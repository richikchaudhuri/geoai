const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { buildRoute, positionAt, metres } = require('../drive-player.js');
const script = readFileSync(path.join(__dirname, '../drive-player.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const sessions = () => [
  { session_id: 'drive-a', road_name: 'First road', local_date: '2026-10-26', route_m: 100, start_utc: '2026-10-26T00:00:00Z', end_utc: '2026-10-26T00:00:10Z', track: { type: 'LineString', coordinates: [[77.5, 12.9], [77.501, 12.9], [77.502, 12.9]] } },
  { session_id: 'drive-b', road_name: '<img src=x onerror=alert(1)>', route_m: 200, track: { type: 'MultiLineString', coordinates: [[[77.5, 12.9], [77.501, 12.9]], [[77.6, 12.9], [77.601, 12.9]]] } },
];
const features = id => [5, 45, 85].map((at, k) => ({ type: 'Feature', id: `${id}-${k}`, geometry: { type: 'Point', coordinates: [77.5 + k * .001, 12.9] }, properties: { session_id: id, segment_id: `${id}-${k}`, vlm_class: 'distress', s0_m: at } }));
const captures = (id, count = 3) => Array.from({ length: count }, (_, k) => ({ type: 'Feature', id: `${id}-frame-${k}`,
  geometry: { type: 'Point', coordinates: [77.5 + k * .00001, 12.9] }, properties: {
    session_id: id, segment_id: `${id}-frame-${k}`, k, s0_m: k * 5,
    vlm_class: ['normal', 'distress', 'pending'][k % 3], has_image: true,
    thumb_url: `/frames/${id}-${k}-thumb.jpg`, preview_url: `/frames/${id}-${k}-preview.jpg`, image_url: `/frames/${id}-${k}-full.jpg`,
  } }));
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
function harness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><main><button id="video"></button></main>', { url: 'https://example.test/gis/app/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, frames = new Map(); let nextFrame = 0;
  w.requestAnimationFrame = fn => { const id = ++nextFrame; frames.set(id, fn); return id; };
  w.cancelAnimationFrame = id => frames.delete(id);
  const frame = timestamp => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(timestamp)); };
  const mapEvents = new Map(), active = new Set(), moves = [], layers = [], playback = [], calls = [], evidence = [];
  const map = { on(name, fn) { mapEvents.set(name, fn); }, off(name) { mapEvents.delete(name); }, addLayer(layer) { active.add(layer); }, removeLayer(layer) { active.delete(layer); },
    fitBounds(bounds, options) { moves.push({ kind: 'fit', bounds, options }); }, panTo(point, options) { moves.push({ kind: 'pan', point, options }); } };
  function layer(points = []) {
    const el = w.document.createElement('div'); el.innerHTML = '<span class="drive-replay-car"></span>';
    const result = { points, children: [], addLayer(l) { this.children.push(l); }, clearLayers() { this.children = []; }, addTo(target) { target.addLayer(this); return this; },
      setLatLng(point) { this.point = point; return this; }, setLatLngs(points) { this.points = points; return this; }, getElement() { return el; } };
    layers.push(result); return result;
  }
  const L = { featureGroup: () => layer(), polyline: points => layer(points), marker: (point, options) => Object.assign(layer(), { point, options }), divIcon: options => options, latLngBounds: points => points };
  const video = { enabled: options.enabled !== false, button: w.document.querySelector('#video'),
    setEnabled(value) { this.enabled = value; w.document.dispatchEvent(new w.CustomEvent('geoai:videochange')); },
    setFilters(filters) { this.filters = filters; }, selectVideo() { this.selected = true; },
    clearPlayback() { playback.push({ type: 'clear' }); }, setPlaybackData(data) { playback.push({ type: 'data', ...data }); }, setPlaybackProgress(distance) { playback.push({ type: 'progress', distance }); } };
  const catalogue = options.sessions || sessions();
  const survey = { filters: { severities: ['High'], captureTime: 'night' }, meta: { schema: 'geoai.gis.v1' },
    showEvidence(feature, group) { evidence.push({ feature, group }); }, client: {
    apiBase: 'https://api.example.test',
    async meta() { return survey.meta; }, async sessions(input) { calls.push({ type: 'sessions', input }); return { sessions: clone(catalogue) }; },
    async features(layer, filters, meta, query) { calls.push({ type: 'features', layer, filters, meta, query }); return options.features ? options.features(layer, filters, meta, query) : { features: features(filters.session), truncated: false }; },
    async driveFrames(id, meta, query) { calls.push({ type: 'driveFrames', id, meta, query }); return options.driveFrames ? options.driveFrames(id, meta, query) : { features: captures(id), truncated: false }; },
  } };
  w.eval(readFileSync(path.join(__dirname, '../gis-core.js'), 'utf8'));
  w.eval(script); const player = new w.GeoAIDrivePlayer({ map, L, video, survey });
  t.after(() => { player.destroy(); dom.window.close(); });
  return { w, player, video, survey, map, calls, moves, playback, frames, frame, active, layers, mapEvents, evidence,
    emit: name => w.document.dispatchEvent(new w.CustomEvent(name)) };
}

test('route geometry uses actual line length, clamps distance and reaches exact endpoints', () => {
  const route = buildRoute(sessions()[0]);
  assert.equal(route.duration, 10); assert.equal(route.recordedDuration, true);
  const begin = positionAt(route, -10), middle = positionAt(route, 50), end = positionAt(route, 999);
  assert.deepEqual(begin.latlng, [12.9, 77.5]);
  assert.ok(Math.abs(middle.latlng[1] - 77.501) < 1e-8);
  assert.ok(Math.abs(end.latlng[1] - 77.502) < 1e-8); assert.equal(end.distance, 100);
  assert.ok(Math.abs(middle.heading - 90) < .01);
  assert.ok(route.length > 200 && route.length < 220);
});

test('MultiLineString replay skips the geographic gap and keeps separate trail parts', () => {
  const route = buildRoute(sessions()[1]);
  const before = positionAt(route, 99.999), after = positionAt(route, 100.001);
  assert.ok(before.latlng[1] < 77.502); assert.ok(after.latlng[1] > 77.599);
  assert.equal(before.part, 0); assert.equal(after.part, 1);
  assert.equal(after.visited.length, 2);
  assert.ok(route.length < 250, 'the 10 km gap must not count as recorded track');
  assert.equal(route.recordedDuration, false); assert.equal(route.duration, 24);
});

test('dateline interpolation takes the short crossing and duplicate GPS points are harmless', () => {
  const route = buildRoute({ route_m: 100, track: { type: 'LineString', coordinates: [[179.9, 0], [179.9, 0], [-179.9, 0]] } });
  assert.ok(Math.abs(Math.abs(positionAt(route, 50).latlng[1]) - 180) < 1e-8);
  const trail = positionAt(route, 100).visited[0];
  assert.ok(Math.abs(trail.at(-1)[1] - trail[0][1]) < 1, 'rendered trail must not draw across the world at the dateline');
  assert.ok(route.length > 22000 && route.length < 23000);
  assert.ok(metres([179.9, 0], [-179.9, 0]) < 23000);
});

test('missing, zero length and malformed tracks cannot become invented routes', () => {
  for (const session of [{ route_m: 0, track: sessions()[0].track }, { route_m: 10, track: null }, { route_m: 10, track: { type: 'LineString', coordinates: [[1, 2], [1, 2]] } }, { route_m: 10, track: { type: 'LineString', coordinates: [[999, 2], [1, 2]] } }]) assert.throws(() => buildRoute(session), /usable/);
});

test('Video toggle only reveals launcher and never opens, fetches, moves or autoplays', t => {
  const h = harness(t, { enabled: false });
  assert.equal(h.player.launcher.hidden, true);
  h.video.setEnabled(true);
  assert.equal(h.player.launcher.hidden, false); assert.equal(h.player.panel.hidden, true);
  assert.equal(h.calls.length, 0); assert.equal(h.moves.length, 0); assert.equal(h.frames.size, 0);
});

test('opening loads the full selected drive and aligns viewport/export drive selection without changing citizen filters', async t => {
  const h = harness(t); const originalFilters = clone(h.survey.filters);
  await h.player.open('drive-b');
  assert.equal(h.player.ready, true); assert.equal(h.player.playing, false);
  assert.equal(h.player.session.session_id, 'drive-b'); assert.equal(h.player.features.length, 3);
  const call = h.calls.find(c => c.type === 'features');
  assert.equal(call.layer, 'video'); assert.equal(call.filters.session, 'drive-b'); assert.equal(call.filters.captureTime, 'night');
  assert.equal(call.query.bbox, undefined); assert.equal(call.query.geom, 'point'); assert.equal(call.query.max, 5000);
  assert.deepEqual(clone(h.survey.filters), { ...originalFilters, session: 'drive-b' });
  assert.equal(h.video.filters.session, 'drive-b');
  assert.equal(h.moves.length, 1); assert.equal(h.moves[0].kind, 'fit'); assert.equal(h.frames.size, 0);
  assert.equal(h.player.select.querySelector('img'), null);
  assert.match(h.player.select.textContent, /<img/);
  assert.equal(h.w.document.body.classList.contains('drive-replay-open'), true);
});

test('play, speed, scrub, resume and completion respect recorded duration', async t => {
  const h = harness(t); await h.player.open('drive-a');
  h.player.play(); h.frame(0); h.frame(100);
  assert.equal(h.player.distance, 1); assert.equal(h.player.playing, true);
  h.player.speedInput.value = '16'; h.player.speedInput.dispatchEvent(new h.w.Event('change'));
  h.frame(200); assert.equal(h.player.distance, 17);
  h.player.slider.value = '50'; h.player.slider.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.player.distance, 50); assert.equal(h.player.playing, false); assert.equal(h.frames.size, 0);
  assert.match(h.player.message.textContent, /^Paused\./);
  assert.match(h.player.encountered.textContent, /^2 \/ 3/);
  h.player.play(); h.frame(300); h.frame(550); h.frame(800);
  assert.equal(h.player.distance, 100); assert.equal(h.player.playing, false); assert.equal(h.frames.size, 0);
  assert.match(h.player.message.textContent, /complete/);
  h.player.play(); assert.equal(h.player.distance, 0);
});

test('stalled frame clocks cannot jump a route and follow is opt-in', async t => {
  const h = harness(t); await h.player.open('drive-a');
  h.player.play(); h.frame(0); h.frame(60000);
  assert.equal(h.player.distance, 2.5); assert.equal(h.moves.filter(m => m.kind === 'pan').length, 0);
  h.player.follow.checked = true; h.player.seek(20);
  assert.equal(h.moves.filter(m => m.kind === 'pan').length, 1);
  h.mapEvents.get('dragstart')(); assert.equal(h.player.follow.checked, false);
});

test('opening evidence, native pause, pagehide and hidden documents stop all frames without auto-resume', async t => {
  const h = harness(t); await h.player.open();
  for (const event of ['geoai:evidenceopen', 'geoai:app-pause']) {
    h.player.play(); h.emit(event); assert.equal(h.player.playing, false); assert.equal(h.frames.size, 0);
  }
  h.player.play(); h.w.dispatchEvent(new h.w.Event('pagehide')); assert.equal(h.frames.size, 0);
  h.player.play(); Object.defineProperty(h.w.document, 'hidden', { value: true, configurable: true }); h.emit('visibilitychange');
  assert.equal(h.player.playing, false); assert.equal(h.frames.size, 0);
  Object.defineProperty(h.w.document, 'hidden', { value: false, configurable: true }); h.emit('visibilitychange');
  assert.equal(h.player.playing, false);
});

test('viewport Video updates preserve playback but disabling Video cleans everything', async t => {
  const h = harness(t); await h.player.open(); h.player.play(); h.frame(0); h.frame(100);
  h.emit('geoai:videochange'); assert.equal(h.player.playing, true); assert.equal(h.player.distance, 1);
  h.video.setEnabled(false);
  assert.equal(h.player.isOpen, false); assert.equal(h.frames.size, 0); assert.equal(h.player.launcher.hidden, true);
  assert.equal(h.active.size, 0); assert.equal(h.playback.at(-1).type, 'clear');
});

test('Escape consumed by an evidence card leaves the paused player available', async t => {
  const h = harness(t); await h.player.open();
  h.player.play(); h.emit('geoai:evidenceopen');
  const cardEscape = new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  cardEscape.preventDefault(); // The earlier original-card handler consumed it.
  h.w.document.dispatchEvent(cardEscape);
  assert.equal(h.player.isOpen, true);
  assert.equal(h.player.playing, false);
  h.w.document.dispatchEvent(new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(h.player.isOpen, false, 'a second Escape can close the player');
});

test('closing aborts pending route results so late resolution cannot draw or move the map', async t => {
  let finish; const h = harness(t, { features: () => new Promise(resolve => { finish = resolve; }) });
  const opening = h.player.open(); await settle();
  const call = h.calls.find(c => c.type === 'features');
  h.player.close(); assert.equal(call.query.signal.aborted, true);
  finish({ features: features('drive-a'), truncated: false }); await opening;
  assert.equal(h.player.ready, false); assert.equal(h.moves.length, 0); assert.equal(h.active.size, 0);
  assert.equal(h.playback.filter(c => c.type === 'data').length, 0);
});

test('session races keep only the latest selected route and abort the earlier load', async t => {
  let finishA; const h = harness(t, { features: (layer, filters) => filters.session === 'drive-a' ? new Promise(resolve => { finishA = resolve; }) : Promise.resolve({ features: features('drive-b'), truncated: false }) });
  const opening = h.player.open('drive-a'); await settle();
  await h.player.load('drive-b');
  finishA({ features: features('drive-a'), truncated: false }); await opening;
  assert.equal(h.player.session.session_id, 'drive-b'); assert.equal(h.player.route.distance, 200);
  assert.equal(h.calls.find(c => c.type === 'features').query.signal.aborted, true);
  assert.equal(h.playback.filter(c => c.type === 'data').length, 1);
});

test('filter changes pause and reload without using stale distress or losing the chosen drive', async t => {
  const h = harness(t); await h.player.open('drive-b'); h.player.play();
  h.survey.filters = { ...h.survey.filters, labels: ['Potholes'] };
  h.emit('geoai:filterschange'); await settle();
  assert.equal(h.player.playing, false); assert.equal(h.player.ready, true);
  assert.equal(h.player.session.session_id, 'drive-b');
  assert.equal(h.moves.filter(m => m.kind === 'fit').length, 1, 'filter-only reload must preserve the camera');
  assert.deepEqual(Array.from(h.calls.filter(c => c.type === 'features').at(-1).filters.labels), ['Potholes']);
});

test('empty matching distress still permits a valid route and failed/oversized requests are explicit', async t => {
  const h = harness(t, { features: async () => ({ features: [], truncated: false }) });
  await h.player.open(); assert.equal(h.player.ready, true); assert.match(h.player.message.textContent, /^0 matching/);
  h.survey.client.features = async () => ({ features: [], truncated: true });
  await h.player.load('drive-a'); assert.equal(h.player.ready, false); assert.match(h.player.message.textContent, /Narrow the filters/); assert.equal(h.player.retryButton.hidden, false);
  h.survey.client.features = async () => { throw new Error('Survey service unavailable'); };
  await h.player.load('drive-a'); assert.equal(h.player.ready, false); assert.match(h.player.message.textContent, /unavailable/);
});

test('an unavailable requested drive cannot silently replay a different drive', async t => {
  const h = harness(t); await h.player.open('missing');
  assert.equal(h.player.ready, false); assert.equal(h.moves.length, 0); assert.match(h.player.message.textContent, /selected drive is unavailable/);
});

test('short landscape maps reserve the side panel and leave the route visible on the left', async t => {
  const h = harness(t); h.map.getSize = () => ({ x: 812, y: 375 });
  await h.player.open();
  const padding = h.moves[0].options;
  assert.ok(padding.paddingTopLeft[1] + padding.paddingBottomRight[1] < 375);
  assert.equal(padding.paddingTopLeft[1], 75); assert.equal(padding.paddingBottomRight[1], 24);
  assert.equal(padding.paddingBottomRight[0], 812 * .46 + 20);
  assert.ok(padding.paddingTopLeft[0] + padding.paddingBottomRight[0] < 812 * .55);
});

test('portrait maps retain bottom-panel padding', async t => {
  const h = harness(t); h.map.getSize = () => ({ x: 375, y: 812 });
  await h.player.open();
  const padding = h.moves[0].options;
  assert.equal(padding.paddingBottomRight[0], 24); assert.equal(padding.paddingBottomRight[1], 280);
});

test('destroy cancels requests, animation and event handlers and removes the player UI', async t => {
  const h = harness(t); await h.player.open(); h.player.play();
  h.player.destroy();
  assert.equal(h.frames.size, 0); assert.equal(h.mapEvents.size, 0); assert.equal(h.w.document.querySelector('#driveReplayPanel'), null);
  h.video.setEnabled(true); h.emit('geoai:filterschange');
  assert.equal(h.player.isOpen, false);
});

test('Replay focuses the car at street zoom and repeated Replay preserves its current progress', async t => {
  const h = harness(t); h.map.getZoom = () => 12; h.map.getMaxZoom = () => 22;
  await h.player.open('drive-a');
  assert.deepEqual(clone(h.moves[0].bounds), [[12.9, 77.5]], 'focus is the car, not the full route');
  assert.equal(h.moves[0].options.maxZoom, 18);
  h.player.seek(50);
  await h.player.open('drive-a');
  assert.equal(h.player.distance, 50);
  assert.deepEqual(clone(h.moves.at(-1).bounds), [clone(h.player.vehicle.point)]);
  assert.equal(h.moves.at(-1).options.maxZoom, 18);
});

test('Replay keeps a closer zoom and respects the available map zoom limit', async t => {
  const h = harness(t); h.map.getZoom = () => 20; h.map.getMaxZoom = () => 22;
  await h.player.open('drive-a');
  assert.equal(h.moves.at(-1).options.maxZoom, 20);
  h.map.getZoom = () => 12; h.map.getMaxZoom = () => 16;
  await h.player.open('drive-a');
  assert.equal(h.moves.at(-1).options.maxZoom, 16);
});

test('filter-only replay refresh leaves the camera alone even with Follow enabled', async t => {
  const h = harness(t); await h.player.open('drive-a');
  h.player.follow.checked = true;
  const count = h.moves.length;
  h.survey.filters = { ...h.survey.filters, labels: ['Potholes'] };
  h.emit('geoai:filterschange'); await settle();
  assert.equal(h.player.ready, true); assert.equal(h.player.follow.checked, true);
  assert.equal(h.moves.length, count);
});

test('captured frames include every class and navigation seeks the car while retaining full-resolution images for details', async t => {
  const h = harness(t, { driveFrames: async id => ({ features: captures(id).reverse(), truncated: false }) });
  await h.player.open('drive-a'); await settle();
  assert.deepEqual(Array.from(h.player.captureFrames, f => f.properties.vlm_class), ['normal', 'distress', 'pending']);
  assert.equal(h.player.frameCount.textContent, '3');
  assert.equal(h.player.frameViewer.hidden, false); assert.equal(h.player.previousFrame.disabled, true);
  assert.equal(h.player.activeCaptureIndex, 0);
  assert.equal(h.player.frameImage.querySelector('img').src, 'https://api.example.test/frames/drive-a-0-preview.jpg');
  assert.equal(h.player.frameGrid.querySelector('img').src, 'https://api.example.test/frames/drive-a-0-thumb.jpg');
  assert.equal(h.player.panel.querySelector('img[src$="-full.jpg"]'), null, 'full resolution is not fetched automatically');
  const call = h.calls.find(c => c.type === 'driveFrames');
  assert.equal(call.id, 'drive-a'); assert.deepEqual(Object.keys(call.query), ['signal']);
  h.player.play(); h.player.nextFrame.click();
  assert.equal(h.player.playing, false); assert.equal(h.player.distance, 5); assert.equal(h.player.activeCaptureIndex, 1);
  assert.deepEqual(clone(h.moves.at(-1).bounds), [clone(h.player.vehicle.point)]);
  h.player.nextFrame.click(); assert.equal(h.player.nextFrame.disabled, true); assert.equal(h.player.distance, 10);
  h.player.previousFrame.click(); assert.equal(h.player.activeCaptureIndex, 1);
  h.player.seek(6.75); h.player.play();
  h.player.frameDetails.click();
  assert.equal(h.player.playing, false); assert.equal(h.player.distance, 6.75, 'opening details does not rewind progress to the sampled frame');
  assert.equal(h.player.isOpen, true); assert.equal(h.player.panel.hidden, false);
  assert.equal(h.player.frameInfo.hidden, false); assert.equal(h.player.frameDetails.getAttribute('aria-expanded'), 'true');
  assert.match(h.player.frameInfo.textContent, /5\.0 m/);
  assert.equal(h.player.frameInfo.querySelector('a').href, 'https://api.example.test/frames/drive-a-1-full.jpg');
  assert.equal(h.evidence.length, 0, 'photo details never open the separate evidence card');
  assert.equal(h.w.document.body.classList.contains('gis-cards-open'), false);
});

test('inline photo details update in place across frame navigation and preview playback resumes without closing', async t => {
  const rows = captures('drive-a');
  Object.assign(rows[0].properties, { final_labels: ['Normal'], final_severity: 'None', confidence: 0, expert_reviewed: true });
  Object.assign(rows[1].properties, { final_labels: ['Potholes'], final_severity: 'High', confidence: .91, needs_expert_review: true });
  const h = harness(t, { driveFrames: async () => ({ features: rows, truncated: false }) });
  await h.player.open('drive-a'); await settle();
  const panel = h.player.panel, viewer = h.player.frameViewer, info = h.player.frameInfo;
  h.player.frameImage.click();
  assert.equal(info.hidden, false); assert.match(info.textContent, /Normal/); assert.match(info.textContent, /0%/);
  h.player.nextFrame.click();
  assert.equal(info.hidden, false); assert.match(info.textContent, /Potholes/); assert.match(info.textContent, /91%/);
  assert.match(info.textContent, /Awaiting expert review/);
  h.player.previousFrame.click();
  assert.equal(info.hidden, false); assert.match(info.textContent, /Expert reviewed/); assert.doesNotMatch(info.textContent, /Potholes/);
  h.player.previewPlayButton.click(); h.frame(0); h.frame(250);
  assert.equal(h.player.playing, true); assert.ok(h.player.distance > 0);
  assert.match(h.player.previewPlayButton.getAttribute('aria-label'), /^Pause/);
  h.player.previewPlayButton.click();
  assert.equal(h.player.playing, false); assert.equal(h.player.isOpen, true); assert.equal(panel.hidden, false);
  assert.equal(h.player.panel, panel); assert.equal(h.player.frameViewer, viewer); assert.equal(h.player.frameInfo, info);
  assert.equal(info.hidden, false); assert.equal(h.evidence.length, 0);
  h.player.frameDetails.click();
  assert.equal(info.hidden, true); assert.equal(h.player.isOpen, true); assert.equal(viewer.hidden, false);
});

test('same-drive inspection selects the clicked frame inline and rejects unrelated evidence', async t => {
  const h = harness(t); await h.player.open('drive-a'); await settle();
  const selected = h.player.captureFrames[1];
  h.player.play();
  assert.equal(h.player.inspectFeature(selected), true);
  assert.equal(h.player.playing, false); assert.equal(h.player.distance, 5);
  assert.equal(h.player.selectedFrame, selected); assert.equal(h.player.activeCaptureIndex, 1);
  assert.equal(h.player.frameInfo.hidden, false); assert.equal(h.player.isOpen, true);
  assert.deepEqual(clone(h.moves.at(-1).bounds), [clone(h.player.vehicle.point)]);
  const moves = h.moves.length;
  assert.equal(h.player.inspectFeature({ type: 'Feature', id: 'citizen', properties: { layer: 'citizen', session_id: 'drive-a', s0_m: 15 } }), false);
  assert.equal(h.player.inspectFeature(captures('drive-b')[0]), false);
  assert.equal(h.player.inspectFeature(null), false);
  assert.equal(h.player.distance, 5); assert.equal(h.player.selectedFrame, selected); assert.equal(h.moves.length, moves);
  assert.equal(h.evidence.length, 0);
  h.player.close();
  assert.equal(h.player.inspectFeature(selected), false); assert.equal(h.player.frameInfo.hidden, true);
});

test('clicked frame stays inspectable while the full collection loads and joins navigation when available', async t => {
  let finish;
  const rows = captures('drive-a');
  const h = harness(t, { driveFrames: () => new Promise(resolve => { finish = resolve; }) });
  await h.player.open('drive-a'); await settle();
  assert.equal(h.player.ready, true); assert.equal(h.player.captureFrames.length, 0);
  assert.equal(h.player.inspectFeature(rows[1]), true);
  assert.equal(h.player.distance, 5); assert.equal(h.player.selectedFrame, rows[1]);
  assert.equal(h.player.frameViewer.hidden, false); assert.equal(h.player.frameInfo.hidden, false);
  assert.match(h.player.frameCaption.textContent, /Selected frame/);
  assert.equal(h.player.previousFrame.disabled, true); assert.equal(h.player.nextFrame.disabled, true);
  finish({ features: rows, truncated: false }); await settle();
  assert.equal(h.player.selectedFrame.id, rows[1].id); assert.equal(h.player.activeCaptureIndex, 1);
  assert.equal(h.player.frameInfo.hidden, false); assert.equal(h.player.distance, 5);
  assert.equal(h.player.previousFrame.disabled, false); assert.equal(h.player.nextFrame.disabled, false);
  assert.equal(h.evidence.length, 0);
});

test('inline evidence uses safe text and photo links, preserves authoritative metadata, and handles missing photos', t => {
  const h = harness(t), d = h.w.document, row = captures('drive-a')[0];
  Object.assign(row.properties, { final_labels: ['<img src=x onerror=alert(1)>'], labels: ['Normal'], confidence: 0,
    preview_url: 'javascript:alert(1)', thumb_url: 'data:text/html,unsafe', image_url: 'javascript:alert(1)' });
  const render = options => h.w.geoaiRenderDriveEvidence(d, row, { apiBase: 'https://api.example.test', showImage: true, ...options });
  const unsafe = render();
  assert.equal(unsafe.querySelector('img'), null); assert.equal(unsafe.querySelector('a'), null);
  assert.match(unsafe.textContent, /Image unavailable/); assert.match(unsafe.textContent, /<img src=x/); assert.match(unsafe.textContent, /0%/);
  const formatted = render({ row: { __gis: { previewURL: '/safe-preview.jpg', fullURL: '/safe-full.jpg',
    reviewText: 'Expert corrected severity', capturedText: '26 Oct 2026, 1:30 pm IST', extraRows: [['Accuracy', '±6 m'], ['Source', 'Drive video']] } } });
  assert.equal(formatted.querySelector('img').src, 'https://api.example.test/safe-preview.jpg');
  const full = formatted.querySelector('a');
  assert.equal(full.href, 'https://api.example.test/safe-full.jpg'); assert.equal(full.target, '_blank'); assert.equal(full.rel, 'noopener noreferrer');
  assert.match(formatted.textContent, /Expert corrected severity/); assert.match(formatted.textContent, /1:30 pm IST/); assert.match(formatted.textContent, /±6 m/);
  formatted.querySelector('img').dispatchEvent(new h.w.Event('error'));
  assert.equal(formatted.querySelector('img'), null); assert.match(formatted.textContent, /Image unavailable/);
  row.properties.has_image = false;
  const missing = render({ row: { __gis: { previewURL: '/safe-preview.jpg', fullURL: '/safe-full.jpg' } } });
  assert.equal(missing.querySelector('img'), null); assert.equal(missing.querySelector('a'), null); assert.match(missing.textContent, /No captured image/);
});

test('playback and scrubbing advance the captured-frame preview, and all thumbnails remain reachable', async t => {
  const h = harness(t, { driveFrames: async id => ({ features: captures(id, 27), truncated: false }) });
  await h.player.open('drive-b'); await settle();
  assert.equal(h.player.frameCount.textContent, '27'); assert.equal(h.player.frameGrid.children.length, 12);
  assert.match(h.player.frameMore.textContent, /15 remaining/);
  h.player.frameMore.click(); assert.equal(h.player.frameGrid.children.length, 24);
  h.player.frameMore.click(); assert.equal(h.player.frameGrid.children.length, 27); assert.equal(h.player.frameMore.hidden, true);
  h.player.frameGrid.children[26].click();
  assert.equal(h.player.distance, 130); assert.equal(h.player.activeCaptureIndex, 26);
  assert.equal(h.player.frameGrid.children[26].getAttribute('aria-current'), 'true');
  h.player.slider.value = '23'; h.player.slider.dispatchEvent(new h.w.Event('input'));
  assert.equal(h.player.activeCaptureIndex, 4); assert.match(h.player.frameCaption.textContent, /Frame 5 · 20 m/);
  h.player.speedInput.value = '16'; h.player.speedInput.dispatchEvent(new h.w.Event('change'));
  h.player.play(); h.frame(0); h.frame(250);
  assert.ok(h.player.activeCaptureIndex > 4, 'the preview follows the moving car without requiring a thumbnail click');
});

test('unsafe, missing and broken frame images show honest placeholders and labels are safe text', async t => {
  const rows = captures('drive-a', 4);
  Object.assign(rows[0].properties, { preview_url: 'javascript:alert(1)', thumb_url: 'data:text/html,<script>alert(1)</script>', final_labels: ['<img src=x onerror=alert(1)>'] });
  Object.assign(rows[1].properties, { has_image: false });
  Object.assign(rows[3].properties, { s0_m: null });
  const h = harness(t, { driveFrames: async () => ({ features: rows, truncated: false }) });
  await h.player.open('drive-a'); await settle();
  assert.equal(h.player.frameImage.querySelector('img'), null); assert.match(h.player.frameImage.textContent, /Image unavailable/);
  assert.match(h.player.frameCaption.textContent, /<img src=x/); assert.equal(h.player.frameCaption.querySelector('img'), null);
  h.player.nextFrame.click();
  assert.equal(h.player.frameImage.querySelector('img'), null); assert.match(h.player.frameImage.textContent, /No captured image/);
  assert.equal(h.player.frameGrid.children[1].querySelector('img'), null);
  h.player.nextFrame.click(); const img = h.player.frameImage.querySelector('img');
  img.dispatchEvent(new h.w.Event('error'));
  assert.equal(h.player.frameImage.querySelector('img'), null); assert.match(h.player.frameImage.textContent, /Image unavailable/);
  const distance = h.player.distance; h.player.nextFrame.click();
  assert.equal(h.player.distance, distance, 'a frame without recorded distance cannot invent a car position');
  assert.match(h.player.frameCaption.textContent, /Distance unavailable/);
});

test('late captured-frame results cannot replace another drive or reopen a closed player', async t => {
  let finishA, finishClosed;
  const h = harness(t, { driveFrames: id => id === 'drive-a'
    ? new Promise(resolve => { finishA = resolve; }) : Promise.resolve({ features: captures(id, 5), truncated: false }) });
  await h.player.open('drive-a'); await settle();
  const first = h.calls.find(c => c.type === 'driveFrames');
  await h.player.load('drive-b'); await settle();
  finishA({ features: captures('drive-a'), truncated: false }); await settle();
  assert.equal(first.query.signal.aborted, true); assert.equal(h.player.frameCount.textContent, '5');
  assert.ok(h.player.captureFrames.every(f => f.properties.session_id === 'drive-b'));
  h.survey.client.driveFrames = () => new Promise(resolve => { finishClosed = resolve; });
  await h.player.load('drive-a'); await settle(); h.player.close();
  finishClosed({ features: captures('drive-a'), truncated: false }); await settle();
  assert.equal(h.player.captureFrames.length, 0); assert.equal(h.player.frameGrid.children.length, 0);
  assert.equal(h.player.frameViewer.hidden, true); assert.equal(h.player.panel.hidden, true);
});

test('frame failure, retry, empty and oversized collections leave route replay usable', async t => {
  let attempts = 0;
  const h = harness(t, { driveFrames: async id => {
    if (++attempts === 1) throw new Error('temporarily unavailable');
    return { features: captures(id), truncated: false };
  } });
  await h.player.open('drive-a'); await settle();
  assert.equal(h.player.ready, true); assert.equal(h.player.frameRetry.hidden, false);
  assert.match(h.player.frameStatus.textContent, /still replay the route/);
  h.player.play(); assert.equal(h.player.playing, true); h.player.pause();
  h.player.frameRetry.click(); await settle();
  assert.equal(h.player.frameRetry.hidden, true); assert.equal(h.player.captureFrames.length, 3);
  h.survey.client.driveFrames = async () => ({ features: [], truncated: false });
  await h.player.load('drive-a'); await settle();
  assert.equal(h.player.ready, true); assert.equal(h.player.frameViewer.hidden, true); assert.match(h.player.frameStatus.textContent, /No captured frames/);
  h.survey.client.driveFrames = async () => ({ features: captures('drive-a'), truncated: true });
  await h.player.load('drive-a'); await settle();
  assert.equal(h.player.ready, true); assert.equal(h.player.captureFrames.length, 0); assert.equal(h.player.frameRetry.hidden, false);
  assert.match(h.player.frameStatus.textContent, /No partial gallery/);
});

test('expanded photo details reserve enough map space to keep the car outside both side cards', async t => {
  const h = harness(t), d = h.w.document;
  const inspector = d.createElement('section'); inspector.className = 'drive-inspector';
  inspector.getBoundingClientRect = () => ({ left: 416, right: 1176, width: 760, top: 110, bottom: 770, height: 660 });
  d.querySelector('main').append(inspector); inspector.append(h.player.panel);
  const menu = d.createElement('div'); menu.className = 'video-drive-card';
  menu.getBoundingClientRect = () => ({ right: 304, bottom: 485, width: 280, height: 294 }); d.body.append(menu);
  h.map.getSize = () => ({ x: 1200, y: 855 });
  await h.player.open('drive-a'); await settle(); h.player.frameDetails.click();
  const { paddingTopLeft: start, paddingBottomRight: end } = h.moves.at(-1).options;
  const carX = (1200 + start[0] - end[0]) / 2, carY = (855 + start[1] - end[1]) / 2;
  assert.ok(carX < 416 && carX > 20, 'car remains left of the expanded photograph');
  assert.ok(carY > 485 && carY < 835, 'car remains below the left drive menu');
  assert.equal(h.player.isOpen, true); assert.equal(h.player.frameInfo.hidden, false);
});
