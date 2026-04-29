/**
 * POST /.netlify/functions/register
 *
 * Issues a 30-day device_token tied to a client-generated device_id.
 * Mobile app calls this on first launch (or whenever it has no token).
 * Server-side rate-limited per IP so an attacker can't farm millions
 * of fresh device_ids in a hammer loop.
 *
 * Request:
 *   { "device_id": "<8-64 char alnum + hyphens>" }
 *
 * Response (200):
 *   { "device_token": "<...>", "expires_at": <unix_seconds>, "device_id": "..." }
 *
 * Response (429): { "error": "too many registrations from this IP" }
 */

const {
  preflight,
  jsonResponse,
  clientIp,
  rateLimit,
  issueToken,
  HMAC_SECRET,
} = require('./_lib/auth');

const REG_RATE_MAX = 20;        // 20 fresh devices per IP per hour
const REG_RATE_WINDOW = 3600;

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';

  if (event.httpMethod === 'OPTIONS') return preflight(origin);
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'method not allowed' }, origin);
  }

  if (!HMAC_SECRET) {
    return jsonResponse(503, { error: 'server not configured (HMAC_SECRET missing)' }, origin);
  }

  // Per-IP rate limit on registration
  const ip = clientIp(event);
  const rl = await rateLimit(`reg:${ip}`, REG_RATE_MAX, REG_RATE_WINDOW);
  if (!rl.allowed) {
    return jsonResponse(429, {
      error: 'too many registrations from this IP',
      retryAfter: rl.retryAfter,
    }, origin, { 'Retry-After': String(rl.retryAfter) });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'invalid JSON' }, origin);
  }

  const deviceId = (body.device_id || '').trim();
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(deviceId)) {
    return jsonResponse(400, {
      error: 'device_id must be 8-64 alphanumeric/hyphen characters',
    }, origin);
  }

  let token;
  try {
    token = issueToken(deviceId);
  } catch (e) {
    return jsonResponse(500, { error: 'token issue failed', detail: e.message }, origin);
  }

  // Decode the expiry from the token for the response
  const expiry = parseInt(token.split('.')[1], 10);

  return jsonResponse(200, {
    device_token: token,
    expires_at: expiry,
    device_id: deviceId,
  }, origin);
};
