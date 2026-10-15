// =========================================================================
// CANONICAL SCORING SPECIFICATION — THE LAST DATASET
// TechTatva 2026 | MAHE Manipal
// Total Competition Points: Exactly 3,100 pts
// Sanctuary: 100 | Yellow: 200 | Blue: 400 | Orange: 600 | Red: 800 | Purple: 1000
// =========================================================================

const CANONICAL_STAGE_SCORES = {
  sanctuary: {
    points: 100,
    source: 'sanctuary_complete',
    sourceId: 'sanctuary-gate',
    requiredChallenges: []
  },
  yellow: {
    points: 200,
    source: 'zone_yellow_clear',
    sourceId: 'yellow-zone',
    requiredChallenges: ['yellow-01']
  },
  blue: {
    points: 400,
    source: 'zone_blue_clear',
    sourceId: 'blue-zone',
    requiredChallenges: [
      'blue-zone-ctf-01',
      'blue-zone-ctf-02',
      'blue-zone-ctf-03',
      'blue-zone-ctf-04'
    ]
  },
  orange: {
    points: 600,
    source: 'zone_orange_clear',
    sourceId: 'orange-zone',
    requiredChallenges: []
  },
  red: {
    points: 800,
    source: 'zone_red_clear',
    sourceId: 'red-zone',
    requiredChallenges: []
  },
  purple: {
    points: 1000,
    source: 'zone_purple_clear',
    sourceId: 'purple-escape',
    requiredChallenges: ['purple-01']
  }
};

const TOTAL_COMPETITION_POINTS = Object.values(CANONICAL_STAGE_SCORES)
  .reduce((acc, curr) => acc + curr.points, 0); // 3,100

const ZONE_REQUIRED_CHALLENGES = {
  sanctuary: [],
  yellow: ['yellow-01'],
  blue: [
    'blue-zone-ctf-01',
    'blue-zone-ctf-02',
    'blue-zone-ctf-03',
    'blue-zone-ctf-04'
  ],
  orange: [],
  red: [],
  purple: ['purple-01']
};

const CHALLENGE_SCORES = {
  'yellow-01': 200,
  'blue-zone-ctf-01': 100,
  'blue-zone-ctf-02': 100,
  'blue-zone-ctf-03': 100,
  'blue-zone-ctf-04': 100,
  'orange-01': 0,
  'red-01': 0,
  'purple-01': 0
};

const ZONE_PREREQUISITES = {
  sanctuary: null,
  yellow: 'sanctuary',
  blue: 'yellow',
  orange: 'blue',
  red: 'orange',
  purple: 'red'
};

const ZONE_NEXT_MAP = {
  sanctuary: 'yellow',
  yellow: 'blue',
  blue: 'orange',
  orange: 'red',
  red: 'purple',
  purple: null
};

const ZONE_REWARD_DATASETS = {
  sanctuary: null,
  yellow: 'community_final',
  blue: 'radio_final',
  orange: 'forensics_final',
  red: 'research_final',
  purple: null
};

module.exports = {
  CANONICAL_STAGE_SCORES,
  TOTAL_COMPETITION_POINTS,
  ZONE_REQUIRED_CHALLENGES,
  CHALLENGE_SCORES,
  ZONE_PREREQUISITES,
  ZONE_NEXT_MAP,
  ZONE_REWARD_DATASETS
};
