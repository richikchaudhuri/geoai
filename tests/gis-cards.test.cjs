/* Exercise the repository's actual anchored-card implementation, independently
 * of map tile/network startup. Survey adapter integration lives in survey.test. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { installCards } = require('./helpers/install-cards.cjs');

function row(id = 'segment-a', overrides = {}) {
  const properties = { layer: 'video', segment_id: id, session_id: 'drive-a', final_labels: ['Potholes'], final_severity: 'High',
    confidence: 0, labels: ['Bleeding'], severity: 'Low', stage2_confidence: .99, expert_reviewed: true, needs_expert_review: false,
    created_at: '2026-10-26T08:00:00Z', utc: '2026-10-26T08:00:00Z', ...overrides };
  return { id, latitude: 12.928, longitude: 77.566, address: 'Test Road', description: 'A road observation.',
    severity: 'Low', distress_types: ['Bleeding'], stage2_confidence: .99, image_url: 'https://images.test/original-never-automatic.png',
    __gis: { feature: { type: 'Feature', id, geometry: { type: 'Point', coordinates: [77.566,12.928] }, properties },
      labelColors: { Potholes: '#7f1d1d', Bleeding: '#6d28d9' }, previewURL: `https://images.test/${id}?w=1280`, thumbnailURL: `https://images.test/${id}?w=480`,
      fullURL: `https://images.test/${id}`, capturedText: '26 Oct 2026, 1:30 pm IST', reviewText: 'Expert-reviewed',
      extraRows: [['Source','Drive video'],['Distance from start','45.0 m'],['Accuracy','±6 m (1σ)']], originalLabels: ['Bleeding'], confidenceThreshold: .8 } };
}
function harness(t, { width = 1280, height = 800, reducedMotion = false } = {}) {
  const dom = new JSDOM('<!doctype html><main><div class="topbar"><a class="brand">GEOAI</a></div><div class="nav-item" data-page="map"></div><div id="aboutStack"></div><div id="filterStack"></div><div id="cardStack"></div><svg id="cardConnectors"></svg></main>', { url:'https://example.test/gis/app/', runScripts:'outside-only' });
  const w = dom.window, timers = new Map(), moves = [], observed = new Set(); let clock = 0, next = 0;
  w.innerWidth = width; w.innerHeight = height;
  w.setTimeout = (fn, delay = 0) => { const id = ++next; timers.set(id,{fn,at:clock + delay}); return id; };
  w.clearTimeout = id => timers.delete(id); w.requestAnimationFrame = fn => w.setTimeout(fn,16); w.cancelAnimationFrame = w.clearTimeout;
  const advance = ms => { const end=clock+ms; let count=0;
    for (;;) { const due=[...timers].filter(([,x])=>x.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!due)break;
      assert.ok(++count<10000,'Card animations must terminate');timers.delete(due[0]);clock=due[1].at;due[1].fn(); }
    clock=end;
  };
  w.matchMedia = query => ({matches:reducedMotion && query.includes('prefers-reduced-motion')});
  w.ResizeObserver = class { observe(el){observed.add(el);} unobserve(el){observed.delete(el);} disconnect(){observed.clear();} };
  const map = { getZoom:()=>16, flyTo:(...args)=>moves.push(args), latLngToContainerPoint:()=>({x:width/2,y:height/2}), on(){} };
  Object.assign(w,{map,
    aboutStack:w.document.getElementById('aboutStack'),filterStack:w.document.getElementById('filterStack'),
    closeAboutStack(){w.aboutStack.classList.remove('open');},closeFilterStack(){w.filterStack.classList.remove('open');}});
  Object.defineProperty(w.HTMLElement.prototype,'offsetWidth',{get(){return Math.min(this.classList.contains('expanded')?660:340,width-56);}});
  Object.defineProperty(w.HTMLElement.prototype,'offsetHeight',{get(){return this.classList.contains('expanded')?Math.min(520,height-100):220;}});
  w.HTMLElement.prototype.getBoundingClientRect = function(){const left=parseFloat(this.style.left)||0,top=parseFloat(this.style.top)||0;return{left,top,right:left+this.offsetWidth,bottom:top+this.offsetHeight,width:this.offsetWidth,height:this.offsetHeight};};
  const context=dom.getInternalVMContext();installCards(w,context);
  const show=(rows,elapsed=2300)=>{w.showCards(rows);advance(elapsed);};
  t.after(()=>{timers.clear();dom.window.close();});
  return {w,advance,show,moves,observed,read:code=>vm.runInContext(code,context),cards:()=>[...w.document.querySelectorAll('#cardStack .detail-panel.open')]};
}

test('GIS observations reuse the original horizontal thumbnail cards and marker connectors', t => {
  const h=harness(t);h.show([row()]);
  const card=h.cards()[0];assert.ok(card.classList.contains('clickable'));assert.equal(card.classList.contains('expanded'),false);
  assert.ok(card.querySelector('.detail-photo-wrap .detail-photo'));assert.ok(card.querySelector('.detail-body'));
  assert.equal(h.w.document.querySelector('.survey-evidence'),null,'Do not replace the repo preview with a separate sidebar');
  assert.equal(card.querySelector('.detail-photo').src,'https://images.test/segment-a?w=480');
  assert.equal(card.classList.contains('loading'),false,'GIS previews reveal after the original loading interval');
  assert.ok(h.w.document.querySelector('#cardConnectors .anchor-dot'));
  assert.equal(h.moves.length,1);assert.deepEqual(Array.from(h.moves[0][0]),[12.928,77.566]);
});

test('preview labels, severity, colours and zero confidence use final GIS fields', t => {
  const h=harness(t);h.show([row()]);const card=h.cards()[0];
  assert.equal(card.querySelector('.severity-badge').textContent,'High');
  assert.equal(card.querySelector('.detail-confidence').textContent,'0% confidence');
  assert.equal(card.querySelector('.detail-tags').textContent,'Potholes');
  assert.equal(card.querySelector('.detail-tag').style.background,'rgb(127, 29, 29)');
  const captured=card.querySelector('.detail-meta dd');
  assert.equal(captured.title,'26 Oct 2026, 1:30 pm IST');
  assert.equal(captured.getAttribute('aria-label'),'26 Oct 2026, 1:30 pm IST');
  assert.match(captured.textContent,/26 Oct/);
  assert.match(card.textContent,/Expert-reviewed/);
});

test('clicking a preview expands the same card using a preview image and explicit original link', t => {
  const h=harness(t);h.show([row()]);h.cards()[0].click();h.advance(2500);
  const expanded=h.w.document.querySelector('#cardStack .detail-panel.expanded.open');assert.ok(expanded);
  assert.equal(expanded.querySelector('.expanded-photo').src,'https://images.test/segment-a?w=1280');
  assert.equal(expanded.querySelector('a[href="https://images.test/segment-a"]').textContent,'Open full resolution');
  assert.ok([...h.w.document.querySelectorAll('img')].every(img=>img.getAttribute('src')!=='https://images.test/segment-a'));
  assert.match(expanded.textContent,/0% confidence/);assert.match(expanded.textContent,/45.0 m/);assert.match(expanded.textContent,/±6 m/);
  assert.match(expanded.textContent,/26 Oct 2026, 1:30 pm IST/);
  assert.equal(expanded.querySelector('[role="meter"]').getAttribute('aria-valuenow'),'0');
  assert.equal(expanded.querySelector('.card-confidence-value').style.width,'0%');
  assert.equal(expanded.querySelector('.card-confidence-threshold').style.left,'80%');
  assert.deepEqual([...expanded.querySelectorAll('s')].map(el=>el.textContent),['Bleeding','Low']);
  assert.equal(expanded.classList.contains('loading'),false);
});

test('Enter and Space expand previews without activating the close button', t => {
  const h=harness(t);
  for(const key of ['Enter',' ']) { h.show([row()]);const card=h.cards()[0];
    assert.equal(card.getAttribute('tabindex'),'0');
    card.dispatchEvent(new h.w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));h.advance(2500);
    assert.ok(h.w.document.querySelector('.detail-panel.expanded.open'));
    h.w.hideCards();h.advance(650);
  }
});

test('desktop groups keep three previews and a View more list for every remaining observation', t => {
  const h=harness(t);const rows=Array.from({length:6},(_,i)=>row('s'+i));h.show(rows);
  assert.equal(h.w.document.querySelectorAll('.detail-panel.clickable.open').length,3);
  const more=h.w.document.querySelector('.view-more.open');assert.ok(more);assert.match(more.textContent,/\+3 more/);
  more.click();h.advance(500);const list=h.w.document.querySelector('.list-card.open');assert.ok(list);
  assert.equal(list.querySelectorAll('.list-row').length,6);
  assert.ok([...list.querySelectorAll('img')].every(img=>img.src.includes('w=480')));
  list.querySelector('.list-row').click();h.advance(700);
  assert.equal(h.w.document.querySelectorAll('.clickable.open').length,1);
});

test('missing and failed thumbnails show placeholders without fetching an original image', t => {
  const h=harness(t),missing=row();missing.__gis.thumbnailURL=null;missing.__gis.previewURL=null;
  h.show([missing]);let card=h.cards()[0];
  assert.ok(!card.querySelector('.detail-photo')?.getAttribute('src'));assert.match(card.textContent,/preview|image|frame/i);
  h.show([row()]);card=h.cards()[0];const img=card.querySelector('.detail-photo');img.dispatchEvent(new h.w.Event('error'));
  assert.ok(!img.isConnected||img.hidden||img.style.display==='none');assert.match(card.textContent,/unavailable/i);
  assert.ok([...h.w.document.querySelectorAll('img')].every(el=>!el.src.includes('original-never-automatic')));
});

test('closing before expansion finishes cannot resurrect a stale card or its connectors', t => {
  const h=harness(t);h.show([row()]);h.cards()[0].click();h.w.hideCards();h.advance(3000);
  assert.equal(h.w.document.querySelectorAll('#cardStack .detail-panel').length,0);
  assert.equal(h.w.document.querySelector('#cardConnectors').children.length,0);
  assert.equal(h.observed.size,0);
});

test('narrow screens keep grouped observations reachable without a three-card overlap', t => {
  const h=harness(t,{width:375,height:812});h.show(Array.from({length:5},(_,i)=>row('mobile-'+i)));
  assert.equal(h.w.document.querySelectorAll('.clickable.open').length,1);
  const more=h.w.document.querySelector('.view-more.open');assert.ok(more);more.click();h.advance(500);
  assert.equal(h.w.document.querySelectorAll('.list-card.open .list-row').length,5);
  for(const card of h.cards()){assert.ok(parseFloat(card.style.left)>=0);assert.ok(parseFloat(card.style.top)>=0);}
});

test('missing authoritative fields never silently resurrect original model predictions', t => {
  const h=harness(t);
  h.show([row('unclassified',{final_labels:[],final_severity:null,confidence:null})]);
  const card=h.cards()[0];
  assert.equal(card.querySelector('.detail-tags').textContent,'Unclassified');
  assert.equal(card.querySelector('.severity-badge').textContent,'Unknown');
  assert.equal(card.querySelector('.detail-confidence').textContent,'Confidence unavailable');
  assert.doesNotMatch(card.textContent,/Bleeding|99%/);
});

test('metadata colours accept Map entries and ignore unsafe style values', t => {
  const h=harness(t), valid=row(),unsafe=row('unsafe');
  valid.__gis.labelColors=new Map([['Potholes','#abcdef']]);
  h.show([valid]);assert.equal(h.cards()[0].querySelector('.detail-tag').style.background,'rgb(171, 205, 239)');
  unsafe.__gis.labelColors={Potholes:'red; background-image:url(https://tracking.test/image)'};
  h.show([unsafe]);assert.equal(h.cards()[0].querySelector('.detail-tag').style.backgroundImage,'');
  const fallback=h.w.document.createElement('span');fallback.style.background=h.read('UNKNOWN_COLOR');
  assert.equal(h.cards()[0].querySelector('.detail-tag').style.background,fallback.style.background);
});

test('untrusted labels and metadata remain text, and unsafe image links are omitted', t => {
  const h=harness(t), observation=row('unsafe',{final_labels:['<img src=x onerror="alert(1)">'],final_severity:'<script>alert(1)</script>'});
  observation.address='<iframe src="https://tracking.test"></iframe>';
  observation.description='<script>alert(1)</script>';
  observation.__gis.previewURL='javascript:alert(1)';observation.__gis.thumbnailURL='file:///private/photo.jpg';
  observation.__gis.fullURL='https://user:password@images.test/private';
  observation.__gis.extraRows=[['<script>name</script>','<iframe>value</iframe>']];
  h.show([observation]);h.cards()[0].click();h.advance(2500);
  const expanded=h.w.document.querySelector('.expanded.open');
  assert.equal(expanded.querySelectorAll('script,iframe,img[onerror],a').length,0);
  assert.equal(expanded.querySelector('.expanded-photo').hasAttribute('src'),false);
  assert.match(expanded.textContent,/<script>alert\(1\)<\/script>/);
  assert.match(expanded.textContent,/<iframe>value<\/iframe>/);
});

test('opening another observation invalidates a pending expansion and old removal timers', t => {
  const h=harness(t);h.show([row('old')]);h.cards()[0].click();
  h.show([row('new')]);h.advance(3000);
  assert.equal(h.cards().length,1);
  assert.equal(h.cards()[0].dataset.observationId,'new');
  assert.equal(h.w.document.querySelectorAll('.expanded').length,0);
  assert.equal(h.observed.size,1);
  assert.ok(h.w.document.querySelector('#cardConnectors .anchor-dot'));
});

test('an explicit group anchor is respected without moving the camera when focus is disabled', t => {
  const h=harness(t);h.w.showCards([row()],{anchor:[12,77],focus:false});h.advance(350);
  assert.deepEqual(Array.from(h.read('selectedLatLng')),[12,77]);
  assert.equal(h.moves.length,0);
  assert.equal(h.cards().length,1);
});

test('existing assessment cards retain their original structure, review fields and expansion flow', t => {
  const h=harness(t), original={id:'legacy',latitude:12,longitude:77,address:'Original address',image_url:'https://images.test/legacy',
    distress_types:['Bleeding'],severity:'Low',stage2_confidence:.82,expert_reviewed:true,expert_corrected_types:['Potholes'],expert_corrected_severity:'High'};
  h.show([original],350);let card=h.cards()[0];
  assert.equal(card.classList.contains('gis-card'),false);assert.ok(card.classList.contains('loading'));
  h.advance(2000);assert.equal(card.classList.contains('loading'),false);
  assert.equal(card.querySelector('.detail-tags').textContent,'Potholes');
  assert.equal(card.querySelector('.detail-photo').src,original.image_url);
  card.click();h.advance(2500);card=h.w.document.querySelector('.expanded.open');
  assert.ok(card);assert.match(card.textContent,/Expert review/);assert.match(card.textContent,/Verified/);
  assert.equal(card.querySelector('.expanded-photo').src,original.image_url);
});

test('list selection announces the new card after clearing its previous selection state', t => {
  const h=harness(t), opened=[],closed=[];
  h.w.document.addEventListener('geoai:cardsopened',event=>opened.push(event.detail));
  h.w.document.addEventListener('geoai:cardsclosed',()=>closed.push({
    active:h.read('activeCards.length'),anchor:h.read('selectedLatLng'),open:h.cards().length,
  }));
  const rows=Array.from({length:5},(_,i)=>row('list-'+i));h.show(rows);
  h.w.document.querySelector('.view-more.open').click();h.advance(500);
  h.w.document.querySelectorAll('.list-card.open .list-row')[2].click();h.advance(350);
  assert.equal(opened.length,2);
  assert.equal(opened[1].row.__gis.feature.id,'list-2');
  assert.deepEqual(Array.from(opened[1].anchor),[12.928,77.566]);
  assert.equal(opened[1].rows.length,1);
  assert.ok(closed.every(state=>state.active===0&&state.anchor===null&&state.open===0));
});

test('reduced motion opens all previews together and skips camera animation and radar pulses', t => {
  const h=harness(t,{reducedMotion:true});
  h.w.showCards(Array.from({length:4},(_,i)=>row('still-'+i)));h.advance(32);
  assert.equal(h.w.document.querySelectorAll('.detail-panel.open').length,4);
  assert.equal(h.w.document.querySelectorAll('.detail-panel.loading').length,0);
  assert.equal(h.moves[0][2].animate,false);assert.equal(h.moves[0][2].duration,0);
  assert.equal(h.w.document.querySelectorAll('.radar-ring').length,0);
  h.cards()[0].click();h.advance(32);
  assert.ok(h.w.document.querySelector('.expanded.open'));
  assert.equal(h.w.document.querySelector('.expanded.open').classList.contains('loading'),false);
});

test('GIS cards retain the original loading pills during map flight and the expanded reveal', t => {
  const h=harness(t);h.w.showCards([row()]);h.advance(1100);
  const preview=h.cards()[0];
  assert.equal(h.moves[0][2].duration,1.1);
  assert.equal(preview.classList.contains('loading'),true,'The full preview stays hidden throughout the camera flight');
  preview.click();assert.equal(h.w.document.querySelector('.expanded'),null,'A loading pill cannot expand');
  h.advance(900);assert.equal(preview.classList.contains('loading'),true);
  h.advance(32);assert.equal(preview.classList.contains('loading'),false);
  preview.click();h.advance(416);
  const expanded=h.w.document.querySelector('.expanded.open');assert.ok(expanded);
  assert.equal(expanded.classList.contains('loading'),true);
  assert.equal(expanded.querySelector('.expanded-photo'),null);
  h.advance(1999);assert.equal(expanded.classList.contains('loading'),true);
  h.advance(1);assert.equal(expanded.classList.contains('loading'),false);
  assert.equal(expanded.querySelector('.expanded-photo').src,'https://images.test/segment-a?w=1280');
});
