const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ANSWERS_PATH = path.resolve(__dirname, '..', 'server_data', 'private_answers.csv');
const ESCAPE_THRESHOLD = 0.80; // Qualifying R2 threshold for Escape Gate

let groundTruthMap = null;
let groundTruthStats = null;

/**
 * Robust RFC-4180 CSV line parser supporting quoted fields and escaped quotes.
 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (inQuotes) {
    return null; // Malformed line with unmatched quote
  }
  result.push(current.trim());
  return result;
}

function loadGroundTruth() {
  if (groundTruthMap) return { groundTruthMap, groundTruthStats };

  const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
  let content = '';
  if (process.env.PRIVATE_ANSWERS_BASE64) {
    content = Buffer.from(process.env.PRIVATE_ANSWERS_BASE64, 'base64').toString('utf8');
  } else {
    const answersPath = process.env.GROUND_TRUTH_PATH || process.env.PRIVATE_ANSWERS_PATH || DEFAULT_ANSWERS_PATH;
    if (!fs.existsSync(answersPath)) {
      if (isProduction) {
        throw new Error(`SCORING_ARBITER_UNAVAILABLE: Private ground truth answers are missing or unreadable in production environment at ${answersPath}. Configure PRIVATE_ANSWERS_BASE64 or PRIVATE_ANSWERS_PATH.`);
      }
      const fixturePath = path.resolve(__dirname, '..', 'tests', 'fixtures', 'sample_predictions.csv');
      const isTestRunner = process.env.NODE_ENV === 'test'
        || process.execArgv.includes('--test')
        || process.argv.some((a) => a.includes('test'));
      if (isTestRunner && fs.existsSync(fixturePath)) {
        content = fs.readFileSync(fixturePath, 'utf8');
      } else {
        throw new Error(`Private answers file not found at ${answersPath}`);
      }
    } else {
      content = fs.readFileSync(answersPath, 'utf8');
    }
  }

  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const map = new Map();
  let sumY = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    if (parts.length >= 2) {
      const id = parts[0].trim().replace(/^["']|["']$/g, '');
      const val = parseFloat(parts[1].replace(/^["']|["']$/g, ''));
      if (id && !isNaN(val)) {
        map.set(id, val);
        sumY += val;
      }
    }
  }

  const n = map.size;
  if (n !== 120) {
    throw new Error(`Expected exactly 120 ground truth rows, found ${n}`);
  }

  const meanY = sumY / n;
  let ssTot = 0;
  for (const y of map.values()) {
    ssTot += Math.pow(y - meanY, 2);
  }

  groundTruthMap = map;
  groundTruthStats = { n, meanY, ssTot };
  return { groundTruthMap, groundTruthStats };
}

/**
 * Validates and evaluates an uploaded submission CSV string.
 */
function evaluateSubmission(csvContent, options = {}) {
  let loaded;
  try {
    loaded = loadGroundTruth();
  } catch (err) {
    return { valid: false, error: `SCORING_ARBITER_UNAVAILABLE: ${err.message}` };
  }
  const { groundTruthMap, groundTruthStats } = loaded;
  const qualifyingThreshold = options.threshold !== undefined ? options.threshold : ESCAPE_THRESHOLD;

  if (typeof csvContent !== 'string' || !csvContent.trim()) {
    return { valid: false, error: 'Empty or missing submission file.' };
  }

  const cleanContent = csvContent.replace(/^\uFEFF/, '').trim();
  const lines = cleanContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return { valid: false, error: 'File must contain a header and prediction rows.' };
  }

  // 1. Validate Header
  const rawHeader = parseCsvLine(lines[0]);
  if (!rawHeader) {
    return { valid: false, error: 'Malformed CSV header: unmatched quote detected.' };
  }
  const header = rawHeader.map((h) => h.toLowerCase().replace(/^["']|["']$/g, ''));
  const idIndex = header.findIndex((h) => h === 'sanctuary_id');
  const predIndex = header.findIndex((h) => h === 'survival_probability');

  if (idIndex === -1 || predIndex === -1 || header.length !== 2) {
    return {
      valid: false,
      error: 'CSV must contain exactly "Sanctuary_ID" and "Survival_Probability" columns in the header.'
    };
  }

  // 2. Parse and Validate Predictions
  const predictions = new Map();
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (!row) {
      return { valid: false, error: `Row ${i + 1} is malformed: unmatched quote detected.` };
    }
    if (row.length !== 2) {
      return { valid: false, error: `Row ${i + 1} has invalid column count (${row.length}, expected 2).` };
    }

    const id = row[idIndex].replace(/^["']|["']$/g, '').trim();
    const predStr = row[predIndex].replace(/^["']|["']$/g, '').trim();
    if (!predStr || !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(predStr)) {
      return { valid: false, error: `Malformed or non-numeric Survival_Probability "${predStr}" for ID "${id}" at row ${i + 1}.` };
    }
    const predVal = Number(predStr);

    if (!id) {
      return { valid: false, error: `Row ${i + 1} has an empty Sanctuary_ID.` };
    }
    if (predictions.has(id)) {
      return { valid: false, error: `Duplicate Sanctuary_ID detected: "${id}" at row ${i + 1}.` };
    }
    if (!groundTruthMap.has(id)) {
      return { valid: false, error: `Unrecognized Sanctuary_ID: "${id}". Must match the 120 test survivors.` };
    }
    if (isNaN(predVal) || !Number.isFinite(predVal)) {
      return { valid: false, error: `Non-numeric or NaN Survival_Probability for ID "${id}" at row ${i + 1}.` };
    }
    if (predVal < 0.0 || predVal > 1.0) {
      return { valid: false, error: `Survival_Probability for ID "${id}" out of bounds (${predVal}). Must be between 0.0 and 1.0.` };
    }

    predictions.set(id, predVal);
  }

  // 3. Verify exactly 120 rows
  if (predictions.size !== groundTruthMap.size) {
    return {
      valid: false,
      error: `Expected exactly ${groundTruthMap.size} prediction records, but received ${predictions.size}.`
    };
  }

  // 4. Calculate R2 and MSE
  let ssRes = 0;
  let mseSum = 0;

  for (const [id, yTrue] of groundTruthMap.entries()) {
    const yPred = predictions.get(id);
    const diff = yTrue - yPred;
    ssRes += Math.pow(diff, 2);
    mseSum += Math.pow(diff, 2);
  }

  const r2 = 1 - (ssRes / groundTruthStats.ssTot);
  const mse = mseSum / groundTruthStats.n;
  const qualifies = r2 >= qualifyingThreshold;

  return {
    valid: true,
    r2Score: Math.round(r2 * 10000) / 10000,
    mseScore: Math.round(mse * 1000000) / 1000000,
    qualifiesForEscape: qualifies,
    threshold: qualifyingThreshold,
    message: qualifies
      ? `QUALIFIED! Model achieved R² = ${(r2 * 100).toFixed(2)}% (Target: >= ${(qualifyingThreshold * 100).toFixed(0)}%). Transit Gate unlocked!`
      : `Model evaluated: R² = ${(r2 * 100).toFixed(2)}%, MSE = ${mse.toFixed(6)}. Qualification threshold is ${(qualifyingThreshold * 100).toFixed(0)}%.`
  };
}

function _resetGroundTruth() {
  groundTruthMap = null;
  groundTruthStats = null;
}

module.exports = {
  loadGroundTruth,
  evaluateSubmission,
  parseCsvLine,
  ESCAPE_THRESHOLD,
  _resetGroundTruth
};
