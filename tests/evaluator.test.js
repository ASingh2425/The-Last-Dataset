process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { evaluateSubmission, parseCsvLine } = require('../lib/evaluator');

const ROOT = path.resolve(__dirname, '..');
const samplePath = path.join(ROOT, 'server_data', 'sample_submission.csv');

function getBaseCsv() {
  return fs.readFileSync(samplePath, 'utf8').trim();
}

function makeModifiedCsv(transformVal) {
  const lines = getBaseCsv().split(/\r?\n/);
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    out.push(`${parts[0].trim()},${transformVal(parts[0].trim(), i)}`);
  }
  return out.join('\n');
}

test('Evaluator: parseCsvLine handles quotes, commas and spaces', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvLine('"a,b",c'), ['a,b', 'c']);
  assert.deepEqual(parseCsvLine('"a""b",c'), ['a"b', 'c']);
  assert.deepEqual(parseCsvLine('  "SANC-0091"  ,  "0.8500"  '), ['SANC-0091', '0.8500']);
});

test('Evaluator: rejects malformed partial float like "0.7junk"', () => {
  const badCsv = makeModifiedCsv((id, idx) => idx === 1 ? '0.7junk' : '0.5000');
  const res = evaluateSubmission(badCsv);
  assert.equal(res.valid, false);
  assert.match(res.error, /Malformed or non-numeric Survival_Probability/);
});

test('Evaluator: rejects negative predictions and values > 1.0', () => {
  const negativeCsv = makeModifiedCsv((id, idx) => idx === 1 ? '-0.05' : '0.5000');
  const resNeg = evaluateSubmission(negativeCsv);
  assert.equal(resNeg.valid, false);
  assert.match(resNeg.error, /out of bounds/);

  const overflowCsv = makeModifiedCsv((id, idx) => idx === 1 ? '1.05' : '0.5000');
  const resOver = evaluateSubmission(overflowCsv);
  assert.equal(resOver.valid, false);
  assert.match(resOver.error, /out of bounds/);
});

test('Evaluator: rejects row with invalid column count', () => {
  const lines = getBaseCsv().split(/\r?\n/);
  lines[1] = lines[1] + ',extra_column';
  const res = evaluateSubmission(lines.join('\n'));
  assert.equal(res.valid, false);
  assert.match(res.error, /invalid column count/);
});

test('Evaluator: rejects duplicate Sanctuary_ID', () => {
  const lines = getBaseCsv().split(/\r?\n/);
  lines[2] = lines[1]; // Duplicate first ID on row 2
  const res = evaluateSubmission(lines.join('\n'));
  assert.equal(res.valid, false);
  assert.match(res.error, /Duplicate Sanctuary_ID detected/);
});

test('Evaluator: rejects unrecognized Sanctuary_ID', () => {
  const lines = getBaseCsv().split(/\r?\n/);
  lines[1] = 'SANC-9999,0.5000';
  const res = evaluateSubmission(lines.join('\n'));
  assert.equal(res.valid, false);
  assert.match(res.error, /Unrecognized Sanctuary_ID/);
});

test('Evaluator: rejects missing rows (< 120 rows)', () => {
  const lines = getBaseCsv().split(/\r?\n/).slice(0, 50);
  const res = evaluateSubmission(lines.join('\n'));
  assert.equal(res.valid, false);
  assert.match(res.error, /Expected exactly 120 prediction records/);
});

test('Evaluator: evaluates valid submission and enforces R2 threshold boundary', () => {
  const answersPath = path.join(ROOT, 'server_data', 'private_answers.csv');
  if (!fs.existsSync(answersPath)) return;
  const perfectCsv = fs.readFileSync(answersPath, 'utf8');
  const res = evaluateSubmission(perfectCsv);
  assert.equal(res.valid, true);
  assert.equal(res.r2Score, 1.0);
  assert.equal(res.qualifiesForEscape, true);
});

test('Evaluator: accepts valid submission with UTF-8 BOM prefix and CRLF line endings', () => {
  const answersPath = path.join(ROOT, 'server_data', 'private_answers.csv');
  if (!fs.existsSync(answersPath)) return;
  const perfectCsv = '\uFEFF' + fs.readFileSync(answersPath, 'utf8').replace(/\n/g, '\r\n');
  const res = evaluateSubmission(perfectCsv);
  assert.equal(res.valid, true);
  assert.equal(res.r2Score, 1.0);
});

test('Evaluator: rejects header with extra columns', () => {
  const lines = getBaseCsv().split(/\r?\n/);
  lines[0] = 'Sanctuary_ID,Survival_Probability,Extra_Column';
  const res = evaluateSubmission(lines.join('\n'));
  assert.equal(res.valid, false);
  assert.match(res.error, /CSV must contain exactly "Sanctuary_ID" and "Survival_Probability" columns/);
});

test('Evaluator: parses scientific exponent notation correctly', () => {
  const expCsv = makeModifiedCsv((id, idx) => idx === 1 ? '8.5e-1' : '0.5000');
  const res = evaluateSubmission(expCsv);
  assert.equal(res.valid, true);
});

test('Evaluator: handles null, undefined, and non-string inputs without throwing', () => {
  for (const badInput of [null, undefined, 123, {}, [], true, false]) {
    const res = evaluateSubmission(badInput);
    assert.equal(res.valid, false);
    assert.equal(res.error, 'Empty or missing submission file.');
  }
});

test('Evaluator: rejects malformed CSV with unmatched quotes', () => {
  const lines = getBaseCsv().split(/\r?\n/);
  lines[1] = '"SANC-0091,0.5000'; // Unmatched opening quote
  const res = evaluateSubmission(lines.join('\n'));
  assert.equal(res.valid, false);
  assert.match(res.error, /unmatched quote/);

  lines[0] = '"Sanctuary_ID,Survival_Probability'; // Unmatched in header
  lines[1] = 'SANC-0091,0.5000';
  const resHeader = evaluateSubmission(lines.join('\n'));
  assert.equal(resHeader.valid, false);
  assert.match(resHeader.error, /unmatched quote/);
});

