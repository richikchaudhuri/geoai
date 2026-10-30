/* On-demand route replay. Distances follow the recorded track; this is not video footage. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root?.document) {
    root.GeoAIDrivePlayer = api.GeoAIDrivePlayer;
    root.geoaiRenderDriveEvidence = api.renderDriveEvidence;
    if (root.geoaiVideoPaths && root.geoaiSurvey && typeof map !== 'undefined' && root.L)
      root.geoaiDrivePlayer = new api.GeoAIDrivePlayer({ map, L: root.L, video: root.geoaiVideoPaths, survey: root.geoaiSurvey });
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const radians = degrees => degrees * Math.PI / 180;
  const degrees = angle => angle * 180 / Math.PI;
  const longitude = n => ((n + 180) % 360 + 360) % 360 - 180;
  const coordinate = p => Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  function renderDriveEvidence(document, feature, { apiBase = '', showImage = false, row } = {}) {
    const p = feature?.properties || {}, detail = row?.__gis || {};
    const node = (tag, text, className) => {
      const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el;
    };
    const safe = value => document.defaultView?.GeoAIGIS?.safeURL(value, apiBase, document.baseURI);
    const host = node('div', null, 'drive-inline-details');
    host.classList.toggle('has-photo', showImage);
    if (showImage) {
      const photo = node('div', null, 'drive-inline-photo');
      const url = p.has_image === false ? null : safe(detail.previewURL || p.preview_url || p.thumb_url);
      if (url) {
        const image = node('img'); image.alt = 'Selected drive frame'; image.src = url;
        image.addEventListener('error', () => photo.replaceChildren(node('span', 'Image unavailable')), { once: true }); photo.append(image);
      } else photo.append(node('span', p.has_image === false ? 'No captured image' : 'Image unavailable'));
      host.append(photo);
    }
    const body = node('div', null, 'drive-inline-body');
    const assessment = node('div', null, 'drive-inline-assessment');
    const severity = ['Low', 'Medium', 'High', 'None'].includes(p.final_severity) ? p.final_severity.toLowerCase() : 'unknown';
    const pill = node('span', p.final_severity || 'Unclassified', `drive-inline-severity severity-${severity}`);
    pill.setAttribute('aria-label', `Severity: ${p.final_severity || 'Unclassified'}`);
    assessment.append(pill, node('span', finite(p.confidence) ? `${Math.round(p.confidence * 100)}% confidence` : 'Confidence not supplied', 'drive-inline-confidence'));
    body.append(assessment);
    const labels = Array.isArray(p.final_labels) ? p.final_labels.filter(s => typeof s === 'string') : [];
    const chips = node('div', null, 'drive-inline-labels');
    for (const label of labels.length ? labels : [p.vlm_class || p.status || 'Unclassified']) chips.append(node('span', label));
    body.append(chips);
    body.append(node('h3', p.address || p.road_name || row?.address || 'Captured road frame', 'drive-inline-title'));
    if (row?.description || p.description) body.append(node('p', row?.description || p.description, 'drive-inline-description'));
    body.append(node('h4', 'FRAME DETAILS', 'drive-inline-section-title'));
    const facts = node('dl', null, 'drive-inline-facts');
    const add = (label, value) => { if (value != null && value !== '') facts.append(node('dt', label), node('dd', String(value))); };
    add('Review', detail.reviewText || (p.expert_reviewed ? 'Expert reviewed' : p.needs_expert_review ? 'Awaiting expert review' : 'Model result · not expert reviewed'));
    add('Captured', detail.capturedText || p.local_time || p.utc);
    if (detail.extraRows?.length) for (const [label, value] of detail.extraRows) add(label, value);
    else {
      add('Distance', finite(p.s0_m) ? `${p.s0_m.toFixed(1)} m` : 'Unavailable');
      add('Frame quality', p.quality_reason); add('Gate status', p.status);
      add('Accuracy', finite(p.position_sigma_m) ? `±${p.position_sigma_m} m` : null);
    }
    if (Array.isArray(p.labels) && p.labels.join(',') !== labels.join(',')) add('Original labels', p.labels.join(' · '));
    body.append(facts);
    const full = p.has_image === false ? null : safe(detail.fullURL || p.image_url);
    if (full) { const link = node('a', 'Full-size photo ↗', 'drive-inline-full-photo'); link.href = full; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link); }
    host.append(body);
    return host;
  }
  function metres(a, b) {
    const dLat = radians(b[1] - a[1]), dLon = radians(longitude(b[0] - a[0]));
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a[1])) * Math.cos(radians(b[1])) * Math.sin(dLon / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(clamp(h, 0, 1)), Math.sqrt(1 - clamp(h, 0, 1)));
  }
  function heading(a, b) {
    const dLon = radians(longitude(b[0] - a[0])), lat1 = radians(a[1]), lat2 = radians(b[1]);
    return (degrees(Math.atan2(Math.sin(dLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon))) + 360) % 360;
  }
  function buildRoute(session) {
    const geometry = session?.track;
    const lines = geometry?.type === 'LineString' ? [geometry.coordinates] : geometry?.type === 'MultiLineString' ? geometry.coordinates : null;
    if (!Array.isArray(lines) || !lines.length || !finite(session.route_m) || session.route_m <= 0) throw new Error('This drive has no usable route distance.');
    const edges = [], parts = [], displayParts = [];
    let length = 0;
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2 || !line.every(coordinate)) throw new Error('This drive has no usable recorded track.');
      const part = [line[0].slice(0, 2)];
      for (let i = 1; i < line.length; i++) if (metres(part.at(-1), line[i]) > .001) part.push(line[i].slice(0, 2));
      if (part.length < 2) continue;
      const partIndex = parts.length;
      parts.push(part);
      let previousLongitude = displayParts.at(-1)?.at(-1)?.[0] ?? part[0][0];
      displayParts.push(part.map(point => {
        previousLongitude += longitude(point[0] - previousLongitude);
        return [previousLongitude, point[1]];
      }));
      for (let i = 1; i < part.length; i++) {
        const size = metres(part[i - 1], part[i]);
        edges.push({ a: part[i - 1], b: part[i], start: length, end: length + size, part: partIndex, vertex: i });
        length += size;
      }
    }
    if (!edges.length || !finite(length) || length <= 0) throw new Error('This drive has no usable recorded track.');
    const recordedDuration = (Date.parse(session.end_utc) - Date.parse(session.start_utc)) / 1000;
    return { edges, parts, displayParts, length, distance: session.route_m,
      duration: finite(recordedDuration) && recordedDuration > 0 ? Math.max(1, recordedDuration) : Math.max(1, session.route_m / (30 / 3.6)),
      recordedDuration: finite(recordedDuration) && recordedDuration > 0 };
  }
  function positionAt(route, distance) {
    const at = clamp(finite(distance) ? distance : 0, 0, route.distance), target = at / route.distance * route.length;
    let low = 0, high = route.edges.length - 1;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (route.edges[mid].end <= target) low = mid + 1; else high = mid; }
    const edge = route.edges[low], t = clamp((target - edge.start) / (edge.end - edge.start), 0, 1);
    const lon = route.displayParts[edge.part][edge.vertex - 1][0] + longitude(edge.b[0] - edge.a[0]) * t, lat = edge.a[1] + (edge.b[1] - edge.a[1]) * t;
    const visited = route.displayParts.slice(0, edge.part).map(part => part.map(point => [point[1], point[0]]));
    visited.push([...route.displayParts[edge.part].slice(0, edge.vertex).map(point => [point[1], point[0]]), [lat, lon]]);
    return { latlng: [lat, lon], heading: heading(edge.a, edge.b), part: edge.part, distance: at, visited };
  }
  const carSVG = '<svg viewBox="0 0 24 32" aria-hidden="true"><path d="M5 7 7 2h10l2 5v20l-2 3H7l-2-3Z" fill="currentColor"/><path d="m8 7 1-2h6l1 2 1 5H7Z" fill="var(--replay-car-window)"/><path d="M8 23h8v4H8Z" fill="var(--replay-car-window)"/><path d="M3 10h2v6H3zm16 0h2v6h-2zM3 21h2v5H3zm16 0h2v5h-2z" fill="currentColor"/></svg>';
  class GeoAIDrivePlayer {
    constructor({ map, L, video, survey }) {
      Object.assign(this, { map, L, video, survey });
      this.document = video.button?.ownerDocument || document;
      this.window = this.document.defaultView || window;
      this.generation = 0; this.distance = 0; this.speed = 1; this.isOpen = false; this.playing = false;
      this.layer = L.featureGroup();
      this.buildUI();
      this.videoChanged = () => { this.launcher.hidden = !video.enabled || this.isOpen; if (!video.enabled && this.isOpen) this.close(false); };
      this.filtersChanged = () => { if (this.isOpen) this.load(survey.filters.session || this.session?.session_id, { fit: false }); };
      this.evidenceOpened = () => this.pause();
      this.visibilityChanged = () => { if (this.document.hidden) this.pause(); };
      this.escape = event => { if (event.key === 'Escape' && !event.defaultPrevented && this.isOpen && !this.document.body.classList.contains('gis-cards-open')) this.close(); };
      this.dragged = () => { this.follow.checked = false; };
      this.document.addEventListener('geoai:videochange', this.videoChanged);
      this.document.addEventListener('geoai:filterschange', this.filtersChanged);
      this.document.addEventListener('geoai:evidenceopen', this.evidenceOpened);
      this.document.addEventListener('geoai:app-pause', this.evidenceOpened);
      this.document.addEventListener('visibilitychange', this.visibilityChanged);
      this.window.addEventListener('pagehide', this.evidenceOpened);
      this.document.addEventListener('keydown', this.escape);
      this.map.on('dragstart', this.dragged);
      this.videoChanged();
    }
    node(tag, text, className) {
      const value = this.document.createElement(tag);
      if (text != null) value.textContent = text;
      if (className) value.className = className;
      return value;
    }
    button(text, name, handler) {
      const button = this.node('button', text); button.type = 'button';
      if (name) button.setAttribute('aria-label', name);
      button.addEventListener('click', handler); return button;
    }
    buildUI() {
      this.launcher = this.document.getElementById('videoDriveReplay') || this.button('▶ Replay drive', 'Open drive route player', () => this.open());
      this.launcher.className = 'drive-replay-launcher'; this.launcher.hidden = true;
      this.launcher.setAttribute('aria-controls', 'driveReplayPanel'); this.launcher.setAttribute('aria-expanded', 'false');
      this.panel = this.node('section', null, 'drive-replay'); this.panel.id = 'driveReplayPanel'; this.panel.hidden = true;
      this.panel.setAttribute('aria-label', 'Drive route player');
      const header = this.node('div', null, 'drive-replay-header');
      const heading = this.node('div'); heading.append(this.node('strong', 'Route replay'), this.node('span', 'Approximate pace · recorded path', 'drive-replay-caption'));
      header.append(heading, this.button('×', 'Close route player', () => this.close()));
      this.select = this.node('select'); this.select.setAttribute('aria-label', 'Drive to replay');
      this.select.addEventListener('change', () => this.load(this.select.value));
      this.slider = this.node('input'); this.slider.type = 'range'; this.slider.min = '0'; this.slider.max = '1'; this.slider.step = '.1'; this.slider.value = '0';
      this.slider.setAttribute('aria-label', 'Distance along drive');
      this.slider.addEventListener('input', () => { this.pause(); this.seek(Number(this.slider.value)); });
      const timeline = this.node('div', null, 'drive-replay-timeline');
      this.progress = this.node('output', '0.00 / 0.00 km'); this.progress.setAttribute('aria-live', 'off');
      this.encountered = this.node('span', '', 'drive-replay-caption');
      timeline.append(this.progress, this.encountered);
      const controls = this.node('div', null, 'drive-replay-controls');
      this.playButton = this.button('▶ Play', 'Play route', () => this.playing ? this.pause() : this.play());
      this.playButton.className = 'drive-replay-play';
      this.restartButton = this.button('↺', 'Restart route', () => { this.pause(); this.seek(0); });
      this.speedInput = this.node('select'); this.speedInput.setAttribute('aria-label', 'Replay speed');
      for (const speed of [1, 4, 8, 16]) { const option = this.node('option', `${speed}×`); option.value = speed; this.speedInput.append(option); }
      this.speedInput.addEventListener('change', () => { const value = Number(this.speedInput.value); this.speed = [1, 4, 8, 16].includes(value) ? value : 1; });
      const followLabel = this.node('label', null, 'drive-replay-follow'); this.follow = this.node('input'); this.follow.type = 'checkbox';
      followLabel.append(this.follow, this.document.createTextNode('Follow'));
      controls.append(this.restartButton, this.playButton, this.speedInput, followLabel);
      this.message = this.node('p', '', 'drive-replay-message'); this.message.setAttribute('role', 'status');
      this.retryButton = this.button('Retry', 'Retry route loading', () => this.load(this.select.value)); this.retryButton.hidden = true;
      this.panel.append(header, this.select, this.slider, timeline, controls, this.message, this.retryButton);
      this.buildFrames();
      const host = this.document.querySelector('main') || this.document.body;
      if (!this.launcher.isConnected) host.append(this.launcher);
      host.append(this.panel);
      this.panel.addEventListener('click', event => event.stopPropagation());
      this.panel.addEventListener('wheel', event => event.stopPropagation(), { passive: true });
      this.L.DomEvent?.disableClickPropagation(this.panel);
      this.L.DomEvent?.disableScrollPropagation(this.panel);
      this.setReady(false);
    }
    buildFrames() {
      this.captureFrames = []; this.activeCaptureIndex = -1; this.visibleFrames = 12;
      this.frameSection = this.node('div', null, 'drive-replay-frames');
      const heading = this.node('div', null, 'drive-replay-frame-heading');
      heading.append(this.node('h3', 'Captured frames'));
      this.frameCount = this.node('span', '', 'drive-inspector-count'); heading.append(this.frameCount);
      this.frameStatus = this.node('p', '', 'drive-replay-caption'); this.frameStatus.setAttribute('role', 'status');
      this.frameRetry = this.button('Retry frames', 'Retry loading captured frames', () => this.loadFrames(this.session?.session_id, this.frameMeta, this.controller?.signal, this.generation));
      this.frameRetry.hidden = true;
      this.frameViewer = this.node('div', null, 'drive-replay-frame-viewer'); this.frameViewer.hidden = true;
      this.frameImage = this.button('', 'Show captured frame details', () => { this.pause(); this.setFrameDetails(true); });
      this.frameImage.className = 'drive-replay-frame-image';
      this.frameCaption = this.node('p', '', 'drive-replay-frame-caption');
      const navigation = this.node('div', null, 'drive-replay-frame-navigation');
      this.previousFrame = this.button('←', 'Previous captured frame', () => this.selectFrame(this.activeCaptureIndex - 1));
      this.frameDetails = this.button('Photo details', 'Open captured frame details', () => { this.pause(); this.setFrameDetails(!this.detailsExpanded); });
      this.frameDetails.setAttribute('aria-expanded', 'false'); this.frameDetails.setAttribute('aria-controls', 'driveFrameDetails');
      this.frameInfo = this.node('div'); this.frameInfo.id = 'driveFrameDetails'; this.frameInfo.hidden = true;
      this.previewPlayButton = this.button('▶ Play', 'Play from this frame', () => this.playing ? this.pause() : this.play());
      this.nextFrame = this.button('→', 'Next captured frame', () => this.selectFrame(this.activeCaptureIndex + 1));
      navigation.append(this.previousFrame, this.previewPlayButton, this.nextFrame);
      this.frameMedia = this.node('div', null, 'drive-replay-frame-media');
      this.frameMedia.append(this.frameImage, this.frameCaption, navigation, this.frameDetails);
      this.frameViewer.append(this.frameMedia, this.frameInfo);
      this.frameGrid = this.node('div', null, 'drive-replay-frame-grid');
      this.frameGrid.setAttribute('aria-label', 'All captured frames');
      this.frameMore = this.button('Show more frames', null, () => { this.visibleFrames += 12; this.renderFrameGrid(); }); this.frameMore.hidden = true;
      this.frameMore.className = 'drive-replay-frame-more';
      this.frameSection.append(heading, this.frameStatus, this.frameRetry, this.frameViewer, this.frameGrid, this.frameMore);
      this.panel.append(this.frameSection);
    }
    frameURL(feature, thumbnail = false) {
      const p = feature?.properties || {};
      if (p.has_image === false) return null;
      const safe = value => this.window.GeoAIGIS?.safeURL(value, this.survey.client.apiBase, this.document.baseURI);
      return thumbnail ? safe(p.thumb_url) || safe(p.preview_url) : safe(p.preview_url) || safe(p.thumb_url);
    }
    framePhoto(feature, thumbnail = false) {
      const box = this.node('span', null, 'drive-replay-photo');
      const url = this.frameURL(feature, thumbnail);
      const placeholder = () => box.replaceChildren(this.node('span', feature?.properties?.has_image === false ? 'No captured image' : 'Image unavailable', 'drive-replay-photo-missing'));
      if (!url) placeholder();
      else {
        const img = this.node('img'); img.alt = thumbnail ? '' : 'Captured road frame'; img.loading = thumbnail ? 'lazy' : 'eager'; img.decoding = 'async';
        img.addEventListener('error', placeholder, { once: true }); img.src = url; box.append(img);
      }
      return box;
    }
    clearFrames(message = '') {
      this.captureFrames = []; this.activeCaptureIndex = -1; this.visibleFrames = 12;
      this.selectedFrame = null; this.detailsExpanded = false; this.setFrameDetails(false);
      this.frameCount.textContent = ''; this.frameStatus.textContent = message; this.frameGrid.replaceChildren(); this.frameImage.replaceChildren();
      this.frameViewer.hidden = true; this.frameMore.hidden = true; this.frameRetry.hidden = true;
    }
    async loadFrames(id, meta, signal, generation) {
      if (!id || !meta || !this.isOpen) return;
      this.frameMeta = meta; this.clearFrames('Loading every captured frame…');
      const current = () => !this.destroyed && this.isOpen && !signal?.aborted && generation === this.generation && this.session?.session_id === id;
      try {
        const result = await this.survey.client.driveFrames(id, meta, { signal });
        if (!current()) return;
        if (result.truncated) throw new Error('This drive exceeds the frame viewing limit. No partial gallery is shown.');
        this.captureFrames = result.features.filter(f => f.properties?.session_id === id).sort((a, b) => {
          const ap = a.properties, bp = b.properties;
          return (finite(ap.s0_m) ? ap.s0_m : Infinity) - (finite(bp.s0_m) ? bp.s0_m : Infinity) || (ap.k ?? 0) - (bp.k ?? 0);
        });
        this.frameCount.textContent = String(this.captureFrames.length);
        this.frameStatus.textContent = this.captureFrames.length ? 'All recorded frames · includes normal, distress and unclassified results.' : 'No captured frames are available for this drive.';
        this.renderFrameGrid(); this.syncFrame();
      } catch (error) {
        if (!current()) return;
        this.frameStatus.textContent = error.message?.includes('viewing limit') ? error.message : 'Could not load captured frames. You can still replay the route.';
        this.frameRetry.hidden = false;
      }
    }
    frameLabel(feature, index) {
      const p = feature.properties || {};
      const condition = (Array.isArray(p.final_labels) && p.final_labels.length ? p.final_labels.join(' · ') : p.vlm_class || p.status || 'Unclassified').replaceAll('_', ' ');
      return `Frame ${index + 1} · ${finite(p.s0_m) ? Math.round(p.s0_m) + ' m' : 'Distance unavailable'} · ${condition}`;
    }
    renderFrameGrid() {
      this.frameGrid.replaceChildren();
      this.captureFrames.slice(0, this.visibleFrames).forEach((feature, index) => {
        const button = this.button('', this.frameLabel(feature, index), () => this.selectFrame(index));
        button.className = 'drive-replay-frame-thumb'; button.dataset.frameIndex = String(index);
        button.setAttribute('aria-current', String(index === this.activeCaptureIndex));
        button.append(this.framePhoto(feature, true), this.node('span', `${index + 1} · ${finite(feature.properties.s0_m) ? Math.round(feature.properties.s0_m) + ' m' : '—'}`));
        this.frameGrid.append(button);
      });
      const remaining = this.captureFrames.length - this.visibleFrames;
      this.frameMore.hidden = remaining <= 0;
      this.frameMore.textContent = `Show more frames (${Math.max(0, remaining)} remaining)`;
    }
    selectFrame(index) {
      const feature = this.captureFrames[index]; if (!feature) return;
      this.pause();
      if (finite(feature.properties.s0_m)) { this.seek(feature.properties.s0_m, { follow: false }); this.focusCar(); }
      this.showFrame(index);
    }
    inspectFeature(feature) {
      const p = feature?.properties;
      if (!this.isOpen || !this.ready || !p || p.session_id !== this.session?.session_id || !(p.segment_id || p.layer === 'video')) return false;
      this.pause();
      if (finite(p.s0_m)) { this.seek(p.s0_m, { follow: false }); this.focusCar(); }
      const id = p.segment_id || feature.id;
      const index = this.captureFrames.findIndex(item => (item.properties?.segment_id || item.id) === id);
      this.showFrame(index, index < 0 ? feature : undefined); this.setFrameDetails(true);
      this.frameImage.scrollIntoView?.({ block: 'start', behavior: 'auto' });
      return true;
    }
    setFrameDetails(expanded) {
      const wasExpanded = this.detailsExpanded;
      this.detailsExpanded = Boolean(expanded && this.selectedFrame);
      this.frameViewer.classList.toggle('is-detailed', this.detailsExpanded);
      this.frameInfo.hidden = !this.detailsExpanded;
      this.frameDetails.textContent = this.detailsExpanded ? 'Hide photo details' : 'Photo details';
      this.frameDetails.setAttribute('aria-expanded', String(this.detailsExpanded));
      this.frameDetails.setAttribute('aria-label', this.detailsExpanded ? 'Hide captured frame details' : 'Open captured frame details');
      this.frameImage.setAttribute('aria-expanded', String(this.detailsExpanded));
      this.frameInfo.replaceChildren();
      let row;
      try { row = this.survey.cardRow?.(this.selectedFrame); } catch (_) { row = undefined; }
      if (this.detailsExpanded) this.frameInfo.append(renderDriveEvidence(this.document, this.selectedFrame, {
        apiBase: this.survey.client.apiBase, row,
      }));
      if (this.detailsExpanded && !wasExpanded && this.ready) this.focusCar();
    }
    syncFrame() {
      if (!this.captureFrames.length) return;
      let low = 0, high = this.captureFrames.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2), at = this.captureFrames[mid].properties.s0_m;
        if (finite(at) && at <= this.distance) low = mid + 1; else high = mid;
      }
      this.showFrame(Math.max(0, low - 1));
    }
    showFrame(index, fallback) {
      const feature = fallback || this.captureFrames[index];
      if (!feature || (index === this.activeCaptureIndex && feature === this.selectedFrame)) return;
      this.activeCaptureIndex = index; this.selectedFrame = feature;
      this.frameViewer.hidden = false; this.frameImage.replaceChildren(this.framePhoto(feature));
      this.frameCaption.textContent = index < 0 ? this.frameLabel(feature, index).replace('Frame 0', 'Selected frame') : this.frameLabel(feature, index);
      this.previousFrame.disabled = index <= 0; this.nextFrame.disabled = index < 0 || index === this.captureFrames.length - 1;
      this.setFrameDetails(this.detailsExpanded);
      for (const button of this.frameGrid.children) button.setAttribute('aria-current', String(Number(button.dataset.frameIndex) === index));
    }
    setReady(ready) {
      this.ready = ready;
      for (const control of [this.playButton, this.previewPlayButton, this.restartButton, this.slider, this.speedInput, this.follow]) control.disabled = !ready;
    }
    async open(sessionId) {
      if (this.destroyed) return;
      this.survey.closeEvidence?.();
      this.window.geoaiDriveInspector?.clearInlinePhoto?.();
      this.video.selectVideo?.();
      if (typeof closeFilterStack === 'function') closeFilterStack();
      if (typeof closeAboutStack === 'function') closeAboutStack();
      if (this.isOpen) {
        if (sessionId && sessionId !== this.session?.session_id) await this.load(sessionId);
        else this.focusCar();
        this.focusControls(); return;
      }
      this.isOpen = true; this.panel.hidden = false; this.launcher.hidden = true;
      this.document.body.classList.add('drive-replay-open'); this.launcher.setAttribute('aria-expanded', 'true');
      if (!this.video.enabled) this.video.setEnabled(true);
      this.select.focus();
      await this.load(sessionId || this.survey.filters.session);
      this.focusControls();
    }
    focusControls() {
      const inspector = this.document.getElementById('driveInspector');
      if (inspector) { inspector.scrollTop = 0; this.playButton.focus({ preventScroll: true }); }
      else this.select.focus();
    }
    async load(requestedId, { fit = true } = {}) {
      if (!this.isOpen) return;
      const generation = ++this.generation;
      this.pause(); this.controller?.abort(); this.controller = new AbortController();
      this.setReady(false); this.retryButton.hidden = true; this.select.disabled = true;
      this.message.textContent = 'Loading recorded route and distress…';
      this.clearFrames('Loading every captured frame…');
      this.route = null; this.session = null; this.features = []; this.distance = 0;
      this.layer.clearLayers(); this.video.clearPlayback();
      this.slider.value = '0'; this.progress.textContent = '0.00 / 0.00 km'; this.encountered.textContent = '';
      const current = () => !this.destroyed && this.isOpen && this.video.enabled && this.generation === generation && !this.controller.signal.aborted;
      try {
        const signal = this.controller.signal;
        const meta = this.survey.meta || await this.survey.client.meta({ signal });
        const catalogue = await this.survey.client.sessions({ signal, perKm: false });
        if (!current()) return;
        this.sessions = catalogue.sessions;
        this.select.replaceChildren();
        for (const session of this.sessions) {
          const option = this.node('option', `${session.road_name || session.road_id || 'Drive'} · ${session.local_date || 'Date unavailable'}`);
          option.value = session.session_id; this.select.append(option);
        }
        const selected = requestedId ? this.sessions.find(s => s.session_id === requestedId) : this.sessions.find(s => { try { buildRoute(s); return true; } catch { return false; } });
        if (!selected) throw new Error(requestedId ? 'The selected drive is unavailable. Choose another drive.' : 'No recorded route is available yet.');
        this.select.value = selected.session_id;
        const route = buildRoute(selected);
        // One drive selection governs replay, ordinary viewport results and exports.
        // Do not call Survey.apply(), which would emit a filter event and recurse.
        this.survey.filters = { ...this.survey.filters, session: selected.session_id };
        if (this.survey.driveInput) this.survey.driveInput.value = selected.session_id;
        this.video.setFilters(this.survey.filters);
        this.survey.updateCounts?.();
        const filters = this.survey.filters;
        const result = await this.survey.client.features('video', filters, meta, { geom: 'point', signal, max: 5000 });
        if (!current()) return;
        if (result.truncated) throw new Error('Too many distress points for replay. Narrow the filters and retry.');
        this.session = selected; this.route = route;
        this.features = result.features.filter(f => f.properties?.session_id === selected.session_id && f.properties?.vlm_class === 'distress');
        this.slider.max = String(route.distance);
        this.reference = this.L.polyline(route.displayParts.map(part => part.map(p => [p[1], p[0]])), { color: '#64748b', weight: 4, opacity: .4, interactive: false }).addTo(this.layer);
        this.trail = this.L.polyline([], { color: '#2563eb', weight: 4, opacity: .85, interactive: false }).addTo(this.layer);
        const icon = this.L.divIcon({ className: 'drive-replay-vehicle', html: `<span class="drive-replay-car">${carSVG}</span>`, iconSize: [36, 42], iconAnchor: [18, 21] });
        this.vehicle = this.L.marker(positionAt(route, 0).latlng, { icon, interactive: false, keyboard: false, zIndexOffset: 1500 }).addTo(this.layer);
        this.layer.addTo(this.map);
        this.video.setPlaybackData({ sessionId: selected.session_id, features: this.features, distance: 0 });
        this.lastPart = null; this.lastFollow = 0; this.lastUI = -Infinity;
        this.setReady(true); this.seek(0, { follow: false });
        this.message.textContent = `${this.features.length} matching distress ${this.features.length === 1 ? 'point' : 'points'}. Click a camera marker for its photo and details.${route.parts.length > 1 ? ' GPS gaps are skipped.' : ''}`;
        this.loadFrames(selected.session_id, meta, signal, generation);
        if (fit) this.focusCar();
      } catch (error) {
        if (!current()) return;
        this.message.textContent = error.message || 'Route replay could not load. Please retry.';
        this.retryButton.hidden = false;
      } finally {
        if (current()) this.select.disabled = !this.sessions?.length;
      }
    }
    focusCar() {
      if (!this.isOpen || !this.ready || !this.route) return;
      const position = positionAt(this.route, this.distance);
      const size = this.map.getSize?.(), height = size?.y || this.window.innerHeight || 800;
      const width = size?.x || this.window.innerWidth || 1280;
      const shortLandscape = width >= 600 && height <= 480;
      let paddingTopLeft = [24, Math.min(110, height * .2)];
      let paddingBottomRight = shortLandscape ? [Math.min(380, width * .46) + 20, 24] : [24, Math.min(280, height * .4)];
      const inspector = this.panel.closest('.drive-inspector');
      if (inspector) {
        const bounds = inspector.getBoundingClientRect();
        if (width > 820 || shortLandscape) {
          const menu = this.document.querySelector('.video-drive-card')?.getBoundingClientRect();
          paddingTopLeft = [menu?.width ? Math.min(menu.right + 16, width * .38) : 24, Math.min(120, height * .3)];
          paddingBottomRight = [Math.min((bounds.width || 350) + (width > 1440 ? 36 : 24) + 16, width * .46), 24];
          if (bounds.width > width * .46) {
            paddingBottomRight[0] = Math.min(bounds.width + (width - bounds.right) + 16, width - 150);
            if (width - paddingBottomRight[0] - paddingTopLeft[0] < 150) {
              paddingTopLeft[0] = 24;
              paddingTopLeft[1] = menu?.height ? Math.min(menu.bottom + 24, height * .7) : paddingTopLeft[1];
            }
          }
        } else {
          paddingTopLeft = [16, Math.min(178, height * .32)];
          paddingBottomRight = [16, Math.min((bounds.height || height * .52) + 26, height * .57)];
        }
      }
      // Reserve the card's occupied space while focusing the car at street level.
      this.map.fitBounds(this.L.latLngBounds([position.latlng]), {
        paddingTopLeft, paddingBottomRight,
        maxZoom: Math.min(this.map.getMaxZoom?.() ?? Infinity, Math.max(18, this.map.getZoom?.() || 0)),
        animate: false,
      });
    }
    seek(distance, { follow = true } = {}) {
      if (!this.route || !this.ready) return;
      this.distance = clamp(finite(distance) ? distance : 0, 0, this.route.distance);
      this.lastFrame = null; this.render(true, this.window.performance.now(), follow);
    }
    render(force = false, now = this.window.performance.now(), follow = true) {
      if (!this.route || !this.vehicle) return;
      const position = positionAt(this.route, this.distance);
      this.vehicle.setLatLng(position.latlng);
      const car = this.vehicle.getElement?.()?.querySelector('.drive-replay-car');
      if (car) car.style.transform = `rotate(${position.heading}deg)`;
      this.trail.setLatLngs(position.visited);
      if (force || now - this.lastUI >= 100) {
        this.lastUI = now;
        this.slider.value = String(this.distance);
        this.slider.setAttribute('aria-valuetext', `${Math.round(this.distance)} of ${Math.round(this.route.distance)} metres`);
        this.progress.textContent = `${(this.distance / 1000).toFixed(2)} / ${(this.route.distance / 1000).toFixed(2)} km`;
        const reached = this.features.filter(f => finite(f.properties.s0_m) && f.properties.s0_m <= this.distance).length;
        this.encountered.textContent = `${reached} / ${this.features.length} distress passed`;
        this.video.setPlaybackProgress(this.distance);
        this.syncFrame();
      }
      if (this.lastPart !== null && position.part !== this.lastPart && this.playing) this.message.textContent = 'GPS gap skipped — continuing on the next recorded path.';
      this.lastPart = position.part;
      if (follow && this.follow.checked && (force || now - this.lastFollow >= 500)) {
        this.lastFollow = now;
        if (this.panel.closest('.drive-inspector')) this.focusCar();
        else this.map.panTo(position.latlng, { animate: false });
      }
    }
    play() {
      if (!this.ready || !this.route || !this.isOpen || !this.video.enabled || this.document.hidden) return;
      if (this.distance >= this.route.distance) this.seek(0);
      if (this.playing) return;
      this.playing = true; this.lastFrame = null;
      this.playButton.textContent = 'Ⅱ Pause'; this.playButton.setAttribute('aria-label', 'Pause route');
      this.previewPlayButton.textContent = 'Ⅱ Pause'; this.previewPlayButton.setAttribute('aria-label', 'Pause frame playback');
      this.message.textContent = 'Replaying the recorded path at approximate pace. Click a camera marker to pause and inspect.';
      const frame = now => {
        if (!this.playing || !this.isOpen || !this.video.enabled) return;
        // A suspended or stalled browser must not catch up by jumping the car ahead.
        if (this.lastFrame != null) this.distance = Math.min(this.route.distance, this.distance + clamp(now - this.lastFrame, 0, 250) / 1000 * this.route.distance / this.route.duration * this.speed);
        this.lastFrame = now;
        this.render(false, now);
        if (this.distance >= this.route.distance) {
          this.render(true, now); this.pause(); this.message.textContent = 'Route complete. Replay it or select a camera marker to inspect distress.'; return;
        }
        this.frame = this.window.requestAnimationFrame(frame);
      };
      this.frame = this.window.requestAnimationFrame(frame);
    }
    pause() {
      const wasPlaying = this.playing;
      this.playing = false; this.lastFrame = null;
      if (this.frame != null) this.window.cancelAnimationFrame(this.frame);
      this.frame = null;
      this.playButton.textContent = '▶ Play'; this.playButton.setAttribute('aria-label', 'Play route');
      this.previewPlayButton.textContent = '▶ Play'; this.previewPlayButton.setAttribute('aria-label', 'Play from this frame');
      if (wasPlaying && this.isOpen && this.ready)
        this.message.textContent = 'Paused. Press Play to continue, or select a camera marker for its photo and details.';
    }
    close(restoreFocus = true) {
      this.pause(); this.generation++; this.controller?.abort();
      this.isOpen = false; this.panel.hidden = true;
      this.document.body.classList.remove('drive-replay-open'); this.launcher.setAttribute('aria-expanded', 'false');
      this.layer.clearLayers(); this.map.removeLayer(this.layer); this.video.clearPlayback();
      this.route = null; this.session = null; this.vehicle = null; this.setReady(false);
      this.clearFrames();
      this.launcher.hidden = !this.video.enabled;
      if (restoreFocus) (this.document.getElementById('driveInspectorReplay') || (!this.launcher.hidden && this.launcher))?.focus();
    }
    destroy() {
      this.close(false); this.destroyed = true;
      this.document.removeEventListener('geoai:videochange', this.videoChanged);
      this.document.removeEventListener('geoai:filterschange', this.filtersChanged);
      this.document.removeEventListener('geoai:evidenceopen', this.evidenceOpened);
      this.document.removeEventListener('geoai:app-pause', this.evidenceOpened);
      this.document.removeEventListener('visibilitychange', this.visibilityChanged);
      this.window.removeEventListener('pagehide', this.evidenceOpened);
      this.document.removeEventListener('keydown', this.escape);
      this.map.off('dragstart', this.dragged);
      this.launcher.remove(); this.panel.remove();
    }
  }
  return { GeoAIDrivePlayer, buildRoute, positionAt, metres, renderDriveEvidence };
});
