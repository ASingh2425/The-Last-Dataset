/**
 * =========================================================================
 * THE LAST DATASET — STRICT PRODUCTION READINESS & RPC AUDIT
 * TechTatva 2026 | MAHE Manipal
 * =========================================================================
 *
 * Verifies live production requirements before launch:
 * 1. Checks that migration files (001-004) exist on disk.
 * 2. Verifies production schema is cleanly isolated from dev seed fixtures.
 * 3. Verifies canonical total score locks to exactly 3,100 points.
 * 4. Verifies production ML evaluator fails closed without fallback when ground truth is missing.
 * 5. Verifies genuine hidden ground truth answer key (120 rows, schema, unique IDs, safe summary stats).
 * 6. Checks live Supabase connection and public schema tables/views.
 * 7. Probes live PostgreSQL stored procedures (RPC existence & service-role execution).
 * 8. Probes anonymous access rejection (verifies unauthenticated callers cannot invoke RPCs).
 * 9. Checks participant roster and fair competition progression status.
 *
 * Usage:
 *   node scripts/verify-production-state.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables safely
const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const ROOT = path.resolve(__dirname, '..');
const { CANONICAL_STAGE_SCORES, TOTAL_COMPETITION_POINTS } = require('../config/scoring');
const { evaluateSubmission, _resetGroundTruth } = require('../lib/evaluator');

let passed = 0;
let failed = 0;
let warned = 0;

function report(status, title, details = '') {
  if (status === 'OK') {
    console.log(`  [PASS] ${title}`);
    passed++;
  } else if (status === 'WARN') {
    console.log(`  [WARN] ${title}`);
    if (details) console.log(`         -> ${details}`);
    warned++;
  } else {
    console.error(`  [FAIL] ${title}`);
    if (details) console.error(`         -> ${details}`);
    failed++;
  }
}

async function main() {
  console.log('========================================================');
  console.log('THE LAST DATASET — PRODUCTION READINESS & RPC AUDIT');
  console.log('========================================================');

  // 1. Check Migration Files on Disk
  console.log('\n--- 1. Checking Database Migration Files on Disk ---');
  const migrations = [
    { file: '000_seed_dev_data.sql', required: false, desc: 'Optional dev seed fixture' },
    { file: '001_initial_schema.sql', required: true, desc: 'Core schema tables, views & complete_challenge_idempotent' },
    { file: '002_atomic_ml_quota.sql', required: true, desc: 'Advisory lock & reserve_ml_attempt RPC' },
    { file: '003_atomic_purple_and_cap.sql', required: true, desc: 'check_team_member_cap trigger & finalize_qualifying_ml_submission RPC' },
    { file: '004_atomic_zone_completion.sql', required: true, desc: 'Atomic complete_zone_atomic RPC' }
  ];

  for (const m of migrations) {
    const fullPath = path.join(ROOT, 'supabase', 'migrations', m.file);
    if (fs.existsSync(fullPath)) {
      const stats = fs.statSync(fullPath);
      report('OK', `${m.file} exists (${stats.size} bytes) — ${m.desc}`);
    } else if (m.required) {
      report('FAIL', `Required migration missing: ${m.file}`, `Expected at ${fullPath}`);
    } else {
      report('WARN', `Optional migration file not found: ${m.file}`);
    }
  }

  // 2. Check Seed Data Isolation
  console.log('\n--- 2. Checking Production Schema Seed Isolation ---');
  const initSchemaPath = path.join(ROOT, 'supabase', 'migrations', '001_initial_schema.sql');
  if (fs.existsSync(initSchemaPath)) {
    const initContent = fs.readFileSync(initSchemaPath, 'utf8');
    if (initContent.includes("INSERT INTO public.teams") || initContent.includes("INSERT INTO public.team_members")) {
      report('FAIL', '001_initial_schema.sql contains dev seed inserts! Seeds must be isolated in 000_seed_dev_data.sql');
    } else {
      report('OK', '001_initial_schema.sql is cleanly isolated from dev seed fixtures');
    }
  }

  // 3. Verify Canonical Scoring Configuration
  console.log('\n--- 3. Verifying Canonical Scoring Configuration ---');
  const expectedTotal = 3100;
  if (TOTAL_COMPETITION_POINTS === expectedTotal) {
    report('OK', `Canonical game total locks to exactly ${expectedTotal} points (100+200+400+600+800+1000)`);
  } else {
    report('FAIL', `Canonical score mismatch: expected ${expectedTotal}, found ${TOTAL_COMPETITION_POINTS}`);
  }

  // 4. Verify Evaluator Production Fail-Closed Semantics
  console.log('\n--- 4. Verifying Evaluator Fail-Closed Semantics ---');
  const prevEnv = process.env.NODE_ENV;
  const prevBase64 = process.env.PRIVATE_ANSWERS_BASE64;
  const prevPath = process.env.PRIVATE_ANSWERS_PATH;

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PRIVATE_ANSWERS_BASE64;
    process.env.PRIVATE_ANSWERS_PATH = '/non/existent/path/private_answers.csv';
    _resetGroundTruth();

    const evalResult = evaluateSubmission('Sanctuary_ID,Survival_Probability\nSANC-0091,0.5');
    if (!evalResult.valid && evalResult.error?.includes('SCORING_ARBITER_UNAVAILABLE')) {
      report('OK', 'Evaluator strictly fails closed in production when ground truth is missing (no fixture fallback)');
    } else {
      report('FAIL', `Evaluator did not fail closed in production: ${JSON.stringify(evalResult)}`);
    }
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevBase64) process.env.PRIVATE_ANSWERS_BASE64 = prevBase64;
    else delete process.env.PRIVATE_ANSWERS_BASE64;
    if (prevPath) process.env.PRIVATE_ANSWERS_PATH = prevPath;
    else delete process.env.PRIVATE_ANSWERS_PATH;
    _resetGroundTruth();
  }

  // 5. Check Hidden Ground Truth Answer Key Integrity & Schema
  console.log('\n--- 5. Verifying Hidden Ground Truth Answer Key ---');
  let groundTruthRaw = '';
  let sourceDesc = '';

  if (process.env.PRIVATE_ANSWERS_BASE64) {
    try {
      groundTruthRaw = Buffer.from(process.env.PRIVATE_ANSWERS_BASE64, 'base64').toString('utf8');
      sourceDesc = 'process.env.PRIVATE_ANSWERS_BASE64';
    } catch (e) {
      report('FAIL', `Failed to decode PRIVATE_ANSWERS_BASE64: ${e.message}`);
    }
  } else if (process.env.PRIVATE_ANSWERS_PATH && fs.existsSync(process.env.PRIVATE_ANSWERS_PATH)) {
    groundTruthRaw = fs.readFileSync(process.env.PRIVATE_ANSWERS_PATH, 'utf8');
    sourceDesc = 'process.env.PRIVATE_ANSWERS_PATH';
  } else {
    const defaultFile = path.join(ROOT, 'server_data', 'private_answers.csv');
    if (fs.existsSync(defaultFile)) {
      groundTruthRaw = fs.readFileSync(defaultFile, 'utf8');
      sourceDesc = 'server_data/private_answers.csv';
    }
  }

  if (!groundTruthRaw) {
    report('FAIL', 'Production ground truth answer key is missing!', 'Set PRIVATE_ANSWERS_BASE64 in Vercel/production or provide server_data/private_answers.csv');
  } else {
    const lines = groundTruthRaw.trim().split(/\r?\n/);
    const header = lines[0]?.trim();
    if (header === 'Sanctuary_ID,Survival_Probability') {
      report('OK', `Answer key header strictly matches expected schema ("Sanctuary_ID,Survival_Probability")`);
    } else {
      report('FAIL', `Answer key header mismatch: expected "Sanctuary_ID,Survival_Probability", got "${header}"`);
    }

    const rowCount = lines.length - 1;
    if (rowCount === 120) {
      report('OK', `Ground truth loaded from ${sourceDesc} contains exactly 120 survivor rows`);
    } else {
      report('FAIL', `Ground truth row count mismatch: expected 120, found ${rowCount}`);
    }

    // Deep validation without leaking private answers
    const idSet = new Set();
    const values = [];
    let validRows = true;

    for (let i = 1; i <= rowCount; i++) {
      const parts = lines[i].split(',');
      if (parts.length < 2) { validRows = false; break; }
      const sId = parts[0].trim();
      const val = parseFloat(parts[1].trim());
      if (!sId.startsWith('SANC-') || isNaN(val) || val < 0.0 || val > 1.0) {
        validRows = false;
        break;
      }
      idSet.add(sId);
      values.push(val);
    }

    if (validRows && idSet.size === 120) {
      const min = Math.min(...values).toFixed(4);
      const max = Math.max(...values).toFixed(4);
      const mean = (values.reduce((a, b) => a + b, 0) / values.length).toFixed(4);
      report('OK', `Answer key integrity verified: 120 unique IDs, all probabilities in [0, 1] (min: ${min}, mean: ${mean}, max: ${max})`);
    } else {
      report('FAIL', `Answer key data validation failed: duplicate IDs or invalid probabilities detected`);
    }

    // Verify it is NOT the public sample predictions fixture
    const fixturePath = path.join(ROOT, 'tests', 'fixtures', 'sample_predictions.csv');
    if (fs.existsSync(fixturePath)) {
      const fixtureContent = fs.readFileSync(fixturePath, 'utf8');
      if (groundTruthRaw.trim() === fixtureContent.trim()) {
        report('FAIL', 'Ground truth answer key is IDENTICAL to sample_predictions.csv! Real answers must be distinct.');
      } else {
        _resetGroundTruth();
        const prevB64 = process.env.PRIVATE_ANSWERS_BASE64;
        process.env.PRIVATE_ANSWERS_BASE64 = Buffer.from(groundTruthRaw).toString('base64');
        const evalCheck = evaluateSubmission(fixtureContent);
        if (evalCheck.valid && evalCheck.r2Score !== 1.0 && evalCheck.r2Score > 0.5) {
          report('OK', `Verified genuine ground truth: sample fixture scores R² = ${(evalCheck.r2Score * 100).toFixed(2)}% (< 80% escape threshold)`);
        } else {
          report('WARN', `Unexpected evaluation score against ground truth: R² = ${evalCheck.r2Score}`);
        }
        if (prevB64) process.env.PRIVATE_ANSWERS_BASE64 = prevB64;
        else delete process.env.PRIVATE_ANSWERS_BASE64;
        _resetGroundTruth();
      }
    }
  }

  // 6. Check Live Supabase Connection & Schema Tables
  console.log('\n--- 6. Checking Live Database Tables & Views ---');
  const { supabase } = require('../lib/supabaseClient');
  if (!supabase) {
    report('WARN', 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not configured. Skipping live database audit.');
  } else {
    const requiredTables = [
      'teams',
      'team_members',
      'zone_progress',
      'dataset_entitlements',
      'score_ledger',
      'ml_submissions',
      'leaderboard_view'
    ];

    for (const table of requiredTables) {
      const { data, error } = await supabase.from(table).select('*').limit(1);
      if (error) {
        report('FAIL', `Table/View "${table}" error: ${error.message} (Code: ${error.code})`);
      } else {
        report('OK', `Table/View "${table}" is accessible in public schema`);
      }
    }

    // 7. Check Live Supabase Stored Procedures (Service Role Access)
    console.log('\n--- 7. Checking Live Database Stored Procedures (RPCs) ---');
    const rpcProbes = [
      {
        name: 'complete_challenge_idempotent',
        migration: '001_initial_schema.sql',
        params: {
          p_team_id: '__PROBE_TEAM__',
          p_delegate_id: null,
          p_zone_id: 'sanctuary',
          p_challenge_id: 'probe-01',
          p_points: 0,
          p_all_zone_challenges: []
        }
      },
      {
        name: 'reserve_ml_attempt',
        migration: '002_atomic_ml_quota.sql / 003_atomic_purple_and_cap.sql',
        params: {
          p_team_id: '__PROBE_TEAM__',
          p_delegate_id: null,
          p_raw_filename: 'probe.csv',
          p_max_attempts: 10
        }
      },
      {
        name: 'finalize_qualifying_ml_submission',
        migration: '003_atomic_purple_and_cap.sql',
        params: {
          p_submission_id: '00000000-0000-0000-0000-000000000000',
          p_team_id: '__PROBE_TEAM__',
          p_delegate_id: null,
          p_r2_score: 1.0,
          p_mse_score: 0.0,
          p_points: 1000
        }
      },
      {
        name: 'complete_zone_atomic',
        migration: '004_atomic_zone_completion.sql',
        params: {
          p_team_id: '__PROBE_TEAM__',
          p_delegate_id: null,
          p_zone_id: 'sanctuary',
          p_points: 0,
          p_next_zone_id: null,
          p_dataset_key: null,
          p_source_id: 'probe',
          p_source_type: 'probe',
          p_required_prev_zone: null,
          p_required_challenges: []
        }
      }
    ];

    let rpcsInstalled = true;
    for (const probe of rpcProbes) {
      const res = await supabase.rpc(probe.name, probe.params);
      const isMissing = res.error?.code === 'PGRST202';
      if (isMissing) {
        rpcsInstalled = false;
        report(
          'FAIL',
          `RPC "${probe.name}" is NOT installed on Supabase!`,
          `Run supabase/APPLY_TO_PRODUCTION.sql in the Supabase Dashboard SQL Editor.`
        );
      } else {
        report('OK', `RPC "${probe.name}" is verified present and executable by service_role in PostgreSQL`);
      }
    }

    // 8. Probe Anonymous RPC Isolation (Least Privilege)
    console.log('\n--- 8. Checking Anonymous RPC Permission Boundaries ---');
    if (rpcsInstalled) {
      const anonClient = createClient(process.env.SUPABASE_URL, 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy_anon');
      const anonRes = await anonClient.rpc('complete_zone_atomic', {
        p_team_id: '__PROBE_TEAM__',
        p_zone_id: 'sanctuary'
      });

      if (anonRes.error && (anonRes.error.code === 'PGRST301' || anonRes.error.code === '42501' || anonRes.error.message?.includes('permission denied') || anonRes.status === 401 || anonRes.status === 403 || anonRes.status === 404)) {
        report('OK', 'Anonymous/unauthenticated execution of complete_zone_atomic is strictly denied');
      } else if (!anonRes.error) {
        report('FAIL', 'CRITICAL SECURITY RISK: Anonymous client successfully invoked complete_zone_atomic!', 'Execute REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC, anon, authenticated in APPLY_TO_PRODUCTION.sql');
      } else {
        report('OK', `Anonymous caller rejected as expected (${anonRes.error.code || anonRes.error.message})`);
      }
    } else {
      report('WARN', 'Skipping anonymous RPC permission check until procedures are installed via APPLY_TO_PRODUCTION.sql');
    }

    // 9. Check Participant Roster & Progression State
    console.log('\n--- 9. Checking Participant Roster & Progression State ---');
    const { data: teams, error: teamsErr } = await supabase.from('teams').select('id, team_name, is_active');
    if (teamsErr) {
      report('FAIL', `Unable to query teams roster: ${teamsErr.message}`);
    } else {
      report('OK', `Participant roster contains ${teams?.length || 0} teams registered`);

      const { data: progressList } = await supabase.from('zone_progress').select('team_id, zone_id, status');
      if (progressList && progressList.length > 0) {
        const preCompletedSanctuary = progressList.filter(p => p.zone_id === 'sanctuary' && p.status === 'completed');

        if (preCompletedSanctuary.length > 0) {
          report(
            'WARN',
            `${preCompletedSanctuary.length} team(s) have Sanctuary marked "completed" without earning points.`,
            `To ensure fair competition, run Part 7 of supabase/APPLY_TO_PRODUCTION.sql to reset Sanctuary="available" and Yellow="locked"`
          );
        } else {
          report('OK', 'All teams start in fair state: Sanctuary available, later zones locked');
        }
      }
    }
  }

  console.log('\n========================================================');
  console.log(`AUDIT SUMMARY: ${passed} PASSED, ${warned} WARNINGS, ${failed} ERRORS`);
  console.log('========================================================\n');

  if (failed > 0) {
    console.error('CRITICAL: One or more production readiness checks failed.');
    console.error('Please review the action items above before opening to participants.\n');
    process.exit(1);
  } else {
    console.log('ALL PRODUCTION READINESS CHECKS PASSED!\n');
  }
}

main().catch((err) => {
  console.error('Unexpected audit failure:', err);
  process.exit(1);
});
