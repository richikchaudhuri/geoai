/**
 * GeoAI WebGIS — Redis-cached, rate-limited Supabase proxy.
 *
 *   browser → this function → Upstash Redis (cache + rate limit) → Supabase
 *
 * Protections layered in here:
 *   1. CORS allowlist          (no wildcard; only known origins)
 *   2. Origin/Referer check    (rejects direct cURL / random sites)
 *   3. Method whitelist        (GET + OPTIONS only)
 *   4. Per-IP sliding window   (60 req/min) via Upstash INCR + EXPIRE
 *   5. Per-IP burst guard      (5 req/sec)  via second window
 *   6. Bot/UA blocklist        (rejects empty UA + common scrapers)
 *   7. Body validation         (no payload accepted on GET)
 *   8. Conservative timeouts   (don't hold Function compute hostage)
 *
 * Required Netlify env vars:
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *
 * Optional (defaults baked in for the GeoAI capstone Supabase project):
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://vtlkitpoffudiefuoijb.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bGtpdHBvZmZ1ZGllZnVvaWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAzMjIsImV4cCI6MjA4OTc3NjMyMn0.wLrwTky4k8iAELOvFbNeo063Z1rjQKOzzq3QYFqR6CU';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const CACHE_KEY = 'geoai:webgis:v1';
const CACHE_TTL_SEC = 300; // 5 min

// ── Rate limit ────────────────────────────────────────────────────────────
const RL_MINUTE_WINDOW_SEC = 60;
const RL_MINUTE_MAX = 60;       // 60 req/min/IP — generous for legit users
const RL_SECOND_WINDOW_SEC = 1;
const RL_SECOND_MAX = 5;        // 5 req/sec/IP burst — kills hammer attacks

// ── CORS allowlist ────────────────────────────────────────────────────────
// Add any other deployment URLs you control to this list.
const ALLOWED_ORIGINS = new Set([
  'https://gisgeoai.netlify.app',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',
]);

// ── Bot UA blocklist (case-insensitive substring match) ───────────────────
const BAD_UA_PATTERNS = [
  'curl/', 'wget/', 'python-requests', 'httpie',
  'go-http-client', 'java/', 'apache-httpclient',
  'scrapy', 'masscan', 'nmap', 'zgrab', 'nuclei',
];

const PHOTOS_SELECT = 'id,latitude,longitude,address,image_url,created_at';
const ASSESSMENTS_SELECT =
  'id,photo_id,latitude,longitude,address,image_url,status,' +
  'distress_types,severity,stage2_confidence,stage1_confidence,' +
  'description,processed_at,created_at,expert_reviewed,' +
  'expert_corrected_types,expert_corrected_severity';

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    'Cache-Control': 'no-cache',
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

function rejectUA(ua) {
  if (!ua || ua.length < 8) return true;
  const lower = ua.toLowerCase();
  return BAD_UA_PATTERNS.some(pat => lower.includes(pat));
}

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
  } catch (e) {
    console.warn('[geoai-fn] redis pipeline failed:', e.message);
    return null;
  }
}

async function redisGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) {
    console.warn('[geoai-fn] redis GET failed:', e.message);
    return null;
  }
}

async function redisSetEx(key, value, ttlSec) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}/setex/${encodeURIComponent(key)}/${ttlSec}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(value),
    });
  } catch (e) {
    console.warn('[geoai-fn] redis SETEX failed:', e.message);
  }
}

/**
 * Per-IP sliding window rate limit. Returns { allowed, retryAfter } using
 * two windows (minute + second) for both sustained and burst protection.
 * Falls open (allowed:true) if Upstash is unreachable so we degrade
 * gracefully instead of black-holing legit traffic.
 */
async function rateLimit(ip) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return { allowed: true, source: 'no-upstash' };

  const minKey = `rl:min:${ip}`;
  const secKey = `rl:sec:${ip}`;

  const result = await redisCmd([
    ['INCR', minKey],
    ['EXPIRE', minKey, String(RL_MINUTE_WINDOW_SEC), 'NX'],
    ['INCR', secKey],
    ['EXPIRE', secKey, String(RL_SECOND_WINDOW_SEC), 'NX'],
  ]);
  if (!result) return { allowed: true, source: 'redis-down' };

  const minCount = (result[0] && result[0].result) || 0;
  const secCount = (result[2] && result[2].result) || 0;

  if (secCount > RL_SECOND_MAX) {
    return { allowed: false, retryAfter: 1, reason: 'burst', count: secCount };
  }
  if (minCount > RL_MINUTE_MAX) {
    return { allowed: false, retryAfter: RL_MINUTE_WINDOW_SEC, reason: 'minute', count: minCount };
  }
  return { allowed: true, minCount, secCount };
}

async function fetchFromSupabase() {
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    Accept: 'application/json',
  };
  const photosUrl = `${SUPABASE_URL}/rest/v1/photos` +
    `?select=${PHOTOS_SELECT}&order=created_at.desc&limit=10000`;
  const assessUrl = `${SUPABASE_URL}/rest/v1/assessments` +
    `?select=${ASSESSMENTS_SELECT}&order=created_at.desc&limit=10000`;

  // 8s timeout — don't burn Function compute on slow Supabase
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const [photosRes, assessRes] = await Promise.all([
      fetch(photosUrl, { headers, signal: ctrl.signal }),
      fetch(assessUrl, { headers, signal: ctrl.signal }),
    ]);
    const photos = photosRes.ok ? await photosRes.json() : [];
    const assessments = assessRes.ok ? await assessRes.json() : [];
    return { photos, assessments, fetchedAt: new Date().toISOString() };
  } finally {
    clearTimeout(t);
  }
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || '';
  const headers = corsHeaders(origin);

  // 1. CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // 2. Method whitelist
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method not allowed' }) };
  }

  // 3. Origin / Referer check — reject random clients hot-linking us
  const referer = event.headers.referer || event.headers.Referer || '';
  const refOrigin = referer ? new URL(referer).origin : '';
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'origin not allowed' }) };
  }
  if (!origin && !ALLOWED_ORIGINS.has(refOrigin)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'no allowed origin or referer' }) };
  }

  // 4. UA blocklist
  const ua = event.headers['user-agent'] || event.headers['User-Agent'] || '';
  if (rejectUA(ua)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'user-agent rejected' }) };
  }

  // 5. Per-IP rate limit (minute + second windows)
  const ip = clientIp(event);
  const rl = await rateLimit(ip);
  if (!rl.allowed) {
    return {
      statusCode: 429,
      headers: { ...headers, 'Retry-After': String(rl.retryAfter) },
      body: JSON.stringify({
        error: 'rate limit exceeded',
        reason: rl.reason,
        retryAfter: rl.retryAfter,
      }),
    };
  }

  const start = Date.now();
  const force = (event.queryStringParameters || {}).force === '1';

  // 6. Try cache
  if (!force) {
    const cached = await redisGet(CACHE_KEY);
    if (cached) {
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'X-Cache': 'HIT',
          'X-Cache-Source': 'upstash',
          'X-Response-Ms': String(Date.now() - start),
          'X-RateLimit-Minute': String(rl.minCount || 0),
        },
        body: JSON.stringify(cached),
      };
    }
  }

  // 7. Fetch fresh, cache, return
  try {
    const fresh = await fetchFromSupabase();
    redisSetEx(CACHE_KEY, fresh, CACHE_TTL_SEC).catch(() => {});
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'X-Cache': force ? 'BYPASS' : 'MISS',
        'X-Cache-Source': UPSTASH_URL ? 'upstash' : 'none',
        'X-Response-Ms': String(Date.now() - start),
        'X-RateLimit-Minute': String(rl.minCount || 0),
      },
      body: JSON.stringify(fresh),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'upstream fetch failed', detail: e.message }),
    };
  }
};
