const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { buildStatic, PUBLIC_ASSETS } = require('../tools/build-static.cjs');

const repo = path.resolve(__dirname, '..');
const nativeConfig = 'mobile/app/src/main/java/com/example/msc/PublicBackendConfig.kt';
const filesIn = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? filesIn(path.join(root, entry.name)).map(name => `${entry.name}/${name}`) : [entry.name]).sort();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geoai-static-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of [...PUBLIC_ASSETS, nativeConfig]) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.copyFileSync(path.join(repo, name), path.join(root, name));
  }
  return root;
}

test('static publish contains only complete public assets with an explicit citizen source', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'old-private-file'), 'must disappear');
  fs.writeFileSync(path.join(root, '.env'), 'must not publish');
  fs.writeFileSync(path.join(root, 'unexpected.js'), 'must not publish');
  const originalConfig = fs.readFileSync(path.join(root, 'config.js'), 'utf8');
  const result = buildStatic(root, { shareBaseUrl: 'https://gisgeoai.netlify.app' });
  assert.equal(result.assets, 17);
  assert.deepEqual(filesIn(result.output), [...PUBLIC_ASSETS].sort());
  assert.equal(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), originalConfig);
  for (const name of PUBLIC_ASSETS.filter(name => name !== 'config.js')) {
    assert.deepEqual(fs.readFileSync(path.join(result.output, name)), fs.readFileSync(path.join(root, name)));
  }
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(result.output, 'config.js'), 'utf8'), context);
  const config = context.window.GIS_CONFIG;
  assert.equal(config.dataSource, 'supabase');
  assert.equal(config.shareBaseUrl, 'https://gisgeoai.netlify.app');
  const source = fs.readFileSync(path.join(root, nativeConfig), 'utf8');
  assert.ok(source.includes(JSON.stringify(config.supabaseUrl)));
  assert.ok(source.includes(JSON.stringify(config.supabaseAnonKey)));
  assert.equal(JSON.parse(Buffer.from(config.supabaseAnonKey.split('.')[1], 'base64url')).role, 'anon');
  const html = fs.readFileSync(path.join(result.output, 'index.html'), 'utf8');
  for (const [, value] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (!/^https?:/.test(value)) assert.ok(fs.existsSync(path.join(result.output, value.split('?')[0])), `Missing ${value}`);
  }
  const css = fs.readFileSync(path.join(result.output, 'styles.css'), 'utf8');
  for (const [, value] of css.matchAll(/url\("([^"]+)"\)/g)) {
    assert.ok(fs.existsSync(path.join(result.output, value)), `Missing ${value}`);
  }
});

test('a private backend key prevents static publication without replacing prior output', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, nativeConfig),
    'const val SUPABASE_URL = "https://citizens.example.test"\n' +
    'const val SUPABASE_PUBLIC_KEY = "sb_secret_must_not_publish"\n');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'previous-output'), 'retained');
  assert.throws(() => buildStatic(root), /public|anon/i);
  assert.deepEqual(filesIn(path.join(root, 'dist')), ['previous-output']);
});

test('static publication accepts a Pages project URL and rejects unsafe share addresses', t => {
  const root = fixture(t);
  const shareBaseUrl = 'https://richikchaudhuri.github.io/geoai/';
  const { output } = buildStatic(root, { shareBaseUrl });
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(output, 'config.js'), 'utf8'), context);
  assert.equal(context.window.GIS_CONFIG.shareBaseUrl, shareBaseUrl);
  for (const value of ['http://example.com', 'https://user:password@example.com', 'https://example.com/?key=private', 'https://example.com/#fragment']) {
    assert.throws(() => buildStatic(root, { shareBaseUrl: value }), /public share URL/);
  }
});
