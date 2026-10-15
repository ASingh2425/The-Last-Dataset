const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  const base = path.basename(file, '.json');
  if (base === 'zones') return require('../config/zones.json');
  if (base === 'teams') return require('../config/teams.json');
  if (base === 'event') return require('../config/event.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadConfig(baseDir) {
  const zonesConfig = readJson(path.join(baseDir, 'config', 'zones.json'));
  const teamsConfig = readJson(path.join(baseDir, 'config', 'teams.json'));
  const event = readJson(path.join(baseDir, 'config', 'event.json'));
  if (!Array.isArray(zonesConfig.zones) || zonesConfig.zones.length !== 5) {
    throw new Error('config/zones.json must contain exactly five zones.');
  }
  const seenZones = new Set();
  const seenCtfs = new Set();
  zonesConfig.zones.forEach((zone, index) => {
    if (!zone.id || !zone.name || !/^#[0-9a-f]{6}$/i.test(zone.color) || zone.order !== index + 1) {
      throw new Error(`Invalid zone metadata/order at index ${index}.`);
    }
    if (seenZones.has(zone.id)) throw new Error(`Duplicate zone ID: ${zone.id}`);
    seenZones.add(zone.id);
    if (!Array.isArray(zone.ctfs) || zone.ctfs.length < 1) throw new Error(`Zone ${zone.id} must have CTFs.`);
    zone.ctfs.forEach((ctf) => {
      if (!ctf.id || !ctf.title || !ctf.url || seenCtfs.has(ctf.id)) throw new Error(`Invalid or duplicate CTF in ${zone.id}.`);
      if (!ctf.completion?.secretEnv) throw new Error(`CTF ${ctf.id} needs completion.secretEnv.`);
      seenCtfs.add(ctf.id);
    });
  });
  if (!['open', 'whitelist'].includes(teamsConfig.mode)) throw new Error('teams.json mode must be open or whitelist.');
  if (!Array.isArray(teamsConfig.allowedIds)) throw new Error('teams.json allowedIds must be an array.');
  return { zones: zonesConfig.zones, teams: teamsConfig, event };
}

module.exports = { loadConfig, readJson };
