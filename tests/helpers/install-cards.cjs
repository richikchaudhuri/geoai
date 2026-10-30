/* Load the actual production card subsystem in an existing jsdom context.
 * This excludes unrelated map/network startup, not card implementation logic. */
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function installCards(window, context) {
  const source = readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  const section = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
    if (a < 0 || b <= a) throw new Error('Production card source boundaries changed: ' + start);
    return source.slice(a,b);
  };
  window.aboutStack = window.document.getElementById('aboutStack');
  window.filterStack = window.document.getElementById('filterStack');
  window.closeAboutStack ||= () => window.aboutStack?.classList.remove('open');
  window.closeFilterStack ||= () => window.filterStack?.classList.remove('open');
  window.matchMedia ||= () => ({ matches:false });
  window.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} };
  window.requestAnimationFrame ||= fn => window.setTimeout(fn,16);
  window.cancelAnimationFrame ||= id => window.clearTimeout(id);
  window.map.flyTo ||= () => {};
  window.map.latLngToContainerPoint ||= () => ({ x:200,y:200 });
  const production = [
    section('const DISTRESS_COLORS =', 'const SEVERITY_RADIUS ='),
    section('function pickPrimaryType(types)', 'function isRecord(row)'),
    section('function isRecord(row)', 'async function withDeadline'),
    section('function isDaytime(', '/* ---------- Severity filter state'),
    section('function isSameLocation(', 'function addSingleMarker('),
    section('/* ---------- Cards (single + clustered) ---------- */', '/* ---------- Nav pill (icon → icon+label active state) ---------- */'),
  ].join('\n');
  vm.runInContext(production, context);
  return { read: code => vm.runInContext(code, context) };
}
module.exports = { installCards };
