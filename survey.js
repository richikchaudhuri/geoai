/* Read-only survey workspace. The existing navigation and map stay in place. */
(function () {
  'use strict';
  const G = window.GeoAIGIS;
  if (!G || typeof map === 'undefined') return;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text != null) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const date = value => {
    const parsed = value && new Date(value);
    return parsed && Number.isFinite(parsed.valueOf()) ? new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
    }).format(parsed) + ' IST' : 'Time unavailable';
  };
  const review = p => p.expert_reviewed ? 'Expert-reviewed' : p.needs_expert_review
    ? 'Model result · awaiting expert review' : 'Model result · not expert-reviewed';
  const point = feature => {
    const p = feature.properties || {};
    const candidate = feature.geometry?.type === 'Point' ? feature.geometry.coordinates
      : [p.centre_lon ?? p.longitude, p.centre_lat ?? p.latitude];
    return G.coordinate(candidate) ? [candidate[1], candidate[0]] : null;
  };
  // Fixed world-pixel anchors make groups stable while panning. Nearby
  // cells are searched too, so observations on a grid edge still cluster.
  function citizenClusters(rows, zoom) {
    const radius = 40, world = 256 * 2 ** zoom, columns = Math.ceil(world / radius);
    const projected = rows.map(row => {
      const latitude = Math.max(-85.05112878, Math.min(85.05112878, row.latitude));
      const sine = Math.sin(latitude * Math.PI / 180);
      return { row, x: ((row.longitude + 180) / 360 * world) % world,
        y: (.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * world };
    }).sort((a, b) => a.x - b.x || a.y - b.y || String(a.row.feature.id || '').localeCompare(String(b.row.feature.id || '')));
    const cells = new Map(), groups = [];
    const key = (x, y) => `${(x + columns) % columns}:${y}`;
    for (const item of projected) {
      const column = Math.floor(item.x / radius), row = Math.floor(item.y / radius);
      let nearest = null, distance = radius * radius + 1;
      for (let x = column - 1; x <= column + 1; x++) for (let y = row - 1; y <= row + 1; y++) {
        for (const group of cells.get(key(x, y)) || []) {
          const rawX = Math.abs(item.x - group.x), dx = Math.min(rawX, world - rawX), dy = item.y - group.y;
          const candidate = dx * dx + dy * dy;
          if (candidate <= radius * radius && candidate < distance) { nearest = group; distance = candidate; }
        }
      }
      if (nearest) nearest.rows.push(item.row);
      else {
        const group = { x: item.x, y: item.y, rows: [item.row] }, cell = key(column, row);
        if (!cells.has(cell)) cells.set(cell, []);
        cells.get(cell).push(group); groups.push(group);
      }
    }
    return groups.map(group => group.rows);
  }

  class Survey {
    constructor() {
      this.directCitizen = window.GIS_CONFIG?.dataSource === 'supabase';
      this.client = this.directCitizen ? new window.GeoAICitizenSource.Client(window.GIS_CONFIG)
        : new G.Client({ apiBase: window.GIS_CONFIG?.apiBase || '', baseURI: document.baseURI });
      this.filters = {};
      this.features = [];
      this.sessions = [];
      this.generation = 0;
      this.layer = L.layerGroup().addTo(map);
      this.video = window.geoaiVideoPaths;
      this.renderer = this.video.renderer;
      this.root = document.getElementById('filterRoot');
      this.notice = node('p', '', 'survey-message');
      this.notice.setAttribute('role', 'status');
      this.root.append(this.notice);
      this.root.classList.add('survey-filters');
      this.root.addEventListener('click', e => e.stopPropagation());
      this.videoEvent = () => {
        this.syncCitizenVisibility();
        this.updateCounts();
        this.renderLocations();
        if (!this.video.enabled && this.evidence?.dataset.layer === 'video') this.closeEvidence();
      };
      document.addEventListener('geoai:videochange', this.videoEvent);
      this.cardsClosed = () => this.clearEvidenceState();
      document.addEventListener('geoai:cardsclosed', this.cardsClosed);
      this.cardsOpened = event => {
        const feature = event.detail?.row?.__gis?.feature;
        if (feature) this.trackEvidence(feature, event.detail.anchor);
      };
      document.addEventListener('geoai:cardsopened', this.cardsOpened);
      // Zoom changes only visual grouping of the full filtered collection;
      // it never refetches observations or changes their reported count.
      this.citizenZoom = () => { if (this.meta) this.renderCitizens(); };
      map.on('zoomend', this.citizenZoom);
      this.escape = e => { if (e.key === 'Escape') this.closeEvidence(); };
      document.addEventListener('keydown', this.escape);
      document.querySelectorAll('.nav-item, .topbar .brand').forEach(control => {
        control.addEventListener('click', () => this.closeEvidence());
      });
      this.init();
    }

    async init() {
      clearTimeout(this.initRetry);
      this.notice.textContent = 'Connecting to survey data…';
      try {
        // Citizen observations need metadata, but must not wait for the
        // independent Video catalogue to become available.
        const meta = await this.client.meta();
        this.meta = meta;
        this.labelMap = new Map(meta.labels.map(value => [value.name, value]));
        this.radiusMap = new Map(meta.severities.map(value => [value.name, value.radius_px]));
        this.classMap = new Map((meta.vlm_classes || []).map(value => [value.name, value]));
        const shared = G.parseView(location.search, meta);
        this.filters = shared.filters;
        this.video.setFilters(this.filters);
        this.buildControls();
        this.buildSettings();
        this.buildLegend();
        if (shared.hasView) {
          const current = map.getCenter();
          if (current.lat !== shared.lat || current.lng !== shared.lng || map.getZoom() !== shared.zoom)
            map.setView([shared.lat, shared.lng], shared.zoom, { animate: false });
          if (shared.style) setMapStyle(shared.style);
        }
        this.loadSessions();
        if (shared.video) this.video.setEnabled(true);
        await this.loadCitizens();
      } catch (error) {
        this.notice.textContent = this.directCitizen ? (error.message || 'Citizen database unavailable.') + ' Retrying in 30 seconds.'
          : 'Survey data temporarily unavailable. Retrying in 30 seconds.';
        setStatus('Survey data unavailable', 'error');
        this.initRetry = setTimeout(() => this.init(), 30000);
      } finally {
        LoadingScreen.finish();
      }
    }

    async loadSessions() {
      if (!this.meta) return;
      if (this.directCitizen) {
        this.sessions = []; this.sessionsReady = true; this.sessionsLoading = false; this.sessionsError = false;
        this.updateDriveCatalogue(); return;
      }
      const generation = (this.sessionGeneration || 0) + 1;
      this.sessionGeneration = generation;
      clearTimeout(this.sessionRetry);
      this.sessionController?.abort();
      this.sessionController = new AbortController();
      this.sessionsLoading = true;
      this.sessionsError = false;
      this.updateDriveCatalogue();
      try {
        const catalogue = await this.client.sessions({ signal: this.sessionController.signal });
        if (generation !== this.sessionGeneration) return;
        this.sessions = catalogue.sessions;
        this.sessionsReady = true;
        this.video.catalog = { at: Date.now(), sessions: this.sessions, meta: this.meta };
        // Keep the current map/filter state. Only an unavailable Video layer
        // needs another request after the catalogue has recovered.
        if (this.video.enabled && this.video.error) this.video.setFilters(this.filters);
      } catch (error) {
        if (generation !== this.sessionGeneration) return;
        this.sessionsError = true;
        this.sessionRetry = setTimeout(() => this.loadSessions(), 30000);
      } finally {
        if (generation === this.sessionGeneration) {
          this.sessionsLoading = false;
          this.updateDriveCatalogue();
        }
      }
    }

    updateDriveCatalogue() {
      if (!this.driveInput) return;
      const all = node('option', 'All drives'); all.value = '';
      this.driveInput.replaceChildren(all);
      for (const session of this.sessions) {
        const option = node('option', (session.road_name || session.road_id || 'Drive') + ' · ' + (session.local_date || 'Unknown date'));
        option.value = session.session_id; this.driveInput.append(option);
      }
      if (this.filters.session && !this.sessions.some(session => session.session_id === this.filters.session)) {
        const title = this.sessionsReady ? 'Unavailable drive' : 'Selected drive';
        const unavailable = node('option', title + ' · ' + this.filters.session);
        unavailable.value = this.filters.session; this.driveInput.append(unavailable);
      }
      this.driveInput.value = this.filters.session;
      if (this.focusDriveButton) this.focusDriveButton.disabled = this.directCitizen || !this.sessionsReady;
      this.driveInput.disabled = this.directCitizen;
      if (this.driveStatus) {
        this.driveStatus.textContent = this.directCitizen ? window.GeoAICitizenSource.VIDEO_UNAVAILABLE : this.sessionsLoading || (!this.sessionsReady && !this.sessionsError)
          ? 'Loading drives…' : this.sessionsError
            ? 'Drive catalogue unavailable. Retrying in 30 seconds. Citizen observations remain available.' : '';
        this.driveStatus.hidden = !this.driveStatus.textContent;
      }
      if (this.driveList) this.renderDrives(this.driveSort?.value || 'distress_m');
    }

    control(label, input) {
      const wrap = node('label', null, 'survey-field');
      wrap.append(node('span', label), input);
      return wrap;
    }
    checkbox(name, label, checked = false) {
      const input = node('input');
      input.type = 'checkbox'; input.name = name; input.checked = checked;
      const wrap = node('label', null, 'survey-check');
      wrap.append(input, node('span', label));
      return wrap;
    }
    section(title) {
      const details = node('details', null, 'survey-section');
      details.append(node('summary', title));
      this.form.append(details);
      return details;
    }
    action(label, handler, parent = this.form) {
      const button = node('button', label, 'survey-action');
      button.type = 'button';
      button.addEventListener('click', handler);
      parent.append(button);
      return button;
    }

    buildControls() {
      // Stop the retired single-layer filter handlers at this boundary.
      const heading = node('div', null, 'survey-filter-heading');
      const title = node('div', null, 'survey-filter-title');
      title.append(node('h2', 'Filters', 'filter-header'),
        node('p', 'Refine observations by type, time and review.', 'survey-filter-description'));
      heading.append(title);
      const reset = this.action('Clear filters', () => {
        this.filters = G.normalizeFilters({}, this.meta);
        this.buildControls(); this.apply();
        this.root.querySelector('.survey-reset')?.focus();
      }, heading);
      reset.classList.add('survey-reset');
      this.root.replaceChildren(heading);
      this.form = node('form', null, 'survey-form');
      this.form.setAttribute('aria-label', 'Survey filters');
      this.form.addEventListener('submit', e => e.preventDefault());
      this.root.append(this.form);
      const layerSection = this.section('Layers and review');
      layerSection.append(this.checkbox('citizen', 'Citizen observations in Map mode', this.filters.citizen));
      layerSection.append(this.checkbox('includeReview', 'Include citizen results awaiting review', this.filters.includeReview));
      const reviewInput = node('select'); reviewInput.name = 'review';
      for (const [value, text] of [['all', 'All review states'], ['needs', 'Needs expert review'], ['reviewed', 'Expert-reviewed']]) {
        const option = node('option', text); option.value = value; reviewInput.append(option);
      }
      reviewInput.value = this.filters.review;
      layerSection.append(this.control('Review state · both layers', reviewInput));
      layerSection.append(this.checkbox('highConfidence', 'Confidence ≥ ' + Math.round(this.meta.confidence_threshold * 100) + '%', this.filters.highConfidence));
      const severity = this.section('Severity and distress type');
      const severityList = node('div', null, 'survey-options');
      for (const value of this.meta.severities) {
        const wrap = this.checkbox('severity', value.name, this.filters.severities.includes(value.name));
        wrap.querySelector('input').value = value.name; severityList.append(wrap);
      }
      severity.append(severityList);
      this.action('High severity preset', () => {
        this.form.querySelectorAll('[name=severity]').forEach(input => { input.checked = input.value === 'High'; });
        this.apply();
      }, severity);
      const categories = new Map();
      for (const label of this.meta.labels) {
        if (!categories.has(label.category)) {
          const group = node('fieldset');
          group.append(node('legend', label.category || 'Distress'));
          categories.set(label.category, group); severity.append(group);
        }
        const wrap = this.checkbox('label', label.name, this.filters.labels.includes(label.name));
        wrap.querySelector('input').value = label.name;
        categories.get(label.category).append(wrap);
      }
      severity.append(node('p', 'Video shows distress only. Selecting Normal can match citizen observations, but will not reveal Normal video segments.', 'survey-help'));
      const time = this.section('Date and capture time');
      const dateRange = node('div', null, 'survey-date-range');
      time.append(dateRange);
      for (const [key, label] of [['dateFrom', 'From · IST'], ['dateTo', 'Through · IST']]) {
        const input = node('input'); input.type = 'date'; input.name = key; input.value = this.filters[key];
        input.min = '0001-01-01'; input.max = '9998-12-31';
        dateRange.append(this.control(label, input));
      }
      const capture = node('select'); capture.name = 'captureTime';
      for (const [value, label] of [['all', 'Any time'], ['day', 'Day · 06:00–18:00 IST'], ['night', 'Night · 18:00–06:00 IST']]) {
        const option = node('option', label); option.value = value; capture.append(option);
      }
      capture.value = this.filters.captureTime;
      time.append(this.control('Capture time', capture));
      const drives = this.section('Drives');
      this.driveInput = node('select'); this.driveInput.name = 'session';
      drives.append(this.control('Selected drive · Video only', this.driveInput));
      this.focusDriveButton = this.action('Focus selected drive', () => this.focusDrive(), drives);
      this.driveStatus = node('p', '', 'survey-help');
      this.driveStatus.setAttribute('role', 'status'); drives.append(this.driveStatus);
      const sort = node('select'); sort.setAttribute('aria-label', 'Sort drives');
      this.driveSort = sort;
      for (const [value, label] of [['distress_m', 'Most distressed metres'], ['pct_distress_of_surveyed', 'Highest distress percentage'], ['start_utc', 'Newest first']]) {
        const option = node('option', label); option.value = value; sort.append(option);
      }
      drives.append(this.control('Sort drives', sort));
      this.driveList = node('div', null, 'survey-drive-list'); drives.append(this.driveList);
      sort.addEventListener('change', () => this.renderDrives(sort.value));
      this.updateDriveCatalogue();
      const results = this.section('Results and exports');
      this.counts = node('p', '', 'survey-counts'); results.append(this.counts);
      results.append(node('p', 'Citizen counts include all filtered observations. Video counts and all exports use the current map area. Total distance includes all recorded drives and repeat passes. Selected-drive statistics appear below the total.', 'survey-help'));
      const videoExport = this.action('Export video CSV', () => this.export('video'), results);
      videoExport.disabled = this.directCitizen;
      if (this.directCitizen) results.append(node('p', 'Connected to the citizen database. Drives need the video GIS server.', 'survey-help'));
      this.action('Export citizen CSV', () => this.export('citizen'), results);
      this.locations = node('div', null, 'survey-locations');
      const top = this.section('Top citizen locations'); top.append(this.locations);
      this.form.addEventListener('change', event => {
        if (event.target === sort) return;
        if (event.target.name === 'review' && event.target.value === 'needs') {
          this.form.elements.namedItem('includeReview').checked = true;
        }
        this.apply();
      });
      this.root.append(this.notice);
      this.updateCounts();
    }

    async apply() {
      const value = name => this.form.elements.namedItem(name)?.value || '';
      const checked = name => !!this.form.elements.namedItem(name)?.checked;
      if (value('dateFrom') && value('dateTo') && value('dateFrom') > value('dateTo')) {
        this.form.elements.namedItem('dateFrom').value = this.filters.dateFrom;
        this.form.elements.namedItem('dateTo').value = this.filters.dateTo;
        this.notice.textContent = 'The end date must be on or after the start date. Previous dates kept.';
        return;
      }
      this.filters = G.normalizeFilters({
        labels: [...this.form.querySelectorAll('[name=label]:checked')].map(input => input.value),
        severities: [...this.form.querySelectorAll('[name=severity]:checked')].map(input => input.value),
        review: value('review'), dateFrom: value('dateFrom'), dateTo: value('dateTo'),
        session: value('session'), captureTime: value('captureTime'),
        citizen: checked('citizen'), includeReview: checked('includeReview'), highConfidence: checked('highConfidence'),
      }, this.meta);
      this.form.elements.namedItem('dateFrom').value = this.filters.dateFrom;
      this.form.elements.namedItem('dateTo').value = this.filters.dateTo;
      this.closeEvidence();
      this.video.setFilters(this.filters);
      document.dispatchEvent(new CustomEvent('geoai:filterschange', { detail: { filters: this.filters } }));
      await this.loadCitizens({ retainMarkers: false });
    }

    bbox() {
      return this.video.viewQuery().bbox;
    }
    async loadCitizens({ retainMarkers = true } = {}) {
      if (!this.meta) return;
      const generation = ++this.generation;
      this.controller?.abort(); clearTimeout(this.retry);
      this.controller = new AbortController();
      this.citizenLoading = true;
      this.notice.textContent = 'Updating results…';
      if (!retainMarkers || !this.filters.citizen) {
        this.features = []; this.layer.clearLayers(); this.citizenRenderKey = null;
      }
      this.truncated = false;
      this.citizenMatched = null;
      this.sourceStats = null;
      this.updateCounts();
      this.renderLocations();
      try {
        if (!this.filters.citizen) {
          this.citizenMatched = 0; this.notice.textContent = ''; this.updateCounts(); this.renderLocations(); return;
        }
        const result = await this.client.features('citizen', this.filters, this.meta, {
          signal: this.controller.signal, max: 5000,
        });
        if (generation !== this.generation) return;
        this.features = result.features.filter(feature => G.matches(feature, this.filters, this.meta, 'citizen'));
        this.citizenMatched = this.filters.captureTime === 'all' ? result.numberMatched : this.features.length;
        this.truncated = result.truncated;
        this.sourceStats = result.sourceStats || null;
        this.renderCitizens();
        this.notice.textContent = result.truncated ? 'More than 5,000 citizen results. Narrow the dates or filters to show every observation.'
          : this.sourceStats ? 'Citizen database · ' + this.sourceStats.total.toLocaleString() + ' available observations. ' +
            (this.sourceStats.awaitingReview ? this.sourceStats.awaitingReview.toLocaleString() + ' await expert review' + (this.filters.includeReview ? ' (included). ' : '; use Include citizen results awaiting review to show them. ') : '') +
            (this.sourceStats.unlocated ? this.sourceStats.unlocated.toLocaleString() + ' have no map location. ' : '') +
            (this.sourceStats.awaitingAssessment ? this.sourceStats.awaitingAssessment.toLocaleString() + ' await assessment.' : '') : '';
        this.renderLocations();
      } catch (error) {
        if (generation !== this.generation) return;
        this.notice.textContent = (retainMarkers && this.features.length ? 'Showing previous citizen results. ' : '') +
          (this.directCitizen ? (error.message || 'Citizen database unavailable.') + ' Retrying in 30 seconds.' : 'Survey data temporarily unavailable. Retrying in 30 seconds.');
        if (!this.video.enabled) setStatus('Citizen data unavailable', 'error');
        this.retry = setTimeout(() => this.loadCitizens({ retainMarkers }), 30000);
      } finally {
        if (generation === this.generation) { this.citizenLoading = false; this.updateCounts(); this.renderLocations(); }
      }
    }

    style(feature) {
      const p = feature.properties || {};
      const fillColor = p.vlm_class === 'distress' ? this.labelMap.get(p.marker_label)?.color
        : this.classMap.get(p.vlm_class)?.color;
      return { fillColor: fillColor || '#6b7280', radius: this.radiusMap.get(p.final_severity) || 4,
        color: '#fff', weight: 2.5, fillOpacity: .9, renderer: this.renderer };
    }
    syncCitizenVisibility() {
      // Keep the saved citizen filter and loaded markers intact across modes.
      const visible = !this.video.enabled && this.filters.citizen !== false;
      if (visible && !map.hasLayer(this.layer)) this.layer.addTo(map);
      else if (!visible && map.hasLayer(this.layer)) map.removeLayer(this.layer);
      if (!visible && this.evidence?.dataset.layer === 'citizen') this.closeEvidence();
    }
    renderCitizens() {
      this.syncCitizenVisibility();
      const zoom = Math.max(0, Math.min(24, finite(map.getZoom()) ? map.getZoom() : 12));
      const renderKey = JSON.stringify([zoom, this.features]);
      if (renderKey === this.citizenRenderKey) return;
      const rows = this.features.flatMap(feature => {
        const location = point(feature);
        return location ? [{ feature, latitude: location[0], longitude: location[1],
          created_at: feature.properties?.data_source === 'supabase' ? feature.properties.captured_at
            : feature.properties?.created_at || feature.properties?.local_time || feature.properties?.utc }] : [];
      });
      const groups = citizenClusters(rows, zoom);
      this.layer.clearLayers();
      this.citizenRenderKey = renderKey;
      for (const rows of groups) {
        const group = rows.map(row => row.feature);
        const first = group[0], location = point(first);
        const priority = group.slice().sort((a, b) => (this.labelMap.get(a.properties.marker_label)?.marker_priority || 100) -
          (this.labelMap.get(b.properties.marker_label)?.marker_priority || 100))[0];
        const allNight = rows.every(row => rowIsDaytime(row) === false);
        let marker;
        if (group.length > 1) {
          if (allNight) L.circleMarker(location, { renderer: this.renderer,
            radius: Math.min(28, 18 + group.length), color: '#0F172A', weight: 1.5,
            fillColor: '#0F172A', fillOpacity: .28, dashArray: '4 3', interactive: false }).addTo(this.layer);
          const size = Math.min(40, 28 + group.length * 2);
          const label = `${group.length} citizen observations · Zoom in or inspect photos`;
          marker = L.marker(location, { keyboard: true, autoPanOnFocus: false, title: label, icon: L.divIcon({
            className: 'cluster-marker-wrapper',
            html: '<div class="cluster-marker' + (allNight ? ' night' : '') + '" style="background:' + this.style(priority).fillColor + '">' + group.length + '</div>',
            iconSize: [size, size], iconAnchor: [size / 2, size / 2],
          }) });
          marker.on('add', () => {
            const element = marker.getElement?.();
            if (!element) return;
            element.setAttribute('role', 'button'); element.setAttribute('aria-label', label);
            element.addEventListener('keydown', event => {
              if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); event.stopPropagation(); marker.fire('click'); }
            });
          });
          marker.on('click', () => {
            const maxZoom = finite(map.getMaxZoom?.()) ? map.getMaxZoom() : 22;
            const positions = rows.map(row => [row.latitude, location[1] + ((row.longitude - location[1] + 540) % 360) - 180]);
            const spread = positions.some(p => Math.hypot((p[0] - location[0]) * 111320,
              (p[1] - location[1]) * 111320 * Math.cos(location[0] * Math.PI / 180)) > .5);
            if (spread && map.getZoom() < maxZoom) {
              this.closeEvidence();
              map.fitBounds(positions, { padding: [50, 110], maxZoom: Math.min(maxZoom, map.getZoom() + 3) });
            } else this.showEvidence(first, group);
          });
        } else {
          const style = this.style(first);
          if (allNight) L.circleMarker(location, { renderer: this.renderer,
            radius: style.radius + 6, color: '#0F172A', weight: 1.5,
            fillColor: '#0F172A', fillOpacity: .28, dashArray: '4 3', interactive: false }).addTo(this.layer);
          marker = L.circleMarker(location, { ...style, dashArray: allNight ? '5 3' : null });
          marker.on('click', () => this.showEvidence(first));
          marker.bindTooltip(node('span', (first.properties.final_labels || []).join(' · ') || first.properties.vlm_class || 'Unclassified'));
        }
        marker.addTo(this.layer);
      }
    }

    updateCounts() {
      if (!this.meta) return;
      this.syncCitizenVisibility();
      const citizen = !this.filters.citizen ? 'Citizen layer off' : this.citizenLoading ? 'Citizen results loading…' : this.citizenMatched == null
        ? 'Citizen results unavailable' : this.citizenMatched.toLocaleString() + (this.sourceStats ? ' of ' + this.sourceStats.total.toLocaleString() : '') + ' citizen observations';
      const video = this.video.enabled ? (this.video.loading ? 'Video results loading…' : this.video.error ? 'Video results unavailable' : this.video.truncated ? 'Video: narrow this view' :
        this.video.features.length.toLocaleString() + ' distressed video segments') : 'Video layer off';
      if (this.counts) this.counts.textContent = citizen + (this.video.enabled ? ' (hidden in drive mode)' : '') + ' · ' + video;
      setStatus(this.video.enabled ? video : citizen, this.video.enabled ? (this.video.error ? 'error' : 'live') : this.citizenMatched == null ? 'error' : 'live');
    }
    renderLocations() {
      if (!this.locations) return;
      this.locations.replaceChildren();
      const unavailable = this.video.enabled ? 'Switch to Map to explore citizen observations.' : !this.filters.citizen ? 'Citizen layer is off.' : this.citizenLoading ? 'Updating locations…'
        : this.citizenMatched == null ? 'Locations unavailable. Waiting for survey data.'
          : this.truncated ? 'Too many locations. Narrow the dates or filters.' : '';
      if (unavailable) { this.locations.append(node('p', unavailable, 'survey-help')); return; }
      const groups = new Map();
      for (const feature of this.features) {
        const position = point(feature);
        if (!position) continue;
        const name = feature.properties.address || position.map(value => value.toFixed(4)).join(', ');
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(feature);
      }
      for (const [name, features] of [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
        this.action(name + ' · ' + features.length, () => {
          this.showEvidence(features[0], features);
        }, this.locations);
      }
      if (!groups.size) this.locations.append(node('p', 'No matching locations in this view.', 'survey-help'));
    }

    renderDrives(sort) {
      this.driveList.replaceChildren();
      if (this.directCitizen) {
        this.driveList.append(node('p', 'Drive routes are not connected to this citizen database.', 'survey-help')); return;
      }
      if (!this.sessionsReady) return;
      if (!this.sessions.length) {
        this.driveList.append(node('p', 'No recorded drives are available.', 'survey-help'));
        return;
      }
      const sessions = this.sessions.slice().sort((a, b) => sort === 'start_utc'
        ? String(b.start_utc).localeCompare(String(a.start_utc)) : (b[sort] || 0) - (a[sort] || 0));
      for (const session of sessions) {
        const card = node('article', null, 'survey-drive');
        const status = ['stored', 'cleaned'].includes(session.state) ? 'Complete' : session.state === 'failed' ? 'Failed' : 'Processing';
        card.append(node('strong', session.road_name || session.road_id || 'Drive'));
        card.append(node('p', (session.local_date || 'Date unavailable') + ' · ' + status));
        const metres = finite(session.route_m) ? (session.route_m / 1000).toFixed(2) + ' km recorded' : 'Distance unavailable';
        const distress = finite(session.distress_m) ? session.distress_m.toFixed(1) + ' m distressed' : 'Distress unavailable';
        const pct = finite(session.pct_distress_of_surveyed) ? ' · ' + session.pct_distress_of_surveyed.toFixed(1) + '% of surveyed length' : '';
        card.append(node('p', metres + ' · ' + distress + pct));
        this.action('Select and focus', () => {
          this.driveInput.value = session.session_id;
          this.apply(); this.focusDrive(session.session_id);
        }, card);
        this.action('Replay drive', () => window.geoaiDrivePlayer?.open(session.session_id), card);
        this.driveList.append(card);
      }
    }
    focusDrive(id = this.filters.session) {
      const session = this.sessions.find(value => value.session_id === id);
      const b = session?.bbox;
      if (!b || b.length !== 4 || !G.coordinate([b[0], b[1]]) || !G.coordinate([b[2], b[3]]) || b[0] > b[2] || b[1] > b[3]) {
        this.notice.textContent = 'Choose a drive with a known map extent first.'; return;
      }
      this.video.setEnabled(true);
      this.video.selectVideo();
      map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [60, 110], maxZoom: 17 });
    }

    clearEvidenceState() {
      if (this.evidence) delete this.evidence.dataset.layer;
      this.evidence = null;
      this.selectedEvidence = null;
      document.body.classList.remove('gis-cards-open');
      if (this.uncertainty) map.removeLayer(this.uncertainty);
      this.uncertainty = null;
    }
    closeEvidence() {
      if (this.evidence) hideCards();
      this.clearEvidenceState();
    }
    cardRow(feature) {
      const p = feature.properties || {}, location = point(feature);
      const captured = p.data_source === 'supabase' ? p.captured_at : p.local_time || p.utc || p.created_at;
      const labels = Array.isArray(p.final_labels) ? p.final_labels.filter(value => typeof value === 'string') : [];
      const previewURL = p.has_image === false ? null : G.safeURL(p.preview_url || p.thumb_url, this.client.apiBase, document.baseURI);
      const thumbnailURL = p.has_image === false ? null : G.safeURL(p.thumb_url, this.client.apiBase, document.baseURI) || previewURL;
      const fullURL = p.has_image === false ? null : G.safeURL(p.image_url, this.client.apiBase, document.baseURI);
      const extraRows = [];
      const field = (name, value) => { if (value != null && value !== '') extraRows.push([name, String(value)]); };
      field('Accuracy', finite(p.position_sigma_m) ? '±' + p.position_sigma_m + ' m (1σ)' : 'Approximate phone position');
      field('Source', p.layer === 'video' || p.segment_id ? 'Drive video' : 'Citizen observation');
      if (p.data_source === 'supabase') {
        field('Assessment', p.assessment_status);
        field('Uploaded', date(p.created_at));
        if (p.capture_time_source === 'upload_proxy') field('Capture time', 'Upload time used; this older record has no capture-time field');
      }
      if (p.segment_id) {
        field('Road', p.road_name || p.road_id); field('Drive', p.session_id);
        field('Distance from start', finite(p.s0_m) ? p.s0_m.toFixed(1) + ' m' : null);
        field('Gate status', p.status);
        field('Detector would have', p.gate_mode === 'all' ? p.gate_decision_if_gated : null);
        field('Frame quality', p.quality_reason);
        field('Sharpness', finite(p.quality_sharpness) ? p.quality_sharpness.toFixed(4) : null);
      }
      if (finite(p.camera?.alt_msl_m)) field('Altitude MSL', p.camera.alt_msl_m + ' m');
      return {
        ...p, id: p.segment_id || p.id || feature.id,
        latitude: location?.[0] ?? null, longitude: location?.[1] ?? null,
        distress_types: labels, severity: p.final_severity || 'Unknown',
        description: p.description || (p.segment_id && p.status === 'not_covered' ? 'No usable frame · not covered' : p.segment_id && p.status === 'skip' ? 'Not sent for classification' : p.vlm_class === 'pending' || p.status === 'pending' || (p.segment_id && p.answered === false) ? 'Awaiting classification' : ''),
        address: p.address || p.road_name || p.road_id || '',
        created_at: captured,
        image_url: previewURL || '', status: p.assessment_status || p.status,
        __gis: { feature, labelColors: Object.fromEntries(this.meta.labels.map(label => [label.name, label.color])),
          previewURL, thumbnailURL, fullURL, capturedText: date(captured),
          reviewText: review(p), extraRows, originalLabels: Array.isArray(p.labels) ? p.labels : [],
          confidenceThreshold: this.meta.confidence_threshold },
      };
    }
    showEvidence(feature, group = [feature]) {
      const isVideo = feature.properties?.layer === 'video' || Boolean(feature.properties?.segment_id);
      if (!isVideo && (this.video.enabled || this.filters.citizen === false)) return;
      // Selected-drive photos stay in the persistent drive card. Other layers
      // retain their existing evidence cards.
      if (window.geoaiDriveInspector?.inspectFeature?.(feature)) {
        this.closeEvidence(); closeFilterStack(); closeAboutStack();
        return;
      }
      if (this.evidence && this.selectedEvidence) {
        const selected = this.selectedEvidence, a = selected.properties || {}, b = feature.properties || {};
        const selectedVideo = a.layer === 'video' || Boolean(a.segment_id);
        const nextVideo = b.layer === 'video' || Boolean(b.segment_id);
        const selectedId = a.segment_id || a.id || selected.id;
        const nextId = b.segment_id || b.id || feature.id;
        if (selectedVideo === nextVideo && (nextVideo
          ? selectedId != null && selectedId === nextId
          : isSameLocation(point(selected), point(feature)))) return;
      }
      document.dispatchEvent(new CustomEvent('geoai:evidenceopen', { detail: { feature } }));
      this.closeEvidence();
      closeFilterStack(); closeAboutStack();
      // Reuse the repository's anchored previews, expanded cards and grouped list.
      const ordered = [feature, ...group.filter(item => item !== feature)];
      const rows = ordered.map(item => this.cardRow(item));
      const location = point(feature);
      showCards(rows, { anchor: location });
    }
    trackEvidence(feature, anchor) {
      this.clearEvidenceState();
      this.evidence = document.getElementById('cardStack');
      this.selectedEvidence = feature;
      this.evidence.dataset.layer = feature.properties?.segment_id || feature.properties?.layer === 'video' ? 'video' : 'citizen';
      document.body.classList.add('gis-cards-open');
      const p = feature.properties || {};
      const location = anchor || point(feature);
      if (location && finite(p.position_sigma_m) && p.position_sigma_m > 0) {
        this.uncertainty = L.circle(location, { renderer: this.renderer, radius: p.position_sigma_m, color: this.style(feature).fillColor,
          weight: 1, dashArray: '3 3', fillOpacity: .06, interactive: false }).addTo(map);
      }
    }

    buildSettings() {
      if (document.getElementById('shareView')) return;
      const settings = document.getElementById('settingsPanel');
      this.shareButton = this.action('Copy view link', () => this.share(), settings); this.shareButton.id = 'shareView';
      this.shareStatus = node('p', '', 'survey-help'); this.shareStatus.setAttribute('role', 'status'); settings.append(this.shareStatus);
    }
    buildLegend() {
      document.getElementById('surveyLegend')?.remove();
      this.legend = node('details', null, 'survey-section'); this.legend.id = 'surveyLegend';
      this.legend.append(node('summary', 'Map legend'));
      this.legend.append(node('p', 'Circles: citizen observations. Camera badges: distressed video segments; click one for its photo and details. Filled road footprints appear at street zoom. Thin lines: recorded drives. During replay, bright badges have been reached and faded badges are ahead. Unmarked road does not mean Normal.', 'survey-help'));
      for (const label of this.meta.labels) {
        const row = node('div', null, 'survey-legend-row');
        const swatch = node('span'); swatch.style.background = label.color;
        row.append(swatch, node('span', label.name)); this.legend.append(row);
      }
      this.legend.append(node('p', 'Citizen marker radii: ' + this.meta.severities.map(value => value.name + ' ' + value.radius_px + ' px').join(' · ') + '. Camera badge sizes follow severity, scaled for visibility inside a larger click target.', 'survey-help'));
      document.querySelector('#aboutStack .about-card')?.append(this.legend);
    }
    async share() {
      let shareURL;
      try {
        const center = map.getCenter();
        const params = G.serializeView({ filters: this.filters, video: this.video.enabled, style: currentStyle,
          lat: center.lat, lng: center.lng, zoom: map.getZoom() }, this.meta);
        const base = window.GIS_CONFIG?.shareBaseUrl || location.href;
        if (new URL(base).hostname === 'appassets.androidplatform.net') throw new Error('Configure your public dashboard address before sharing.');
        const url = new URL(base); url.search = params.toString(); url.hash = '';
        shareURL = url.href;
        if (url.origin === location.origin) history.replaceState(null, '', url.href);
        this.shareStatus.replaceChildren();
        const event = new CustomEvent('geoai:share', { cancelable: true, detail: { url: url.href, title: 'GEOAI map view' } });
        if (!document.dispatchEvent(event)) { this.shareStatus.textContent = 'View ready to share.'; return; }
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url.href);
        else {
          const input = node('textarea'); input.value = url.href; input.setAttribute('readonly', '');
          document.body.append(input); input.select();
          const copied = document.execCommand('copy'); input.remove();
          if (!copied) throw new Error('Copy unavailable. Use the link below.');
        }
        this.shareStatus.textContent = 'View link copied.';
      } catch (error) {
        this.shareStatus.textContent = shareURL ? 'Select and copy this view link:' : error.message || 'Unable to copy this view.';
        if (shareURL) {
          const input = node('textarea'); input.value = shareURL; input.readOnly = true;
          input.setAttribute('aria-label', 'Shareable view link'); this.shareStatus.append(input); input.focus(); input.select();
        }
      }
    }
    async export(layer) {
      if (this.exporting) return;
      if (layer === 'video' && !this.video.enabled) { this.notice.textContent = 'Enable Video before exporting its visible results.'; return; }
      if (layer === 'citizen' && !this.filters.citizen) { this.notice.textContent = 'Enable citizen observations before exporting.'; return; }
      this.exporting = true; this.notice.textContent = 'Preparing complete filtered export…';
      const snapshot = JSON.stringify(this.filters), bbox = this.bbox();
      try {
        let result;
        if (layer === 'video') result = await this.client.exportVideo(this.filters, this.meta, { bbox });
        else {
          const rows = await this.client.features('citizen', this.filters, this.meta, { bbox, max: 20000 });
          if (rows.truncated) throw new Error('Too many results. Narrow the dates or map area before exporting.');
          result = { content: G.csv(rows.features.filter(feature => G.matches(feature, this.filters, this.meta, 'citizen'))),
            filename: 'geoai-citizen.csv', mime: 'text/csv;charset=utf-8' };
        }
        if (snapshot !== JSON.stringify(this.filters) || bbox !== this.bbox() || (layer === 'video' && !this.video.enabled) ||
            (layer === 'citizen' && !this.filters.citizen)) throw new Error('The view changed. Export again for the current filters.');
        const event = new CustomEvent('geoai:export', { cancelable: true, detail: result });
        if (document.dispatchEvent(event)) {
          const url = URL.createObjectURL(new Blob([result.content], { type: result.mime }));
          const link = node('a'); link.href = url; link.download = result.filename;
          document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
        this.notice.textContent = 'Filtered CSV ready.';
      } catch (error) { this.notice.textContent = error.message || 'Export failed. Please retry.'; }
      finally { this.exporting = false; }
    }
  }
  window.GeoAISurvey = Survey;
  window.geoaiSurvey = new Survey();
}());
