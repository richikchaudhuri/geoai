/* Drive picker and whole-drive inspection. The map keeps its own viewport counts. */
(function () {
  'use strict';
  const G = window.GeoAIGIS;
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const complete = new Set(['stored', 'cleaned']);
  const coord = p => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  const color = s => /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(s || '') ? s : '#64748b';
  const km = n => finite(n) && n >= 0 ? (n / 1000).toFixed(2) + ' km' : 'Unavailable';
  const status = s => complete.has(s?.state) ? 'Complete' : s?.state === 'failed' ? 'Failed' : 'Processing';
  const name = s => s?.road_name || s?.road_id || 'Unnamed drive';
  function routeLines(session) {
    const g = session?.track;
    const lines = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
    return Array.isArray(lines) ? lines.filter(line => Array.isArray(line) && line.length >= 2 && line.every(coord)) : [];
  }
  class GeoAIDriveInspector {
    constructor({ video, map, L }) {
      Object.assign(this, { video, map, L });
      this.document = video.button?.ownerDocument || document;
      this.window = this.document.defaultView || window;
      this.mount = this.document.getElementById('videoDrivePicker');
      this.client = new G.Client({ apiBase: video.apiBase || '', fetch: video.fetch, baseURI: this.document.baseURI });
      this.generation = 0; this.features = null; this.sessionId = ''; this.pageSize = 12;
      this.buildPicker(); this.buildPanel();
      this.changed = () => this.update();
      this.outside = event => { if (!this.mount?.contains(event.target)) this.closePicker(false); };
      this.document.addEventListener('geoai:videochange', this.changed);
      this.document.addEventListener('pointerdown', this.outside);
      this.update();
    }
    node(tag, text, className) {
      const el = this.document.createElement(tag);
      if (text != null) el.textContent = text;
      if (className) el.className = className;
      return el;
    }
    button(text, action, className) {
      const el = this.node('button', text, className); el.type = 'button'; el.addEventListener('click', action); return el;
    }
    buildPicker() {
      if (!this.mount) return;
      this.trigger = this.button('', () => this.listbox.hidden ? this.openPicker() : this.closePicker(true), 'drive-picker-trigger');
      this.trigger.id = 'videoDriveTrigger'; this.trigger.setAttribute('aria-haspopup', 'listbox');
      this.trigger.setAttribute('aria-expanded', 'false'); this.trigger.setAttribute('aria-controls', 'videoDriveOptions');
      this.triggerName = this.node('strong', 'Loading drives…');
      this.triggerMeta = this.node('span', 'Recorded surveys', 'drive-picker-caption');
      const text = this.node('span', null, 'drive-picker-value'); text.append(this.triggerName, this.triggerMeta);
      const icon = this.node('span', '⌄', 'drive-picker-chevron'); icon.setAttribute('aria-hidden', 'true');
      this.trigger.append(text, icon);
      this.listbox = this.node('div', null, 'drive-picker-options'); this.listbox.id = 'videoDriveOptions';
      this.listbox.hidden = true; this.listbox.setAttribute('role', 'listbox'); this.listbox.setAttribute('aria-label', 'Recorded drives');
      this.mount.append(this.trigger, this.listbox);
      this.trigger.addEventListener('keydown', event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); this.openPicker(event.key === 'ArrowUp' || event.key === 'End' ? 'last' : event.key === 'Home' ? 'first' : undefined);
        } else if (event.key === 'Escape' && !this.listbox.hidden) { event.preventDefault(); event.stopPropagation(); this.closePicker(true); }
      });
      this.listbox.addEventListener('keydown', event => {
        const options = [...this.listbox.querySelectorAll('[role=option]')], index = options.indexOf(this.document.activeElement);
        let next;
        if (event.key === 'ArrowDown') next = (index + 1) % options.length;
        if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = options.length - 1;
        if (next !== undefined && options[next]) {
          event.preventDefault(); event.stopPropagation(); options[next].focus(); options[next].scrollIntoView?.({ block: 'nearest' });
        } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closePicker(true); }
        else if (['Enter', ' ', 'Spacebar'].includes(event.key) && options[index]) { event.preventDefault(); event.stopPropagation(); options[index].click(); }
        else if (event.key === 'Tab') this.closePicker(false);
      });
      this.mount.addEventListener('focusout', event => { if (event.relatedTarget && !this.mount.contains(event.relatedTarget)) this.closePicker(false); });
      this.L?.DomEvent?.disableClickPropagation(this.mount); this.L?.DomEvent?.disableScrollPropagation(this.mount);
    }
    openPicker(edge) {
      if (!this.trigger || this.trigger.disabled) return;
      this.listbox.hidden = false; this.trigger.setAttribute('aria-expanded', 'true');
      const options = [...this.listbox.querySelectorAll('[role=option]')];
      const target = edge === 'first' ? options[0] : edge === 'last' ? options.at(-1) : options.find(el => el.getAttribute('aria-selected') === 'true') || options[0];
      target?.focus(); target?.scrollIntoView?.({ block: 'nearest' });
    }
    closePicker(restoreFocus = false) {
      if (!this.listbox) return;
      const wasOpen = !this.listbox.hidden;
      this.listbox.hidden = true; this.trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus && wasOpen) this.trigger.focus();
    }
    buildPanel() {
      this.panel = this.node('section', null, 'drive-inspector'); this.panel.id = 'driveInspector'; this.panel.hidden = true;
      this.panel.setAttribute('aria-labelledby', 'driveInspectorTitle');
      const header = this.node('div', null, 'drive-inspector-header');
      const heading = this.node('div'); heading.append(this.node('span', 'SELECTED DRIVE', 'drive-inspector-eyebrow'));
      this.title = this.node('h2'); this.title.id = 'driveInspectorTitle'; heading.append(this.title);
      const close = this.button('×', () => this.video.selectDrive(''), 'drive-inspector-close'); close.setAttribute('aria-label', 'Close drive details and show all drives');
      header.append(heading, close);
      this.subtitle = this.node('p', '', 'drive-inspector-subtitle');
      this.route = this.node('div', null, 'drive-inspector-route');
      this.stats = this.node('div', null, 'drive-inspector-stats');
      const actions = this.node('div', null, 'drive-inspector-actions');
      this.focusButton = this.button('Focus route', () => this.video.focusRoutes(this.sessionId));
      this.replayButton = this.button('Replay drive', () => this.window.geoaiDrivePlayer?.open(this.sessionId));
      this.replayButton.id = 'driveInspectorReplay';
      actions.append(this.focusButton, this.replayButton);
      this.replayHost = this.node('div', null, 'drive-inspector-replay'); this.replayHost.id = 'driveReplayHost';
      const player = this.document.getElementById('driveReplayPanel');
      if (player) { player.classList.add('drive-replay-embedded'); this.replayHost.append(player); }
      this.buildInlinePhoto();
      const results = this.node('div', null, 'drive-inspector-results');
      const resultsHeader = this.node('div', null, 'drive-inspector-results-header');
      resultsHeader.append(this.node('h3', 'Distress along this drive'));
      this.count = this.node('span', '', 'drive-inspector-count'); resultsHeader.append(this.count);
      this.message = this.node('p', '', 'drive-inspector-message'); this.message.id = 'driveInspectorStatus'; this.message.setAttribute('role', 'status');
      this.retry = this.button('Try again', () => this.load(), 'drive-inspector-retry'); this.retry.id = 'driveInspectorRetry'; this.retry.hidden = true;
      this.labels = this.node('div', null, 'drive-inspector-labels');
      this.labelsNote = this.node('p', 'A segment can have more than one distress type.', 'drive-inspector-note'); this.labelsNote.hidden = true;
      this.observations = this.node('div', null, 'drive-inspector-observations'); this.observations.id = 'driveInspectorObservations';
      this.more = this.button('Show more', () => { this.visibleCount += this.pageSize; this.renderObservations(); }, 'drive-inspector-more'); this.more.id = 'driveInspectorMore'; this.more.hidden = true;
      results.append(resultsHeader, this.message, this.retry, this.labels, this.labelsNote, this.observations, this.more);
      this.panel.append(header, this.subtitle, this.route, this.stats, actions, this.replayHost, this.inlinePhoto, results);
      (this.document.querySelector('main') || this.document.body).append(this.panel);
      this.L?.DomEvent?.disableClickPropagation(this.panel); this.L?.DomEvent?.disableScrollPropagation(this.panel);
    }
    buildInlinePhoto() {
      this.inlinePhoto = this.node('section', null, 'drive-inspector-photo'); this.inlinePhoto.id = 'driveInspectorPhoto'; this.inlinePhoto.hidden = true;
      this.inlinePhoto.setAttribute('aria-labelledby', 'driveInspectorPhotoTitle');
      const header = this.node('div', null, 'drive-inspector-photo-header');
      const title = this.node('h3', 'Selected photo'); title.id = 'driveInspectorPhotoTitle';
      this.inlineClose = this.button('×', () => this.clearInlinePhoto(), 'drive-inspector-close'); this.inlineClose.setAttribute('aria-label', 'Close selected photo');
      header.append(title, this.inlineClose);
      this.inlineContent = this.node('div', null, 'drive-inspector-photo-content');
      const navigation = this.node('div', null, 'drive-inspector-photo-navigation');
      this.inlinePrevious = this.button('←', () => this.stepInlinePhoto(-1)); this.inlinePrevious.setAttribute('aria-label', 'Previous drive observation');
      this.inlinePosition = this.node('span', '', 'drive-inspector-note');
      this.inlineNext = this.button('→', () => this.stepInlinePhoto(1)); this.inlineNext.setAttribute('aria-label', 'Next drive observation');
      navigation.append(this.inlinePrevious, this.inlinePosition, this.inlineNext);
      this.inlinePhoto.append(header, navigation, this.inlineContent);
    }
    inspectFeature(feature) {
      const p = feature?.properties;
      if (this.destroyed || !this.video.enabled || this.panel.hidden || !this.sessionId ||
        this.video.filters?.session !== this.sessionId || p?.session_id !== this.sessionId ||
        p.layer === 'citizen' || !(p.layer === 'video' || p.segment_id)) return false;
      const player = this.window.geoaiDrivePlayer;
      if (player?.inspectFeature?.(feature) === true) { this.clearInlinePhoto(); return true; }
      const render = this.window.geoaiRenderDriveEvidence;
      if (typeof render !== 'function') return false;
      player?.pause?.();
      let row;
      // Metadata can still be arriving when the user selects a map marker.
      // The shared renderer can use the feature itself until formatting is ready.
      try { row = this.window.geoaiSurvey?.cardRow?.(feature); } catch (_) { row = undefined; }
      const content = render(this.document, feature, { apiBase: this.video.apiBase || '', showImage: true, row });
      if (!content) return false;
      this.inlineFeature = feature; this.inlineContent.replaceChildren(content);
      this.inlinePhoto.hidden = false; this.panel.classList.add('drive-inspector-photo-open');
      this.updateInlineNavigation(); this.inlinePhoto.scrollIntoView?.({ block: 'start' });
      return true;
    }
    inlineFeatureIndex() {
      const id = this.inlineFeature?.properties?.segment_id || this.inlineFeature?.id;
      return id == null ? -1 : (this.features || []).findIndex(feature => (feature.properties?.segment_id || feature.id) === id);
    }
    updateInlineNavigation() {
      const index = this.inlineFeatureIndex(), total = this.features?.length || 0;
      this.inlinePrevious.disabled = index <= 0; this.inlineNext.disabled = index < 0 || index >= total - 1;
      this.inlinePosition.textContent = index >= 0 ? `${index + 1} of ${total} distress observations` : 'Selected frame';
    }
    stepInlinePhoto(delta) {
      const index = this.inlineFeatureIndex(), feature = index >= 0 ? this.features?.[index + delta] : null;
      if (feature) this.inspectFeature(feature);
    }
    clearInlinePhoto() {
      this.inlineFeature = null; this.inlinePhoto.hidden = true; this.inlineContent.replaceChildren();
      this.panel.classList.remove('drive-inspector-photo-open'); this.updateInlineNavigation();
    }
    syncPicker(sessions, selected) {
      if (!this.trigger) return;
      const ready = Array.isArray(this.video.catalog?.sessions);
      const signature = JSON.stringify([sessions, this.video.filters?.session || '', ready]);
      if (signature === this.pickerSignature) return;
      this.pickerSignature = signature;
      this.trigger.disabled = !ready || !sessions.length;
      this.triggerName.textContent = selected ? name(selected) : this.video.filters?.session ? 'Unavailable drive' : ready ? 'All drives' : 'Loading drives…';
      this.triggerMeta.textContent = selected ? `${selected.local_date || 'Date unavailable'} · ${km(selected.route_m)}` : `${sessions.length} recorded ${sessions.length === 1 ? 'drive' : 'drives'}`;
      this.trigger.setAttribute('aria-label', `Inspect a drive: ${this.triggerName.textContent}`);
      const values = [{ session_id: '', road_name: 'All drives', caption: `${sessions.length} drives · complete map overview` }, ...sessions];
      if (this.video.filters?.session && !selected) values.push({ session_id: this.video.filters.session, road_name: 'Unavailable drive', caption: 'No drive record is available' });
      this.listbox.replaceChildren();
      for (const s of values) {
        const option = this.button('', () => { this.closePicker(true); this.video.selectDrive(s.session_id); }, 'drive-picker-option');
        option.setAttribute('role', 'option'); option.tabIndex = -1; option.dataset.sessionId = s.session_id;
        option.setAttribute('aria-selected', String(s.session_id === (this.video.filters?.session || '')));
        const text = this.node('span', null, 'drive-picker-value');
        const line = this.node('span', null, 'drive-picker-option-title');
        line.append(this.node('strong', name(s)));
        if (s.session_id && !s.caption) line.append(this.node('span', km(s.route_m), 'drive-picker-distance'));
        text.append(line, this.node('span', s.caption || `${s.local_date || 'Date unavailable'} · ${status(s)}${routeLines(s).length ? '' : ' · No route yet'}`, 'drive-picker-caption'));
        const check = this.node('span', s.session_id === (this.video.filters?.session || '') ? '✓' : '', 'drive-picker-check'); check.setAttribute('aria-hidden', 'true');
        option.append(text, check); this.listbox.append(option);
      }
    }
    update() {
      if (this.destroyed) return;
      const sessions = [...new Map((this.video.catalog?.sessions || []).filter(s => s?.session_id).map(s => [s.session_id, s])).values()];
      const id = this.video.filters?.session || '', selected = sessions.find(s => s.session_id === id);
      this.syncPicker(sessions, selected);
      const visible = this.video.enabled && !!id;
      this.panel.hidden = !visible;
      this.document.body.classList.toggle('drive-inspector-open', visible);
      if (!visible) {
        this.clearInlinePhoto();
        this.closePicker(false); this.controller?.abort(); this.generation++; this.requestKey = null; this.panel.removeAttribute('aria-busy');
        if (this.sessionId || this.features) { this.sessionId = ''; this.features = null; this.publish(); }
        return;
      }
      const meta = this.video.meta || this.video.catalog?.meta;
      const key = JSON.stringify([id, this.video.filters, selected, meta]);
      if (key === this.requestKey) return;
      if (id !== this.sessionId) this.panel.scrollTop = 0;
      this.requestKey = key; this.sessionId = id; this.session = selected; this.meta = meta;
      this.renderSession();
      if (!selected || !meta) {
        this.clearInlinePhoto();
        this.controller?.abort(); this.generation++; this.features = null; this.clearResults(); this.panel.removeAttribute('aria-busy');
        this.message.textContent = !selected ? 'This drive is unavailable. Choose another drive from the menu.' : 'Loading survey metadata…'; this.publish(); return;
      }
      this.load();
    }
    renderSession() {
      const s = this.session;
      this.title.textContent = s ? name(s) : 'Unavailable drive';
      this.subtitle.textContent = s ? `${s.local_date || 'Date unavailable'} · ${status(s)}` : this.sessionId;
      this.stats.replaceChildren();
      for (const [label, value] of [['Recorded', km(s?.route_m)], ['Distressed', finite(s?.distress_m) ? s.distress_m.toFixed(1) + ' m' : 'Unavailable']]) {
        const cell = this.node('div'); cell.append(this.node('strong', value), this.node('span', label)); this.stats.append(cell);
      }
      const lines = routeLines(s);
      this.focusButton.disabled = !lines.length;
      this.replayButton.disabled = !lines.length || !finite(s?.route_m) || s.route_m <= 0;
      this.renderRoute(lines);
    }
    renderRoute(lines) {
      this.route.replaceChildren();
      if (!lines.length) { this.route.append(this.node('p', 'No recorded route available.', 'drive-inspector-note')); return; }
      // Unwrap longitude so a track crossing the dateline retains a short local span.
      let anchor = lines[0][0][0];
      const unwrapped = lines.map(line => line.map(p => { anchor += ((p[0] - anchor + 540) % 360) - 180; return [anchor, p[1]]; }));
      const points = unwrapped.flat(), meanLat = points.reduce((sum,p) => sum + p[1], 0) / points.length;
      const xFactor = Math.max(.01, Math.cos(meanLat * Math.PI / 180));
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of points) { minX = Math.min(minX, p[0] * xFactor); maxX = Math.max(maxX, p[0] * xFactor); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
      const scale = Math.min(268 / Math.max(maxX - minX, .000001), 94 / Math.max(maxY - minY, .000001));
      const project = p => [160 + (p[0] * xFactor - (minX + maxX) / 2) * scale, 62 - (p[1] - (minY + maxY) / 2) * scale];
      const svg = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 320 124'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Recorded drive route; gaps between track parts are preserved');
      for (const line of unwrapped) {
        const path = this.document.createElementNS(svg.namespaceURI, 'polyline');
        path.setAttribute('points', line.map(p => project(p).join(',')).join(' ')); path.setAttribute('class', 'drive-inspector-route-line'); svg.append(path);
      }
      for (const [point, cls] of [[points[0], 'start'], [points.at(-1), 'end']]) {
        const dot = this.document.createElementNS(svg.namespaceURI, 'circle'), [x, y] = project(point);
        dot.setAttribute('cx', String(x)); dot.setAttribute('cy', String(y)); dot.setAttribute('r', '4'); dot.setAttribute('class', 'drive-inspector-route-' + cls); svg.append(dot);
      }
      const caption = this.node('div', null, 'drive-inspector-route-caption'); caption.append(this.node('span', 'Recorded route'), this.node('span', '● Start  ○ End'));
      this.route.append(svg, caption);
    }
    clearResults() {
      this.count.textContent = ''; this.labels.replaceChildren(); this.observations.replaceChildren(); this.labelsNote.hidden = true; this.retry.hidden = true; this.more.hidden = true;
    }
    publish(completeResult = false) {
      this.document.dispatchEvent(new this.window.CustomEvent('geoai:driveinspectionchange', { detail: { sessionId: this.sessionId, features: this.features, complete: completeResult } }));
    }
    async load() {
      if (!this.session || !this.meta || !this.video.enabled || this.destroyed) return;
      this.clearInlinePhoto();
      this.controller?.abort(); this.controller = new this.window.AbortController();
      const signal = this.controller.signal, generation = ++this.generation, id = this.sessionId;
      this.features = null; this.clearResults(); this.message.textContent = 'Loading distress across the whole drive…'; this.publish();
      this.panel.setAttribute('aria-busy', 'true');
      const current = () => !this.destroyed && !signal.aborted && generation === this.generation && this.video.enabled && id === this.video.filters?.session;
      try {
        const result = await this.client.features('video', { ...this.video.filters, session: id }, this.meta, { geom: 'point', signal, max: 5000 });
        if (!current()) return;
        if (result.truncated) { this.message.textContent = 'More than 5,000 matching segments. Narrow the filters to inspect this drive.'; this.publish(); return; }
        this.features = result.features.filter(f => f?.properties?.session_id === id && f.properties.vlm_class === 'distress')
          .sort((a,b) => (a.properties.s0_m ?? Infinity) - (b.properties.s0_m ?? Infinity));
        this.visibleCount = this.pageSize;
        this.message.textContent = this.features.length ? 'Whole drive · current filters. Select a result for its photo and details.' : 'No distress matches the current filters for this drive.';
        this.count.textContent = String(this.features.length);
        this.renderLabels(); this.renderObservations(); this.updateInlineNavigation(); this.publish(true);
      } catch (error) {
        if (!current()) return;
        this.message.textContent = 'Could not load this drive’s distress results. Its recorded route is still available.';
        this.retry.hidden = false; this.publish();
      } finally { if (generation === this.generation) this.panel.removeAttribute('aria-busy'); }
    }
    renderLabels() {
      this.labels.replaceChildren();
      const counts = new Map(), metadata = new Map((this.meta?.labels || []).map(l => [l.name, l]));
      for (const feature of this.features || []) {
        const labels = feature.properties.final_labels;
        for (const label of new Set((Array.isArray(labels) ? labels : []).filter(v => typeof v === 'string'))) counts.set(label, (counts.get(label) || 0) + 1);
      }
      for (const [label, count] of [...counts].sort((a,b) => b[1] - a[1])) {
        const chip = this.node('span', null, 'drive-inspector-label');
        const dot = this.node('i'); dot.style.backgroundColor = color(metadata.get(label)?.color); dot.setAttribute('aria-hidden', 'true');
        chip.append(dot, this.node('span', label), this.node('strong', String(count))); this.labels.append(chip);
      }
      this.labelsNote.hidden = !counts.size;
    }
    renderObservations() {
      this.observations.replaceChildren();
      for (const feature of (this.features || []).slice(0, this.visibleCount)) {
        const p = feature.properties || {}, names = Array.isArray(p.final_labels) ? p.final_labels.filter(s => typeof s === 'string') : [];
        const row = this.button('', () => this.window.geoaiSurvey?.showEvidence(feature, [feature]), 'drive-inspector-observation');
        const top = this.node('span', null, 'drive-inspector-observation-top');
        top.append(this.node('strong', finite(p.s0_m) ? `${Math.round(p.s0_m)} m along route` : 'Position unavailable'), this.node('span', p.final_severity || 'Unknown', 'drive-inspector-severity'));
        row.append(top, this.node('span', names.join(' · ') || 'Distress', 'drive-inspector-observation-labels'));
        row.setAttribute('aria-label', `${finite(p.s0_m) ? Math.round(p.s0_m) + ' metres' : 'Position unavailable'} · ${names.join(', ') || 'Distress'} · ${p.final_severity || 'Unknown'} severity · Open photo and details`);
        this.observations.append(row);
      }
      this.more.hidden = !this.features || this.visibleCount >= this.features.length;
      if (!this.more.hidden) this.more.textContent = `Show more (${this.features.length - this.visibleCount} remaining)`;
    }
    destroy() {
      this.destroyed = true; this.controller?.abort(); this.generation++;
      this.clearInlinePhoto();
      this.document.removeEventListener('geoai:videochange', this.changed); this.document.removeEventListener('pointerdown', this.outside);
      this.features = null; this.sessionId = ''; this.publish();
      this.document.body.classList.remove('drive-inspector-open'); this.mount?.replaceChildren(); this.panel.remove();
    }
  }
  window.GeoAIDriveInspector = GeoAIDriveInspector;
  if (G && window.geoaiVideoPaths && typeof map !== 'undefined' && window.L)
    window.geoaiDriveInspector = new GeoAIDriveInspector({ video: window.geoaiVideoPaths, map, L: window.L });
})();
