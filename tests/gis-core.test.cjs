const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const GIS = require('../gis-core.js');

const meta = { schema: GIS.SCHEMA, labels: [
  { name: 'Potholes', color: '#7f1d1d', category: 'Disintegration' },
  { name: 'Bleeding', color: '#6d28d9', category: 'Surface Defects' },
  { name: 'Normal', color: '#16a34a', category: 'Normal' },
], severities: [{ name: 'None', radius_px: 4 }, { name: 'Low', radius_px: 6 }, { name: 'Medium', radius_px: 9 }, { name: 'High', radius_px: 13 }, { name: 'Unknown', radius_px: 4 }],
vlm_classes: [{ name: 'distress', color: null }, { name: 'normal', color: '#16a34a' }, { name: 'pending', color: '#9ca3af' }],
confidence_threshold: .8, limits: { default_limit: 2, max_limit: 20000 } };
const ft = (id, overrides = {}) => ({ type: 'Feature', id,
  geometry: { type: 'Point', coordinates: [77.56, 12.93] }, properties: {
    layer: 'video', segment_id: id, session_id: 'drive_1', vlm_class: 'distress', final_labels: ['Potholes'], marker_label: 'Potholes',
    final_severity: 'Low', confidence: .9, needs_expert_review: false, expert_reviewed: false, utc: '2026-10-26T11:00:00Z',
    status: 'send', answered: true, length_m: 5, ...overrides,
  } });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => value, text: async () => typeof value === 'string' ? value : JSON.stringify(value) });
const page = (features, count, layer = 'video') => ({ schema: GIS.SCHEMA, type: 'FeatureCollection', layer,
  features, numberMatched: count, numberReturned: features.length });

test('GIS metadata rejects invalid shapes, CSS injection and ambiguous labels', () => {
  assert.equal(GIS.validateMeta(meta), meta);
  for (const modified of [{ ...meta, schema: 'v2' }, { ...meta, confidence_threshold: 2 },
    { ...meta, limits: { default_limit: 200, max_limit: 100 } },
    { ...meta, labels: [{ name: 'Potholes', color: 'red;background:url(evil)' }] },
    { ...meta, labels: [meta.labels[0], { ...meta.labels[0], name: 'potholes' }] },
    { ...meta, severities: [{ name: 'Low', radius_px: 0 }] }]) assert.throws(() => GIS.validateMeta(modified));
});

test('filters canonicalize metadata choices, preserve empty and zero semantics, and validate real dates', () => {
  assert.deepEqual(GIS.normalizeFilters({ labels: ['potholes', 'Potholes', 'Old D00'], severities: ['HIGH', 'bad'],
    review: 'needs', highConfidence: 'true', dateFrom: '2026-10-29', dateTo: '2026-10-26',
    session: 'drive_1', includeReview: '1', citizen: false, captureTime: 'night', injected: true }, meta),
  { labels: ['Potholes'], severities: ['High'], review: 'needs', highConfidence: true, dateFrom: '2026-10-26', dateTo: '2026-10-29',
    session: 'drive_1', includeReview: true, citizen: false, captureTime: 'night' });
  const invalid = GIS.normalizeFilters({ dateFrom: '2026-02-30', dateTo: 'oops', session: 'a,b', review: 'invalid', captureTime: 'invalid' }, meta);
  assert.equal(invalid.dateFrom, ''); assert.equal(invalid.dateTo, ''); assert.equal(invalid.session, '');
  assert.equal(invalid.review, 'all'); assert.equal(invalid.captureTime, 'all'); assert.equal(invalid.citizen, true);
  assert.equal(GIS.normalizeFilters({ dateTo: '9999-12-31', dateFrom: '0000-01-01' }, meta).dateTo, '');
});

test('queries use IST inclusive-start and next-day exclusive-end including leap and year boundaries', () => {
  const q = GIS.query({ dateFrom: '2024-02-29', dateTo: '2024-02-29', labels: ['Potholes'], session: 'drive_1', captureTime: 'day' }, meta, 'video', { geom: 'point', bbox: [77, 12, 78, 13], limit: 2, offset: 1 });
  assert.equal(q.get('date_from'), '2024-02-29T00:00:00+05:30');
  assert.equal(q.get('date_to'), '2024-03-01T00:00:00+05:30');
  assert.equal(q.get('vlm_class'), 'distress'); assert.equal(q.get('session'), 'drive_1');
  assert.equal(q.has('captureTime'), false); assert.equal(q.has('capture_time'), false);
  const citizen = GIS.query({ session: 'drive_1', includeReview: true, dateTo: '2026-12-31' }, meta, 'citizen', { geom: 'footprint' });
  assert.equal(citizen.get('date_to'), '2027-01-01T00:00:00+05:30'); assert.equal(citizen.get('include_review'), 'true');
  assert.equal(citizen.has('geom'), false); assert.equal(citizen.has('session'), false); assert.equal(citizen.has('vlm_class'), false);
  assert.throws(() => GIS.query({}, meta, 'video', { bbox: [78, 12, 77, 13] }));
  assert.throws(() => GIS.query({}, meta, 'video', { bbox: ',,,' }));
  assert.throws(() => GIS.query({}, meta, 'video', { geom: 'bogus' }));
  assert.throws(() => GIS.query({}, meta, 'video', { limit: 20001 }));
  assert.throws(() => GIS.query({}, meta, 'video', { offset: -1 }));
});

test('matches uses final classification and confidence, never invents distress from severity', () => {
  const p = ft('a', { labels: ['Bleeding'], severity: 'High', stage1_confidence: .99, stage2_confidence: .8, confidence: 0,
    final_labels: ['Potholes'], final_severity: 'None', expert_reviewed: true });
  assert.equal(GIS.matches(p, { labels: ['Potholes'], severities: ['None'], review: 'reviewed' }, meta, 'video'), true);
  assert.equal(GIS.matches(p, { labels: ['Bleeding'] }, meta, 'video'), false);
  assert.equal(GIS.matches(p, { highConfidence: true }, meta, 'video'), false);
  assert.equal(GIS.matches(ft('b', { vlm_class: 'pending', final_severity: 'High' }), {}, meta, 'video'), false);
  assert.equal(GIS.matches(ft('c', { vlm_class: 'normal', confidence: .85, stage2_confidence: 0, assessment_status: 'classified' }), { highConfidence: true }, meta, 'citizen'), true);
});

test('matches IST boundaries and missing capture time without processing-time substitution', () => {
  const f = { dateFrom: '2026-10-26', dateTo: '2026-10-26' };
  assert.equal(GIS.matches(ft('start', { utc: '2026-10-25T18:30:00Z' }), f, meta, 'video'), true);
  assert.equal(GIS.matches(ft('before', { utc: '2026-10-25T18:29:59Z' }), f, meta, 'video'), false);
  assert.equal(GIS.matches(ft('end', { utc: '2026-10-26T18:30:00Z' }), f, meta, 'video'), false);
  assert.equal(GIS.matches(ft('day', { utc: '2026-10-26T00:30:00Z' }), { captureTime: 'day' }, meta, 'video'), true);
  assert.equal(GIS.matches(ft('night', { utc: '2026-10-26T12:30:00Z' }), { captureTime: 'night' }, meta, 'video'), true);
  assert.equal(GIS.matches(ft('unknown', { utc: null, processed_at: '2026-10-26T05:00:00Z' }), { captureTime: 'day' }, meta, 'video'), false);
  assert.equal(GIS.matches(ft('citizen', { created_at: '2026-09-25T14:14:11Z', utc: '2026-10-26T00:30:00Z', assessment_status: 'expert_review' }), { includeReview: false }, meta, 'citizen'), false);
  assert.equal(GIS.matches(ft('citizen', { created_at: '2026-09-25T14:14:11Z', assessment_status: 'expert_review' }), { includeReview: true, captureTime: 'night' }, meta, 'citizen'), true);
});

test('safe URLs preserve API-origin image paths and block active schemes and credentials', () => {
  assert.equal(GIS.safeURL('/gis/image/a?w=1280', 'https://api.example.org', 'https://site.example.org/gis/app/'), 'https://api.example.org/gis/image/a?w=1280');
  assert.equal(GIS.safeURL('https://res.cloudinary.com/x.jpg', 'https://api.example.org'), 'https://res.cloudinary.com/x.jpg');
  for (const value of ['javascript:alert(1)', 'data:text/html,evil', 'file:///etc/passwd', 'https://name:secret@example.org/p', '']) assert.equal(GIS.safeURL(value), null);
  assert.equal(GIS.coordinate([77.5, 12.9]), true); assert.equal(GIS.coordinate([12.9, 177.5]), false);
  assert.equal(GIS.validCoordinates('12.9', 77.5), false); assert.equal(GIS.validCoordinates(NaN, 0), false);
});

test('CSV exports preserve Unicode, quotes, lists, false and zero and neutralize formulas', () => {
  const content = GIS.csv([ft('x', { description: '=HYPERLINK("https://evil")\nIRC §7.2', final_labels: ['Potholes', 'Bleeding'], confidence: 0, expert_reviewed: false }), ft('y', { road_name: '\t=1+1', address: '+CMD', camera_lon: -77.5 })]);
  assert.ok(content.startsWith('\ufeff')); assert.match(content, /IRC §7.2/); assert.match(content, /Potholes; Bleeding/);
  assert.match(content, /"'=HYPERLINK\(""https:\/\/evil""\)/); assert.match(content, /"'\t=1\+1"/);
  assert.match(content, /"'\+CMD"/); assert.match(content, /"-77.5"/); assert.match(content, /"false"/); assert.match(content, /"0"/);
});

test('share URLs round-trip all enabled layers, filters and view while sanitizing malformed links', () => {
  const filters = GIS.normalizeFilters({ labels: ['Bleeding', 'Potholes'], severities: ['High', 'Medium'], review: 'needs', highConfidence: true,
    dateFrom: '2026-10-26', dateTo: '2026-10-27', session: 'drive_1', includeReview: true, citizen: false, captureTime: 'night' }, meta);
  for (const style of ['light', 'dark', 'voyager', 'satellite', 'backdrop', 'toner']) {
    const view = GIS.parseView(GIS.serializeView({ filters, video: true, style, lat: 12.9345678, lng: 77.5678912, zoom: 17 }, meta), meta);
    assert.deepEqual(view.filters, filters); assert.equal(view.video, true); assert.equal(view.style, style); assert.equal(view.hasView, true);
    assert.ok(Math.abs(view.lat - 12.9345678) < 0.000001); assert.ok(Math.abs(view.lng - 77.5678912) < 0.000001); assert.equal(view.zoom, 17);
  }
  const bad = GIS.parseView('?style=<script>&lat=Infinity&lng=foo&zoom=200&label=bad&citizen=oops', meta);
  assert.equal(bad.style, 'light'); assert.equal(bad.lat, 12.9716); assert.equal(bad.zoom, 22); assert.equal(bad.hasView, false); assert.deepEqual(bad.filters.labels, []);
  assert.equal(GIS.parseView('', meta).filters.citizen, true);
  assert.equal(GIS.parseView('?lat=+&lng=+', meta).hasView, false);
});

test('client pages strictly, filters day/night once, and reports complete and oversized results honestly', async () => {
  const calls = [], rows = [ft('a'), ft('b', { utc: '2026-10-26T13:00:00Z' }), ft('c')];
  const client = new GIS.Client({ baseURI: 'https://host.example/gis/app/', fetch: async url => {
    calls.push(new URL(url)); const offset = Number(calls.at(-1).searchParams.get('offset')); return response(page(rows.slice(offset, offset + 2), 3));
  } });
  const result = await client.features('video', { captureTime: 'day' }, meta);
  assert.deepEqual(result.features.map(x => x.id), ['a', 'c']); assert.equal(result.numberMatched, 2); assert.equal(result.sourceNumberMatched, 3);
  assert.equal(result.truncated, false); assert.equal(calls.length, 2); assert.equal(calls[1].searchParams.get('offset'), '2');
  const large = new GIS.Client({ fetch: async () => response(page([rows[0]], 5001)) });
  assert.deepEqual(await large.features('video', {}, meta), { features: [], numberMatched: 5001, sourceNumberMatched: 5001, truncated: true });
});

test('client rejects stalled pages, duplicate IDs, changing totals and incorrect schemas', async () => {
  const cases = [
    [page([], 1)], [page([ft('a'), ft('a')], 2)],
    [page([ft('a'), ft('b')], 3), page([ft('c')], 4)],
    [{ ...page([ft('a')], 1), numberReturned: 2 }],
    [{ ...page([ft('a')], 1), schema: 'future.v2' }],
    [{ ...page([ft('a')], 1), layer: 'citizen' }],
  ];
  for (const replies of cases) {
    const client = new GIS.Client({ fetch: async () => response(replies.shift()) });
    await assert.rejects(client.features('video', {}, meta));
  }
});

test('drive frame paging includes every classification and records without stored images', async () => {
  const classes = ['distress', 'normal', 'pending', 'unknown', 'not_sent', 'not_covered'];
  const rows = classes.map((vlm_class, k) => ft(`frame_${k}`, { vlm_class, k,
    has_image: k < 4, status: k === 4 ? 'skip' : k === 5 ? 'not_covered' : 'send',
    final_labels: vlm_class === 'normal' ? ['Normal'] : [], confidence: null, utc: null }));
  const calls = [], client = new GIS.Client({ fetch: async url => {
    const q = new URL(url).searchParams; calls.push(q);
    const offset = Number(q.get('offset')); return response(page(rows.slice(offset, offset + 2), rows.length));
  } });
  const result = await client.driveFrames('drive_1', meta);
  assert.deepEqual(result.features, rows); assert.equal(result.numberMatched, 6);
  assert.equal(result.sourceNumberMatched, 6); assert.equal(result.truncated, false);
  assert.deepEqual(calls.map(q => q.get('offset')), ['0', '2', '4']);
  for (const q of calls) assert.deepEqual(Object.fromEntries(q), { session: 'drive_1', geom: 'point', limit: '2', offset: q.get('offset') });
});

test('drive frame requests ignore viewport and distress filters without changing ordinary map requests', async () => {
  const calls = [], rows = [ft('normal', { vlm_class: 'normal', final_labels: ['Normal'], confidence: 0 }), ft('distress')];
  const client = new GIS.Client({ fetch: async url => { calls.push(new URL(url)); return response(page(rows, 2)); } });
  const frames = await client.driveFrames('drive_1', meta, { bbox: [77, 12, 78, 13], labels: ['Potholes'], highConfidence: true });
  assert.deepEqual(frames.features.map(f => f.id), ['normal', 'distress']);
  assert.deepEqual([...calls[0].searchParams.keys()], ['session', 'geom', 'limit', 'offset']);
  const map = await client.features('video', { session: 'drive_1', labels: ['Potholes'], highConfidence: true }, meta, { bbox: [77, 12, 78, 13] });
  assert.deepEqual(map.features.map(f => f.id), ['distress']);
  assert.equal(calls[1].searchParams.get('vlm_class'), 'distress');
  assert.equal(calls[1].searchParams.get('label'), 'Potholes');
  assert.equal(calls[1].searchParams.get('min_confidence'), '0.8');
  assert.equal(calls[1].searchParams.get('bbox'), '77,12,78,13');
});

test('drive frames reject cross-drive or unidentified records instead of silently mixing sessions', async () => {
  for (const session_id of ['drive_2', '', null, undefined]) {
    const client = new GIS.Client({ fetch: async () => response(page([ft('a'), ft('wrong', { session_id })], 2)) });
    await assert.rejects(client.driveFrames('drive_1', meta), /unexpected session/);
  }
});

test('drive frames reject incomplete paging and report limits without presenting partial results as complete', async () => {
  for (const replies of [[page([], 1)], [page([ft('a'), ft('b')], 3), page([ft('c')], 4)],
    [page([ft('a'), ft('b')], 3), page([ft('a')], 3)]]) {
    const client = new GIS.Client({ fetch: async () => response(replies.shift()) });
    await assert.rejects(client.driveFrames('drive_1', meta));
  }
  let calls = 0;
  const client = new GIS.Client({ fetch: async () => { calls++; return response(page([ft('a'), ft('b')], 20001)); } });
  assert.deepEqual(await client.driveFrames('drive_1', meta), { features: [], numberMatched: 20001, sourceNumberMatched: 20001, truncated: true });
  assert.equal(calls, 1);
  const small = new GIS.Client({ fetch: async () => response(page([ft('a'), ft('b')], 3)) });
  assert.equal((await small.driveFrames('drive_1', meta, { max: 2 })).truncated, true);
});

test('drive frames validate session and limit and respect cancellation before making requests', async () => {
  let calls = 0;
  const client = new GIS.Client({ fetch: async () => { calls++; return response(page([], 0)); } });
  for (const session of ['', null, {}, 'drive_1,drive_2', '../drive', 'x'.repeat(201)]) await assert.rejects(client.driveFrames(session, meta), /Invalid drive session/);
  for (const max of [0, 20001, NaN, 1.5]) await assert.rejects(client.driveFrames('drive_1', meta, { max }), /Invalid feature limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.driveFrames('drive_1', meta, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('client cancellation and deadline settle even when fetch ignores AbortSignal', async () => {
  const client = new GIS.Client({ fetch: () => new Promise(() => {}), timeoutMs: 15 });
  await assert.rejects(client.meta(), e => e.status === 408);
  const controller = new AbortController(); const pending = client.meta({ signal: controller.signal }); controller.abort();
  await assert.rejects(pending, e => e.name === 'AbortError');
  await assert.rejects(client.meta({ signal: controller.signal }), e => e.name === 'AbortError');
});

test('catalogue caches successful validated responses for60seconds and does not cache failures', async () => {
  let calls = 0;
  const client = new GIS.Client({ fetch: async url => { calls++; return response(url.includes('/meta') ? meta : { schema: GIS.SCHEMA, count: 1, sessions: [{ session_id: 'drive_1' }] }); } });
  await client.meta(); await client.meta(); await client.sessions(); await client.sessions(); assert.equal(calls, 2);
  client.cache.get('meta').at -= 60001; await client.meta(); assert.equal(calls, 3);
  const controller = new AbortController(); controller.abort(); await assert.rejects(client.sessions({ signal: controller.signal }));
  let failures = 0; const broken = new GIS.Client({ fetch: async () => { failures++; return response({}, 503); } });
  await assert.rejects(broken.meta(), e => e.status === 503); await assert.rejects(broken.meta()); assert.equal(failures, 2);
});

test('CSV export checks every page and count, strips geom, preserves BOM and neutralizes server formulas', async () => {
  const calls = [], client = new GIS.Client({ fetch: async url => {
    const u = new URL(url); calls.push(u); if (u.pathname.endsWith('/summary')) return response({ schema: GIS.SCHEMA, segments: 3 });
    return response(Number(u.searchParams.get('offset')) === 0 ? '\ufeffsegment_id,description\r\na,"line1\nline2"\r\nb,=SUM(1)\r\n' : '\ufeffsegment_id,description\r\nc,§7.2\r\n');
  } });
  const result = await client.exportVideo({ labels: ['Potholes'] }, meta, { bbox: [77, 12, 78, 13] });
  assert.equal(result.filename, 'geoai-video.csv'); assert.ok(result.content.startsWith('\ufeff')); assert.match(result.content, /"'=SUM\(1\)"/); assert.match(result.content, /line1\nline2/);
  assert.equal(calls.length, 4); assert.ok(calls.every(u => u.searchParams.get('label') === 'Potholes' && !u.searchParams.has('geom')));
});

test('CSV export refuses >20000 rows, truncated pages and changing server count', async () => {
  const large = new GIS.Client({ fetch: async () => response({ schema: GIS.SCHEMA, segments: 20001 }) });
  await assert.rejects(large.exportVideo({}, meta), e => e.status === 413);
  const truncated = new GIS.Client({ fetch: async url => response(url.includes('/summary') ? { schema: GIS.SCHEMA, segments: 2 } : 'segment_id\na\n') });
  await assert.rejects(truncated.exportVideo({}, meta), /Incomplete/);
  let summaries = 0; const changing = new GIS.Client({ fetch: async url => response(url.includes('/summary') ? { schema: GIS.SCHEMA, segments: ++summaries } : 'segment_id\na\n') });
  await assert.rejects(changing.exportVideo({}, meta), /changed/);
});

test('day/night summary and export use the same complete filtered rows rather than unsupported API params', async () => {
  const rows = [ft('day'), ft('night', { utc: '2026-10-26T15:00:00Z' })], paths = [];
  const client = new GIS.Client({ fetch: async url => { paths.push(new URL(url)); return response(page(rows, 2)); } });
  const summary = await client.summary({ captureTime: 'day' }, meta);
  assert.equal(summary.segments, 1); assert.equal(summary.distress_m, 5); assert.equal(summary.labels.find(l => l.label === 'Potholes').segments, 1);
  const output = await client.exportVideo({ captureTime: 'night' }, meta);
  assert.match(output.content, /"night"/); assert.doesNotMatch(output.content, /"day"/);
  assert.ok(paths.every(u => u.pathname.endsWith('/segments.geojson') && !u.searchParams.has('capture_time')));
});

const sampleRoot = process.env.GIS_SAMPLE_DIR || path.resolve(__dirname, '../../gis_sample');
const hasSample = fs.existsSync(path.join(sampleRoot, 'gis_core.py'));
test('1,440 distinct shared-filter scenarios agree with the independent supplied Python API oracle', { skip: !hasSample }, () => {
  const realMeta = JSON.parse(fs.readFileSync(path.join(sampleRoot, 'api/gis/meta.json'), 'utf8'));
  const layers = Object.fromEntries(['video', 'citizen'].map(layer => [layer, JSON.parse(fs.readFileSync(path.join(sampleRoot, `api/gis/${layer}/${layer === 'video' ? 'segments_point' : 'assessments'}.geojson`), 'utf8')).features]));
  const labelSets = [[], ...realMeta.labels.map(l => [l.name])], severitySets = [[], ...realMeta.severities.map(s => [s.name])];
  const cases = [];
  for (const layer of ['video', 'citizen']) for (const labels of labelSets) for (const severities of severitySets) for (const review of ['all', 'needs', 'reviewed']) for (const highConfidence of [false, true]) {
    const index = cases.length, dateValue = layer === 'video' ? '2026-10-26' : '2026-09-25';
    const filters = { labels, severities, review, highConfidence, includeReview: index % 4 !== 0,
      dateFrom: index % 5 === 0 ? dateValue : '', dateTo: index % 5 === 0 ? dateValue : '', captureTime: ['all', 'day', 'night'][index % 3] };
    cases.push({ layer, filters, query: Object.fromEntries(GIS.query(filters, realMeta, layer)) });
  }
  assert.equal(cases.length, 1440);
  const python = String.raw`
import sys,json,datetime,os
sys.dont_write_bytecode=True
root=sys.argv[1];sys.path.insert(0,root)
import gis_core as core
cases=json.load(sys.stdin)
features={layer:json.load(open(os.path.join(root,'api','gis',layer,'segments_point.geojson' if layer=='video' else 'assessments.geojson')))['features'] for layer in ['video','citizen']}
out=[]
for c in cases:
 f=c['filters'];q={}
 if c['layer']=='video':q['vlm_class']='distress'
 else:q['include_review']='true' if f['includeReview'] else 'false'
 if f['labels']:q['label']=','.join(sorted(f['labels']))
 if f['severities']:q['severity']=','.join(sorted(f['severities']))
 if f['review']=='needs':q['needs_review']='true'
 if f['review']=='reviewed':q['reviewed']='true'
 if f['highConfidence']:q['min_confidence']='0.8'
 if f['dateFrom']:q['date_from']=f['dateFrom']+'T00:00:00+05:30'
 if f['dateTo']:q['date_to']=(datetime.date.fromisoformat(f['dateTo'])+datetime.timedelta(days=1)).isoformat()+'T00:00:00+05:30'
 assert q==c['query'],(q,c['query'])
 selected,total=core.apply(features[c['layer']],core.parse_filters(q,c['layer']))
 if f['captureTime']!='all':
  def clock(ft):
   t=core.parse_time(ft['properties'].get('utc' if c['layer']=='video' else 'created_at'))
   return t is not None and ((6<=t.astimezone(datetime.timezone(datetime.timedelta(hours=5,minutes=30))).hour<18)==(f['captureTime']=='day'))
  selected=[ft for ft in selected if clock(ft)]
 out.append(sorted(str(ft['id']) for ft in selected))
json.dump(out,sys.stdout)
`;
  const oracle = spawnSync('python3', ['-B', '-c', python, sampleRoot], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(oracle.status, 0, oracle.stderr);
  const expected = JSON.parse(oracle.stdout);
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const actual = layers[c.layer].filter(ft => GIS.matches(ft, c.filters, realMeta, c.layer)).map(ft => String(ft.id)).sort();
    assert.deepEqual(actual, expected[i], `Scenario ${i + 1}: ${JSON.stringify(c)}`);
    const view = GIS.parseView(GIS.serializeView({ filters: c.filters, video: true, style: 'light', lat: 12.93, lng: 77.56, zoom: 16 }, realMeta), realMeta);
    assert.deepEqual(view.filters, GIS.normalizeFilters(c.filters, realMeta), `Share scenario ${i + 1}`);
  }
});
