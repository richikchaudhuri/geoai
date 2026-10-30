/* Optional survey overlay. The original dashboard keeps control of its map and navigation. */
(function () {
  'use strict';

  const SCHEMA = 'geoai.gis.v1';
  const COMPLETE = new Set(['stored', 'cleaned']);
  // Route colours distinguish drives only; distress colours and sizes come from /gis/meta.
  const LIGHT = ['#2563eb', '#b45309', '#0f766e', '#7c3aed'];
  const DARK = ['#93c5fd', '#fcd34d', '#5eead4', '#c4b5fd'];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const coordinate = point => Array.isArray(point) && point.length >= 2 &&
    finite(point[0]) && Math.abs(point[0]) <= 180 && finite(point[1]) && Math.abs(point[1]) <= 90;
  const unsupported = () => Object.assign(new Error('Unsupported video survey data'), { status: 422 });

  function validTrack(track) {
    if (!track || !['LineString', 'MultiLineString'].includes(track.type)) return false;
    const lines = track.type === 'LineString' ? [track.coordinates] : track.coordinates;
    return Array.isArray(lines) && lines.length > 0 && lines.every(line =>
      Array.isArray(line) && line.length >= 2 && line.every(coordinate));
  }

  function validFootprint(geometry) {
    return geometry?.type === 'Polygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 &&
      geometry.coordinates.every(ring => Array.isArray(ring) && ring.length >= 4 && ring.every(coordinate) &&
        ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]);
  }

  function centre(feature) {
    const p = feature.properties || {};
    const point = coordinate([p.centre_lon, p.centre_lat]) ? [p.centre_lon, p.centre_lat]
      : feature.geometry?.type === 'Point' && coordinate(feature.geometry.coordinates) ? feature.geometry.coordinates : null;
    return point ? { lat: point[1], lng: point[0] } : null;
  }

  // World pixels make membership independent of map panning. Anchor groups
  // avoid chaining an entire street together when each sample is close to the next.
  function clusterEntries(entries, zoom) {
    const size = 256 * 2 ** zoom, radius = 40, columns = Math.ceil(size / radius);
    const project = location => {
      const sine = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, location.lat)) * Math.PI / 180);
      return { x: (location.lng + 180) / 360 * size, y: (.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size };
    };
    const ordered = entries.map(entry => ({ ...entry, pixel: project(entry.location) }))
      .sort((a, b) => a.pixel.x - b.pixel.x || a.pixel.y - b.pixel.y || String(a.feature.properties.segment_id || a.feature.id).localeCompare(String(b.feature.properties.segment_id || b.feature.id)));
    const grid = new Map(), groups = [];
    const key = (x, y) => `${((x % columns) + columns) % columns}:${y}`;
    for (const entry of ordered) {
      const cellX = Math.floor(entry.pixel.x / radius), cellY = Math.floor(entry.pixel.y / radius);
      let selected, nearest = radius * radius;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const group of grid.get(key(cellX + dx, cellY + dy)) || []) {
          const rawX = Math.abs(entry.pixel.x - group.pixel.x), x = Math.min(rawX, size - rawX), y = entry.pixel.y - group.pixel.y;
          const distance = x * x + y * y;
          if (distance <= nearest) { selected = group; nearest = distance; }
        }
      }
      if (selected) selected.members.push(entry);
      else {
        const group = { ...entry, members: [entry] }; groups.push(group);
        const cell = key(cellX, cellY); if (!grid.has(cell)) grid.set(cell, []); grid.get(cell).push(group);
      }
    }
    return groups;
  }

  function addLine(node, text, strong = false) {
    const line = document.createElement(strong ? 'strong' : 'div');
    line.textContent = text;
    node.append(line);
  }

  class GeoAIVideoPaths {
    constructor({ map, L, button, notice, apiBase = '', fetch: fetcher, retryMs = 30000 }) {
      Object.assign(this, { map, L, button, notice, retryMs });
      this.apiBase = String(apiBase).replace(/\/$/, '');
      this.fetch = fetcher || window.fetch.bind(window);
      this.enabled = false;
      this.generation = 0;
      this.paths = [];
      this.features = [];
      this.distressMarkers = [];
      this.playback = null;
      this.inspection = null;
      this.filters = {};
      this.inspectionChanged = event => {
        const detail = event.detail || {};
        if (!this.enabled || detail.sessionId !== this.filters.session) return;
        this.inspection = Array.isArray(detail.features) && !detail.truncated && !detail.error
          ? { sessionId: detail.sessionId, features: detail.features.filter(f =>
            f?.type === 'Feature' && f.properties?.session_id === detail.sessionId && f.properties.vlm_class === 'distress') }
          : null;
        this.renderDistress();
      };
      document.addEventListener('geoai:driveinspectionchange', this.inspectionChanged);
      this.distance = document.getElementById('videoDistance');
      this.distanceLabel = document.getElementById('videoDistanceLabel');
      this.driveSelect = document.getElementById('videoDriveSelect');
      this.driveDetails = document.getElementById('videoDriveDetails');
      this.driveFocus = document.getElementById('videoDriveFocus');
      this.driveReplay = document.getElementById('videoDriveReplay');
      this.driveSelect?.addEventListener('change', () => this.selectDrive(this.driveSelect.value));
      this.driveFocus?.addEventListener('click', () => this.focusRoutes(this.filters.session));
      this.driveReplay?.addEventListener('click', () => window.geoaiDrivePlayer?.open(this.filters.session || undefined));
      if (this.distance) {
        L.DomEvent?.disableClickPropagation(this.distance);
        L.DomEvent?.disableScrollPropagation(this.distance);
      }
      this.layer = L.featureGroup();
      this.distressLayer = L.featureGroup();
      this.renderer = window.geoaiCanvasRenderer || L.canvas({ padding: .3 });
      this.click = event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.enabled && !this.button.classList.contains('active')) {
          this.selectVideo();
          return;
        }
        this.setEnabled(!this.enabled);
      };
      this.move = () => {
        if (!this.enabled) return;
        this.generation++;
        this.controller?.abort();
        clearTimeout(this.retryTimer);
        clearTimeout(this.moveTimer);
        this.moveTimer = setTimeout(() => this.load(this.generation), 300);
      };
      this.zoom = () => { if (this.enabled) this.renderDistress(); };
      this.mapButton = document.querySelector('.nav-item[data-page="map"]');
      this.mapClick = () => this.setEnabled(false);
      this.mapButton?.addEventListener('click', this.mapClick);
      button.addEventListener('click', this.click, true);
      map.on('moveend', this.move);
      map.on('zoomend', this.zoom);
      this.themeObserver = new MutationObserver(() => this.applyTheme());
      this.themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      this.updateButton();
      this.updateDistance();
    }

    setFilters(filters) {
      if (JSON.stringify(this.filters) !== JSON.stringify(filters || {})) this.inspection = null;
      this.clearPlayback();
      this.filters = filters || {};
      this.cache = null;
      this.generation++;
      this.controller?.abort();
      clearTimeout(this.retryTimer);
      clearTimeout(this.moveTimer);
      if (this.enabled && this.catalog) {
        this.features = [];
        this.render(this.catalog.sessions);
      }
      if (this.enabled) return this.load(this.generation);
    }

    notify() {
      document.dispatchEvent(new CustomEvent('geoai:videochange', { detail: { enabled: this.enabled, features: this.features, matched: this.matched, truncated: this.truncated } }));
    }

    selectVideo() {
      // Reuse the existing panels; selecting Video only brings the map forward.
      if (typeof closeAboutStack === 'function') closeAboutStack();
      if (typeof closeFilterStack === 'function') closeFilterStack();
      document.querySelectorAll('.nav-pill .nav-item').forEach(item => {
        item.classList.toggle('active', item === this.button);
      });
    }

    updateButton() {
      this.button.setAttribute('aria-pressed', String(this.enabled));
      // A toggle keeps one accessible name; aria-pressed communicates its state.
      this.button.setAttribute('aria-label', 'Video drive paths and distress');
      this.button.title = this.enabled ? 'Video on · hide drive paths and distress' : 'Video · show drive paths and distress';
    }

    message(text) {
      if (!this.notice) return;
      this.notice.textContent = text;
      this.notice.hidden = !text;
    }

    updateDistance(sessions) {
      if (!this.distance || !this.distanceLabel) return;
      this.distance.hidden = !this.enabled;
      if (!this.enabled) return;
      let label = 'Loading distance…';
      let description = 'Recorded drive route length.';
      if (sessions === null) label = 'Distance unavailable';
      else if (Array.isArray(sessions)) {
        const unique = new Map();
        let valid = true;
        for (const session of sessions) {
          if (!session || typeof session.session_id !== 'string' || !session.session_id) { valid = false; continue; }
          if (!unique.has(session.session_id)) unique.set(session.session_id, session);
        }
        let metres = 0;
        for (const session of unique.values()) {
          if (!finite(session.route_m) || session.route_m < 0) valid = false;
          else metres += session.route_m;
        }
        label = valid && finite(metres)
          ? `${(metres / 1000).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} km travelled`
          : 'Distance unavailable';
        description = `Recorded route length across ${unique.size} ${unique.size === 1 ? 'drive' : 'drives'}. Repeat passes are included; this is not unique road coverage.`;
        if ([...unique.values()].some(session => !COMPLETE.has(session.state))) {
          description += ' Unfinished drives may contain only part of their recorded distance.';
        }
        if (!valid) description = 'One or more drive distances are unavailable. A complete total cannot be shown.';
      }
      // Do not re-announce the same distance on every map pan.
      if (this.distanceLabel.textContent !== label) {
        if (label.endsWith(' km travelled')) {
          const number = document.createElement('span');
          number.className = 'video-distance-number';
          number.textContent = label.slice(0, -' km travelled'.length);
          const unit = document.createElement('span');
          unit.className = 'video-distance-unit';
          unit.textContent = ' km travelled';
          this.distanceLabel.replaceChildren(number, unit);
        } else this.distanceLabel.textContent = label;
      }
      this.distance.title = description;
      this.updateDriveMenu(sessions);
    }

    updateDriveMenu(sessions) {
      if (!this.driveSelect) return;
      const available = Array.isArray(sessions);
      const drives = [...new Map((sessions || []).filter(s => s?.session_id).map(s => [s.session_id, s])).values()];
      const selected = drives.find(s => s.session_id === this.filters.session);
      const signature = JSON.stringify([drives, this.filters.session, available, sessions === undefined]);
      if (signature === this.menuSignature) return;
      this.menuSignature = signature;
      const option = (value, label) => {
        const el = document.createElement('option'); el.value = value; el.textContent = label; return el;
      };
      this.driveSelect.replaceChildren(option('', available ? `All drives (${drives.length})` : sessions === undefined ? 'Loading drives…' : 'Drives unavailable'));
      for (const session of drives) {
        const km = finite(session.route_m) && session.route_m >= 0 ? `${(session.route_m / 1000).toFixed(2)} km` : 'Distance unavailable';
        this.driveSelect.append(option(session.session_id,
          `${session.road_name || session.road_id || 'Drive'} · ${session.local_date || 'Date unavailable'} · ${km}`));
      }
      if (this.filters.session && !selected) this.driveSelect.append(option(this.filters.session, 'Unavailable drive'));
      this.driveSelect.value = this.filters.session || '';
      this.driveSelect.disabled = !available || !drives.length;
      const routes = drives.filter(s => validTrack(s.track));
      if (selected) {
        const status = COMPLETE.has(selected.state) ? 'Complete' : selected.state === 'failed' ? 'Failed' : 'Processing';
        const km = finite(selected.route_m) && selected.route_m >= 0 ? `${(selected.route_m / 1000).toFixed(2)} km recorded` : 'Distance unavailable';
        const distress = finite(selected.distress_m) ? `${selected.distress_m.toFixed(1)} m distressed` : 'Distress unavailable';
        const pct = finite(selected.pct_distress_of_surveyed) ? ` (${selected.pct_distress_of_surveyed.toFixed(1)}% of surveyed length)` : '';
        this.driveDetails.textContent = `${selected.local_date || 'Date unavailable'} · ${status}\n${km} · ${distress}${pct}\n${validTrack(selected.track) ? 'All drive routes remain on the map.' : 'No recorded route available for this drive.'}`;
      } else {
        this.driveDetails.textContent = this.filters.session ? 'Selected drive unavailable. All available routes remain on the map.'
          : available ? `${drives.length} drives · ${routes.length} routes on the map.${routes.length < drives.length ? ' Some drives have no recorded route yet.' : ''}` : sessions === undefined ? 'Loading drive catalogue…' : 'Drive catalogue unavailable.';
      }
      this.driveFocus.textContent = this.filters.session ? 'Focus route' : 'Show all routes';
      this.driveFocus.disabled = this.filters.session ? !validTrack(selected?.track) : !routes.length;
      const replayable = s => validTrack(s?.track) && finite(s.route_m) && s.route_m > 0;
      this.driveReplay.disabled = this.filters.session ? !replayable(selected) : !drives.some(replayable);
      window.geoaiDriveInspector?.update();
    }

    selectDrive(id = '') {
      if (window.geoaiDrivePlayer?.isOpen) window.geoaiDrivePlayer.close(false);
      const survey = window.geoaiSurvey;
      const filters = { ...(survey?.filters || this.filters), session: id };
      if (survey) {
        survey.filters = filters;
        if (survey.driveInput) survey.driveInput.value = id;
        survey.closeEvidence?.();
      }
      this.setFilters(filters);
      document.dispatchEvent(new CustomEvent('geoai:filterschange', { detail: { filters } }));
      this.focusRoutes(id);
    }

    focusRoutes(id = '') {
      const sessions = (this.catalog?.sessions || []).filter(s => (!id || s.session_id === id) && validTrack(s.track));
      const points = sessions.flatMap(s => (s.track.type === 'LineString' ? [s.track.coordinates] : s.track.coordinates)
        .flatMap(line => line.map(p => [p[1], p[0]])));
      if (!points.length) return;
      // Camera moves only after an explicit menu/focus action.
      const size = this.map.getSize?.();
      const width = size?.x || window.innerWidth || 1280;
      const height = size?.y || window.innerHeight || 800;
      const inspector = id && document.getElementById('driveInspector');
      const options = { padding: [50, 100], maxZoom: 17 };
      if (inspector && !inspector.hidden) {
        const panel = inspector.getBoundingClientRect();
        const menu = this.distance?.getBoundingClientRect();
        if (width > 820) {
          options.paddingTopLeft = [Math.min((menu?.right || 330) + 24, width * .42), 110];
          options.paddingBottomRight = [Math.min(panel.width + 48, width * .42), 85];
        } else {
          options.paddingTopLeft = [20, Math.min((menu?.bottom || 280) + 20, height * .4)];
          options.paddingBottomRight = [20, Math.min(panel.height + 20, height * .46)];
        }
        delete options.padding;
      }
      this.map.fitBounds(this.L.latLngBounds(points), options);
    }

    async setEnabled(enabled) {
      if (this.enabled === Boolean(enabled)) return;
      this.enabled = Boolean(enabled);
      if (this.enabled) this.selectVideo();
      else if (this.button.classList.contains('active')) {
        document.querySelectorAll('.nav-pill .nav-item').forEach(item => {
          item.classList.toggle('active', item.dataset.page === 'map');
        });
      }
      this.generation++;
      clearTimeout(this.retryTimer);
      clearTimeout(this.moveTimer);
      this.controller?.abort();
      this.updateButton();
      this.notify();
      this.updateDistance();
      this.button.removeAttribute('aria-busy');
      this.message('');
      if (!this.enabled) {
        this.inspection = null;
        this.playback = null;
        this.distressMarkers = [];
        this.clearUncertainty();
        this.map.removeLayer(this.layer);
        this.layer.clearLayers();
        this.distressLayer.clearLayers();
        this.renderedFeatures = null;
        this.renderedPlayback = null;
        this.paths = [];
        this.renderedPaths = null;
        this.features = [];
        return;
      }
      await this.load(this.generation);
    }

    viewQuery() {
      const bounds = this.map.getBounds();
      let west = bounds.getWest(), east = bounds.getEast();
      const south = Math.max(-90, bounds.getSouth()), north = Math.min(90, bounds.getNorth());
      if (![west, east, south, north].every(finite)) throw unsupported();
      if (east - west >= 360) { west = -180; east = 180; }
      else {
        west = ((west + 180) % 360 + 360) % 360 - 180;
        east = ((east + 180) % 360 + 360) % 360 - 180;
        // The API accepts one non-wrapping bbox; use all longitudes across the dateline.
        if (west > east) { west = -180; east = 180; }
      }
      const values = [west, south, east, north];
      const bbox = values.map(value => value.toFixed(6)).join(',');
      const geom = this.map.getZoom() >= 16 ? 'footprint' : 'point';
      return { bbox, geom, key: `${geom}:${bbox}:${JSON.stringify(this.filters)}` };
    }

    async json(path, signal) {
      const response = await this.fetch(`${this.apiBase}${path}`, { signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw Object.assign(new Error('Video survey request failed'), { status: response.status });
      const data = await response.json();
      if (signal.aborted) throw new Error('Video survey request cancelled');
      if (!data || data.schema !== SCHEMA) throw unsupported();
      return data;
    }

    validateMeta(meta) {
      if (!Array.isArray(meta.labels) || !meta.labels.length || !Array.isArray(meta.severities) || !meta.severities.length ||
          !finite(meta.confidence_threshold) || meta.confidence_threshold < 0 || meta.confidence_threshold > 1 ||
          !Number.isInteger(meta.limits?.default_limit) || meta.limits.default_limit < 1 ||
          !Number.isInteger(meta.limits?.max_limit) || meta.limits.max_limit < 1 ||
          meta.labels.some(label => typeof label.name !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(label.color)) ||
          meta.severities.some(level => typeof level.name !== 'string' || !finite(level.radius_px) || level.radius_px <= 0)) throw unsupported();
    }

    async load(generation) {
      if (!this.enabled || generation !== this.generation) return;
      clearTimeout(this.retryTimer);
      if (window.GIS_CONFIG?.dataSource === 'supabase') {
        this.loading = false; this.error = true; this.features = []; this.matched = null;
        this.updateDistance(null);
        this.message(window.GeoAICitizenSource?.VIDEO_UNAVAILABLE || 'Drive routes are not connected. This source contains citizen photos only.');
        this.notify();
        return;
      }
      this.loading = true;
      this.error = false;
      this.message('');
      // Existing observations remain anchored while the next viewport loads.
      // Explicit filter changes and disabling Video still clear invalid data.
      this.notify();
      const controller = new AbortController();
      this.controller = controller;
      this.button.setAttribute('aria-busy', 'true');
      const deadline = setTimeout(() => controller.abort(), 15000);
      const current = () => this.enabled && generation === this.generation && !controller.signal.aborted;
      try {
        const view = this.viewQuery();
        if (!this.catalog || Date.now() - this.catalog.at >= 60000) {
          const sessions = await this.json('/gis/video/sessions?track=true&per_km=false', controller.signal);
          if (!Array.isArray(sessions.sessions)) throw unsupported();
          const meta = await this.json('/gis/meta', controller.signal);
          this.validateMeta(meta);
          if (!current()) return;
          this.catalog = { at: Date.now(), sessions: sessions.sessions, meta };
        }
        this.meta = this.catalog.meta;
        this.labels = new Map(this.meta.labels.map(label => [label.name, label]));
        this.severities = new Map(this.meta.severities.map(level => [level.name, level]));
        // The drive catalogue is independent of filtered viewport observations.
        // Show every known route even while distress data loads or is unavailable.
        this.render(this.catalog.sessions);
        let features, tooMany = false;
        if (this.cache?.key === view.key && Date.now() - this.cache.at < 60000) {
          features = this.cache.features;
          this.matched = this.cache.matched;
        } else {
          features = [];
          const ids = new Set();
          const limit = Math.min(5000, this.meta.limits.default_limit, this.meta.limits.max_limit);
          let offset = 0, matched = null;
          do {
            const params = new URLSearchParams({ vlm_class: 'distress', geom: view.geom, bbox: view.bbox, limit: String(limit), offset: String(offset) });
            if (window.GeoAIGIS) {
              const shared = window.GeoAIGIS.query(this.filters, this.meta, 'video');
              shared.forEach((value, key) => params.set(key, value));
            }
            const data = await this.json(`/gis/video/segments.geojson?${params}`, controller.signal);
            if (!current()) return;
            if (data.type !== 'FeatureCollection' || !Array.isArray(data.features) ||
                !Number.isInteger(data.numberMatched) || data.numberMatched < 0 ||
                data.numberReturned !== data.features.length || data.numberReturned > limit ||
                offset + data.numberReturned > data.numberMatched ||
                (matched !== null && matched !== data.numberMatched) ||
                (!data.numberReturned && offset < data.numberMatched)) throw unsupported();
            matched = data.numberMatched;
            if (matched > 5000) { tooMany = true; break; }
            for (const feature of data.features) {
              if (!feature || typeof feature !== 'object') throw unsupported();
              const id = feature.properties?.segment_id || feature.id;
              if (!id || ids.has(id)) throw unsupported();
              ids.add(id);
              // Never infer distress from severity, confidence, or an unanswered detector gate.
              if (feature.type === 'Feature' && feature.properties?.vlm_class === 'distress') features.push(feature);
            }
            offset += data.numberReturned;
          } while (offset < matched);
          this.matched = matched;
          if (window.GeoAIGIS) features = features.filter(feature => window.GeoAIGIS.matches(feature, this.filters, this.meta, 'video'));
          if (!tooMany) this.cache = { key: view.key, at: Date.now(), features, matched };
        }
        if (!current()) return;
        this.truncated = tooMany;
        const nextFeatures = tooMany ? [] : features;
        if (JSON.stringify(this.features) !== JSON.stringify(nextFeatures)) this.features = nextFeatures;
        this.render(this.catalog.sessions);
        this.loading = false;
        this.notify();
        this.message(tooMany ? 'Too many distressed segments in this view. Zoom in to inspect the road.' : '');
      } catch (error) {
        if (!this.enabled || generation !== this.generation) return;
        this.updateDistance(this.catalog ? this.catalog.sessions : null);
        // Keep already loaded, correctly located observations during outages.
        // The notice and unavailable count distinguish them from fresh results.
        this.loading = false;
        this.error = true;
        this.notify();
        const temporary = !error.status || error.status >= 500;
        this.message(temporary
          ? (this.features.length ? 'Could not refresh this view. Previously loaded observations remain visible. Retrying in 30 seconds.' : 'Survey data temporarily unavailable. Retrying in 30 seconds.')
          : error.status === 404 ? 'Video surveys are not connected to this site yet.'
            : 'Video survey data could not load. Toggle Video off and on to retry.');
        if (temporary) this.retryTimer = setTimeout(() => this.load(generation), this.retryMs);
      } finally {
        clearTimeout(deadline);
        if (generation === this.generation) this.button.removeAttribute('aria-busy');
      }
    }

    tooltip(session) {
      const node = document.createElement('div');
      addLine(node, session.road_name || session.road_id || 'Drive survey', true);
      const state = COMPLETE.has(session.state) ? 'Complete' : session.state === 'failed' ? 'Failed' : 'Processing';
      const metres = finite(session.route_m) ? `${(session.route_m / 1000).toFixed(2)} km` : 'Length unavailable';
      addLine(node, [session.local_date || 'Date unavailable', metres, state].join(' · '));
      addLine(node, 'Drive path · approximate phone GNSS positions');
      addLine(node, 'Unmarked road is not a confirmed Normal result.');
      return node;
    }

    distressTooltip(properties) {
      const node = document.createElement('div');
      addLine(node, Array.isArray(properties.final_labels) ? properties.final_labels.join(' · ') : 'Distress', true);
      const confidence = finite(properties.confidence) ? `${Math.round(properties.confidence * 100)}% confidence` : 'Confidence unavailable';
      addLine(node, `${properties.final_severity} severity · ${confidence}`);
      addLine(node, properties.expert_reviewed ? 'Expert-reviewed' : properties.needs_expert_review
        ? 'Model result · awaiting expert review' : 'Model result · not expert-reviewed');
      const time = new Date(properties.local_time || properties.utc);
      if ((properties.local_time || properties.utc) && !Number.isNaN(time.valueOf())) {
        addLine(node, new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(time) + ' IST');
      }
      addLine(node, finite(properties.position_sigma_m) && properties.position_sigma_m >= 0
        ? `Approximate segment position · ±${properties.position_sigma_m} m (1σ)` : 'Approximate segment position · accuracy unavailable');
      return node;
    }

    render(sessions) {
      sessions = [...new Map(sessions.filter(s => s?.session_id).map(s => [s.session_id, s])).values()];
      this.updateDistance(sessions);
      this.clearUncertainty();
      const signature = JSON.stringify(sessions);
      if (this.renderedPaths !== signature) {
        for (const { path } of this.paths) this.layer.removeLayer(path);
        this.paths = [];
        sessions.forEach(session => {
        if (!session || !validTrack(session.track)) return;
        let hash = 0;
        for (const char of String(session.session_id || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        const path = this.L.geoJSON({ type: 'Feature', properties: {}, geometry: session.track }, {
          renderer: this.renderer,
          style: { weight: 2, opacity: .55, lineCap: 'round', lineJoin: 'round', dashArray: COMPLETE.has(session.state) ? null : '7 5' },
        });
        path.bindTooltip(() => this.tooltip(session), { sticky: true, direction: 'top', className: 'video-map-tooltip' });
        path.addTo(this.layer);
        this.paths.push({ path, sessionId: session.session_id, colorIndex: hash % LIGHT.length });
        });
        this.renderedPaths = signature;
      }
      this.applyTheme();
      if (!this.layer.getLayers().includes(this.distressLayer)) this.distressLayer.addTo(this.layer);
      if (!this.map.hasLayer(this.layer)) this.layer.addTo(this.map);
      this.renderDistress();
      this.button.title = `Video on · ${this.paths.length} drive paths · ${this.features.length} distressed segments in view`;
    }

    // Playback supplies a complete, filtered drive without changing the viewport
    // result list used by counts and exports.
    setPlaybackData({ sessionId, features, distance = 0 } = {}) {
      if (!this.enabled || typeof sessionId !== 'string' || !sessionId || !Array.isArray(features) || features.length > 5000) return false;
      const seen = new Set();
      const usable = features.filter(feature => {
        const p = feature?.properties, id = p?.segment_id || feature?.id;
        if (feature?.type !== 'Feature' || p?.session_id !== sessionId || p.vlm_class !== 'distress' || !id || seen.has(id)) return false;
        seen.add(id); return true;
      });
      this.playback = { sessionId, features: usable, distance: finite(distance) ? Math.max(0, distance) : 0 };
      this.renderDistress();
      return true;
    }

    setPlaybackProgress(distance) {
      if (!this.enabled || !this.playback || !finite(distance)) return;
      this.playback.distance = Math.max(0, distance);
      for (const entry of this.distressMarkers) this.updateMarkerProgress(entry);
    }

    clearPlayback() {
      if (!this.playback) return;
      this.playback = null;
      this.renderDistress();
    }

    updateMarkerProgress(entry) {
      const members = entry.members || [entry];
      const reachedCount = this.playback ? members.filter(member => finite(member.feature.properties.s0_m) && member.feature.properties.s0_m <= this.playback.distance).length : null;
      const knownCount = members.filter(member => finite(member.feature.properties.s0_m)).length;
      const reached = reachedCount === null ? null : reachedCount === members.length ? true : reachedCount === 0 && knownCount === members.length ? false : 'partial';
      if (entry.reached === reached && entry.reachedCount === reachedCount) return;
      entry.reached = reached; entry.reachedCount = reachedCount;
      const element = entry.marker.getElement?.();
      element?.classList.toggle('video-distress-reached', reached === true);
      element?.classList.toggle('video-distress-upcoming', reached === false);
      element?.classList.toggle('video-distress-partial', reached === 'partial');
      entry.marker.setOpacity?.(reached === false ? .35 : 1);
      if (members.length > 1 && element) {
        element.setAttribute('aria-label', this.clusterLabel(entry));
        const progress = element.querySelector('.video-distress-cluster-progress');
        if (progress) { progress.textContent = reachedCount === null ? '' : `${reachedCount}/${members.length}`; progress.hidden = reachedCount === null; }
      }
      for (const member of members) {
        const ahead = this.playback && finite(member.feature.properties.s0_m) && member.feature.properties.s0_m > this.playback.distance;
        member.footprint?.setStyle({ opacity: ahead ? .2 : .65, fillOpacity: ahead ? .04 : .18 });
      }
    }

    clusterCanZoom(entry) {
      const maxZoom = this.map.getMaxZoom?.(), ceiling = finite(maxZoom) ? maxZoom : 21;
      if (this.map.getZoom() >= ceiling) return false;
      const first = entry.members[0].location;
      return entry.members.some(member => {
        const lat = (member.location.lat - first.lat) * 111320;
        const lon = (((member.location.lng - first.lng + 540) % 360) - 180) * 111320 * Math.cos(first.lat * Math.PI / 180);
        return lat * lat + lon * lon > 1;
      });
    }

    clusterLabel(entry) {
      const count = entry.members.length;
      const progress = this.playback ? ` · ${entry.reachedCount || 0} of ${count} reached` : '';
      return `${count} drive distress observations${progress} · ${this.clusterCanZoom(entry) ? 'Zoom in to separate' : 'Open photos and details'}`;
    }

    openCluster(entry) {
      entry.marker.closeTooltip?.(); this.clearUncertainty();
      if (this.clusterCanZoom(entry)) {
        const anchor = entry.members[0].location.lng;
        const points = entry.members.map(member => [member.location.lat, anchor + (((member.location.lng - anchor + 540) % 360) - 180)]);
        const maxZoom = this.map.getMaxZoom?.();
        this.map.fitBounds(this.L.latLngBounds(points), { padding: [60, 60], maxZoom: Math.min(finite(maxZoom) ? maxZoom : 21, this.map.getZoom() + 3), animate: false });
        return;
      }
      const members = entry.members.map(member => member.feature).sort((a, b) =>
        String(a.properties.session_id || '').localeCompare(String(b.properties.session_id || '')) || (a.properties.s0_m ?? Infinity) - (b.properties.s0_m ?? Infinity));
      if (window.geoaiSurvey) window.geoaiSurvey.showEvidence(members[0], members);
      else entry.marker.openTooltip();
    }

    renderDistress() {
      this.clearUncertainty();
      const zoom = this.map.getZoom();
      const features = this.playback?.features || this.inspection?.features || this.features;
      // Following the vehicle refreshes viewport counts, but its complete
      // playback result set has not changed. Retain those marker instances;
      // Leaflet repositions them during a pan and reattaches them with the
      // feature group after route rendering. Zoom changes still rebuild sizes
      // and nearby-observation groups.
      if (this.enabled && this.renderedFeatures === features && this.renderedPlayback === this.playback &&
          this.renderedPlaybackZoom === zoom && this.renderedPlaybackMeta === this.meta) return;
      this.renderedPlayback = null;
      this.renderedFeatures = null;
      this.distressLayer.clearLayers();
      this.distressMarkers = [];
      if (!this.enabled || !this.meta) return;
      const entries = [];
      for (const feature of features) {
        const p = feature.properties, location = centre(feature);
        const color = this.labels.get(p.marker_label)?.color;
        const radius = this.severities.get(p.final_severity)?.radius_px;
        if (!location || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color || '') || !finite(radius) || radius <= 0) continue;
        const entry = { feature, location, color, radius };
        if (zoom >= 16 && validFootprint(feature.geometry)) {
          entry.footprint = this.L.geoJSON(feature, { renderer: this.renderer, interactive: false,
            style: { renderer: this.renderer, color, fillColor: color, weight: 1, opacity: .65, fillOpacity: .18, interactive: false } });
          entry.footprint.addTo(this.distressLayer);
        }
        entries.push(entry);
      }
      for (const entry of clusterEntries(entries, zoom)) {
        const { feature, location, radius } = entry, p = feature.properties, clustered = entry.members.length > 1;
        const dominant = [...entry.members].sort((a, b) => b.radius - a.radius ||
          (this.labels.get(a.feature.properties.marker_label)?.marker_priority ?? Infinity) - (this.labels.get(b.feature.properties.marker_label)?.marker_priority ?? Infinity))[0];
        const color = dominant.color;
        const badge = document.createElement('span');
        badge.className = 'video-distress-badge' + (clustered ? ' video-distress-cluster-badge' : '') + (entry.members.length >= 1000 ? ' video-distress-large-cluster' : '');
        badge.style.setProperty('--distress-color', color);
        badge.style.setProperty('--distress-size', `${Math.max(14, Math.min(24, radius * 2))}px`);
        badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3z"/></svg>';
        if (clustered) {
          const count = document.createElement('strong'); count.textContent = String(entry.members.length); badge.append(count);
          const progress = document.createElement('span'); progress.className = 'video-distress-cluster-progress'; progress.hidden = true; badge.append(progress);
        }
        const labels = Array.isArray(p.final_labels) ? p.final_labels.filter(value => typeof value === 'string') : [];
        const label = clustered ? this.clusterLabel(entry) : `Drive distress · ${labels.join(' · ') || 'Distress'} · ${p.final_severity} severity${finite(p.s0_m) ? ` · ${p.s0_m.toFixed(0)} m along drive` : ''} · Open photo and details`;
        const marker = this.L.marker(location, {
          icon: this.L.divIcon({ html: badge, className: 'video-distress-icon' + (clustered ? ' video-distress-cluster' : ''), iconSize: clustered ? [40, 40] : [32, 32], iconAnchor: clustered ? [20, 20] : [16, 16] }),
          keyboard: true, autoPanOnFocus: false, riseOnHover: true, bubblingMouseEvents: false,
          title: label, zIndexOffset: clustered ? 300 : 200,
        });
        entry.marker = marker;
        marker.on('add', () => {
          const element = marker.getElement?.();
          if (!element) return;
          element.setAttribute('role', 'button'); element.setAttribute('aria-label', label);
          if (clustered) element.dataset.count = String(entry.members.length);
          else element.dataset.segmentId = String(p.segment_id || feature.id || '');
          element.addEventListener('keydown', event => {
            if (event.key === ' ' || event.key === 'Spacebar') {
              event.preventDefault(); event.stopPropagation(); marker.fire('click');
            }
          });
          entry.reached = undefined; this.updateMarkerProgress(entry);
        });
        marker.bindTooltip(() => {
          if (!clustered) return this.distressTooltip(p);
          const node = document.createElement('div'); addLine(node, `${entry.members.length} drive distress observations`, true);
          addLine(node, this.clusterCanZoom(entry) ? 'Click to zoom in and separate nearby observations.' : 'Click to browse every photo at this location.');
          if (this.playback) addLine(node, `${entry.reachedCount || 0} of ${entry.members.length} reached during replay.`);
          return node;
        }, { direction: 'top', className: 'video-map-tooltip' });
        marker.on('tooltipopen', () => {
          this.clearUncertainty();
          if (!clustered && finite(p.position_sigma_m) && p.position_sigma_m > 0) {
            this.uncertainty = this.L.circle(location, { renderer: this.renderer, radius: p.position_sigma_m, color,
              weight: 1, dashArray: '3 3', fillOpacity: .06, interactive: false }).addTo(this.layer);
          }
        });
        marker.on('tooltipclose', () => this.clearUncertainty());
        marker.on('click', () => {
          if (clustered) { this.openCluster(entry); return; }
          if (window.geoaiSurvey) {
            marker.closeTooltip?.(); this.clearUncertainty();
            window.geoaiSurvey.showEvidence(feature, [feature]);
          } else marker.openTooltip();
        });
        marker.addTo(this.distressLayer);
        this.distressMarkers.push(entry);
        this.updateMarkerProgress(entry);
      }
      this.renderedPlayback = this.playback;
      this.renderedFeatures = features;
      this.renderedPlaybackZoom = zoom;
      this.renderedPlaybackMeta = this.meta;
    }

    clearUncertainty() {
      if (this.uncertainty) this.layer.removeLayer(this.uncertainty);
      this.uncertainty = null;
    }

    applyTheme() {
      const palette = document.body.classList.contains('chrome-dark') ? DARK : LIGHT;
      this.paths.forEach(({ path, sessionId, colorIndex }) => path.setStyle({ color: palette[colorIndex],
        weight: sessionId === this.filters.session ? 5 : 3, opacity: sessionId === this.filters.session ? 1 : .7 }));
    }

    destroy() {
      if (this.enabled) this.setEnabled(false);
      clearTimeout(this.retryTimer);
      clearTimeout(this.moveTimer);
      this.controller?.abort();
      this.themeObserver.disconnect();
      this.map.off('moveend', this.move);
      this.map.off('zoomend', this.zoom);
      this.button.removeEventListener('click', this.click, true);
      this.mapButton?.removeEventListener('click', this.mapClick);
      document.removeEventListener('geoai:driveinspectionchange', this.inspectionChanged);
    }
  }

  window.GeoAIVideoPaths = GeoAIVideoPaths;
  const button = document.getElementById('videoToggle');
  if (button && typeof map !== 'undefined' && window.L) {
    window.geoaiVideoPaths = new GeoAIVideoPaths({ map, L: window.L, button,
      notice: document.getElementById('videoNotice'), apiBase: window.GIS_CONFIG?.apiBase || '' });
  }
})();
