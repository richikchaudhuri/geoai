const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { installCards } = require('./helpers/install-cards.cjs');
const root = path.join(__dirname, '..');
const schema = 'geoai.gis.v1';
const clone = value => JSON.parse(JSON.stringify(value));
const metadata = () => ({ schema, confidence_threshold: .8, limits: { default_limit: 2, max_limit: 20 },
  labels: [
    { name: 'Potholes', category: 'Disintegration', color: '#7f1d1d', marker_priority: 1, is_distress: true },
    { name: 'Bleeding', category: 'Surface Defects', color: '#6d28d9', marker_priority: 16, is_distress: true },
    { name: 'Normal', category: 'Normal', color: '#16a34a', marker_priority: 19, is_distress: false },
  ], severities: [{ name: 'None', radius_px: 4 }, { name: 'Low', radius_px: 6 }, { name: 'Medium', radius_px: 9 }, { name: 'High', radius_px: 13 }, { name: 'Unknown', radius_px: 4 }],
  vlm_classes: [{ name: 'distress', color: null }, { name: 'normal', color: '#16a34a' }, { name: 'pending', color: '#9ca3af' }, { name: 'unknown', color: '#6b7280' }],
});
function feature(id, properties = {}, layer = 'citizen') {
  return { type: 'Feature', id, geometry: { type: 'Point', coordinates: [properties.longitude ?? properties.centre_lon ?? 77.566, properties.latitude ?? properties.centre_lat ?? 12.928] }, properties: {
    id, layer, assessment_status: 'classified', final_labels: ['Potholes'], final_primary_label: 'Potholes',
    labels: ['Bleeding'], marker_label: 'Potholes', final_severity: 'High', severity: 'Low',
    vlm_class: 'distress', confidence: .9, needs_expert_review: false, expert_reviewed: false,
    longitude: 77.566, latitude: 12.928, centre_lon: 77.566, centre_lat: 12.928,
    address: 'Test Road', created_at: '2026-10-26T08:00:00Z', utc: '2026-10-26T08:00:00Z',
    position_sigma_m: 6, has_image: true, preview_url: `/gis/image/${id}?w=480`, image_url: `/gis/image/${id}`,
    ...(layer === 'video' ? { segment_id: id, session_id: 'drive-a', k: 1, status: 'send', answered: true, length_m: 5, s0_m: 10 } : {}),
    ...properties,
  } };
}
const citizenRows = () => [feature('c-high'), feature('c-low', { final_severity: 'Low', confidence: .3, expert_reviewed: true, longitude: 77.568, latitude: 12.93 }),
  feature('c-review', { assessment_status: 'expert_review', needs_expert_review: true, confidence: 0 })];
const videoRows = () => [feature('v-high', {}, 'video'), feature('v-low', { final_severity: 'Low', confidence: .2, needs_expert_review: true }, 'video'),
  feature('v-normal', { final_labels: ['Normal'], marker_label: 'Normal', vlm_class: 'normal', final_severity: 'None' }, 'video')];
const catalogue = () => ({ schema, count: 2, sessions: [
  { session_id: 'drive-a', state: 'stored', road_name: 'First Road', local_date: '2026-10-26', start_utc: '2026-10-26T08:00:00Z', route_m: 1234, distress_m: 20, pct_distress_of_surveyed: 10,
    bbox: [77.56, 12.92, 77.57, 12.94], track: { type: 'LineString', coordinates: [[77.56, 12.92], [77.57, 12.94]] } },
  { session_id: 'drive-b', state: 'classifying', road_name: 'Second Road', local_date: '2026-10-27', start_utc: '2026-10-27T08:00:00Z', route_m: 2826,
    bbox: [77.56, 12.92, 77.58, 12.95], track: { type: 'LineString', coordinates: [[77.56, 12.92], [77.58, 12.95]] } },
] });
async function settle() { for (let i = 0; i < 18; i++) await new Promise(resolve => setImmediate(resolve)); }

function harness(t, options = {}) {
  const dom = new JSDOM(readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: options.url || 'https://example.test/gis/app/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  let now = 1000, nextTimer = 0;
  const timers = new Map();
  w.Date.now = () => now;
  w.setTimeout = (fn, delay = 0) => { const id = ++nextTimer; timers.set(id, { at: now + delay, fn }); return id; };
  w.clearTimeout = id => timers.delete(id);
  w.requestAnimationFrame = fn => w.setTimeout(fn, 16);
  w.cancelAnimationFrame = w.clearTimeout;
  function advance(ms) {
    const end = now + ms;
    let count = 0;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      if (++count > 10000) throw new Error('Unbounded timer loop');
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = end;
  }
  const evented = object => {
    const events = new Map();
    return Object.assign(object, {
      on(names, fn) { if (typeof names === 'object') { Object.entries(names).forEach(([name, f]) => this.on(name, f)); return this; }
        names.split(' ').forEach(name => events.set(name, [...(events.get(name) || []), fn])); return this; },
      off(names, fn) { names.split(' ').forEach(name => events.set(name, (events.get(name) || []).filter(f => f !== fn))); return this; },
      fire(name, event = {}) { for (const fn of events.get(name) || []) fn({ target: this, ...event }); return this; },
    });
  };
  const moves = [], active = new Set(), markers = [], circles = [], statuses = [], styleChanges = [], actions = [];
  const group = (kind = 'group', config = {}) => evented({ kind, options: config, layers: [],
    addLayer(layer) { this.layers.push(layer); layer.target = this; return this; },
    removeLayer(layer) { this.layers = this.layers.filter(item => item !== layer); return this; },
    clearLayers() { this.layers.length = 0; return this; },
    addTo(target) { target.addLayer(this); this.target = target; return this; }, remove() { this.target?.removeLayer(this); },
    setStyle(style) { Object.assign(this.options, style); return this; }, setLatLngs(points) { this.points = points; return this; },
    setOpacity(value) { this.options.opacity = value; return this; },
    bindTooltip(content, tooltipOptions) { this.tooltip = { content, options: tooltipOptions }; return this; },
    getLayers() { return this.layers; }, eachLayer(fn) { this.layers.forEach(fn); return this; },
    bringToFront() { return this; }, bringToBack() { return this; },
  });
  const map = evented({ center: { lat: 12.9716, lng: 77.5946 }, zoom: options.zoom || 15, bbox: [77.5, 12.9, 77.7, 13],
    addLayer(layer) { active.add(layer); return this; }, removeLayer(layer) { active.delete(layer); return this; }, hasLayer(layer) { return active.has(layer); },
    getCenter() { return this.center; }, getZoom() { return this.zoom; },
    getBounds() { return { getWest: () => this.bbox[0], getSouth: () => this.bbox[1], getEast: () => this.bbox[2], getNorth: () => this.bbox[3] }; },
    project(value) { const p = Array.isArray(value) ? value : [value.lat, value.lng]; return { x: p[1] * 1000, y: p[0] * 1000 }; },
    unproject(value) { return { lat: (value.y ?? value[1]) / 1000, lng: (value.x ?? value[0]) / 1000 }; },
    latLngToLayerPoint(value) { return this.project(value); }, layerPointToLatLng(value) { return this.unproject(value); },
    latLngToContainerPoint() { return { x: w.innerWidth / 2, y: w.innerHeight / 2 }; },
    setView(value, zoom, settings) { this.center = { lat: value[0], lng: value[1] }; this.zoom = zoom; moves.push({ kind: 'set', value, zoom, settings }); return this; },
    flyTo(value, zoom, settings) { this.center = { lat: value[0], lng: value[1] }; this.zoom = zoom; moves.push({ kind: 'fly', value, zoom, settings }); return this; },
    fitBounds(value, settings) { moves.push({ kind: 'fit', value, settings }); return this; },
  });
  const L = { layerGroup: () => group(), featureGroup: () => group(), canvas: options => ({ options }),
    point: (x, y) => ({ x, y }), latLng: (lat, lng) => ({ lat, lng }),
    circleMarker(location, options) { const marker = group('citizen', options); marker.location = location; markers.push(marker); return marker; },
    marker(location, options) { const marker = group(options.icon?.className === 'video-distress-icon' ? 'video' : 'cluster', options); marker.location = location; markers.push(marker); return marker; },
    divIcon: options => options,
    circle(location, options) { const circle = group('uncertainty', options); circle.location = location; circles.push(circle); return circle; },
    polygon(points, options) { const marker = group('video', options); marker.points = points; markers.push(marker); return marker; },
    geoJSON(input, options = {}) { const layer = group('geojson', options); layer.input = input;
      const features = input.type === 'FeatureCollection' ? input.features : input.type === 'Feature' ? [input] : [];
      for (const feature of features) { const child = group('feature', typeof options.style === 'function' ? options.style(feature) : options.style || {});
        child.feature = feature; options.onEachFeature?.(feature, child); layer.addLayer(child); }
      return layer; },
  };
  const calls = [], citizens = clone(options.citizens || citizenRows()), videos = clone(options.videos || videoRows());
  const select = (rows, q, layer) => rows.filter(({ properties: p }) => {
    if (layer === 'citizen' && q.get('include_review') !== 'true' && p.assessment_status === 'expert_review') return false;
    for (const [key, value] of [['vlm_class', p.vlm_class], ['session', p.session_id], ['severity', p.final_severity]])
      if (q.has(key) && !q.get(key).split(',').includes(value)) return false;
    if (q.has('label') && !q.get('label').split(',').some(label => p.final_labels.includes(label))) return false;
    if (q.get('reviewed') === 'true' && !p.expert_reviewed) return false;
    if (q.get('needs_review') === 'true' && !p.needs_expert_review) return false;
    if (q.has('min_confidence') && (typeof p.confidence !== 'number' || p.confidence < Number(q.get('min_confidence')))) return false;
    const time = Date.parse(layer === 'citizen' ? p.created_at : p.utc);
    if (q.has('date_from') && time < Date.parse(q.get('date_from'))) return false;
    if (q.has('date_to') && time >= Date.parse(q.get('date_to'))) return false;
    return true;
  });
  const ok = data => ({ ok: true, status: 200, json: async () => clone(data), text: async () => data });
  function respond(url) {
    const p = new URL(url, w.location.href), q = p.searchParams;
    if (p.pathname === '/gis/meta') return ok(options.meta || metadata());
    if (p.pathname === '/gis/video/sessions') return ok(options.sessions || catalogue());
    const layer = p.pathname.startsWith('/gis/citizen/') ? 'citizen' : 'video';
    const rows = select(layer === 'citizen' ? citizens : videos, q, layer);
    if (p.pathname === '/gis/video/summary') return ok({ schema, segments: rows.length });
    const offset = Number(q.get('offset') || 0), limit = Number(q.get('limit') || 5000), page = rows.slice(offset, offset + limit);
    if (p.pathname === '/gis/video/segments.csv') {
      const columns = ['segment_id', 'session_id', 'final_severity', 'final_labels', 'confidence'];
      const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
      return ok(columns.map(quote).join(',') + '\r\n' + page.map(row => columns.map(key => quote(row.properties[key])).join(',')).join('\r\n') + (page.length ? '\r\n' : ''));
    }
    if (p.pathname.endsWith('.geojson')) return ok({ schema, type: 'FeatureCollection', layer, numberMatched: rows.length, numberReturned: page.length, features: page });
    throw new Error('Unexpected endpoint: ' + p.pathname);
  }
  Object.assign(w, { map, L, GIS_CONFIG: options.config || {}, currentStyle: 'light',
    LoadingScreen: { finish() { actions.push('loading-finished'); } },
    setStatus(text, state) { statuses.push({ text, state }); },
    setMapStyle(style) { styleChanges.push(style); w.currentStyle = style; },
    closeFilterStack() { actions.push('close-filters'); }, closeAboutStack() {}, openAboutStack() {},
  });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.fetch = async (url, init) => { calls.push({ url, init }); return options.fetch ? options.fetch(url, init, () => respond(url)) : respond(url); };
  const context = dom.getInternalVMContext();
  for (const file of ['gis-core.js', 'citizen-source.js', 'video.js']) vm.runInContext(readFileSync(path.join(root, file), 'utf8'), context);
  installCards(w, context);
  vm.runInContext(readFileSync(path.join(root, 'survey.js'), 'utf8'), context);
  const survey = w.geoaiSurvey, video = w.geoaiVideoPaths;
  t.after(() => { video.destroy(); survey.controller?.abort(); timers.clear(); dom.window.close(); });
  const requests = endpoint => calls.filter(call => new URL(call.url, w.location.href).pathname === endpoint);
  const change = async (name, value) => { const input = survey.form.elements.namedItem(name); if (input.type === 'checkbox') input.checked = value; else input.value = value;
    input.dispatchEvent(new w.Event('change', { bubbles: true })); await settle(); };
  return { w, survey, video, map, L, markers, circles, active, statuses, actions, moves, styleChanges, calls, requests, citizens, videos, advance, change };
}

function capture(app, type) {
  const events = [];
  app.w.document.addEventListener(type, event => { events.push(event.detail); event.preventDefault(); });
  return events;
}

test('drive mode hides walking markers and Map restores the same observations without refetching', async t => {
  const app = harness(t); await settle();
  const citizenMarkers = [...app.survey.layer.layers];
  const requests = app.requests('/gis/citizen/assessments.geojson').length;
  assert.ok(app.active.has(app.survey.layer));
  await app.video.setEnabled(true); await settle();
  assert.equal(app.active.has(app.survey.layer), false, 'Walking markers must leave the map in drive mode');
  assert.equal(app.survey.filters.citizen, true, 'Drive mode must preserve the walking layer preference');
  assert.equal(app.survey.form.elements.namedItem('citizen').checked, true);
  assert.equal(app.survey.features.length, 2, 'Cached walking observations must remain available for return');
  assert.equal(app.survey.locations.querySelectorAll('button').length, 0, 'Drive mode cannot reopen walking evidence through Top Locations');
  assert.match(app.statuses.at(-1).text, /video|drive/i, 'The visible map status should describe drive observations');
  app.w.document.querySelector('[data-page="map"]').click(); await settle();
  assert.equal(app.video.enabled, false, 'Map returns to walking mode');
  assert.ok(app.active.has(app.survey.layer));
  assert.deepEqual(app.survey.layer.layers, citizenMarkers, 'Switching modes reuses walking markers');
  assert.equal(app.requests('/gis/citizen/assessments.geojson').length, requests, 'Mode switching must not reload citizen data');
  assert.match(app.statuses.at(-1).text, /2 citizen observations/);
});

test('a shared drive-mode URL starts with walking observations hidden and restores them on toggle off', async t => {
  const app = harness(t, { url: 'https://example.test/gis/app/?video=true' }); await settle();
  assert.equal(app.video.enabled, true);
  assert.equal(app.active.has(app.survey.layer), false);
  assert.equal(app.survey.features.length, 2);
  await app.video.setEnabled(false); await settle();
  assert.ok(app.active.has(app.survey.layer));
  assert.equal(app.survey.layer.layers.length, 2);
});

test('late walking loads and zoom regrouping cannot put walking markers back into drive mode', async t => {
  let release;
  const app = harness(t, { fetch: (url, init, respond) => url.includes('/gis/citizen/')
    ? new Promise(resolve => { release = () => resolve(respond()); }) : respond() });
  await settle();
  assert.equal(typeof release, 'function');
  await app.video.setEnabled(true); await settle();
  assert.equal(app.active.has(app.survey.layer), false);
  release(); await settle();
  app.map.zoom = 18; app.map.fire('zoomend'); await settle();
  assert.equal(app.survey.features.length, 2);
  assert.equal(app.active.has(app.survey.layer), false, 'Late response and zoom must respect the current mode');
  await app.video.setEnabled(false); await settle();
  assert.ok(app.active.has(app.survey.layer));
  assert.equal(app.survey.layer.layers.length, 2);
});

test('changing filters in drive mode preserves hidden walking results for the return to Map', async t => {
  const app = harness(t); await settle();
  await app.video.setEnabled(true); await settle();
  await app.change('highConfidence', true);
  assert.equal(app.active.has(app.survey.layer), false);
  assert.equal(app.survey.features.length, 1);
  await app.video.setEnabled(false); await settle();
  assert.ok(app.active.has(app.survey.layer));
  assert.equal(app.survey.layer.layers.length, 1, 'Returning to walking mode must show the current filtered results');
  assert.equal(app.survey.features[0].id, 'c-high');
});

test('leaving drive mode respects an explicitly disabled walking layer', async t => {
  const app = harness(t); await settle();
  await app.change('citizen', false);
  await app.video.setEnabled(true); await settle();
  await app.video.setEnabled(false); await settle();
  assert.equal(app.survey.filters.citizen, false);
  assert.equal(app.survey.form.elements.namedItem('citizen').checked, false);
  assert.equal(app.active.has(app.survey.layer), false, 'Map must preserve the user’s walking layer preference');
  assert.equal(app.survey.layer.layers.length, 0);
});

test('survey starts with metadata-driven citizen results and no implicit image or Video requests', async t => {
  const app = harness(t); await settle();
  assert.equal(app.requests('/gis/meta').length, 1);
  assert.equal(app.requests('/gis/video/sessions').length, 1);
  assert.equal(app.requests('/gis/video/segments.geojson').length, 0);
  assert.equal(app.video.enabled, false);
  assert.equal(app.survey.renderer, app.video.renderer, 'Survey and Video must share one interaction canvas');
  assert.equal(app.survey.features.length, 2);
  assert.equal(app.survey.layer.layers.length, 2);
  assert.equal(app.survey.layer.layers[0].options.fillColor, '#7f1d1d');
  assert.equal(app.survey.layer.layers[0].options.radius, 13);
  assert.match(app.survey.counts.textContent, /2 citizen observations.*Video layer off/);
  assert.equal(app.moves.length, 0);
  assert.equal(app.w.document.querySelectorAll('#cardStack img').length, 0);
  assert.ok(app.calls.every(call => !String(call.url).includes('/gis/image/')));
  assert.equal(app.survey.form.querySelectorAll('[name=label]').length, 3);
  assert.ok(app.actions.includes('loading-finished'));
});

test('combined review, confidence, severity and date filters affect counts and exact API queries', async t => {
  const app = harness(t); await settle();
  await app.change('includeReview', true);
  assert.equal(app.survey.features.length, 3);
  await app.change('review', 'needs');
  assert.equal(app.survey.features.length, 1);
  assert.equal(app.survey.features[0].id, 'c-review');
  await app.change('highConfidence', true);
  assert.equal(app.survey.features.length, 0);
  await app.change('review', 'all');
  assert.equal(app.survey.features.length, 1);
  await app.change('dateFrom', '2026-10-26'); await app.change('dateTo', '2026-10-26');
  const q = new URL(app.requests('/gis/citizen/assessments.geojson').at(-1).url).searchParams;
  assert.equal(q.get('date_from'), '2026-10-26T00:00:00+05:30');
  assert.equal(q.get('date_to'), '2026-10-27T00:00:00+05:30');
  assert.equal(q.get('min_confidence'), '.8'.replace(/^\./, '0.'));
  assert.equal(q.get('include_review'), 'true');
  const high = [...app.survey.form.querySelectorAll('button')].find(b => b.textContent === 'High severity preset');
  high.click(); await settle();
  assert.deepEqual(Array.from(app.survey.filters.severities), ['High']);
  assert.equal(app.survey.features.length, 1);
});

test('Video and citizen filters share final result logic while distance retains all drives', async t => {
  const app = harness(t); await settle(); await app.video.setEnabled(true); await settle();
  assert.equal(app.video.features.length, 2);
  assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, '4.06 km travelled');
  await app.change('session', 'drive-a');
  assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, '4.06 km travelled');
  assert.equal(app.w.document.getElementById('videoDriveSelect').value, 'drive-a');
  const preset = [...app.survey.form.querySelectorAll('button')].find(b => b.textContent === 'High severity preset');
  preset.click(); await settle();
  assert.equal(app.video.features.length, 1);
  assert.equal(app.video.features[0].id, 'v-high');
  assert.equal(app.survey.features.length, 1);
  assert.match(app.survey.counts.textContent, /1 citizen observations.*1 distressed video segments/);
  assert.equal(app.moves.length, 0);
  app.survey.focusDrive(); await settle();
  assert.equal(app.moves.at(-1).kind, 'fit');
  assert.deepEqual(JSON.parse(JSON.stringify(app.moves.at(-1).value)), [[12.92, 77.56], [12.94, 77.57]]);
});

test('original evidence cards use safe previews, preserve zero confidence and expand to full details', async t => {
  const app = harness(t); await settle();
  const row = feature('danger', { final_primary_label: '<img src=x onerror=alert(1)>', final_labels: ['<svg onload=alert(1)>'],
    description: '<script>alert(1)</script>', confidence: 0, expert_reviewed: true, labels: ['Bleeding'], camera: { alt_ellipsoid_m: 900, alt_msl_m: null } });
  app.survey.showEvidence(row); app.advance(2300);
  const preview = app.w.document.querySelector('#cardStack .detail-panel.clickable.open');
  assert.ok(preview.querySelector('.detail-photo-wrap .detail-photo'));
  assert.ok(preview.querySelector('.detail-body'));
  assert.equal(preview.querySelector('.detail-tags').textContent, row.properties.final_labels[0]);
  assert.equal(app.w.document.querySelector('.survey-evidence'), null);
  preview.click(); app.advance(2500);
  const panel = app.w.document.querySelector('#cardStack .detail-panel.expanded.open');
  assert.equal(panel.querySelectorAll('script,iframe,[onerror],[onload]').length, 0);
  assert.equal(panel.querySelector('h2').textContent, row.properties.address);
  assert.match(panel.textContent, /0% confidence/);
  assert.equal(panel.querySelector('[role=meter]').getAttribute('aria-valuenow'), '0');
  assert.equal(panel.querySelector('s').textContent, 'Bleeding');
  assert.equal(panel.querySelectorAll('img').length, 1);
  assert.equal(panel.querySelector('img').src, 'https://example.test/gis/image/danger?w=480');
  assert.equal(panel.querySelector('a').href, 'https://example.test/gis/image/danger');
  assert.equal(panel.textContent.includes('Altitude MSL'), false);
  assert.equal(app.circles.at(-1).options.radius, 6);
  assert.equal(app.circles.at(-1).options.renderer, app.video.renderer);
  panel.querySelector('img').dispatchEvent(new app.w.Event('error'));
  assert.equal(panel.querySelector('img').hidden, true);
  assert.equal(panel.querySelector('img').hasAttribute('src'), false);
  assert.match(panel.textContent, /Preview unavailable/);
  app.w.document.dispatchEvent(new app.w.KeyboardEvent('keydown', { key: 'Escape' }));
  app.advance(650);
  assert.equal(app.w.document.querySelector('#cardStack .detail-panel'), null);
  assert.equal(app.w.document.body.classList.contains('gis-cards-open'), false);
  assert.equal(app.active.has(app.circles.at(-1)), false);
});

test('missing or unsafe image URLs produce honest placeholders without loading full images', async t => {
  const app = harness(t); await settle();
  for (const properties of [{ has_image: false, status: 'not_covered' }, { preview_url: 'javascript:alert(1)', image_url: 'file:///private/photo.jpg' }]) {
    app.survey.closeEvidence(); app.advance(650);
    app.survey.showEvidence(feature('unavailable', properties)); app.advance(2300);
    app.w.document.querySelector('#cardStack .clickable.open').click(); app.advance(2500);
    const panel = app.w.document.querySelector('#cardStack .expanded.open');
    assert.equal(panel.querySelectorAll('img[src],a[href]').length, 0);
    assert.match(panel.textContent, /No usable frame|No preview available/);
  }
});

test('pending and unanswered drive observations explain that classification is still awaited', async t => {
  const app = harness(t); await settle();
  const states = [{ vlm_class: 'pending' }, { status: 'pending' }, { answered: false }];
  for (const [index, state] of states.entries()) {
    app.survey.showEvidence(feature('waiting-' + index, { final_labels: [], final_severity: 'Unknown', confidence: null, ...state }, 'video'));
    app.advance(2300);
    const card = app.w.document.querySelector('#cardStack .clickable.open');
    assert.equal(card.querySelector('.detail-description').textContent, 'Awaiting classification');
    assert.equal(card.querySelector('.detail-confidence').textContent, 'Confidence unavailable');
  }
  app.survey.showEvidence(feature('waiting-described', { answered: false, description: 'Frame awaiting specialist review.' }, 'video'));
  app.advance(2300);
  assert.equal(app.w.document.querySelector('#cardStack .clickable.open .detail-description').textContent, 'Frame awaiting specialist review.');
  for (const [status, description] of [['skip', 'Not sent for classification'], ['not_covered', 'No usable frame · not covered']]) {
    app.survey.showEvidence(feature(status, { status, answered: false, has_image: false, vlm_class: 'unknown' }, 'video'));
    app.advance(2300);
    assert.equal(app.w.document.querySelector('#cardStack .clickable.open .detail-description').textContent, description);
    assert.equal(app.w.document.querySelectorAll('#cardStack .clickable.open img[src]').length, 0);
  }
});

test('expanding another preview tracks that observation’s uncertainty without an extra camera flight', async t => {
  const app = harness(t); await settle();
  const first = feature('anchor', { position_sigma_m: 6 }, 'video');
  const second = feature('neighbour', { position_sigma_m: 12, centre_lon: 77.5661, centre_lat: 12.9281, longitude: 77.5661, latitude: 12.9281 }, 'video');
  app.survey.showEvidence(first, [first, second]); app.advance(2300);
  const firstCircle = app.survey.uncertainty;
  app.w.document.querySelector('#cardStack .clickable.open[data-observation-id="neighbour"]').click(); app.advance(2500);
  assert.equal(app.w.document.querySelector('#cardStack .expanded.open').dataset.observationId, 'neighbour');
  assert.equal(app.active.has(firstCircle), false);
  assert.equal(app.survey.uncertainty.options.radius, 12);
  assert.deepEqual(Array.from(app.survey.uncertainty.location), [12.9281, 77.5661]);
  assert.equal(app.w.document.body.classList.contains('gis-cards-open'), true);
  assert.equal(app.survey.evidence.dataset.layer, 'video');
  assert.equal(app.moves.length, 1, 'Expanding a nearby preview updates its accuracy circle without another map flight');
});

test('citizen tooltip metadata is plain text rather than executable Leaflet HTML', async t => {
  const app = harness(t, { citizens: [feature('malicious', { final_labels: ['<img src=x onerror=alert(1)>'] })] }); await settle();
  const tooltip = app.survey.layer.layers[0].tooltip.content;
  assert.equal(typeof tooltip, 'object', 'Leaflet strings are interpreted as HTML; use a text DOM node');
  assert.equal(tooltip.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(tooltip.querySelectorAll('img').length, 0);
});

test('share links restore filters, camera, style and Video without an extra automatic camera jump', async t => {
  const app = harness(t, { url: 'https://example.test/gis/app/?geoai=1&lat=12.93&lng=77.56&zoom=17&video=true&style=dark&severity=High&include_review=true&session=drive-a' });
  await settle();
  assert.equal(app.video.enabled, true);
  assert.equal(app.map.getZoom(), 17);
  assert.equal(app.moves.length, 1);
  assert.deepEqual(app.styleChanges, ['dark']);
  assert.deepEqual(Array.from(app.survey.filters.severities), ['High']);
  assert.equal(app.video.features.length, 1);
  const events = capture(app, 'geoai:share');
  await app.survey.share();
  assert.equal(events.length, 1);
  const q = new URL(events[0].url).searchParams;
  assert.equal(q.get('severity'), 'High'); assert.equal(q.get('lat'), '12.93'); assert.equal(q.get('style'), 'dark');
  assert.equal(q.get('video'), 'true'); assert.equal(q.get('session'), 'drive-a');
});

test('native-hosted view sharing uses its configured public dashboard rather than asset origin', async t => {
  const app = harness(t, { url: 'https://appassets.androidplatform.net/gis/app/index.html', config: { apiBase: 'https://api.example.test', shareBaseUrl: 'https://api.example.test/gis/app/' } });
  await settle(); const events = capture(app, 'geoai:share'); await app.survey.share();
  assert.equal(new URL(events[0].url).origin, 'https://api.example.test');
  assert.ok(app.calls.every(call => new URL(call.url, app.w.location.href).origin === 'https://api.example.test'));
});

test('citizen and video exports deliver exactly the current filtered rows to the cancelable native event', async t => {
  const app = harness(t); await settle(); await app.video.setEnabled(true); await settle();
  const exports = capture(app, 'geoai:export');
  const preset = [...app.survey.form.querySelectorAll('button')].find(b => b.textContent === 'High severity preset');
  preset.click(); await settle();
  await app.survey.export('citizen');
  assert.equal(exports.length, 1); assert.match(exports[0].content, /c-high/); assert.doesNotMatch(exports[0].content, /c-low|c-review/);
  assert.equal(exports[0].filename, 'geoai-citizen.csv');
  await app.survey.export('video');
  assert.equal(exports.length, 2); assert.match(exports[1].content, /v-high/); assert.doesNotMatch(exports[1].content, /v-low|v-normal/);
  assert.equal(exports[1].filename, 'geoai-video.csv');
  assert.equal(app.requests('/gis/video/summary').length, 2);
  const q = new URL(app.requests('/gis/video/segments.csv')[0].url).searchParams;
  assert.equal(q.get('vlm_class'), 'distress'); assert.equal(q.get('severity'), 'High'); assert.ok(q.has('bbox'));
});

test('stale citizen responses cannot replace a later filtered result or re-enable an off layer', async t => {
  let hold = false; const pending = [];
  const app = harness(t, { fetch: (url, init, respond) => {
    if (hold && url.includes('/gis/citizen/')) return new Promise(resolve => pending.push({ init, release: () => resolve(respond()) }));
    return respond();
  } }); await settle(); hold = true;
  const old = app.survey.loadCitizens(); await settle();
  assert.equal(pending.length, 1);
  hold = false; await app.change('citizen', false);
  assert.equal(pending[0].init.signal.aborted, true);
  pending[0].release(); await old; await settle();
  assert.equal(app.survey.layer.layers.length, 0); assert.equal(app.survey.features.length, 0);
  assert.match(app.survey.counts.textContent, /Citizen layer off/);
});

test('an export pending when Video is disabled cannot publish an outdated native download', async t => {
  let release, hold = false;
  const app = harness(t, { fetch: (url, init, respond) => hold && url.includes('/gis/video/segments.csv')
    ? new Promise(resolve => { release = () => resolve(respond()); }) : respond() });
  await settle(); await app.video.setEnabled(true); await settle(); const exports = capture(app, 'geoai:export'); hold = true;
  const exporting = app.survey.export('video'); await settle();
  assert.equal(typeof release, 'function');
  await app.video.setEnabled(false); release(); await exporting; await settle();
  assert.equal(exports.length, 0);
  assert.match(app.survey.notice.textContent, /changed|cancel|Enable Video/i);
});

test('an export pending when filters change cannot publish rows from the previous filter', async t => {
  let release, hold = false;
  const app = harness(t, { fetch: (url, init, respond) => hold && url.includes('/gis/video/segments.csv')
    ? new Promise(resolve => { release = () => resolve(respond()); }) : respond() });
  await settle(); await app.video.setEnabled(true); await settle(); const exports = capture(app, 'geoai:export'); hold = true;
  const exporting = app.survey.export('video'); await settle();
  hold = false; await app.change('review', 'needs'); release(); await exporting;
  assert.equal(exports.length, 0); assert.match(app.survey.notice.textContent, /changed|cancel/i);
});

test('a failed video refresh retains mapped observations but marks the current count unavailable', async t => {
  let fail = false;
  const app = harness(t, { fetch: (url, init, respond) => fail && url.includes('/gis/video/segments.geojson') ? { ok: false, status: 503 } : respond() });
  await settle(); await app.video.setEnabled(true); await settle();
  assert.match(app.survey.counts.textContent, /2 distressed video segments/);
  const previous = app.video.features;
  fail = true; app.map.bbox = [77.6, 12.9, 77.8, 13]; app.map.fire('moveend'); app.advance(300); await settle();
  assert.equal(app.video.features, previous, 'Network failure cannot remove already mapped observations');
  assert.equal(app.video.error, true);
  assert.match(app.w.document.getElementById('videoNotice').textContent, /Previously loaded observations remain visible/);
  assert.doesNotMatch(app.survey.counts.textContent, /2 distressed video segments/);
  assert.match(app.survey.counts.textContent, /unavailable|could not|failed/i);
});

test('temporary initialization failure retries once and never creates duplicate filter or legend controls', async t => {
  let fail = true;
  const app = harness(t, { fetch: (url, init, respond) => fail && url.endsWith('/gis/meta') ? { ok: false, status: 503 } : respond() });
  await settle(); assert.match(app.survey.notice.textContent, /Retrying/); assert.ok(app.actions.includes('loading-finished'));
  fail = false; app.advance(30000); await settle();
  assert.equal(app.w.document.querySelectorAll('[aria-label="Survey filters"]').length, 1);
  assert.equal(app.w.document.querySelectorAll('#shareView').length, 1);
  assert.equal(app.w.document.querySelectorAll('#surveyLegend').length, 1);
  assert.equal(app.survey.features.length, 2);
});

test('Map and Filters navigation close observation evidence and remove its uncertainty circle', async t => {
  const app = harness(t); await settle();
  for (const page of ['map', 'filters']) {
    app.survey.showEvidence(app.survey.features[0]); app.advance(2300);
    assert.ok(app.survey.evidence);
    app.w.document.querySelector(`[data-page="${page}"]`).click();
    assert.equal(app.w.document.querySelector('#cardStack .detail-panel.open'), null);
    assert.equal(app.survey.evidence, null);
    assert.equal(app.w.document.body.classList.contains('gis-cards-open'), false);
    assert.equal(app.active.has(app.circles.at(-1)), false);
  }
});

test('entering drive mode closes walking evidence while background drive updates retain drive evidence', async t => {
  let hold = false, release;
  const app = harness(t, { fetch: (url, init, respond) => hold && url.includes('/gis/video/segments.geojson')
    ? new Promise(resolve => { release = () => resolve(respond()); }) : respond() });
  await settle();
  app.survey.showEvidence(app.survey.features[0]); app.advance(2300);
  assert.ok(app.survey.evidence, 'Walking evidence starts open');
  hold = true;
  const loading = app.video.setEnabled(true); await settle();
  assert.equal(app.survey.evidence, null, 'Entering drive mode removes walking evidence');
  assert.equal(typeof release, 'function');
  app.survey.showEvidence(videoRows()[0]); app.advance(2300);
  const panel = app.survey.evidence;
  assert.ok(panel, 'Drive evidence remains available');
  release(); await loading; await settle();
  assert.equal(app.survey.evidence, panel, 'Background drive count refresh must retain the drive photo');
  await app.video.setEnabled(false); await settle();
  assert.equal(app.survey.evidence, null, 'Leaving drive mode closes drive evidence');
});

test('clipboard denial leaves a real selectable view link rather than an unfulfilled instruction', async t => {
  const app = harness(t); await settle();
  Object.defineProperty(app.w.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied'); } } });
  app.w.document.execCommand = () => false;
  await app.survey.share();
  const target = app.w.document.getElementById('settingsPanel');
  const link = target.querySelector('a[href*="geoai="]');
  const input = target.querySelector('input[readonly],textarea[readonly]');
  const url = link?.href || input?.value;
  assert.ok(url, 'A generated URL remains available for manual copy/open when clipboard permission is denied');
  assert.equal(new URL(url).searchParams.get('geoai'), '1');
});

test('invalid date range does not silently fetch a different range, and disabled layers cannot export', async t => {
  const app = harness(t); await settle(); const exports = capture(app, 'geoai:export');
  await app.survey.export('video'); assert.equal(exports.length, 0); assert.match(app.survey.notice.textContent, /Enable Video/);
  await app.change('citizen', false); await app.survey.export('citizen'); assert.equal(exports.length, 0); assert.match(app.survey.notice.textContent, /Enable citizen/);
  const before = app.calls.length;
  app.survey.form.elements.namedItem('dateFrom').value = '2026-10-28';
  app.survey.form.elements.namedItem('dateTo').value = '2026-10-26';
  await app.survey.apply(); assert.equal(app.calls.length, before);
  assert.match(app.survey.notice.textContent, /end date must be on or after/);
  assert.equal(app.survey.form.elements.namedItem('dateFrom').value, app.survey.filters.dateFrom);
  assert.equal(app.survey.form.elements.namedItem('dateTo').value, app.survey.filters.dateTo);
});

test('date and capture-time export matches only the locally filtered day segments', async t => {
  const rows = [feature('day', { utc: '2026-10-26T00:30:00Z' }, 'video'),
    feature('night', { utc: '2026-10-26T15:30:00Z' }, 'video')];
  const app = harness(t, { videos: rows }); await settle(); await app.video.setEnabled(true); await settle();
  await app.change('captureTime', 'day');
  assert.equal(app.video.features.length, 1); assert.equal(app.video.features[0].id, 'day');
  const events = capture(app, 'geoai:export'); await app.survey.export('video');
  assert.equal(events.length, 1); assert.match(events[0].content, /"day"/); assert.doesNotMatch(events[0].content, /"night"/);
  assert.equal(app.requests('/gis/video/segments.csv').length, 0, 'Local time-of-day predicate uses bounded JSON export, not an unfiltered server CSV');
});

test('web entry loads shared GIS contract before the base app so the retired citizen pipeline stays isolated', () => {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const dom = new JSDOM(html);
  const scripts = [...dom.window.document.querySelectorAll('script[src]')].map(script => script.getAttribute('src').split('?')[0]);
  assert.ok(scripts.indexOf('gis-core.js') >= 0);
  assert.ok(scripts.indexOf('gis-core.js') < scripts.indexOf('app.js'));
  assert.ok(scripts.indexOf('app.js') < scripts.indexOf('video.js'));
  assert.ok(scripts.indexOf('video.js') < scripts.indexOf('survey.js'));
  assert.equal(scripts.some(src => /supabase/i.test(src)), false);
  dom.window.close();
});


test('coincident street-level citizen observations keep the original grouped preview cards', async t => {
  const rows = [feature('same-one', { description: 'First observation evidence' }),
    feature('same-two', { description: 'Second observation evidence', final_severity: 'Low' }),
    feature('same-three', { description: 'Third observation evidence', final_severity: 'Medium' })];
  const app = harness(t, { citizens: rows, zoom: 17 }); await settle();
  assert.equal(app.survey.features.length, 3);
  assert.equal(app.survey.layer.layers.length, 1);
  const cluster = app.survey.layer.layers[0];
  assert.equal(cluster.kind, 'cluster');
  cluster.fire('click'); app.advance(2300);
  const cards = [...app.survey.evidence.querySelectorAll('.clickable.open')];
  assert.equal(cards.length, 3);
  assert.match(app.survey.evidence.textContent, /First observation evidence/);
  assert.match(app.survey.evidence.textContent, /Second observation evidence/);
  assert.match(app.survey.evidence.textContent, /Third observation evidence/);
  cards.find(card => card.textContent.includes('Second observation evidence')).click(); app.advance(2500);
  assert.match(app.survey.evidence.querySelector('.expanded.open').textContent, /Second observation evidence/);
  assert.equal(app.moves.length, 1, 'Opening the cluster restores the original marker focus; expanding its preview adds no camera jump');
  assert.equal(app.moves[0].kind, 'fly'); assert.equal(app.moves[0].zoom, 19);
});

test('failed or oversized citizen requests remove stale Top Locations and explain the actual state', async t => {
  let mode = 'normal';
  const app = harness(t, { fetch: async (url, init, respond) => {
    if (!url.includes('/gis/citizen/')) return respond();
    if (mode === 'fail') return { ok: false, status: 503 };
    const response = respond();
    if (mode === 'truncated') {
      const data = await response.json(); data.numberMatched = 6001;
      return { ok: true, json: async () => data };
    }
    return response;
  } }); await settle();
  assert.ok(app.survey.locations.querySelector('button'));
  mode = 'fail'; await app.change('review', 'needs');
  assert.equal(app.survey.locations.querySelectorAll('button').length, 0);
  assert.equal(app.survey.layer.layers.length, 0);
  assert.match(app.survey.locations.textContent, /unavailable/i);
  assert.doesNotMatch(app.survey.locations.textContent, /No matching/);
  mode = 'truncated'; await app.survey.loadCitizens();
  assert.equal(app.survey.locations.querySelectorAll('button').length, 0);
  assert.match(app.survey.locations.textContent, /Too many.*Narrow/i);
  assert.doesNotMatch(app.survey.locations.textContent, /No matching/);
});

test('an invalid date edit restores visible applied dates while an earlier request finishes and exports', async t => {
  let hold = false, release;
  const app = harness(t, { fetch: (url, init, respond) => hold && url.includes('/gis/citizen/')
    ? new Promise(resolve => { release = () => resolve(respond()); }) : respond() }); await settle();
  await app.change('dateFrom', '2026-10-26'); await app.change('dateTo', '2026-10-26');
  hold = true; const pending = app.survey.loadCitizens(); await settle();
  const before = app.calls.length;
  app.survey.form.elements.namedItem('dateFrom').value = '2026-10-28';
  await app.survey.apply();
  assert.equal(app.calls.length, before);
  assert.equal(app.survey.form.elements.namedItem('dateFrom').value, '2026-10-26');
  assert.equal(app.survey.form.elements.namedItem('dateTo').value, '2026-10-26');
  assert.equal(app.survey.filters.dateFrom, '2026-10-26');
  hold = false; release(); await pending;
  const exports = capture(app, 'geoai:export'); await app.survey.export('citizen');
  assert.equal(exports.length, 1);
  const q = new URL(app.requests('/gis/citizen/assessments.geojson').at(-1).url).searchParams;
  assert.equal(q.get('date_from'), '2026-10-26T00:00:00+05:30');
  assert.equal(q.get('date_to'), '2026-10-27T00:00:00+05:30');
});

test('unavailable drive links remain explicit instead of silently showing an all-drives selection', async t => {
  const app = harness(t, { url: 'https://example.test/gis/app/?video=true&session=deleted-drive' }); await settle();
  assert.equal(app.survey.driveInput.value, 'deleted-drive');
  assert.match(app.survey.driveInput.selectedOptions[0].textContent, /Unavailable drive/);
  assert.equal(app.video.features.length, 0);
  assert.equal(app.w.document.getElementById('videoDistanceLabel').textContent, '4.06 km travelled');
  assert.match(app.w.document.getElementById('videoDriveDetails').textContent, /Selected drive unavailable/);
  app.survey.focusDrive();
  assert.equal(app.moves.length, 0);
  assert.match(app.survey.notice.textContent, /known map extent/);
});

test('unavailable drive catalogue never blocks healthy citizen data and recovers without resetting filters or camera', async t => {
  let unavailable = true;
  const rows = Array.from({ length: 131 }, (_, i) => feature('healthy-' + i, { final_severity: i % 2 ? 'Low' : 'High' }));
  const app = harness(t, { citizens: rows, fetch: (url, init, respond) =>
    unavailable && url.includes('/gis/video/sessions') ? { ok: false, status: 503 } : respond() });
  await settle();
  assert.equal(app.survey.features.length, 131, 'Independent drive catalogue outage cannot hide healthy citizen observations');
  assert.match(app.survey.counts.textContent, /131 citizen observations/);
  assert.equal(app.requests('/gis/meta').length, 1);
  assert.equal(app.requests('/gis/video/sessions').length, 1);
  assert.ok(app.actions.includes('loading-finished'));
  const preset = [...app.survey.form.querySelectorAll('button')].find(button => button.textContent === 'High severity preset');
  preset.click(); await settle();
  assert.equal(app.survey.features.length, 66);
  app.map.setView([12.94, 77.57], 17);
  const before = app.requests('/gis/citizen/assessments.geojson').length;
  const moves = app.moves.length;
  unavailable = false; app.advance(30000); await settle();
  assert.equal(app.requests('/gis/meta').length, 1);
  assert.equal(app.requests('/gis/video/sessions').length, 2);
  assert.equal(app.requests('/gis/citizen/assessments.geojson').length, before, 'Catalogue recovery only retries the failing endpoint');
  assert.equal(app.survey.features.length, 66);
  assert.deepEqual(Array.from(app.survey.filters.severities), ['High']);
  assert.equal(app.survey.form.querySelector('[name=severity][value=High]').checked, true);
  assert.equal(app.survey.sessions.length, 2);
  assert.equal(app.survey.driveInput.options.length, 3);
  assert.equal(app.moves.length, moves);
  assert.deepEqual(app.map.getCenter(), { lat: 12.94, lng: 77.57 });
  assert.equal(app.video.enabled, false);
});

test('drive camera badges open the same evidence card and pause listeners before the photo opens', async t => {
  const app = harness(t); await settle(); await app.video.setEnabled(true); await settle();
  const events = [];
  app.w.document.addEventListener('geoai:evidenceopen', event => events.push({ id: event.detail.feature.id, panelAlreadyOpen: !!app.survey.evidence }));
  const badge = app.video.distressMarkers.find(entry => entry.feature.id === 'v-high');
  assert.match(badge.marker.options.icon.className, /video-distress-icon/);
  assert.equal(badge.members.length, 2, 'Coincident drive observations share one numbered camera badge');
  badge.marker.fire('click'); app.advance(2300);
  assert.deepEqual(events, [{ id: 'v-high', panelAlreadyOpen: false }]);
  const panel = app.w.document.querySelector('#cardStack .clickable.open');
  assert.equal(panel.dataset.layer, 'video');
  assert.equal(panel.querySelector('img').src, 'https://example.test/gis/image/v-high?w=480');
  assert.equal(panel.querySelector('.severity-badge').textContent, 'High');
  assert.equal(panel.querySelector('.detail-confidence').textContent, '90% confidence');
  assert.equal(app.w.document.querySelectorAll('#cardStack .clickable.open').length, 2, 'overlapping drive observations use the original preview cards');
  assert.equal(app.moves.length, 1, 'An explicit marker click restores the original camera focus');
  assert.equal(app.moves[0].kind, 'fly'); assert.equal(app.moves[0].zoom, 19);
});

test('selected-drive camera clicks stay in the right card when inline inspection handles them', async t => {
  const app = harness(t, { zoom: 19, videos: [feature('v-high', {}, 'video'),
    feature('v-low', { centre_lat: 12.93, centre_lon: 77.568, final_severity: 'Low' }, 'video')] }); await settle(); await app.video.setEnabled(true); await settle();
  const d = app.w.document, panel = d.createElement('section'), inspected = [], events = [];
  panel.id = 'driveInspector'; panel.textContent = 'Replay and captured frames'; d.querySelector('main').append(panel);
  d.body.classList.add('drive-inspector-open', 'drive-replay-open');
  app.w.geoaiDriveInspector = {
    inspectFeature(row) {
      if (row.properties.layer !== 'video' || row.properties.session_id !== 'drive-a') return false;
      inspected.push(row.id); panel.dataset.selectedFrame = row.id; return true;
    },
  };
  d.addEventListener('geoai:evidenceopen', event => events.push(event.detail.feature.id));
  for (const id of ['v-high', 'v-low', 'v-high']) {
    app.video.distressMarkers.find(entry => entry.feature.id === id).marker.fire('click');
    app.advance(2300);
    assert.equal(panel.dataset.selectedFrame, id);
    assert.equal(d.getElementById('driveInspector'), panel);
    assert.equal(panel.hidden, false);
    assert.equal(d.body.classList.contains('drive-replay-open'), true);
    assert.equal(d.body.classList.contains('gis-cards-open'), false, 'inline selection must not activate the CSS that hides replay');
    assert.equal(d.querySelector('#cardStack .clickable.open'), null);
    assert.equal(app.survey.evidence == null, true);
  }
  assert.deepEqual(inspected, ['v-high', 'v-low', 'v-high']);
  assert.deepEqual(events, [], 'the legacy evidence-open path must not run after inline handling');
  assert.equal(app.moves.length, 0, 'only the inline inspector decides whether to focus the map');
});

test('unhandled citizen and other-drive evidence keeps the original photo-card flow', async t => {
  const app = harness(t); await settle();
  const events = [], offered = [];
  app.w.geoaiDriveInspector = { inspectFeature(row) { offered.push(row.id); return false; } };
  app.w.document.addEventListener('geoai:evidenceopen', event => events.push(event.detail.feature.id));
  for (const row of [feature('outside-citizen'), feature('outside-drive', { session_id: 'drive-b' }, 'video')]) {
    app.survey.showEvidence(row); app.advance(2300);
    const preview = app.w.document.querySelector('#cardStack .clickable.open');
    assert.ok(preview);
    assert.equal(preview.dataset.observationId, row.id);
    assert.equal(preview.querySelector('img').src, `https://example.test/gis/image/${row.id}?w=480`);
    assert.equal(app.w.document.body.classList.contains('gis-cards-open'), true);
    app.survey.closeEvidence(); app.advance(650);
  }
  assert.ok(offered.includes('outside-drive'));
  assert.deepEqual(events, ['outside-citizen', 'outside-drive']);
});

test('grouped drive selection remains tracked through View more and closes completely when Video is disabled', async t => {
  const rows = Array.from({ length: 6 }, (_, index) => feature('group-' + index, {
    address: 'Observation road ' + index, s0_m: index * 5, k: index,
    position_sigma_m: 4 + index, final_severity: index === 5 ? 'Low' : 'High',
  }, 'video'));
  const app = harness(t, { videos: rows }); await settle();
  await app.video.setEnabled(true); await settle();
  assert.equal(app.moves.length, 0, 'Enabling Video itself does not move the map');
  app.video.distressMarkers.find(entry => entry.members.some(member => member.feature.id === 'group-5')).marker.fire('click'); app.advance(2300);
  const preview = app.w.document.querySelector('#cardStack .clickable.open');
  assert.equal(preview.dataset.observationId, 'group-0', 'The cluster starts at its earliest recorded observation');
  assert.equal(preview.querySelector('.severity-badge').textContent, 'High');
  assert.equal(app.w.document.querySelectorAll('#cardStack .clickable.open').length, 3);
  assert.equal(app.survey.uncertainty.options.radius, 4);
  const previousCircle = app.survey.uncertainty;
  app.w.document.querySelector('#cardStack .view-more.open').click(); app.advance(500);
  const entries = [...app.w.document.querySelectorAll('#cardStack .list-card.open .list-row')];
  assert.equal(entries.length, 6);
  entries.find(entry => entry.textContent.includes('Observation road 2')).click(); app.advance(2300);
  assert.equal(app.w.document.querySelector('#cardStack .clickable.open').dataset.observationId, 'group-2');
  assert.equal(app.survey.evidence, app.w.document.getElementById('cardStack'));
  assert.equal(app.survey.evidence.dataset.layer, 'video');
  assert.equal(app.w.document.body.classList.contains('gis-cards-open'), true);
  assert.equal(app.active.has(previousCircle), false);
  assert.equal(app.survey.uncertainty.options.radius, 6);
  const selectedCircle = app.survey.uncertainty;
  const movesBeforeDisable = app.moves.length;
  await app.video.setEnabled(false); await settle(); app.advance(650);
  assert.equal(app.survey.evidence, null);
  assert.equal(app.survey.uncertainty, null);
  assert.equal(app.active.has(selectedCircle), false);
  assert.equal(app.w.document.querySelector('#cardStack .detail-panel'), null);
  assert.equal(app.w.document.getElementById('cardConnectors').children.length, 0);
  assert.equal(app.w.document.body.classList.contains('gis-cards-open'), false);
  assert.equal(app.moves.length, movesBeforeDisable, 'Disabling Video does not move the map');
});

test('filter changes notify replay with the accepted shared state and drive replay is opt-in', async t => {
  const app = harness(t); await settle();
  const received = [], opened = [];
  app.w.document.addEventListener('geoai:filterschange', event => received.push(event.detail.filters));
  app.w.geoaiDrivePlayer = { open: id => opened.push(id) };
  assert.equal(opened.length, 0);
  const replay = [...app.survey.driveList.querySelectorAll('button')].find(button => button.textContent === 'Replay drive');
  replay.click();
  assert.equal(opened.length, 1);
  assert.equal(app.moves.length, 0, 'the replay controller owns any explicitly requested focus');
  await app.change('highConfidence', true);
  assert.equal(received.length, 1);
  assert.equal(received[0].highConfidence, true);
  assert.equal(received[0], app.survey.filters);
});

test('citizen overview clusters zoom to all members and split into separately selectable observations', async t => {
  const rows = [feature('same-a'), feature('same-b', { latitude: 12.928001, longitude: 77.566001 }),
    feature('different-road', { latitude: 12.929, longitude: 77.567 })];
  const app = harness(t, { citizens: rows, zoom: 12 }); await settle();
  assert.equal(app.survey.layer.layers.length, 1, 'Nearby overview markers become one numbered group');
  const cluster = app.survey.layer.layers[0];
  assert.match(cluster.options.icon.html, />3</);
  assert.match(cluster.options.title, /3 citizen observations/);
  cluster.fire('click');
  assert.equal(app.moves.length, 1); assert.equal(app.moves[0].kind, 'fit');
  assert.equal(app.moves[0].value.length, 3, 'The extent uses every member, never an arbitrary road');
  assert.equal(app.moves[0].settings.maxZoom, 15);
  assert.equal(app.survey.evidence == null, true, 'An overview cluster does not open unrelated photo cards');
  app.map.zoom = 19; app.map.fire('zoomend');
  assert.equal(app.survey.layer.layers.length, 2, 'Street zoom separates the other road');
  const pair = app.survey.layer.layers.find(layer => layer.kind === 'cluster');
  assert.match(pair.options.icon.html, />2</);
  pair.fire('click'); app.advance(2300);
  assert.equal(app.survey.evidence.querySelectorAll('.clickable.open').length, 2, 'Coincident frames remain individually accessible');
  assert.equal(app.survey.citizenMatched, 3);
});

test('panning preserves citizen groups while zoom regroups without API reloads or count changes', async t => {
  const app = harness(t, { zoom: 12 }); await settle();
  const initial = [...app.survey.layer.layers], requests = app.requests('/gis/citizen/assessments.geojson').length;
  const count = app.survey.citizenMatched;
  assert.equal(initial.length, 1);
  assert.ok(app.requests('/gis/citizen/assessments.geojson').every(call => !new URL(call.url).searchParams.has('bbox')));
  app.map.bbox = [76, 11, 76.1, 11.1]; app.map.fire('moveend'); app.advance(500); await settle();
  assert.deepEqual(app.survey.layer.layers, initial, 'Panning does not move world-anchored groups or discard offscreen observations');
  app.map.zoom = 19; app.map.fire('zoomend'); app.advance(500); await settle();
  assert.equal(app.requests('/gis/citizen/assessments.geojson').length, requests);
  assert.equal(app.survey.layer.layers.length, 2);
  const street = [...app.survey.layer.layers]; app.map.fire('zoomend');
  assert.deepEqual(app.survey.layer.layers, street, 'An unchanged zoom retains existing markers');
  assert.equal(app.survey.citizenMatched, count);
  assert.match(app.survey.counts.textContent, /2 citizen observations/);
});

test('citizen clusters join neighbors across cell edges and retain every observation at maximum zoom', async t => {
  const zoom = 16, world = 256 * 2 ** zoom;
  const x = Math.floor((77.566 + 180) / 360 * world / 40) * 40 + 39;
  const rows = [0, 2, 80, 82, 200].map((offset, index) => feature('boundary-' + index, { longitude: (x + offset) / world * 360 - 180 }));
  const app = harness(t, { citizens: rows, zoom }); await settle();
  app.map.getMaxZoom = () => zoom;
  assert.equal(app.survey.layer.layers.length, 3, 'A two-pixel separation groups even across the fixed-grid edge');
  const seen = []; app.survey.showEvidence = (first, group = [first]) => seen.push(...group.map(item => item.id));
  for (const marker of app.survey.layer.layers) marker.fire('click');
  assert.deepEqual(seen.sort(), rows.map(row => row.id).sort());
  assert.equal(new Set(seen).size, rows.length); assert.equal(app.moves.length, 0);
  assert.equal(app.survey.citizenMatched, rows.length);
});

test('citizen clusters across the dateline use a local zoom extent instead of spanning the world', async t => {
  const rows = [feature('west', { latitude: 0, longitude: -179.99999 }), feature('east', { latitude: 0, longitude: 179.99999 })];
  const app = harness(t, { citizens: rows, zoom: 12 }); await settle();
  const markers = app.survey.layer.layers.filter(layer => layer.options.interactive !== false);
  assert.equal(markers.length, 1);
  markers[0].fire('click');
  assert.equal(app.moves[0].kind, 'fit');
  const positions = app.moves[0].value;
  assert.ok(Math.abs(positions[0][1] - positions[1][1]) < .001);
});

test('repeated selected-marker clicks do not refly or collapse an expanded original card', async t => {
  const app = harness(t); await settle();
  const marker = app.survey.layer.layers.find(layer => layer.kind === 'citizen' && layer.options.interactive !== false);
  marker.fire('click'); app.advance(2300);
  app.survey.evidence.querySelector('.clickable.open').click(); app.advance(2500);
  const expanded = app.survey.evidence.querySelector('.expanded.open');
  marker.fire('click'); app.advance(700);
  assert.equal(app.moves.length, 1);
  assert.equal(app.survey.evidence.querySelector('.expanded.open'), expanded);
  app.survey.closeEvidence(); app.advance(650); marker.fire('click'); app.advance(2300);
  assert.equal(app.moves.length, 2, 'A later explicit selection after closing can focus again');
});

test('Video repeat selection is ignored but different frames sharing coordinates remain selectable', async t => {
  const app = harness(t); await settle();
  const first = feature('same-position-frame-a', {}, 'video'), second = feature('same-position-frame-b', {}, 'video');
  app.survey.showEvidence(first); app.advance(2300);
  const preview = app.survey.evidence.querySelector('.clickable.open');
  app.survey.showEvidence(clone(first)); app.advance(2300);
  assert.equal(app.moves.length, 1);
  assert.equal(app.survey.evidence.querySelector('.clickable.open'), preview);
  app.survey.showEvidence(second); app.advance(650);
  assert.equal(app.moves.length, 2);
  assert.equal(app.survey.evidence.querySelector('.clickable.open').dataset.segmentId, 'same-position-frame-b');
});

test('Top Locations invokes the original card focus once without an intermediate zoom jump', async t => {
  const app = harness(t); await settle();
  app.survey.locations.querySelector('button').click(); app.advance(2300);
  assert.equal(app.moves.length, 1);
  assert.equal(app.moves[0].kind, 'fly'); assert.equal(app.moves[0].zoom, 19);
  assert.equal(app.moves[0].settings.duration, 1.1);
});

test('same-filter refreshes retain citizen markers while pending, unchanged or failed', async t => {
  let mode = 'normal', finish;
  const app = harness(t, { fetch: (url, init, respond) => {
    if (!url.includes('/gis/citizen/')) return respond();
    if (mode === 'pending') return new Promise(resolve => { finish = () => resolve(respond()); });
    if (mode === 'failed') return { ok: false, status: 503 };
    return respond();
  } }); await settle();
  let initial = [...app.survey.layer.layers];
  initial[0].fire('click'); app.advance(2300);
  app.map.fire('zoomend'); initial = [...app.survey.layer.layers];
  const card = app.survey.evidence.querySelector('.clickable.open');
  mode = 'pending'; const refresh = app.survey.loadCitizens(); await settle();
  assert.deepEqual(app.survey.layer.layers, initial, 'A slow refresh cannot blank the map');
  mode = 'normal'; finish(); await refresh;
  assert.deepEqual(app.survey.layer.layers, initial, 'An unchanged response cannot recreate markers');
  assert.equal(app.survey.evidence.querySelector('.clickable.open'), card);
  mode = 'failed'; await app.survey.loadCitizens();
  assert.deepEqual(app.survey.layer.layers, initial, 'A failed refresh retains the previously visible observations');
  assert.match(app.survey.notice.textContent, /Showing previous citizen results/);
  assert.equal(app.survey.evidence.querySelector('.clickable.open'), card);
});

test('night citizen markers retain original halos, dashed borders and cluster treatment', async t => {
  const rows = [feature('night-one', { created_at: '2026-10-26T19:00:00Z' }),
    feature('night-two', { created_at: '2026-10-26T19:00:00Z' }),
    feature('night-single', { created_at: '2026-10-26T19:00:00Z', latitude: 12.93, longitude: 77.568, final_severity: 'Low' })];
  const app = harness(t, { citizens: rows }); await settle();
  const halos = app.survey.layer.layers.filter(layer => layer.options.interactive === false);
  assert.equal(halos.length, 2);
  assert.ok(halos.every(layer => layer.options.fillColor === '#0F172A' && layer.options.dashArray === '4 3'));
  assert.equal(halos[0].options.radius, 20); assert.equal(halos[1].options.radius, 12);
  const cluster = app.survey.layer.layers.find(layer => layer.kind === 'cluster');
  assert.match(cluster.options.icon.html, /cluster-marker night/);
  const single = app.survey.layer.layers.find(layer => layer.kind === 'citizen' && layer.options.interactive !== false);
  assert.equal(single.options.radius, 6); assert.equal(single.options.weight, 2.5);
  assert.equal(single.options.dashArray, '5 3'); assert.equal(single.options.fillColor, '#7f1d1d');
});

test('explicit citizen database uses the current filters, clusters and evidence without requesting GIS routes', async t => {
  const rows={photos:[
    {id:1,latitude:12.93,longitude:77.57,created_at:'2026-10-30T02:00:00Z',captured_at:'2026-10-29T01:00:00Z'},
    {id:2,latitude:12.93001,longitude:77.57001,created_at:'2026-10-30T02:00:00Z',captured_at:null},
    {id:3,latitude:12.93002,longitude:77.57002,created_at:'2026-10-30T02:00:00Z',captured_at:null}],
  assessments:[
    {id:'a1',photo_id:1,status:'classified',distress_types:['Pothole (D40)'],severity:'High',stage2_confidence:.9},
    {id:'a2',photo_id:2,status:'expert_review',distress_types:['Longitudinal Crack (D00)'],severity:'Low',stage2_confidence:.4}]};
  const app=harness(t,{config:{dataSource:'supabase',supabaseUrl:'https://citizen.example.test',supabaseAnonKey:'sb_publishable_fixture'},
    fetch:async address=>{
      const url=new URL(address),table=url.pathname.split('/').at(-1),data=rows[table];
      assert.ok(data,'Citizen mode may only request photos/assessments');
      return {ok:true,status:200,headers:{get:()=>`0-${data.length-1}/${data.length}`},json:async()=>clone(data)};
    }});
  await settle();
  assert.equal(app.survey.citizenMatched,2);assert.equal(app.survey.sourceStats.total,3);
  assert.match(app.survey.notice.textContent,/3 available observations/);assert.match(app.statuses.at(-1).text,/2 of 3 citizen observations/);
  assert.equal(app.survey.layer.layers.length,1,'The current clustering remains enabled');
  assert.equal(app.survey.form.elements.namedItem('includeReview').checked,false,'Current review defaults are preserved');
  await app.change('includeReview',true);assert.equal(app.survey.citizenMatched,3);
  const captured=app.survey.features.find(f=>f.properties.photo_id==='1');
  app.survey.showEvidence(captured);assert.ok(app.survey.evidence);
  assert.match(app.survey.cardRow(captured).__gis.capturedText,/29 Oct/);
  assert.match(app.survey.evidence.textContent,/Pothole \(D40\)/);
  await app.video.setEnabled(true);await settle();
  assert.match(app.video.notice.textContent,/Drive routes are not connected/);
  assert.equal(app.video.features.length,0);assert.equal(app.video.paths.length,0);
  assert.equal(app.video.driveReplay.disabled,true);
  assert.equal(app.calls.filter(c=>new URL(c.url).pathname.startsWith('/gis/')).length,0);
  await app.video.setEnabled(false);await settle();assert.ok(app.active.has(app.survey.layer));
});

test('citizen database errors surface without a frozen-data fallback or a misleading count', async t => {
  const app=harness(t,{config:{dataSource:'supabase',supabaseUrl:'https://citizen.example.test',supabaseAnonKey:'sb_publishable_fixture'},
    fetch:async address=>({ok:false,status:403,json:async()=>({message:'read denied'})})});
  await settle();
  assert.equal(app.survey.features.length,0);assert.equal(app.survey.citizenMatched,null);
  assert.match(app.survey.notice.textContent,/HTTP 403/);assert.match(app.statuses.at(-1).text,/unavailable/);
  assert.ok(app.calls.every(c=>new URL(c.url).pathname.startsWith('/rest/v1/')));
  assert.ok(app.actions.includes('loading-finished'));
});

test('a configured GIS outage does not silently switch to the citizen database', async t => {
  const app=harness(t,{config:{dataSource:'gis',apiBase:'https://gis.example.test',supabaseUrl:'https://citizen.example.test',supabaseAnonKey:'sb_publishable_fixture'},
    fetch:async()=>({ok:false,status:503,json:async()=>({})})});
  await settle();
  assert.equal(app.survey.directCitizen,false);assert.equal(app.survey.features.length,0);
  assert.ok(app.calls.every(c=>new URL(c.url).hostname==='gis.example.test'));
  assert.match(app.survey.notice.textContent,/unavailable/);
});
