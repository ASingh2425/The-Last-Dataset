-- =========================================================================
-- THE LAST DATASET — MIGRATION 003: ATOMIC PURPLE FINALIZATION,
-- PERMANENT SUBMISSION LOCKING, 2-PLAYER CAP & CHALLENGE INTEGRITY
-- TechTatva 2026 | MAHE Manipal
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. HARD 2-PLAYER ROSTER LIMIT TRIGGER
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_team_member_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_member_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_member_count
    FROM public.team_members
    WHERE team_id = NEW.team_id;

    IF v_member_count >= 2 THEN
        RAISE EXCEPTION 'TEAM_CAP_EXCEEDED: Maximum 2 players permitted per team.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_team_member_cap ON public.team_members;
CREATE TRIGGER trg_team_member_cap
BEFORE INSERT ON public.team_members
FOR EACH ROW
EXECUTE FUNCTION public.check_team_member_cap();


-- -------------------------------------------------------------------------
-- 2. HARDENED ATOMIC ML QUOTA RESERVATION WITH PERMANENT ESCAPE LOCK
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_ml_attempt(
    p_team_id TEXT,
    p_delegate_id TEXT DEFAULT NULL,
    p_raw_filename TEXT DEFAULT 'submission.csv',
    p_max_attempts INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_team_id TEXT;
    v_count INTEGER;
    v_new_id UUID;
    v_now TIMESTAMPTZ := NOW();
    v_already_escaped BOOLEAN := FALSE;
    v_team_exists BOOLEAN := FALSE;
BEGIN
    v_clean_team_id := UPPER(TRIM(p_team_id));
    IF v_clean_team_id IS NULL OR v_clean_team_id = '' THEN
        RAISE EXCEPTION 'Team ID is required';
    END IF;

    -- Validate team existence and active status
    SELECT EXISTS (
        SELECT 1 FROM public.teams WHERE id = v_clean_team_id AND is_active = TRUE
    ) INTO v_team_exists;
    IF NOT v_team_exists THEN
        RAISE EXCEPTION 'TEAM_NOT_FOUND: Team "%" does not exist or is inactive.', v_clean_team_id;
    END IF;

    -- Take a transaction-level advisory lock on the team hash
    PERFORM pg_advisory_xact_lock(hashtext('ml_quota:' || v_clean_team_id));

    -- Check if team has already qualified or completed purple zone
    SELECT EXISTS (
        SELECT 1 FROM public.ml_submissions
        WHERE team_id = v_clean_team_id AND qualifies_for_escape = TRUE
    ) OR EXISTS (
        SELECT 1 FROM public.zone_progress
        WHERE team_id = v_clean_team_id AND zone_id = 'purple' AND status = 'completed'
    ) INTO v_already_escaped;

    -- Count existing attempts
    SELECT COUNT(*) INTO v_count
    FROM public.ml_submissions
    WHERE team_id = v_clean_team_id;

    -- If already escaped, permanently lock submissions
    IF v_already_escaped THEN
        RETURN jsonb_build_object(
            'allowed', FALSE,
            'submissionId', NULL,
            'attemptNumber', v_count,
            'submissionsUsed', v_count,
            'submissionsRemaining', 0,
            'alreadyCompleted', TRUE,
            'reason', 'PURPLE_ALREADY_COMPLETED',
            'submittedAt', v_now
        );
    END IF;

    -- Check if quota exhausted
    IF v_count >= p_max_attempts THEN
        RETURN jsonb_build_object(
            'allowed', FALSE,
            'submissionId', NULL,
            'attemptNumber', v_count,
            'submissionsUsed', v_count,
            'submissionsRemaining', 0,
            'alreadyCompleted', FALSE,
            'reason', 'SUBMISSION_LIMIT_EXCEEDED',
            'submittedAt', v_now
        );
    END IF;

    -- Reserve new slot
    v_new_id := gen_random_uuid();
    INSERT INTO public.ml_submissions (
        id,
        team_id,
        delegate_id,
        attempt_number,
        raw_filename,
        status,
        submitted_at
    )
    VALUES (
        v_new_id,
        v_clean_team_id,
        p_delegate_id,
        v_count + 1,
        COALESCE(p_raw_filename, 'submission.csv'),
        'processing',
        v_now
    );

    RETURN jsonb_build_object(
        'allowed', TRUE,
        'submissionId', v_new_id,
        'attemptNumber', v_count + 1,
        'submissionsUsed', v_count + 1,
        'submissionsRemaining', p_max_attempts - (v_count + 1),
        'alreadyCompleted', FALSE,
        'reason', NULL,
        'submittedAt', v_now
    );
END;
$$;


-- -------------------------------------------------------------------------
-- 3. ATOMIC QUALIFYING ML SUBMISSION & 1,000-POINT PURPLE COMPLETION
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_qualifying_ml_submission(
    p_submission_id UUID,
    p_team_id TEXT,
    p_delegate_id TEXT DEFAULT NULL,
    p_r2_score DOUBLE PRECISION DEFAULT NULL,
    p_mse_score DOUBLE PRECISION DEFAULT NULL,
    p_points INTEGER DEFAULT 1000
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_team_id TEXT;
    v_now TIMESTAMPTZ := NOW();
    v_idempotency_key TEXT;
    v_points_awarded INTEGER := 0;
    v_canonical_points INTEGER := 1000;
    v_team_exists BOOLEAN := FALSE;
BEGIN
    v_clean_team_id := UPPER(TRIM(p_team_id));
    IF v_clean_team_id IS NULL OR v_clean_team_id = '' THEN
        RAISE EXCEPTION 'Team ID is required';
    END IF;

    -- Validate team existence and active status
    SELECT EXISTS (
        SELECT 1 FROM public.teams WHERE id = v_clean_team_id AND is_active = TRUE
    ) INTO v_team_exists;
    IF NOT v_team_exists THEN
        RAISE EXCEPTION 'TEAM_NOT_FOUND: Team "%" does not exist or is inactive.', v_clean_team_id;
    END IF;

    v_idempotency_key := v_clean_team_id || ':purple-escape';

    -- 1. Take advisory lock
    PERFORM pg_advisory_xact_lock(hashtext('ml_quota:' || v_clean_team_id));

    -- 2. Finalize submission to valid and qualifying
    UPDATE public.ml_submissions
    SET r2_score = p_r2_score,
        mse_score = p_mse_score,
        qualifies_for_escape = TRUE,
        status = 'valid',
        error_message = NULL
    WHERE id = p_submission_id AND team_id = v_clean_team_id;

    -- 3. Mark purple zone completed
    INSERT INTO public.zone_progress (team_id, zone_id, status, completed_at, updated_at)
    VALUES (v_clean_team_id, 'purple', 'completed', v_now, v_now)
    ON CONFLICT (team_id, zone_id) DO UPDATE
    SET status = 'completed',
        completed_at = COALESCE(public.zone_progress.completed_at, v_now),
        updated_at = v_now;

    -- 4. Award 1,000 points idempotently in score ledger using canonical score
    BEGIN
        INSERT INTO public.score_ledger (
            team_id,
            delegate_id,
            points,
            source_type,
            source_id,
            idempotency_key,
            created_at
        )
        VALUES (
            v_clean_team_id,
            p_delegate_id,
            v_canonical_points,
            'zone_purple_clear',
            'purple-escape',
            v_idempotency_key,
            v_now
        );
        v_points_awarded := v_canonical_points;
    EXCEPTION WHEN unique_violation THEN
        v_points_awarded := 0; -- Already awarded
    END;

    RETURN jsonb_build_object(
        'success', TRUE,
        'submissionId', p_submission_id,
        'teamId', v_clean_team_id,
        'zoneCompleted', TRUE,
        'pointsAwarded', v_points_awarded,
        'qualifiesForEscape', TRUE,
        'finalizedAt', v_now
    );
END;
$$;

-- -------------------------------------------------------------------------
-- PRIVILEGE HARDENING & LEAST PRIVILEGE REVOCATIONS
-- -------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.check_team_member_cap() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_ml_attempt(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_qualifying_ml_submission(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.check_team_member_cap() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_ml_attempt(TEXT, TEXT, TEXT, INTEGER) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_qualifying_ml_submission(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) TO postgres, service_role;
