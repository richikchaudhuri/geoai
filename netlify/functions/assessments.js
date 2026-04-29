/**
 * GeoAI WebGIS — Redis-cached Supabase proxy.
 *
 * Browser → this function → Upstash Redis (cache)
 *                       ↓ on miss
 *                       → Supabase
 *
 * Required Netlify env vars:
 *   UPSTASH_REDIS_REST_URL    — from your Upstash Redis dashboard
 *   UPSTASH_REDIS_REST_TOKEN  — from your Upstash Redis dashboard
 *
 * Optional (defaults baked in for the GeoAI capstone Supabase project):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *
 * If Upstash env vars are unset, the function still works — it just
 * skips the cache layer and proxies directly to Supabase. So you can
 * deploy first, set up Upstash later.
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://vtlkitpoffudiefuoijb.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bGtpdHBvZmZ1ZGllZnVvaWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAzMjIsImV4cCI6MjA4OTc3NjMyMn0.wLrwTky4k8iAELOvFbNeo063Z1rjQKOzzq3QYFqR6CU';

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const CACHE_KEY = 'geoai:webgis:v1';
const CACHE_TTL_SEC = 300; // 5 minutes — tune to taste

const PHOTOS_SELECT = 'id,latitude,longitude,address,image_url,created_at';
const ASSESSMENTS_SELECT =
  'id,photo_id,latitude,longitude,address,image_url,status,' +
  'distress_types,severity,stage2_confidence,stage1_confidence,' +
  'description,processed_at,created_at,expert_reviewed,' +
  'expert_corrected_types,expert_corrected_severity';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json',
};

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
    const res = await fetch(
      `${UPSTASH_URL}/setex/${encodeURIComponent(key)}/${ttlSec}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${UPSTASH_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(value),
      },
    );
    if (!res.ok) {
      console.warn('[geoai-fn] redis SETEX non-ok:', res.status);
    }
  } catch (e) {
    console.warn('[geoai-fn] redis SETEX failed:', e.message);
  }
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

  const [photosRes, assessRes] = await Promise.all([
    fetch(photosUrl, { headers }),
    fetch(assessUrl, { headers }),
  ]);

  const photos = photosRes.ok ? await photosRes.json() : [];
  const assessments = assessRes.ok ? await assessRes.json() : [];
  if (!photosRes.ok) console.warn('[geoai-fn] photos status:', photosRes.status);
  if (!assessRes.ok) console.warn('[geoai-fn] assessments status:', assessRes.status);

  return { photos, assessments, fetchedAt: new Date().toISOString() };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const start = Date.now();
  const force = (event.queryStringParameters || {}).force === '1';

  // Try cache first
  if (!force) {
    const cached = await redisGet(CACHE_KEY);
    if (cached) {
      const elapsed = Date.now() - start;
      return {
        statusCode: 200,
        headers: {
          ...CORS,
          'X-Cache': 'HIT',
          'X-Cache-Source': 'upstash',
          'X-Response-Ms': String(elapsed),
        },
        body: JSON.stringify(cached),
      };
    }
  }

  // Fetch from Supabase, cache, return
  try {
    const fresh = await fetchFromSupabase();
    // Fire-and-forget cache write — don't block the response on it
    redisSetEx(CACHE_KEY, fresh, CACHE_TTL_SEC).catch(() => {});
    const elapsed = Date.now() - start;
    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'X-Cache': force ? 'BYPASS' : 'MISS',
        'X-Cache-Source': UPSTASH_URL ? 'upstash' : 'none',
        'X-Response-Ms': String(elapsed),
      },
      body: JSON.stringify(fresh),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({
        error: 'upstream fetch failed',
        detail: e.message,
      }),
    };
  }
};
