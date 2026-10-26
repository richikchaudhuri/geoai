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
  const rasters = [];
  const vectors = [];
  const removed = [];
  const activeLayers = new Set();
  const frameCallbacks = new Map();
  const cancelledFrames = new Set();
  const transforms = [];
  const evented = () => {
    const listeners = new Map();
    return {
      once(name, fn) { const entries = listeners.get(name) || []; entries.push({ fn, once: true }); listeners.set(name, entries); return this; },
      on(name, fn) { const entries = listeners.get(name) || []; entries.push({ fn }); listeners.set(name, entries); return this; },
      fire(name, event = {}) {
        const entries = listeners.get(name) || [];
        listeners.set(name, entries.filter(entry => !entry.once));
        entries.forEach(entry => entry.fn(event));
        return this;
      },
    };
  };
  const layer = () => ({
    ...evented(),
    addTo() { activeLayers.add(this); return this; }, bindTooltip() { return this; },
    clearLayers() { markers.length = 0; },
  });
  const map = {
    ...layer(), setView() { return this; },
    removeLayer(item) {
      if (activeLayers.delete(item)) { removed.push(item); item.onRemove?.(this); item._map = null; }
      return this;
    },
    flyTo() {}, flyToBounds() {}, getZoom: () => 19,
    getCenter: () => ({ lat: 12.97, lng: 77.59 }),
    getBounds: () => ({ getNorthWest: () => ({ lat: 13, lng: 77.5 }) }),
    latLngToContainerPoint: () => ({ x: 200, y: 200 }),
  };
  w.L = {
    map: () => map, control: { zoom: layer }, layerGroup: layer,
    tileLayer: (url, options) => { const raster = Object.assign(layer(), { url, options }); tiles.push(url); rasters.push(raster); return raster; },
    circleMarker: (point, style) => { markers.push({ point, style }); return layer(); },
    marker: point => { markers.push({ point }); return layer(); },
    divIcon: x => x, rectangle: layer,
    Util: {
      requestAnimFrame(fn, context) {
        const callback = () => fn.call(context);
        const id = w.requestAnimationFrame(callback);
        frameCallbacks.set(id, callback);
        return id;
      },
      cancelAnimFrame(id) { if (id !== undefined) cancelledFrames.add(id); w.cancelAnimationFrame(id); },
    },
    DomUtil: { setTransform(canvas, offset, scale) { transforms.push({ canvas, offset, scale }); } },
  };
  if (!options.noMapSDK) w.maplibregl = {};
  if (!options.noMapBridge) w.L.maplibreGL = config => {
    if (options.vectorConstructorFailure) throw new Error('Map bridge unavailable');
    const container = w.document.createElement('div');
    const visibility = new Map();
    const paint = new Map();
    const gl = {
      ...evented(), visibility, paint, jumps: [], _actualCanvas: w.document.createElement('canvas'),
      getStyle: () => ({ sources: options.vectorSources || {
        openmaptiles: { type: 'vector' }, annotations: { type: 'geojson' },
      }, layers: [
        { id: 'background', type: 'background' }, { id: 'land', type: 'fill' },
        { id: 'roads', type: 'line' }, { id: 'places', type: 'symbol', layout: { 'text-field': '{name}' } },
        { id: 'icons', type: 'symbol', layout: { 'icon-image': '{icon}' } },
      ] }),
      setLayoutProperty(id, property, value) { assert.equal(property, 'visibility'); visibility.set(id, value); },
      setPaintProperty(id, property, value) { paint.set(`${id}:${property}`, value); },
      jumpTo(view) { this.jumps.push(view); },
    };
    const vector = {
      ...layer(), config, container, gl, originalRemovals: 0, resizes: 0, zoomEnds: 0,
      _gl: options.vectorAddFailure === 'before-gl' ? null : gl,
      getContainer: () => container,
      getMaplibreMap() { return this._gl; },
      _resizeContainer() { this.resizes += 1; },
      _zoomEnd() { this.zoomEnds += 1; },
      addTo(target) {
        this._map = target;
        activeLayers.add(this);
        w.document.getElementById('map').append(container);
        if (options.vectorAddFailure) throw new Error('WebGL unavailable');
        return this;
      },
      onRemove() {
        assert.ok(this.getMaplibreMap(), 'bridge cleanup cannot run before its GL map exists');
        this.originalRemovals += 1;
        this._gl = null;
        container.remove();
      },
    };
    vectors.push(vector);
    return vector;
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
  return { w, advance, markers, requests, tiles, rasters, vectors, removed, activeLayers, frameCallbacks, cancelledFrames, transforms, read: code => vm.runInContext(code, context) };
}

test('blocked browser storage and missing Supabase SDK still load the snapshot', async t => {
  const app = await boot(t, { storageDisabled: true, noSupabase: true });
  assert.equal(app.read('allMergedRows.length'), 1);
  assert.equal(app.markers.length, 1);
  assert.equal(app.vectors.length, 1);
});

test('unknown saved map style falls back to the default basemap', async t => {
  const app = await boot(t, { style: 'obsolete-style' });
  assert.equal(app.vectors[0].config.style, 'https://tiles.openfreemap.org/styles/positron');
});

const styles = [
  ['light', 'positron', false], ['dark', 'dark', true], ['voyager', 'liberty', false],
  ['satellite', 'dark', true], ['backdrop', 'positron', false], ['toner', 'positron', false],
];

function finishVectorLoad(vector) {
  vector.gl.fire('style.load');
  for (const [sourceId, source] of Object.entries(vector.gl.getStyle().sources)) {
    if (source.type === 'vector') vector.gl.fire('sourcedata', { sourceId, coord: { z: 12, x: 2928, y: 1899 } });
  }
  vector.gl.fire('load');
}

for (const [style, vectorStyle, dark] of styles) {
  test(`${style} restores a keyless basemap with its saved selection and theme`, async t => {
    const app = await boot(t, { style });
    const vector = app.vectors[0];
    assert.equal(vector.config.style, `https://tiles.openfreemap.org/styles/${vectorStyle}`);
    assert.equal(new URL(vector.config.style).search, '');
    assert.equal(app.w.document.body.classList.contains('chrome-dark'), dark);
    assert.equal(app.w.document.querySelector('.settings-option.active').dataset.style, style);
    assert.equal(app.w.localStorage.getItem('mapStyle'), style);
    assert.equal(app.w.document.getElementById('mapNotice').hidden, true);
    assert.equal(app.rasters.length, style === 'satellite' ? 1 : 0);
    finishVectorLoad(vector);
    app.advance(20001);
    assert.equal(app.read('currentBasemap.vector'), vector);
    assert.ok(app.activeLayers.has(vector));
  });
}

test('backdrop hides symbol labels without hiding roads or land', async t => {
  const app = await boot(t, { style: 'backdrop' });
  const vector = app.vectors[0];
  vector.gl.fire('style.load');
  assert.deepEqual([...vector.gl.visibility], [['places', 'none'], ['icons', 'none']]);
  assert.equal(vector.container.style.opacity, '1');
});

test('satellite keeps its vector overlay transparent until only labels remain', async t => {
  const app = await boot(t, { style: 'satellite' });
  const vector = app.vectors[0];
  const raster = app.rasters[0];
  assert.equal(vector.container.style.opacity, '0');
  assert.equal(raster.options.maxNativeZoom, 14);
  assert.equal(raster.options.maxZoom, 22);
  assert.match(raster.url, /tiles\.maps\.eox\.at\/.*\{z\}\/\{y\}\/\{x\}\.jpg$/);
  assert.equal(new URL(raster.url).search, '');
  assert.match(raster.options.attribution, /Copernicus/);
  vector.gl.fire('style.load');
  assert.deepEqual([...vector.gl.visibility], [
    ['background', 'none'], ['land', 'none'], ['roads', 'none'],
  ]);
  assert.equal(vector.container.style.opacity, '1');
  assert.deepEqual([...vector.gl.paint], [
    ['places:text-color', '#ffffff'], ['places:text-halo-color', '#202024'],
    ['places:text-halo-width', 1.5],
  ], 'only text symbols get legible satellite label paint');
  assert.ok(app.activeLayers.has(raster));
});

test('toner applies monochrome only to its basemap and keeps distress marker colors', async t => {
  const app = await boot(t);
  const markerStyles = app.markers.map(marker => ({ ...marker.style }));
  const oldVector = app.vectors[0];
  app.w.setMapStyle('toner');
  const toner = app.vectors.at(-1);
  assert.equal(toner.container.classList.contains('map-monochrome'), true);
  assert.deepEqual([...app.w.document.querySelectorAll('.map-monochrome')], [toner.container]);
  assert.equal(app.w.document.getElementById('map').style.filter, '');
  assert.equal(app.w.document.body.style.filter, '');
  assert.deepEqual(app.markers.map(marker => ({ ...marker.style })), markerStyles);
  assert.ok(app.removed.includes(oldVector));
  app.w.setMapStyle('light');
  assert.equal(app.w.document.querySelector('.map-monochrome'), null);
  assert.equal(toner.container.isConnected, false);
  assert.equal(app.w.localStorage.getItem('mapStyle'), 'light');
});

for (const failure of ['noMapSDK', 'noMapBridge', 'vectorConstructorFailure']) {
  test(`${failure} falls back to keyless streets and reports the unavailable style`, async t => {
    const app = await boot(t, { style: 'dark', [failure]: true });
    assert.equal(app.tiles.length, 1);
    assert.equal(app.tiles[0], 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    assert.equal(app.read('currentBasemap.vector'), null);
    assert.equal(app.w.document.body.classList.contains('chrome-dark'), false);
    assert.equal(app.w.document.getElementById('mapNotice').hidden, false);
    assert.match(app.w.document.getElementById('mapNotice').textContent, /standard street map/i);
    // Keep the requested style saved so a later working browser can restore it.
    assert.equal(app.w.localStorage.getItem('mapStyle'), 'dark');
  });
}

for (const stage of ['before-gl', 'after-gl']) {
  test(`a failed WebGL add ${stage} cleans up its partial layer before fallback`, async t => {
    const app = await boot(t, { vectorAddFailure: stage });
    const vector = app.vectors[0];
    assert.equal(vector.container.isConnected, false);
    assert.equal(app.activeLayers.has(vector), false);
    assert.equal(app.removed.filter(item => item === vector).length, 1);
    assert.equal(vector.originalRemovals, stage === 'before-gl' ? 0 : 1);
    assert.equal(app.tiles[0], 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    assert.ok(app.activeLayers.has(app.rasters[0]));
  });
}

test('a vector map gets 20 seconds to load and transient tile errors can recover', async t => {
  const app = await boot(t);
  const vector = app.vectors[0];
  vector.gl.fire('error', { error: new Error('Temporary tile failure') });
  app.advance(19999);
  assert.equal(app.tiles.length, 0);
  assert.ok(app.activeLayers.has(vector));
  app.advance(1);
  assert.equal(app.tiles.length, 1);
  assert.equal(app.read('currentBasemap.vector'), null);
  assert.equal(vector.container.isConnected, false);
  app.advance(40000);
  assert.equal(app.tiles.length, 1, 'fallback must not create duplicate raster layers');
});

test('successful vector loading cancels the fallback timer', async t => {
  const app = await boot(t);
  const vector = app.vectors[0];
  app.advance(19999);
  finishVectorLoad(vector);
  app.advance(40000);
  assert.equal(app.tiles.length, 0);
  assert.equal(app.read('currentBasemap.vector'), vector);
});

for (const event of ['metadata-only', 'all-tiles-failed', 'unrelated-source']) {
  test(`vector ${event} plus load does not falsely count as a rendered basemap`, async t => {
    const app = await boot(t);
    const vector = app.vectors[0];
    vector.gl.fire('style.load');
    if (event === 'metadata-only') vector.gl.fire('sourcedata', { sourceId: 'openmaptiles', isSourceLoaded: true });
    if (event === 'all-tiles-failed') vector.gl.fire('error', { error: new Error('All tile downloads failed') });
    if (event === 'unrelated-source') vector.gl.fire('sourcedata', { sourceId: 'annotations', coord: { z: 12 } });
    vector.gl.fire('load');
    app.advance(19999);
    assert.equal(app.tiles.length, 0);
    app.advance(1);
    assert.equal(app.tiles[0], 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    assert.equal(app.activeLayers.has(vector), false);
  });
}

test('one successfully decoded vector tile can recover after other tiles failed', async t => {
  const app = await boot(t);
  const vector = app.vectors[0];
  vector.gl.fire('style.load').fire('error', { error: new Error('One tile failed') }).fire('load');
  app.advance(19999);
  vector.gl.fire('sourcedata', { sourceId: 'openmaptiles', coord: { z: 12 } });
  app.advance(40000);
  assert.equal(app.tiles.length, 0);
  assert.ok(app.activeLayers.has(vector));
});

test('every vector source needs a decoded tile but non-vector sources do not', async t => {
  const app = await boot(t, { vectorSources: {
    roads: { type: 'vector' }, places: { type: 'vector' }, annotations: { type: 'geojson' },
  } });
  const vector = app.vectors[0];
  vector.gl.fire('style.load').fire('sourcedata', { sourceId: 'roads', coord: { z: 12 } }).fire('load');
  app.advance(19000);
  assert.equal(app.tiles.length, 0);
  vector.gl.fire('sourcedata', { sourceId: 'places', coord: { z: 12 } });
  app.advance(40000);
  assert.equal(app.tiles.length, 0);
  assert.ok(app.activeLayers.has(vector));
});

test('source tiles received before style readiness still count once the style loads', async t => {
  const app = await boot(t);
  const vector = app.vectors[0];
  vector.gl.fire('sourcedata', { sourceId: 'openmaptiles', coord: { z: 12 } }).fire('load');
  app.advance(19000);
  vector.gl.fire('style.load');
  app.advance(40000);
  assert.equal(app.tiles.length, 0);
});

test('late events from a failed vector cannot alter its same-style raster replacement', async t => {
  const app = await boot(t, { style: 'toner' });
  const vector = app.vectors[0];
  app.advance(20000);
  const raster = app.rasters[0];
  const notice = app.w.document.getElementById('mapNotice').textContent;
  app.read('window.mapStages = []; LoadingScreen.setStage = stage => window.mapStages.push(stage)');
  finishVectorLoad(vector);
  vector.gl.fire('webglcontextlost');
  app.advance(0);
  assert.equal(app.w.mapStages.length, 0);
  assert.equal(vector.gl.visibility.size, 0);
  assert.equal(app.read('currentBasemap.raster'), raster);
  assert.equal(app.read('currentBasemap.vector'), null);
  assert.equal(app.rasters.length, 1);
  assert.equal(app.w.document.getElementById('mapNotice').textContent, notice);
});

test('vector transitions coalesce animation frames and preserve the live bridge transform', async t => {
  const app = await boot(t);
  const vector = app.vectors[0];
  vector._transitionEnd();
  const firstFrame = vector.transitionFrame;
  vector._transitionEnd();
  assert.ok(app.cancelledFrames.has(firstFrame));
  app.advance(16);
  assert.equal(vector.resizes, 1);
  assert.equal(app.transforms.length, 1);
  assert.equal(app.transforms[0].canvas, vector.gl._actualCanvas);
  assert.deepEqual(app.transforms[0].offset, { x: 200, y: 200 });
  assert.equal(app.transforms[0].scale, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(vector.gl.jumps)), [
    { center: { lat: 12.97, lng: 77.59 }, zoom: 18 },
  ]);
  assert.equal(vector.zoomEnds, 0);
  vector.gl.fire('moveend');
  assert.equal(vector.zoomEnds, 1);
});

test('switching basemaps cancels an outstanding transition and guards a raced callback', async t => {
  const app = await boot(t);
  const vector = app.vectors[0];
  vector._transitionEnd();
  const frame = vector.transitionFrame;
  const queuedCallback = app.frameCallbacks.get(frame);
  app.w.setMapStyle('dark');
  assert.ok(app.cancelledFrames.has(frame));
  assert.equal(vector._map, null);
  assert.equal(vector.getMaplibreMap(), null);
  app.advance(16);
  queuedCallback(); // A browser can already have dequeued RAF when removal occurs.
  assert.equal(vector.resizes, 0);
  assert.equal(vector.gl.jumps.length, 0);
  assert.equal(app.transforms.length, 0);
});

test('a transition with an unavailable GL map exits without resizing or jumping', async t => {
  const app = await boot(t);
  const vector = app.vectors[0];
  vector._transitionEnd();
  vector._gl = null;
  app.advance(16);
  assert.equal(vector.resizes, 0);
  assert.equal(vector.gl.jumps.length, 0);
});

for (const state of ['removed', 'replaced-gl']) {
  test(`late transition moveend ignores a ${state} layer`, async t => {
    const app = await boot(t);
    const vector = app.vectors[0];
    vector._transitionEnd();
    app.advance(16);
    assert.equal(vector.gl.jumps.length, 1);
    if (state === 'removed') app.w.setMapStyle('dark');
    else vector._gl = {};
    vector.gl.fire('moveend');
    assert.equal(vector.zoomEnds, 0);
  });
}

test('changing styles removes both old satellite layers and ignores every late callback', async t => {
  const app = await boot(t, { style: 'satellite' });
  const oldVector = app.vectors[0];
  const oldRaster = app.rasters[0];
  app.w.setMapStyle('dark');
  const current = app.vectors.at(-1);
  assert.ok(app.removed.includes(oldVector));
  assert.ok(app.removed.includes(oldRaster));
  app.read('window.mapStages = []; LoadingScreen.setStage = stage => window.mapStages.push(stage)');
  oldVector.gl.fire('style.load').fire('load').fire('webglcontextlost');
  oldRaster.fire('load');
  app.advance(0);
  assert.equal(oldVector.gl.visibility.size, 0);
  assert.equal(oldVector.container.style.opacity, '0');
  assert.equal(app.w.mapStages.length, 0);
  assert.equal(app.read('currentBasemap.vector'), current);
  assert.equal(app.w.document.body.classList.contains('chrome-dark'), true);
  assert.equal(app.w.document.getElementById('mapNotice').hidden, true);
  app.advance(20000);
  assert.equal(app.tiles.length, 2, 'stale events must not cancel the new style timeout');
  assert.equal(app.activeLayers.has(current), false);
});

test('current WebGL context loss falls back after its callback and resets the notice on a new style', async t => {
  const app = await boot(t);
  const vector = app.vectors[0];
  vector.gl.fire('load').fire('webglcontextlost');
  assert.equal(app.tiles.length, 0);
  app.advance(0);
  assert.equal(app.tiles.length, 1);
  assert.equal(app.w.document.getElementById('mapNotice').hidden, false);
  const fallback = app.rasters[0];
  app.w.setMapStyle('voyager');
  assert.ok(app.removed.includes(fallback));
  assert.equal(app.w.document.getElementById('mapNotice').hidden, true);
  assert.equal(app.read('currentStyle'), 'voyager');
});

for (const failure of ['noMapSDK', 'timeout', 'contextlost']) {
  test(`satellite preserves its imagery when labels fail via ${failure}`, async t => {
    const app = await boot(t, { style: 'satellite', noMapSDK: failure === 'noMapSDK' });
    const raster = app.rasters[0];
    if (failure === 'timeout') app.advance(20000);
    if (failure === 'contextlost') { app.vectors[0].gl.fire('webglcontextlost'); app.advance(0); }
    assert.equal(app.rasters.length, 1);
    assert.ok(app.activeLayers.has(raster));
    assert.equal(app.removed.includes(raster), false);
    assert.equal(app.read('currentBasemap.vector'), null);
    assert.equal(app.w.document.body.classList.contains('chrome-dark'), true);
    assert.match(app.w.document.getElementById('mapNotice').textContent, /street labels could not load over the satellite imagery/i);
  });
}

test('all failed satellite imagery tiles fall back to streets after the load callback returns', async t => {
  const app = await boot(t, { style: 'satellite' });
  const vector = app.vectors[0];
  const imagery = app.rasters[0];
  imagery.fire('loading').fire('tileerror').fire('tileerror').fire('load');
  assert.equal(app.rasters.length, 1, 'Leaflet must finish its load callback before replacing the layer');
  app.advance(0);
  assert.equal(app.rasters.length, 2);
  assert.equal(app.rasters[1].url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.ok(app.removed.includes(imagery));
  assert.ok(app.removed.includes(vector));
  assert.equal(app.w.document.body.classList.contains('chrome-dark'), false);
  assert.match(app.w.document.getElementById('mapNotice').textContent, /standard street map/i);
  imagery.fire('load'); // A removed source must not replace its successor again.
  app.advance(40000);
  assert.equal(app.rasters.length, 2);
});

test('a successful label load cannot cancel an already queued imagery failure fallback', async t => {
  const app = await boot(t, { style: 'satellite' });
  const imagery = app.rasters[0];
  imagery.fire('loading').fire('tileerror').fire('load');
  finishVectorLoad(app.vectors[0]);
  app.advance(0);
  assert.equal(app.rasters.length, 2);
  assert.equal(app.rasters[1].url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(app.activeLayers.has(imagery), false);
});

test('context loss cannot downgrade an already queued satellite imagery failure', async t => {
  const app = await boot(t, { style: 'satellite' });
  const imagery = app.rasters[0];
  imagery.fire('loading').fire('tileerror').fire('load');
  app.vectors[0].gl.fire('webglcontextlost');
  app.advance(0);
  assert.equal(app.rasters.length, 2);
  assert.equal(app.activeLayers.has(imagery), false);
});

test('failed fallback street tiles display an error without an infinite fallback loop', async t => {
  const app = await boot(t, { noMapSDK: true });
  const raster = app.rasters[0];
  raster.fire('loading').fire('tileerror').fire('load');
  app.advance(60000);
  assert.equal(app.rasters.length, 1);
  assert.ok(app.activeLayers.has(raster));
  assert.match(app.w.document.getElementById('mapNotice').textContent, /tiles could not load/i);
});

test('partially successful satellite tiles keep the imagery and each loading cycle resets its counts', async t => {
  const app = await boot(t, { style: 'satellite' });
  const imagery = app.rasters[0];
  finishVectorLoad(app.vectors[0]);
  imagery.fire('loading').fire('tileerror').fire('tileload').fire('load');
  app.advance(30000);
  assert.equal(app.rasters.length, 1);
  assert.ok(app.activeLayers.has(imagery));
  imagery.fire('loading').fire('tileerror').fire('load');
  app.advance(0);
  assert.equal(app.rasters.length, 2, 'the previous cycle success must not hide a new all-failed viewport');
});

test('switching styles cancels a queued imagery fallback and ignores stale raster errors', async t => {
  const app = await boot(t, { style: 'satellite' });
  const imagery = app.rasters[0];
  imagery.fire('loading').fire('tileerror').fire('load');
  app.w.setMapStyle('light');
  const current = app.vectors.at(-1);
  imagery.fire('load');
  app.advance(0);
  assert.equal(app.rasters.length, 1);
  assert.equal(app.read('currentBasemap.vector'), current);
  assert.equal(app.w.document.getElementById('mapNotice').hidden, true);
});

test('an unknown style request leaves the current map and stored selection intact', async t => {
  const app = await boot(t, { style: 'dark' });
  const vector = app.vectors[0];
  app.w.setMapStyle('obsolete-style');
  assert.equal(app.vectors.length, 1);
  assert.equal(app.removed.length, 0);
  assert.equal(app.read('currentBasemap.vector'), vector);
  assert.equal(app.w.localStorage.getItem('mapStyle'), 'dark');
  assert.equal(app.w.document.body.classList.contains('chrome-dark'), true);
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
