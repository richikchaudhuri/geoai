/* Explicit, read-only citizen source for installations using the original
 * photos/assessments tables. No GIS endpoint or frozen-data fallback is used.
 * Merge/capture semantics follow ios/Packages/GeoAICore/SnapshotDecoder.swift.
 * Styles below are the existing GIS taxonomy and original app.js RDD styles;
 * they contain no observations, counts, geometry or sample drive data. */
(function (root, factory) {
  const api = factory(root ? root.GeoAIGIS : require('./gis-core.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GeoAICitizenSource = api;
}(typeof window !== 'undefined' ? window : null, function (G) {
  'use strict';
  const METADATA = {"schema":"geoai.gis.v1","labels":[{"name":"Bleeding","is_distress":true,"category":"Surface Defects","color":"#6d28d9","marker_priority":16},{"name":"Streaking","is_distress":true,"category":"Surface Defects","color":"#a855f7","marker_priority":18},{"name":"Hungry Surface","is_distress":true,"category":"Surface Defects","color":"#d946ef","marker_priority":17},{"name":"Hairline Cracks","is_distress":true,"category":"Cracks","color":"#eab308","marker_priority":15},{"name":"Alligator Cracking","is_distress":true,"category":"Cracks","color":"#dc2626","marker_priority":5},{"name":"Longitudinal Cracking","is_distress":true,"category":"Cracks","color":"#f59e0b","marker_priority":14},{"name":"Transverse Cracking","is_distress":true,"category":"Cracks","color":"#f97316","marker_priority":13},{"name":"Edge Cracking","is_distress":true,"category":"Cracks","color":"#c2410c","marker_priority":12},{"name":"Slippage","is_distress":true,"category":"Deformation","color":"#0ea5e9","marker_priority":11},{"name":"Rutting","is_distress":true,"category":"Deformation","color":"#2563eb","marker_priority":8},{"name":"Corrugation","is_distress":true,"category":"Deformation","color":"#0891b2","marker_priority":10},{"name":"Shoving","is_distress":true,"category":"Deformation","color":"#1e40af","marker_priority":9},{"name":"Shallow Depression","is_distress":true,"category":"Deformation","color":"#14b8a6","marker_priority":7},{"name":"Settlement","is_distress":true,"category":"Deformation","color":"#0f766e","marker_priority":6},{"name":"Stripping","is_distress":true,"category":"Disintegration","color":"#a16207","marker_priority":4},{"name":"Ravelling","is_distress":true,"category":"Disintegration","color":"#92400e","marker_priority":3},{"name":"Potholes","is_distress":true,"category":"Disintegration","color":"#7f1d1d","marker_priority":1},{"name":"Edge Breaking","is_distress":true,"category":"Disintegration","color":"#be123c","marker_priority":2},{"name":"Normal","is_distress":false,"category":"Normal","color":"#16a34a","marker_priority":19},{"name":"Longitudinal Crack (D00)","color":"#FCD34D","marker_priority":25,"is_distress":true,"category":"Recorded RDD types"},{"name":"Transverse Crack (D10)","color":"#FB923C","marker_priority":24,"is_distress":true,"category":"Recorded RDD types"},{"name":"Alligator Crack (D20)","color":"#EF4444","marker_priority":22,"is_distress":true,"category":"Recorded RDD types"},{"name":"Pothole (D40)","color":"#991B1B","marker_priority":20,"is_distress":true,"category":"Recorded RDD types"},{"name":"Block Crack (D43)","color":"#A855F7","marker_priority":23,"is_distress":true,"category":"Recorded RDD types"}],"other_label_color":"#6b7280","severities":[{"name":"None","radius_px":4},{"name":"Low","radius_px":6},{"name":"Medium","radius_px":9},{"name":"High","radius_px":13},{"name":"Unknown","radius_px":4}],"vlm_classes":[{"name":"distress","color":null,"meaning":"answered; at least one IRC:82 distress label (colour by marker_label)"},{"name":"normal","color":"#16a34a","meaning":"answered; Normal"},{"name":"unknown","color":"#6b7280","meaning":"answered, but without a valid label"},{"name":"pending","color":"#9ca3af","meaning":"sent to the VLM, answer not stored yet"},{"name":"not_sent","color":"#d1d5db","meaning":"covered, the frame-level gate said skip (not classified)"},{"name":"not_covered","color":"#111827","meaning":"never imaged (GNSS gap, stopped, black frames): no data"}],"confidence_threshold":0.8,"limits":{"default_limit":5000,"max_limit":20000}};
  const VIDEO_UNAVAILABLE = 'Drive routes are not connected. This source contains citizen photos only. Connect the video GIS server in the app settings when it is available.';
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o || {}, key);
  const text = value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  const number = value => typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  const id = row => text(row?.id);
  const photoID = row => text(row?.photo_id);
  const list = value => Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))] : null;
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
  const time = value => date(value) ? Date.parse(value) : -Infinity;
  const point = row => G.validCoordinates(number(row?.latitude), number(row?.longitude))
    ? [number(row.longitude), number(row.latitude)] : null;
  const image = row => /^https?:\/\//i.test(text(row?.image_url)) ? G.safeURL(row.image_url) : null;
  const severity = value => ({ low:'Low', less:'Low', medium:'Medium', moderate:'Medium', high:'High', 'red alert':'High', none:'None' }[text(value).trim().toLowerCase()] || 'Unknown');
  const abort = () => Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
  const failure = message => new Error(message);
  function metadata() { return G.validateMeta(JSON.parse(JSON.stringify(METADATA))); }

  function configuration(config = {}) {
    let url;
    try { url = new URL(config.supabaseUrl); } catch (_) { throw failure('Citizen database address is missing or invalid.'); }
    const localDebug = config.supabaseAllowLoopbackHttp === true && ['localhost','127.0.0.1','[::1]','10.0.2.2'].includes(url.hostname) && url.protocol === 'http:';
    if ((url.protocol !== 'https:' && !localDebug) || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) {
      throw failure('Use the HTTPS address of the citizen database.');
    }
    const key = text(config.supabaseAnonKey).trim();
    if (key.startsWith('sb_secret_')) throw failure('Use a public citizen database key, never a secret key.');
    if (key.startsWith('sb_publishable_')) {
      if (key.length <= 15 || /\s/.test(key)) throw failure('Citizen database public key is invalid.');
    } else {
      try {
        const parts = key.split('.');
        if (parts.length !== 3 || !parts.every(Boolean) || /\s/.test(key)) throw new Error();
        const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
        if (payload.role !== 'anon') throw new Error();
      } catch (_) { throw failure('Use a public publishable key or anon key for citizen observations.'); }
    }
    return { origin: url.origin, key };
  }

  function merge(photos, assessments) {
    const assessmentTime = row => time(date(row.created_at) || date(row.processed_at));
    const newest = assessments.slice().sort((a,b) => {
      const first = assessmentTime(b) - assessmentTime(a);
      if (Number.isFinite(first) && first) return first;
      if (assessmentTime(a) !== assessmentTime(b)) return assessmentTime(a) > assessmentTime(b) ? -1 : 1;
      const processed = time(b.processed_at) - time(a.processed_at);
      return Number.isFinite(processed) && processed ? processed : id(a).localeCompare(id(b));
    });
    const seen = new Set();
    let canonical = newest.filter(row => {
      if (!id(row)) return false;
      const key = photoID(row) ? 'photo:' + photoID(row) : image(row) ? 'image:' + image(row) : 'id:' + id(row);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const linkedPhotos = new Set(canonical.map(photoID).filter(Boolean));
    const linkedImages = new Set(canonical.filter(photoID).map(image).filter(Boolean));
    photos.forEach(p => { if (linkedPhotos.has(id(p)) && image(p)) linkedImages.add(image(p)); });
    canonical = canonical.filter(a => photoID(a) || !linkedImages.has(image(a)));
    const byPhoto = new Map(), byImage = new Map(), used = new Set(), seenPhotos = new Set();
    canonical.forEach(a => {
      if (photoID(a) && !byPhoto.has(photoID(a))) byPhoto.set(photoID(a), a);
      if (image(a) && !byImage.has(image(a))) byImage.set(image(a), a);
    });
    const rows = [];
    photos.slice().sort((a,b) => time(b.created_at) - time(a.created_at) || id(a).localeCompare(id(b))).forEach(photo => {
      if (!id(photo) || seenPhotos.has(id(photo))) return;
      seenPhotos.add(id(photo));
      let a = byPhoto.get(id(photo));
      const candidate = byImage.get(image(photo));
      if (!a && candidate && (!photoID(candidate) || photoID(candidate) === id(photo))) a = candidate;
      if (a && used.has(id(a))) a = null;
      if (a) used.add(id(a));
      rows.push(normalize(photo, a));
    });
    canonical.forEach(a => { if (!used.has(id(a))) rows.push(normalize(null, a)); });
    return rows.sort((a,b) => time(b.properties.captured_at) - time(a.properties.captured_at) || a.id.localeCompare(b.id));
  }

  function normalize(photo, assessment) {
    const a = assessment || {}, p = photo || {};
    const coordinates = point(a) || point(p), reviewed = a.expert_reviewed === true;
    const original = list(a.distress_types), corrected = list(a.expert_corrected_types);
    const effective = reviewed && corrected !== null ? corrected : original;
    const status = text(a.status) || (assessment ? 'unknown' : 'pending');
    const answered = ['classified','expert_review','done'].includes(status) || (status === 'unknown' && (reviewed || effective?.length > 0));
    const labels = answered && effective !== null ? (effective.length ? effective : ['Normal']) : [];
    const state = !answered ? (['pending','processing'].includes(status) ? 'pending' : 'unknown')
      : labels.some(label => label !== 'Normal') ? 'distress' : labels.includes('Normal') ? 'normal' : 'unknown';
    const rawConfidence = effective?.length ? number(a.stage2_confidence) : number(a.stage1_confidence);
    const confidence = Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : null;
    const captured = own(photo,'captured_at') ? date(p.captured_at) : date(p.created_at) || date(a.created_at);
    const imageURL = image(a) || image(p);
    const priority = new Map(METADATA.labels.map(label => [label.name,label.marker_priority]));
    const marker = labels.slice().sort((x,y) => (priority.get(x) || 100) - (priority.get(y) || 100))[0] || null;
    const rowID = assessment ? 'assessment-' + id(a) : 'photo-' + id(p);
    return { type:'Feature', id:rowID, geometry:coordinates ? {type:'Point',coordinates} : null, properties: {
      id:rowID, assessment_id:assessment ? id(a) : null, photo_id:id(p) || photoID(a) || null,
      layer:'citizen', data_source:'supabase', assessment_status:status, status,
      latitude:coordinates?.[1] ?? null, longitude:coordinates?.[0] ?? null,
      address:text(a.address).trim() || text(p.address), description:text(a.description),
      image_url:imageURL, preview_url:imageURL, thumb_url:imageURL, has_image:Boolean(imageURL),
      created_at:date(p.created_at) || date(a.created_at), captured_at:captured,
      capture_time_source:own(photo,'captured_at') ? 'capture' : 'upload_proxy', processed_at:date(a.processed_at),
      labels:original || [], final_labels:labels, final_primary_label:labels[0] || null, marker_label:marker,
      severity:severity(a.severity), final_severity:severity(reviewed && a.expert_corrected_severity != null ? a.expert_corrected_severity : a.severity),
      vlm_class:state, answered, confidence, expert_reviewed:reviewed,
      needs_expert_review:!reviewed && status === 'expert_review',
    } };
  }

  class Client {
    constructor(config = {}, {fetch:fetcher, timeoutMs=15000, pageSize=500, maxRows=20000} = {}) {
      this.config = config; this.fetch = fetcher || globalThis.fetch.bind(globalThis);
      this.timeoutMs = timeoutMs; this.pageSize = pageSize; this.maxRows = maxRows;
      this.apiBase = config.supabaseUrl || ''; this.supportsVideo = false;
    }
    async meta({signal} = {}) {
      if (signal?.aborted) throw abort();
      configuration(this.config);
      return metadata();
    }
    async sessions() { return {schema:G.SCHEMA,count:0,sessions:[],unavailable:true}; }
    async table(table, columns, signal) {
      const config = configuration(this.config), rows = [], seen = new Set();
      let total = null, pages = 0;
      const start = Date.now();
      while (total === null || rows.length < total) {
        if (signal?.aborted) throw abort();
        if (++pages > 200 || Date.now()-start > 60000) throw failure('Loading all citizen observations took too long. Please retry.');
        const url = new URL('/rest/v1/' + table, config.origin);
        url.search = new URLSearchParams({select:columns,order:'created_at.desc,id.desc',limit:String(this.pageSize),offset:String(rows.length)});
        const controller = new AbortController();
        const cancel = () => controller.abort();
        signal?.addEventListener('abort',cancel,{once:true});
        let timer;
        const deadline = new Promise((_,reject) => {
          timer = setTimeout(() => { controller.abort(); reject(failure('Citizen database request timed out.')); },this.timeoutMs);
        });
        let response, data;
        try {
          [response,data] = await Promise.race([deadline,(async () => {
            const headers = {apikey:config.key,Accept:'application/json',Prefer:'count=exact'};
            if (!config.key.startsWith('sb_publishable_')) headers.Authorization = 'Bearer ' + config.key;
            const response = await this.fetch(url.href,{headers,signal:controller.signal,cache:'no-store',redirect:'error'});
            const data = await response.json();
            return [response,data];
          })()]);
          if (signal?.aborted || controller.signal.aborted) throw abort();
        } finally { clearTimeout(timer); signal?.removeEventListener('abort',cancel); }
        if (!response.ok) {
          if (response.status === 400 && table === 'photos' && !rows.length && columns.split(',').includes('captured_at') &&
              ['42703','PGRST204'].includes(data?.code) && /captured_at/i.test(data?.message || '')) {
            columns = columns.split(',').filter(c => c !== 'captured_at').join(','); continue;
          }
          throw failure('Citizen database returned HTTP ' + response.status + '. Check the connection and read access.');
        }
        const range = response.headers.get('Content-Range');
        const rangeTotal = /^((\d+)-(\d+)|\*)\/(\d+)$/.exec(range || '');
        if (!Array.isArray(data) || !rangeTotal) throw failure('A complete citizen result could not be verified. Please refresh.');
        const count = Number(rangeTotal[4]);
        if (count > this.maxRows) throw failure('The citizen dataset exceeds the download limit. Use a GIS server for larger datasets.');
        if (total !== null && count !== total) throw failure('Citizen observations changed while loading. Please refresh.');
        total = count;
        const expected = data.length ? `${rows.length}-${rows.length+data.length-1}/${total}` : `*/${total}`;
        if (range !== expected || data.length > this.pageSize || rows.length+data.length > total || (!data.length && rows.length < total)) {
          throw failure('The citizen result was incomplete. Please refresh.');
        }
        for (const row of data) {
          if (!row || typeof row !== 'object' || !id(row) || seen.has(id(row))) throw failure('The citizen result contains duplicate or invalid records. Please refresh.');
          seen.add(id(row)); rows.push(row);
        }
      }
      return rows;
    }
    async features(layer, filters, meta, {bbox,signal,max=5000} = {}) {
      if (layer !== 'citizen') throw failure(VIDEO_UNAVAILABLE);
      if (signal?.aborted) throw abort();
      let snapshot = this.snapshot;
      if (!snapshot || Date.now()-snapshot.at >= 30000) {
        const [photos,assessments] = await Promise.all([
          this.table('photos','id,latitude,longitude,address,image_url,created_at,captured_at',signal),
          this.table('assessments','id,photo_id,latitude,longitude,address,image_url,status,distress_types,severity,stage2_confidence,stage1_confidence,description,processed_at,created_at,expert_reviewed,expert_corrected_types,expert_corrected_severity',signal),
        ]);
        if (signal?.aborted) throw abort();
        const features = merge(photos,assessments);
        snapshot = {at:Date.now(),features}; this.snapshot = snapshot;
      }
      const bounds = bbox == null ? null : G.query(filters,meta,'citizen',{bbox}).get('bbox').split(',').map(Number);
      const selected = snapshot.features.filter(f => G.matches(f,filters,meta,'citizen') && (!bounds || (f.geometry &&
        f.properties.longitude >= bounds[0] && f.properties.longitude <= bounds[2] && f.properties.latitude >= bounds[1] && f.properties.latitude <= bounds[3])));
      const stats = {total:snapshot.features.length,unlocated:snapshot.features.filter(f => !f.geometry).length,
        awaitingReview:snapshot.features.filter(f => f.properties.needs_expert_review).length,
        awaitingAssessment:snapshot.features.filter(f => f.properties.vlm_class === 'pending').length};
      return {features:selected.length > max ? [] : selected,numberMatched:selected.length,sourceNumberMatched:snapshot.features.length,
        truncated:selected.length > max,sourceStats:stats,source:'supabase'};
    }
    async exportVideo() { throw failure(VIDEO_UNAVAILABLE); }
  }
  return {Client,metadata,merge,normalize,configuration,VIDEO_UNAVAILABLE};
}));
