const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const schema = 'geoai.gis.v1';
const sessions = () => [
  { session_id: 'drive-a', road_name: 'First road', local_date: '2026-10-26', state: 'stored', route_m: 300, distress_m: 15,
    pct_distress_of_surveyed: 5, track: { type: 'LineString', coordinates: [[77.5, 12.9], [77.501, 12.901], [77.502, 12.9]] } },
  { session_id: 'drive-b', road_name: '<img src=x onerror=alert(1)>', local_date: '2026-10-27', state: 'cleaned', route_m: 500,
    track: { type: 'MultiLineString', coordinates: [[[77.6, 12.9], [77.601, 12.901]], [[77.61, 12.91], [77.612, 12.91]]] } },
  { session_id: 'drive-empty', road_name: 'Awaiting route', state: 'queued', route_m: 0, track: null },
];
const meta = () => ({ schema, labels: [
  { name: 'Potholes', color: '#7f1d1d', marker_priority: 1, is_distress: true },
  { name: 'Bleeding', color: '#6d28d9', marker_priority: 2, is_distress: true },
], severities: [{ name: 'Low', radius_px: 6 }, { name: 'High', radius_px: 13 }, { name: 'None', radius_px: 4 }],
vlm_classes: [{ name: 'distress', color: '#ef4444' }], confidence_threshold: .8,
limits: { default_limit: 2, max_limit: 100 } });
const features = session => [10, 45, 110].map((s0_m, i) => ({ type: 'Feature', id: `${session}-${i}`,
  geometry: { type: 'Point', coordinates: [77.5 + i * .001, 12.9] }, properties: {
    layer: 'video', session_id: session, segment_id: `${session}-${i}`, vlm_class: 'distress',
    final_labels: i === 1 ? ['Potholes', 'Bleeding'] : ['Potholes'], final_severity: i === 2 ? 'High' : 'Low',
    marker_label: 'Potholes', confidence: .9, s0_m, length_m: 5,
    centre_lon: 77.5 + i * .001, centre_lat: 12.9, utc: '2026-10-26T11:40:00Z',
  } }));
const ok = body => ({ ok: true, status: 200, json: async () => body });
function page(params, rows, total = rows.length) {
  const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 2);
  const selected = rows.slice(offset, offset + limit);
  return ok({ schema, type: 'FeatureCollection', layer: 'video', features: selected, numberMatched: total, numberReturned: selected.length });
}
async function settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); }
function key(w, node, value) { node.dispatchEvent(new w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })); }
function harness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><main><div id="videoDrivePicker"></div><button id="outside">Outside</button></main>',
    { url: 'https://example.test/gis/app/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, calls = [], selections = [], focus = [], replay = [], evidence = [], changes = [], inlineRenderings = [], paused = [];
  const catalogue = options.sessions || sessions();
  const video = { enabled: options.enabled !== false, filters: { session: options.session || '', ...(options.filters || {}) },
    catalog: { sessions: catalogue, meta: meta() }, meta: meta(), apiBase: 'https://api.example.test',
    async fetch(url, input) {
      const parsed = new URL(url, w.location.href); calls.push({ url: parsed, input });
      if (options.fetch) return options.fetch(parsed, input);
      return page(parsed.searchParams, options.rows || features(parsed.searchParams.get('session')));
    },
    selectDrive(id) { selections.push(id); this.filters = { ...this.filters, session: id }; inspector.update(); },
    focusRoutes(id) { focus.push(id); },
  };
  const map = { getSize: () => ({ x: 1280, y: 800 }) };
  const L = { DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {} } };
  w.geoaiSurvey = {
    showEvidence(feature, group) { if (!inspector.inspectFeature(feature)) evidence.push({ feature, group }); },
    cardRow(feature) { return { id: feature.id, __gis: { reviewText: 'Model result · awaiting expert review' } }; },
  };
  w.geoaiDrivePlayer = { open(id) { replay.push(id); }, pause() { paused.push(true); }, inspectFeature: options.inspectFeature || (() => false) };
  w.geoaiRenderDriveEvidence = (document, feature, input) => {
    inlineRenderings.push({ feature, input });
    const box = document.createElement('div'); box.textContent = `Photo ${feature.id} · ${input.row?.__gis?.reviewText || 'Feature details'}`; return box;
  };
  w.document.addEventListener('geoai:driveinspectionchange', e => changes.push(e.detail));
  w.eval(readFileSync(path.join(root, 'gis-core.js'), 'utf8'));
  w.eval(readFileSync(path.join(root, 'drive-inspector.js'), 'utf8'));
  let existingPlayer;
  if (options.existingPlayer) {
    existingPlayer = w.document.createElement('section'); existingPlayer.id = 'driveReplayPanel';
    existingPlayer.hidden = true; existingPlayer.textContent = 'Existing replay controls';
    w.document.querySelector('main').append(existingPlayer);
  }
  const inspector = new w.GeoAIDriveInspector({ video, map, L });
  t.after(() => { inspector.destroy?.(); dom.window.close(); });
  return { w, inspector, video, calls, selections, focus, replay, evidence, changes, existingPlayer, inlineRenderings, paused,
    emit: () => w.document.dispatchEvent(new w.CustomEvent('geoai:videochange')),
    select(id) { video.filters = { ...video.filters, session: id }; inspector.update(); },
  };
}

test('custom picker lists all drives as safe text and leaves the inspector closed before selection', t => {
  const h = harness(t), d = h.w.document;
  const trigger = d.getElementById('videoDriveTrigger'), list = d.getElementById('videoDriveOptions');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(list.hidden, true); assert.equal(d.getElementById('driveInspector').hidden, true);
  assert.equal(h.calls.length, 0);
  trigger.click();
  assert.equal(trigger.getAttribute('aria-expanded'), 'true'); assert.equal(list.hidden, false);
  assert.deepEqual([...list.querySelectorAll('[role=option]')].map(el => el.dataset.sessionId), ['', 'drive-a', 'drive-b', 'drive-empty']);
  assert.match(list.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(list.querySelector('img'), null);
  const outside = d.getElementById('outside');
  outside.dispatchEvent(new h.w.MouseEvent('pointerdown', { bubbles: true })); outside.click();
  assert.equal(list.hidden, true); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('the existing replay player is docked once inside the selected-drive card and survives drive changes', async t => {
  const h = harness(t, { existingPlayer: true }), d = h.w.document;
  const host = d.getElementById('driveReplayHost'), player = h.existingPlayer;
  assert.equal(host.parentElement, h.inspector.panel);
  assert.equal(player.parentElement, host); assert.equal(player.classList.contains('drive-replay-embedded'), true);
  assert.equal(d.querySelectorAll('#driveReplayPanel').length, 1);
  assert.equal(player.hidden, true, 'docking does not open replay automatically');
  for (const id of ['drive-a', 'drive-b', '', 'drive-a']) {
    h.select(id); await settle();
    assert.equal(d.getElementById('driveReplayPanel'), player, 'selection keeps the same controls and event listeners');
    assert.equal(player.parentElement, host); assert.equal(d.querySelectorAll('#driveReplayPanel').length, 1);
  }
  h.inspector.replayButton.click();
  assert.deepEqual(h.replay, ['drive-a']);
});

test('picker keyboard navigation selects a drive and Escape dismisses without changing it', async t => {
  const h = harness(t), d = h.w.document, trigger = d.getElementById('videoDriveTrigger');
  trigger.focus(); key(h.w, trigger, 'ArrowDown');
  const list = d.getElementById('videoDriveOptions');
  assert.equal(list.hidden, false);
  key(h.w, d.activeElement, 'End');
  assert.equal(d.activeElement.dataset.sessionId, 'drive-empty');
  key(h.w, d.activeElement, 'Home');
  assert.equal(d.activeElement.dataset.sessionId, '');
  key(h.w, d.activeElement, 'ArrowDown');
  assert.equal(d.activeElement.dataset.sessionId, 'drive-a');
  assert.equal(d.activeElement.tagName, 'BUTTON');
  key(h.w, d.activeElement, 'Enter'); await settle();
  assert.deepEqual(h.selections, ['drive-a']);
  assert.equal(list.hidden, true); assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  trigger.click(); key(h.w, d.activeElement, 'Escape');
  assert.equal(list.hidden, true); assert.equal(d.activeElement, trigger);
  assert.deepEqual(h.selections, ['drive-a']);
  trigger.click(); key(h.w, d.activeElement, 'End'); key(h.w, d.activeElement, ' '); await settle();
  assert.deepEqual(h.selections, ['drive-a', 'drive-empty']);
  assert.equal(list.hidden, true);
});

test('selected-drive inspector fetches all pages without a map bbox and inspects evidence in place', async t => {
  const h = harness(t, { session: 'drive-a' }); await settle();
  const panel = h.w.document.getElementById('driveInspector');
  assert.equal(panel.hidden, false); assert.match(panel.textContent, /First road/);
  assert.equal(h.calls.length, 2, 'full-drive data follows pagination');
  for (const call of h.calls) {
    assert.equal(call.url.pathname, '/gis/video/segments.geojson');
    assert.equal(call.url.searchParams.get('session'), 'drive-a');
    assert.equal(call.url.searchParams.get('geom'), 'point');
    assert.equal(call.url.searchParams.has('bbox'), false);
  }
  assert.equal(h.inspector.features.length, 3);
  const observations = [...panel.querySelectorAll('.drive-inspector-observation')];
  assert.equal(observations.length, 3);
  assert.match(observations[2].textContent, /110/);
  observations[2].click();
  assert.equal(h.evidence.length, 0); assert.equal(h.inspector.inlineFeature.id, 'drive-a-2');
  assert.equal(h.inspector.inlinePhoto.hidden, false); assert.equal(panel.hidden, false);
  const selectedContent = h.inspector.inlineContent.firstElementChild;
  h.emit(); h.emit(); await settle();
  assert.equal(h.calls.length, 2, 'map viewport refresh notifications do not refetch a complete drive');
  assert.equal(h.inspector.inlineContent.firstElementChild, selectedContent, 'viewport refresh preserves the photo and its content');
});

test('rapid drive switching aborts the old request and ignores its late result', async t => {
  let resolveA;
  const h = harness(t, { session: 'drive-a', fetch: (url, input) => url.searchParams.get('session') === 'drive-a'
    ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve(page(url.searchParams, features('drive-b'))) });
  await settle(); const old = h.calls[0];
  h.select('drive-b'); await settle();
  assert.equal(old.input.signal.aborted, true);
  assert.equal(h.inspector.sessionId, 'drive-b');
  assert.deepEqual(Array.from(h.inspector.features, f => f.id), ['drive-b-0', 'drive-b-1', 'drive-b-2']);
  resolveA(page(old.url.searchParams, features('drive-a'))); await settle();
  assert.equal(h.inspector.sessionId, 'drive-b');
  assert.ok(h.inspector.features.every(f => f.properties.session_id === 'drive-b'));
  const successful = h.changes.filter(c => Array.isArray(c.features));
  assert.ok(successful.length > 0);
  assert.ok(successful.every(c => c.sessionId === 'drive-b'));
});

test('Video off or All drives clears inspection and a pending request cannot reopen it', async t => {
  let finish;
  const h = harness(t, { session: 'drive-a', fetch: () => new Promise(resolve => { finish = resolve; }) });
  await settle();
  h.video.enabled = false; h.emit();
  assert.equal(h.calls[0].input.signal.aborted, true);
  assert.equal(h.w.document.getElementById('driveInspector').hidden, true);
  assert.equal(h.w.document.getElementById('driveInspector').hasAttribute('aria-busy'), false);
  finish(page(h.calls[0].url.searchParams, features('drive-a'))); await settle();
  assert.equal(h.w.document.getElementById('driveInspector').hidden, true);
  assert.equal(h.changes.filter(c => Array.isArray(c.features)).length, 0);
  h.video.enabled = true; h.select(''); await settle();
  assert.equal(h.w.document.getElementById('driveInspector').hidden, true);
});

test('empty, failed and oversized distress results are distinguished instead of claiming a complete clean drive', async t => {
  const empty = harness(t, { session: 'drive-a', rows: [] }); await settle();
  assert.match(empty.w.document.getElementById('driveInspectorStatus').textContent, /no|0/i);
  assert.equal(empty.inspector.features.length, 0);
  assert.equal(empty.w.document.querySelectorAll('.drive-inspector-observation').length, 0);
  const failed = harness(t, { session: 'drive-a', fetch: async () => ({ ok: false, status: 503 }) }); await settle();
  assert.match(failed.w.document.getElementById('driveInspectorStatus').textContent, /unavailable|could not|failed/i);
  assert.equal(failed.w.document.getElementById('driveInspectorRetry').hidden, false);
  assert.equal(failed.inspector.features, null);
  const large = harness(t, { session: 'drive-a', fetch: async url => page(url.searchParams, features('drive-a'), 5001) }); await settle();
  assert.match(large.w.document.getElementById('driveInspectorStatus').textContent, /narrow|5,000|5000|too many/i);
  assert.equal(large.inspector.features, null);
  assert.equal(large.w.document.querySelectorAll('.drive-inspector-observation').length, 0);
});

test('changing filters refetches the selected drive while retaining its full-route context', async t => {
  const h = harness(t, { session: 'drive-a' }); await settle();
  h.video.filters = { ...h.video.filters, severities: ['High'] }; h.inspector.update(); await settle();
  const filtered = h.calls.filter(c => c.url.searchParams.get('severity') === 'High');
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every(c => c.url.searchParams.get('session') === 'drive-a' && !c.url.searchParams.has('bbox')));
  assert.equal(h.inspector.sessionId, 'drive-a');
  assert.equal(h.inspector.features.length, 1); assert.equal(h.inspector.features[0].properties.final_severity, 'High');
});

test('route preview preserves disconnected parts and unavailable routes cannot be focused or replayed', async t => {
  const h = harness(t, { session: 'drive-b' }); await settle();
  const panel = h.w.document.getElementById('driveInspector');
  const parts = [...panel.querySelectorAll('.drive-inspector-route svg polyline')];
  assert.equal(parts.length, 2, 'a GNSS gap is not joined with an invented road');
  assert.ok(parts.every(p => p.getAttribute('points').split(' ').length === 2));
  h.inspector.focusButton.click(); h.inspector.replayButton.click();
  assert.deepEqual(h.focus, ['drive-b']); assert.deepEqual(h.replay, ['drive-b']);
  h.select('drive-empty'); await settle();
  assert.match(panel.querySelector('.drive-inspector-route').textContent, /No recorded route/);
  assert.equal(h.inspector.focusButton.disabled, true); assert.equal(h.inspector.replayButton.disabled, true);
  h.inspector.focusButton.click(); h.inspector.replayButton.click();
  assert.equal(h.focus.length, 1); assert.equal(h.replay.length, 1);
});

test('label counts count each type per segment and retain explicit overlapping-label semantics', async t => {
  const rows = features('drive-a'); rows[1].properties.final_labels.push('Potholes');
  const h = harness(t, { session: 'drive-a', rows }); await settle();
  const chips = [...h.w.document.querySelectorAll('.drive-inspector-label')];
  const counts = Object.fromEntries(chips.map(el => [el.querySelector('span').textContent, el.querySelector('strong').textContent]));
  assert.deepEqual(counts, { Potholes: '3', Bleeding: '1' });
  assert.match(h.w.document.getElementById('driveInspector').textContent, /more than one distress type/);
  assert.equal(h.inspector.features.length, 3, 'multiple labels never inflate the segment total');
});

test('retry recovers an unavailable drive result without switching the selected drive', async t => {
  let broken = true;
  const h = harness(t, { session: 'drive-b', fetch: async url => broken ? { ok: false, status: 503 } : page(url.searchParams, features('drive-b')) });
  await settle();
  const retry = h.w.document.getElementById('driveInspectorRetry'); assert.equal(retry.hidden, false);
  broken = false; retry.click(); await settle();
  assert.equal(retry.hidden, true); assert.equal(h.inspector.sessionId, 'drive-b');
  assert.equal(h.inspector.features.length, 3);
  assert.equal(h.w.document.getElementById('driveInspector').hasAttribute('aria-busy'), false);
});

test('inline photo navigation preserves the drive card and needs no separate evidence or replay flow', async t => {
  const h = harness(t, { session: 'drive-a' }); await settle();
  const panel = h.inspector.panel, rows = h.inspector.features;
  assert.equal(h.inspector.inspectFeature(rows[1]), true);
  assert.equal(panel.hidden, false); assert.equal(h.inspector.inlinePhoto.hidden, false);
  assert.equal(h.inspector.inlineFeature, rows[1]); assert.match(h.inspector.inlinePosition.textContent, /2 of 3/);
  assert.equal(h.inspector.inlinePrevious.disabled, false); assert.equal(h.inspector.inlineNext.disabled, false);
  assert.equal(h.inlineRenderings[0].input.showImage, true);
  assert.equal(h.inlineRenderings[0].input.apiBase, 'https://api.example.test');
  assert.match(h.inlineRenderings[0].input.row.__gis.reviewText, /awaiting expert review/);
  h.inspector.inlineNext.click();
  assert.equal(h.inspector.inlineFeature, rows[2]); assert.equal(h.inspector.inlineNext.disabled, true);
  h.inspector.inlinePrevious.click(); h.inspector.inlinePrevious.click();
  assert.equal(h.inspector.inlineFeature, rows[0]); assert.equal(h.inspector.inlinePrevious.disabled, true);
  assert.equal(h.evidence.length, 0); assert.equal(h.replay.length, 0);
  assert.equal(h.w.document.body.classList.contains('gis-cards-open'), false);
  assert.ok(h.paused.length > 0, 'inline inspection pauses any active player without reopening it');
  h.inspector.inlineClose.click();
  assert.equal(h.inspector.inlineFeature, null); assert.equal(h.inspector.inlinePhoto.hidden, true);
  assert.equal(panel.hidden, false); assert.equal(h.video.filters.session, 'drive-a');
  assert.equal(h.inspector.features.length, 3, 'closing the selected photo leaves the observation list ready');
});

test('inline inspection only claims visible selected-drive video features', async t => {
  const h = harness(t, { session: 'drive-a' }); await settle();
  const feature = features('drive-a')[0];
  for (const other of [null, {}, features('drive-b')[0], { ...feature, properties: { ...feature.properties, layer: 'citizen' } },
    { type: 'Feature', properties: { session_id: 'drive-a' } }]) assert.equal(h.inspector.inspectFeature(other), false);
  assert.equal(h.inlineRenderings.length, 0);
  h.inspector.panel.hidden = true; assert.equal(h.inspector.inspectFeature(feature), false);
  h.inspector.panel.hidden = false; h.video.enabled = false; assert.equal(h.inspector.inspectFeature(feature), false);
  h.video.enabled = true; h.video.filters.session = 'drive-b'; assert.equal(h.inspector.inspectFeature(feature), false);
  h.video.filters.session = 'drive-a'; assert.equal(h.inspector.inspectFeature(feature), true);
  h.select(''); assert.equal(h.inspector.inspectFeature(feature), false);
  assert.equal(h.inspector.inlinePhoto.hidden, true);
});

test('ready replay handles the selected photo directly while pending replay uses the inspector fallback', async t => {
  let handled = false;
  const h = harness(t, { session: 'drive-a', inspectFeature: () => handled }); await settle();
  const feature = h.inspector.features[0];
  assert.equal(h.inspector.inspectFeature(feature), true); assert.equal(h.inspector.inlinePhoto.hidden, false);
  const rendered = h.inlineRenderings.length;
  handled = true;
  assert.equal(h.inspector.inspectFeature(feature), true);
  assert.equal(h.inspector.inlinePhoto.hidden, true); assert.equal(h.inspector.inlineFeature, null);
  assert.equal(h.inlineRenderings.length, rendered, 'a handled player selection does not create a duplicate inline photo');
  assert.equal(h.inspector.panel.hidden, false); assert.equal(h.replay.length, 0);
  handled = { pending: true };
  assert.equal(h.inspector.inspectFeature(feature), true);
  assert.equal(h.inspector.inlinePhoto.hidden, false, 'only a strict true counts as a completed player selection');
  assert.equal(h.inlineRenderings.length, rendered + 1);
});

test('pending map photo stays usable when observations arrive, and filter or drive changes clear it', async t => {
  let finish;
  const h = harness(t, { session: 'drive-a', fetch: url => Number(url.searchParams.get('offset')) === 0 && !finish
    ? new Promise(resolve => { finish = () => resolve(page(url.searchParams, features('drive-a'))); })
    : Promise.resolve(page(url.searchParams, features(url.searchParams.get('session')))) });
  await settle();
  const feature = features('drive-a')[1];
  assert.equal(h.inspector.inspectFeature(feature), true);
  const content = h.inspector.inlineContent.firstElementChild;
  assert.equal(h.inspector.inlinePrevious.disabled, true); assert.equal(h.inspector.inlineNext.disabled, true);
  finish(); await settle();
  assert.equal(h.inspector.inlineContent.firstElementChild, content);
  assert.equal(h.inspector.inlineFeature, feature);
  assert.equal(h.inspector.inlinePrevious.disabled, false); assert.equal(h.inspector.inlineNext.disabled, false);
  h.video.filters = { ...h.video.filters, severities: ['High'] }; h.inspector.update();
  assert.equal(h.inspector.inlinePhoto.hidden, true); assert.equal(h.inspector.inlineFeature, null);
  await settle(); assert.equal(h.inspector.inspectFeature(h.inspector.features[0]), true);
  h.select('drive-b'); assert.equal(h.inspector.inlinePhoto.hidden, true); assert.equal(h.inspector.inlineFeature, null);
  await settle(); assert.equal(h.inspector.inspectFeature(h.inspector.features[0]), true);
  h.video.enabled = false; h.emit();
  assert.equal(h.inspector.inlinePhoto.hidden, true); assert.equal(h.inspector.inlineFeature, null); assert.equal(h.inspector.panel.hidden, true);
});
