// Verify the actual WKUserScript bridge without requiring an iOS simulator.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../GeoAI/Survey/SurveyDashboardView.swift'), 'utf8');
const script = source.split('private static let bridgeScript = """')[1]?.split('"""')[0];
assert.ok(script, 'Native bridge source must be available');
const listeners = {}, messages = [];
vm.runInNewContext(script, {
  document: { addEventListener: (name, listener) => { listeners[name] = listener; } },
  window: { webkit: { messageHandlers: { geoaiSurvey: { postMessage: message => messages.push(message) } } } },
});
let prevented = 0;
const event = detail => ({ detail, cancelable: true, preventDefault: () => { prevented++; } });
listeners['geoai:share'](event({ url: 'https://survey.example/gis/app/?video=1', type: 'injected' }));
assert.equal(messages.at(-1).type, 'share');
assert.equal(prevented, 1);
listeners['geoai:export'](event({ content: 'a,b\n1,2', filename: 'survey.csv', mime: 'text/csv' }));
assert.equal(messages.at(-1).type, 'export');
assert.equal(messages.at(-1).content, 'a,b\n1,2');
assert.equal(prevented, 2);
listeners['geoai:export'](event({ url: '/gis/video/segments.csv?severity=High' }));
assert.equal(messages.at(-1).url, '/gis/video/segments.csv?severity=High');
assert.equal(prevented, 3);
listeners['geoai:export'](event({ content: 'x'.repeat(10485761) }));
assert.equal(messages.at(-1).type, 'exportTooLarge');
assert.equal(prevented, 4);
listeners['geoai:share'](event(null));
assert.equal(messages.length, 4);
assert.equal(prevented, 4);
const sharingExpression = source.match(/evaluateJavaScript\("(Boolean\(window\.geoaiSurvey[^"]+)"\)/)?.[1];
assert.ok(sharingExpression, 'Toolbar sharing must use the current shared controller');
let sharedCurrentView = 0;
assert.equal(vm.runInNewContext(sharingExpression, { window: { geoaiSurvey: { share: () => { sharedCurrentView++; } } } }), true);
assert.equal(sharedCurrentView, 1);
assert.equal(vm.runInNewContext(sharingExpression, { window: {} }), false);
const capability = source.split('private static let capabilityScript = """')[1]?.split('"""')[0];
assert.ok(capability, 'Dashboard capability validation must be available');
const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
const supports = mutate => {
  const dom = new JSDOM(html, { url: 'https://survey.example/gis/app/' });
  if (mutate) mutate(dom.window.document);
  const result = vm.runInNewContext(capability, { document: dom.window.document, URL });
  dom.window.close();
  return result;
};
assert.equal(supports(), true, 'Current shipped dashboard supports the mobile update');
assert.equal(supports(document => document.querySelector('meta[name="geoai-survey-ui-version"]').remove()), false);
assert.equal(supports(document => document.querySelector('meta[name="geoai-survey-ui-version"]').content = '20261029'), false);
assert.equal(supports(document => document.querySelector('meta[name="geoai-survey-ui-version"]').content = 'invalid'), false);
assert.equal(supports(document => document.querySelector('meta[name="geoai-survey-ui-version"]').content = 'Infinity'), false);
assert.equal(supports(document => document.querySelector('meta[name="geoai-survey-ui-version"]').content = '20261101'), true);
assert.equal(supports(document => document.getElementById('videoToggle').remove()), false);
for (const asset of ['gis-core.js', 'video.js', 'survey.js', 'drive-player.js', 'drive-inspector.js']) {
  assert.equal(supports(document => document.querySelector(`script[src^="${asset}"]`).remove()), false, `${asset} is required`);
}
// The capability must be available before asynchronous map setup or API calls.
// No application globals are supplied to supports(); a present loading screen
// and absent dynamically-created inspector must not incorrectly reject it.
assert.equal(supports(document => {
  assert.ok(document.getElementById('loadingScreen'));
  assert.equal(document.getElementById('driveInspector'), null);
}), true);
assert.match(source, /cachePolicy: \.reloadRevalidatingCacheData/);
console.log('PASS: native bridge share, CSV content, CSV URL, oversized export, malformed event, current-view toolbar and dashboard revision/asset contract checks');
