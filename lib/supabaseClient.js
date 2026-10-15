const { createClient } = require('@supabase/supabase-js');
const fs = require('node:fs');
const path = require('node:path');

// Ensure local environment variables are loaded
const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

if (!supabaseUrl || !supabaseKey) {
  if (isProduction) {
    console.warn('[supabaseClient] Warning: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in production environment.');
  }
}

const supabase = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      db: { schema: 'public' }
    })
  : null;

module.exports = { supabase };
