#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configuration } = require('../citizen-source.js');

// Publish only browser assets. Never copy the repository, native clients,
// snapshots, local configuration, or build artifacts into the hosted site.
const PUBLIC_ASSETS = Object.freeze([
  'index.html', 'config.js', 'app.js', 'gis-core.js', 'citizen-source.js',
  'basemaps.js', 'survey.js', 'survey.css', 'video.js', 'video.css',
  'drive-player.js', 'drive-player.css', 'drive-inspector.js',
  'drive-inspector.css', 'styles.css', 'favicon.svg', 'fonts/rostex.outline.ttf',
]);

function publicSettings(root, shareBaseUrl) {
  // Reuse the original client configuration, avoiding a second key to maintain.
  // The native source file itself is never included in the published output.
  const source = fs.readFileSync(path.join(root,
    'mobile/app/src/main/java/com/example/msc/PublicBackendConfig.kt'), 'utf8');
  const constant = name => {
    const value = source.match(new RegExp(`\\bconst\\s+val\\s+${name}\\s*=\\s*("[^"\\r\\n]*")`));
    if (!value) throw new Error(`Missing public client setting: ${name}`);
    return JSON.parse(value[1]);
  };
  const shareURL = new URL(shareBaseUrl);
  if (shareURL.protocol !== 'https:' || shareURL.username || shareURL.password || shareURL.search || shareURL.hash) {
    throw new Error('The public share URL must be an HTTPS website address without credentials, query or fragment.');
  }
  const config = {
    dataSource: 'supabase',
    supabaseUrl: constant('SUPABASE_URL'),
    supabaseAnonKey: constant('SUPABASE_PUBLIC_KEY'),
    shareBaseUrl,
  };
  // Fail before publishing if the source ever contains a private/service key.
  configuration(config);
  return config;
}

function buildStatic(root = path.resolve(__dirname, '..'), {
  shareBaseUrl = process.env.GEOAI_SHARE_BASE_URL || 'https://gisgeoai.netlify.app',
} = {}) {
  const config = publicSettings(root, shareBaseUrl);
  const files = PUBLIC_ASSETS.map(name => {
    const source = path.join(root, name);
    if (!fs.lstatSync(source).isFile()) throw new Error(`Expected a regular public asset: ${name}`);
    return [name, name === 'config.js'
      ? '// Generated for explicit citizen-only static hosting.\n' +
        `window.GIS_CONFIG = ${JSON.stringify(config, null, 2)};\n`
      : fs.readFileSync(source)];
  });
  const output = path.join(root, 'dist');
  fs.rmSync(output, { recursive: true, force: true });
  for (const [name, contents] of files) {
    const destination = path.join(output, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }
  return { output, assets: files.length };
}

if (require.main === module) {
  const result = buildStatic();
  console.log(`Prepared ${result.assets} public assets in dist for the citizen dashboard.`);
}

module.exports = { buildStatic, PUBLIC_ASSETS };
