/**
 * Shared HMAC token + rate-limit + CORS helpers for the GeoAI server
 * functions. Pulled into its own module so register / sign-upload /
 * photos all share one implementation.
 *
 * Token format:
 *   <device_id_hex>.<expiry_unix_seconds>.<hmac_sha256_hex>
 *
 * The HMAC is over `${device_id}.${expiry}` using HMAC_SECRET. Tokens
 * are issued at /register, expire 30 days later, and are renewed on
 * use. They're verified with constant-time comparison.
 */

const crypto = require('crypto');

const HMAC_SECRET = process.env.HMAC_SECRET || '';
const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const ALLOWED_ORIGINS = new Set([
  'https://gisgeoai.netlify.app',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',
  // Mobile app (no Origin header on native HTTP) is handled by Origin-absent path
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Token',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

function clientIp(event) {
  const xff = event.headers['x-forwarded-for'] || event.headers['X-Forwarded-For'];
  if (xff) return xff.split(',')[0].trim();
  return event.headers['x-nf-client-connection-ip'] ||
         event.headers['client-ip'] ||
         '0.0.0.0';
}

// Constant-time HMAC over the given payload string
function hmac(payload) {
  if (!HMAC_SECRET) throw new Error('HMAC_SECRET env var not set');
  return crypto.createHmac('sha256', HMAC_SECRET).update(payload).digest('hex');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Issue a device_token for a given device_id
function issueToken(deviceId) {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(deviceId)) {
    throw new Error('Invalid device_id format');
  }
  const expiry = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload = `${deviceId}.${expiry}`;
  const sig = hmac(payload);
  return `${deviceId}.${expiry}.${sig}`;
}

// Verify a device_token and return { ok, deviceId, expiry } or { ok: false }
function verifyToken(token) {
  if (typeof token !== 'string') return { ok: false, reason: 'not-string' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [deviceId, expiryStr, sig] = parts;
  const expiry = parseInt(expiryStr, 10);
  if (!Number.isFinite(expiry)) return { ok: false, reason: 'bad-expiry' };
  if (expiry < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(deviceId)) return { ok: false, reason: 'bad-device-id' };
  const expected = hmac(`${deviceId}.${expiryStr}`);
  if (!safeEqual(sig, expected)) return { ok: false, reason: 'bad-signature' };
  return { ok: true, deviceId, expiry };
}

// ── Rate limiting via Upstash REST ────────────────────────────────────────
async function redisCmd(commands) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Sliding-window rate limit. `key` is whatever you want to bucket by
 * (device id, ip, endpoint). Returns { allowed, count, retryAfter }.
 * Falls open if Upstash is unreachable.
 */
async function rateLimit(key, max, windowSec) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return { allowed: true, count: 0 };
  const result = await redisCmd([
    ['INCR', `rl:${key}`],
    ['EXPIRE', `rl:${key}`, String(windowSec), 'NX'],
  ]);
  if (!result) return { allowed: true, count: 0 };
  const count = (result[0] && result[0].result) || 0;
  if (count > max) {
    return { allowed: false, count, retryAfter: windowSec };
  }
  return { allowed: true, count };
}

function jsonResponse(statusCode, body, origin, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...corsHeaders(origin), ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function preflight(origin) {
  return { statusCode: 204, headers: corsHeaders(origin), body: '' };
}

module.exports = {
  HMAC_SECRET,
  ALLOWED_ORIGINS,
  corsHeaders,
  clientIp,
  hmac,
  safeEqual,
  issueToken,
  verifyToken,
  rateLimit,
  jsonResponse,
  preflight,
};
