-- =========================================================================
-- THE LAST DATASET — PRODUCTION CONSOLIDATED MIGRATIONS & RPC INSTALLER
-- TechTatva 2026 | MAHE Manipal
-- 
-- Run this script in the Supabase Dashboard SQL Editor for your project:
-- https://supabase.com/dashboard/project/bqedvdohyaeivdqzapyy/sql
-- =========================================================================

-- -------------------------------------------------------------------------
-- PART 1: HARD 2-PLAYER ROSTER LIMIT TRIGGER (MIGRATION 003)
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
-- PART 2: ATOMIC ML QUOTA RESERVATION WITH PERMANENT ESCAPE LOCK (MIGRATIONS 002/003)
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
-- PART 3: ATOMIC QUALIFYING ML SUBMISSION & 1,000-POINT PURPLE COMPLETION (MIGRATION 003)
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

    -- 4. Award 1,000 points idempotently in score ledger using canonical points
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
-- PART 4: ATOMIC CROSS-ZONE COMPLETION STORED PROCEDURE (MIGRATION 004)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_zone_atomic(
    p_team_id TEXT,
    p_delegate_id TEXT DEFAULT NULL,
    p_zone_id TEXT DEFAULT NULL,
    p_points INTEGER DEFAULT 0,
    p_next_zone_id TEXT DEFAULT NULL,
    p_dataset_key TEXT DEFAULT NULL,
    p_source_id TEXT DEFAULT NULL,
    p_source_type TEXT DEFAULT NULL,
    p_required_prev_zone TEXT DEFAULT NULL,
    p_required_challenges TEXT[] DEFAULT ARRAY[]::TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_team_id TEXT;
    v_clean_zone_id TEXT;
    v_now TIMESTAMPTZ := NOW();
    v_prev_status TEXT;
    v_solved_challenges TEXT[];
    v_req_challenge TEXT;
    v_has_qual BOOLEAN := FALSE;
    v_already_completed BOOLEAN := FALSE;
    v_idempotency_key TEXT;
    v_points_awarded INTEGER := 0;
    v_canonical_points INTEGER := 0;
    v_team_exists BOOLEAN := FALSE;
    v_source_id TEXT;
BEGIN
    v_clean_team_id := UPPER(TRIM(p_team_id));
    IF v_clean_team_id IS NULL OR v_clean_team_id = '' THEN
        RAISE EXCEPTION 'Team ID is required';
    END IF;

    v_clean_zone_id := LOWER(TRIM(p_zone_id));
    IF v_clean_zone_id IS NULL OR v_clean_zone_id = '' THEN
        RAISE EXCEPTION 'Zone ID is required';
    END IF;

    -- Validate team existence and active status
    SELECT EXISTS (
        SELECT 1 FROM public.teams WHERE id = v_clean_team_id AND is_active = TRUE
    ) INTO v_team_exists;
    IF NOT v_team_exists THEN
        RAISE EXCEPTION 'TEAM_NOT_FOUND: Team "%" does not exist or is inactive.', v_clean_team_id;
    END IF;

    -- 1. Take transaction-level advisory lock on team zone completion
    PERFORM pg_advisory_xact_lock(hashtext('zone_complete:' || v_clean_team_id));

    -- 2. Validate prerequisite zone
    IF p_required_prev_zone IS NOT NULL THEN
        SELECT status INTO v_prev_status
        FROM public.zone_progress
        WHERE team_id = v_clean_team_id AND zone_id = p_required_prev_zone;

        IF v_prev_status IS NULL OR v_prev_status != 'completed' THEN
            RAISE EXCEPTION 'PREREQUISITE_NOT_MET: Previous sector "%" must be completed before "%" can be cleared.', p_required_prev_zone, v_clean_zone_id;
        END IF;
    END IF;

    -- 3. Validate required challenges
    IF array_length(p_required_challenges, 1) > 0 AND v_clean_zone_id != 'purple' THEN
        SELECT solved_challenges INTO v_solved_challenges
        FROM public.zone_progress
        WHERE team_id = v_clean_team_id AND zone_id = v_clean_zone_id;

        FOREACH v_req_challenge IN ARRAY p_required_challenges LOOP
            IF v_solved_challenges IS NULL OR NOT (v_req_challenge = ANY(v_solved_challenges)) THEN
                RAISE EXCEPTION 'CHALLENGES_INCOMPLETE: Sector "%" requires challenge "%" to be solved before clearance.', v_clean_zone_id, v_req_challenge;
            END IF;
        END LOOP;
    END IF;

    -- 4. Purple zone requires qualifying ML submission
    IF v_clean_zone_id = 'purple' THEN
        SELECT EXISTS (
            SELECT 1 FROM public.ml_submissions
            WHERE team_id = v_clean_team_id AND qualifies_for_escape = TRUE
        ) INTO v_has_qual;

        IF NOT v_has_qual THEN
            RAISE EXCEPTION 'PREREQUISITE_NOT_MET: Purple Zone requires an authoritative ML submission on record with R² ≥ 0.80.';
        END IF;
    END IF;

    -- 5. Determine canonical points strictly in database logic
    v_canonical_points := CASE v_clean_zone_id
        WHEN 'sanctuary' THEN 100
        WHEN 'yellow' THEN 200
        WHEN 'blue' THEN 400
        WHEN 'orange' THEN 600
        WHEN 'red' THEN 800
        WHEN 'purple' THEN 1000
        ELSE 0
    END;

    -- Canonical source_id
    v_source_id := CASE v_clean_zone_id
        WHEN 'sanctuary' THEN 'sanctuary-gate'
        WHEN 'yellow' THEN 'yellow-zone'
        WHEN 'blue' THEN 'blue-zone'
        WHEN 'orange' THEN 'orange-zone'
        WHEN 'red' THEN 'red-zone'
        WHEN 'purple' THEN 'purple-escape'
        ELSE v_clean_zone_id
    END;

    -- 6. Check if zone is already completed
    SELECT (status = 'completed') INTO v_already_completed
    FROM public.zone_progress
    WHERE team_id = v_clean_team_id AND zone_id = v_clean_zone_id;

    -- 7. Mark current zone completed
    INSERT INTO public.zone_progress (
        team_id,
        zone_id,
        status,
        completed_at,
        updated_at
    )
    VALUES (
        v_clean_team_id,
        v_clean_zone_id,
        'completed',
        v_now,
        v_now
    )
    ON CONFLICT (team_id, zone_id) DO UPDATE
    SET status = 'completed',
        completed_at = COALESCE(public.zone_progress.completed_at, v_now),
        updated_at = v_now;

    -- 8. Unlock next zone if specified
    IF p_next_zone_id IS NOT NULL THEN
        INSERT INTO public.zone_progress (
            team_id,
            zone_id,
            status,
            unlocked_at,
            updated_at
        )
        VALUES (
            v_clean_team_id,
            p_next_zone_id,
            'available',
            v_now,
            v_now
        )
        ON CONFLICT (team_id, zone_id) DO UPDATE
        SET status = CASE WHEN public.zone_progress.status = 'completed' THEN 'completed' ELSE 'available' END,
            unlocked_at = COALESCE(public.zone_progress.unlocked_at, v_now),
            updated_at = v_now;
    END IF;

    -- 9. Grant dataset entitlement if specified
    IF p_dataset_key IS NOT NULL THEN
        INSERT INTO public.dataset_entitlements (
            team_id,
            dataset_key
        )
        VALUES (
            v_clean_team_id,
            p_dataset_key
        )
        ON CONFLICT (team_id, dataset_key) DO NOTHING;
    END IF;

    -- 10. Award points idempotently in score ledger using canonical points
    IF v_canonical_points > 0 THEN
        v_idempotency_key := v_clean_team_id || ':' || v_source_id;
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
                COALESCE(p_source_type, 'zone_' || v_clean_zone_id || '_clear'),
                v_source_id,
                v_idempotency_key,
                v_now
            );
            v_points_awarded := v_canonical_points;
        EXCEPTION WHEN unique_violation THEN
            v_points_awarded := 0; -- Already awarded previously
        END;
    END IF;

    RETURN jsonb_build_object(
        'success', TRUE,
        'teamId', v_clean_team_id,
        'zoneId', v_clean_zone_id,
        'nextZoneId', p_next_zone_id,
        'datasetKey', p_dataset_key,
        'pointsAwarded', v_points_awarded,
        'alreadyCompleted', COALESCE(v_already_completed, FALSE),
        'completedAt', v_now
    );
END;
$$;


-- -------------------------------------------------------------------------
-- PART 5: ATOMIC CHALLENGE COMPLETION STORED PROCEDURE (MIGRATION 001 HARDENED)
-- -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_challenge_idempotent(
    p_team_id TEXT,
    p_delegate_id TEXT,
    p_zone_id TEXT,
    p_challenge_id TEXT,
    p_points INTEGER,
    p_all_zone_challenges TEXT[],
    p_next_zone_id TEXT DEFAULT NULL,
    p_reward_dataset_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_clean_team_id TEXT;
    v_current_solved TEXT[];
    v_is_new_solve BOOLEAN := FALSE;
    v_zone_now_complete BOOLEAN := FALSE;
    v_total_score INTEGER;
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

    -- Transaction-level advisory lock on team challenge solve
    PERFORM pg_advisory_xact_lock(hashtext('challenge_solve:' || v_clean_team_id));

    -- 1. Fetch current solved challenges for this zone
    SELECT solved_challenges INTO v_current_solved
    FROM public.zone_progress
    WHERE team_id = v_clean_team_id AND zone_id = p_zone_id;

    IF v_current_solved IS NULL THEN
        v_current_solved := ARRAY[p_challenge_id];
        v_is_new_solve := TRUE;
        INSERT INTO public.zone_progress (team_id, zone_id, status, solved_challenges, unlocked_at)
        VALUES (v_clean_team_id, p_zone_id, 'in_progress', v_current_solved, NOW())
        ON CONFLICT (team_id, zone_id) DO UPDATE
        SET solved_challenges = v_current_solved,
            updated_at = NOW();
    ELSE
        IF NOT (p_challenge_id = ANY(v_current_solved)) THEN
            v_current_solved := array_append(v_current_solved, p_challenge_id);
            v_is_new_solve := TRUE;
            UPDATE public.zone_progress
            SET solved_challenges = v_current_solved,
                status = 'in_progress',
                updated_at = NOW()
            WHERE team_id = v_clean_team_id AND zone_id = p_zone_id;
        ELSE
            v_is_new_solve := FALSE;
        END IF;
    END IF;

    -- 2. Check if all challenges in this zone are solved
    IF p_all_zone_challenges <@ v_current_solved THEN
        v_zone_now_complete := TRUE;
        UPDATE public.zone_progress
        SET status = 'completed',
            completed_at = COALESCE(completed_at, NOW()),
            updated_at = NOW()
        WHERE team_id = v_clean_team_id AND zone_id = p_zone_id;

        -- Unlock dataset entitlement if specified
        IF p_reward_dataset_key IS NOT NULL THEN
            INSERT INTO public.dataset_entitlements (team_id, dataset_key)
            VALUES (v_clean_team_id, p_reward_dataset_key)
            ON CONFLICT (team_id, dataset_key) DO NOTHING;
        END IF;

        -- Unlock next zone if specified
        IF p_next_zone_id IS NOT NULL THEN
            INSERT INTO public.zone_progress (team_id, zone_id, status, unlocked_at)
            VALUES (v_clean_team_id, p_next_zone_id, 'available', NOW())
            ON CONFLICT (team_id, zone_id) DO UPDATE
            SET status = CASE WHEN public.zone_progress.status = 'locked' THEN 'available' ELSE public.zone_progress.status END,
                unlocked_at = COALESCE(public.zone_progress.unlocked_at, NOW());
        END IF;
    END IF;

    -- 3. Calculate total team score from authoritative score ledger
    -- (Scoring ownership belongs strictly to zone completion RPCs)
    SELECT COALESCE(SUM(points), 0) INTO v_total_score
    FROM public.score_ledger
    WHERE team_id = v_clean_team_id;

    RETURN jsonb_build_object(
        'success', TRUE,
        'newlySolved', v_is_new_solve,
        'zoneCompleted', v_zone_now_complete,
        'totalScore', v_total_score,
        'solvedCount', array_length(v_current_solved, 1)
    );
END;
$$;


-- -------------------------------------------------------------------------
-- PART 6: PRIVILEGE HARDENING & LEAST PRIVILEGE REVOCATIONS
-- Revoke all execute rights from PUBLIC, anon, and authenticated.
-- Grant execute strictly to postgres and service_role.
-- -------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.check_team_member_cap() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reserve_ml_attempt(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_qualifying_ml_submission(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_zone_atomic(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_challenge_idempotent(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.check_team_member_cap() TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_ml_attempt(TEXT, TEXT, TEXT, INTEGER) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_qualifying_ml_submission(UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INTEGER) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.complete_zone_atomic(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.complete_challenge_idempotent(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, TEXT) TO postgres, service_role;


-- -------------------------------------------------------------------------
-- PART 7: RESET SEEDED TEAMS TO FAIR COMPETITION STATE
-- Sets Sanctuary as 'available' (unlocked) and all later zones as 'locked'
-- -------------------------------------------------------------------------
DELETE FROM public.score_ledger;
DELETE FROM public.dataset_entitlements;
DELETE FROM public.ml_submissions;

UPDATE public.zone_progress
SET status = 'available',
    unlocked_at = NOW(),
    completed_at = NULL,
    solved_challenges = '{}'
WHERE zone_id = 'sanctuary';

UPDATE public.zone_progress
SET status = 'locked',
    unlocked_at = NULL,
    completed_at = NULL,
    solved_challenges = '{}'
WHERE zone_id != 'sanctuary';
