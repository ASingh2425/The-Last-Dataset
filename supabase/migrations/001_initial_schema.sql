-- =========================================================================
-- THE LAST DATASET — MASTER DATABASE SCHEMA
-- TechTatva 2026 | MAHE Manipal
-- Authoritative Central Progression, Scoring, Auth & ML Pipeline
-- =========================================================================

-- Enable UUID extension if not already present
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -------------------------------------------------------------------------
-- 1. TEAMS TABLE
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.teams (
    id TEXT PRIMARY KEY,                       -- e.g. 'TECHTEAM10328' (Normalized uppercase)
    team_name TEXT NOT NULL,                  -- Display name of the team
    team_leader_name TEXT NOT NULL,           -- Full name of team leader
    leader_mobile TEXT NOT NULL,              -- Leader mobile number (10-digit)
    passcode_hash TEXT NOT NULL,              -- Argon2id/bcrypt/SHA-256 salted hash of team password
    student_type TEXT DEFAULT 'MAHE',         -- 'MAHE' or 'NONMAHE'
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- 2. TEAM MEMBERS (Up to 2 players per team)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_members (
    delegate_id TEXT PRIMARY KEY,             -- e.g. '12331' (Unique Delegate ID from TechTatva)
    team_id TEXT NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    member_name TEXT NOT NULL,
    is_leader BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON public.team_members(team_id);

-- -------------------------------------------------------------------------
-- 3. TEAM SESSIONS (Tracking active player logins)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.team_sessions (
    session_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    delegate_id TEXT NOT NULL REFERENCES public.team_members(delegate_id),
    expires_at TIMESTAMPTZ NOT NULL,
    last_active_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_sessions_team_id ON public.team_sessions(team_id);

-- -------------------------------------------------------------------------
-- 4. ZONE PROGRESSION
-- -------------------------------------------------------------------------
-- Valid zones: 'sanctuary', 'yellow', 'blue', 'orange', 'red', 'purple'
CREATE TABLE IF NOT EXISTS public.zone_progress (
    team_id TEXT NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    zone_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('locked', 'available', 'in_progress', 'completed')),
    solved_challenges TEXT[] DEFAULT '{}',
    unlocked_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (team_id, zone_id)
);

-- -------------------------------------------------------------------------
-- 5. IMMUTABLE SCORE LEDGER (Atomic concurrency for 2 players)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.score_ledger (
    id BIGSERIAL PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    delegate_id TEXT,                         -- Identifies which of the 2 teammates completed the action
    points INTEGER NOT NULL,
    source_type TEXT NOT NULL,                 -- 'zone_sanctuary_clear', 'zone_yellow_clear', etc.
    source_id TEXT NOT NULL,                   -- e.g. 'sanctuary-gate', 'yellow-zone'
    idempotency_key TEXT UNIQUE NOT NULL,      -- Prevents duplicate point awards (e.g. 'TECHTEAM10328:yellow-zone')
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_score_ledger_team_id ON public.score_ledger(team_id);

-- -------------------------------------------------------------------------
-- 6. DATASET ENTITLEMENTS (Fragments unlocked by zone completions)
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dataset_entitlements (
    team_id TEXT NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    dataset_key TEXT NOT NULL CHECK (dataset_key IN ('community_final', 'radio_final', 'forensics_final', 'research_final')),
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    download_count INTEGER DEFAULT 0,
    PRIMARY KEY (team_id, dataset_key)
);

-- -------------------------------------------------------------------------
-- 7. PURPLE ZONE ML SUBMISSIONS
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ml_submissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    team_id TEXT NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    delegate_id TEXT,
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    r2_score DOUBLE PRECISION,
    mse_score DOUBLE PRECISION,
    qualifies_for_escape BOOLEAN DEFAULT FALSE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'valid', 'rejected')),
    error_message TEXT,
    raw_filename TEXT
);

CREATE INDEX IF NOT EXISTS idx_ml_submissions_team ON public.ml_submissions(team_id);

-- -------------------------------------------------------------------------
-- 8. ORGANIZER AUDIT LOG
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organizer_audit_log (
    id BIGSERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,                      -- 'admin', 'system'
    target_team_id TEXT,
    reason TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- -------------------------------------------------------------------------
-- 9. ATOMIC STORED PROCEDURE: IDEMPOTENT CHALLENGE COMPLETION
-- -------------------------------------------------------------------------
-- Records challenge solves in zone_progress.solved_challenges.
-- Note: Score ledger ownership belongs strictly to zone completion RPCs.
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
-- 10. HELPER VIEW: LEADERBOARD
-- -------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.leaderboard_view AS
SELECT 
    t.id AS team_id,
    t.team_name,
    COALESCE(SUM(l.points), 0) AS total_score,
    COUNT(DISTINCT l.source_id) AS total_challenges_solved,
    COALESCE(BOOL_OR(s.qualifies_for_escape), FALSE) AS escape_unlocked,
    MAX(s.r2_score) AS best_r2_score,
    MAX(l.created_at) AS last_score_at
FROM public.teams t
LEFT JOIN public.score_ledger l ON t.id = l.team_id
LEFT JOIN public.ml_submissions s ON t.id = s.team_id
WHERE t.is_active = TRUE
GROUP BY t.id, t.team_name
ORDER BY total_score DESC, best_r2_score DESC NULLS LAST, last_score_at ASC NULLS LAST;

-- -------------------------------------------------------------------------
-- 11. PRIVILEGE HARDENING & LEAST PRIVILEGE REVOCATIONS
-- -------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.complete_challenge_idempotent(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_challenge_idempotent(TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, TEXT) TO postgres, service_role;
