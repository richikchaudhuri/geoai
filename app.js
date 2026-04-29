/* ---------- Loading screen ---------- */

const LoadingScreen = (() => {
  const screen = document.getElementById('loadingScreen');
  const statusText = document.getElementById('loadingStatusText');
  const dots = Array.from(document.querySelectorAll('.loading-dot'));
  const bar = document.getElementById('loadingBarFill');
  const totalStages = dots.length;
  const labels = [
    'Initialising map',
    'Loading basemap tiles',
    'Connecting to Supabase',
    'Fetching assessments',
    'Plotting locations',
  ];
  let currentStage = -1;
  let finished = false;
  const minStartTime = performance.now();

  function swapStatus(text) {
    if (!statusText) return;
    statusText.classList.add('swapping');
    setTimeout(() => {
      statusText.textContent = text;
      statusText.classList.remove('swapping');
    }, 220);
  }

  function setStage(index) {
    if (finished) return;
    if (index <= currentStage) return;
    currentStage = index;
    dots.forEach((d, i) => {
      d.classList.remove('active', 'done');
      if (i < index) d.classList.add('done');
      else if (i === index) d.classList.add('active');
    });
    bar.style.width = `${Math.min(100, ((index + 0.6) / totalStages) * 100)}%`;
    if (labels[index]) swapStatus(labels[index]);
  }

  function finish() {
    if (finished) return;
    finished = true;
    dots.forEach((d) => { d.classList.remove('active'); d.classList.add('done'); });
    bar.style.width = '100%';
    swapStatus('Ready');
    const elapsed = performance.now() - minStartTime;
    const remaining = Math.max(0, 900 - elapsed);
    setTimeout(() => {
      screen.classList.add('done');
    }, remaining + 400);
  }

  // ----- Interactive constellation field -----
  const canvas = document.getElementById('loadingCanvas');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let cw = 0, ch = 0;
  let mouseX = 0, mouseY = 0, hasMouse = false;
  const particles = [];
  const COUNT = 110;

  function resize() {
    cw = window.innerWidth;
    ch = window.innerHeight;
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < COUNT; i++) {
    particles.push({
      x: Math.random() * cw,
      y: Math.random() * ch,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      r: Math.random() * 1.4 + 0.5,
      base: Math.random() * 0.5 + 0.3,
      twinkle: Math.random() * Math.PI * 2,
    });
  }

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX; mouseY = e.clientY; hasMouse = true;
  });
  window.addEventListener('touchmove', (e) => {
    if (!e.touches.length) return;
    mouseX = e.touches[0].clientX; mouseY = e.touches[0].clientY; hasMouse = true;
  }, { passive: true });

  const ripples = [];
  window.addEventListener('mousedown', (e) => {
    if (finished) return;
    ripples.push({ x: e.clientX, y: e.clientY, r: 0, alpha: 0.6 });
  });

  let frame = 0;
  function draw() {
    if (screen.classList.contains('done')) return;
    frame++;
    ctx.clearRect(0, 0, cw, ch);

    // Particles (white stars, twinkle)
    for (const p of particles) {
      if (hasMouse) {
        const dx = mouseX - p.x;
        const dy = mouseY - p.y;
        const dSq = dx * dx + dy * dy;
        const range = 220;
        if (dSq < range * range) {
          const d = Math.sqrt(dSq) || 1;
          const f = (range - d) / range * 0.07;
          p.vx += (dx / d) * f;
          p.vy += (dy / d) * f;
        }
      }
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.95;
      p.vy *= 0.95;
      p.vx += (Math.random() - 0.5) * 0.04;
      p.vy += (Math.random() - 0.5) * 0.04;
      p.twinkle += 0.04;

      if (p.x < 0) p.x = cw; else if (p.x > cw) p.x = 0;
      if (p.y < 0) p.y = ch; else if (p.y > ch) p.y = 0;

      const twinkle = 0.7 + 0.3 * Math.sin(p.twinkle);
      ctx.globalAlpha = p.base * twinkle;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Constellation lines
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const a = particles[i], b = particles[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 110 * 110) {
          ctx.globalAlpha = (1 - Math.sqrt(d2) / 110) * 0.14;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    // Mouse-anchored connecting lines (more reactive)
    if (hasMouse) {
      ctx.strokeStyle = '#ffffff';
      for (const p of particles) {
        const dx = mouseX - p.x, dy = mouseY - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 160 * 160) {
          ctx.globalAlpha = (1 - Math.sqrt(d2) / 160) * 0.35;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(mouseX, mouseY);
          ctx.stroke();
        }
      }
    }

    // Click ripples
    ctx.strokeStyle = '#ffffff';
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += 5;
      rp.alpha *= 0.96;
      ctx.globalAlpha = rp.alpha;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
      ctx.stroke();
      if (rp.alpha < 0.02) ripples.splice(i, 1);
    }

    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  setTimeout(() => finish(), 12000);

  return { setStage, finish };
})();

const MAPTILER_KEY = 'W0xPGqC6BW5yhLWJ0C9A';

const SUPABASE_URL = 'https://vtlkitpoffudiefuoijb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bGtpdHBvZmZ1ZGllZnVvaWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAzMjIsImV4cCI6MjA4OTc3NjMyMn0.wLrwTky4k8iAELOvFbNeo063Z1rjQKOzzq3QYFqR6CU';

const BENGALURU = [12.9716, 77.5946];

const DISTRESS_COLORS = {
  'Longitudinal Crack (D00)': '#FCD34D',
  'Transverse Crack (D10)': '#FB923C',
  'Alligator Crack (D20)': '#EF4444',
  'Pothole (D40)': '#991B1B',
  'Block Crack (D43)': '#A855F7',
};
const UNKNOWN_COLOR = '#6E6E73';

const TYPE_RANK = {
  'Pothole (D40)': 5,
  'Alligator Crack (D20)': 4,
  'Block Crack (D43)': 3,
  'Transverse Crack (D10)': 2,
  'Longitudinal Crack (D00)': 1,
};

const SEVERITY_RADIUS = { Low: 10, Medium: 14, High: 19, None: 7, Unknown: 7 };
const SEVERITY_COLOR = {
  Low: '#facc15',
  Medium: '#fb923c',
  High: '#dc2626',
  None: '#6E6E73',
  Unknown: '#6E6E73',
};

const MAP_STYLES = {
  light: {
    dark: false,
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 20, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO' },
  },
  dark: {
    dark: true,
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 20, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO' },
  },
  voyager: {
    dark: false,
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 20, subdomains: 'abcd', attribution: '&copy; OpenStreetMap &copy; CARTO' },
  },
  satellite: {
    dark: true,
    url: `https://api.maptiler.com/maps/hybrid-v4/{z}/{x}/{y}{r}.png?key=${MAPTILER_KEY}`,
    options: { maxZoom: 22, tileSize: 512, zoomOffset: -1, crossOrigin: true,
               attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; OSM' },
  },
  backdrop: {
    dark: false,
    url: `https://api.maptiler.com/maps/backdrop-v4/{z}/{x}/{y}{r}.png?key=${MAPTILER_KEY}`,
    options: { maxZoom: 22, tileSize: 512, zoomOffset: -1, crossOrigin: true,
               attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; OSM' },
  },
  toner: {
    dark: false,
    url: `https://api.maptiler.com/maps/toner-v2/{z}/{x}/{y}{r}.png?key=${MAPTILER_KEY}`,
    options: { maxZoom: 22, tileSize: 512, zoomOffset: -1, crossOrigin: true,
               attribution: '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> &copy; OSM' },
  },
};

LoadingScreen.setStage(0); // Initialising map

const map = L.map('map', {
  zoomControl: false,
  attributionControl: true,
}).setView(BENGALURU, 12);

L.control.zoom({ position: 'bottomright' }).addTo(map);

LoadingScreen.setStage(1); // Loading basemap tiles

let currentTileLayer = null;
let currentStyle = localStorage.getItem('mapStyle') || 'light';

function setMapStyle(styleKey) {
  const style = MAP_STYLES[styleKey];
  if (!style) return;
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = L.tileLayer(style.url, style.options);
  currentTileLayer.once('load', () => LoadingScreen.setStage(2));
  currentTileLayer.addTo(map);
  currentStyle = styleKey;
  localStorage.setItem('mapStyle', styleKey);
  document.body.classList.toggle('chrome-dark', !!style.dark);
  document.querySelectorAll('.settings-option').forEach((el) => {
    el.classList.toggle('active', el.dataset.style === styleKey);
  });
}

setMapStyle(currentStyle);

const statusEl = document.getElementById('status');
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const searchWrap = document.getElementById('searchWrap');
const searchTrigger = document.getElementById('searchTrigger');

function setStatus(text, state) {
  statusEl.textContent = text;
  statusEl.classList.remove('live', 'error');
  if (state) statusEl.classList.add(state);
}

/* ---------- Location search (Nominatim) ---------- */

let searchHighlight = null;
let searchMarker = null;
let searchTimer = null;
let activeQuery = '';

async function runSearch(q) {
  if (!q || q.length < 2) {
    searchResults.classList.remove('open');
    searchResults.innerHTML = '';
    return;
  }
  activeQuery = q;
  const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&polygon_geojson=0&q=${encodeURIComponent(q)}`;
  try {
    const res = await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } });
    if (activeQuery !== q) return;
    const data = await res.json();
    renderResults(data);
  } catch (e) {
    renderResults([]);
  }
}

function renderResults(items) {
  searchResults.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'result-empty';
    empty.textContent = 'No results';
    searchResults.appendChild(empty);
    searchResults.classList.add('open');
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'result';
    row.innerHTML = `
      <div class="result-title"></div>
      <div class="result-meta"></div>
    `;
    const parts = item.display_name.split(', ');
    row.querySelector('.result-title').textContent = parts[0];
    row.querySelector('.result-meta').textContent = parts.slice(1).join(', ');
    row.addEventListener('click', () => selectResult(item));
    searchResults.appendChild(row);
  });
  searchResults.classList.add('open');
}

function selectResult(item) {
  const lat = parseFloat(item.lat);
  const lon = parseFloat(item.lon);
  const bb = item.boundingbox; // [southLat, northLat, westLon, eastLon]


  if (searchHighlight) { map.removeLayer(searchHighlight); searchHighlight = null; }
  if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }

  if (bb && bb.length === 4) {
    const south = parseFloat(bb[0]);
    const north = parseFloat(bb[1]);
    const west = parseFloat(bb[2]);
    const east = parseFloat(bb[3]);
    const bounds = [[south, west], [north, east]];

    searchHighlight = L.rectangle(bounds, {
      color: '#1A1A1C',
      weight: 2,
      opacity: 0.9,
      fillColor: '#1A1A1C',
      fillOpacity: 0.05,
      dashArray: '6 4',
    }).addTo(map);

    map.flyToBounds(bounds, { padding: [80, 80], duration: 0.8 });
  } else {
    map.flyTo([lat, lon], 14, { duration: 0.8 });
  }

  searchMarker = L.circleMarker([lat, lon], {
    radius: 6,
    color: '#FFFFFF',
    weight: 2,
    fillColor: '#1A1A1C',
    fillOpacity: 1,
  }).addTo(map).bindTooltip(item.display_name.split(', ')[0], {
    direction: 'top',
    offset: [0, -8],
    className: 'search-tooltip',
    permanent: false,
  });

  searchInput.value = item.display_name.split(', ')[0];
  searchWrap.classList.add('has-value');
  searchWrap.classList.remove('active');
  searchResults.classList.remove('open');
  searchInput.blur();
}

function collapseSearch({ clear = false } = {}) {
  searchWrap.classList.remove('hint', 'active');
  if (clear) {
    searchInput.value = '';
    searchWrap.classList.remove('has-value');
    if (searchHighlight) { map.removeLayer(searchHighlight); searchHighlight = null; }
    if (searchMarker) { map.removeLayer(searchMarker); searchMarker = null; }
  }
  searchResults.classList.remove('open');
  searchInput.blur();
}

function advanceSearchState() {
  if (searchWrap.classList.contains('active') || searchWrap.classList.contains('has-value')) {
    searchInput.focus();
  } else if (searchWrap.classList.contains('hint')) {
    searchWrap.classList.remove('hint');
    searchWrap.classList.add('active');
    setTimeout(() => searchInput.focus(), 80);
  } else {
    searchWrap.classList.add('hint');
  }
}

searchWrap.addEventListener('click', (e) => {
  if (e.target === searchInput) return;
  e.stopPropagation();
  advanceSearchState();
});

searchInput.addEventListener('focus', () => {
  searchWrap.classList.remove('hint');
  searchWrap.classList.add('active');
  if (searchInput.value && searchResults.children.length) {
    searchResults.classList.add('open');
  }
});

searchInput.addEventListener('input', (e) => {
  const q = e.target.value.trim();
  searchWrap.classList.toggle('has-value', q.length > 0);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(q), 300);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    collapseSearch({ clear: true });
    settingsWrap.classList.remove('open');
  } else if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) &&
             !searchWrap.classList.contains('active')) {
    e.preventDefault();
    searchWrap.classList.remove('hint');
    searchWrap.classList.add('active');
    setTimeout(() => searchInput.focus(), 80);
  }
});

/* ---------- Settings panel ---------- */

const settingsWrap = document.getElementById('settingsWrap');
const settingsTrigger = document.getElementById('settingsTrigger');
const settingsOptions = document.getElementById('settingsOptions');

settingsTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsWrap.classList.toggle('open');
  searchWrap.classList.remove('hint', 'active');
  searchResults.classList.remove('open');
});

settingsOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('.settings-option');
  if (!btn) return;
  setMapStyle(btn.dataset.style);
});

// Single document click handler — closes search and settings when clicking
// outside their respective wraps. Merged from two separate handlers that
// could race with each other.
document.addEventListener('click', (e) => {
  if (!searchWrap.contains(e.target)) {
    searchWrap.classList.remove('hint', 'active');
    searchResults.classList.remove('open');
  }
  if (!settingsWrap.contains(e.target)) {
    settingsWrap.classList.remove('open');
  }
});

/* ---------- Supabase: assessments layer ---------- */

const sb = (window.supabase && SUPABASE_ANON_KEY && SUPABASE_ANON_KEY !== 'PASTE_SUPABASE_ANON_KEY_HERE')
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const assessmentLayer = L.layerGroup().addTo(map);

let allMergedRows = [];

/* ---------- Smart caching (saves Supabase reads + Nominatim hits) ---------- */

// Bumped to v3 to bust any locally-cached data that was stored before the
// day/night filter fix, so users get a fresh fetch and the new logic
// runs against current data.
const CACHE_VERSION = 3;
const CACHE_KEY = `geoai:dataCache:v${CACHE_VERSION}`;
const CACHE_TTL_MS = 10 * 60 * 1000;          // 10 min: serve from cache, no network
const CACHE_HARD_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 h: still usable but always revalidate

const Cache = {
  read() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.data) || !parsed.timestamp) return null;
      const age = Date.now() - parsed.timestamp;
      if (age > CACHE_HARD_LIMIT_MS) {
        localStorage.removeItem(CACHE_KEY);
        return null;
      }
      return { ...parsed, age };
    } catch (e) {
      return null;
    }
  },
  write(data) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        data,
        timestamp: Date.now(),
        version: CACHE_VERSION,
      }));
    } catch (e) {
      // Quota exceeded — drop cache rather than crash
      try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
      console.warn('[GeoAI] cache write failed:', e.message);
    }
  },
  fresh(entry) {
    return entry && entry.age < CACHE_TTL_MS;
  },
  clear() {
    localStorage.removeItem(CACHE_KEY);
  },
};
window.GeoAICache = Cache; // exposed for console debugging

function pickPrimaryType(types) {
  if (!types || !types.length) return null;
  let best = types[0];
  let bestRank = TYPE_RANK[best] || 0;
  for (const t of types) {
    const r = TYPE_RANK[t] || 0;
    if (r > bestRank) { best = t; bestRank = r; }
  }
  return best;
}

function colorForTypes(types) {
  const primary = pickPrimaryType(types);
  if (!primary) return UNKNOWN_COLOR;
  return DISTRESS_COLORS[primary] || UNKNOWN_COLOR;
}

function effectiveTypes(row) {
  if (Array.isArray(row.expert_corrected_types) && row.expert_corrected_types.length) {
    return row.expert_corrected_types;
  }
  return Array.isArray(row.distress_types) ? row.distress_types : [];
}

function effectiveSeverity(row) {
  return row.expert_corrected_severity || row.severity || 'Unknown';
}

function effectiveConfidence(row) {
  if (typeof row.stage2_confidence === 'number' && row.stage2_confidence > 0) {
    return row.stage2_confidence;
  }
  return row.stage1_confidence || 0;
}

/**
 * Try the Netlify Function endpoint that proxies Supabase via Upstash
 * Redis. Returns { ok, body, cacheState, responseMs } on success or
 * { ok: false } on any failure (function not deployed, network error,
 * non-2xx, etc.). Caller falls back to direct Supabase.
 */
async function tryNetlifyFunction() {
  // Skip the function call when running from file:// or a localhost
  // dev server — Netlify functions only exist on the deployed site.
  // This means local-dev still works via direct Supabase.
  const onNetlify = location.protocol === 'https:' ||
                    /\.netlify\.app$/.test(location.hostname);
  if (!onNetlify) return { ok: false };

  try {
    const res = await fetch('/.netlify/functions/assessments', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false };
    const body = await res.json();
    return {
      ok: true,
      body,
      cacheState: res.headers.get('X-Cache') || 'unknown',
      responseMs: res.headers.get('X-Response-Ms') || '?',
    };
  } catch (_) {
    return { ok: false };
  }
}

async function loadAssessments() {
  // 1) Try cache first — this is what saves your bills
  const cached = Cache.read();
  let renderedFromCache = false;
  if (cached) {
    console.log(`[GeoAI] cache hit · ${cached.data.length} rows · ${Math.round(cached.age / 1000)}s old`);
    allMergedRows = cached.data;
    LoadingScreen.setStage(3);
    LoadingScreen.setStage(4);
    renderAssessments(cached.data);
    LoadingScreen.finish();
    renderedFromCache = true;

    // Cache is fresh enough — skip the network entirely. Zero Supabase reads.
    if (Cache.fresh(cached)) {
      const ageS = Math.round(cached.age / 1000);
      setStatus(`${cached.data.length.toLocaleString()} cached · ${ageS}s ago`, 'live');
      return;
    }
    // Cache is stale: fall through and refresh in background
    console.log('[GeoAI] cache stale, revalidating in background');
  }

  if (!sb) {
    if (!renderedFromCache) {
      setStatus('Add Supabase anon key', 'error');
      LoadingScreen.finish();
    }
    return;
  }

  if (!renderedFromCache) {
    LoadingScreen.setStage(3);
    setStatus('Loading data…');
  }

  try {
    let photos = [];
    let assessments = [];
    let source = 'supabase-direct';

    // 1) Try the Netlify Function (Redis-backed). One shared cache across
    //    all visitors, so most page loads cost zero Supabase reads.
    const fnResp = await tryNetlifyFunction();
    if (fnResp.ok) {
      photos = fnResp.body.photos || [];
      assessments = fnResp.body.assessments || [];
      source = `netlify-fn (${fnResp.cacheState}, ${fnResp.responseMs}ms)`;
    } else {
      // 2) Fall back to direct Supabase (function not deployed, errored,
      //    or running site locally without Netlify).
      const [photosRes, assessRes] = await Promise.all([
        sb.from('photos')
          .select('id, latitude, longitude, address, image_url, created_at')
          .order('created_at', { ascending: false })
          .limit(10000),
        sb.from('assessments')
          .select(`
            id, photo_id, latitude, longitude, address, image_url, status,
            distress_types, severity, stage2_confidence, stage1_confidence,
            description, processed_at, created_at, expert_reviewed,
            expert_corrected_types, expert_corrected_severity
          `)
          .order('created_at', { ascending: false })
          .limit(10000),
      ]);
      if (photosRes.error) console.error('photos query error:', photosRes.error);
      if (assessRes.error) console.error('assessments query error:', assessRes.error);
      if (photosRes.error && assessRes.error) throw photosRes.error;
      photos = photosRes.data || [];
      assessments = assessRes.error ? [] : (assessRes.data || []);
    }

    console.log(`[GeoAI] data via ${source}: photos=${photos.length}, assessments=${assessments.length}`);
    if (assessments.length) console.log('[GeoAI] sample assessment:', assessments[0]);

    const byPhotoId = new Map();
    const byImageUrl = new Map();
    for (const a of assessments) {
      if (a.photo_id != null) byPhotoId.set(a.photo_id, a);
      if (a.image_url) byImageUrl.set(a.image_url, a);
    }

    const usedAssessmentIds = new Set();
    const merged = photos.map((p) => {
      const a = byPhotoId.get(p.id) || byImageUrl.get(p.image_url);
      if (a) {
        usedAssessmentIds.add(a.id);
        return {
          ...a,
          latitude: a.latitude ?? p.latitude,
          longitude: a.longitude ?? p.longitude,
          address: a.address || p.address,
          image_url: a.image_url || p.image_url,
          created_at: p.created_at,
        };
      }
      return {
        id: `photo-${p.id}`,
        latitude: p.latitude,
        longitude: p.longitude,
        address: p.address,
        image_url: p.image_url,
        created_at: p.created_at,
        processed_at: null,
        status: 'pending',
        distress_types: [],
        severity: 'Unknown',
        description: '',
      };
    });

    for (const a of assessments) {
      if (usedAssessmentIds.has(a.id)) continue;
      if (a.latitude == null || a.longitude == null) continue;
      merged.push(a);
    }

    const classified = merged.filter(r => Array.isArray(r.distress_types) && r.distress_types.length).length;
    console.log(`[GeoAI] merged: ${merged.length} (with classification: ${classified})`);

    // 2) Persist to cache so the next page load is instant + free
    Cache.write(merged);

    if (renderedFromCache) {
      // Background revalidate — only re-render if the data actually changed
      const oldCount = allMergedRows.length;
      const sameLength = oldCount === merged.length;
      const sameClassified = sameLength && classified === allMergedRows.filter(r => Array.isArray(r.distress_types) && r.distress_types.length).length;
      if (!sameClassified) {
        allMergedRows = merged;
        renderAssessments(merged);
        setStatus(`${merged.length.toLocaleString()} assessments · refreshed`, 'live');
      } else {
        setStatus(`${merged.length.toLocaleString()} assessments · in sync`, 'live');
      }
    } else {
      allMergedRows = merged;
      LoadingScreen.setStage(4);
      renderAssessments(merged);
      LoadingScreen.finish();
    }
  } catch (e) {
    console.error('Supabase load failed:', e);
    if (!renderedFromCache) {
      setStatus('Data error · check console', 'error');
      LoadingScreen.finish();
    } else {
      setStatus(`${allMergedRows.length.toLocaleString()} cached · network error`, 'error');
    }
  }
}

/* ---------- Day / night classification ---------- */

// Approximate sun-elevation calculation based on date + lat/lng.
// Returns true = daytime (sun above horizon), false = night, null if unknown.
function isDaytime(timestampLike, lat, lng) {
  if (!timestampLike || lat == null || lng == null) return null;
  const d = new Date(timestampLike);
  if (isNaN(d.getTime())) return null;

  const dayOfYear = Math.floor(
    (d - new Date(Date.UTC(d.getUTCFullYear(), 0, 0))) / 86400000
  );
  // Solar declination (°)
  const decl = -23.45 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365);
  const declRad = (decl * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;

  // Hour angle at the day/night boundary. We use civil twilight (sun at -6°)
  // rather than the geometric horizon — that matches photographic reality
  // (handheld photos start needing flash for surface detail) and lines up
  // with when streetlights typically come on. For Bengaluru in April this
  // puts the night cutoff at ~19:00 IST.
  const cosH =
    (Math.sin((-6 * Math.PI) / 180) -
      Math.sin(latRad) * Math.sin(declRad)) /
    (Math.cos(latRad) * Math.cos(declRad));

  if (cosH < -1) return true;   // polar day
  if (cosH > 1)  return false;  // polar night

  const hourAngleHours = (Math.acos(cosH) * 12) / Math.PI;
  const sunriseUTC = 12 - lng / 15 - hourAngleHours;
  const sunsetUTC  = 12 - lng / 15 + hourAngleHours;
  const utcHourFrac = d.getUTCHours() + d.getUTCMinutes() / 60;
  return utcHourFrac >= sunriseUTC && utcHourFrac <= sunsetUTC;
}

function rowIsDaytime(row) {
  // Use the CAPTURE time (created_at = photo upload time on the assessment
  // row), not processed_at (AI classification time, which may be hours or
  // days later). A photo taken at 11pm but processed at 9am the next morning
  // was incorrectly being flagged as "day" before this fix.
  const ts = row.created_at || row.processed_at;
  return isDaytime(ts, row.latitude, row.longitude);
}

function rowSeverityRank(row) {
  const sev = effectiveSeverity(row);
  return ({ High: 3, Medium: 2, Low: 1 })[sev] || 0;
}

function rowTypeRank(row) {
  const types = effectiveTypes(row);
  const primary = pickPrimaryType(types);
  return primary ? (TYPE_RANK[primary] || 0) : 0;
}

// Grid-based clustering at ~5 metre cell size.
// 1° latitude  ≈ 111 320 m (constant)
// 1° longitude ≈ 111 320 × cos(lat) m  (depends on latitude)
// Cluster only photos taken from essentially the same spot (handles GPS
// jitter ~3m, doesn't merge distinct nearby damages).
const CLUSTER_RADIUS_M = 3;

function clusterRows(rows) {
  // Clustering disabled — every row is its own marker
  if (CLUSTER_RADIUS_M <= 0) {
    return rows
      .filter(r => r.latitude != null && r.longitude != null)
      .map(r => [r]);
  }

  const groups = new Map();
  const latStep = CLUSTER_RADIUS_M / 111320;
  for (const row of rows) {
    if (row.latitude == null || row.longitude == null) continue;
    const cosLat = Math.cos((row.latitude * Math.PI) / 180);
    const lngStep = CLUSTER_RADIUS_M / (111320 * Math.max(0.01, cosLat));
    const latCell = Math.round(row.latitude / latStep);
    const lngCell = Math.round(row.longitude / lngStep);
    const key = `${latCell}|${lngCell}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}

/* ---------- Severity filter state (persists across card close) ---------- */

const SEVERITY_LABELS = { Low: 'Less', Medium: 'Moderate', High: 'Red Alert' };
const SEVERITY_DOT_COLOR = { Low: '#22c55e', Medium: '#facc15', High: '#dc2626' };
let activeSeverityFilter = null;
let activeTimeFilter = null;  // 'day' | 'night' | null

const severityPill = document.getElementById('severityPill');
const severityPillDot = document.getElementById('severityPillDot');
const severityPillLabel = document.getElementById('severityPillLabel');
const severityPillClose = document.getElementById('severityPillClose');

const timePill = document.getElementById('timePill');
const timePillDot = document.getElementById('timePillDot');
const timePillLabel = document.getElementById('timePillLabel');
const timePillClose = document.getElementById('timePillClose');

function positionSeverityPill() {
  if (window.innerWidth <= 820) {
    if (severityPill) { severityPill.style.left = ''; severityPill.style.top = ''; }
    if (timePill) { timePill.style.left = ''; timePill.style.top = ''; }
    return;
  }
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const rect = topbar.getBoundingClientRect();

  let cursorX = rect.right + 14;
  // Severity pill first (if visible), then time pill to its right
  for (const pill of [severityPill, timePill]) {
    if (!pill || pill.hidden) continue;
    const pillH = pill.offsetHeight || 50;
    pill.style.left = `${Math.round(cursorX)}px`;
    pill.style.top = `${Math.round(rect.top + (rect.height - pillH) / 2)}px`;
    cursorX += pill.offsetWidth + 10;
  }
}

function setSeverityFilter(level) {
  activeSeverityFilter = (level && level !== 'all') ? level : null;

  if (activeSeverityFilter) {
    severityPillLabel.textContent = SEVERITY_LABELS[activeSeverityFilter] || activeSeverityFilter;
    severityPillDot.style.background = SEVERITY_DOT_COLOR[activeSeverityFilter] || UNKNOWN_COLOR;
    severityPill.hidden = false;
    requestAnimationFrame(() => {
      positionSeverityPill();
      severityPill.classList.add('show');
    });
    // Filter is locked in — collapse the filter stack and bounce nav to Map
    closeFilterStack();
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    const mapNav = document.querySelector('.nav-item[data-page="map"]');
    if (mapNav) mapNav.classList.add('active');
  } else {
    severityPill.classList.remove('show');
    setTimeout(() => { severityPill.hidden = true; positionSeverityPill(); }, 350);
    // Mirror to the severity card UI if it's open
    if (typeof setSeverityActive === 'function') setSeverityActive(null);
  }

  // Re-render markers with the filter applied
  renderAssessments(allMergedRows);
}

severityPillClose.addEventListener('click', (e) => {
  e.stopPropagation();
  setSeverityFilter(null);
});

window.addEventListener('resize', positionSeverityPill);

function renderAssessments(rows) {
  assessmentLayer.clearLayers();

  // Apply persistent severity filter
  let filtered = rows;
  if (activeSeverityFilter) {
    filtered = rows.filter(r => effectiveSeverity(r) === activeSeverityFilter);
  }
  // Apply persistent day/night filter
  if (activeTimeFilter) {
    let dayCount = 0, nightCount = 0, unknownCount = 0;
    filtered = filtered.filter(r => {
      const day = rowIsDaytime(r);
      if (day === true) dayCount++;
      else if (day === false) nightCount++;
      else unknownCount++;
      if (day == null) return activeTimeFilter === 'day'; // unknowns default to day bucket
      return activeTimeFilter === 'day' ? day : !day;
    });
    console.log(
      `[GeoAI] time filter='${activeTimeFilter}' · ` +
      `${dayCount} day, ${nightCount} night, ${unknownCount} unknown · ` +
      `kept ${filtered.length}`
    );
    // Sanity check: log a sample of what slipped through
    if (filtered.length && activeTimeFilter === 'night') {
      const sample = filtered.slice(0, 3).map(r => ({
        id: r.id,
        created_at: r.created_at,
        processed_at: r.processed_at,
        lat: r.latitude,
        lng: r.longitude,
        rowIsDaytime: rowIsDaytime(r),
      }));
      console.log('[GeoAI] sample night-filtered rows:', sample);
    }
  }

  const groups = clusterRows(filtered);
  let plotted = 0;
  for (const group of groups) {
    if (group.length === 1) {
      addSingleMarker(group[0]);
    } else {
      addClusterMarker(group);
    }
    plotted += group.length;
  }
  if (plotted === 0) {
    if (activeSeverityFilter) {
      setStatus(`0 ${SEVERITY_LABELS[activeSeverityFilter] || ''} assessments`, 'error');
    } else {
      setStatus('No data found', 'error');
    }
  } else {
    const suffix = activeSeverityFilter ? ` · ${SEVERITY_LABELS[activeSeverityFilter]} only` : '';
    setStatus(`${plotted.toLocaleString()} assessment${plotted === 1 ? '' : 's'}${suffix}`, 'live');
  }
}

function isSameLocation(a, b) {
  if (!a || !b) return false;
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

function addSingleMarker(row) {
  const types = effectiveTypes(row);
  const severity = effectiveSeverity(row);
  const fill = colorForTypes(types);
  const radius = SEVERITY_RADIUS[severity] || 5;
  const day = rowIsDaytime(row);

  // Night captures get an unmistakable dark halo behind the colored dot.
  // Severity colour stays the same so the user can still read severity at a
  // glance, but the halo + dashed inner border makes day/night unmissable.
  if (day === false) {
    L.circleMarker([row.latitude, row.longitude], {
      radius: radius + 6,
      color: '#0F172A',
      weight: 1.5,
      fillColor: '#0F172A',
      fillOpacity: 0.28,
      dashArray: '4 3',
      interactive: false,  // click passes through to the real marker
    }).addTo(assessmentLayer);
  }

  const m = L.circleMarker([row.latitude, row.longitude], {
    radius,
    color: '#FFFFFF',
    weight: 2.5,
    fillColor: fill,
    fillOpacity: 0.9,
    // Night captures: longer-dashed white border. Day captures: solid.
    dashArray: day === false ? '5 3' : null,
  });
  m.on('click', () => {
    if (isSameLocation(selectedLatLng, [row.latitude, row.longitude])) return;
    showCards([row]);
  });
  m.addTo(assessmentLayer);
}

function addClusterMarker(group) {
  const lat = group[0].latitude;
  const lng = group[0].longitude;

  let bestColor = UNKNOWN_COLOR;
  let bestRank = -1;
  for (const row of group) {
    const r = rowTypeRank(row);
    if (r > bestRank) {
      bestRank = r;
      const types = effectiveTypes(row);
      bestColor = colorForTypes(types);
    }
  }

  // If every member of this cluster is a night capture, give the cluster
  // the same dark halo as individual night markers so the visual cue
  // carries through clustering.
  const allNight = group.every(r => rowIsDaytime(r) === false);
  if (allNight) {
    const haloRadius = Math.min(28, 18 + group.length);
    L.circleMarker([lat, lng], {
      radius: haloRadius,
      color: '#0F172A',
      weight: 1.5,
      fillColor: '#0F172A',
      fillOpacity: 0.28,
      dashArray: '4 3',
      interactive: false,
    }).addTo(assessmentLayer);
  }

  const size = Math.min(48, 28 + group.length * 2);
  const cls = allNight ? 'cluster-marker night' : 'cluster-marker';
  const icon = L.divIcon({
    className: 'cluster-marker-wrapper',
    html: `<div class="${cls}" style="background:${bestColor}">${group.length}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

  const m = L.marker([lat, lng], { icon });
  m.on('click', () => {
    if (isSameLocation(selectedLatLng, [lat, lng])) return;
    showCards(group);
  });
  m.addTo(assessmentLayer);
}

/* ---------- Cards (single + clustered) ---------- */

const cardStack = document.getElementById('cardStack');
const cardConnectors = document.getElementById('cardConnectors');
const CARD_EDGE_PADDING = 16;
const SINGLE_DISTANCE = 80;
const FAN_DISTANCE = 220;
const CIRCLE_DISTANCE = 280;
const MAX_VISIBLE_CARDS = 3;

let activeCards = [];
let selectedLatLng = null;
let currentClusterRows = null;

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Safe lat/lng formatter — handles null/undefined/NaN without throwing
function fmtCoords(row, decimals = 5) {
  const lat = (typeof row.latitude === 'number' && Number.isFinite(row.latitude)) ? row.latitude : null;
  const lng = (typeof row.longitude === 'number' && Number.isFinite(row.longitude)) ? row.longitude : null;
  if (lat == null || lng == null) return '—';
  return `${lat.toFixed(decimals)}, ${lng.toFixed(decimals)}`;
}

function buildCardElement() {
  const card = document.createElement('aside');
  card.className = 'detail-panel loading clickable';
  card.setAttribute('aria-hidden', 'false');
  card.innerHTML = `
    <button class="detail-close" aria-label="Close detail">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
    <div class="loading-content">
      <div class="spinner"></div>
      <span>Loading information…</span>
    </div>
    <div class="detail-photo-wrap"><img class="detail-photo" alt="" /></div>
    <div class="detail-body">
      <div class="detail-header">
        <span class="severity-badge"></span>
        <span class="detail-confidence"></span>
      </div>
      <div class="detail-tags"></div>
      <p class="detail-address"></p>
      <p class="detail-description"></p>
      <dl class="detail-meta"></dl>
    </div>
  `;
  card.querySelector('.detail-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hideCards();
  });
  cardStack.appendChild(card);
  cardResizeObserver.observe(card);
  return card;
}

function attachExpandHandler(cardEl, row) {
  cardEl.addEventListener('click', (e) => {
    if (e.target.closest('.detail-close')) return;
    if (cardEl.classList.contains('loading')) return;
    showExpandedCard(row);
  });
}

function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildExpandedHTML(row) {
  const types = effectiveTypes(row);
  const severity = effectiveSeverity(row);
  const conf = effectiveConfidence(row);

  const reviewerTypes = Array.isArray(row.expert_corrected_types) && row.expert_corrected_types.length
    ? row.expert_corrected_types : null;

  const tagChips = types.length
    ? types.map(t => `<span class="detail-tag" style="background:${DISTRESS_COLORS[t] || UNKNOWN_COLOR}">${escapeHTML(t)}</span>`).join('')
    : `<span class="detail-tag" style="background:${UNKNOWN_COLOR}">Normal</span>`;

  let html = `
    <button class="detail-close" aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
    <div class="expanded-photo-wrap">
      <img class="expanded-photo" src="${escapeHTML(row.image_url || '')}" alt="" />
    </div>
    <div class="expanded-body">
      <div class="expanded-tags">
        <span class="severity-badge" data-severity="${escapeHTML(severity)}">${escapeHTML(severity)}</span>
        ${conf ? `<span class="detail-confidence">${Math.round(conf * 100)}% confidence</span>` : ''}
      </div>
      <div class="detail-tags">${tagChips}</div>
      <h2 class="expanded-title">${escapeHTML(row.address || `${fmtCoords(row)}`)}</h2>
      ${row.description ? `<p class="expanded-description">${escapeHTML(row.description)}</p>` : ''}
  `;

  // AI classification
  const aiRows = [];
  if (row.stage1_label) aiRows.push(['Stage 1', `${row.stage1_label}${row.stage1_confidence != null ? ` · ${(row.stage1_confidence * 100).toFixed(1)}%` : ''}`]);
  if (row.is_distressed != null) aiRows.push(['Is distressed', row.is_distressed ? 'Yes' : 'No']);
  if (row.stage2_confidence != null) aiRows.push(['Stage 2 confidence', `${(row.stage2_confidence * 100).toFixed(1)}%`]);
  if (aiRows.length) {
    html += `<div class="expanded-section">
      <div class="expanded-section-title">AI classification</div>
      <dl class="expanded-meta">
        ${aiRows.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join('')}
      </dl>
    </div>`;
  }

  // Expert review
  if (row.needs_expert_review || row.expert_reviewed || reviewerTypes || row.expert_corrected_severity || row.expert_notes) {
    const expertRows = [
      ['Needs review', row.needs_expert_review ? 'Yes' : 'No'],
      ['Reviewed', row.expert_reviewed ? 'Verified' : 'Not yet'],
    ];
    if (reviewerTypes) expertRows.push(['Corrected types', reviewerTypes.join(', ')]);
    if (row.expert_corrected_severity) expertRows.push(['Corrected severity', row.expert_corrected_severity]);
    if (row.expert_notes) expertRows.push(['Notes', row.expert_notes]);
    html += `<div class="expanded-section">
      <div class="expanded-section-title">Expert review</div>
      <dl class="expanded-meta">
        ${expertRows.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join('')}
      </dl>
    </div>`;
  }

  // Metadata
  const metaRows = [];
  if (row.status) metaRows.push(['Status', row.status]);
  // Capture time = when the citizen actually took the photo (created_at on the
  // assessment row matches the photo-upload timestamp). This is the timeline
  // users care about most, so it's shown first.
  if (row.created_at) {
    metaRows.push(['Captured', formatDate(row.created_at)]);
  }
  if (row.processed_at && row.processed_at !== row.created_at) {
    metaRows.push(['AI processed', formatDate(row.processed_at)]);
  }
  metaRows.push(['Coordinates', `${fmtCoords(row)}`]);
  if (row.image_width && row.image_height) metaRows.push(['Image', `${row.image_width} × ${row.image_height}`]);
  if (row.photo_id != null) metaRows.push(['Photo ID', row.photo_id]);
  if (row.road_segment_id) metaRows.push(['Road segment', row.road_segment_id]);
  html += `<div class="expanded-section">
    <div class="expanded-section-title">Metadata</div>
    <dl class="expanded-meta">
      ${metaRows.map(([k, v]) => `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`).join('')}
    </dl>
  </div>`;

  html += `</div>`; // close expanded-body
  return html;
}

function showExpandedCard(row) {
  // Fade out existing cards
  cardConnectors.classList.remove('active');
  for (const { el } of activeCards) {
    el.classList.remove('open');
    try { cardResizeObserver.unobserve(el); } catch (_) {}
  }
  const closing = activeCards;
  activeCards = [];

  setTimeout(() => {
    for (const { el } of closing) el.remove();
    while (cardConnectors.firstChild) cardConnectors.removeChild(cardConnectors.firstChild);

    const card = document.createElement('aside');
    card.className = 'detail-panel expanded loading';
    card.setAttribute('aria-hidden', 'false');
    card.innerHTML = `
      <button class="detail-close" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      <div class="loading-content">
        <div class="spinner"></div>
        <span>Loading details…</span>
      </div>
    `;
    card.querySelector('.detail-close').addEventListener('click', hideCards);
    cardStack.appendChild(card);
    cardResizeObserver.observe(card);

    activeCards.push({ el: card, row, kind: 'expanded' });
    positionExpandedCard(card);
    void cardStack.offsetWidth;

    requestAnimationFrame(() => {
      card.classList.add('open');

      setTimeout(() => {
        card.innerHTML = buildExpandedHTML(row);
        card.querySelector('.detail-close').addEventListener('click', hideCards);
        card.classList.remove('loading');
        positionExpandedCard(card);
        // After layout settles, position again
        setTimeout(() => positionExpandedCard(card), 50);
      }, 2000);
    });
  }, 400);
}

function positionExpandedCard(card) {
  if (!selectedLatLng) return;
  const point = map.latLngToContainerPoint(selectedLatLng);
  const cardW = card.offsetWidth;
  const cardH = card.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Try right of marker, fallback to left, fallback to clamp
  let left = point.x + SINGLE_DISTANCE;
  let flipLeft = false;
  if (left + cardW + CARD_EDGE_PADDING > vw) {
    const tryLeft = point.x - SINGLE_DISTANCE - cardW;
    if (tryLeft >= CARD_EDGE_PADDING) {
      left = tryLeft;
      flipLeft = true;
    } else {
      left = vw - cardW - CARD_EDGE_PADDING;
    }
  }
  card.classList.toggle('flip-left', flipLeft);

  let top = point.y - cardH / 2;
  top = Math.max(CARD_EDGE_PADDING, Math.min(top, vh - cardH - CARD_EDGE_PADDING));
  left = Math.max(CARD_EDGE_PADDING, left);

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;

  drawCardConnectors(point);
}

function triggerRadarPulse(point) {
  const NS = 'http://www.w3.org/2000/svg';
  cardConnectors.classList.add('active');
  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      const ring = document.createElementNS(NS, 'circle');
      ring.setAttribute('cx', point.x);
      ring.setAttribute('cy', point.y);
      ring.setAttribute('r', 8);
      ring.setAttribute('class', 'radar-ring');
      // Insert at start so radar sits behind connector lines/dots
      cardConnectors.insertBefore(ring, cardConnectors.firstChild);
      setTimeout(() => ring.remove(), 1500);
    }, i * 320);
  }
}

function populateCard(card, row) {
  const types = effectiveTypes(row);
  const severity = effectiveSeverity(row);

  const photo = card.querySelector('.detail-photo');
  photo.src = row.image_url || '';
  photo.alt = (types[0] || 'Pavement assessment') + (row.address ? ` near ${row.address}` : '');

  const sevBadge = card.querySelector('.severity-badge');
  sevBadge.textContent = severity;
  sevBadge.dataset.severity = severity;

  const conf = effectiveConfidence(row);
  card.querySelector('.detail-confidence').textContent = conf ? `${Math.round(conf * 100)}% confidence` : '';

  const tagsEl = card.querySelector('.detail-tags');
  tagsEl.innerHTML = '';
  if (!types.length) {
    const chip = document.createElement('span');
    chip.className = 'detail-tag';
    chip.textContent = 'Normal';
    chip.style.background = UNKNOWN_COLOR;
    tagsEl.appendChild(chip);
  } else {
    for (const t of types) {
      const chip = document.createElement('span');
      chip.className = 'detail-tag';
      chip.textContent = t;
      chip.style.background = DISTRESS_COLORS[t] || UNKNOWN_COLOR;
      tagsEl.appendChild(chip);
    }
  }

  card.querySelector('.detail-address').textContent =
    row.address || fmtCoords(row);

  const desc = card.querySelector('.detail-description');
  desc.textContent = row.description || '';
  desc.style.display = row.description ? '' : 'none';

  const meta = card.querySelector('.detail-meta');
  meta.innerHTML = '';
  const metaRows = [
    ['Captured', formatDate(row.created_at || row.processed_at)],
    ['Coordinates', fmtCoords(row)],
  ];
  if (row.expert_reviewed) metaRows.push(['Review', 'Verified by expert']);
  for (const [k, v] of metaRows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    meta.appendChild(dt); meta.appendChild(dd);
  }
}

function computeCircleAngles(n) {
  if (n === 1) return [0];
  const angles = [];
  const step = 360 / n;
  const start = -90 + step / 2;
  for (let i = 0; i < n; i++) angles.push(start + i * step);
  return angles;
}

function showCards(rows) {
  hideCards();
  if (!rows.length) return;

  // Any marker/location click closes the About panel and resets nav to Map
  // Any marker/location click closes the About + Filter panels and resets
  // the nav to Map — so opening a card always brings you back to the map view.
  const aboutOpen = aboutStack && aboutStack.classList.contains('open');
  const filterOpen = filterStack && filterStack.classList.contains('open');
  if (aboutOpen || filterOpen) {
    if (aboutOpen) closeAboutStack();
    if (filterOpen) closeFilterStack();
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    const mapNav = document.querySelector('.nav-item[data-page="map"]');
    if (mapNav) mapNav.classList.add('active');
  }

  selectedLatLng = [rows[0].latitude, rows[0].longitude];
  currentClusterRows = rows;

  const sorted = [...rows].sort((a, b) =>
    (rowTypeRank(b) - rowTypeRank(a)) || (rowSeverityRank(b) - rowSeverityRank(a))
  );

  const showViewMore = sorted.length > MAX_VISIBLE_CARDS;
  const visibleCount = showViewMore ? MAX_VISIBLE_CARDS : sorted.length;
  const totalSlots = visibleCount + (showViewMore ? 1 : 0);
  const angles = computeCircleAngles(totalSlots);

  for (let i = 0; i < visibleCount; i++) {
    const card = buildCardElement();
    populateCard(card, sorted[i]);
    attachExpandHandler(card, sorted[i]);
    card.dataset.angle = angles[i];
    activeCards.push({ el: card, row: sorted[i], kind: 'card' });
  }

  if (showViewMore) {
    const moreBtn = buildViewMoreElement(sorted.length - visibleCount, sorted);
    moreBtn.dataset.angle = angles[totalSlots - 1];
    activeCards.push({ el: moreBtn, row: null, kind: 'more' });
  }

  map.flyTo(selectedLatLng, Math.max(map.getZoom(), 19), {
    duration: 1.1,
    easeLinearity: 0.25,
  });

  // Radar pulse from the marker pixel position
  const anchorPoint = map.latLngToContainerPoint(selectedLatLng);
  triggerRadarPulse(anchorPoint);

  positionAllCards();
  void cardStack.offsetWidth;
  requestAnimationFrame(() => {
    cardConnectors.classList.add('active');
    activeCards.forEach(({ el, kind }, i) => {
      setTimeout(() => el.classList.add('open'), i * 80);
      // After 2s, reveal full card content from loading pill
      if (kind === 'card') {
        setTimeout(() => {
          el.classList.remove('loading');
          requestAnimationFrame(() => positionAllCards());
        }, 2000 + i * 80);
      }
    });
  });
}

function buildViewMoreElement(extraCount, allRows) {
  const btn = document.createElement('button');
  btn.className = 'detail-panel view-more';
  btn.setAttribute('aria-label', `View ${extraCount} more`);
  btn.innerHTML = `
    <span class="corner tl"></span><span class="corner tr"></span>
    <span class="corner bl"></span><span class="corner br"></span>
    <div class="view-more-body">
      <div class="view-more-stack">
        ${allRows.slice(0, 3).map(r => `<span class="vm-dot" style="background:${colorForTypes(effectiveTypes(r))}"></span>`).join('')}
      </div>
      <div class="view-more-label">+${extraCount} more</div>
      <div class="view-more-sub">View all ${allRows.length}</div>
    </div>
  `;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    showListView(allRows);
  });
  cardStack.appendChild(btn);
  cardResizeObserver.observe(btn);
  return btn;
}

function buildListElement(rows) {
  const card = document.createElement('aside');
  card.className = 'detail-panel list-card';
  card.setAttribute('aria-hidden', 'false');
  card.innerHTML = `
    <span class="corner tl"></span><span class="corner tr"></span>
    <span class="corner bl"></span><span class="corner br"></span>
    <button class="detail-close" aria-label="Close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
    <div class="list-header">
      <div class="list-title">${rows.length} assessments at this location</div>
      <div class="list-sub">Click any to inspect</div>
    </div>
    <div class="list-rows"></div>
  `;
  const rowsContainer = card.querySelector('.list-rows');
  rows.forEach((row) => {
    const types = effectiveTypes(row);
    const severity = effectiveSeverity(row);
    const conf = effectiveConfidence(row);
    const item = document.createElement('button');
    item.className = 'list-row';
    item.innerHTML = `
      <img class="list-thumb" alt="" src="${row.image_url || ''}" />
      <div class="list-text">
        <div class="list-row-top">
          <span class="severity-badge" data-severity="${severity}">${severity}</span>
          ${types.length ? types.map(t => `<span class="list-type" style="background:${DISTRESS_COLORS[t] || UNKNOWN_COLOR}">${t.split(' (')[0]}</span>`).join('') : '<span class="list-type" style="background:'+UNKNOWN_COLOR+'">Normal</span>'}
        </div>
        <div class="list-row-bot">
          <span class="list-addr">${row.address || 'No address'}</span>
          ${conf ? `<span class="list-conf">${Math.round(conf * 100)}%</span>` : ''}
        </div>
      </div>
    `;
    item.addEventListener('click', () => {
      hideCards();
      setTimeout(() => showCards([row]), 50);
    });
    rowsContainer.appendChild(item);
  });
  card.querySelector('.detail-close').addEventListener('click', hideCards);
  cardStack.appendChild(card);
  cardResizeObserver.observe(card);
  return card;
}

function showListView(rows) {
  cardConnectors.classList.remove('active');
  for (const { el } of activeCards) {
    el.classList.remove('open');
    try { cardResizeObserver.unobserve(el); } catch (_) {}
  }
  const closing = activeCards;
  activeCards = [];

  setTimeout(() => {
    for (const { el } of closing) el.remove();
    while (cardConnectors.firstChild) cardConnectors.removeChild(cardConnectors.firstChild);

    const list = buildListElement(rows);
    list.dataset.angle = 0;
    list.classList.add('list-card');
    activeCards.push({ el: list, row: null, kind: 'list' });
    positionAllCards();
    void cardStack.offsetWidth;
    requestAnimationFrame(() => {
      cardConnectors.classList.add('active');
      list.classList.add('open');
    });
  }, 400);
}

function hideCards() {
  if (!activeCards.length) {
    while (cardConnectors.firstChild) cardConnectors.removeChild(cardConnectors.firstChild);
    return;
  }
  cardConnectors.classList.remove('active');
  const closing = activeCards;
  activeCards = [];
  selectedLatLng = null;
  for (const { el } of closing) {
    el.classList.remove('open');
    // Stop watching this card's size — without this, removed cards keep
    // firing the observer callback and trigger phantom positionAllCards calls.
    try { cardResizeObserver.unobserve(el); } catch (_) {}
  }
  setTimeout(() => {
    for (const { el } of closing) el.remove();
    // Clear connector lines AND any in-flight radar rings so old animations
    // don't carry over to the next selection.
    while (cardConnectors.firstChild) cardConnectors.removeChild(cardConnectors.firstChild);
  }, 600);
}

function positionAllCards() {
  if (!selectedLatLng || activeCards.length === 0) return;

  // Expanded card uses its own marker-anchored positioning
  if (activeCards.length === 1 && activeCards[0].kind === 'expanded') {
    positionExpandedCard(activeCards[0].el);
    return;
  }

  const point = map.latLngToContainerPoint(selectedLatLng);
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const n = activeCards.length;
  const isList = n === 1 && activeCards[0].kind === 'list';
  const distance = isList ? SINGLE_DISTANCE :
                   n === 1 ? SINGLE_DISTANCE :
                   n <= 3 ? FAN_DISTANCE :
                   CIRCLE_DISTANCE;

  for (const { el } of activeCards) {
    const angleDeg = parseFloat(el.dataset.angle || '0');
    const angleRad = (angleDeg * Math.PI) / 180;
    const cardW = el.offsetWidth;
    const cardH = el.offsetHeight;

    const dx = Math.cos(angleRad) * distance;
    const dy = Math.sin(angleRad) * distance;
    const cardCenterX = point.x + dx;
    const cardCenterY = point.y + dy;

    const placeRight = cardCenterX >= point.x;
    el.classList.toggle('flip-left', !placeRight);

    let left = placeRight ? cardCenterX : (cardCenterX - cardW);
    let top = cardCenterY - cardH / 2;

    left = Math.max(CARD_EDGE_PADDING, Math.min(left, vw - cardW - CARD_EDGE_PADDING));
    top = Math.max(CARD_EDGE_PADDING, Math.min(top, vh - cardH - CARD_EDGE_PADDING));

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  drawCardConnectors(point);
}

function drawCardConnectors(anchorPoint) {
  while (cardConnectors.firstChild) cardConnectors.removeChild(cardConnectors.firstChild);
  const NS = 'http://www.w3.org/2000/svg';

  for (const { el } of activeCards) {
    const rect = el.getBoundingClientRect();
    const cx = anchorPoint.x;
    const cy = anchorPoint.y;

    // Skip if marker overlaps the card
    const inside =
      cx >= rect.left - 2 && cx <= rect.right + 2 &&
      cy >= rect.top - 2 && cy <= rect.bottom + 2;
    if (inside) continue;

    // Nearest point on the card's bounding rectangle
    const nearestX = Math.max(rect.left, Math.min(cx, rect.right));
    const nearestY = Math.max(rect.top, Math.min(cy, rect.bottom));

    // Pull the endpoint back by an 8px gap so the line floats just short of the card
    const dx = nearestX - cx;
    const dy = nearestY - cy;
    const len = Math.hypot(dx, dy);
    if (len < 22) continue;          // too short to look intentional
    const gap = 8;
    const t = (len - gap) / len;
    const x2 = cx + dx * t;
    const y2 = cy + dy * t;

    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', cx);
    line.setAttribute('y1', cy);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    cardConnectors.appendChild(line);
  }

  // Continuous pulse ring (stays while card is open — high-visibility "this is the dot")
  const pulseRing = document.createElementNS(NS, 'circle');
  pulseRing.setAttribute('cx', anchorPoint.x);
  pulseRing.setAttribute('cy', anchorPoint.y);
  pulseRing.setAttribute('r', 7);
  pulseRing.setAttribute('class', 'pulse-ring');
  cardConnectors.appendChild(pulseRing);

  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('cx', anchorPoint.x);
  ring.setAttribute('cy', anchorPoint.y);
  ring.setAttribute('r', 10);
  ring.setAttribute('class', 'anchor-ring');
  cardConnectors.appendChild(ring);

  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', anchorPoint.x);
  dot.setAttribute('cy', anchorPoint.y);
  dot.setAttribute('r', 4);
  dot.setAttribute('class', 'anchor-dot');
  cardConnectors.appendChild(dot);
}

map.on('move zoom resize', positionAllCards);
window.addEventListener('resize', positionAllCards);

// Track every card's size changes (loading→expanded transition, content swap).
// Without this, connector lines stay anchored to the card's old dimensions until
// the user pans/zooms the map, which forces a redraw.
let _resizeRAF = null;
const cardResizeObserver = new ResizeObserver(() => {
  if (_resizeRAF) cancelAnimationFrame(_resizeRAF);
  _resizeRAF = requestAnimationFrame(() => {
    _resizeRAF = null;
    positionAllCards();
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeCards.length) hideCards();
});

/* ---------- Nav pill (icon → icon+label active state) ---------- */

const aboutStack = document.getElementById('aboutStack');
const filterStack = document.getElementById('filterStack');

function openAboutStack() {
  aboutStack.classList.add('open');
  aboutStack.setAttribute('aria-hidden', 'false');
  document.body.classList.add('about-open');
}

function closeAboutStack() {
  aboutStack.classList.remove('open');
  aboutStack.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('about-open');
}
const filterRoot = document.getElementById('filterRoot');
const filterIssues = document.getElementById('filterIssues');
const filterIssuesList = document.getElementById('filterIssuesList');
const filterSeverity = document.getElementById('filterSeverity');
const filterLocations = document.getElementById('filterLocations');
const filterLocationsTitle = document.getElementById('filterLocationsTitle');
const filterLocationsList = document.getElementById('filterLocationsList');

function openFilterStack() {
  filterStack.classList.add('open');
  filterStack.setAttribute('aria-hidden', 'false');
}

function closeFilterStack() {
  filterStack.classList.remove('open');
  filterStack.setAttribute('aria-hidden', 'true');
  filterIssues.hidden = true;
  filterSeverity.hidden = true;
  filterTime.hidden = true;
  filterLocations.hidden = true;
  filterRoot.querySelectorAll('.filter-option').forEach(b => b.classList.remove('active'));
  filterSeverity.querySelectorAll('.filter-option').forEach(b => b.classList.remove('active'));
  filterTime.querySelectorAll('.filter-option').forEach(b => b.classList.remove('active'));
}

function setFilterRootActive(filter) {
  filterRoot.querySelectorAll('.filter-option').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
}

function showFilterIssues() {
  setFilterRootActive('issues');
  filterIssues.hidden = false;
  filterSeverity.hidden = true;
  filterTime.hidden = true;
  filterLocations.hidden = true;

  // Aggregate every upload by address (no classification filter — count all rows)
  const byAddress = new Map();
  for (const row of allMergedRows) {
    if (row.latitude == null || row.longitude == null) continue;
    const addr = row.address || fmtCoords(row, 4);
    if (!byAddress.has(addr)) {
      byAddress.set(addr, { count: 0, rows: [], lat: row.latitude, lng: row.longitude });
    }
    const entry = byAddress.get(addr);
    entry.count += 1;
    entry.rows.push(row);
  }

  const sorted = [...byAddress.entries()].sort((a, b) => b[1].count - a[1].count);

  filterIssuesList.innerHTML = '';
  if (!sorted.length) {
    const empty = document.createElement('div');
    empty.className = 'filter-list-item';
    empty.style.justifyContent = 'center';
    empty.style.color = 'var(--muted)';
    empty.textContent = 'No distress data yet';
    filterIssuesList.appendChild(empty);
    return;
  }
  for (const [addr, data] of sorted) {
    const item = document.createElement('button');
    item.className = 'filter-list-item';
    item.innerHTML = `
      <span class="label">${escapeHTML(addr)}</span>
      <span class="count">${data.count}</span>
    `;
    item.addEventListener('click', () => goToLocationFromFilter(data.rows));
    filterIssuesList.appendChild(item);
  }
}

function showFilterSeverity() {
  setFilterRootActive('severity');
  filterIssues.hidden = true;
  filterSeverity.hidden = false;
  filterTime.hidden = true;
  filterLocations.hidden = true;
  // Mirror the active filter state onto the buttons so the user sees what's
  // currently locked in when re-opening the panel.
  filterSeverity.querySelectorAll('.filter-option').forEach(b => {
    b.classList.toggle('active', b.dataset.severity === activeSeverityFilter);
  });
}

function showFilterTime() {
  setFilterRootActive('time');
  filterIssues.hidden = true;
  filterSeverity.hidden = true;
  filterTime.hidden = false;
  filterLocations.hidden = true;
  filterTime.querySelectorAll('.filter-option').forEach(b => {
    b.classList.toggle('active', b.dataset.time === activeTimeFilter);
  });
}

function setSeverityActive(level) {
  filterSeverity.querySelectorAll('.filter-option').forEach(b => {
    b.classList.toggle('active', b.dataset.severity === level);
  });
}

function showSeverityLocations(level) {
  setSeverityActive(level);
  filterLocations.hidden = false;

  // Apply persistent severity filter to the map (skip for "all")
  setSeverityFilter(level === 'all' ? null : level);

  const SEV_RANK = { High: 3, Medium: 2, Low: 1, None: 0, Unknown: 0 };
  const LABELS = { Low: 'Less', Medium: 'Moderate', High: 'Red Alert' };

  let filtered;
  let title;
  if (level === 'all') {
    title = 'All locations';
    filtered = [...allMergedRows]
      .filter(r => r.latitude != null && r.longitude != null)
      .sort((a, b) => (SEV_RANK[effectiveSeverity(b)] || 0) - (SEV_RANK[effectiveSeverity(a)] || 0));
  } else {
    title = `${LABELS[level]} severity`;
    filtered = allMergedRows.filter(r => effectiveSeverity(r) === level && r.latitude != null && r.longitude != null);
  }

  filterLocationsTitle.textContent = title;
  filterLocationsList.innerHTML = '';

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'filter-list-item';
    empty.style.justifyContent = 'center';
    empty.style.color = 'var(--muted)';
    empty.textContent = 'No matches';
    filterLocationsList.appendChild(empty);
    return;
  }

  for (const row of filtered) {
    const sev = effectiveSeverity(row);
    const sevColor = SEVERITY_COLOR[sev] || UNKNOWN_COLOR;
    const types = effectiveTypes(row);
    const primary = pickPrimaryType(types);
    const addr = row.address || fmtCoords(row, 4);

    const item = document.createElement('button');
    item.className = 'filter-list-item';
    item.innerHTML = `
      <span class="severity-dot" style="background:${sevColor}"></span>
      <span class="label">${escapeHTML(addr)}</span>
      <span class="meta">${escapeHTML(primary ? primary.replace(/\s*\([^)]*\)\s*$/, '') : 'Normal')}</span>
    `;
    item.addEventListener('click', () => goToLocationFromFilter([row], level));
    filterLocationsList.appendChild(item);
  }
}

function goToLocationFromFilter(rows, severityFilter = null) {
  if (!rows || !rows.length) return;
  const first = rows[0];
  if (first.latitude == null || first.longitude == null) return;

  // Find the cluster of rows at this location (matches what a cluster marker click would do)
  const latStep = CLUSTER_RADIUS_M / 111320;
  const cosLat = Math.cos((first.latitude * Math.PI) / 180);
  const lngStep = CLUSTER_RADIUS_M / (111320 * Math.max(0.01, cosLat));
  const targetLatCell = Math.round(first.latitude / latStep);
  const targetLngCell = Math.round(first.longitude / lngStep);

  let groupRows = allMergedRows.filter(r => {
    if (r.latitude == null || r.longitude == null) return false;
    return Math.round(r.latitude / latStep) === targetLatCell &&
           Math.round(r.longitude / lngStep) === targetLngCell;
  });

  // If user came from a specific severity filter, pre-filter the cluster
  // so they see only matching cards directly (no "View more" needed)
  if (severityFilter && severityFilter !== 'all') {
    const filtered = groupRows.filter(r => effectiveSeverity(r) === severityFilter);
    if (filtered.length) groupRows = filtered;
  }

  // Close any open panels and switch the nav back to Map
  closeFilterStack();
  closeAboutStack();
  document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
  const mapNav = document.querySelector('.nav-item[data-page="map"]');
  if (mapNav) mapNav.classList.add('active');

  // showCards handles flyTo, radar pulse, loading spinner, then full card
  showCards(groupRows.length ? groupRows : rows);
}

filterRoot.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  if (btn.dataset.filter === 'issues') showFilterIssues();
  else if (btn.dataset.filter === 'severity') showFilterSeverity();
  else if (btn.dataset.filter === 'time') showFilterTime();
});

const filterTime = document.getElementById('filterTime');
filterTime.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-time]');
  if (!btn) return;
  setTimeFilter(btn.dataset.time === 'all' ? null : btn.dataset.time);
  // Mirror active state inside the card
  filterTime.querySelectorAll('.filter-option').forEach(b => {
    b.classList.toggle('active', b.dataset.time === btn.dataset.time);
  });
});

function setTimeFilter(level) {
  activeTimeFilter = (level === 'day' || level === 'night') ? level : null;

  if (activeTimeFilter) {
    timePillLabel.textContent = activeTimeFilter === 'day' ? 'Day' : 'Night';
    timePillDot.style.background = activeTimeFilter === 'day' ? '#facc15' : '#1A1A1C';
    timePill.hidden = false;
    requestAnimationFrame(() => {
      positionSeverityPill();
      timePill.classList.add('show');
    });
    // Filter locked — collapse cards and reset nav
    closeFilterStack();
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    const mapNav = document.querySelector('.nav-item[data-page="map"]');
    if (mapNav) mapNav.classList.add('active');
  } else {
    timePill.classList.remove('show');
    setTimeout(() => { timePill.hidden = true; positionSeverityPill(); }, 350);
    filterTime.querySelectorAll('.filter-option').forEach(b => b.classList.remove('active'));
  }
  renderAssessments(allMergedRows);
}

timePillClose.addEventListener('click', (e) => {
  e.stopPropagation();
  setTimeFilter(null);
});

filterSeverity.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-severity]');
  if (!btn) return;
  showSeverityLocations(btn.dataset.severity);
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    item.classList.add('active');

    if (item.dataset.page === 'filters') {
      closeAboutStack();
      openFilterStack();
    } else if (item.dataset.page === 'about') {
      closeFilterStack();
      openAboutStack();
    } else {
      closeFilterStack();
      closeAboutStack();
    }
  });
});

loadAssessments();
