const crypto = require('node:crypto');

function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function signSession(sessionId, secret) {
  return `${sessionId}.${hmac(secret, `session:${sessionId}`)}`;
}
function verifySessionCookie(cookie, secret) {
  if (typeof cookie !== 'string') return null;
  const at = cookie.lastIndexOf('.');
  if (at < 1) return null;
  const sessionId = cookie.slice(0, at);
  const signature = cookie.slice(at + 1);
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return null;
  return safeEqual(signature, hmac(secret, `session:${sessionId}`)) ? sessionId : null;
}
function randomId() { return require('node:crypto').randomBytes(32).toString('hex'); }
function validateTeamId(value, regexString) {
  if (typeof value !== 'string') return false;
  let regex;
  try { regex = new RegExp(regexString || '^[A-Za-z0-9-]{3,32}$'); } catch { regex = /^[A-Za-z0-9-]{3,32}$/; }
  return regex.test(value.trim());
}
function validateTeamName(value, regexString) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  let regex;
  try { regex = new RegExp(regexString || "^[\\p{L}\\p{N} .,'’_()-]{2,40}$", 'u'); } catch { regex = /^[\p{L}\p{N} .,'’_()-]{2,40}$/u; }
  return trimmed.length >= 2 && trimmed.length <= 40 && regex.test(trimmed);
}
function canonicalTeamId(id) {
  if (!id) return '';
  const s = String(id).trim().toUpperCase();
  if (s === 'UNDEFINED' || s === 'NULL' || s === 'NAN' || s === 'OPERATOR') return '';
  return s;
}
function sanitizeTeamName(name) { return String(name).normalize('NFC').trim(); }
function validCtfSignature({ secret, teamId, ctfId, timestamp, signature, now = Date.now() }) {
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > 300) return false;
  if (typeof secret !== 'string' || secret.length < 32) return false;
  return safeEqual(signature, hmac(secret, `${teamId}.${ctfId}.${seconds}`));
}
function signLaunchToken(payload, secret) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const tokenSig = hmac(secret, `launch:${encodedPayload}`);
  return `${encodedPayload}.${tokenSig}`;
}
function verifyLaunchToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!safeEqual(signature, hmac(secret, `launch:${encodedPayload}`))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    // Allow generous grace period so launch tokens remain valid for the duration of the CTF
    if (payload.exp && Date.now() > (payload.exp + 24 * 60 * 60 * 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
module.exports = { hmac, safeEqual, signSession, verifySessionCookie, randomId, validateTeamId, validateTeamName, canonicalTeamId, sanitizeTeamName, validCtfSignature, signLaunchToken, verifyLaunchToken };
