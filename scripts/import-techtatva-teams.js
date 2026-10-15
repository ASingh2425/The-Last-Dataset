/**
 * =========================================================================
 * TECHTATVA PARTICIPANT IMPORTER SCRIPT
 * The Last Dataset | MAHE Manipal
 * =========================================================================
 *
 * Usage:
 *   node scripts/import-techtatva-teams.js [--file ./data/teams_roster.json] [--remote https://last-dataset.vercel.app] [--dry-run]
 *
 * Features:
 *   - Supports JSON roster (data/teams_roster.json) or CSV exports
 *   - Ingests into live Supabase directly or via --remote Admin API
 *   - Syncs zone progress (Sanctuary AVAILABLE, Yellow LOCKED)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { supabase } = require('../lib/supabaseClient');

function hashPassword(passcode) {
  return crypto.createHash('sha256').update(String(passcode).trim(), 'utf8').digest('hex');
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const headers = lines[0].split(',').map((h) => h.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = [];
    let insideQuotes = false;
    let currentVal = '';

    for (let c = 0; c < lines[i].length; c++) {
      const char = lines[i][c];
      if (char === '"' || char === "'") {
        insideQuotes = !insideQuotes;
      } else if (char === ',' && !insideQuotes) {
        values.push(currentVal.trim().replace(/^["']|["']$/g, ''));
        currentVal = '';
      } else {
        currentVal += char;
      }
    }
    values.push(currentVal.trim().replace(/^["']|["']$/g, ''));

    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = values[idx] || '';
    });
    rows.push(obj);
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const fileArgIndex = args.indexOf('--file');
  const remoteArgIndex = args.indexOf('--remote');
  const remoteUrl = remoteArgIndex !== -1 ? args[remoteArgIndex + 1] : null;

  let filePath = fileArgIndex !== -1 ? args[fileArgIndex + 1] : null;
  if (!filePath) {
    const defaultJson = path.resolve(__dirname, '..', 'data', 'teams_roster.json');
    if (fs.existsSync(defaultJson)) {
      filePath = defaultJson;
    }
  }

  if (!filePath || !fs.existsSync(filePath)) {
    console.error('Error: Please provide a valid file via --file <path>');
    process.exit(1);
  }

  console.log(`Reading roster file: ${filePath}`);
  let rosterTeams = [];

  if (filePath.endsWith('.json')) {
    rosterTeams = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } else {
    const rawRows = parseCSV(fs.readFileSync(filePath, 'utf8'));
    console.log(`Parsed ${rawRows.length} rows from CSV.`);
    
    // Group into teams
    const teamsMap = new Map();
    for (const row of rawRows) {
      const teamId = String(row['team id'] || row['team_id'] || '').trim().toUpperCase();
      const delegateId = String(row['delegate id'] || row['delegate_id'] || '').trim();
      if (!teamId || !delegateId) continue;

      if (!teamsMap.has(teamId)) {
        teamsMap.set(teamId, {
          id: teamId,
          team_name: String(row['team name'] || row['team_name'] || `Team ${teamId.replace(/^TECHTEAM/, '')}`).trim(),
          team_leader_name: String(row['member name'] || row['team leader'] || '').trim(),
          leader_mobile: String(row['mobile no.'] || row['mobile'] || '0000000000').trim(),
          passcode: String(row['access passcode'] || row['password'] || '').trim(),
          student_type: String(row['student type'] || 'MAHE').trim().toUpperCase(),
          members: []
        });
      }

      const teamEntry = teamsMap.get(teamId);
      const isLeader = String(row['role'] || '').includes('Leader') || String(row['is leader'] || '').toUpperCase() === 'YES';
      if (isLeader) {
        teamEntry.team_leader_name = String(row['member name'] || row['name'] || '').trim();
        teamEntry.leader_mobile = String(row['mobile no.'] || row['mobile'] || '').trim();
      }

      teamEntry.members.push({
        delegate_id: delegateId,
        name: String(row['member name'] || row['name'] || '').trim(),
        is_leader: isLeader
      });
    }

    for (const t of teamsMap.values()) {
      t.passcode_hash = hashPassword(t.passcode);
      rosterTeams.push(t);
    }
  }

  console.log(`Loaded ${rosterTeams.length} teams in roster.`);

  if (isDryRun) {
    console.log('\n[DRY RUN COMPLETE] Roster verified. No changes written.');
    return;
  }

  // Remote import via Admin API endpoint
  if (remoteUrl) {
    const targetUrl = remoteUrl.replace(/\/+$/, '') + '/api/admin/import-roster';
    const adminKey = process.env.ADMIN_KEY || process.env.ADMIN_SECRET || 'tld-admin-master-key-2026';
    console.log(`\nImporting to remote server: ${targetUrl}...`);

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': adminKey
      },
      body: JSON.stringify({ teams: rosterTeams })
    });

    const result = await res.json();
    console.log('Remote response:', res.status, result);
    return;
  }

  // Direct Supabase import if local client available
  if (!supabase) {
    console.warn('\nNotice: Local Supabase client not connected. You can:');
    console.log('  1. Run against remote: node scripts/import-techtatva-teams.js --remote https://last-dataset.vercel.app');
    console.log('  2. Apply SQL migration in Supabase SQL editor: supabase/APPLY_FINAL_ROSTER.sql');
    return;
  }

  console.log('\nWriting teams to Supabase PostgreSQL database...');
  let importedTeams = 0;
  let importedMembers = 0;

  for (const team of rosterTeams) {
    const passHash = team.passcode_hash || hashPassword(team.passcode);

    const { error: teamErr } = await supabase.from('teams').upsert({
      id: team.id,
      team_name: team.team_name,
      team_leader_name: team.team_leader_name,
      leader_mobile: team.leader_mobile,
      passcode_hash: passHash,
      student_type: team.student_type,
      is_active: true
    }, { onConflict: 'id' });

    if (teamErr) {
      console.error(`Failed to insert team ${team.id}:`, teamErr.message);
      continue;
    }
    importedTeams++;

    for (const member of (team.members || [])) {
      const { error: memErr } = await supabase.from('team_members').upsert({
        delegate_id: String(member.delegate_id).trim(),
        team_id: team.id,
        member_name: member.name,
        is_leader: !!member.is_leader
      }, { onConflict: 'delegate_id' });

      if (!memErr) importedMembers++;
    }

    await supabase.from('zone_progress').upsert([
      { team_id: team.id, zone_id: 'sanctuary', status: 'available', unlocked_at: new Date().toISOString() },
      { team_id: team.id, zone_id: 'yellow', status: 'locked', unlocked_at: null }
    ], { onConflict: 'team_id,zone_id' });
  }

  console.log(`\nSUCCESSFULLY IMPORTED: ${importedTeams} teams and ${importedMembers} members into database!`);
}

main().catch(console.error);
