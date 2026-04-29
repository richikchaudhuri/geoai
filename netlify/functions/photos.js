/**
 * POST /.netlify/functions/photos
 *
 * Confirms a successful Cloudinary upload and writes the photos row to
 * Supabase using the SERVICE-ROLE key. The mobile app loses its ability
 * to write to Supabase directly with the anon key (after the user runs
 * the matching RLS migration in SECURITY.md).
 *
 * Request:
 *   {
 *     device_token: "...",
 *     image_url:    "https://res.cloudinary.com/dnxpt5gea/image/upload/v.../geoai/<device_id>/<public_id>.jpg",
 *     latitude:     12.97,
 *     longitude:    77.59,
 *     address:      "MG Road, Bengaluru" (optional),
 *     image_width:  1080 (optional),
 *     image_height: 1080 (optional)
 *   }
 *
 * Response (200): { ok: true, photo_id: <bigint> }
 */

const {
  preflight,
  jsonResponse,
  verifyToken,
  rateLimit,
  HMAC_SECRET,
} = require('./_lib/auth');

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'dnxpt5gea';
const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://vtlkitpoffudiefuoijb.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RATE_MAX = 60;
const RATE_WINDOW = 3600;

function isValidCloudinaryUrl(url, deviceId) {
  if (typeof url !== 'string') return false;
  // Lock to https + our cloud name + the device's own folder, so a
  // tampered client can't pass a URL pointing at a different account.
  const expectedPrefix = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/`;
  if (!url.startsWith(expectedPrefix)) return false;
  if (!url.includes(`/geoai/${deviceId}/`)) return false;
  return url.length < 2048;
}

function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90
    && lng >= -180 && lng <= 180;
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
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse(503, {
      error: 'server not configured (SUPABASE_SERVICE_ROLE_KEY)',
    }, origin);
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'invalid JSON' }, origin);
  }

  // 1. Auth
  const tokenCheck = verifyToken(body.device_token);
  if (!tokenCheck.ok) {
    return jsonResponse(401, {
      error: 'invalid or expired device_token',
      reason: tokenCheck.reason,
    }, origin);
  }
  const deviceId = tokenCheck.deviceId;

  // 2. Per-device write rate limit (paired with /sign-upload's limit)
  const rl = await rateLimit(`photos:${deviceId}`, RATE_MAX, RATE_WINDOW);
  if (!rl.allowed) {
    return jsonResponse(429, {
      error: 'rate limit hit', retryAfter: rl.retryAfter,
    }, origin, { 'Retry-After': String(rl.retryAfter) });
  }

  // 3. Validate inputs
  if (!isValidCloudinaryUrl(body.image_url, deviceId)) {
    return jsonResponse(400, {
      error: 'image_url must be a Cloudinary URL in this device\'s folder',
    }, origin);
  }
  const lat = parseFloat(body.latitude);
  const lng = parseFloat(body.longitude);
  if (!isValidLatLng(lat, lng)) {
    return jsonResponse(400, { error: 'invalid latitude/longitude' }, origin);
  }
  const address = typeof body.address === 'string'
    ? body.address.slice(0, 500) : null;
  const imageWidth = Number.isFinite(parseInt(body.image_width, 10))
    ? parseInt(body.image_width, 10) : null;
  const imageHeight = Number.isFinite(parseInt(body.image_height, 10))
    ? parseInt(body.image_height, 10) : null;

  // 4. Insert via service-role
  const row = {
    image_url: body.image_url,
    latitude: lat,
    longitude: lng,
  };
  if (address) row.address = address;
  if (imageWidth) row.image_width = imageWidth;
  if (imageHeight) row.image_height = imageHeight;

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/photos`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify([row]),
    });

    if (!res.ok) {
      const detail = await res.text();
      return jsonResponse(502, {
        error: 'supabase insert failed',
        status: res.status,
        detail: detail.slice(0, 500),
      }, origin);
    }

    const inserted = await res.json();
    return jsonResponse(200, {
      ok: true,
      photo_id: inserted[0]?.id,
      device_id: deviceId,
    }, origin);
  } catch (e) {
    return jsonResponse(502, {
      error: 'supabase request failed',
      detail: e.message,
    }, origin);
  }
};
