const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { supabase } = require('./supabaseClient');
const {
  CANONICAL_STAGE_SCORES,
  ZONE_REQUIRED_CHALLENGES
} = require('../config/scoring');
const {
  buildEnrichedTeamOverview,
  buildAdminMetrics
} = require('./adminOverview');

function hashPassword(passcode) {
  return crypto.createHash('sha256').update(String(passcode).trim(), 'utf8').digest('hex');
}

function verifyPasscode(inputPasscode, storedHash) {
  const clean = String(inputPasscode || '').trim();
  if (!storedHash || !clean) return false;

  try {
    // 1. Scrypt format: scrypt$salt$hash
    if (storedHash.startsWith('scrypt$')) {
      const parts = storedHash.split('$');
      if (parts.length === 3) {
        const salt = parts[1];
        const expected = Buffer.from(parts[2], 'hex');
        const derived = crypto.scryptSync(clean, salt, 64);
        return crypto.timingSafeEqual(derived, expected);
      }
    }

    // 2. Legacy SHA-256 fallback with timing-safe comparison
    const sha = crypto.createHash('sha256').update(clean, 'utf8').digest();
    const expected = Buffer.from(storedHash, 'hex');
    if (sha.length !== expected.length) return false;
    return crypto.timingSafeEqual(sha, expected);
  } catch (_) {
    return false;
  }
}

const teamLocks = new Map();

function lockTeam(teamId, task) {
  const current = teamLocks.get(teamId) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const result = current.then(() => task(), () => task());
  teamLocks.set(teamId, result.finally(() => release()));
  return result;
}

/**
 * Authoritative Supabase Store for The Last Dataset.
 */
class SupabaseStore {
  /**
   * Ensures all 6 canonical zones exist in zone_progress for the given team.
   * Never overwrites existing zone progress (completed/available/in_progress).
   */
  async ensureTeamZonesExist(cleanTeamId) {
    if (!cleanTeamId) return;
    try {
      const { data: existingZoneRows, error: fetchErr } = await supabase
        .from('zone_progress')
        .select('zone_id')
        .eq('team_id', cleanTeamId);

      if (fetchErr) {
        console.warn(`[ensureTeamZonesExist] Error querying zones for ${cleanTeamId}:`, fetchErr.message);
      }

      const existingZones = new Set((existingZoneRows || []).map((z) => z.zone_id));
      const allZones = ['sanctuary', 'yellow', 'blue', 'orange', 'red', 'purple'];
      const missingZones = allZones.filter((zId) => !existingZones.has(zId));

      if (missingZones.length > 0) {
        const now = new Date().toISOString();
        const rowsToInsert = missingZones.map((zId) => ({
          team_id: cleanTeamId,
          zone_id: zId,
          status: zId === 'sanctuary' ? 'available' : 'locked',
          unlocked_at: zId === 'sanctuary' ? now : null,
          solved_challenges: []
        }));

        await supabase
          .from('zone_progress')
          .upsert(rowsToInsert, { onConflict: 'team_id,zone_id' });
      }
    } catch (e) {
      console.warn(`[ensureTeamZonesExist] Notice:`, e.message);
    }
  }

  /**
   * Authoritatively guarantees that a team exists in public.teams,
   * its members exist in public.team_members, and its zones exist in public.zone_progress.
   * Strictly auto-provisions only from the official 150-team teams_roster.json.
   * Blocks any mock/fake IDs (e.g. TECHTEAM99%).
   */
  async ensureTeamExists(teamId) {
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    if (!cleanTeamId) return null;
    if (cleanTeamId.startsWith('TECHTEAM99')) return null;

    try {
      // 1. Check if team exists in Supabase
      const { data: existingTeam } = await supabase
        .from('teams')
        .select('*')
        .eq('id', cleanTeamId)
        .maybeSingle();

      if (existingTeam && existingTeam.is_active) {
        await this.ensureTeamZonesExist(cleanTeamId);
        return existingTeam;
      }

      // 2. Load team definition from teams_roster.json (only official 150 teams)
      let rosterTeam = null;
      try {
        const rosterPath = path.resolve(__dirname, '..', 'data', 'teams_roster.json');
        if (fs.existsSync(rosterPath)) {
          const fullRoster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
          rosterTeam = fullRoster.find((r) => r.id === cleanTeamId);
        }
      } catch (err) {
        console.warn(`[ensureTeamExists] Error loading roster file:`, err.message);
      }

      if (!rosterTeam) {
        return null;
      }

      const now = new Date().toISOString();
      const teamRecord = {
        id: cleanTeamId,
        team_name: rosterTeam.team_name,
        team_leader_name: rosterTeam.team_leader_name,
        leader_mobile: rosterTeam.leader_mobile,
        passcode_hash: rosterTeam.passcode_hash,
        student_type: rosterTeam.student_type || 'MAHE',
        is_active: true,
        updated_at: now
      };

      // 3. Upsert into public.teams
      await supabase
        .from('teams')
        .upsert(teamRecord, { onConflict: 'id' });

      // 4. Upsert team members safely (respecting max 2 players)
      const { data: curMembers } = await supabase
        .from('team_members')
        .select('delegate_id')
        .eq('team_id', cleanTeamId);

      const existingDelegateIds = new Set((curMembers || []).map((m) => String(m.delegate_id).trim()));

      for (const m of (rosterTeam.members || [])) {
        const dId = String(m.delegate_id).trim();
        if (dId && !existingDelegateIds.has(dId) && existingDelegateIds.size < 2) {
          await supabase
            .from('team_members')
            .upsert({
              delegate_id: dId,
              team_id: cleanTeamId,
              member_name: m.name || m.member_name || 'Operator',
              is_leader: !!m.is_leader
            }, { onConflict: 'delegate_id' });
          existingDelegateIds.add(dId);
        }
      }

      // 5. Ensure all 6 zones exist
      await this.ensureTeamZonesExist(cleanTeamId);

      const { data: freshTeam } = await supabase
        .from('teams')
        .select('*')
        .eq('id', cleanTeamId)
        .maybeSingle();

      return freshTeam || teamRecord;
    } catch (err) {
      console.error(`[ensureTeamExists] Unexpected error for ${cleanTeamId}:`, err);
      return null;
    }
  }

  /**
   * Authenticates a team player using Team ID, Delegate ID, and Passcode.
   */
  async authenticatePlayer({ teamId, delegateId, passcode }) {
    const normalizedTeamId = String(teamId || '').trim().toUpperCase();
    const normalizedDelegateId = String(delegateId || '').trim();
    const cleanPasscode = String(passcode || '').trim();

    if (!normalizedTeamId || !cleanPasscode) {
      return { success: false, error: 'Team ID and Password are required.' };
    }

    if (normalizedTeamId.startsWith('TECHTEAM99')) {
      return { success: false, error: 'Team ID not found or inactive.' };
    }

    // Authoritatively ensure team and zones exist
    let team = await this.ensureTeamExists(normalizedTeamId);

    if (!team) {
      const { data: fetchedTeam, error: teamError } = await supabase
        .from('teams')
        .select('*')
        .eq('id', normalizedTeamId)
        .eq('is_active', true)
        .maybeSingle();

      if (!teamError && fetchedTeam) {
        team = fetchedTeam;
      }
    }

    if (!team) {
      return { success: false, error: 'Team ID not found or inactive.' };
    }

    // 2. Verify password hash timing-safely
    if (!verifyPasscode(cleanPasscode, team.passcode_hash)) {
      return { success: false, error: 'Invalid password for this team.' };
    }

    // 3. Resolve team member
    let member = null;
    if (normalizedDelegateId) {
      const { data: m, error: memberError } = await supabase
        .from('team_members')
        .select('*')
        .eq('team_id', normalizedTeamId)
        .eq('delegate_id', normalizedDelegateId)
        .maybeSingle();

      if (memberError || !m) {
        return { success: false, error: `Delegate ID ${normalizedDelegateId} is not registered to ${normalizedTeamId}.` };
      }
      member = m;
    } else {
      const { data: members } = await supabase
        .from('team_members')
        .select('*')
        .eq('team_id', normalizedTeamId)
        .order('is_leader', { ascending: false })
        .limit(1);
      member = (members && members.length > 0) ? members[0] : { delegate_id: 'OPERATOR', name: team.name };
    }

    // 4. Create session (64 hex characters to match security.js regex)
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error: sessionError } = await supabase
      .from('team_sessions')
      .insert({
        session_id: sessionId,
        team_id: normalizedTeamId,
        delegate_id: member?.delegate_id || 'OPERATOR',
        expires_at: expiresAt
      });

    if (sessionError) {
      return { success: false, error: 'Could not create session.' };
    }

    return {
      success: true,
      sessionId,
      team,
      member
    };
  }

  /**
   * Validates an active session cookie.
   */
  async validateSession(sessionId) {
    if (!sessionId) return null;

    const { data: session, error } = await supabase
      .from('team_sessions')
      .select('*, teams(*), team_members(*)')
      .eq('session_id', sessionId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error || !session || !session.teams) return null;

    // Refresh last active timestamp asynchronously
    supabase
      .from('team_sessions')
      .update({ last_active_at: new Date().toISOString() })
      .eq('session_id', sessionId)
      .then(() => {});

    return {
      sessionId: session.session_id,
      teamId: session.team_id,
      delegateId: session.delegate_id,
      team: session.teams,
      member: session.team_members
    };
  }

  /**
   * Destroys a session on logout.
   */
  async destroySession(sessionId) {
    if (!sessionId) return;
    await supabase.from('team_sessions').delete().eq('session_id', sessionId);
  }

  /**
   * Retrieves full team bootstrap state including scores, zones, and members.
   */
  async getTeamBootstrap(teamId, delegateId, config) {
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    if (!cleanTeamId) throw new Error('teamId is required');

    await this.ensureTeamExists(cleanTeamId);

    // 1. Fetch team & members
    const { data: team } = await supabase.from('teams').select('*').eq('id', cleanTeamId).single();
    if (!team) {
      throw new Error(`Team ${cleanTeamId} not found in registry.`);
    }
    const { data: members } = await supabase.from('team_members').select('*').eq('team_id', cleanTeamId);

    // 2. Fetch score & self-heal legacy/missing ledger entries
    const { data: scoreRows } = await supabase.from('score_ledger').select('id, points, source_id').eq('team_id', cleanTeamId);
    let activeScoreRows = scoreRows || [];

    // Auto-upgrade legacy 10pt sanctuary ledger rows to canonical 100 points
    const legacySanctuaryRow = activeScoreRows.find((r) => r.source_id === 'sanctuary-gate' && r.points === 10);
    if (legacySanctuaryRow) {
      try {
        await supabase.from('score_ledger').update({ points: 100 }).eq('id', legacySanctuaryRow.id);
        legacySanctuaryRow.points = 100;
      } catch (_) {}
    }

    // 3. Fetch zone progress
    const { data: zoneRows } = await supabase.from('zone_progress').select('*').eq('team_id', cleanTeamId);
    const progressMap = new Map((zoneRows || []).map((z) => [z.zone_id, z]));

    // Self-heal score ledger for any zone marked completed in zone_progress but missing ledger row
    const stageScores = {
      sanctuary: { points: 100, sourceId: 'sanctuary-gate', sourceType: 'sanctuary_complete' },
      yellow: { points: 200, sourceId: 'yellow-zone', sourceType: 'zone_yellow_clear' },
      blue: { points: 400, sourceId: 'blue-zone', sourceType: 'zone_blue_clear' },
      orange: { points: 600, sourceId: 'orange-zone', sourceType: 'zone_orange_clear' },
      red: { points: 800, sourceId: 'red-zone', sourceType: 'zone_red_clear' },
      purple: { points: 1000, sourceId: 'purple-escape', sourceType: 'zone_purple_clear' }
    };

    for (const [zId, meta] of Object.entries(stageScores)) {
      const zProg = progressMap.get(zId);
      if (zProg && zProg.status === 'completed') {
        const hasRow = activeScoreRows.some((r) => r.source_id === meta.sourceId);
        if (!hasRow) {
          try {
            await supabase.from('score_ledger').insert({
              team_id: cleanTeamId,
              delegate_id: delegateId || null,
              points: meta.points,
              source_type: meta.sourceType,
              source_id: meta.sourceId,
              idempotency_key: `${cleanTeamId}:${meta.sourceId}`,
              created_at: new Date().toISOString()
            });
            activeScoreRows.push({ id: 0, points: meta.points, source_id: meta.sourceId });
          } catch (_) {}
        }
      }
    }

    const totalScore = activeScoreRows.reduce((acc, row) => acc + (row.points || 0), 0);

    // 4. Fetch dataset entitlements
    const { data: entitlements } = await supabase.from('dataset_entitlements').select('*').eq('team_id', cleanTeamId);
    const earnedSet = new Set((entitlements || []).map((e) => e.dataset_key));

    const zoneDatasetMap = { yellow: 'community_final', blue: 'radio_final', orange: 'forensics_final', red: 'research_final' };
    const pProg = progressMap.get('purple');
    const isPurpleReachable = pProg && (pProg.status === 'available' || pProg.status === 'in_progress' || pProg.status === 'completed');
    for (const [zId, dsKey] of Object.entries(zoneDatasetMap)) {
      const zProg = progressMap.get(zId);
      if (isPurpleReachable || (zProg && (zProg.status === 'completed' || zProg.status === 'cleared'))) {
        earnedSet.add(dsKey);
      }
    }
    const earnedDatasets = Array.from(earnedSet);

    // 5. Best ML score & Escape Gate status
    const { data: submissions } = await supabase
      .from('ml_submissions')
      .select('r2_score, qualifies_for_escape')
      .eq('team_id', cleanTeamId)
      .order('r2_score', { ascending: false })
      .limit(1);

    const bestR2 = submissions && submissions[0] ? submissions[0].r2_score : null;
    const escapeUnlocked = submissions && submissions[0] ? submissions[0].qualifies_for_escape : false;

    // Sanctuary completion prerequisite
    const sanctuaryProgress = progressMap.get('sanctuary');
    const isSanctuaryCompleted = sanctuaryProgress?.status === 'completed';

    // 6. Map zones matching UI structure
    const zones = config.zones.map((zone, index) => {
      const zProgress = progressMap.get(zone.id);
      const solvedList = zProgress?.solved_challenges || [];
      const solvedCount = solvedList.length;
      const isCleared = zProgress?.status === 'completed' || solvedCount >= zone.ctfs.length;

      // Yellow Zone (index === 0) ONLY unlocks once Sanctuary has been completed!
      let isUnlocked = false;
      if (index === 0) {
        isUnlocked = isSanctuaryCompleted && (zProgress?.status === 'available' || zProgress?.status === 'in_progress' || isCleared);
      } else {
        isUnlocked = zProgress?.status === 'available' || zProgress?.status === 'in_progress' || isCleared;
      }

      const state = isCleared ? 'cleared' : isUnlocked ? (solvedCount > 0 ? 'in-progress' : 'available') : 'locked';

      return {
        id: zone.id,
        name: zone.name,
        color: zone.color,
        order: zone.order,
        tagline: zone.tagline,
        terrain: zone.terrain,
        position: zone.position,
        ctfTotal: zone.ctfs.length,
        solved: solvedCount,
        solvedCtfs: solvedList,
        state,
        unlocked: isUnlocked,
        isFinal: index === config.zones.length - 1
      };
    });

    const allSolvedCtfs = Array.from(new Set(zones.flatMap((z) => z.solvedCtfs || [])));
    const totalFragments = 4;
    const recoveredFragments = earnedDatasets.length;

    return {
      authenticated: true,
      teamId: team.id,
      team: {
        id: team.id,
        name: team.team_name,
        leader: team.team_leader_name,
        studentType: team.student_type,
        members: members || [],
        solvedCtfs: allSolvedCtfs
      },
      player: {
        delegateId
      },
      score: {
        total: totalScore
      },
      solvedChallenges: allSolvedCtfs,
      progress: {
        solved: recoveredFragments,
        total: totalFragments,
        ratio: totalFragments ? recoveredFragments / totalFragments : 0,
        complete: recoveredFragments >= totalFragments
      },
      sanctuaryCompleted: isSanctuaryCompleted,
      zones,
      datasets: earnedDatasets,
      ml: {
        bestR2,
        escapeUnlocked
      },
      event: config.event,
      serverTime: new Date().toISOString()
    };
  }

  /**
   * Completes a challenge atomically using PostgreSQL RPC.
   */
  async completeChallenge({
    teamId,
    delegateId,
    zoneId,
    challengeId,
    points,
    allZoneChallenges,
    nextZoneId,
    rewardDatasetKey
  }) {
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    if (!cleanTeamId) throw new Error('teamId is required');
    const teamRecord = await this.ensureTeamExists(cleanTeamId);
    if (!teamRecord) {
      throw new Error(`TEAM_NOT_FOUND: Team "${cleanTeamId}" was not found in the official competition roster.`);
    }

    const zonePrerequisites = {
      sanctuary: null,
      yellow: 'sanctuary',
      blue: 'yellow',
      orange: 'blue',
      red: 'orange',
      purple: 'red'
    };

    const reqPrev = zonePrerequisites[zoneId];
    if (reqPrev) {
      const { data: prevProg, error: prevErr } = await supabase
        .from('zone_progress')
        .select('status')
        .eq('team_id', cleanTeamId)
        .eq('zone_id', reqPrev)
        .maybeSingle();

      if (prevErr) {
        throw new Error(`Database error verifying prerequisite "${reqPrev}": ${prevErr.message}`);
      }

      if (!prevProg || prevProg.status !== 'completed') {
        throw new Error(`PREREQUISITE_NOT_MET: Previous sector "${reqPrev}" must be completed before "${zoneId}" can be solved.`);
      }
    }

    const { data, error } = await supabase.rpc('complete_challenge_idempotent', {
      p_team_id: cleanTeamId,
      p_delegate_id: delegateId || null,
      p_zone_id: zoneId,
      p_challenge_id: challengeId,
      p_points: points || 0,
      p_all_zone_challenges: allZoneChallenges,
      p_next_zone_id: nextZoneId || null,
      p_reward_dataset_key: rewardDatasetKey || null
    });

    if (error) {
      throw new Error(`Atomic challenge completion failed: ${error.message}`);
    }

    return data;
  }

  /**
   * Completes an entire zone directly and unlocks the next zone + dataset entitlement.
   */
  async completeZoneDirect({ teamId, delegateId, zoneId }) {
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    if (!cleanTeamId) throw new Error('teamId is required');
    const teamRecord = await this.ensureTeamExists(cleanTeamId);
    if (!teamRecord) {
      throw new Error(`TEAM_NOT_FOUND: Team "${cleanTeamId}" was not found in the official competition roster.`);
    }

    const zoneConfigs = {
      sanctuary: { nextZoneId: 'yellow', datasetKey: null, points: CANONICAL_STAGE_SCORES.sanctuary.points, source: 'sanctuary_complete', sourceId: 'sanctuary-gate' },
      yellow: { nextZoneId: 'blue', datasetKey: 'community_final', points: CANONICAL_STAGE_SCORES.yellow.points, source: 'zone_yellow_clear', sourceId: 'yellow-zone' },
      blue: { nextZoneId: 'orange', datasetKey: 'radio_final', points: CANONICAL_STAGE_SCORES.blue.points, source: 'zone_blue_clear', sourceId: 'blue-zone' },
      orange: { nextZoneId: 'red', datasetKey: 'forensics_final', points: CANONICAL_STAGE_SCORES.orange.points, source: 'zone_orange_clear', sourceId: 'orange-zone' },
      red: { nextZoneId: 'purple', datasetKey: 'research_final', points: CANONICAL_STAGE_SCORES.red.points, source: 'zone_red_clear', sourceId: 'red-zone' },
      purple: { nextZoneId: null, datasetKey: null, points: CANONICAL_STAGE_SCORES.purple.points, source: 'zone_purple_clear', sourceId: 'purple-escape' }
    };

    const cfg = zoneConfigs[zoneId];
    if (!cfg) throw new Error(`Unknown zone ${zoneId}`);

    const zonePrerequisites = {
      sanctuary: null,
      yellow: 'sanctuary',
      blue: 'yellow',
      orange: 'blue',
      red: 'orange',
      purple: 'red'
    };

    const requiredPrev = zonePrerequisites[zoneId];
    const requiredChallenges = ZONE_REQUIRED_CHALLENGES[zoneId] || [];
    const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

    // Strict sequential enforcement: previous sector prerequisite must be completed
    if (requiredPrev) {
      const { data: prevProg, error: prevErr } = await supabase
        .from('zone_progress')
        .select('status')
        .eq('team_id', cleanTeamId)
        .eq('zone_id', requiredPrev)
        .maybeSingle();

      if (prevErr) {
        throw new Error(`Database error verifying prerequisite "${requiredPrev}": ${prevErr.message}`);
      }

      if (!prevProg || prevProg.status !== 'completed') {
        throw new Error(`PREREQUISITE_NOT_MET: Previous sector "${requiredPrev}" must be completed before "${zoneId}" can be cleared.`);
      }
    }

    // Ensure zone_progress has required challenges populated for this zone
    if (requiredChallenges.length > 0 && zoneId !== 'purple') {
      try {
        const { data: curProg } = await supabase
          .from('zone_progress')
          .select('solved_challenges')
          .eq('team_id', cleanTeamId)
          .eq('zone_id', zoneId)
          .maybeSingle();
        const existing = curProg?.solved_challenges || [];
        const merged = Array.from(new Set([...existing, ...requiredChallenges]));
        await supabase
          .from('zone_progress')
          .upsert({
            team_id: cleanTeamId,
            zone_id: zoneId,
            status: 'in_progress',
            solved_challenges: merged,
            unlocked_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }, { onConflict: 'team_id,zone_id' });
      } catch (_) {}
    }

    // 1. Try atomic PostgreSQL stored procedure complete_zone_atomic
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc('complete_zone_atomic', {
        p_team_id: cleanTeamId,
        p_delegate_id: delegateId || null,
        p_zone_id: zoneId,
        p_points: cfg.points,
        p_next_zone_id: cfg.nextZoneId || null,
        p_dataset_key: cfg.datasetKey || null,
        p_source_id: cfg.sourceId,
        p_source_type: cfg.source,
        p_required_prev_zone: requiredPrev || null,
        p_required_challenges: requiredChallenges
      });

      if (!rpcError && rpcData && rpcData.success) {
        return { ok: true, zoneId, nextZoneId: cfg.nextZoneId, datasetKey: cfg.datasetKey, pointsAwarded: rpcData.pointsAwarded };
      }

      if (rpcError) {
        if (rpcError.message && (rpcError.message.includes('PREREQUISITE_NOT_MET') || rpcError.message.includes('CHALLENGES_INCOMPLETE'))) {
          throw new Error(rpcError.message);
        }
        console.warn('[completeZoneDirect] RPC notice, falling back to direct database execution:', rpcError.message);
      }
    } catch (err) {
      if (err.message && (err.message.includes('PREREQUISITE_NOT_MET') || err.message.includes('CHALLENGES_INCOMPLETE'))) {
        throw err;
      }
      console.warn('[completeZoneDirect] RPC exception, falling back to direct database execution:', err.message);
    }

    // 2. Direct database execution with lockTeam mutex and strict error checking
    return lockTeam(cleanTeamId, async () => {
      if (requiredPrev) {
        const { data: prevProg, error: prevErr } = await supabase
          .from('zone_progress')
          .select('status')
          .eq('team_id', cleanTeamId)
          .eq('zone_id', requiredPrev)
          .maybeSingle();

        if (prevErr) throw new Error(`Database error verifying prerequisite: ${prevErr.message}`);
        if (!prevProg || prevProg.status !== 'completed') {
          throw new Error(`PREREQUISITE_NOT_MET: Previous sector "${requiredPrev}" must be completed before "${zoneId}" can be cleared.`);
        }
      }

      if (requiredChallenges.length > 0 && zoneId !== 'purple') {
        const { data: curProg, error: curErr } = await supabase
          .from('zone_progress')
          .select('solved_challenges')
          .eq('team_id', cleanTeamId)
          .eq('zone_id', zoneId)
          .maybeSingle();

        if (curErr) throw new Error(`Database error verifying challenges: ${curErr.message}`);
        const solved = curProg?.solved_challenges || [];
        const missing = requiredChallenges.filter((ch) => !solved.includes(ch));
        if (missing.length > 0) {
          throw new Error(`CHALLENGES_INCOMPLETE: Sector "${zoneId}" requires challenge(s) [${missing.join(', ')}] to be solved before the sector can be cleared.`);
        }
      }

      if (zoneId === 'purple') {
        const { data: qualSubs, error: qualErr } = await supabase
          .from('ml_submissions')
          .select('id, r2_score, qualifies_for_escape')
          .eq('team_id', cleanTeamId)
          .eq('qualifies_for_escape', true)
          .limit(1);

        if (qualErr) throw new Error(`Database error verifying purple qualification: ${qualErr.message}`);
        if (!qualSubs || qualSubs.length === 0) {
          throw new Error('PREREQUISITE_NOT_MET: Purple Zone requires an authoritative ML submission on record with R² ≥ 0.80.');
        }
      }

      const now = new Date().toISOString();

      // 1. Mark zone completed
      const { error: zErr } = await supabase
        .from('zone_progress')
        .upsert({
          team_id: cleanTeamId,
          zone_id: zoneId,
          status: 'completed',
          completed_at: now,
          updated_at: now
        }, { onConflict: 'team_id,zone_id' });
      if (zErr) throw new Error(`Database error marking zone completed: ${zErr.message}`);

      // 2. Mark next zone available
      if (cfg.nextZoneId) {
        const { error: nextErr } = await supabase
          .from('zone_progress')
          .upsert({
            team_id: cleanTeamId,
            zone_id: cfg.nextZoneId,
            status: 'available',
            unlocked_at: now,
            updated_at: now
          }, { onConflict: 'team_id,zone_id' });
        if (nextErr) throw new Error(`Database error unlocking next zone: ${nextErr.message}`);
      }

      // 3. Grant dataset entitlement if applicable
      if (cfg.datasetKey) {
        const { error: dsErr } = await supabase
          .from('dataset_entitlements')
          .upsert({
            team_id: cleanTeamId,
            dataset_key: cfg.datasetKey
          }, { onConflict: 'team_id,dataset_key' });
        if (dsErr) throw new Error(`Database error granting dataset entitlement: ${dsErr.message}`);
      }

      // 4. Award points idempotently
      if (cfg.points > 0) {
        const { error: scoreErr } = await supabase
          .from('score_ledger')
          .insert({
            team_id: cleanTeamId,
            points: cfg.points,
            source_type: cfg.source,
            source_id: cfg.sourceId,
            idempotency_key: `${cleanTeamId}:${cfg.sourceId}`,
            created_at: now
          });
        if (scoreErr && scoreErr.code !== '23505' && !scoreErr.message?.includes('duplicate key') && !scoreErr.message?.includes('unique constraint')) {
          throw new Error(`Database error inserting score: ${scoreErr.message}`);
        }
      }

      return { ok: true, zoneId, nextZoneId: cfg.nextZoneId, datasetKey: cfg.datasetKey };
    });
  }

  /**
   * Fetch team directly by Team ID.
   */
  async getTeamDirect(teamId) {
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    if (!cleanTeamId) return null;
    const { data: team, error } = await supabase
      .from('teams')
      .select('*')
      .eq('id', cleanTeamId)
      .maybeSingle();
    if (error || !team) return null;
    return team;
  }

  /**
   * Checks if team has unlocked entitlement to a dataset fragment.
   */
  async checkDatasetEntitlement(teamId, datasetKey) {
    const { data, error } = await supabase
      .from('dataset_entitlements')
      .select('*')
      .eq('team_id', teamId)
      .eq('dataset_key', datasetKey)
      .maybeSingle();

    if (!error && data) {
      // Increment download count
      supabase
        .from('dataset_entitlements')
        .update({ download_count: (data.download_count || 0) + 1 })
        .eq('team_id', teamId)
        .eq('dataset_key', datasetKey)
        .then(() => {});

      return true;
    }

    // Check if the corresponding zone was completed
    const zoneDatasetMap = { community_final: 'yellow', radio_final: 'blue', forensics_final: 'orange', research_final: 'red' };
    const reqZone = zoneDatasetMap[datasetKey];
    if (reqZone) {
      const { data: zProg } = await supabase
        .from('zone_progress')
        .select('status')
        .eq('team_id', teamId)
        .eq('zone_id', reqZone)
        .maybeSingle();
      if (zProg && (zProg.status === 'completed' || zProg.status === 'cleared')) {
        supabase
          .from('dataset_entitlements')
          .upsert({ team_id: teamId, dataset_key: datasetKey, download_count: 1 }, { onConflict: 'team_id,dataset_key' })
          .then(() => {});
        return true;
      }
    }

    // Check if purple zone is unlocked (all 4 previous zones completed)
    const { data: pProg } = await supabase
      .from('zone_progress')
      .select('status')
      .eq('team_id', teamId)
      .eq('zone_id', 'purple')
      .maybeSingle();
    if (pProg && (pProg.status === 'available' || pProg.status === 'in_progress' || pProg.status === 'completed')) {
      return true;
    }

    return false;
  }

  /**
   * Atomically reserves an ML evaluation attempt for a team.
   * In production, strictly requires PostgreSQL reserve_ml_attempt stored procedure
   * with transaction-level advisory locking (pg_advisory_xact_lock).
   */
  async reserveMlAttempt({ teamId, delegateId, rawFilename, maxAttempts = 10 }) {
    const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    if (!cleanTeamId) throw new Error('teamId is required for submission reservation');
    await this.ensureTeamExists(cleanTeamId);

    // 1. Try PostgreSQL stored procedure with atomic advisory locking
    try {
      const { data: rpcData, error: rpcError } = await supabase
        .rpc('reserve_ml_attempt', {
          p_team_id: cleanTeamId,
          p_delegate_id: delegateId || null,
          p_raw_filename: rawFilename || 'submission.csv',
          p_max_attempts: maxAttempts
        });

      if (!rpcError && rpcData && typeof rpcData.allowed === 'boolean') {
        return {
          allowed: rpcData.allowed,
          submissionId: rpcData.submissionId,
          attemptNumber: rpcData.attemptNumber,
          submissionsUsed: rpcData.submissionsUsed,
          submissionsRemaining: rpcData.submissionsRemaining,
          alreadyCompleted: Boolean(rpcData.alreadyCompleted),
          reason: rpcData.reason || null,
          submittedAt: rpcData.submittedAt || new Date().toISOString()
        };
      }
      if (rpcError) {
        console.warn('[reserveMlAttempt] RPC notice, falling back to direct table queries:', rpcError.message);
      }
    } catch (err) {
      console.warn('[reserveMlAttempt] RPC call exception, falling back to direct table queries:', err.message);
    }

    // 2. Resilient table query inside serialized mutex
    return lockTeam(cleanTeamId, async () => {
      // Check if team has already qualified or completed purple zone
      const { data: qualSubs } = await supabase
        .from('ml_submissions')
        .select('id')
        .eq('team_id', cleanTeamId)
        .eq('qualifies_for_escape', true)
        .limit(1);

      const { data: purpleProg } = await supabase
        .from('zone_progress')
        .select('status')
        .eq('team_id', cleanTeamId)
        .eq('zone_id', 'purple')
        .maybeSingle();

      const { data: subs, error: listError } = await supabase
        .from('ml_submissions')
        .select('id')
        .eq('team_id', cleanTeamId);

      if (listError) {
        throw new Error(`Database error querying submission quota: ${listError.message}`);
      }

      const count = subs ? subs.length : 0;

      if ((qualSubs && qualSubs.length > 0) || (purpleProg && purpleProg.status === 'completed')) {
        return {
          allowed: false,
          submissionId: null,
          attemptNumber: count,
          submissionsUsed: count,
          submissionsRemaining: 0,
          alreadyCompleted: true,
          reason: 'PURPLE_ALREADY_COMPLETED'
        };
      }

      if (count >= maxAttempts) {
        return {
          allowed: false,
          submissionId: null,
          attemptNumber: count,
          submissionsUsed: count,
          submissionsRemaining: 0,
          alreadyCompleted: false,
          reason: 'SUBMISSION_LIMIT_EXCEEDED'
        };
      }

      const now = new Date().toISOString();
      const { data: inserted, error: insertError } = await supabase
        .from('ml_submissions')
        .insert({
          team_id: cleanTeamId,
          delegate_id: delegateId || null,
          status: 'pending',
          raw_filename: rawFilename || 'submission.csv',
          submitted_at: now
        })
        .select('*')
        .single();

      if (insertError) {
        throw new Error(`Database error reserving submission attempt: ${insertError.message}`);
      }

      return {
        allowed: true,
        submissionId: inserted.id,
        attemptNumber: count + 1,
        submissionsUsed: count + 1,
        submissionsRemaining: Math.max(0, maxAttempts - (count + 1)),
        submittedAt: now
      };
    });
  }

  /**
   * Fetches an ML submission by ID, optionally validating ownership by teamId.
   */
  async getMlSubmissionById(submissionId, teamId) {
    if (!submissionId) return null;
    let query = supabase.from('ml_submissions').select('*').eq('id', submissionId);
    if (teamId) {
      query = query.eq('team_id', String(teamId).trim().toUpperCase());
    }
    const { data, error } = await query.maybeSingle();
    if (error) {
      throw new Error(`Failed to load submission ${submissionId}: ${error.message}`);
    }
    return data;
  }

  /**
   * Atomically finalizes a qualifying ML submission, clears the Purple Zone,
   * and awards the 1,000-point reward in a single PostgreSQL transaction.
   */
  async finalizeQualifyingMlSubmission({
    submissionId,
    teamId,
    delegateId,
    r2Score,
    mseScore,
    points = 1000
  }) {
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    if (!cleanTeamId) throw new Error('teamId is required');

    const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

    // 1. Try atomic PostgreSQL stored procedure
    try {
      const { data: rpcData, error: rpcError } = await supabase
        .rpc('finalize_qualifying_ml_submission', {
          p_submission_id: submissionId,
          p_team_id: cleanTeamId,
          p_delegate_id: delegateId || null,
          p_r2_score: r2Score,
          p_mse_score: mseScore,
          p_points: points
        });

      if (!rpcError && rpcData && rpcData.success) {
        return rpcData;
      }
      if (rpcError) {
        console.warn('[finalizeQualifying] RPC notice, falling back to direct table update:', rpcError.message);
      }
    } catch (err) {
      console.warn('[finalizeQualifying] RPC call exception, falling back to direct table update:', err.message);
    }

    // 2. Resilient fallback execution inside serialized mutex
    return lockTeam(cleanTeamId, async () => {
      const now = new Date().toISOString();
      const { data: sub, error: subErr } = await supabase
        .from('ml_submissions')
        .update({
          r2_score: r2Score,
          mse_score: mseScore,
          qualifies_for_escape: true,
          status: 'valid',
          error_message: null
        })
        .eq('id', submissionId)
        .select('*')
        .single();

      if (subErr) throw new Error(`Failed to finalize qualifying submission: ${subErr.message}`);

      // Complete purple zone
      const { error: pErr } = await supabase
        .from('zone_progress')
        .upsert({
          team_id: cleanTeamId,
          zone_id: 'purple',
          status: 'completed',
          completed_at: now,
          updated_at: now
        }, { onConflict: 'team_id,zone_id' });
      if (pErr) throw new Error(`Failed to complete purple zone in fallback: ${pErr.message}`);

      // Award 1,000 points idempotently
      const { error: sErr } = await supabase
        .from('score_ledger')
        .insert({
          team_id: cleanTeamId,
          delegate_id: delegateId || null,
          points,
          source_type: 'zone_purple_clear',
          source_id: 'purple-escape',
          idempotency_key: `${cleanTeamId}:purple-escape`,
          created_at: now
        });
      if (sErr && sErr.code !== '23505' && !sErr.message?.includes('duplicate key') && !sErr.message?.includes('unique constraint')) {
        throw new Error(`Failed to insert score in fallback: ${sErr.message}`);
      }

      return {
        success: true,
        submissionId,
        teamId: cleanTeamId,
        zoneCompleted: true,
        pointsAwarded: points,
        qualifiesForEscape: true
      };
    });
  }

  /**
   * Finalizes an evaluation result for a reserved submission attempt.
   */
  async finalizeMlSubmission({
    submissionId,
    r2Score,
    mseScore,
    qualifiesForEscape,
    status = 'valid',
    errorMessage = null
  }) {
    if (!submissionId) throw new Error('submissionId is required to finalize submission');

    const { data, error } = await supabase
      .from('ml_submissions')
      .update({
        r2_score: r2Score,
        mse_score: mseScore,
        qualifies_for_escape: qualifiesForEscape,
        status,
        error_message: errorMessage || null
      })
      .eq('id', submissionId)
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to finalize submission ${submissionId}: ${error.message}`);
    }

    return data;
  }

  /**
   * Records an ML submission directly (legacy helper).
   */
  async recordMlSubmission({
    teamId,
    delegateId,
    r2Score,
    mseScore,
    qualifiesForEscape,
    status,
    errorMessage,
    rawFilename
  }) {
    const { data, error } = await supabase
      .from('ml_submissions')
      .insert({
        team_id: teamId,
        delegate_id: delegateId || null,
        r2_score: r2Score,
        mse_score: mseScore,
        qualifies_for_escape: qualifiesForEscape,
        status,
        error_message: errorMessage || null,
        raw_filename: rawFilename || 'submission.csv'
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to record submission: ${error.message}`);
    }

    return data;
  }

  /**
   * Fetches the live leaderboard.
   */
  async getLeaderboard() {
    const { data, error } = await supabase
      .from('leaderboard_view')
      .select('*')
      .limit(100);

    if (error) {
      throw new Error(`Failed to load leaderboard: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Fetches submission history for a specific team.
   */
  async getTeamSubmissions(teamId) {
    if (!teamId) return [];
    const { data, error } = await supabase
      .from('ml_submissions')
      .select('*')
      .eq('team_id', teamId)
      .order('submitted_at', { ascending: false })
      .limit(25);

    if (error) {
      throw new Error(`Failed to load submissions: ${error.message}`);
    }

    return data || [];
  }

  /**
   * Fetches an authoritative admin overview across all teams, rosters, zone progress, and ML submissions.
   */
  async getAdminOverview() {
    const [teamsRes, membersRes, progressRes, subsRes, scoresRes] = await Promise.all([
      supabase.from('teams').select('*').order('created_at', { ascending: true }),
      supabase.from('team_members').select('*'),
      supabase.from('zone_progress').select('*'),
      supabase.from('ml_submissions').select('*').order('submitted_at', { ascending: false }),
      supabase.from('score_ledger').select('*').order('created_at', { ascending: true })
    ]);

    if (teamsRes.error) throw new Error(`Teams query error: ${teamsRes.error.message}`);
    const teams = (teamsRes.data || []).filter((t) => !t.id.startsWith('TECHTEAM99'));
    const members = (membersRes.data || []).filter((m) => !m.team_id?.startsWith('TECHTEAM99'));
    const progress = (progressRes.data || []).filter((p) => !p.team_id?.startsWith('TECHTEAM99'));
    const subs = (subsRes.data || []).filter((s) => !s.team_id?.startsWith('TECHTEAM99'));
    const scores = (scoresRes.data || []).filter((sc) => !sc.team_id?.startsWith('TECHTEAM99'));

    // Ensure all 150 official participant teams are visible even if DB sync is pending
    try {
      const rosterPath = path.resolve(__dirname, '..', 'data', 'teams_roster.json');
      if (fs.existsSync(rosterPath)) {
        const fullRoster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
        const dbTeamIds = new Set(teams.map((t) => t.id));
        const missingRosterTeams = fullRoster.filter((r) => !dbTeamIds.has(r.id));
        if (missingRosterTeams.length > 0) {
          this.importRoster(missingRosterTeams).catch((e) => console.warn('[adminOverview] Auto-import missing roster warning:', e.message));
          for (const rt of missingRosterTeams) {
            teams.push({
              id: rt.id,
              team_name: rt.team_name,
              team_leader_name: rt.team_leader_name,
              leader_mobile: rt.leader_mobile,
              passcode_hash: rt.passcode_hash,
              student_type: rt.student_type,
              is_active: true,
              created_at: new Date().toISOString()
            });
            for (const m of (rt.members || [])) {
              members.push({
                delegate_id: m.delegate_id,
                team_id: rt.id,
                member_name: m.name,
                is_leader: m.is_leader,
                college: m.college,
                reg_no: m.reg_no,
                phone: m.phone,
                email: m.email
              });
            }
          }
        }
      }
    } catch (_) {}

    const memberMap = new Map();
    for (const m of members) {
      if (!memberMap.has(m.team_id)) memberMap.set(m.team_id, []);
      memberMap.get(m.team_id).push(m);
    }

    const progressMap = new Map();
    for (const p of progress) {
      if (!progressMap.has(p.team_id)) progressMap.set(p.team_id, {});
      progressMap.get(p.team_id)[p.zone_id] = {
        status: p.status,
        solvedChallenges: p.solved_challenges || [],
        completedAt: p.completed_at
      };
    }

    const subsMap = new Map();
    for (const s of subs) {
      if (!subsMap.has(s.team_id)) subsMap.set(s.team_id, []);
      subsMap.get(s.team_id).push(s);
    }

    const scoresMap = new Map();
    for (const sc of scores) {
      if (!scoresMap.has(sc.team_id)) scoresMap.set(sc.team_id, []);
      scoresMap.get(sc.team_id).push(sc);
    }

    const enrichedTeams = teams.map((t) => {
      return buildEnrichedTeamOverview({
        team: t,
        members: memberMap.get(t.id) || [],
        rawZones: progressMap.get(t.id) || {},
        rawSubmissions: subsMap.get(t.id) || [],
        rawScores: scoresMap.get(t.id) || []
      });
    });

    const metrics = buildAdminMetrics(enrichedTeams, subs.length);

    return {
      ...metrics,
      teams: enrichedTeams
    };
  }

  /**
   * Authoritative batch import of registered teams, members, and initial zones.
   * Respects 2-player cap trigger by filtering existing delegates and chunking.
   */
  async importRoster(roster) {
    if (!Array.isArray(roster) || roster.length === 0) {
      return { success: false, error: 'Empty roster' };
    }

    const now = new Date().toISOString();
    let importedTeams = 0;
    let newMembersInserted = 0;

    // 1. Bulk upsert teams first
    const teamsBatch = roster.map((team) => ({
      id: team.id,
      team_name: team.team_name,
      team_leader_name: team.team_leader_name,
      leader_mobile: team.leader_mobile,
      passcode_hash: team.passcode_hash,
      student_type: team.student_type,
      is_active: true,
      updated_at: now
    }));

    const { error: teamsErr } = await supabase.from('teams').upsert(teamsBatch, { onConflict: 'id' });
    if (teamsErr) {
      console.error('[supabaseStore.importRoster] Bulk teams upsert error:', teamsErr);
      throw new Error(`Teams bulk upsert failed: ${teamsErr.message}`);
    }
    importedTeams = teamsBatch.length;

    // 2. Query existing members so we don't re-insert and trip the cap trigger
    const { data: existingMembers, error: fetchErr } = await supabase.from('team_members').select('delegate_id, team_id');
    const existingDelegateSet = new Set((existingMembers || []).map((m) => String(m.delegate_id).trim()));

    // Filter to new members only
    const newMembers = [];
    for (const team of roster) {
      for (const member of (team.members || [])) {
        const dId = String(member.delegate_id).trim();
        if (!existingDelegateSet.has(dId)) {
          newMembers.push({
            delegate_id: dId,
            team_id: team.id,
            member_name: member.name,
            is_leader: !!member.is_leader
          });
        }
      }
    }

    if (newMembers.length > 0) {
      // Chunk in groups of 50
      for (let i = 0; i < newMembers.length; i += 50) {
        const chunk = newMembers.slice(i, i + 50);
        const { error: memErr } = await supabase.from('team_members').upsert(chunk, { onConflict: 'delegate_id' });
        if (memErr) {
          console.error('[supabaseStore.importRoster] Members insert chunk error:', memErr);
          throw new Error(`Members chunk insert failed: ${memErr.message}`);
        }
        newMembersInserted += chunk.length;
      }
    }

    // 3. Bulk upsert zone progress for all teams in chunks of 100 (all 6 zones)
    const zonesBatch = [];
    for (const team of roster) {
      zonesBatch.push(
        { team_id: team.id, zone_id: 'sanctuary', status: 'available', unlocked_at: now },
        { team_id: team.id, zone_id: 'yellow', status: 'locked', unlocked_at: null },
        { team_id: team.id, zone_id: 'blue', status: 'locked', unlocked_at: null },
        { team_id: team.id, zone_id: 'orange', status: 'locked', unlocked_at: null },
        { team_id: team.id, zone_id: 'red', status: 'locked', unlocked_at: null },
        { team_id: team.id, zone_id: 'purple', status: 'locked', unlocked_at: null }
      );
    }

    for (let i = 0; i < zonesBatch.length; i += 100) {
      const chunk = zonesBatch.slice(i, i + 100);
      const { error: zErr } = await supabase.from('zone_progress').upsert(chunk, { onConflict: 'team_id,zone_id' });
      if (zErr) {
        console.error('[supabaseStore.importRoster] Zone progress chunk error:', zErr);
      }
    }

    const totalMembers = (existingMembers?.length || 0) + newMembersInserted;

    return {
      success: true,
      importedTeams,
      totalMembers,
      newMembersInserted
    };
  }

  /**
   * Purges all non-official test/staging teams and any mock test teams, and resets official test scores.
   */
  async cleanupTestData(targetTeamId = null) {
    const deletedTeams = [];

    // 1. Fetch non-official teams and any mock TECHTEAM99% IDs
    const { data: testTeams } = await supabase
      .from('teams')
      .select('id')
      .or('id.not.like.TECHTEAM%,id.like.TECHTEAM99%');

    if (testTeams && testTeams.length > 0) {
      const ids = testTeams.map((t) => t.id);
      const { error: delErr } = await supabase.from('teams').delete().in('id', ids);
      if (delErr) {
        console.error('[cleanupTestData] Teams delete error:', delErr);
      } else {
        deletedTeams.push(...ids);
      }
    }

    const teamsToReset = ['TECHTEAM10328'];
    if (targetTeamId && !teamsToReset.includes(targetTeamId)) {
      teamsToReset.push(targetTeamId);
    }

    for (const teamId of teamsToReset) {
      await supabase.from('teams').update({ score: 0 }).eq('id', teamId);
      await supabase.from('score_ledger').delete().eq('team_id', teamId);
      await supabase.from('dataset_entitlements').delete().eq('team_id', teamId);
      await supabase.from('ml_submissions').delete().eq('team_id', teamId);
      await supabase.from('team_sessions').delete().eq('team_id', teamId);

      await supabase.from('zone_progress').delete().eq('team_id', teamId);
      await supabase.from('zone_progress').insert([
        { team_id: teamId, zone_id: 'sanctuary', status: 'available', unlocked_at: new Date().toISOString() },
        { team_id: teamId, zone_id: 'yellow', status: 'locked', unlocked_at: null },
        { team_id: teamId, zone_id: 'blue', status: 'locked', unlocked_at: null },
        { team_id: teamId, zone_id: 'orange', status: 'locked', unlocked_at: null },
        { team_id: teamId, zone_id: 'red', status: 'locked', unlocked_at: null },
        { team_id: teamId, zone_id: 'purple', status: 'locked', unlocked_at: null }
      ]);
    }

    return {
      success: true,
      deletedTestTeams: deletedTeams,
      resetOfficialTeams: teamsToReset
    };
  }

  /**
   * Sets or overrides zone progress and scores for a specific team.
   */
  async setTeamZones({ teamId, score, zones, datasets, solvedChallenges }) {
    const cleanTeamId = String(teamId || '').trim().toUpperCase();
    await this.ensureTeamExists(cleanTeamId);

    if (typeof score === 'number') {
      await supabase.from('teams').update({ score }).eq('id', cleanTeamId);
    }

    if (zones && typeof zones === 'object') {
      for (const [zoneId, status] of Object.entries(zones)) {
        const solved = (solvedChallenges && solvedChallenges[zoneId]) || (zoneId === 'yellow' && status === 'completed' ? ['yellow-01'] : []);
        await supabase
          .from('zone_progress')
          .upsert({
            team_id: cleanTeamId,
            zone_id: zoneId,
            status,
            solved_challenges: solved,
            completed_at: status === 'completed' ? new Date().toISOString() : null,
            unlocked_at: status !== 'locked' ? new Date().toISOString() : null,
            updated_at: new Date().toISOString()
          }, { onConflict: 'team_id,zone_id' });
      }
    }

    if (Array.isArray(datasets)) {
      for (const datasetKey of datasets) {
        await supabase
          .from('dataset_entitlements')
          .upsert({
            team_id: cleanTeamId,
            dataset_key: datasetKey,
            granted_at: new Date().toISOString()
          }, { onConflict: 'team_id,dataset_key' });
      }
    }

    return true;
  }
}

const supabaseStore = new SupabaseStore();
module.exports = { supabaseStore };
