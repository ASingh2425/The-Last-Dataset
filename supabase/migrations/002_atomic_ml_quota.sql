-- =========================================================================
-- THE LAST DATASET — MIGRATION 002: ATOMIC ML QUOTA RESERVATION
-- TechTatva 2026 | MAHE Manipal
-- Multi-instance advisory lock and atomic quota reservation
-- =========================================================================

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

    -- 1. Take a transaction-level advisory lock on the team hash
    -- This serializes concurrent evaluation requests for the same team across all database connections / Lambdas.
    PERFORM pg_advisory_xact_lock(hashtext('ml_quota:' || v_clean_team_id));

    -- 2. Check if team has already qualified or completed purple zone
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

    -- Permanent lock if already escaped
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

    -- 3. Check if quota exceeded
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

    -- 4. Insert pending submission record
    v_new_id := gen_random_uuid();
    INSERT INTO public.ml_submissions (
        id,
        team_id,
        delegate_id,
        status,
        raw_filename,
        submitted_at
    )
    VALUES (
        v_new_id,
        v_clean_team_id,
        p_delegate_id,
        'pending',
        COALESCE(p_raw_filename, 'submission.csv'),
        v_now
    );

    -- 5. Return success payload
    RETURN jsonb_build_object(
        'allowed', TRUE,
        'submissionId', v_new_id,
        'attemptNumber', v_count + 1,
        'submissionsUsed', v_count + 1,
        'submissionsRemaining', GREATEST(0, p_max_attempts - (v_count + 1)),
        'submittedAt', v_now
    );
END;
$$;

-- -------------------------------------------------------------------------
-- PRIVILEGE HARDENING & LEAST PRIVILEGE REVOCATIONS
-- -------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.reserve_ml_attempt(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_ml_attempt(TEXT, TEXT, TEXT, INTEGER) TO postgres, service_role;
