-- =========================================================================
-- THE LAST DATASET — OPTIONAL DEVELOPMENT & STAGING SEED DATA
-- TechTatva 2026 | MAHE Manipal
-- DO NOT RUN IN PRODUCTION ROSTERS
-- =========================================================================

-- Pre-populates sample development teams with passcode 'MAHE2026!'
-- SHA-256('MAHE2026!') = '8a371217805dd9f6d8e337a86fa08a6522b7585a3c5ef01997356ba538ee33b8'

INSERT INTO public.teams (id, team_name, team_leader_name, leader_mobile, passcode_hash, student_type)
VALUES
('TECHTEAM10328', 'Alpha Protocol', 'GRANDHI GOWTHAM RAM SAI', '8431863119', '8a371217805dd9f6d8e337a86fa08a6522b7585a3c5ef01997356ba538ee33b8', 'MAHE'),
('TECHTEAM10305', 'Echo Vanguard', 'HIMAANI PATHI', '9632015177', '8a371217805dd9f6d8e337a86fa08a6522b7585a3c5ef01997356ba538ee33b8', 'MAHE'),
('TECHTEAM10172', 'Outpost 7', 'Sujal M H', '8867144895', '8a371217805dd9f6d8e337a86fa08a6522b7585a3c5ef01997356ba538ee33b8', 'NONMAHE'),
('TECHTEAM10335', 'Sector Nine', 'DIVVYESH RAMESH', '9811927351', '8a371217805dd9f6d8e337a86fa08a6522b7585a3c5ef01997356ba538ee33b8', 'MAHE'),
('TECHTEAM10122', 'Ghost Relay', 'ASHWIN ANILKUMAR MENON', '7907727291', '8a371217805dd9f6d8e337a86fa08a6522b7585a3c5ef01997356ba538ee33b8', 'MAHE'),
('TECHTEAM10296', 'Redline', 'Dheeraj', '9353396740', '8a371217805dd9f6d8e337a86fa08a6522b7585a3c5ef01997356ba538ee33b8', 'NONMAHE')
ON CONFLICT (id) DO NOTHING;

-- Seed team members (Delegate IDs)
INSERT INTO public.team_members (delegate_id, team_id, member_name, is_leader)
VALUES
('12331', 'TECHTEAM10328', 'GRANDHI GOWTHAM RAM SAI', TRUE),
('12302', 'TECHTEAM10305', 'HIMAANI PATHI', TRUE),
('11934', 'TECHTEAM10172', 'Sujal M H', TRUE),
('11555', 'TECHTEAM10335', 'DIVVYESH RAMESH', TRUE),
('11287', 'TECHTEAM10122', 'ASHWIN ANILKUMAR MENON', TRUE),
('11158', 'TECHTEAM10296', 'Dheeraj', TRUE)
ON CONFLICT (delegate_id) DO NOTHING;

-- Correct Initial State: Sanctuary is AVAILABLE (unlocked), Yellow is LOCKED
INSERT INTO public.zone_progress (team_id, zone_id, status, unlocked_at)
SELECT id, 'sanctuary', 'available', NOW() FROM public.teams
ON CONFLICT (team_id, zone_id) DO NOTHING;

INSERT INTO public.zone_progress (team_id, zone_id, status, unlocked_at)
SELECT id, 'yellow', 'locked', NULL FROM public.teams
ON CONFLICT (team_id, zone_id) DO NOTHING;
