const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const source = readFileSync(path.join(root, 'app.js'), 'utf8');
const basemapsSource = readFileSync(path.join(root, 'basemaps.js'), 'utf8');
const gisCoreSource = readFileSync(path.join(root, 'gis-core.js'), 'utf8');
const photo = { id: 'p1', latitude: 12.97, longitude: 77.59, image_url: 'https://example.com/photo.jpg', created_at: '2026-04-01T06:00:00Z' };
const assessment = { ...photo, id: 'a1', photo_id: 'p1', status: 'classified', severity: 'Low', distress_types: ['Pothole (D40)'] };

async function boot(t, options = {}) {
  const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'outside-only' });
  t.after(() => {
    try { vm.runInContext('window.geoaiVideoPaths?.destroy(); window.geoaiSurvey?.controller?.abort(); basemapManager.destroy()', dom.getInternalVMContext()); } catch (_) {}
    dom.window.close();
  });
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
  w.HTMLCanvasElement.prototype.getContext = () => options.noCanvas ? null : new Proxy({}, { get: () => () => {}, set: () => true });
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
      off(name, fn) {
        if (!name) listeners.clear();
        else if (!fn) listeners.delete(name);
        else listeners.set(name, (listeners.get(name) || []).filter(entry => entry.fn !== fn));
        return this;
      },
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
  const viewport = { center: { lat: 12.97, lng: 77.59 }, zoom: 19 };
  const attributions = new Set();
  const map = {
    ...layer(), setView() { return this; },
    attributionControl: { addAttribution(value) { attributions.add(value); }, removeAttribution(value) { attributions.delete(value); }, getContainer() { return null; } },
    hasLayer(item) { return activeLayers.has(item); },
    removeLayer(item) {
      if (activeLayers.delete(item)) { removed.push(item); item.onRemove?.(this); item._map = null; }
      return this;
    },
    flyTo() {}, flyToBounds() {}, getZoom: () => viewport.zoom,
    getCenter: () => viewport.center,
    getSize: () => ({ x: 1024, y: 768 }),
    getBounds: () => ({
      getNorthWest: () => ({ lat: 13, lng: 77.5 }),
      getWest: () => viewport.center.lng - 0.001, getEast: () => viewport.center.lng + 0.001,
      getNorth: () => viewport.center.lat + 0.001, getSouth: () => viewport.center.lat - 0.001,
    }),
    latLngToContainerPoint: () => ({ x: 200, y: 200 }),
  };
  w.L = {
    map: (id, options) => { map.options = options; return map; }, control: { zoom: layer }, layerGroup: layer,
    featureGroup: layer, canvas: options => ({ options }),
    tileLayer: (url, options) => {
      const container = w.document.createElement('div');
      const raster = Object.assign(layer(), {
        url, options: { ...options }, container, pending: false,
        getContainer: () => container, getAttribution: () => options.attribution,
        setOpacity(value) { this.options.opacity = value; container.style.opacity = String(value); return this; },
        setZIndex(value) { container.style.zIndex = String(value); return this; },
        isLoading() { return this.pending; },
        addTo(target) { this._map = target; activeLayers.add(this); w.document.getElementById('map').append(container); return this; },
        onRemove() { container.remove(); },
      });
      tiles.push(url); rasters.push(raster); return raster;
    },
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
    const paint = new Map([['places:text-color', '#111111'], ['places:text-halo-color', '#eeeeee'], ['places:text-halo-width', 1]]);
    const gl = {
      ...evented(), visibility, paint, jumps: [], _actualCanvas: w.document.createElement('canvas'),
      tilesLoaded: true, styleLoaded: true, mapLoaded: true,
      getCanvas() { return this._actualCanvas; },
      isStyleLoaded() { return this.styleLoaded; },
      areTilesLoaded() { return this.tilesLoaded; },
      loaded() { return this.mapLoaded; },
      getCenter: () => viewport.center, getZoom: () => viewport.zoom - 1,
      getLayoutProperty(id, property) { return visibility.get(id) ?? 'visible'; },
      getPaintProperty(id, property) { return paint.get(`${id}:${property}`); },
      getStyle: () => ({ sources: options.vectorSources || {
        openmaptiles: { type: 'vector' }, annotations: { type: 'geojson' },
      }, layers: [
        { id: 'background', type: 'background' }, { id: 'land', type: 'fill' },
        { id: 'roads', type: 'line' }, { id: 'places', type: 'symbol', layout: { 'text-field': '{name}' }, paint: { 'text-color': '#111111', 'text-halo-color': '#eeeeee', 'text-halo-width': 1 } },
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
  if (options.cacheEntry) w.localStorage.setItem('geoai:dataCache:v4', JSON.stringify(options.cacheEntry));
  if (options.style) w.localStorage.setItem('mapStyle', options.style);
  if (options.storageDisabled) Object.defineProperty(w, 'localStorage', { get() { throw new Error('Storage disabled'); } });
  const tables = options.tables || { photos: [photo], assessments: [assessment] };
  const requests = [];
  let supabaseClientCount = 0;
  if (!options.noSupabase) {
    w.supabase = { createClient: () => ({ from(table) {
      let signal;
      return { select() { return this; }, order() { return this; }, abortSignal(value) { signal = value; return this; }, async range(start, end) {
        requests.push({ table, start, end, signal });
        if (options.range) return options.range({ table, start, end, signal });
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
  if (w.supabase) {
    const createClient = w.supabase.createClient;
    w.supabase.createClient = (...args) => { supabaseClientCount++; return createClient(...args); };
  }
  const network = [], fetcher = w.fetch;
  w.fetch = (...args) => { network.push(args[0]); return fetcher(...args); };
  const context = dom.getInternalVMContext();
  if (options.fullGIS) vm.runInContext(gisCoreSource, context);
  vm.runInContext(basemapsSource, context);
  if (options.stalledMapStartup) {
    w.GeoAIBasemaps = class extends w.GeoAIBasemaps {
      start(initialKey) { super.start(initialKey); return new Promise(() => {}); }
    };
  }
  vm.runInContext(source.replace(/loadAssessments\(\);\s*$/, 'window.initialLoad = loadAssessments();'), context);
  if (!options.pendingLoad) await w.initialLoad;
  if (options.fullGIS) {
    vm.runInContext(readFileSync(path.join(root, 'video.js'), 'utf8'), context);
    vm.runInContext(readFileSync(path.join(root, 'survey.js'), 'utf8'), context);
  }
  return { w, advance, markers, requests, network, getSupabaseClientCount: () => supabaseClientCount, tiles, rasters, vectors, removed, activeLayers, frameCallbacks, cancelledFrames, transforms, map, viewport, attributions, read: code => vm.runInContext(code, context) };
}

const styles = [
  ['light', 'positron', false], ['dark', 'dark', true], ['voyager', 'liberty', false],
  ['satellite', 'dark', true], ['backdrop', 'positron', false], ['toner', 'positron', false],
];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const vectorFor = (app, id) => app.vectors.find(vector => vector.config.style.endsWith(`/${id}`));
const isLoading = app => !app.w.document.getElementById('loadingScreen').classList.contains('done');
const current = app => app.read('currentBasemap');
const state = (app, id) => app.read(`basemapManager.entries.get(${JSON.stringify(id)}).state`);

function tileEvent(vector, sourceId = 'openmaptiles') {
  const z = Math.floor(vector.gl.getZoom());
  const center = vector.gl.getCenter();
  const scale = 2 ** z;
  const lat = center.lat * Math.PI / 180;
  return { sourceId, sourceDataType: 'content', coord: { canonical: {
    z, x: Math.floor((center.lng + 180) / 360 * scale),
    y: Math.floor((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2 * scale),
  } } };
}
function finishVectorLoad(vector) {
  vector.gl.fire('style.load');
  for (const [sourceId, source] of Object.entries(vector.gl.getStyle().sources)) {
    if (source.type === 'vector') vector.gl.fire('sourcedata', tileEvent(vector, sourceId));
  }
  vector.gl.fire('load').fire('idle');
}
function finishRasterLoad(raster) {
  raster.pending = false;
  const coords = tileEvent({ gl: { getCenter: () => raster._map.getCenter(), getZoom: () => Math.min(raster._map.getZoom(), raster.options.maxNativeZoom) } }).coord.canonical;
  raster.fire('tileload', { coords }).fire('load');
}
async function finishMaps(app) {
  app.vectors.forEach(finishVectorLoad);
  finishRasterLoad(app.rasters[0]);
  await flush();
}

test('blocked browser storage and missing Supabase SDK still load the snapshot', async t => {
  const app = await boot(t, { storageDisabled: true, noSupabase: true });
  assert.equal(app.read('allMergedRows.length'), 1);
  assert.equal(app.markers.length, 1);
  assert.equal(app.vectors.length, 3);
});

test('unknown saved map style falls back to the default basemap', async t => {
  const app = await boot(t, { style: 'obsolete-style' });
  await finishMaps(app);
  assert.equal(current(app).key, 'light');
  assert.equal(current(app).vector, vectorFor(app, 'positron'));
});

for (const [style, vectorStyle, dark] of styles) {
  test(`${style} restores a keyless basemap with its saved selection and theme`, async t => {
    const app = await boot(t, { style });
    await finishMaps(app);
    const vector = vectorFor(app, vectorStyle);
    assert.equal(new URL(vector.config.style).search, '');
    assert.equal(app.w.document.body.classList.contains('chrome-dark'), dark);
    assert.equal(app.w.document.querySelector('.settings-option.active').dataset.style, style);
    assert.equal(app.w.localStorage.getItem('mapStyle'), style);
    assert.equal(app.w.document.getElementById('mapNotice').hidden, true);
    assert.equal(current(app).vector, vector);
    assert.ok(app.activeLayers.has(vector));
    assert.equal(vector.container.style.opacity, '1');
    assert.equal(app.vectors.length, 3);
    assert.equal(app.rasters.length, 1);
  });
}

test('assessment readiness alone cannot dismiss startup before every map has settled', async t => {
  const app = await boot(t);
  assert.equal(app.markers.length, 1);
  app.advance(12001);
  assert.equal(isLoading(app), true, 'the former 12-second escape must not expose unprepared maps');
  finishVectorLoad(vectorFor(app, 'positron'));
  finishVectorLoad(vectorFor(app, 'dark'));
  finishRasterLoad(app.rasters[0]);
  await flush();
  app.advance(1500);
  assert.equal(isLoading(app), true, 'Voyager is still preparing');
  assert.equal(app.w.document.querySelector('[data-style="voyager"]').getAttribute('aria-busy'), 'true');
  finishVectorLoad(vectorFor(app, 'liberty'));
  await flush();
  app.advance(1500);
  assert.equal(isLoading(app), false);
  for (const button of app.w.document.querySelectorAll('.settings-option')) {
    assert.equal(button.dataset.loadState, 'ready');
    assert.equal(button.hasAttribute('aria-busy'), false);
    assert.equal(button.disabled, false);
  }
});

test('ready maps also wait for assessments before opening the website', async t => {
  const pending = deferred();
  const app = await boot(t, { pendingLoad: true, range: ({ table, start }) => start ? { data: [], error: null } : pending.promise.then(() => ({ data: table === 'photos' ? [photo] : [assessment], error: null })) });
  await finishMaps(app);
  app.advance(1500);
  assert.equal(isLoading(app), true);
  pending.resolve();
  await app.w.initialLoad;
  app.advance(1500);
  assert.equal(isLoading(app), false);
});

test('an unexpectedly stalled map startup promise has a final bounded escape and releases the animation', async t => {
  const app = await boot(t, { stalledMapStartup: true });
  const canvas = app.w.document.getElementById('loadingCanvas');
  app.advance(20000);
  await flush();
  app.advance(8000);
  await flush();
  app.advance(6999);
  assert.equal(isLoading(app), true, 'provider failure cannot bypass the pending startup gate before its safety deadline');
  assert.equal(app.markers.length, 1);
  app.advance(1);
  await flush();
  app.advance(2200);
  assert.equal(isLoading(app), false);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  assert.match(app.w.document.getElementById('loadingStatusText').textContent, /Opening available map data/);
  assert.equal(app.rasters.length, 2, 'the final escape must not restart provider requests');
});

test('all styles reuse their prewarmed instances and keep the inactive maps attached', async t => {
  const app = await boot(t);
  await finishMaps(app);
  const instances = [...app.vectors];
  const imagery = app.rasters[0];
  for (const [key, id] of [...styles, ...styles.slice().reverse()]) {
    app.w.setMapStyle(key);
    assert.equal(current(app).key, key, 'prepared switches are synchronous');
    assert.equal(current(app).vector, vectorFor(app, id));
    assert.equal(current(app).vector.container.style.opacity, '1');
    assert.equal(current(app).raster, key === 'satellite' ? imagery : null);
    assert.equal(app.vectors.length, 3);
    assert.equal(app.rasters.length, 1);
    assert.equal(app.removed.length, 0);
  }
  for (const vector of instances) {
    assert.ok(app.activeLayers.has(vector));
    assert.equal(vector.container.isConnected, true);
  }
  assert.ok(app.activeLayers.has(imagery));
});

test('a pending style keeps the working map visible and a later choice wins', async t => {
  const app = await boot(t);
  const light = vectorFor(app, 'positron');
  finishVectorLoad(light);
  await flush();
  app.w.setMapStyle('dark');
  assert.equal(current(app).vector, light);
  assert.equal(light.container.style.opacity, '1');
  app.w.setMapStyle('voyager');
  finishVectorLoad(vectorFor(app, 'dark'));
  await flush();
  assert.equal(current(app).vector, light, 'late completion of Dark must not steal the selection');
  finishVectorLoad(vectorFor(app, 'liberty'));
  await flush();
  assert.equal(current(app).key, 'voyager');
  assert.equal(light.container.style.opacity, '0');
});

test('backdrop hides labels and restores them when reusing the Light renderer', async t => {
  const app = await boot(t);
  await finishMaps(app);
  const vector = vectorFor(app, 'positron');
  app.w.setMapStyle('backdrop');
  assert.equal(vector.gl.visibility.get('places'), 'none');
  assert.equal(vector.gl.visibility.get('icons'), 'none');
  assert.notEqual(vector.gl.visibility.get('roads'), 'none');
  assert.notEqual(vector.gl.visibility.get('land'), 'none');
  app.w.setMapStyle('light');
  assert.notEqual(vector.gl.visibility.get('places'), 'none');
  assert.notEqual(vector.gl.visibility.get('icons'), 'none');
});

test('Satellite reuses Dark for labels and restores Dark geometry and text paint', async t => {
  const app = await boot(t);
  await finishMaps(app);
  const vector = vectorFor(app, 'dark');
  const raster = app.rasters[0];
  const originalText = vector.gl.getPaintProperty('places', 'text-color');
  app.w.setMapStyle('satellite');
  assert.equal(raster.options.maxNativeZoom, 14);
  assert.equal(raster.options.maxZoom, 22);
  assert.match(raster.url, /tiles\.maps\.eox\.at\/.*\{z\}\/\{y\}\/\{x\}\.jpg$/);
  assert.equal(new URL(raster.url).search, '');
  assert.match([...app.attributions].join(' '), /Copernicus/);
  for (const id of ['background', 'land', 'roads']) assert.equal(vector.gl.visibility.get(id), 'none');
  assert.equal(vector.gl.paint.get('places:text-color'), '#ffffff');
  assert.equal(vector.gl.paint.get('places:text-halo-color'), '#202024');
  assert.equal(vector.gl.paint.get('places:text-halo-width'), 1.5);
  app.w.setMapStyle('dark');
  for (const id of ['background', 'land', 'roads']) assert.notEqual(vector.gl.visibility.get(id), 'none');
  assert.equal(vector.gl.getPaintProperty('places', 'text-color'), originalText);
  assert.equal(raster.container.style.opacity, '1', 'imagery stays underneath until Dark has rendered its restored geometry');
  vector.gl.fire('render');
  assert.equal(raster.container.style.opacity, '0');
  assert.equal(current(app).vector, vector);
});

test('Toner affects its cached basemap only and restores Light without changing marker colors', async t => {
  const app = await boot(t);
  await finishMaps(app);
  const markerStyles = app.markers.map(marker => ({ ...marker.style }));
  const vector = vectorFor(app, 'positron');
  app.w.setMapStyle('toner');
  assert.deepEqual([...app.w.document.querySelectorAll('.map-monochrome')], [vector.container]);
  assert.equal(app.w.document.getElementById('map').style.filter, '');
  assert.equal(app.w.document.body.style.filter, '');
  assert.deepEqual(app.markers.map(marker => ({ ...marker.style })), markerStyles);
  app.w.setMapStyle('light');
  assert.equal(app.w.document.querySelector('.map-monochrome'), null);
  assert.equal(vector.container.isConnected, true);
});

for (const event of ['metadata-only', 'all-tiles-failed', 'unrelated-source']) {
  test(`vector ${event} plus load and idle cannot count as a healthy map`, async t => {
    const app = await boot(t);
    const vector = vectorFor(app, 'positron');
    vector.gl.fire('style.load');
    if (event === 'metadata-only') vector.gl.fire('sourcedata', { sourceId: 'openmaptiles', sourceDataType: 'metadata', isSourceLoaded: true });
    if (event === 'all-tiles-failed') vector.gl.fire('error', { error: new Error('All tile downloads failed') });
    if (event === 'unrelated-source') vector.gl.fire('sourcedata', tileEvent(vector, 'annotations'));
    vector.gl.fire('load').fire('idle');
    assert.equal(state(app, 'positron'), 'loading');
    app.advance(20000);
    await flush();
    assert.equal(state(app, 'positron'), 'failed');
    assert.equal(current(app), null);
  });
}

test('decoded tiles wait for idle and the renderer to finish its outstanding requests', async t => {
  const app = await boot(t);
  const vector = vectorFor(app, 'positron');
  vector.gl.tilesLoaded = false;
  finishVectorLoad(vector);
  assert.equal(state(app, 'positron'), 'loading');
  vector.gl.tilesLoaded = true;
  vector.gl.fire('idle');
  await flush();
  assert.equal(state(app, 'positron'), 'ready');
  assert.equal(current(app).vector, vector);
});

test('every vector source needs a decoded tile while non-vector sources do not', async t => {
  const app = await boot(t, { vectorSources: { roads: { type: 'vector' }, places: { type: 'vector' }, annotations: { type: 'geojson' } } });
  const vector = vectorFor(app, 'positron');
  vector.gl.fire('style.load').fire('sourcedata', tileEvent(vector, 'roads')).fire('load').fire('idle');
  assert.equal(state(app, 'positron'), 'loading');
  vector.gl.fire('sourcedata', tileEvent(vector, 'places')).fire('idle');
  await flush();
  assert.equal(state(app, 'positron'), 'ready');
  assert.equal(current(app).vector, vector);
});

test('source tiles received before style readiness still count once the style and frame are ready', async t => {
  const app = await boot(t);
  const vector = vectorFor(app, 'positron');
  vector.gl.fire('sourcedata', tileEvent(vector)).fire('load').fire('idle');
  assert.equal(state(app, 'positron'), 'loading');
  vector.gl.fire('style.load').fire('idle');
  await flush();
  assert.equal(current(app).vector, vector);
});

test('a transient vector tile error can recover within the loading deadline', async t => {
  const app = await boot(t);
  const vector = vectorFor(app, 'positron');
  vector.gl.fire('error', { error: new Error('One tile failed') });
  app.advance(19999);
  finishVectorLoad(vector);
  await flush();
  app.advance(1);
  await flush();
  assert.equal(current(app).vector, vector);
  assert.equal(app.rasters.length, 1, 'a working map does not need an extra fallback download');
});

test('an unavailable requested style uses a prepared alternative and disables only unavailable choices', async t => {
  const app = await boot(t, { style: 'dark' });
  finishVectorLoad(vectorFor(app, 'positron'));
  finishVectorLoad(vectorFor(app, 'liberty'));
  finishRasterLoad(app.rasters[0]);
  app.advance(20000);
  await flush();
  assert.equal(current(app).key, 'light');
  assert.equal(current(app).vector, vectorFor(app, 'positron'));
  assert.equal(app.w.document.querySelector('[data-style="dark"]').disabled, true);
  assert.equal(app.w.document.querySelector('[data-style="light"]').disabled, false);
  assert.equal(app.w.localStorage.getItem('mapStyle'), 'dark');
  assert.equal(app.rasters.length, 1);
  app.advance(1500);
  assert.equal(isLoading(app), false);
});

test('all failed providers have bounded startup and do not endlessly create fallbacks', async t => {
  const app = await boot(t);
  app.advance(20000);
  await flush();
  assert.equal(app.rasters.length, 2);
  assert.equal(app.rasters[1].url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(isLoading(app), true);
  app.advance(8000);
  await flush();
  app.advance(1500);
  assert.equal(isLoading(app), false);
  assert.equal(app.w.document.getElementById('mapNotice').hidden, false);
  app.advance(60000);
  await flush();
  assert.equal(app.rasters.length, 2);
});

for (const failure of ['noMapSDK', 'noMapBridge', 'vectorConstructorFailure']) {
  test(`${failure} can recover through a bounded keyless street fallback`, async t => {
    const app = await boot(t, { style: 'dark', [failure]: true });
    app.advance(20000);
    await flush();
    const fallback = app.rasters.find(raster => raster.url.includes('tile.openstreetmap.org'));
    assert.ok(fallback);
    finishRasterLoad(fallback);
    await flush();
    assert.equal(current(app).raster, fallback);
    assert.equal(current(app).vector, null);
    assert.equal(current(app).fallback, true);
    assert.equal(app.w.document.body.classList.contains('chrome-dark'), false);
    assert.equal(app.w.localStorage.getItem('mapStyle'), 'dark');
    assert.equal(app.w.document.getElementById('mapNotice').hidden, false);
  });
}

for (const stage of ['before-gl', 'after-gl']) {
  test(`a failed WebGL add ${stage} cleans each partial layer before fallback`, async t => {
    const app = await boot(t, { vectorAddFailure: stage });
    app.advance(0);
    for (const vector of app.vectors) {
      assert.equal(vector.container.isConnected, false);
      assert.equal(app.activeLayers.has(vector), false);
      assert.equal(app.removed.filter(item => item === vector).length, 1);
      assert.equal(vector.originalRemovals, stage === 'before-gl' ? 0 : 1);
    }
    app.advance(20000);
    await flush();
    assert.equal(app.rasters.filter(raster => raster.url.includes('tile.openstreetmap.org')).length, 1);
  });
}

test('late events from failed renderers cannot replace the working street fallback', async t => {
  const app = await boot(t, { style: 'toner' });
  app.advance(20000);
  await flush();
  const fallback = app.rasters[1];
  finishRasterLoad(fallback);
  await flush();
  const notice = app.w.document.getElementById('mapNotice').textContent;
  for (const vector of app.vectors) {
    finishVectorLoad(vector);
    vector.gl.fire('webglcontextlost');
  }
  app.advance(0);
  await flush();
  assert.equal(current(app).raster, fallback);
  assert.equal(current(app).vector, null);
  assert.equal(app.rasters.length, 2);
  assert.equal(app.w.document.getElementById('mapNotice').textContent, notice);
});

test('satellite remains usable when its label renderer fails', async t => {
  const app = await boot(t, { style: 'satellite', noMapSDK: true });
  finishRasterLoad(app.rasters[0]);
  await flush();
  assert.equal(current(app).key, 'satellite');
  assert.equal(current(app).raster, app.rasters[0]);
  assert.equal(current(app).vector, null);
  assert.equal(app.w.document.body.classList.contains('chrome-dark'), true);
  assert.equal(app.rasters.length, 1);
  assert.equal(app.w.document.getElementById('mapNotice').hidden, false);
});

test('failed satellite imagery keeps an already working vector map visible', async t => {
  const app = await boot(t);
  finishVectorLoad(vectorFor(app, 'positron'));
  finishVectorLoad(vectorFor(app, 'dark'));
  app.w.setMapStyle('satellite');
  app.rasters[0].fire('loading').fire('tileerror').fire('load');
  app.advance(0);
  await flush();
  assert.equal(current(app).vector, vectorFor(app, 'positron'));
  assert.equal(current(app).vector.container.style.opacity, '1');
  assert.equal(app.rasters.length, 1);
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
  assert.deepEqual(JSON.parse(JSON.stringify(vector.gl.jumps)), [{ center: { lat: 12.97, lng: 77.59 }, zoom: 18 }]);
  assert.equal(vector.zoomEnds, 0);
  vector.gl.fire('moveend');
  assert.equal(vector.zoomEnds, 1);
});

test('destroy cancels an outstanding transition and guards a raced callback', async t => {
  const app = await boot(t);
  const vector = app.vectors[0];
  vector._transitionEnd();
  const frame = vector.transitionFrame;
  const queuedCallback = app.frameCallbacks.get(frame);
  app.read('basemapManager.destroy()');
  assert.ok(app.cancelledFrames.has(frame));
  assert.equal(vector._map, null);
  assert.equal(vector.getMaplibreMap(), null);
  app.advance(16);
  queuedCallback();
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
    if (state === 'removed') app.read('basemapManager.destroy()');
    else vector._gl = {};
    vector.gl.fire('moveend');
    assert.equal(vector.zoomEnds, 0);
  });
}

test('context loss recovers to another prepared map without creating a fourth vector renderer', async t => {
  const app = await boot(t);
  await finishMaps(app);
  const vector = vectorFor(app, 'positron');
  vector.gl.fire('webglcontextlost', { preventDefault() {} });
  assert.equal(app.removed.includes(vector), false, 'cleanup must wait until the event returns');
  app.advance(0);
  await flush();
  assert.notEqual(current(app).vector, vector);
  assert.equal(current(app).vector.container.style.opacity, '1');
  assert.equal(app.vectors.length, 3);
  assert.equal(app.rasters.length, 1);
});

test('an unknown style request leaves the current map and stored selection intact', async t => {
  const app = await boot(t, { style: 'dark' });
  await finishMaps(app);
  const vector = current(app).vector;
  app.w.setMapStyle('obsolete-style');
  assert.equal(app.vectors.length, 3);
  assert.equal(app.removed.length, 0);
  assert.equal(current(app).vector, vector);
  assert.equal(app.w.localStorage.getItem('mapStyle'), 'dark');
  assert.equal(app.w.document.body.classList.contains('chrome-dark'), true);
});

for (const event of ['metadata-with-coordinates', 'invalid-coordinate']) {
  test(`${event} cannot masquerade as decoded vector tile content`, async t => {
    const app = await boot(t);
    const vector = vectorFor(app, 'positron');
    const data = tileEvent(vector);
    if (event === 'metadata-with-coordinates') data.sourceDataType = 'metadata';
    else data.coord.canonical = {};
    vector.gl.fire('style.load').fire('load').fire('sourcedata', data).fire('idle');
    assert.equal(state(app, 'positron'), 'loading');
    vector.gl.fire('sourcedata', tileEvent(vector)).fire('idle');
    await flush();
    assert.equal(state(app, 'positron'), 'ready');
  });
}

test('a late Dark render cannot hide imagery after switching back to Satellite', async t => {
  const app = await boot(t);
  await finishMaps(app);
  app.w.setMapStyle('satellite');
  app.w.setMapStyle('dark');
  app.w.setMapStyle('satellite');
  vectorFor(app, 'dark').gl.fire('render');
  assert.equal(current(app).key, 'satellite');
  assert.equal(app.rasters[0].container.style.opacity, '1');
});

test('prewarmed maps stay hidden and attached until selected without changing the viewport', async t => {
  const app = await boot(t);
  const initialCenter = { ...app.map.getCenter() };
  const initialZoom = app.map.getZoom();
  for (const vector of app.vectors) {
    assert.equal(vector.container.style.opacity, '0');
    assert.equal(vector.container.style.position, 'absolute', 'cached renderers must overlap rather than stack below the viewport');
    assert.equal(vector.container.style.top, '0px');
    assert.equal(vector.container.style.left, '0px');
    assert.notEqual(vector.container.style.display, 'none');
    assert.ok(app.activeLayers.has(vector));
  }
  await finishMaps(app);
  app.w.setMapStyle('dark');
  for (const vector of app.vectors) {
    assert.equal(vector.container.style.opacity, vector === vectorFor(app, 'dark') ? '1' : '0');
  }
  assert.deepEqual(app.map.getCenter(), initialCenter);
  assert.equal(app.map.getZoom(), initialZoom);
});

test('a ready style waits for its new viewport after panning and preserves the visible map', async t => {
  const app = await boot(t);
  await finishMaps(app);
  const light = vectorFor(app, 'positron');
  const dark = vectorFor(app, 'dark');
  app.map.fire('movestart');
  app.viewport.center = { lat: 19.076, lng: 72.8777 };
  app.map.fire('moveend');
  app.w.setMapStyle('dark');
  dark.gl.fire('idle');
  await flush();
  assert.equal(state(app, 'dark'), 'loading', 'decoded tiles from Bengaluru cannot prove Mumbai has rendered');
  assert.equal(current(app).vector, light);
  assert.equal(light.container.style.opacity, '1');
  dark.gl.fire('sourcedata', tileEvent(dark)).fire('idle');
  await flush();
  assert.equal(current(app).vector, dark);
  assert.equal(dark.container.style.opacity, '1');
  assert.equal(light.container.style.opacity, '0');
  assert.equal(app.vectors.length, 3);
});

test('returning to a decoded viewport reuses cached tiles after a fresh idle frame', async t => {
  const app = await boot(t);
  await finishMaps(app);
  app.map.fire('movestart');
  app.map.fire('moveend');
  app.w.setMapStyle('voyager');
  const voyager = vectorFor(app, 'liberty');
  assert.equal(state(app, 'liberty'), 'loading');
  voyager.gl.fire('idle');
  await flush();
  assert.equal(state(app, 'liberty'), 'ready');
  assert.equal(current(app).vector, voyager);
});

test('satellite readiness uses imagery from the current viewport and cannot reuse a failed new area', async t => {
  const app = await boot(t);
  await finishMaps(app);
  const imagery = app.rasters[0];
  app.map.fire('movestart');
  app.viewport.center = { lat: 19.076, lng: 72.8777 };
  imagery.pending = true;
  imagery.fire('loading');
  app.map.fire('moveend');
  const light = vectorFor(app, 'positron');
  light.gl.fire('sourcedata', tileEvent(light)).fire('idle');
  const dark = vectorFor(app, 'dark');
  dark.gl.fire('sourcedata', tileEvent(dark)).fire('idle');
  app.w.setMapStyle('satellite');
  assert.equal(current(app).vector, light);
  imagery.pending = false;
  imagery.fire('tileerror').fire('load');
  app.advance(0);
  await flush();
  assert.equal(state(app, 'satellite'), 'failed');
  assert.equal(current(app).vector, light);
  assert.equal(app.w.document.querySelector('[data-style="satellite"]').disabled, true);
});

test('a successful satellite viewport tolerates a failed tile when another tile decoded', async t => {
  const app = await boot(t, { style: 'satellite' });
  const imagery = app.rasters[0];
  finishVectorLoad(vectorFor(app, 'dark'));
  imagery.fire('loading').fire('tileerror');
  finishRasterLoad(imagery);
  await flush();
  assert.equal(current(app).raster, imagery);
  assert.equal(state(app, 'satellite'), 'ready');
  assert.equal(app.w.document.getElementById('mapNotice').hidden, true);
});

test('only the visible map providers contribute attribution as styles change', async t => {
  const app = await boot(t);
  await finishMaps(app);
  assert.equal(app.attributions.size, 1);
  assert.doesNotMatch([...app.attributions].join(' '), /Copernicus/);
  app.w.setMapStyle('satellite');
  assert.equal(app.attributions.size, 2);
  assert.match([...app.attributions].join(' '), /Copernicus/);
  app.w.setMapStyle('voyager');
  assert.equal(app.attributions.size, 1);
  assert.doesNotMatch([...app.attributions].join(' '), /Copernicus/);
  app.read('basemapManager.destroy()');
  assert.equal(app.attributions.size, 0);
});

test('GEOAI logo opens and closes About while preserving the Video toggle', async t => {
  const app = await boot(t);
  const document = app.w.document;
  const logo = document.querySelector('.topbar .brand');
  const about = document.getElementById('aboutStack');
  const filters = document.getElementById('filterStack');
  const video = document.getElementById('videoToggle');
  assert.equal(document.querySelector('.nav-pill [data-page="about"]'), null);
  video.setAttribute('aria-pressed', 'true');
  document.querySelector('[data-page="filters"]').click();
  assert.equal(filters.classList.contains('open'), true);
  logo.click();
  assert.equal(about.getAttribute('aria-hidden'), 'false');
  assert.equal(logo.getAttribute('aria-expanded'), 'true');
  assert.equal(filters.classList.contains('open'), false);
  assert.equal(document.querySelector('[data-page="map"]').classList.contains('active'), true);
  assert.equal(video.getAttribute('aria-pressed'), 'true');
  logo.click();
  assert.equal(about.getAttribute('aria-hidden'), 'true');
  assert.equal(logo.getAttribute('aria-expanded'), 'false');
  logo.click();
  document.querySelector('[data-page="map"]').click();
  assert.equal(about.getAttribute('aria-hidden'), 'true');
  assert.equal(logo.getAttribute('aria-expanded'), 'false');
  assert.equal(video.getAttribute('aria-pressed'), 'true');
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
  app.w.fetch = async url => ({ ok: true, json: () => url.includes('old') ? oldJSON.promise : Promise.resolve([{ display_name: 'New result, India', lat: '12.97', lon: '77.59' }]) });
  const first = app.w.runSearch('old');
  await Promise.resolve();
  await app.w.runSearch('new');
  oldJSON.resolve([{ display_name: 'Old result, India', lat: '12.97', lon: '77.59' }]);
  await first;
  assert.match(app.w.document.getElementById('searchResults').textContent, /New result/);
});

test('old search failure cannot erase newer results, and closing cancels pending input', async t => {
  const app = await boot(t);
  const old = deferred();
  app.w.fetch = url => url.includes('old') ? old.promise : Promise.resolve({ ok: true, json: async () => [{ display_name: 'New result', lat: '12.97', lon: '77.59' }] });
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

test('a browser without 2D canvas still waits for maps before dismissing the loading screen', async t => {
  const app = await boot(t, { noCanvas: true });
  assert.equal(app.read('LoadingScreen.canvasAvailable'), false);
  assert.equal(app.markers.length, 1);
  app.advance(1500);
  assert.equal(isLoading(app), true);
  await finishMaps(app);
  app.advance(1500);
  assert.equal(app.w.document.getElementById('loadingScreen').classList.contains('done'), true);
});

test('completed loading animation releases its canvas and ignores later window resizes', async t => {
  const app = await boot(t);
  const canvas = app.w.document.getElementById('loadingCanvas');
  assert.ok(canvas.width > 0);
  await finishMaps(app);
  app.advance(2200);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  app.w.dispatchEvent(new app.w.Event('resize'));
  assert.equal(canvas.width, 0);
});

test('clearing filters before the next animation frame cannot resurrect their pills', async t => {
  const app = await boot(t);
  app.w.setSeverityFilter('High');
  app.w.setTimeFilter('night');
  app.w.setSeverityFilter(null);
  app.w.setTimeFilter(null);
  app.advance(400);
  for (const id of ['severityPill', 'timePill']) {
    const pill = app.w.document.getElementById(id);
    assert.equal(pill.hidden, true);
    assert.equal(pill.classList.contains('show'), false);
  }
});

for (const [name, cacheEntry] of [
  ['null row', { data: [null], timestamp: Date.now() }],
  ['array row', { data: [[]], timestamp: Date.now() }],
  ['future timestamp', { data: [], timestamp: Date.now() + 86400000 }],
  ['text timestamp', { data: [], timestamp: 'invalid' }],
]) {
  test(`invalid cached ${name} does not prevent loading current assessments`, async t => {
    const app = await boot(t, { cacheEntry });
    assert.ok(app.requests.length > 0);
    assert.equal(app.read('allMergedRows.length'), 1);
    assert.equal(app.markers.length, 1);
  });
}

test('mixed type labels cannot crash card rendering or location lists', async t => {
  const app = await boot(t);
  const row = { ...assessment, distress_types: [null, 42, {}, '', 'Pothole (D40)'] };
  app.w.showCards([row]);
  const list = app.w.buildListElement([row]);
  assert.equal(list.querySelectorAll('.list-type').length, 1);
  assert.equal(list.querySelector('.list-type').textContent, 'Pothole');
  assert.equal(app.w.effectiveTypes({ ...row, expert_reviewed: true, expert_corrected_types: [null] }).length, 0);
  assert.equal(app.w.hasCoordinates(null), false);
});

test('malformed live rows use the snapshot instead of breaking the dashboard', async t => {
  const app = await boot(t, { tables: { photos: [null], assessments: [assessment] } });
  assert.equal(app.read('allMergedRows.length'), 1);
  assert.equal(app.read('Cache.read()'), null);
});

test('malformed snapshots leave usable cached markers on screen', async t => {
  const app = await boot(t, { cache: [assessment], noSupabase: true,
    fetch: async () => ({ ok: true, json: async () => ({ photos: [null], assessments: [] }) }) });
  assert.equal(app.markers.length, 1);
  assert.match(app.w.document.getElementById('status').textContent, /cached.*network error/);
});

test('hung live requests abort together and reach snapshot fallback after the deadline', async t => {
  const app = await boot(t, { pendingLoad: true, range: () => new Promise(() => {}) });
  assert.equal(app.requests.length, 2);
  app.advance(15000);
  await app.w.initialLoad;
  assert.equal(app.requests.every(request => request.signal.aborted), true);
  assert.equal(app.read('allMergedRows.length'), 1);
  assert.equal(app.read('Cache.read()'), null);
});

test('a failed live table cancels its still-running sibling without waiting for timeout', async t => {
  const app = await boot(t, { range: ({ table }) => table === 'photos'
    ? Promise.resolve({ data: null, error: new Error('offline') }) : new Promise(() => {}) });
  assert.equal(app.requests.every(request => request.signal.aborted), true);
  assert.equal(app.read('allMergedRows.length'), 1);
});

test('a stalled snapshot response body times out while keeping cached data', async t => {
  let snapshotSignal;
  const app = await boot(t, { pendingLoad: true, noSupabase: true, cache: [assessment],
    fetch: async (_, options) => { snapshotSignal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  app.advance(10000);
  await app.w.initialLoad;
  assert.equal(snapshotSignal.aborted, true);
  assert.equal(app.markers.length, 1);
  assert.match(app.w.document.getElementById('status').textContent, /network error/);
});

test('late live responses cannot replace the snapshot after timing out', async t => {
  const pending = deferred();
  const app = await boot(t, { pendingLoad: true, range: () => pending.promise });
  app.advance(15000);
  await app.w.initialLoad;
  pending.resolve({ data: [{ ...photo, id: 'late' }], error: null });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(app.read('allMergedRows[0].id'), 'a1');
  assert.equal(app.read('Cache.read()'), null);
});

test('search skips malformed coordinates and falls back from invalid bounds to a valid point', async t => {
  const app = await boot(t);
  app.w.renderResults([null, {}, { display_name: 'Bad', lat: '', lon: '0' },
    { display_name: 'Bad', lat: '12oops', lon: '77' }, { display_name: 'Bad', lat: '91', lon: '0' },
    { display_name: 'Valid place', lat: '0', lon: '0', boundingbox: ['no', '1', '0', '1'] }]);
  assert.equal(app.w.document.querySelectorAll('.result').length, 1);
  app.w.document.querySelector('.result').click();
  assert.equal(app.w.document.getElementById('searchInput').value, 'Valid place');
  assert.deepEqual([...app.markers.at(-1).point], [0, 0]);
  assert.doesNotThrow(() => app.w.selectResult({ display_name: 'Broken', lat: 'Infinity', lon: '0' }));
});

test('stalled search is aborted without overwriting a newer completed query', async t => {
  const app = await boot(t);
  let oldSignal;
  app.w.fetch = (url, options) => url.includes('old') ? new Promise((_, reject) => {
    oldSignal = options.signal;
    oldSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) : Promise.resolve({ ok: true, json: async () => [{ display_name: 'New place', lat: '12', lon: '77' }] });
  const old = app.w.runSearch('old');
  app.advance(10000);
  await old;
  assert.equal(oldSignal.aborted, true);
  await app.w.runSearch('new');
  assert.match(app.w.document.getElementById('searchResults').textContent, /New place/);
});


test('production GIS startup isolates legacy Supabase/cache data and waits for actual Survey completion', async t => {
  const pending = deferred();
  const schema = 'geoai.gis.v1';
  const app = await boot(t, {
    fullGIS: true,
    cacheEntry: { data: [{ ...assessment, id: 'legacy-private-cache' }], timestamp: Date.now() },
    fetch: async url => {
      const pathname = new URL(url).pathname;
      let data;
      if (pathname === '/gis/meta') {
        await pending.promise;
        data = { schema, confidence_threshold: .8, limits: { default_limit: 5000, max_limit: 20000 },
          labels: [{ name: 'Normal', color: '#16a34a', category: 'Normal', marker_priority: 1 }],
          severities: [{ name: 'None', radius_px: 4 }], vlm_classes: [{ name: 'normal', color: '#16a34a' }] };
      } else if (pathname === '/gis/video/sessions') data = { schema, count: 0, sessions: [] };
      else if (pathname === '/gis/citizen/assessments.geojson') data = { schema, type: 'FeatureCollection', layer: 'citizen', numberMatched: 0, numberReturned: 0, features: [] };
      else throw new Error('Production GIS startup must not request legacy snapshot or Supabase: ' + url);
      return { ok: true, json: async () => data };
    },
  });
  assert.equal(app.read('sb'), null);
  assert.equal(app.getSupabaseClientCount(), 0);
  assert.equal(app.requests.length, 0);
  assert.equal(app.read('allMergedRows.length'), 0, 'Fresh legacy cache must not leak into the GIS map');
  assert.equal(app.markers.length, 0);
  assert.ok(app.w.geoaiSurvey, 'The real Survey controller is running');
  assert.equal(app.w.geoaiSurvey.renderer, app.w.geoaiVideoPaths.renderer);
  assert.equal(app.w.geoaiSurvey.renderer, app.map.options.renderer, 'One renderer owns citizen/video hit testing on the actual map');
  await finishMaps(app); app.advance(2000); await flush();
  assert.equal(isLoading(app), true, 'Prepared maps still wait for the actual Survey metadata/results');
  pending.resolve();
  for (let i = 0; i < 25; i++) await flush();
  assert.equal(app.w.geoaiSurvey.citizenMatched, 0);
  assert.match(app.w.geoaiSurvey.counts.textContent, /0 citizen observations/);
  assert.ok(app.network.some(url => new URL(url).pathname === '/gis/citizen/assessments.geojson'));
  assert.ok(app.network.every(url => new URL(url).pathname.startsWith('/gis/')));
  app.advance(2000); await flush();
  assert.equal(isLoading(app), false, 'The real Survey completion opens the prepared map');
});
