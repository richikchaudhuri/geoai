const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const source = readFileSync(path.join(root, 'app.js'), 'utf8');
const photo = { id: 'p1', latitude: 12.97, longitude: 77.59, image_url: 'https://example.com/photo.jpg', created_at: '2026-04-01T06:00:00Z' };
const assessment = { ...photo, id: 'a1', photo_id: 'p1', status: 'classified', severity: 'Low', distress_types: ['Pothole (D40)'] };

async function boot(t, options = {}) {
  const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.console = { log() {}, warn() {}, error() {} };
  let now = 0;
  let nextTimer = 0;
  const timers = new Map();
  w.setTimeout = (fn, delay = 0) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; };
  w.clearTimeout = id => timers.delete(id);
  w.requestAnimationFrame = fn => w.setTimeout(fn, 16);
  w.cancelAnimationFrame = w.clearTimeout;
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const markers = [];
  const tiles = [];
  const layer = () => ({
    addTo() { return this; }, once() { return this; }, on() { return this; }, bindTooltip() { return this; },
    clearLayers() { markers.length = 0; },
  });
  const map = { ...layer(), setView() { return this; }, removeLayer() {}, flyTo() {}, flyToBounds() {}, getZoom: () => 19, latLngToContainerPoint: () => ({ x: 200, y: 200 }) };
  w.L = {
    map: () => map, control: { zoom: layer }, layerGroup: layer,
    tileLayer: url => { tiles.push(url); return layer(); },
    circleMarker: (point, style) => { markers.push({ point, style }); return layer(); },
    marker: point => { markers.push({ point }); return layer(); },
    divIcon: x => x, rectangle: layer,
  };
  if (options.cache) w.localStorage.setItem('geoai:dataCache:v4', JSON.stringify({ data: options.cache, timestamp: Date.now() - 11 * 60 * 1000 }));
  if (options.style) w.localStorage.setItem('mapStyle', options.style);
  if (options.storageDisabled) Object.defineProperty(w, 'localStorage', { get() { throw new Error('Storage disabled'); } });
  const tables = options.tables || { photos: [photo], assessments: [assessment] };
  const requests = [];
  if (!options.noSupabase) {
    w.supabase = { createClient: () => ({ from(table) {
      return { select() { return this; }, order() { return this; }, async range(start, end) {
        requests.push({ table, start, end });
        if (table === options.errorTable) return { data: null, error: new Error('Temporary failure') };
        if (options.repeatPage) return { data: tables[table].slice(0, 1), error: null };
        return { data: tables[table].slice(start, Math.min(end + 1, start + (options.cap || 1000))), error: null };
      } };
    } }) };
  }
  w.fetch = options.fetch || (async url => {
    assert.equal(url, 'data/snapshot.json', 'tests must not contact production');
    return { ok: true, json: async () => ({ photos: [photo], assessments: [assessment] }) };
  });
  const context = dom.getInternalVMContext();
  vm.runInContext(source.replace(/loadAssessments\(\);\s*$/, 'window.initialLoad = loadAssessments();'), context);
  await w.initialLoad;
  return { w, advance, markers, requests, tiles, read: code => vm.runInContext(code, context) };
}

test('blocked browser storage and missing Supabase SDK still load the snapshot', async t => {
  const app = await boot(t, { storageDisabled: true, noSupabase: true });
  assert.equal(app.read('allMergedRows.length'), 1);
  assert.equal(app.markers.length, 1);
  assert.equal(app.tiles.length, 1);
});

test('unknown saved map style falls back to the default basemap', async t => {
  const app = await boot(t, { style: 'obsolete-style' });
  assert.match(app.tiles[0], /light_all/);
});

test('pagination follows actual response size when the server caps pages', async t => {
  const app = await boot(t, { cap: 1, tables: { photos: [photo, { ...photo, id: 'p2', image_url: 'https://example.com/two.jpg' }], assessments: [assessment] } });
  assert.deepEqual(app.requests.filter(r => r.table === 'photos').map(r => r.start), [0, 1, 2]);
  assert.equal(app.read('allMergedRows.length'), 2);
});

test('one failed table uses a consistent snapshot instead of caching partial live data', async t => {
  const app = await boot(t, { errorTable: 'assessments' });
  assert.equal(app.read('allMergedRows[0].severity'), 'Low');
  assert.equal(app.read('Cache.read()'), null);
});

test('repeated IDs across live pages use the snapshot instead of duplicated data', async t => {
  const app = await boot(t, { repeatPage: true });
  assert.equal(app.read('allMergedRows.length'), 1);
  assert.equal(app.read('Cache.read()'), null);
});

test('same-count background refresh updates changed severity and description', async t => {
  const app = await boot(t, { cache: [{ ...assessment, severity: 'High', description: 'old' }] });
  assert.equal(app.read('allMergedRows[0].severity'), 'Low');
  assert.match(app.w.document.getElementById('status').textContent, /refreshed/);
});

test('newest assessment wins and older linked/legacy assessments do not duplicate photos', async t => {
  const app = await boot(t, { tables: { photos: [photo], assessments: [assessment, { ...assessment, id: 'older', severity: 'High' }, { ...assessment, id: 'legacy', photo_id: null }] } });
  assert.equal(app.read('allMergedRows.length'), 1);
  assert.equal(app.read('allMergedRows[0].id'), 'a1');
});

test('photos sharing an image URL do not borrow another photo\'s assessment', async t => {
  const app = await boot(t, { tables: { photos: [photo, { ...photo, id: 'p2' }], assessments: [assessment] } });
  assert.equal(app.read('allMergedRows[0].id'), 'a1');
  assert.equal(app.read('allMergedRows[1].status'), 'pending');
});

test('invalid assessment GPS falls back to the complete photo coordinate pair', async t => {
  const app = await boot(t, { tables: { photos: [photo], assessments: [{ ...assessment, latitude: 999, longitude: 80 }] } });
  assert.equal(app.read('allMergedRows[0].latitude'), photo.latitude);
  assert.equal(app.read('allMergedRows[0].longitude'), photo.longitude);
  assert.equal(app.markers.length, 1);
});

test('unreviewed stale corrections do not override the current model result', async t => {
  const app = await boot(t);
  assert.equal(app.read('effectiveTypes({ expert_reviewed: false, expert_corrected_types: ["old"], distress_types: ["new"] })[0]'), 'new');
  assert.equal(app.read('effectiveSeverity({ expert_reviewed: false, expert_corrected_severity: "High", severity: "Low" })'), 'Low');
});

test('empty expert correction clears old distress types and zero confidence stays zero', async t => {
  const app = await boot(t);
  assert.equal(app.read('effectiveTypes({ expert_reviewed: true, expert_corrected_types: [], distress_types: ["Pothole (D40)"] }).length'), 0);
  assert.equal(app.read('effectiveConfidence({ stage2_confidence: 0, stage1_confidence: 0.98 })'), 0);
});

test('invalid coordinates are excluded while the equator and prime meridian remain valid', async t => {
  const app = await boot(t);
  assert.equal(app.read('clusterRows([{latitude: NaN, longitude: 1}, {latitude: 91, longitude: 1}, {latitude: 0, longitude: 0}]).length'), 1);
  assert.equal(app.read('isDaytime("2026-04-01T12:00:00Z", NaN, 1)'), null);
});

test('day/night classification wraps correctly across UTC midnight', async t => {
  const app = await boot(t);
  assert.equal(app.read('isDaytime("2026-03-20T23:00:00Z", 0, 170)'), true);
  assert.equal(app.read('isDaytime("2026-03-20T01:00:00Z", 0, -170)'), true);
  assert.equal(app.read('isDaytime("2026-03-20T12:00:00Z", 0, 170)'), false);
});

test('list cards render remote text as text without injected markup or attributes', async t => {
  const app = await boot(t);
  const card = app.w.buildListElement([{ ...assessment, address: '<img src=x onerror=alert(1)>', severity: '\" onmouseover=alert(1)', image_url: 'x\" onerror=alert(1)', distress_types: ['<svg onload=alert(1)>'] }]);
  assert.equal(card.querySelectorAll('[onerror], [onload], [onmouseover]').length, 0);
  assert.equal(card.querySelector('.list-addr').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(card.querySelector('.list-type').textContent, '<svg onload=alert(1)>');
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('slow search JSON cannot overwrite newer search results', async t => {
  const app = await boot(t);
  const oldJSON = deferred();
  app.w.fetch = async url => ({ ok: true, json: () => url.includes('old') ? oldJSON.promise : Promise.resolve([{ display_name: 'New result, India' }]) });
  const first = app.w.runSearch('old');
  await Promise.resolve();
  await app.w.runSearch('new');
  oldJSON.resolve([{ display_name: 'Old result, India' }]);
  await first;
  assert.match(app.w.document.getElementById('searchResults').textContent, /New result/);
});

test('old search failure cannot erase newer results, and closing cancels pending input', async t => {
  const app = await boot(t);
  const old = deferred();
  app.w.fetch = url => url.includes('old') ? old.promise : Promise.resolve({ ok: true, json: async () => [{ display_name: 'New result' }] });
  const first = app.w.runSearch('old');
  await app.w.runSearch('new');
  old.reject(new Error('offline'));
  await first;
  assert.match(app.w.document.getElementById('searchResults').textContent, /New result/);
  const input = app.w.document.getElementById('searchInput');
  input.value = 'pending';
  input.dispatchEvent(new app.w.Event('input'));
  app.w.collapseSearch({ clear: true });
  app.w.fetch = () => { throw new Error('cancelled debounce must not fetch'); };
  app.advance(500);
  assert.equal(app.w.document.getElementById('searchResults').classList.contains('open'), false);
});

test('closing during card expansion prevents a delayed card from reopening', async t => {
  const app = await boot(t);
  app.w.showCards([assessment]);
  app.w.showExpandedCard(assessment);
  app.w.hideCards();
  app.advance(3000);
  assert.equal(app.w.document.getElementById('cardStack').children.length, 0);
  assert.equal(app.read('selectedLatLng'), null);
});

test('old card cleanup cannot clear the new selection connectors', async t => {
  const app = await boot(t);
  app.w.showCards([assessment]);
  app.w.showCards([{ ...assessment, latitude: 13 }]);
  app.advance(700);
  assert.equal(app.read('activeCards.length'), 1);
  assert.ok(app.w.document.getElementById('cardConnectors').children.length > 0);
});

test('clearing and quickly reapplying filters keeps the active pills visible', async t => {
  const app = await boot(t);
  app.w.setSeverityFilter(null);
  app.w.setSeverityFilter('High');
  app.w.setTimeFilter(null);
  app.w.setTimeFilter('night');
  app.advance(400);
  assert.equal(app.w.document.getElementById('severityPill').hidden, false);
  assert.equal(app.w.document.getElementById('timePill').hidden, false);
});
