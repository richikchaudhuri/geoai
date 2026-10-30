const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const schema = 'geoai.gis.v1';
const trackA = { type: 'LineString', coordinates: [[77.56, 12.92], [77.561, 12.921], [77.562, 12.922]] };
const trackB = { type: 'MultiLineString', coordinates: [
  [[77.57, 12.93], [77.571, 12.931]],
  [[77.58, 12.94], [77.581, 12.941]],
] };
const trackC = { type: 'LineString', coordinates: [[77.59, 12.95], [77.591, 12.951]] };
function sessions() {
  return { schema, count: 4, sessions: [
    { session_id: 'drive-a', road_name: 'First road', local_date: '2026-10-26', state: 'stored', route_m: 300, track: structuredClone(trackA) },
    { session_id: 'drive-b', road_name: '<img src=x onerror="alert(1)">', local_date: '2026-10-27', state: 'cleaned', route_m: 500, track: structuredClone(trackB) },
    { session_id: 'drive-c', road_name: 'Processing road', state: 'classifying', route_m: 100, track: structuredClone(trackC) },
    { session_id: 'drive-empty', road_name: 'No track yet', state: 'queued', route_m: 0, track: null },
  ] };
}
function meta() {
  return { schema, labels: [
    { name: 'Potholes', color: '#7f1d1d', is_distress: true, marker_priority: 1 },
    { name: 'Edge Cracking', color: '#8f53ca', is_distress: true, marker_priority: 6 },
    { name: 'Bleeding', color: '#6d28d9', is_distress: true, marker_priority: 16 },
    { name: 'Normal', color: '#16a34a', is_distress: false, marker_priority: 19 },
  ], severities: [
    { name: 'None', radius_px: 4 }, { name: 'Low', radius_px: 6 },
    { name: 'Medium', radius_px: 9 }, { name: 'High', radius_px: 13 }, { name: 'Unknown', radius_px: 4 },
  ], vlm_classes: [{ name: 'unknown', color: '#6b7280' }], confidence_threshold: .8,
  limits: { default_limit: 2, max_limit: 20 } };
}
function segment(id, properties = {}, geometry) {
  return { type: 'Feature', id, geometry: geometry === undefined ? {
    type: 'Polygon', coordinates: [[[77.566, 12.928], [77.5661, 12.928], [77.5661, 12.9281], [77.566, 12.928]]],
  } : geometry, properties: {
    layer: 'video', segment_id: id, session_id: 'drive-a', k: 1, status: 'send',
    vlm_class: 'distress', answered: true, centre_lat: 12.928, centre_lon: 77.566,
    position_sigma_m: 6, final_labels: ['Potholes'], marker_label: 'Potholes', final_severity: 'Medium',
    labels: ['Normal'], severity: 'None', confidence: .92, needs_expert_review: false, expert_reviewed: false,
    local_time: '2026-10-26T17:14:11.396+05:30', utc: '2026-10-26T11:44:11.396Z',
    length_m: 5, s0_m: 7.45, road_name: 'First road', ...properties,
  } };
}
function segments() {
  return [segment('segment-a'), segment('segment-b', {
    final_labels: ['Bleeding', 'Edge Cracking'], marker_label: 'Edge Cracking', final_severity: 'None',
    confidence: .95, needs_expert_review: true, centre_lon: 77.586,
  })];
}
const ok = data => ({ ok: true, status: 200, json: async () => data });
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }

function harness(t, options = {}) {
  const dom = new JSDOM(readFileSync(path.join(root, 'index.html'), 'utf8'), { url: 'https://example.test/', runScripts: 'outside-only' });
  const w = dom.window;
  let now = 0, timerId = 0;
  const timers = new Map();
  w.Date.now = () => now;
  w.setTimeout = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; };
  w.clearTimeout = id => timers.delete(id);
  w.setInterval = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: now + delay, interval: delay }); return id; };
  w.clearInterval = w.clearTimeout;
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at;
      if (due[1].interval) timers.set(due[0], { ...due[1], at: now + due[1].interval });
      due[1].fn();
    }
    now = end;
  }
  function evented(value = {}) {
    const listeners = new Map();
    return Object.assign(value, {
      on(names, listener) {
        if (typeof names === 'object') { for (const [name, fn] of Object.entries(names)) this.on(name, fn); return this; }
        for (const name of names.split(' ')) { const entries = listeners.get(name) || []; entries.push(listener); listeners.set(name, entries); }
        return this;
      },
      off(names, listener) { for (const name of names.split(' ')) listeners.set(name, (listeners.get(name) || []).filter(fn => fn !== listener)); return this; },
      fire(name, data = {}) { for (const fn of listeners.get(name) || []) fn({ target: this, ...data }); return this; },
    });
  }
  const basemap = { kind: 'original-basemap' }, citizens = { kind: 'original-citizens' };
  const activeLayers = new Set([basemap, citizens]);
  const removed = [], added = [], moves = [], geometries = [], polygons = [], circles = [], tooltips = [];
  const panes = new Map();
  const map = evented({
    center: { lat: 12.9716, lng: 77.5946 }, zoom: options.zoom || 12, bbox: [77.5, 12.9, 77.7, 13.0],
    addLayer(layer) { activeLayers.add(layer); added.push(layer); layer._target = this; return this; },
    removeLayer(layer) { activeLayers.delete(layer); removed.push(layer); layer._target = null; return this; },
    hasLayer(layer) { return activeLayers.has(layer); },
    createPane(name) { const pane = w.document.createElement('div'); panes.set(name, pane); return pane; },
    getPane(name) { return panes.get(name); },
    getCenter() { return this.center; }, getZoom() { return this.zoom; }, getMaxZoom() { return options.maxZoom ?? 21; },
    getBounds() { const [west, south, east, north] = this.bbox; return { getWest: () => west, getSouth: () => south, getEast: () => east, getNorth: () => north, toBBoxString: () => this.bbox.join(',') }; },
    project(latlng) { const [lat, lng] = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng]; return { x: lng * 1000, y: lat * 1000 }; },
    unproject(point) { return { lat: (point.y ?? point[1]) / 1000, lng: (point.x ?? point[0]) / 1000 }; },
    latLngToLayerPoint(latlng) { return this.project(latlng); }, layerPointToLatLng(point) { return this.unproject(point); },
    fitBounds(bounds, opts) { moves.push({ kind: 'fit', bounds, opts }); return this; },
    flyToBounds(bounds, opts) { return this.fitBounds(bounds, opts); },
    setView(center, zoom, opts) { moves.push({ kind: 'set', center, zoom, opts }); this.center = center; this.zoom = zoom; return this; },
  });
  const bounds = (points = []) => ({ points, extend() { return this; }, isValid() { return true; } });
  function group(kind = 'group', config = {}) {
    const layer = evented({
      kind, options: config, layers: [], styles: [],
      addLayer(value) { this.layers.push(value); value._target = this; return this; },
      removeLayer(value) { this.layers = this.layers.filter(item => item !== value); value._target = null; return this; },
      clearLayers() { for (const child of this.layers) child._target = null; this.layers.length = 0; return this; },
      addTo(target) { target.addLayer(this); this.fire('add'); return this; },
      remove() { this._target?.removeLayer(this); return this; },
      getLayers() { return this.layers; }, eachLayer(fn) { this.layers.forEach(fn); return this; }, getBounds: bounds,
      setStyle(style) { this.styles.push(style); Object.assign(this.options, style); return this; },
      setLatLngs(points) { this.points = points; return this; },
      bindTooltip(content, settings) { this.tooltip = { content, settings, layer: this }; tooltips.push(this.tooltip); return this; },
      openTooltip() { this.fire('tooltipopen'); return this; }, closeTooltip() { this.fire('tooltipclose'); return this; },
      bringToFront() { return this; }, bringToBack() { return this; },
    });
    return layer;
  }
  const L = {
    layerGroup: () => group(), featureGroup: () => group(), latLngBounds: bounds,
    canvas: config => ({ kind: 'canvas-renderer', options: config }),
    point: (x, y) => ({ x, y }), latLng: (lat, lng) => Array.isArray(lat) ? { lat: lat[0], lng: lat[1] } : { lat, lng },
    divIcon: config => config,
    polyline(points, config) { const line = group('polyline', config); line.points = points; return line; },
    marker(location, config) {
      const marker = group('camera', config), element = w.document.createElement('div');
      element.className = config.icon.className; element.append(config.icon.html);
      marker.location = location; marker.element = element; marker.opacityChanges = [];
      marker.setLatLng = value => { marker.location = value; return marker; };
      marker.getElement = () => element;
      marker.setOpacity = value => { marker.opacityChanges.push(value); element.style.opacity = String(value); return marker; };
      return marker;
    },
    polygon(points, config) { const layer = group('diamond', config); layer.points = points; polygons.push(layer); return layer; },
    circle(latlng, config) { const layer = group('uncertainty', config); layer.latlng = latlng; circles.push(layer); return layer; },
    geoJSON(input, config = {}) {
      const layer = group('geojson', config);
      geometries.push({ input, config, layer }); layer.data = input;
      const features = input?.type === 'FeatureCollection' ? input.features : input?.type === 'Feature' ? [input] : [{ type: 'Feature', geometry: input, properties: {} }];
      for (const feature of features) {
        const child = group('feature', typeof config.style === 'function' ? config.style(feature) : config.style || {});
        child.feature = feature; config.onEachFeature?.(feature, child); layer.addLayer(child);
      }
      return layer;
    },
  };
  const calls = [];
  function responseFor(url) {
    const parsed = new URL(url, w.location.href);
    if (parsed.pathname === '/gis/video/sessions') return ok(options.sessions || sessions());
    if (parsed.pathname === '/gis/meta') return ok(options.meta || meta());
    if (parsed.pathname === '/gis/video/segments.geojson') {
      const features = options.segments || segments(), limit = Number(parsed.searchParams.get('limit') || features.length), offset = Number(parsed.searchParams.get('offset') || 0);
      const page = features.slice(offset, offset + limit);
      return ok({ schema, type: 'FeatureCollection', layer: 'video', numberMatched: features.length, numberReturned: page.length, features: page });
    }
    throw new Error(`Unexpected endpoint: ${parsed.pathname}`);
  }
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return options.fetch ? options.fetch(url, init, () => responseFor(url)) : responseFor(url);
  };
  vm.runInContext(readFileSync(path.join(root, 'video.js'), 'utf8'), dom.getInternalVMContext());
  const button = w.document.getElementById('videoToggle');
  const notice = w.document.getElementById('videoNotice');
  let baseNavClicks = 0;
  w.document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', event => {
    event.preventDefault(); baseNavClicks++;
    w.document.querySelectorAll('.nav-item').forEach(node => node.classList.remove('active'));
    item.classList.add('active');
  }));
  const controller = new w.GeoAIVideoPaths({ map, L, button, notice, apiBase: options.apiBase || '', fetch: fetcher });
  t.after(() => { w.geoaiDrivePlayer?.destroy?.(); controller.destroy(); dom.window.close(); });
  const visible = () => {
    const result = []; const walk = layer => { result.push(layer); for (const child of layer.layers || []) walk(child); };
    activeLayers.forEach(walk); return result;
  };
  const requests = pathname => calls.filter(call => new URL(call.url, w.location.href).pathname === pathname);
  return { w, controller, map, L, button, notice, calls, advance, activeLayers, basemap, citizens, removed, added, moves, geometries, polygons, circles, tooltips, visible, requests, getBaseNavClicks: () => baseNavClicks };
}

function tooltipText(layer) { const content = layer.tooltip.content; return typeof content === 'function' ? content() : content; }
function routes(app) { return app.geometries.filter(entry => ['LineString', 'MultiLineString'].includes(entry.input.geometry?.type)); }

test('Video lazily loads tracks, metadata and only viewport distress through the read-only API', async t => {
  const app = harness(t);
  assert.equal(app.calls.length, 0);
  await app.controller.setEnabled(true);
  assert.equal(app.requests('/gis/video/sessions').length, 1);
  assert.equal(app.requests('/gis/meta').length, 1);
  const query = new URL(app.requests('/gis/video/segments.geojson')[0].url, app.w.location.href).searchParams;
  assert.equal(query.get('vlm_class'), 'distress');
  assert.equal(query.get('geom'), 'point');
  assert.deepEqual(query.get('bbox').split(',').map(Number), app.map.bbox);
  assert.ok(Number(query.get('limit')) <= meta().limits.max_limit);
  assert.equal(query.get('offset'), '0');
  assert.equal(query.has('min_confidence'), false);
  assert.ok(app.calls.every(call => (call.init.method || 'GET') === 'GET' && call.init.body === undefined));
  assert.ok(app.calls.every(call => !/\/image\/|\/summary/.test(call.url)));
  assert.equal(app.moves.length, 0, 'changing a layer never moves the map');
  assert.ok(app.activeLayers.has(app.basemap));
  assert.ok(app.activeLayers.has(app.citizens));
  assert.equal(app.notice.hidden, true);
});

test('travelled distance totals unique drive routes and stays stable across viewport changes and toggles', async t => {
  const data = sessions();
  data.sessions[0].route_m = 1150;
  data.sessions[1].route_m = 272.81;
  data.sessions[2].route_m = 2637.5;
  data.sessions.push(structuredClone(data.sessions[0]));
  const app = harness(t, { sessions: data, segments: [] });
  const distance = app.w.document.getElementById('videoDistance');
  const label = app.w.document.getElementById('videoDistanceLabel');
  assert.equal(distance.hidden, true);
  const enabling = app.controller.setEnabled(true);
  assert.equal(distance.hidden, false);
  assert.match(label.textContent, /Loading distance/);
  await enabling;
  assert.equal(label.textContent, '4.06 km travelled');
  assert.match(distance.title, /across 4 drives/);
  assert.match(distance.title, /Repeat passes.*not unique road coverage/);
  assert.match(distance.title, /Unfinished drives.*part/);
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 0, 'route distance is not the sum of displayed distress');
  app.map.bbox = [77.7, 13, 77.8, 13.1]; app.map.fire('moveend');
  app.advance(300); await settle();
  assert.equal(label.textContent, '4.06 km travelled');
  assert.equal(app.requests('/gis/video/sessions').length, 1);
  assert.equal(app.requests('/gis/meta').length, 1);
  assert.ok(app.calls.every(call => ['/gis/video/sessions', '/gis/meta', '/gis/video/segments.geojson'].includes(new URL(call.url, app.w.location.href).pathname)));
  const requests = app.calls.length;
  await app.controller.setEnabled(false);
  assert.equal(distance.hidden, true);
  await app.controller.setEnabled(true);
  assert.equal(distance.hidden, false);
  assert.equal(label.textContent, '4.06 km travelled');
  assert.equal(app.calls.length, requests);
});

test('distance distinguishes true zero from invalid or unavailable data and stays hidden after loading is cancelled', async t => {
  for (const value of [undefined, null, -1, NaN, Infinity]) {
    const data = sessions(); data.sessions[0].route_m = value;
    const app = harness(t, { sessions: data });
    await app.controller.setEnabled(true);
    assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, 'Distance unavailable');
  }
  const zeroData = sessions(); zeroData.sessions.forEach(session => { session.route_m = 0; });
  const zero = harness(t, { sessions: zeroData });
  await zero.controller.setEnabled(true);
  assert.equal(zero.w.document.getElementById('videoDistanceLabel').textContent, '0.00 km travelled');
  const failed = harness(t, { fetch: async () => ({ ok: false, status: 503 }) });
  await failed.controller.setEnabled(true);
  assert.equal(failed.w.document.getElementById('videoDistance').hidden, false);
  assert.equal(failed.w.document.getElementById('videoDistanceLabel').textContent, 'Distance unavailable');
  let release;
  const cancelled = harness(t, { fetch: (url, init, fallback) => new Promise(resolve => { release = () => resolve(fallback()); }) });
  const enabling = cancelled.controller.setEnabled(true);
  assert.match(cancelled.w.document.getElementById('videoDistanceLabel').textContent, /Loading distance/);
  await cancelled.controller.setEnabled(false);
  release(); await enabling;
  assert.equal(cancelled.w.document.getElementById('videoDistance').hidden, true);
});

test('selecting a drive, an unavailable drive or a zero-distance drive retains every recorded route and the whole-catalogue total', async t => {
  const app = harness(t, { segments: [] });
  await app.controller.setEnabled(true);
  const original = app.controller.paths.map(entry => entry.path);
  for (const session of ['drive-b', 'deleted-drive', 'drive-empty', '']) {
    await app.controller.setFilters({ session });
    assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, '0.90 km travelled');
    assert.equal(app.controller.paths.length, 3);
    assert.deepEqual(Array.from(app.controller.paths, entry => entry.sessionId), ['drive-a', 'drive-b', 'drive-c']);
    assert.deepEqual(app.controller.paths.map(entry => entry.path), original, 'selection does not destroy the other route layers');
    assert.ok(original.every(path => app.visible().includes(path)), 'all recorded route layers remain attached');
  }
  assert.equal(app.moves.length, 0, 'filter refreshes do not unexpectedly move the map');
});

test('recorded routes and total appear before distress finishes and survive a failed distress request', async t => {
  let release;
  const app = harness(t, { fetch: (url, init, fallback) => url.includes('/segments.geojson')
    ? new Promise(resolve => { release = resolve; }) : fallback() });
  const loading = app.controller.setEnabled(true);
  await settle();
  assert.equal(typeof release, 'function');
  assert.equal(app.controller.paths.length, 3, 'valid catalogue routes are usable while distress is still loading');
  assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, '0.90 km travelled');
  release({ ok: false, status: 503 });
  await loading;
  assert.equal(app.controller.error, true);
  assert.equal(app.controller.paths.length, 3);
  assert.ok(app.controller.paths.every(entry => app.visible().includes(entry.path)));
  assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, '0.90 km travelled');
  assert.equal(app.notice.hidden, false, 'failed distress is explained without hiding available routes');
});

test('the menu under total distance lists every drive and supports selection, focus, replay and returning to all drives', async t => {
  const app = harness(t, { segments: [] });
  await app.controller.setEnabled(true);
  const distance = app.w.document.getElementById('videoDistance');
  const select = distance.querySelector('#videoDriveSelect');
  const details = distance.querySelector('#videoDriveDetails');
  const focus = distance.querySelector('#videoDriveFocus');
  const replay = distance.querySelector('#videoDriveReplay');
  assert.ok(select && details && focus && replay, 'drive controls belong directly below the total');
  assert.deepEqual(Array.from(select.options, option => option.value), ['', 'drive-a', 'drive-b', 'drive-c', 'drive-empty']);
  assert.match(select.options[0].textContent, /All drives/i);
  assert.match(select.options[1].textContent, /First road/);
  assert.match(select.options[1].textContent, /2026-10-26/);
  assert.match(select.options[4].textContent, /No track yet/);
  assert.equal(distance.querySelector('img'), null, 'road names are text, never executable markup');
  assert.equal(app.moves.length, 0, 'loading the menu preserves the current map');
  const replayCalls = [];
  app.w.geoaiDrivePlayer = { isOpen: true, close() { replayCalls.push('close'); this.isOpen = false; }, open(id) { replayCalls.push(id); } };
  app.w.geoaiSurvey = { filters: { session: '', captureTime: 'night' }, driveInput: app.w.document.createElement('input'), updateCounts() {} };
  await app.controller.setFilters(app.w.geoaiSurvey.filters);
  select.value = 'drive-b'; select.dispatchEvent(new app.w.Event('change'));
  await settle();
  assert.equal(app.controller.filters.session, 'drive-b');
  assert.equal(app.w.geoaiSurvey.filters.session, 'drive-b');
  assert.equal(app.w.geoaiSurvey.filters.captureTime, 'night');
  assert.equal(app.w.geoaiSurvey.driveInput.value, 'drive-b');
  assert.deepEqual(replayCalls, ['close']);
  assert.equal(app.controller.paths.length, 3);
  assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, '0.90 km travelled');
  assert.match(details.textContent, /0\.50/);
  const selected = app.controller.paths.find(entry => entry.sessionId === 'drive-b');
  const other = app.controller.paths.find(entry => entry.sessionId === 'drive-a');
  assert.ok(selected.path.options.weight > other.path.options.weight, 'selected route stands out while all routes remain visible');
  assert.equal(app.moves.length, 1, 'an explicit drive selection focuses its extent');
  assert.deepEqual(JSON.parse(JSON.stringify(app.moves[0].bounds.points)), trackB.coordinates.flat().map(([lng, lat]) => [lat, lng]));
  replay.click();
  assert.deepEqual(replayCalls, ['close', 'drive-b']);
  focus.click();
  assert.equal(app.moves.length, 2);
  select.value = ''; select.dispatchEvent(new app.w.Event('change'));
  await settle();
  assert.equal(app.controller.filters.session, '');
  assert.equal(app.w.geoaiSurvey.filters.session, '');
  assert.equal(app.controller.paths.length, 3);
  assert.equal(app.moves.length, 3, 'All drives explicitly fits every recorded route');
  assert.deepEqual(JSON.parse(JSON.stringify(app.moves[2].bounds.points)), [...trackA.coordinates, ...trackB.coordinates.flat(), ...trackC.coordinates].map(([lng, lat]) => [lat, lng]));
  assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, '0.90 km travelled');
  await app.controller.setEnabled(false);
  assert.equal(distance.hidden, true);
});

test('the real route player shares the menu Replay button and stays synchronized through switching, closure and late replay responses', async t => {
  const app = harness(t, { segments: [] });
  let delayReplay = false, releaseReplay;
  app.w.geoaiSurvey = {
    filters: { session: '' }, meta: meta(), driveInput: app.w.document.createElement('input'),
    closeEvidence() {}, updateCounts() {},
    client: {
      async sessions() { return sessions(); },
      async features() {
        if (delayReplay) return new Promise(resolve => { releaseReplay = resolve; });
        return { features: [], truncated: false };
      },
    },
  };
  app.w.eval(readFileSync(path.join(root, 'drive-player.js'), 'utf8'));
  const player = app.w.geoaiDrivePlayer = new app.w.GeoAIDrivePlayer({ map: app.map, L: app.L, video: app.controller, survey: app.w.geoaiSurvey });
  await app.controller.setEnabled(true);
  const select = app.w.document.getElementById('videoDriveSelect');
  const replay = app.w.document.getElementById('videoDriveReplay');
  assert.equal(player.launcher, replay, 'player reuses the real menu control');
  assert.equal(app.w.document.querySelectorAll('.drive-replay-launcher').length, 1);
  assert.ok(app.w.document.getElementById('videoDistance').contains(replay));
  assert.equal(replay.hidden, false);
  assert.equal(replay.disabled, false);
  replay.click(); await settle();
  assert.equal(player.isOpen, true);
  assert.equal(player.ready, true);
  assert.equal(replay.hidden, true);
  assert.equal(select.value, 'drive-a');
  assert.equal(app.controller.paths.length, 3);
  assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, '0.90 km travelled');
  player.select.value = 'drive-b'; player.select.dispatchEvent(new app.w.Event('change')); await settle();
  assert.equal(player.session.session_id, 'drive-b');
  assert.equal(select.value, 'drive-b');
  assert.equal(app.w.geoaiSurvey.driveInput.value, 'drive-b');
  assert.equal(app.controller.paths.length, 3);
  select.value = ''; select.dispatchEvent(new app.w.Event('change')); await settle();
  assert.equal(player.isOpen, false);
  assert.equal(replay.hidden, false);
  assert.equal(app.w.geoaiSurvey.filters.session, '');
  assert.equal(app.controller.playback, null);

  // Changing the menu during a pending replay must invalidate its late result.
  delayReplay = true;
  replay.click(); await settle();
  assert.equal(player.isOpen, true);
  assert.equal(player.ready, false);
  assert.equal(typeof releaseReplay, 'function');
  select.value = 'drive-b'; select.dispatchEvent(new app.w.Event('change')); await settle();
  assert.equal(player.isOpen, false);
  delayReplay = false;
  releaseReplay({ features: [segment('late-replay', { session_id: 'drive-a' })], truncated: false });
  await settle();
  assert.equal(player.isOpen, false);
  assert.equal(player.ready, false);
  assert.equal(player.route, null);
  assert.equal(app.controller.playback, null);
  assert.equal(select.value, 'drive-b');
  assert.equal(app.controller.paths.length, 3);
  assert.equal(replay.hidden, false);
  replay.click(); await settle();
  assert.equal(player.ready, true);
  assert.equal(player.session.session_id, 'drive-b');
  await app.controller.setEnabled(false);
  assert.equal(player.isOpen, false);
  assert.equal(replay.hidden, true);
  await app.controller.setEnabled(true);
  assert.equal(replay.hidden, false);
  assert.equal(replay.disabled, false);
  assert.equal(app.controller.paths.length, 3);
});

test('all usable drive tracks preserve gaps and processing state', async t => {
  const data = sessions();
  data.sessions.push(
    { track: { type: 'LineString', coordinates: [[77.5, 12.9], [NaN, 12.91]] } },
    { track: { type: 'LineString', coordinates: [[77.5, 12.9], [181, 12.91]] } },
    { track: { type: 'Point', coordinates: [77.5, 12.9] } },
  );
  const app = harness(t, { sessions: data });
  await app.controller.setEnabled(true);
  assert.deepEqual(routes(app).map(item => item.input.geometry), [trackA, trackB, trackC]);
  assert.equal(routes(app)[1].input.geometry.coordinates.length, 2);
  assert.ok(routes(app)[2].config.style.dashArray);
  const hostile = tooltipText(routes(app)[1].layer);
  assert.equal(hostile.querySelector('img'), null);
  assert.match(hostile.textContent, /<img src=x onerror="alert\(1\)">/);
  assert.match(tooltipText(routes(app)[2].layer).textContent, /Processing/);
});

test('camera badges use metadata colour and final severity including None with independent hit targets', async t => {
  const data = meta(); data.severities.find(entry => entry.name === 'None').radius_px = 7;
  const app = harness(t, { meta: data });
  await app.controller.setEnabled(true);
  const diamonds = app.visible().filter(layer => layer.kind === 'camera');
  assert.equal(diamonds.length, 2);
  assert.equal(diamonds[0].options.icon.html.style.getPropertyValue('--distress-color'), '#7f1d1d');
  assert.equal(diamonds[1].options.icon.html.style.getPropertyValue('--distress-color'), '#8f53ca');
  assert.equal(diamonds[1].options.icon.html.style.getPropertyValue('--distress-size'), '14px');
  assert.deepEqual([...diamonds[1].options.icon.iconSize], [32, 32]);
  assert.equal(diamonds[1].options.autoPanOnFocus, false);
  assert.equal(diamonds[1].options.keyboard, true);
  assert.equal(app.geometries.filter(entry => entry.input.geometry?.type === 'Polygon').length, 0);
});

test('street-level distress keeps clickable camera badges above noninteractive footprints', async t => {
  const app = harness(t, { zoom: 17, segments: [segment('a'), segment('b', { centre_lon: 77.567 }, { type: 'Point', coordinates: [77.567, 12.928] }), segment('c', { centre_lon: 77.568 }, null)] });
  await app.controller.setEnabled(true);
  const footprints = app.geometries.filter(entry => entry.input.geometry?.type === 'Polygon');
  assert.equal(footprints.length, 1);
  assert.equal(footprints[0].config.renderer?.kind, 'canvas-renderer');
  assert.deepEqual(footprints[0].input.geometry, segment('a').geometry);
  assert.equal(footprints[0].config.interactive, false);
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 3);
});

test('non-distress, unanswered and unpositioned rows never become false road distress', async t => {
  const app = harness(t, { segments: [
    segment('good'),
    segment('normal', { vlm_class: 'normal', final_labels: ['Normal'] }),
    segment('pending', { vlm_class: 'pending', answered: false }),
    segment('skip', { vlm_class: 'not_sent', status: 'skip', answered: false }),
    segment('gap', { vlm_class: 'not_covered', status: 'not_covered', answered: false }),
    segment('invalid-position', { centre_lat: NaN, centre_lon: 500 }, null),
  ] });
  await app.controller.setEnabled(true);
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 1);
});

test('segment labels are final, review flags authoritative, confidence zero and position uncertainty remain visible', async t => {
  const app = harness(t, { segments: [segment('a', {
    final_labels: ['<img src=x onerror="alert(1)">', 'Potholes'],
    confidence: 0, needs_expert_review: true, expert_reviewed: false,
  }), segment('b', { confidence: .95, needs_expert_review: true, centre_lon: 77.586 })] });
  await app.controller.setEnabled(true);
  const diamonds = app.visible().filter(layer => layer.kind === 'camera');
  const node = tooltipText(diamonds[0]);
  assert.equal(node.querySelector('img'), null);
  assert.match(node.textContent, /<img src=x onerror="alert\(1\)">/);
  assert.match(node.textContent, /Potholes/);
  assert.match(node.textContent, /Medium/);
  assert.match(node.textContent, /0\s*%/);
  assert.match(node.textContent, /review/i);
  assert.match(node.textContent, /±\s*6/);
  assert.match(node.textContent, /17:14|5:14/);
  assert.doesNotMatch(node.textContent, /above mean sea level|MSL/);
  assert.match(tooltipText(diamonds[1]).textContent, /awaiting.*review|pending.*review|needs.*review/i);
  diamonds[0].fire('tooltipopen');
  assert.equal(app.circles.at(-1).options.radius, 6, 'uncertainty is a metre-radius circle');
  assert.ok(app.visible().includes(app.circles.at(-1)));
  diamonds[0].fire('tooltipclose');
  assert.ok(!app.visible().includes(app.circles.at(-1)));
});

test('paging loads every matching segment without duplicating the top-level layers', async t => {
  const app = harness(t, { segments: [segment('a'), segment('b'), segment('c'), segment('d'), segment('e')] });
  await app.controller.setEnabled(true);
  const queries = app.requests('/gis/video/segments.geojson').map(call => new URL(call.url, app.w.location.href).searchParams);
  assert.deepEqual(queries.map(query => Number(query.get('offset'))), [0, 2, 4]);
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 1);
  assert.equal(app.controller.distressMarkers[0].members.length, 5, 'paging preserves every observation inside the spatial cluster');
  assert.equal(app.activeLayers.size, 3);
});

test('off removes only video and recent re-enable uses cache without moving the current view', async t => {
  const app = harness(t);
  await app.controller.setEnabled(true);
  const requests = app.calls.length;
  const layer = [...app.activeLayers].find(item => item !== app.basemap && item !== app.citizens);
  app.map.center = { lat: 13, lng: 77.7 }; app.map.zoom = 14;
  await app.controller.setEnabled(false);
  assert.deepEqual([...app.activeLayers], [app.basemap, app.citizens]);
  assert.equal(app.button.getAttribute('aria-pressed'), 'false');
  assert.equal(app.button.hasAttribute('aria-busy'), false);
  assert.equal(app.notice.hidden, true);
  assert.equal(app.moves.length, 0);
  assert.deepEqual(app.map.getCenter(), { lat: 13, lng: 77.7 });
  await app.controller.setEnabled(true);
  assert.equal(app.calls.length, requests);
  assert.equal(app.activeLayers.size, 3);
  assert.ok(app.activeLayers.has(layer));
  assert.equal(app.visible().filter(item => item.kind === 'camera').length, 2);
  await app.controller.setEnabled(false);
  await app.controller.setEnabled(true);
  assert.equal(app.visible().filter(item => item.kind === 'camera').length, 2, 'Re-enabling at the same zoom must restore cached icons');
});

test('turning Video off aborts pending requests and ignores late data', async t => {
  let release;
  const app = harness(t, { fetch: (url, init, fallback) => url.includes('/segments.geojson')
    ? new Promise(resolve => { release = () => resolve(fallback()); }) : fallback() });
  const loading = app.controller.setEnabled(true); await settle();
  const request = app.requests('/gis/video/segments.geojson')[0];
  assert.ok(request);
  await app.controller.setEnabled(false);
  assert.equal(request.init.signal.aborted, true);
  release(); await loading;
  assert.deepEqual([...app.activeLayers], [app.basemap, app.citizens]);
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 0);
  assert.equal(app.button.getAttribute('aria-pressed'), 'false');
  assert.equal(app.notice.hidden, true);
});

test('panning debounces viewport requests and does not let stale results overwrite the next viewport', async t => {
  let release;
  const app = harness(t, { fetch: (url, init, fallback) => url.includes('/segments.geojson') && new URL(url, 'https://example.test').searchParams.get('bbox').split(',').map(Number)[0] === 77.6
    ? new Promise(resolve => { release = () => resolve(ok({ schema, type: 'FeatureCollection', layer: 'video', numberMatched: 1, numberReturned: 1, features: [segment('stale')] })); }) : fallback() });
  await app.controller.setEnabled(true);
  const initial = app.requests('/gis/video/segments.geojson').length;
  app.map.bbox = [77.6, 12.9, 77.8, 13]; app.map.fire('moveend');
  app.advance(299); await settle(); assert.equal(app.requests('/gis/video/segments.geojson').length, initial);
  app.advance(1); await settle();
  const stale = app.requests('/gis/video/segments.geojson').at(-1);
  assert.ok(release);
  app.map.bbox = [77.7, 12.9, 77.9, 13]; app.map.fire('moveend');
  app.advance(300); await settle();
  assert.equal(stale.init.signal.aborted, true);
  release(); await settle();
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 2);
  assert.deepEqual(new URL(app.requests('/gis/video/segments.geojson').at(-1).url, app.w.location.href).searchParams.get('bbox').split(',').map(Number), [77.7, 12.9, 77.9, 13]);
  assert.equal(app.moves.length, 0);
});

test('world-sized, wrapped and dateline views request valid non-wrapping API bounds', async t => {
  for (const [viewport, expected] of [
    [[-220, -100, 220, 100], [-180, -90, 180, 90]],
    [[437.5, 12.9, 437.7, 13], [77.5, 12.9, 77.7, 13]],
    [[170, -20, 190, 20], [-180, -20, 180, 20]],
  ]) {
    const app = harness(t);
    app.map.bbox = viewport;
    await app.controller.setEnabled(true);
    const query = new URL(app.requests('/gis/video/segments.geojson')[0].url, app.w.location.href).searchParams;
    assert.deepEqual(query.get('bbox').split(',').map(Number), expected);
    assert.equal(app.notice.hidden, true);
    assert.equal(app.moves.length, 0);
  }
});

test('panning keeps loaded camera markers and route instances through pending, failed and unchanged refreshes', async t => {
  let pending = false, rejectRefresh;
  const app = harness(t, { fetch: (url, init, fallback) => pending && url.includes('/segments.geojson')
    ? new Promise((resolve, reject) => { rejectRefresh = reject; }) : fallback() });
  await app.controller.setEnabled(true);
  const cameras = app.visible().filter(layer => layer.kind === 'camera');
  const tracks = routes(app);
  pending = true;
  app.map.bbox = [77.6, 12.9, 77.8, 13]; app.map.fire('moveend'); app.advance(300); await settle();
  assert.deepEqual(app.visible().filter(layer => layer.kind === 'camera'), cameras);
  assert.deepEqual(routes(app), tracks);
  rejectRefresh(new Error('network unavailable')); await settle();
  assert.deepEqual(app.visible().filter(layer => layer.kind === 'camera'), cameras);
  assert.equal(app.controller.error, true);
  assert.match(app.notice.textContent, /Previously loaded observations remain visible/);
  pending = false;
  app.map.fire('moveend'); app.advance(300); await settle();
  assert.deepEqual(app.visible().filter(layer => layer.kind === 'camera'), cameras);
  assert.deepEqual(routes(app), tracks);
  assert.equal(app.controller.error, false);
  assert.equal(app.moves.length, 0);
});

test('city clusters zoom to separate streets and coincident street observations remain individually accessible', async t => {
  const app = harness(t, { segments: [segment('selected'), segment('same-spot'),
    segment('another-street', { centre_lat: 12.929, centre_lon: 77.567 })] });
  const opened = [];
  app.w.geoaiSurvey = { showEvidence: (feature, group) => opened.push(Array.from(group, f => f.properties.segment_id)) };
  await app.controller.setEnabled(true);
  for (const zoom of [12, 13, 14]) {
    app.map.zoom = zoom; app.map.fire('zoomend');
    const cluster = app.controller.distressMarkers[0];
    assert.equal(cluster.members.length, 3); cluster.marker.fire('click');
    assert.equal(opened.length, 0, 'city-scale groups zoom instead of pretending separate streets share a photo location');
    assert.equal(app.moves.at(-1).opts.maxZoom, zoom + 3);
    assert.equal(app.moves.at(-1).bounds.points.length, 3);
  }
  app.map.zoom = 19; app.map.fire('zoomend');
  assert.equal(app.controller.distressMarkers.length, 2);
  const coincident = app.controller.distressMarkers.find(entry => entry.members.length === 2);
  coincident.marker.fire('click');
  assert.deepEqual(opened[0].sort(), ['same-spot', 'selected']);
});

test('zooming to street level requests footprints rather than reusing point geometry', async t => {
  const app = harness(t, { fetch: async (url, init, fallback) => {
    const parsed = new URL(url, 'https://example.test');
    if (parsed.pathname !== '/gis/video/segments.geojson') return fallback();
    const response = await fallback().json();
    if (parsed.searchParams.get('geom') === 'point') response.features = response.features.map(feature => ({ ...feature, geometry: { type: 'Point', coordinates: [77.566, 12.928] } }));
    return ok(response);
  } });
  await app.controller.setEnabled(true);
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 2);
  app.map.zoom = 17; app.map.fire('zoomend'); app.map.fire('moveend');
  app.advance(300); await settle();
  assert.equal(new URL(app.requests('/gis/video/segments.geojson').at(-1).url, app.w.location.href).searchParams.get('geom'), 'footprint');
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 2);
  assert.equal(app.visible().filter(layer => layer.kind === 'geojson' && layer.data.geometry.type === 'Polygon').length, 2);
  assert.equal(app.moves.length, 0);
});

test('oversized viewport shows a zoom-in notice and routes, never a misleading partial distress sample', async t => {
  const app = harness(t, { fetch: async (url, init, fallback) => url.includes('/segments.geojson')
    ? ok({ schema, type: 'FeatureCollection', layer: 'video', numberMatched: 5001, numberReturned: 2, features: [segment('a'), segment('b')] }) : fallback() });
  await app.controller.setEnabled(true);
  assert.match(app.notice.textContent, /zoom in/i);
  assert.equal(routes(app).length, 3);
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 0);
  assert.equal(app.requests('/gis/video/segments.geojson').length, 1);
});

test('Video selects one navigation pill and Map exits drive mode while retaining accessible toggle labels', async t => {
  const app = harness(t);
  const mapNav = app.w.document.querySelector('[data-page="map"]');
  const filtersNav = app.w.document.querySelector('[data-page="filters"]');
  const selected = () => [...app.w.document.querySelectorAll('.nav-pill .nav-item.active')];
  const label = app.button.getAttribute('aria-label');
  app.button.click(); await settle();
  assert.equal(app.button.getAttribute('aria-pressed'), 'true');
  assert.equal(app.button.getAttribute('aria-label'), label);
  assert.equal(app.getBaseNavClicks(), 0);
  assert.deepEqual(selected(), [app.button]);
  const requests = app.calls.length;
  filtersNav.click();
  assert.equal(app.getBaseNavClicks(), 1);
  assert.equal(app.button.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(selected(), [filtersNav]);
  app.button.click(); await settle();
  assert.deepEqual(selected(), [app.button]);
  assert.equal(app.button.getAttribute('aria-pressed'), 'true', 'reselecting enabled Video keeps the overlay visible');
  assert.equal(app.calls.length, requests, 'reselection does not reload the survey');
  mapNav.click(); await settle();
  assert.deepEqual(selected(), [mapNav]);
  assert.equal(app.button.getAttribute('aria-pressed'), 'false', 'Map must exit drive mode');
  app.button.click(); await settle();
  assert.deepEqual(selected(), [app.button]);
  assert.equal(app.button.getAttribute('aria-pressed'), 'true');
  app.button.click(); await settle();
  assert.deepEqual(selected(), [mapNav]);
  assert.equal(app.button.getAttribute('aria-pressed'), 'false');
  await app.controller.setEnabled(true);
  filtersNav.click();
  await app.controller.setEnabled(false);
  assert.deepEqual(selected(), [filtersNav], 'disabling an unselected Video layer preserves the selected Filters pill');
  assert.equal(app.button.getAttribute('aria-pressed'), 'false');
  assert.equal(app.moves.length, 0);
});

test('service failure retries after 30 seconds and recovers without disturbing the base map', async t => {
  let failed = false;
  const app = harness(t, { fetch: async (url, init, fallback) => {
    if (!failed && url.includes('/segments.geojson')) { failed = true; return { ok: false, status: 503 }; }
    return fallback();
  } });
  await app.controller.setEnabled(true);
  assert.match(app.notice.textContent, /unavailable/i);
  assert.equal(app.notice.hidden, false);
  const requests = app.calls.length;
  app.advance(29999); await settle(); assert.equal(app.calls.length, requests);
  app.advance(1); await settle();
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 2);
  assert.equal(app.notice.hidden, true);
  assert.ok(app.activeLayers.has(app.basemap));
  assert.ok(app.activeLayers.has(app.citizens));
  const recovered = app.calls.length;
  app.advance(120000); await settle(); assert.equal(app.calls.length, recovered, 'successful data does not poll');
});

test('turning Video off cancels pending retries', async t => {
  const app = harness(t, { fetch: async () => ({ ok: false, status: 503 }) });
  await app.controller.setEnabled(true);
  await app.controller.setEnabled(false);
  const requests = app.calls.length;
  app.advance(120000); await settle();
  assert.equal(app.calls.length, requests);
  assert.equal(app.notice.hidden, true);
  assert.equal(app.activeLayers.size, 2);
});

test('unsupported schema and stalled pagination fail clearly rather than claiming a complete survey', async t => {
  const app = harness(t, { fetch: async (url, init, fallback) => url.includes('/segments.geojson')
    ? ok({ schema, type: 'FeatureCollection', numberMatched: 7, numberReturned: 0, features: [] }) : fallback() });
  await app.controller.setEnabled(true);
  assert.equal(app.notice.hidden, false);
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 0);
  assert.equal(app.requests('/gis/video/segments.geojson').length, 1);
  const bad = harness(t, { apiBase: 'https://survey.example.test/', meta: { ...meta(), schema: 'other.v1' } });
  await bad.controller.setEnabled(true);
  assert.ok(bad.calls.every(call => call.url.startsWith('https://survey.example.test/gis/')));
  assert.equal(bad.notice.hidden, false);
  const requests = bad.calls.length;
  bad.advance(120000); await settle();
  assert.equal(bad.calls.length, requests, 'unsupported schema is not retried indefinitely');
});

test('the shared navigation slider supplies Video black/white highlight while distress colours remain metadata colours', async t => {
  const app = harness(t);
  const style = app.w.document.createElement('style');
  style.textContent = readFileSync(path.join(root, 'styles.css'), 'utf8') + '\n' + readFileSync(path.join(root, 'video.css'), 'utf8');
  app.w.document.head.append(style);
  await app.controller.setEnabled(true);
  const slider = app.w.document.querySelector('.nav-slider');
  assert.ok(slider, 'navigation shares one sliding highlight');
  assert.equal(app.w.document.querySelectorAll('.nav-slider').length, 1);
  assert.equal(app.w.getComputedStyle(slider).backgroundColor, 'rgb(26, 26, 28)');
  assert.equal(app.w.getComputedStyle(app.button).backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(app.w.getComputedStyle(app.button).color, 'rgb(255, 255, 255)');
  app.w.document.body.classList.add('chrome-dark'); await settle();
  assert.equal(app.w.getComputedStyle(slider).backgroundColor, 'rgb(255, 255, 255)');
  assert.equal(app.w.getComputedStyle(app.button).backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(app.w.getComputedStyle(app.button).color, 'rgb(26, 26, 28)');
  assert.deepEqual(app.visible().filter(layer => layer.kind === 'camera').map(layer => layer.options.icon.html.style.getPropertyValue('--distress-color')), ['#7f1d1d', '#8f53ca']);
});


test('coincident clusters and Space open every captured observation without hiding another drive', async t => {
  const app = harness(t, { segments: [segment('later', { s0_m: 20 }), segment('earlier', { s0_m: 5 }),
    segment('other-drive', { session_id: 'drive-b', s0_m: 10 })] });
  const opened = [];
  app.w.geoaiSurvey = { showEvidence: (feature, group) => opened.push({ feature, group }) };
  await app.controller.setEnabled(true);
  const camera = app.visible().find(layer => layer.kind === 'camera');
  camera.fire('click');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].feature.properties.segment_id, 'earlier');
  assert.deepEqual(Array.from(opened[0].group, feature => feature.properties.segment_id), ['earlier', 'later', 'other-drive']);
  assert.equal(camera.getElement().getAttribute('role'), 'button');
  assert.match(camera.getElement().getAttribute('aria-label'), /3 drive distress observations.*Open photos and details/);
  assert.equal(camera.getElement().dataset.count, '3');
  const key = new app.w.KeyboardEvent('keydown', { key: ' ', cancelable: true, bubbles: true });
  camera.getElement().dispatchEvent(key);
  assert.equal(key.defaultPrevented, true);
  assert.equal(opened.length, 2, 'one group opens per Space key press');
  assert.equal(app.moves.length, 0, 'coincident groups do not zoom endlessly');
});

test('playback marks encountered observations without rebuilding markers or replacing viewport counts', async t => {
  const app = harness(t);
  await app.controller.setEnabled(true);
  const viewFeatures = app.controller.features;
  const fullDrive = [segment('at-start', { s0_m: 0 }), segment('later', { s0_m: 20, centre_lon: 77.586 }),
    segment('foreign', { session_id: 'drive-b', s0_m: 0 }), segment('normal', { vlm_class: 'normal' })];
  assert.equal(app.controller.setPlaybackData({ sessionId: 'drive-a', features: fullDrive, distance: 0 }), true);
  const cameras = app.visible().filter(layer => layer.kind === 'camera');
  assert.equal(cameras.length, 2);
  assert.equal(cameras[0].getElement().classList.contains('video-distress-reached'), true);
  assert.equal(cameras[1].getElement().classList.contains('video-distress-upcoming'), true);
  assert.equal(cameras[1].getElement().style.opacity, '0.35');
  assert.equal(app.controller.features, viewFeatures);
  app.controller.setPlaybackProgress(25);
  assert.equal(cameras[1].getElement().classList.contains('video-distress-reached'), true);
  assert.equal(cameras[1].getElement().style.opacity, '1');
  const changes = cameras[1].opacityChanges.length;
  app.controller.setPlaybackProgress(26);
  assert.equal(cameras[1].opacityChanges.length, changes, 'unchanged state performs no DOM opacity write');
  assert.equal(app.visible().filter(layer => layer.kind === 'camera')[1], cameras[1]);
  app.controller.setPlaybackProgress(2);
  assert.equal(cameras[1].getElement().classList.contains('video-distress-upcoming'), true, 'backward seeking restores upcoming state');
  app.controller.clearPlayback();
  assert.deepEqual(app.visible().filter(layer => layer.kind === 'camera').map(layer => layer.getElement().dataset.segmentId), ['segment-a', 'segment-b']);
  assert.equal(app.controller.features, viewFeatures);
});

test('disabling Video or changing filters discards playback and rejects late playback data', async t => {
  const app = harness(t);
  await app.controller.setEnabled(true);
  app.controller.setPlaybackData({ sessionId: 'drive-a', features: [segment('replay')], distance: 5 });
  await app.controller.setFilters({ highConfidence: true });
  assert.equal(app.controller.playback, null);
  app.controller.setPlaybackData({ sessionId: 'drive-a', features: [segment('replay')], distance: 5 });
  await app.controller.setEnabled(false);
  assert.equal(app.controller.playback, null);
  assert.equal(app.controller.setPlaybackData({ sessionId: 'drive-a', features: [segment('late')] }), false);
  app.controller.setPlaybackProgress(30);
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 0);
});


test('following a replay retains camera instances during viewport refresh but rebuilds on zoom or replay replacement', async t => {
  const app = harness(t);
  await app.controller.setEnabled(true);
  app.controller.setPlaybackData({ sessionId: 'drive-a', features: [segment('replay-a'), segment('replay-b', { s0_m: 30, centre_lon: 77.586 })], distance: 10 });
  const original = app.visible().filter(layer => layer.kind === 'camera');
  const requests = app.requests('/gis/video/segments.geojson').length;
  app.map.bbox = [77.6, 12.91, 77.8, 13.01]; app.map.fire('moveend');
  app.advance(300); await settle();
  assert.ok(app.requests('/gis/video/segments.geojson').length > requests, 'viewport counts still refresh while following');
  assert.deepEqual(app.visible().filter(layer => layer.kind === 'camera'), original, 'full-drive icon instances survive load-start and route reattachment');
  assert.equal(original[0].getElement().classList.contains('video-distress-reached'), true);
  assert.equal(original[1].getElement().classList.contains('video-distress-upcoming'), true);
  app.map.zoom = 17; app.map.fire('zoomend');
  const zoomed = app.visible().filter(layer => layer.kind === 'camera');
  assert.notEqual(zoomed[0], original[0], 'zoom recomputes footprint and nearby grouping');
  app.controller.setPlaybackData({ sessionId: 'drive-a', features: [], distance: 0 });
  assert.equal(app.visible().filter(layer => layer.kind === 'camera').length, 0, 'an empty replacement clears old replay icons');
  app.controller.clearPlayback();
  assert.deepEqual(app.visible().filter(layer => layer.kind === 'camera').map(marker => marker.getElement().dataset.segmentId), ['segment-a', 'segment-b']);
});

test('drive inspection keeps whole-drive markers through viewport refresh and rejects stale selections', async t => {
  const app = harness(t);
  await app.controller.setEnabled(true);
  await app.controller.setFilters({ session: 'drive-a' });
  const dispatch = (sessionId, features) => app.w.document.dispatchEvent(new app.w.CustomEvent('geoai:driveinspectionchange', {
    detail: { sessionId, features },
  }));
  dispatch('drive-a', [segment('whole-drive'), segment('foreign', { session_id: 'drive-b' })]);
  assert.equal(app.controller.distressMarkers.length, 1);
  assert.equal(app.controller.distressMarkers[0].feature.id, 'whole-drive');
  assert.equal(app.controller.features.length, 2, 'viewport count/export input is independent');
  await app.controller.load(app.controller.generation);
  assert.equal(app.controller.distressMarkers[0].feature.id, 'whole-drive');
  assert.equal(app.controller.paths.length, 3);
  await app.controller.setFilters({ session: 'drive-b' });
  dispatch('drive-a', [segment('late')]);
  assert.equal(app.controller.inspection, null);
  dispatch('drive-b', [segment('b', { session_id: 'drive-b' })]);
  assert.equal(app.controller.distressMarkers[0].feature.id, 'b');
  dispatch('drive-b', null);
  assert.equal(app.controller.inspection, null, 'loading/failure returns to ordinary observations');
  await app.controller.setEnabled(false);
  dispatch('drive-b', [segment('late-b', { session_id: 'drive-b' })]);
  assert.equal(app.controller.inspection, null);
});

function clusterMembers(app) {
  return Array.from(app.controller.distressMarkers, entry => Array.from(entry.members, member => member.feature.id).sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

test('world-pixel camera clusters reduce an overview, separate at street zoom and never discard members', async t => {
  const rows = Array.from({ length: 36 }, (_, index) => segment(`sample-${String(index).padStart(2, '0')}`, {
    centre_lon: 77.566 + index * .00005, s0_m: index * 5,
  }));
  const app = harness(t, { segments: rows, zoom: 12 });
  await app.controller.setEnabled(true);
  assert.equal(app.controller.distressMarkers.length, 1);
  assert.equal(app.controller.distressMarkers[0].marker.getElement().dataset.count, '36');
  assert.equal(app.controller.features.length, 36, 'viewport counts still count observations, not bubbles');
  assert.equal(app.controller.paths.length, 3);
  const all = rows.map(row => row.id).sort();
  for (const zoom of [12, 16, 18, 19, 21]) {
    app.map.zoom = zoom; app.map.fire('zoomend');
    assert.deepEqual(clusterMembers(app).flat().sort(), all, `all 36 observations survive zoom ${zoom}`);
    assert.equal(new Set(clusterMembers(app).flat()).size, 36);
  }
  assert.equal(app.controller.distressMarkers.length, 36, 'spaced observations have individual icons at close street zoom');
  app.map.zoom = 12; app.map.fire('zoomend');
  assert.equal(app.controller.distressMarkers.length, 1, 'zooming out collapses the same observations again');
});

test('cluster membership and identities are pan-stable, including source-order changes', async t => {
  const rows = Array.from({ length: 24 }, (_, index) => segment(`row-${index}`, {
    centre_lon: 77.56 + index * .0002, centre_lat: 12.928 + (index % 3) * .0002,
  }));
  const app = harness(t, { segments: rows, zoom: 17 }); await app.controller.setEnabled(true);
  const groups = clusterMembers(app), markers = app.controller.distressMarkers.map(entry => entry.marker);
  app.map.center = { lat: 12.94, lng: 77.58 }; app.map.bbox = [77.55, 12.91, 77.59, 12.95];
  app.map.fire('moveend'); app.advance(300); await settle();
  assert.deepEqual(clusterMembers(app), groups);
  assert.deepEqual(app.controller.distressMarkers.map(entry => entry.marker), markers);
  app.controller.features = [...app.controller.features].reverse(); app.controller.renderDistress();
  assert.deepEqual(clusterMembers(app), groups, 'server page order does not move observations between bubbles');
});

test('cluster progress counts reached members without hiding partial groups or losing footprints', async t => {
  const app = harness(t, { zoom: 18 }); await app.controller.setEnabled(true);
  const rows = [segment('a', { s0_m: 5 }), segment('b', { s0_m: 20, final_severity: 'High', marker_label: 'Edge Cracking' }), segment('c', { s0_m: 40 })];
  app.controller.setPlaybackData({ sessionId: 'drive-a', features: rows, distance: 0 });
  const entry = app.controller.distressMarkers[0], marker = entry.marker, el = marker.getElement();
  assert.equal(app.controller.distressMarkers.length, 1); assert.equal(entry.members.length, 3);
  assert.equal(marker.options.icon.html.style.getPropertyValue('--distress-color'), '#8f53ca', 'cluster uses the most severe member colour');
  assert.equal(el.style.opacity, '0.35'); assert.match(el.getAttribute('aria-label'), /0 of 3 reached/);
  app.controller.setPlaybackProgress(25);
  assert.equal(el.style.opacity, '1'); assert.equal(el.classList.contains('video-distress-partial'), true);
  assert.equal(el.querySelector('.video-distress-cluster-progress').textContent, '2/3');
  assert.equal(entry.members.find(member => member.feature.id === 'a').footprint.styles.at(-1).fillOpacity, .18);
  assert.equal(entry.members.find(member => member.feature.id === 'c').footprint.styles.at(-1).fillOpacity, .04);
  const writes = marker.opacityChanges.length;
  app.controller.setPlaybackProgress(26); assert.equal(marker.opacityChanges.length, writes);
  app.controller.setPlaybackProgress(50); assert.equal(el.classList.contains('video-distress-reached'), true);
  assert.equal(el.querySelector('.video-distress-cluster-progress').textContent, '3/3');
  app.controller.setPlaybackProgress(0); assert.equal(el.classList.contains('video-distress-upcoming'), true);
  assert.equal(el.style.opacity, '0.35'); assert.equal(app.controller.distressMarkers[0].marker, marker);
});

test('maximum-zoom clusters open all records rather than attempting an unavailable zoom', async t => {
  const app = harness(t, { zoom: 18, maxZoom: 18, segments: [segment('a'), segment('b', { centre_lon: 77.56602, s0_m: 20 })] });
  const opened = []; app.w.geoaiSurvey = { showEvidence: (feature, group) => opened.push({ feature, group }) };
  await app.controller.setEnabled(true);
  const entry = app.controller.distressMarkers[0];
  assert.equal(entry.members.length, 2); assert.match(entry.marker.getElement().getAttribute('aria-label'), /Open photos/);
  entry.marker.fire('click'); assert.equal(app.moves.length, 0);
  assert.deepEqual(Array.from(opened[0].group, feature => feature.id), ['a', 'b']);
});

test('dateline camera groups keep short wrapped bounds when expanded', async t => {
  const app = harness(t, { zoom: 12, segments: [segment('west', { centre_lat: 0, centre_lon: 179.9999 }), segment('east', { centre_lat: 0, centre_lon: -179.9999 })] });
  await app.controller.setEnabled(true);
  assert.equal(app.controller.distressMarkers.length, 1);
  app.controller.distressMarkers[0].marker.fire('click');
  const points = app.moves.at(-1).bounds.points;
  assert.ok(Math.abs(points[0][1] - points[1][1]) < .001, 'cluster bounds must not span the globe');
});
