const fs = require('node:fs');
const path = require('node:path');
const { createStore, initialState } = require('../lib/store');
const baseDir = path.resolve(__dirname, '..');
const envFile = path.join(baseDir, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
if (process.env.NODE_ENV === 'production') { console.error('Refusing to reset production data.'); process.exit(2); }
if (!process.argv.includes('--confirm')) { console.error('This wipes ALL local team progress. Re-run with: npm run reset:data -- --confirm'); process.exit(2); }
const store = createStore(process.env.DATA_FILE || path.join(baseDir, 'data', 'progress.json'));
store.write(initialState());
console.log(`Reset local progress store: ${store.filePath}`);
