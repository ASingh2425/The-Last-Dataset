const fs = require('node:fs');
const path = require('node:path');

console.error('CHALLENGE COMPLETED. FURTHER PLAYING IS PROHIBITED.');
process.exit(1);
const { loadConfig } = require('../lib/config');
const { createStore } = require('../lib/store');
const { canonicalTeamId } = require('../lib/security');

const baseDir = path.resolve(__dirname, '..');
function loadEnv() {
  const file = path.join(baseDir, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
function event(team, message) {
  team.events ||= []; team.events.unshift({ message, at: new Date().toISOString() }); team.events = team.events.slice(0, 40);
}
loadEnv();
if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(2); }
if (process.env.ENABLE_DEV_TOOLS !== 'true') { console.error('Dev tools are disabled. Set ENABLE_DEV_TOOLS=true in your local environment.'); process.exit(2); }
const [rawTeamId, ctfId] = process.argv.slice(2);
if (!rawTeamId || !ctfId) { console.error('Usage: npm run dev:solve -- <teamId> <ctfId>'); process.exit(2); }
const config = loadConfig(baseDir);
const teamId = canonicalTeamId(rawTeamId);
const found = config.zones.map((zone) => ({ zone, ctf: zone.ctfs.find((ctf) => ctf.id === ctfId) })).find((item) => item.ctf);
if (!found) { console.error(`Unknown CTF ID: ${ctfId}`); process.exit(2); }
const store = createStore(process.env.DATA_FILE || path.join(baseDir, 'data', 'progress.json'));
const state = store.read(); const team = state.teams[teamId];
if (!team) { console.error(`Team ${teamId} is not registered yet.`); process.exit(2); }
const index = config.zones.findIndex((zone) => zone.id === found.zone.id);
if (index > 0 && !config.zones[index - 1].ctfs.every((ctf) => team.solvedCtfs.includes(ctf.id))) {
  console.error(`Zone ${found.zone.name} is still quarantined; clear ${config.zones[index - 1].name} first.`); process.exit(3);
}
if (team.solvedCtfs.includes(ctfId)) { console.log(`${ctfId} is already solved for ${teamId}; no change made.`); process.exit(0); }
team.solvedCtfs.push(ctfId); event(team, `DEV SIMULATION · DATA RECOVERED: ${found.ctf.title}`); store.write(state);
console.log(`SOLVED ${ctfId} for ${teamId}.`);
const zoneComplete = found.zone.ctfs.every((ctf) => team.solvedCtfs.includes(ctf.id));
console.log(zoneComplete ? `${found.zone.name} CLEARED.` : `${found.zone.ctfs.filter((ctf) => team.solvedCtfs.includes(ctf.id)).length}/${found.zone.ctfs.length} challenges recovered in ${found.zone.name}.`);
if (zoneComplete && index < config.zones.length - 1) console.log(`UNLOCKED: ${config.zones[index + 1].name}.`);
if (team.solvedCtfs.length === config.zones.reduce((sum, zone) => sum + zone.ctfs.length, 0)) console.log('SURVIVOR COMPLETE.');
