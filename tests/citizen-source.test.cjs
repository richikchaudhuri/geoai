const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../gis-core.js');
const C = require('../citizen-source.js');
const config = {dataSource:'supabase',supabaseUrl:'https://citizens.example.test',supabaseAnonKey:'sb_publishable_fixture'};
const meta = C.metadata();
const photo = (id, extra={}) => ({id,latitude:12.93,longitude:77.57,image_url:`https://images.example.test/${id}.jpg`,created_at:'2026-10-30T02:00:00Z',captured_at:'2026-10-29T01:00:00Z',...extra});
const assessment = (id, photo_id, extra={}) => ({id,photo_id,status:'classified',distress_types:['Pothole (D40)'],severity:'High',stage2_confidence:.9,expert_reviewed:false,created_at:'2026-10-30T02:00:00Z',...extra});
const reply = (data,range,status=200) => ({ok:status>=200&&status<300,status,headers:{get:name=>name.toLowerCase()==='content-range'?range:null},json:async()=>structuredClone(data)});
function backend(photos,assessments,{cap=500,transform}={}) {
  const calls=[];
  const fetch=async (address,init) => {
    const url=new URL(address),table=url.pathname.split('/').at(-1),rows={photos,assessments}[table];
    assert.ok(rows,'Only photos and assessments endpoints are permitted');
    const offset=Number(url.searchParams.get('offset')),limit=Math.min(cap,Number(url.searchParams.get('limit'))),page=rows.slice(offset,offset+limit);
    const range=page.length?`${offset}-${offset+page.length-1}/${rows.length}`:`*/${rows.length}`;
    calls.push({url,init});
    return transform?.({table,url,page,range,offset,calls}) || reply(page,range);
  };
  return {fetch,calls};
}

test('explicit citizen source validates public key kind before any network call', async () => {
  const anon='eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({role:'anon'})).toString('base64url')+'.signature';
  assert.equal(C.configuration({...config,supabaseAnonKey:anon}).key,anon);
  assert.equal(C.configuration(config).origin,config.supabaseUrl);
  for (const bad of ['sb_secret_bad','service_role',anon.replace(anon.split('.')[1],Buffer.from('{"role":"service_role"}').toString('base64url'))]) {
    let calls=0;
    const client=new C.Client({...config,supabaseAnonKey:bad},{fetch:()=>{calls++;}});
    await assert.rejects(()=>client.meta(),/public|anon|secret/);assert.equal(calls,0);
  }
  for (const address of ['https://user:pass@example.test','https://example.test/path','https://example.test?token=a','http://192.168.1.4']) {
    assert.throws(()=>C.configuration({...config,supabaseUrl:address}),/HTTPS/);
  }
  assert.throws(()=>C.configuration({...config,supabaseUrl:'http://127.0.0.1:8765'}),/HTTPS/);
  assert.equal(C.configuration({...config,supabaseUrl:'http://127.0.0.1:8765',supabaseAllowLoopbackHttp:true}).origin,'http://127.0.0.1:8765');
  assert.throws(()=>C.configuration({...config,supabaseUrl:'http://192.168.1.4',supabaseAllowLoopbackHttp:true}),/HTTPS/);
});

test('pagination reads all 357 observations even when the service caps each page at 100', async () => {
  const photos=Array.from({length:357},(_,i)=>photo(i+1)),assessments=photos.map(p=>assessment('a'+p.id,p.id));
  const mock=backend(photos,assessments,{cap:100}),client=new C.Client(config,{fetch:mock.fetch});
  const result=await client.features('citizen',{},meta);
  assert.equal(result.numberMatched,357);assert.equal(result.features.length,357);assert.equal(result.sourceStats.total,357);
  assert.equal(result.truncated,false);assert.equal(mock.calls.length,8);
  for (const {url,init} of mock.calls) {
    assert.equal(url.searchParams.get('order'),'created_at.desc,id.desc');
    assert.equal(init.headers.Prefer,'count=exact');assert.equal(init.headers.apikey,config.supabaseAnonKey);
    assert.equal(init.headers.Authorization,undefined,'Publishable API keys are not bearer JWTs');assert.equal(init.redirect,'error');
  }
  const filtered=await client.features('citizen',{severities:['Low']},meta);
  assert.equal(filtered.numberMatched,0);assert.equal(filtered.sourceStats.total,357);assert.equal(mock.calls.length,8,'Local filtering may reuse the fresh complete response');
});

test('latest assessment and authoritative photo links suppress stale and legacy duplicates', () => {
  const photos=[photo(1),photo(2,{image_url:'https://images.example.test/1.jpg'}),photo(3),photo(4,{latitude:null,longitude:null})];
  const rows=C.merge(photos,[
    assessment('old',1,{created_at:'2026-10-28T01:00:00Z',severity:'Low'}),
    assessment('new',1,{image_url:photos[0].image_url}),
    assessment('legacy',null,{image_url:photos[0].image_url}),
    assessment('orphan',9,{latitude:12.94,longitude:77.58}),
  ]);
  assert.equal(rows.length,5);assert.equal(rows.filter(f=>f.properties.assessment_id==='new').length,1);
  assert.equal(rows.filter(f=>['old','legacy'].includes(f.properties.assessment_id)).length,0);
  assert.equal(rows.find(f=>f.properties.photo_id==='2').properties.vlm_class,'pending');
  assert.equal(rows.find(f=>f.properties.photo_id==='4').geometry,null,'Unlocated records remain counted, never placed at zero coordinates');
});

test('expert corrections, zero confidence, unknown and empty classified labels stay faithful', () => {
  const corrected=C.normalize(photo(1),assessment('a',1,{expert_reviewed:true,expert_corrected_types:[],expert_corrected_severity:'None',stage1_confidence:0}));
  assert.deepEqual(corrected.properties.final_labels,['Normal']);assert.deepEqual(corrected.properties.labels,['Pothole (D40)']);
  assert.equal(corrected.properties.confidence,0);assert.equal(corrected.properties.final_severity,'None');assert.equal(corrected.properties.vlm_class,'normal');
  const pending=C.normalize(photo(2),null);assert.equal(pending.properties.vlm_class,'pending');assert.deepEqual(pending.properties.final_labels,[]);
  const invalid=C.normalize(photo(3),assessment('bad',3,{distress_types:null,stage1_confidence:1.8}));
  assert.equal(invalid.properties.vlm_class,'unknown');assert.equal(invalid.properties.confidence,null);
  const unreviewed=C.normalize(photo(4),assessment('unreviewed',4,{expert_corrected_types:['Normal'],expert_corrected_severity:'None',status:'expert_review',stage2_confidence:0}));
  assert.deepEqual(unreviewed.properties.final_labels,['Pothole (D40)']);assert.equal(unreviewed.properties.confidence,0);
  assert.equal(unreviewed.properties.needs_expert_review,true);assert.equal(G.matches(unreviewed,{},meta,'citizen'),false);
  assert.equal(G.matches(unreviewed,{includeReview:true},meta,'citizen'),true);
});

test('capture null stays unknown, legacy missing field uses upload proxy, and filters use recorded capture time', () => {
  const unknown=C.normalize(photo(1,{captured_at:null}),assessment('a',1));
  assert.equal(unknown.properties.captured_at,null);assert.equal(G.matches(unknown,{captureTime:'day'},meta,'citizen'),false);
  const legacyPhoto=photo(2);delete legacyPhoto.captured_at;
  const legacy=C.normalize(legacyPhoto,assessment('b',2));
  assert.equal(legacy.properties.captured_at,legacyPhoto.created_at);assert.equal(legacy.properties.capture_time_source,'upload_proxy');
  const captured=C.normalize(photo(3),assessment('c',3));
  assert.equal(G.matches(captured,{dateFrom:'2026-10-29',dateTo:'2026-10-29',captureTime:'day'},meta,'citizen'),true);
  assert.equal(G.matches(captured,{dateFrom:'2026-10-30'},meta,'citizen'),false,'Upload time must not replace an existing capture time');
});

test('review/unlocated totals explain matching counts; map-area export contains only located matching rows', async () => {
  const mock=backend([photo(1),photo(2),photo(3,{latitude:null,longitude:null}),photo(4)],
    [assessment('a',1),assessment('review',2,{status:'expert_review'})]);
  const client=new C.Client(config,{fetch:mock.fetch});
  const result=await client.features('citizen',{},meta);
  assert.equal(result.numberMatched,3);assert.deepEqual(result.sourceStats,{total:4,unlocated:1,awaitingReview:1,awaitingAssessment:2});
  const included=await client.features('citizen',{includeReview:true},meta);assert.equal(included.numberMatched,4);
  const area=await client.features('citizen',{includeReview:true},meta,{bbox:'77.5,12.9,77.6,13'});
  assert.equal(area.numberMatched,3);assert.ok(area.features.every(f=>f.geometry));
});

test('only the specific missing captured_at schema error permits a compatibility retry', async () => {
  const mock=backend([photo(1)],[],{transform:({table,url})=>table==='photos'&&url.searchParams.get('select').includes('captured_at')
    ? reply({code:'42703',message:'column photos.captured_at does not exist'},null,400):null});
  const client=new C.Client(config,{fetch:mock.fetch});
  assert.equal((await client.features('citizen',{},meta)).numberMatched,1);
  assert.equal(mock.calls.filter(c=>c.url.pathname.endsWith('/photos')).length,2);
  for (const status of [400,401,403,500]) {
    const calls=[];
    const denied=new C.Client(config,{fetch:async url=>{calls.push(url);return reply({code:'42703',message:'column something_else does not exist'},null,status);}});
    await assert.rejects(()=>denied.features('citizen',{},meta),new RegExp('HTTP '+status));
    assert.ok(calls.every(url=>url.startsWith(config.supabaseUrl+'/rest/v1/')),'Never fall back to GIS or a frozen snapshot');
  }
});

test('missing totals, changed totals, duplicate pages and download caps fail instead of showing a partial count', async () => {
  for (const kind of ['missing','changing','duplicate','cap']) {
    const mock=backend([photo(1),photo(2),photo(3)],[],{cap:1,transform:({table,page,range,offset})=>{
      if(table!=='photos') return null;
      if(kind==='missing') return reply(page,null);
      if(kind==='changing'&&offset) return reply(page,`${offset}-${offset}/4`);
      if(kind==='duplicate'&&offset) return reply([photo(1)],range);
      return null;
    }});
    const client=new C.Client(config,{fetch:mock.fetch,maxRows:kind==='cap'?2:20000});
    await assert.rejects(()=>client.features('citizen',{},meta),/complete|changed|duplicate|limit/);
    assert.equal(client.snapshot,undefined);
  }
});

test('empty database is a verified empty live result and no drive request is issued', async () => {
  const mock=backend([],[]),client=new C.Client(config,{fetch:mock.fetch});
  const result=await client.features('citizen',{},meta);assert.equal(result.numberMatched,0);assert.equal(result.sourceStats.total,0);
  await assert.rejects(()=>client.features('video',{},meta),/not connected/);
  await assert.rejects(()=>client.exportVideo(),/not connected/);
  assert.equal((await client.sessions()).unavailable,true);assert.equal(mock.calls.length,2);
});

test('aborted and timed-out loads never publish an incomplete snapshot', async () => {
  const controller=new AbortController();controller.abort();
  let calls=0;const client=new C.Client(config,{fetch:async()=>{calls++;return new Promise(()=>{});},timeoutMs:10});
  await assert.rejects(()=>client.features('citizen',{},meta,{signal:controller.signal}),{name:'AbortError'});assert.equal(calls,0);
  await assert.rejects(()=>client.features('citizen',{},meta),/timed out/);assert.equal(client.snapshot,undefined);
});
