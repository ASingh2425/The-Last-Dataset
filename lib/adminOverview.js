const {
  CANONICAL_STAGE_SCORES,
  TOTAL_COMPETITION_POINTS,
  ZONE_REQUIRED_CHALLENGES,
  ZONE_PREREQUISITES
} = require('../config/scoring');

const ALL_ZONE_IDS = ['sanctuary', 'yellow', 'blue', 'orange', 'red', 'purple'];

/**
 * Normalizes zone progress into a complete 6-zone map.
 */
function normalizeZoneMap(rawZones = {}) {
  const normalized = {};
  for (const zoneId of ALL_ZONE_IDS) {
    const raw = rawZones[zoneId];
    if (raw) {
      normalized[zoneId] = {
        status: raw.status || 'locked',
        solvedChallenges: Array.isArray(raw.solvedChallenges) ? [...raw.solvedChallenges] : [],
        completedAt: raw.completedAt || null
      };
    } else {
      normalized[zoneId] = {
        status: zoneId === 'sanctuary' ? 'available' : 'locked',
        solvedChallenges: [],
        completedAt: null
      };
    }
  }
  return normalized;
}

/**
 * Computes current stage of a team based on normalized zone statuses.
 */
function computeCurrentStage(normalizedZones) {
  if (normalizedZones.purple.status === 'completed') return 'completed';
  if (normalizedZones.purple.status === 'available' || normalizedZones.red.status === 'completed') return 'purple';
  if (normalizedZones.red.status === 'available' || normalizedZones.orange.status === 'completed') return 'red';
  if (normalizedZones.orange.status === 'available' || normalizedZones.blue.status === 'completed') return 'orange';
  if (normalizedZones.blue.status === 'available' || normalizedZones.yellow.status === 'completed') return 'blue';
  if (normalizedZones.yellow.status === 'available' || normalizedZones.sanctuary.status === 'completed') return 'yellow';
  return 'sanctuary';
}

/**
 * Computes Purple status: 'locked' | 'eligible' | 'processing' | 'completed'
 */
function computePurpleStatus(normalizedZones, ml) {
  if (normalizedZones.purple.status === 'completed') return 'completed';
  if (ml.escapeUnlocked) return 'eligible';
  if (normalizedZones.red.status === 'completed' || ml.submissionsUsed > 0) return 'processing';
  return 'locked';
}

/**
 * Finds the latest activity timestamp for a team across all sources.
 */
function computeLastActivityAt(team, normalizedZones, submissions, scoreLedger) {
  const dates = [];

  if (team.updatedAt) dates.push(new Date(team.updatedAt).getTime());
  if (team.updated_at) dates.push(new Date(team.updated_at).getTime());
  if (team.createdAt) dates.push(new Date(team.createdAt).getTime());
  if (team.created_at) dates.push(new Date(team.created_at).getTime());

  for (const z of Object.values(normalizedZones)) {
    if (z.completedAt) dates.push(new Date(z.completedAt).getTime());
  }

  for (const s of submissions) {
    const timeStr = s.submittedAt || s.submitted_at;
    if (timeStr) dates.push(new Date(timeStr).getTime());
  }

  for (const sc of scoreLedger) {
    const timeStr = sc.createdAt || sc.created_at;
    if (timeStr) dates.push(new Date(timeStr).getTime());
  }

  const valid = dates.filter((d) => !Number.isNaN(d));
  if (valid.length === 0) return team.createdAt || team.created_at || null;
  return new Date(Math.max(...valid)).toISOString();
}

/**
 * Performs integrity / consistency audits on a single team.
 */
function auditTeamIntegrity({
  id,
  members,
  normalizedZones,
  score,
  ml,
  submissions,
  scoreLedger
}) {
  const inconsistencies = [];

  // 1. Two-player hard limit check
  if (members.length > 2) {
    inconsistencies.push({
      type: 'MEMBER_CAP_EXCEEDED',
      severity: 'error',
      message: `Team has ${members.length} registered members, exceeding the 2-player hard cap.`
    });
  } else if (members.length === 0) {
    inconsistencies.push({
      type: 'EMPTY_ROSTER',
      severity: 'warning',
      message: 'Team has no registered player members.'
    });
  }

  // 2. Zone sequence & prerequisites audit
  for (const zoneId of ALL_ZONE_IDS) {
    const prereq = ZONE_PREREQUISITES[zoneId];
    if (prereq) {
      const isCleared = normalizedZones[zoneId].status === 'completed';
      const prereqCleared = normalizedZones[prereq].status === 'completed';
      if (isCleared && !prereqCleared && prereq !== 'sanctuary') {
        inconsistencies.push({
          type: 'PREREQUISITE_SKIPPED',
          severity: 'error',
          message: `Zone "${zoneId}" is marked completed, but prerequisite "${prereq}" was not completed.`
        });
      }
    }
  }

  // 3. Challenge completion verification
  for (const zoneId of ALL_ZONE_IDS) {
    if (normalizedZones[zoneId].status === 'completed') {
      const required = ZONE_REQUIRED_CHALLENGES[zoneId] || [];
      const solved = normalizedZones[zoneId].solvedChallenges || [];
      for (const reqCtf of required) {
        if (!solved.includes(reqCtf)) {
          inconsistencies.push({
            type: 'MISSING_CHALLENGE',
            severity: 'warning',
            message: `Zone "${zoneId}" is marked completed, but required challenge "${reqCtf}" is not recorded as solved.`
          });
        }
      }
    }
  }

  // 4. Score verification vs completed zones
  let expectedPoints = 0;
  for (const zoneId of ALL_ZONE_IDS) {
    if (normalizedZones[zoneId].status === 'completed') {
      expectedPoints += CANONICAL_STAGE_SCORES[zoneId]?.points || 0;
    }
  }
  if (score !== expectedPoints) {
    inconsistencies.push({
      type: 'SCORE_MISMATCH',
      severity: 'error',
      message: `Recorded score (${score} pts) does not match expected canonical total for completed zones (${expectedPoints} pts).`
    });
  }

  // 5. Purple qualification check
  if (normalizedZones.purple.status === 'completed') {
    const hasQualifyingMl = submissions.some(
      (s) => s.qualifiesForEscape || s.qualifies_for_escape || (typeof (s.r2Score ?? s.r2_score) === 'number' && (s.r2Score ?? s.r2_score) >= 0.80)
    );
    if (!hasQualifyingMl) {
      inconsistencies.push({
        type: 'PURPLE_UNQUALIFIED_COMPLETION',
        severity: 'error',
        message: 'Purple zone marked completed, but no qualifying ML submission with R² >= 0.80 exists.'
      });
    }
  }

  // 6. Quota check
  if (submissions.length > 10) {
    inconsistencies.push({
      type: 'QUOTA_EXCEEDED',
      severity: 'error',
      message: `Team has submitted ${submissions.length} ML predictions, exceeding the 10-submission limit.`
    });
  }

  return inconsistencies;
}

/**
 * Builds an enriched team overview object.
 */
function buildEnrichedTeamOverview({
  team,
  members = [],
  rawZones = {},
  rawSubmissions = [],
  rawScores = []
}) {
  const id = team.id;
  const name = team.name || team.team_name || id;
  const passcode = team.passcode || null;
  const studentType = team.studentType || team.student_type || 'MAHE';

  // Normalize members
  const normalizedMembers = members.map((m) => {
    if (typeof m === 'string') {
      return { delegateId: m, name: m, isLeader: false };
    }
    return {
      delegateId: m.delegateId || m.delegate_id,
      name: m.name || m.member_name,
      isLeader: Boolean(m.isLeader ?? m.is_leader),
      college: m.college || m.college_name || null,
      regNo: m.regNo || m.reg_no || null,
      phone: m.phone || m.mobile_no || null,
      email: m.email || null
    };
  });

  const leaderMember = normalizedMembers.find((m) => m.isLeader) || normalizedMembers[0] || {};
  const leaderName = team.leaderName || team.team_leader_name || leaderMember.name || null;
  const leaderMobile = team.leaderMobile || team.leader_mobile || leaderMember.phone || null;
  const leaderEmail = team.leaderEmail || team.leader_email || leaderMember.email || null;
  const college = team.college || leaderMember.college || normalizedMembers[0]?.college || null;

  // Normalize zones
  const zones = normalizeZoneMap(rawZones);

  // Normalize ML submissions
  const submissions = rawSubmissions.map((s, idx) => {
    const r2 = typeof s.r2_score === 'number' ? s.r2_score : (typeof s.r2Score === 'number' ? s.r2Score : null);
    const mse = typeof s.mse_score === 'number' ? s.mse_score : (typeof s.mseScore === 'number' ? s.mseScore : null);
    const qualifies = Boolean(s.qualifies_for_escape || s.qualifiesForEscape || (r2 !== null && r2 >= 0.80));
    return {
      id: s.id || `sub-${idx + 1}`,
      attemptNumber: rawSubmissions.length - idx, // Most recent first
      delegateId: s.delegate_id || s.delegateId || 'UNKNOWN',
      submittedAt: s.submitted_at || s.submittedAt || null,
      r2Score: r2,
      mseScore: mse,
      qualifiesForEscape: qualifies,
      status: s.status || 'valid',
      errorMessage: s.error_message || s.errorMessage || null,
      rawFilename: s.raw_filename || s.rawFilename || 'submission.csv'
    };
  });

  // Calculate ML stats
  const bestR2 = submissions.reduce((max, s) => {
    if (typeof s.r2Score === 'number' && (max === null || s.r2Score > max)) return s.r2Score;
    return max;
  }, team.bestR2 ?? null);

  const escapeUnlocked = Boolean(
    team.escapeUnlocked ||
    submissions.some((s) => s.qualifiesForEscape) ||
    (bestR2 !== null && bestR2 >= 0.80)
  );

  const ml = {
    submissionsUsed: submissions.length,
    bestR2,
    escapeUnlocked,
    submissions
  };

  // Normalize score ledger
  const scoreLedger = rawScores.map((sc) => ({
    id: sc.id,
    delegateId: sc.delegate_id || sc.delegateId || null,
    points: sc.points || 0,
    sourceType: sc.source_type || sc.sourceType || null,
    sourceId: sc.source_id || sc.sourceId || null,
    idempotencyKey: sc.idempotency_key || sc.idempotencyKey || null,
    createdAt: sc.created_at || sc.createdAt || null
  }));

  // Total score: sum from score ledger or recorded score
  const ledgerSum = scoreLedger.reduce((sum, entry) => sum + (entry.points || 0), 0);
  const score = scoreLedger.length > 0 ? ledgerSum : (team.score || 0);

  // Compute stages
  const currentStage = computeCurrentStage(zones);
  const completedStages = ALL_ZONE_IDS.filter((z) => zones[z].status === 'completed');
  const purpleStatus = computePurpleStatus(zones, ml);
  const lastActivityAt = computeLastActivityAt(team, zones, submissions, scoreLedger);

  // Audit inconsistencies
  const inconsistencies = auditTeamIntegrity({
    id,
    members: normalizedMembers,
    normalizedZones: zones,
    score,
    ml,
    submissions,
    scoreLedger
  });

  return {
    id,
    name,
    passcode,
    college,
    leaderName,
    leaderMobile,
    leaderEmail,
    studentType,
    members: normalizedMembers,
    score,
    currentStage,
    completedStages,
    completedStagesCount: completedStages.length,
    totalStagesCount: ALL_ZONE_IDS.length,
    purpleStatus,
    zones,
    ml,
    scoreLedger,
    lastActivityAt,
    inconsistencies,
    hasInconsistencies: inconsistencies.length > 0,
    createdAt: team.created_at || team.createdAt || null,
    updatedAt: team.updated_at || team.updatedAt || null
  };
}

/**
 * Builds aggregate metrics across all teams.
 */
function buildAdminMetrics(enrichedTeams, totalMlSubmissions) {
  const totalTeams = enrichedTeams.length;

  const completedTeams = enrichedTeams.filter(
    (t) => t.currentStage === 'completed' || t.score >= TOTAL_COMPETITION_POINTS
  ).length;

  // Active teams: teams that have progressed or scored or submitted ML, but haven't completed
  const activeTeams = enrichedTeams.filter(
    (t) => (t.score > 0 || t.ml.submissionsUsed > 0 || t.completedStagesCount > 0) &&
           t.currentStage !== 'completed' &&
           t.score < TOTAL_COMPETITION_POINTS
  ).length;

  const totalPointsAwarded = enrichedTeams.reduce((sum, t) => sum + (t.score || 0), 0);

  return {
    totalTeams,
    activeTeams,
    completedTeams,
    pointsAwarded: totalPointsAwarded,
    totalPointsPossible: TOTAL_COMPETITION_POINTS,
    totalMlSubmissions: totalMlSubmissions !== undefined ? totalMlSubmissions : enrichedTeams.reduce((sum, t) => sum + t.ml.submissionsUsed, 0),
    serverTime: new Date().toISOString()
  };
}

module.exports = {
  ALL_ZONE_IDS,
  normalizeZoneMap,
  computeCurrentStage,
  computePurpleStatus,
  computeLastActivityAt,
  auditTeamIntegrity,
  buildEnrichedTeamOverview,
  buildAdminMetrics
};
