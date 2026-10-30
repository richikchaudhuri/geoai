/* Shared, read-only geoai.gis.v1 contract. Browser and native-hosted views use
 * the same normalization, filters, exports and share links. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GeoAIGIS = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const SCHEMA = 'geoai.gis.v1';
  const STYLES = new Set(['light', 'dark', 'voyager', 'satellite', 'backdrop', 'toner']);
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const validCoordinates = (lat, lng) => finite(lat) && finite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const coordinate = value => Array.isArray(value) && value.length >= 2 && validCoordinates(value[1], value[0]);
  const error = (message, status = 422) => Object.assign(new Error(message), { status });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  function validateMeta(meta) {
    if (!object(meta) || meta.schema !== SCHEMA || !Array.isArray(meta.labels) || !meta.labels.length ||
      !Array.isArray(meta.severities) || !meta.severities.length || !Array.isArray(meta.vlm_classes) ||
      !finite(meta.confidence_threshold) || meta.confidence_threshold < 0 || meta.confidence_threshold > 1 ||
      !Number.isInteger(meta.limits?.default_limit) || meta.limits.default_limit < 1 ||
      !Number.isInteger(meta.limits?.max_limit) || meta.limits.max_limit < meta.limits.default_limit) {
      throw error('Unsupported GIS metadata');
    }
    const color = value => typeof value === 'string' && /^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value);
    const names = new Set();
    for (const label of meta.labels) {
      if (!object(label) || typeof label.name !== 'string' || !label.name || names.has(label.name.toLowerCase()) || !color(label.color)) throw error('Invalid GIS label metadata');
      names.add(label.name.toLowerCase());
    }
    names.clear();
    for (const level of meta.severities) {
      if (!object(level) || typeof level.name !== 'string' || !level.name || names.has(level.name) || !finite(level.radius_px) || level.radius_px <= 0) throw error('Invalid GIS severity metadata');
      names.add(level.name);
    }
    for (const cls of meta.vlm_classes) {
      if (!object(cls) || typeof cls.name !== 'string' || (cls.color !== null && !color(cls.color))) throw error('Invalid GIS class metadata');
    }
    return meta;
  }

  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1 || Number(value.slice(0, 4)) > 9998) return '';
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === value ? value : '';
  }
  function nextDate(value) {
    const d = new Date(`${value}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  const truth = value => value === true || value === 'true' || value === '1' || value === 1;
  function choices(value, allowed) {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    const lookup = new Map(allowed.map(item => [item.toLowerCase(), item]));
    return [...new Set(values.filter(item => typeof item === 'string').map(item => lookup.get(item.trim().toLowerCase())).filter(Boolean))].sort();
  }
  function normalizeFilters(input = {}, meta) {
    input = object(input) ? input : {};
    let from = date(input.dateFrom), to = date(input.dateTo);
    if (from && to && from > to) [from, to] = [to, from];
    return {
      labels: choices(input.labels, (meta?.labels || []).map(item => item.name)),
      severities: choices(input.severities, (meta?.severities || []).map(item => item.name)),
      review: ['needs', 'reviewed'].includes(input.review) ? input.review : 'all',
      highConfidence: truth(input.highConfidence), dateFrom: from, dateTo: to,
      session: typeof input.session === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(input.session) ? input.session : '',
      includeReview: truth(input.includeReview), citizen: input.citizen === undefined ? true : truth(input.citizen),
      captureTime: ['day', 'night'].includes(input.captureTime) ? input.captureTime : 'all',
    };
  }
  function bboxString(value) {
    if (typeof value === 'string' && value.split(',').some(part => !part.trim())) throw error('Invalid map bounds');
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map(Number) : [];
    if (values.length !== 4 || !values.every(finite) || !validCoordinates(values[1], values[0]) ||
      !validCoordinates(values[3], values[2]) || values[0] > values[2] || values[1] > values[3]) throw error('Invalid map bounds');
    return values.join(',');
  }
  function query(input, meta, layer, extras = {}) {
    if (!['video', 'citizen'].includes(layer)) throw error('Unknown GIS layer');
    const f = normalizeFilters(input, meta), q = new URLSearchParams();
    if (layer === 'video') { q.set('vlm_class', 'distress'); if (f.session) q.set('session', f.session); }
    else q.set('include_review', String(f.includeReview));
    if (f.labels.length) q.set('label', f.labels.join(','));
    if (f.severities.length) q.set('severity', f.severities.join(','));
    if (f.review === 'needs') q.set('needs_review', 'true');
    if (f.review === 'reviewed') q.set('reviewed', 'true');
    if (f.highConfidence) q.set('min_confidence', String(meta.confidence_threshold));
    if (f.dateFrom) q.set('date_from', `${f.dateFrom}T00:00:00+05:30`);
    if (f.dateTo) q.set('date_to', `${nextDate(f.dateTo)}T00:00:00+05:30`);
    if (extras.bbox !== undefined && extras.bbox !== null) q.set('bbox', bboxString(extras.bbox));
    if (layer === 'video' && extras.geom !== undefined) {
      if (!['point', 'footprint', 'line'].includes(extras.geom)) throw error('Invalid map geometry');
      q.set('geom', extras.geom);
    }
    for (const name of ['limit', 'offset']) {
      if (extras[name] === undefined) continue;
      const value = extras[name];
      if (!Number.isInteger(value) || value < (name === 'limit' ? 1 : 0) || value > (name === 'limit' ? meta.limits.max_limit : 10000000)) throw error(`Invalid ${name}`);
      q.set(name, String(value));
    }
    return q;
  }
  function timestamp(p, layer) {
    const value = layer === 'citizen' ? p.data_source === 'supabase' ? p.captured_at : p.created_at : p.utc;
    if (!value || typeof value !== 'string') return NaN;
    return Date.parse(value);
  }
  function matches(feature, input, meta, layer) {
    if (!['video', 'citizen'].includes(layer) || !object(feature)) return false;
    const p = object(feature.properties) ? feature.properties : feature;
    const f = normalizeFilters(input, meta);
    if (layer === 'video' && (p.vlm_class !== 'distress' || (f.session && p.session_id !== f.session))) return false;
    if (layer === 'citizen' && !f.includeReview && p.assessment_status === 'expert_review') return false;
    if (f.labels.length && !(Array.isArray(p.final_labels) && p.final_labels.some(label => typeof label === 'string' && f.labels.some(wanted => wanted.toLowerCase() === label.toLowerCase())))) return false;
    if (f.severities.length && !f.severities.includes(p.final_severity)) return false;
    if (f.review === 'needs' && !p.needs_expert_review) return false;
    if (f.review === 'reviewed' && !p.expert_reviewed) return false;
    if (f.highConfidence && (!finite(p.confidence) || p.confidence < meta.confidence_threshold)) return false;
    if (f.dateFrom || f.dateTo || f.captureTime !== 'all') {
      const time = timestamp(p, layer);
      if (!Number.isFinite(time)) return false;
      if (f.dateFrom && time < Date.parse(`${f.dateFrom}T00:00:00+05:30`)) return false;
      if (f.dateTo && time >= Date.parse(`${nextDate(f.dateTo)}T00:00:00+05:30`)) return false;
      if (f.captureTime !== 'all') {
        const hour = new Date(time + 330 * 60000).getUTCHours();
        if ((hour >= 6 && hour < 18) !== (f.captureTime === 'day')) return false;
      }
    }
    return true;
  }

  function safeURL(value, apiBase = '', baseURI = (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/')) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const base = new URL(apiBase || baseURI, baseURI);
      const result = new URL(value, base);
      return ['http:', 'https:'].includes(result.protocol) && !result.username && !result.password ? result.href : null;
    } catch (_) { return null; }
  }
  function cell(value) {
    let text = Array.isArray(value) ? value.join('; ') : value == null ? '' : object(value) ? JSON.stringify(value) : String(value);
    // CSV quoting alone does not stop Excel from evaluating a formula.
    if (typeof value !== 'number' && (/^[\t\r\n]/.test(text) || (/^\s*[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)))) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }
  const CSV_COLUMNS = ['id', 'layer', 'segment_id', 'session_id', 'k', 'photo_id', 'status', 'vlm_class', 'answered', 'assessment_status',
    'final_labels', 'final_primary_label', 'marker_label', 'final_severity', 'labels', 'primary_label', 'severity', 'confidence',
    'stage1_label', 'stage1_confidence', 'stage2_confidence', 'needs_expert_review', 'expert_reviewed', 'expert_corrected_types',
    'expert_corrected_severity', 'description', 'condition_indicators', 'utc', 'local_time', 'created_at', 'processed_at',
    'latitude', 'longitude', 'address', 'centre_lat', 'centre_lon', 'position_sigma_m', 's0_m', 's1_m', 'length_m', 'partial',
    'chainage_start_km', 'chainage_end_km', 'road_id', 'road_name', 'direction', 'lane', 'camera_lat', 'camera_lon',
    'camera_heading_deg', 'camera_speed_kmh', 'camera_h_sigma_m', 'gate_mode', 'gate_decision', 'gate_decision_if_gated',
    'gate_reasons', 'gate_probe_frac', 'gate_evidence', 'gate_crack_mm', 'quality_sharpness', 'quality_blur_px', 'quality_reason', 'low_light', 'image_url'];
  function csv(features) {
    if (!Array.isArray(features)) throw error('Invalid export rows');
    return '\ufeff' + [CSV_COLUMNS.map(cell).join(','), ...features.map(feature => {
      const p = feature.properties || feature;
      return CSV_COLUMNS.map(key => cell(key === 'id' ? p.id ?? feature.id : p[key])).join(',');
    })].join('\r\n') + '\r\n';
  }
  function readCSV(content) {
    const rows = []; let row = [], field = '', quoted = false;
    const text = content.replace(/^\ufeff/, '');
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"' && field === '') quoted = true;
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        row.push(field); if (row.some(value => value !== '')) rows.push(row); row = []; field = '';
      } else field += char;
    }
    if (quoted) throw error('Incomplete CSV response');
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function serializeView(view = {}, meta) {
    const f = normalizeFilters(view.filters, meta), q = new URLSearchParams({ geoai: '1' });
    q.set('video', String(!!view.video)); q.set('style', STYLES.has(view.style) ? view.style : 'light');
    if (validCoordinates(view.lat, view.lng)) {
      q.set('lat', String(Number(Math.max(-85.05112878, Math.min(85.05112878, view.lat)).toFixed(6))));
      q.set('lng', String(Number(view.lng.toFixed(6))));
    }
    q.set('zoom', String(finite(view.zoom) ? Math.max(1, Math.min(22, view.zoom)) : 12));
    if (f.labels.length) q.set('label', f.labels.join(','));
    if (f.severities.length) q.set('severity', f.severities.join(','));
    q.set('review', f.review); q.set('confidence', String(f.highConfidence));
    if (f.dateFrom) q.set('date_from', f.dateFrom); if (f.dateTo) q.set('date_to', f.dateTo);
    if (f.session) q.set('session', f.session);
    q.set('include_review', String(f.includeReview)); q.set('citizen', String(f.citizen)); q.set('capture_time', f.captureTime);
    return q;
  }
  function parseView(search, meta) {
    const q = search instanceof URLSearchParams ? search : new URLSearchParams(typeof search === 'string' ? search : '');
    const lat = q.has('lat') && q.get('lat').trim() !== '' ? Number(q.get('lat')) : NaN;
    const lng = q.has('lng') && q.get('lng').trim() !== '' ? Number(q.get('lng')) : NaN;
    const zoom = q.has('zoom') && q.get('zoom').trim() !== '' ? Number(q.get('zoom')) : NaN;
    const hasPosition = validCoordinates(lat, lng);
    return { filters: normalizeFilters({ labels: q.get('label'), severities: q.get('severity'), review: q.get('review'),
      highConfidence: q.get('confidence'), dateFrom: q.get('date_from'), dateTo: q.get('date_to'), session: q.get('session'),
      includeReview: q.get('include_review'), citizen: q.has('citizen') ? q.get('citizen') : undefined, captureTime: q.get('capture_time') }, meta),
    video: truth(q.get('video')), style: STYLES.has(q.get('style')) ? q.get('style') : 'light',
    lat: hasPosition ? Math.max(-85.05112878, Math.min(85.05112878, lat)) : 12.9716,
    lng: hasPosition ? lng : 77.5946, zoom: finite(zoom) ? Math.max(1, Math.min(22, zoom)) : 12,
    hasView: q.get('geoai') === '1' || hasPosition };
  }

  class Client {
    constructor({ apiBase = '', fetch: fetcher, baseURI, timeoutMs = 15000 } = {}) {
      this.baseURI = baseURI || (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/');
      this.apiBase = apiBase; this.fetch = fetcher || globalThis.fetch.bind(globalThis); this.timeoutMs = timeoutMs;
      this.cache = new Map();
      if (!safeURL('/', this.apiBase, this.baseURI)) throw error('The GIS API needs an HTTP or HTTPS address');
    }
    async request(path, { signal, text = false } = {}) {
      if (typeof path !== 'string' || !path.startsWith('/gis/')) throw error('Invalid GIS endpoint');
      if (signal?.aborted) throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
      const controller = new AbortController(); let timer, cancel;
      const cancelled = new Promise((_, reject) => {
        cancel = () => { controller.abort(); reject(Object.assign(new Error('Request cancelled'), { name: 'AbortError' })); };
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => { controller.abort(); reject(error('GIS request timed out', 408)); }, this.timeoutMs);
      });
      try {
        return await Promise.race([cancelled, (async () => {
          const response = await this.fetch(safeURL(path, this.apiBase, this.baseURI), { signal: controller.signal,
            headers: { Accept: text ? 'text/csv' : 'application/json' } });
          if (!response.ok) throw error(response.status === 503 ? 'Survey data temporarily unavailable' : 'GIS request failed', response.status);
          const data = text ? await response.text() : await response.json();
          if (signal?.aborted || controller.signal.aborted) throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
          if (!text && (!object(data) || data.schema !== SCHEMA)) throw error('Unsupported GIS data');
          return data;
        })()]);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    }
    json(path, options = {}) { return this.request(path, options); }
    async meta({ signal } = {}) {
      const cached = this.cache.get('meta');
      if (signal?.aborted) throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
      if (cached && Date.now() - cached.at < 60000) return cached.value;
      const value = validateMeta(await this.json('/gis/meta', { signal }));
      this.cache.set('meta', { value, at: Date.now() }); return value;
    }
    async sessions({ signal, session = '', track = true, perKm = true } = {}) {
      const q = new URLSearchParams({ track: String(!!track), per_km: String(!!perKm) });
      if (session) q.set('session', session);
      const key = `sessions:${q}`, cached = this.cache.get(key);
      if (signal?.aborted) throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
      if (cached && Date.now() - cached.at < 60000) return cached.value;
      const value = await this.json(`/gis/video/sessions?${q}`, { signal });
      if (!Array.isArray(value.sessions) || value.count !== value.sessions.length ||
        value.sessions.some(s => !object(s) || typeof s.session_id !== 'string' || !s.session_id) ||
        new Set(value.sessions.map(s => s.session_id)).size !== value.sessions.length) throw error('Invalid drive catalogue');
      this.cache.set(key, { value, at: Date.now() }); return value;
    }
    async features(layer, filters, meta, { bbox, geom = 'point', signal, max = 5000 } = {}) {
      const result = await this.featurePages(layer, meta,
        (limit, offset) => query(filters, meta, layer, { bbox, geom, limit, offset }), { signal, max });
      if (result.truncated) return result;
      const selected = result.features.filter(feature => matches(feature, filters, meta, layer));
      return { ...result, features: selected, numberMatched: selected.length };
    }
    async driveFrames(session, meta, { signal, max = 20000 } = {}) {
      if (typeof session !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(session)) throw error('Invalid drive session');
      // The frame browser is independent of distress and map filters. Omitting
      // vlm_class includes normal, pending and unclassified records as well.
      return this.featurePages('video', meta,
        (limit, offset) => new URLSearchParams({ session, geom: 'point', limit: String(limit), offset: String(offset) }),
        { signal, max, session });
    }
    async featurePages(layer, meta, makeQuery, { signal, max = 5000, session } = {}) {
      if (!Number.isInteger(max) || max < 1 || max > 20000) throw error('Invalid feature limit');
      const endpoint = layer === 'video' ? '/gis/video/segments.geojson' : layer === 'citizen' ? '/gis/citizen/assessments.geojson' : null;
      if (!endpoint) throw error('Unknown GIS layer');
      const limit = Math.min(max, meta.limits.default_limit, meta.limits.max_limit), features = [], seen = new Set();
      let total = null, offset = 0;
      do {
        const q = makeQuery(limit, offset);
        const data = await this.json(`${endpoint}?${q}`, { signal });
        if (data.type !== 'FeatureCollection' || data.layer !== layer || !Array.isArray(data.features) || !Number.isInteger(data.numberMatched) || data.numberMatched < 0 ||
          data.numberReturned !== data.features.length || data.numberReturned > limit || data.numberReturned + offset > data.numberMatched ||
          (total !== null && data.numberMatched !== total) || (!data.numberReturned && offset < data.numberMatched)) throw error('Incomplete or changing GIS response');
        total = data.numberMatched;
        if (total > max) return { features: [], numberMatched: total, sourceNumberMatched: total, truncated: true };
        for (const feature of data.features) {
          const id = layer === 'video' ? feature?.properties?.segment_id || feature?.id : feature?.properties?.id || feature?.id;
          if (!object(feature) || feature.type !== 'Feature' || !object(feature.properties) || typeof id !== 'string' || !id || seen.has(id)) throw error('Invalid or duplicate GIS feature');
          if (session !== undefined && feature.properties.session_id !== session) throw error('Drive frame response contains an unexpected session');
          seen.add(id); features.push(feature);
        }
        offset += data.numberReturned;
      } while (offset < total);
      return { features, numberMatched: total, sourceNumberMatched: total, truncated: false };
    }
    async summary(filters, meta, { bbox, signal } = {}) {
      const f = normalizeFilters(filters, meta);
      if (f.captureTime !== 'all') {
        const result = await this.features('video', f, meta, { bbox, signal, max: 20000 });
        if (result.truncated) throw error('Narrow the filters to fewer than 20,000 segments', 413);
        return aggregate(result.features, meta);
      }
      const value = await this.json(`/gis/video/summary?${query(f, meta, 'video', { bbox })}`, { signal });
      if (!Number.isInteger(value.segments) || value.segments < 0) throw error('Invalid survey summary');
      return value;
    }
    async exportVideo(filters, meta, { bbox, signal } = {}) {
      const f = normalizeFilters(filters, meta);
      if (f.captureTime !== 'all') {
        const result = await this.features('video', f, meta, { bbox, signal, max: 20000 });
        if (result.truncated) throw error('Narrow the filters to fewer than 20,000 segments before exporting', 413);
        return { content: csv(result.features), filename: 'geoai-video.csv', mime: 'text/csv;charset=utf-8' };
      }
      const summary = await this.summary(f, meta, { bbox, signal });
      const total = summary.segments;
      if (total > 20000) throw error('Narrow the filters to fewer than 20,000 segments before exporting', 413);
      const limit = Math.min(5000, meta.limits.default_limit, meta.limits.max_limit), rows = [], ids = new Set();
      let header = null, offset = 0;
      do {
        const q = query(f, meta, 'video', { bbox, limit, offset });
        const page = readCSV(await this.request(`/gis/video/segments.csv?${q}`, { signal, text: true }));
        const columns = page.shift();
        if (!columns?.length || !columns.includes('segment_id') || new Set(columns).size !== columns.length ||
          (header && JSON.stringify(header) !== JSON.stringify(columns)) || page.length !== Math.min(limit, total - offset)) throw error('Incomplete or changing CSV export');
        header = columns; const idColumn = columns.indexOf('segment_id');
        for (const row of page) {
          if (row.length !== header.length || !row[idColumn] || ids.has(row[idColumn])) throw error('Invalid or repeated CSV row');
          ids.add(row[idColumn]); rows.push(row);
        }
        offset += page.length;
      } while (offset < total);
      const after = await this.summary(f, meta, { bbox, signal });
      if (after.segments !== total) throw error('Survey results changed during export. Try again.');
      const content = '\ufeff' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
      return { content, filename: 'geoai-video.csv', mime: 'text/csv;charset=utf-8' };
    }
  }

  function aggregate(features, meta) {
    const result = { schema: SCHEMA, segments: features.length, sessions: 0, route_m: 0, surveyed_m: 0, classified_m: 0, distress_m: 0,
      normal_m: 0, not_covered_m: 0, needs_expert_review: 0, expert_reviewed: 0, with_image: 0, answered: 0, segments_by_status: {}, segments_by_vlm_class: {} };
    const sessions = new Set(), labels = new Map(meta.labels.map(l => [l.name, { label: l.name, segments: 0, length_m: 0 }]));
    for (const feature of features) {
      const p = feature.properties, length = finite(p.length_m) && p.length_m >= 0 ? p.length_m : 0;
      if (p.session_id) sessions.add(p.session_id);
      result.route_m += length;
      if (p.status === 'not_covered') result.not_covered_m += length; else if (['send', 'audit', 'skip'].includes(p.status)) result.surveyed_m += length;
      if (['distress', 'normal'].includes(p.vlm_class) && p.answered) result.classified_m += length;
      if (p.vlm_class === 'distress') result.distress_m += length; if (p.vlm_class === 'normal') result.normal_m += length;
      for (const name of ['needs_expert_review', 'expert_reviewed', 'has_image', 'answered']) if (p[name]) result[name === 'has_image' ? 'with_image' : name]++;
      result.segments_by_status[p.status] = (result.segments_by_status[p.status] || 0) + 1;
      result.segments_by_vlm_class[p.vlm_class] = (result.segments_by_vlm_class[p.vlm_class] || 0) + 1;
      for (const name of new Set(p.final_labels || [])) {
        const label = labels.get(name); if (label) { label.segments++; label.length_m += length; }
      }
    }
    result.sessions = sessions.size;
    const percent = (n, d) => d ? 100 * n / d : null;
    result.pct_distress_of_surveyed = percent(result.distress_m, result.surveyed_m);
    result.pct_distress_of_classified = percent(result.distress_m, result.classified_m);
    result.labels = [...labels.values()].map(l => ({ ...l, pct_of_surveyed: percent(l.length_m, result.surveyed_m), pct_of_classified: percent(l.length_m, result.classified_m) }));
    return result;
  }

  return { SCHEMA, validateMeta, normalizeFilters, query, matches, safeURL, csv, serializeView, parseView, coordinate, validCoordinates, Client };
}));
