-- =========================================================================
-- THE LAST DATASET — MIGRATION 004: ATOMIC ZONE COMPLETION & SCORING RPC
-- TechTatva 2026 | MAHE Manipal
-- =========================================================================

-- -------------------------------------------------------------------------
-- ATOMIC CROSS-ZONE COMPLETION STORED PROCEDURE
-- Handles prerequisite check, challenge check, zone completion,
-- next-zone unlock, dataset entitlement grant, and idempotent scoring
-- in a single PostgreSQL ACID transaction.
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
-- PRIVILEGE HARDENING & LEAST PRIVILEGE REVOCATIONS
-- -------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.complete_zone_atomic(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_zone_atomic(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO postgres, service_role;
