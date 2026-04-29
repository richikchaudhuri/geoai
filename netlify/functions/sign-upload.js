/**
 * POST /.netlify/functions/sign-upload
 *
 * Issues Cloudinary signed-upload params for an authenticated device.
 * Replaces the old "unsigned upload preset" flow — the API secret never
 * leaves Netlify env vars, and clients can only upload into the folder
 * the server says they're allowed in (`geoai/<device_id>/<timestamp>`).
 *
 * Request:
 *   { "device_token": "...", "file_size": <bytes> }
 *
 * Response (200):
 *   {
 *     upload_url: "https://api.cloudinary.com/v1_1/<cloud>/image/upload",
 *     params: {
 *       api_key: "...", timestamp: 1234567890,
 *       folder: "geoai/<device_id>", public_id: "...",
 *       signature: "<sha1 hex>"
 *     }
 *   }
 *
 * Server-side rate limit: 60 sign requests / hour / device.
 * Bigger picture: a tampered APK using the SAME device_token still
 * hits this 60/h cap; an attacker generating fresh device_ids hits the
 * /register cap. Both require server cooperation.
 */

const crypto = require('crypto');
const {
  preflight,
  jsonResponse,
  verifyToken,
  rateLimit,
  HMAC_SECRET,
} = require('./_lib/auth');

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'dnxpt5gea';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const RATE_MAX = 60;       // 60 uploads / device / hour
const RATE_WINDOW = 3600;

/**
 * Build the Cloudinary upload signature.
 * Cloudinary docs:
 *   1. Sort params alphabetically by key.
 *   2. Concatenate `key=value` pairs joined with `&`.
 *   3. Append the API secret.
 *   4. SHA-1 hex digest.
 */
function cloudinarySignature(params) {
  const keys = Object.keys(params).sort();
  const toSign = keys.map(k => `${k}=${params[k]}`).join('&');
  return crypto
    .createHash('sha1')
    .update(toSign + CLOUDINARY_API_SECRET)
    .digest('hex');
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';

  if (event.httpMethod === 'OPTIONS') return preflight(origin);
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'method not allowed' }, origin);
  }

  if (!HMAC_SECRET) {
    return jsonResponse(503, { error: 'server not configured (HMAC_SECRET)' }, origin);
  }
  if (!CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return jsonResponse(503, {
      error: 'server not configured (Cloudinary API key/secret)',
    }, origin);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'invalid JSON' }, origin);
  }

  // 1. Verify device_token
  const tokenCheck = verifyToken(body.device_token);
  if (!tokenCheck.ok) {
    return jsonResponse(401, {
      error: 'invalid or expired device_token',
      reason: tokenCheck.reason,
    }, origin);
  }
  const deviceId = tokenCheck.deviceId;

  // 2. Validate file_size
  const fileSize = parseInt(body.file_size, 10);
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return jsonResponse(400, { error: 'file_size required (positive integer)' }, origin);
  }
  if (fileSize > MAX_FILE_SIZE) {
    return jsonResponse(413, {
      error: `file too large (max ${MAX_FILE_SIZE} bytes)`,
      received: fileSize,
    }, origin);
  }

  // 3. Per-device rate limit
  const rl = await rateLimit(`upload:${deviceId}`, RATE_MAX, RATE_WINDOW);
  if (!rl.allowed) {
    return jsonResponse(429, {
      error: 'upload rate limit hit for this device',
      retryAfter: rl.retryAfter,
    }, origin, { 'Retry-After': String(rl.retryAfter) });
  }

  // 4. Build signed upload params
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `geoai/${deviceId}`;
  const publicId = `${timestamp}_${crypto.randomBytes(6).toString('hex')}`;
  const tags = `geoai-mobile,device:${deviceId}`;

  const paramsToSign = {
    folder,
    public_id: publicId,
    tags,
    timestamp,
  };
  const signature = cloudinarySignature(paramsToSign);

  return jsonResponse(200, {
    upload_url: `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    params: {
      api_key: CLOUDINARY_API_KEY,
      timestamp,
      folder,
      public_id: publicId,
      tags,
      signature,
    },
    expires_in: 3600,
    rate_limit_remaining: Math.max(0, RATE_MAX - rl.count),
  }, origin);
};
