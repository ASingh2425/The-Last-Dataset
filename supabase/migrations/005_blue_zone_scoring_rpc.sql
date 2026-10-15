-- =========================================================================
-- THE LAST DATASET — MIGRATION 005: BLUE ZONE 4-CTF ATOMIC SCORING
-- TechTatva 2026 | MAHE Manipal
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. UPDATE complete_challenge_idempotent
-- Allows per-CTF idempotent point awards (100 pts per Blue CTF).
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
    v_idempotency_key TEXT;
    v_now TIMESTAMPTZ := NOW();
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
        INSERT INTO public.zone_progress (team_id, zone_id, status, solved_challenges, unlocked_at, updated_at)
        VALUES (v_clean_team_id, p_zone_id, 'in_progress', v_current_solved, v_now, v_now)
        ON CONFLICT (team_id, zone_id) DO UPDATE
        SET solved_challenges = v_current_solved,
            updated_at = v_now;
    ELSE
        IF NOT (p_challenge_id = ANY(v_current_solved)) THEN
            v_current_solved := array_append(v_current_solved, p_challenge_id);
            v_is_new_solve := TRUE;
            UPDATE public.zone_progress
            SET solved_challenges = v_current_solved,
                updated_at = v_now
            WHERE team_id = v_clean_team_id AND zone_id = p_zone_id;
        ELSE
            v_is_new_solve := FALSE;
        END IF;
    END IF;

    -- 2. Award challenge points idempotently if specified (e.g. 100 pts per Blue CTF)
    IF v_is_new_solve AND p_points > 0 THEN
        v_idempotency_key := v_clean_team_id || ':' || p_challenge_id;
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
                p_points,
                'ctf_complete',
                p_challenge_id,
                v_idempotency_key,
                v_now
            );
        EXCEPTION WHEN unique_violation THEN
            -- Idempotent duplicate: already awarded
            NULL;
        END;
    END IF;

    -- 3. Check if all challenges in this zone are solved
    IF p_all_zone_challenges <@ v_current_solved THEN
        v_zone_now_complete := TRUE;
        UPDATE public.zone_progress
        SET status = 'completed',
            completed_at = COALESCE(completed_at, v_now),
            updated_at = v_now
        WHERE team_id = v_clean_team_id AND zone_id = p_zone_id;

        -- Unlock dataset entitlement if specified
        IF p_reward_dataset_key IS NOT NULL THEN
            INSERT INTO public.dataset_entitlements (team_id, dataset_key)
            VALUES (v_clean_team_id, p_reward_dataset_key)
            ON CONFLICT (team_id, dataset_key) DO NOTHING;
        END IF;

        -- Unlock next zone if specified
        IF p_next_zone_id IS NOT NULL THEN
            INSERT INTO public.zone_progress (team_id, zone_id, status, unlocked_at, updated_at)
            VALUES (v_clean_team_id, p_next_zone_id, 'available', v_now, v_now)
            ON CONFLICT (team_id, zone_id) DO UPDATE
            SET status = CASE WHEN public.zone_progress.status = 'locked' THEN 'available' ELSE public.zone_progress.status END,
                unlocked_at = COALESCE(public.zone_progress.unlocked_at, v_now),
                updated_at = v_now;
        END IF;
    END IF;

    -- 4. Calculate total team score from authoritative score ledger
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
-- 2. UPDATE complete_zone_atomic
-- For blue zone, awards 0 additional points because 400 points are awarded
-- 100 per verified CTF in score_ledger.
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

    -- 1. Advisory lock
    PERFORM pg_advisory_xact_lock(hashtext('zone_complete:' || v_clean_team_id));

    -- 2. Validate prerequisite
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

    -- 4. Purple zone check
    IF v_clean_zone_id = 'purple' THEN
        SELECT EXISTS (
            SELECT 1 FROM public.ml_submissions
            WHERE team_id = v_clean_team_id AND qualifies_for_escape = TRUE
        ) INTO v_has_qual;

        IF NOT v_has_qual THEN
            RAISE EXCEPTION 'PREREQUISITE_NOT_MET: Purple Zone requires an authoritative ML submission on record with R² ≥ 0.80.';
        END IF;
    END IF;

    -- 5. Canonical points strictly in database logic
    -- Blue Zone awards 0 points on whole-zone clear because all 400 pts are awarded
    -- individually (100 pts each) across the 4 Blue CTFs.
    v_canonical_points := CASE v_clean_zone_id
        WHEN 'sanctuary' THEN 10
        WHEN 'yellow' THEN 100
        WHEN 'blue' THEN 0
        WHEN 'orange' THEN 0
        WHEN 'red' THEN 0
        WHEN 'purple' THEN 1000
        ELSE 0
    END;

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

    -- 7. Mark zone completed
    INSERT INTO public.zone_progress (team_id, zone_id, status, completed_at, updated_at)
    VALUES (v_clean_team_id, v_clean_zone_id, 'completed', v_now, v_now)
    ON CONFLICT (team_id, zone_id) DO UPDATE
    SET status = 'completed',
        completed_at = COALESCE(public.zone_progress.completed_at, v_now),
        updated_at = v_now;

    -- 8. Unlock next zone
    IF p_next_zone_id IS NOT NULL THEN
        INSERT INTO public.zone_progress (team_id, zone_id, status, unlocked_at, updated_at)
        VALUES (v_clean_team_id, p_next_zone_id, 'available', v_now, v_now)
        ON CONFLICT (team_id, zone_id) DO UPDATE
        SET status = CASE WHEN public.zone_progress.status = 'completed' THEN 'completed' ELSE 'available' END,
            unlocked_at = COALESCE(public.zone_progress.unlocked_at, v_now),
            updated_at = v_now;
    END IF;

    -- 9. Grant dataset entitlement
    IF p_dataset_key IS NOT NULL THEN
        INSERT INTO public.dataset_entitlements (team_id, dataset_key)
        VALUES (v_clean_team_id, p_dataset_key)
        ON CONFLICT (team_id, dataset_key) DO NOTHING;
    END IF;

    -- 10. Award points idempotently in score ledger
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
            v_points_awarded := 0;
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

REVOKE EXECUTE ON FUNCTION public.complete_challenge_idempotent(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_challenge_idempotent(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, TEXT) TO postgres, service_role;

REVOKE EXECUTE ON FUNCTION public.complete_zone_atomic(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_zone_atomic(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[]) TO postgres, service_role;
