// Real HTTP acceptance checks against the unchanged supplied mock server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const GIS = require('../gis-core.js');
const path = require('node:path');
const usage = `Usage: node tools/verify-gis.cjs [--base-url ORIGIN] [--output FILE]

Read-only HTTP acceptance checks against the unchanged supplied gis_sample data.
Base URL: --base-url, GIS_API_ORIGIN, or http://127.0.0.1:8765.
No files are written unless --output is supplied. Node.js 18+ is required.
The expected counts describe the supplied sample; production data may differ.`;
function options(argv) {
  let base = process.env.GIS_API_ORIGIN || 'http://127.0.0.1:8765', output = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!['--base-url', '--output'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid arguments.\n' + usage);
    const value = argv[++i];
    if (flag === '--base-url') base = value; else output = path.resolve(value);
  }
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Use an HTTP(S) API origin without credentials, a path, query or fragment.');
  }
  return { origin: parsed.origin, output };
}
let configuration;
try { configuration = options(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(1); }
if (configuration.help) { console.log(usage); process.exit(0); }
const { origin, output } = configuration;
const checks = [];
async function check(name, run) {
  try { await run(); checks.push({ name, result: 'pass' }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, result: 'fail', message: error.message }); throw error; }
}
function report(failure) {
  const passed = checks.filter(check => check.result === 'pass').length;
  const failed = checks.filter(check => check.result === 'fail').length + (failure && !checks.some(check => check.result === 'fail') ? 1 : 0);
  const result = { api: origin, fixture: 'gis_sample 2026-10-27', generatedAt: new Date().toISOString(),
    checks, passed, failed, skipped: 0, complete: !failure, ...(failure ? { error: failure.message } : {}) };
  if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(`${passed} real HTTP acceptance checks passed; ${failed} failed.`);
}
function csvRows(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\ufeff/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += c; i++; } else quoted = !quoted; }
    else if (!quoted && c === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (c === '\r' || c === '\n')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.length > 1 || row[0]) rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  assert.equal(quoted, false); return rows;
}
(async () => {
  const client = new GIS.Client({ apiBase: origin }), meta = await client.meta();
  await check('Metadata contract and catalogue', async () => {
    assert.equal(meta.schema, 'geoai.gis.v1'); assert.equal(meta.labels.length, 19); assert.equal(meta.confidence_threshold, .8);
    const drives = await client.sessions(); assert.equal(drives.count, 3);
    assert.equal(Math.round(drives.sessions.reduce((sum, s) => sum + s.route_m, 0)), 4060);
    assert.ok(drives.sessions.every(s => s.track && s.per_km));
  });
  const scenarios = [
    ['Video default distress', 'video', {}, 164], ['Potholes', 'video', { labels: ['Potholes'] }, 131],
    ['Medium and High distress', 'video', { severities: ['Medium', 'High'] }, 75],
    ['High-confidence distress', 'video', { highConfidence: true }, 47],
    ['Distress awaiting review', 'video', { review: 'needs' }, 140],
    ['Expert-reviewed distress empty state', 'video', { review: 'reviewed' }, 0],
    ['Citizen classified default', 'citizen', {}, 131], ['Citizen including review', 'citizen', { includeReview: true }, 344],
    ['Citizen High Potholes including review', 'citizen', { includeReview: true, labels: ['Potholes'], severities: ['High'] }, 1],
  ];
  for (const [name, layer, filters, expected] of scenarios) await check(name, async () => {
    const result = await client.features(layer, filters, meta);
    assert.equal(result.truncated, false); assert.equal(result.numberMatched, expected); assert.equal(result.sourceNumberMatched, expected);
    assert.equal(new Set(result.features.map(f => f.id)).size, expected);
  });
  await check('All-class summary remains distinct from visible distress', async () => {
    const all = await client.json('/gis/video/summary'); assert.equal(all.segments, 813); assert.equal(all.needs_expert_review, 389);
    assert.equal(all.route_m, 4060.31); assert.equal(all.distress_m, 815.31); assert.equal(all.pct_distress_of_surveyed, 20.08);
    const visible = await client.summary({}, meta); assert.equal(visible.segments, 164); assert.equal(visible.needs_expert_review, 140);
  });
  await check('Forced small-page retrieval returns complete unique results', async () => {
    const smallPage = { ...meta, limits: { ...meta.limits, default_limit: 17 } };
    const result = await client.features('video', {}, smallPage);
    assert.equal(result.features.length, 164); assert.equal(new Set(result.features.map(f => f.id)).size, 164);
  });
  await check('Point and footprint requests describe identical distress identities', async () => {
    const [points, polygons] = await Promise.all([client.features('video', {}, meta, { geom: 'point' }), client.features('video', {}, meta, { geom: 'footprint' })]);
    assert.deepEqual(points.features.map(f => f.id), polygons.features.map(f => f.id));
    assert.ok(points.features.every(f => f.geometry?.type === 'Point')); assert.ok(polygons.features.some(f => f.geometry?.type === 'Polygon'));
  });
  await check('CSV export matches all filtered IDs across multiple pages and carries one BOM/header', async () => {
    const smallPage = { ...meta, limits: { ...meta.limits, default_limit: 19 } }, filters = { labels: ['Potholes'] };
    const [result, exported] = await Promise.all([client.features('video', filters, meta), client.exportVideo(filters, smallPage)]);
    const rows = csvRows(exported.content), header = rows.shift(), idIndex = header.indexOf('segment_id');
    assert.ok(exported.content.startsWith('\ufeff')); assert.equal((exported.content.match(/\ufeff/g) || []).length, 1);
    assert.equal(rows.length, 131); assert.deepEqual(rows.map(r => r[idIndex]).sort(), result.features.map(f => f.id).sort());
  });
  await check('IST day and night filters partition complete results and CSV respects them', async () => {
    const [day, night, all] = await Promise.all(['day', 'night', 'all'].map(captureTime => client.features('video', { captureTime }, meta)));
    assert.equal(day.features.length + night.features.length, all.features.length);
    const output = await client.exportVideo({ captureTime: 'day' }, meta), rows = csvRows(output.content); rows.shift();
    assert.equal(rows.length, day.features.length);
  });
  await check('Invalid query parameters remain visible as400errors', async () => {
    await assert.rejects(client.json('/gis/video/segments.geojson?label=Pothole'), e => e.status === 400);
    await assert.rejects(client.json('/gis/citizen/assessments.geojson?session=bad'), e => e.status === 400);
    await assert.rejects(client.json('/gis/video/sessions?date_from=2026-10-26'), e => e.status === 400);
  });
  await check('Supplied preview URL resolves to JPEG and missing image returns404', async () => {
    const result = await client.features('video', {}, meta), p = result.features[0].properties;
    const url = GIS.safeURL(p.preview_url, origin), response = await fetch(url);
    assert.ok(url.includes('?w=')); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^image\/jpeg/);
    assert.ok((await response.arrayBuffer()).byteLength > 1000);
    const missing = await fetch(`${origin}/gis/image/nonexistent_segment?w=1280`); assert.equal(missing.status, 404);
  });
})().then(() => report()).catch(error => { console.error(error.message); report(error); process.exitCode = 1; });
