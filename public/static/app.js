/* Trail Log front end. Plain JavaScript, no build step. */
(() => {
  'use strict';

  // ---------- Helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  async function api(method, url, body, isForm) {
    const opts = { method, headers: { 'X-Requested-With': 'fetch' } };
    if (body !== undefined) {
      if (isForm) opts.body = body;
      else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    const res = await fetch(url, opts);
    if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, isError) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2600);
  }
  const fail = (e) => toast(e.message || String(e), true);

  const DIFFS = ['Easy', 'Moderate', 'Hard', 'Expert'];
  const TYPES = ['Single track', 'Two track / jeep road', 'Dirt road', 'Sand / dunes', 'Rocky / technical', 'Mixed'];
  const DIFF_COLORS = { Easy: '#2e8b57', Moderate: '#2b6cb0', Hard: '#1f2622', Expert: '#1f2622' };
  const lineColor = (t) => t.color || DIFF_COLORS[t.difficulty] || '#8a6a3b';
  const diffBadge = (d) => `<span class="diff diff-${esc(d || 'none')}"><span class="diff-icon"></span>${esc(d || 'Not rated')}</span>`;
  const fmtMi = (m) => (m == null ? '–' : Number(m) < 10 ? Number(m).toFixed(1) : Math.round(Number(m)).toLocaleString());
  const fmtDate = (d) => {
    if (!d) return '';
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const stars = (n) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '');

  function haversineMi(a, b) {
    const r = (d) => (d * Math.PI) / 180;
    const dLat = r(b[1] - a[1]); const dLng = r(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * 3958.7613 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const geomMiles = (g) => g.coordinates.reduce((sum, line) => sum + line.reduce((s, c, i) => (i ? s + haversineMi(line[i - 1], c) : 0), 0), 0);
  const geomPoints = (g) => g.coordinates.reduce((n, l) => n + l.length, 0);
  // GeoJSON [lng,lat,ele] <-> Leaflet [lat,lng,ele]
  const toLatLngs = (g) => g.coordinates.map((line) => line.map((c) => (c.length > 2 ? [c[1], c[0], c[2]] : [c[1], c[0]])));
  function fromLayer(layer) {
    const gj = layer.toGeoJSON().geometry;
    if (gj.type === 'LineString') return { type: 'MultiLineString', coordinates: [gj.coordinates] };
    return { type: 'MultiLineString', coordinates: gj.coordinates.filter((l) => l.length >= 2) };
  }
  function mergeGeoms(a, b) {
    return { type: 'MultiLineString', coordinates: [...(a ? a.coordinates : []), ...b.coordinates] };
  }

  // ---------- State ----------
  const S = {
    me: null,
    users: [],
    trails: [],
    filters: { q: '', diff: '', state: '', rider: '', sort: 'name' },
    view: 'list',
    selectedId: null,
    form: null,      // trail being created or edited
    mode: null,      // active map mode (drawing or editing)
  };

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: true, preferCanvas: false }).setView([39.3, -111.7], 7);
  const bases = {
    'Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: 'Map: © OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors',
    }),
    'USGS topo': L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, maxNativeZoom: 16, attribution: 'USGS The National Map',
    }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    }),
    'Streets': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }),
  };
  const overlays = {
    'Known trails (OSM)': L.tileLayer('https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png', {
      maxZoom: 18, opacity: 0.8, attribution: 'Trails: © waymarkedtrails.org',
    }),
  };
  const savedBase = store.get('basemap');
  (bases[savedBase] || bases.Topo).addTo(map);
  L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => store.set('basemap', e.name));
  L.control.scale({ imperial: true, metric: false }).addTo(map);

  // "Where am I" button
  let meMarker;
  const Locate = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      div.innerHTML = '<button class="locate-btn" title="Show my location" aria-label="Show my location"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>';
      L.DomEvent.disableClickPropagation(div);
      div.firstChild.addEventListener('click', () => {
        if (!navigator.geolocation) return toast('Location is not available on this device', true);
        navigator.geolocation.getCurrentPosition((pos) => {
          const ll = [pos.coords.latitude, pos.coords.longitude];
          if (meMarker) meMarker.setLatLng(ll);
          else meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }), interactive: false }).addTo(map);
          map.setView(ll, Math.max(map.getZoom(), 13));
        }, () => toast('Could not get your location', true), { enableHighAccuracy: true, timeout: 10000 });
      });
      return div;
    },
  });
  new Locate().addTo(map);

  map.pm.setGlobalOptions({ snappable: false, allowSelfIntersection: true });
  map.pm.setLang('en');

  const trailLayer = L.layerGroup().addTo(map);
  const layerById = new Map();
  let draftLayer = null;

  function drawTrailsOnMap() {
    trailLayer.clearLayers();
    layerById.clear();
    const visible = new Set(filteredTrails().map((t) => t.id));
    for (const t of S.trails) {
      if (!visible.has(t.id)) continue;
      if (S.form && S.form.id === t.id) continue; // being edited: shown as the draft instead
      const ll = toLatLngs(t.geometry);
      const selected = S.selectedId === t.id;
      const dim = S.selectedId && !selected;
      const casing = L.polyline(ll, { color: '#fff', weight: selected ? 10 : 7, opacity: dim ? 0.45 : 0.9, interactive: false });
      const line = L.polyline(ll, { color: lineColor(t), weight: selected ? 6 : 4, opacity: dim ? 0.5 : 1, interactive: false,
        dashArray: t.difficulty === 'Expert' ? '10 6' : null });
      const hit = L.polyline(ll, { color: '#000', weight: 20, opacity: 0, pmIgnore: true });
      hit.bindTooltip(t.name, { sticky: true, className: 'trail-tip', direction: 'top', offset: [0, -8] });
      hit.on('click', () => { if (!S.mode) openTrail(t.id); });
      hit.on('mouseover', () => { const el = $(`.trail-item[data-id="${t.id}"]`); if (el) el.classList.add('hover'); });
      hit.on('mouseout', () => { const el = $(`.trail-item[data-id="${t.id}"]`); if (el) el.classList.remove('hover'); });
      const g = L.featureGroup([casing, line, hit]);
      g.addTo(trailLayer);
      layerById.set(t.id, g);
    }
    // keep the selected trail on top
    if (S.selectedId && layerById.has(S.selectedId)) layerById.get(S.selectedId).eachLayer((l) => l.bringToFront());
  }

  function showDraft(geometry) {
    if (draftLayer) { map.removeLayer(draftLayer); draftLayer = null; }
    if (!geometry) return;
    const ll = toLatLngs(geometry);
    draftLayer = L.featureGroup([
      L.polyline(ll, { color: '#24302b', weight: 9, opacity: 0.85, interactive: false, pmIgnore: true }),
      L.polyline(ll, { color: '#e8c547', weight: 5, interactive: false, pmIgnore: true }),
    ]).addTo(map);
  }

  function fitGeometry(geometry, opts = {}) {
    const b = L.latLngBounds(toLatLngs(geometry).flat());
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 15, ...opts });
  }
  function fitAll() {
    const pts = filteredTrails().flatMap((t) => toLatLngs(t.geometry).flat());
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 13 });
  }

  // ---------- Map modes: drawing and editing lines ----------
  const panel = $('#panel');
  function setSheet(state) {
    panel.classList.remove('expanded', 'collapsed');
    if (state) panel.classList.add(state);
    setTimeout(() => map.invalidateSize(), 280);
  }
  $('#sheet-grip').addEventListener('click', () => {
    if (panel.classList.contains('collapsed')) setSheet(null);
    else if (panel.classList.contains('expanded')) setSheet('collapsed');
    else setSheet('expanded');
  });

  function showModeBar(text, { undo = false, doneLabel = 'Finish' } = {}) {
    $('#mode-text').textContent = text;
    $('#mode-undo').hidden = !undo;
    $('#mode-done').textContent = doneLabel;
    $('#mode-bar').hidden = false;
    $('.map-actions').hidden = true;
    if (matchMedia('(max-width: 760px)').matches) setSheet('collapsed');
  }
  function hideModeBar() {
    $('#mode-bar').hidden = true;
    $('.map-actions').hidden = false;
    if (panel.classList.contains('collapsed')) setSheet(null);
  }

  // Draw a new line. Resolves with a MultiLineString geometry, or null if cancelled.
  function drawLine() {
    return new Promise((resolve) => {
      const touch = matchMedia('(pointer: coarse)').matches;
      S.mode = {
        type: 'draw',
        cancel: () => { map.pm.disableDraw(); finish(null); },
        done: () => {
          const d = map.pm.Draw.Line;
          if (d._layer && d._layer.getLatLngs().length >= 2) d._finishShape();
          else toast('Add at least two points first', true);
        },
        undo: () => { const d = map.pm.Draw.Line; if (d._layer && d._layer.getLatLngs().length) d._removeLastVertex(); },
      };
      const onCreate = (e) => {
        const g = fromLayer(e.layer);
        map.removeLayer(e.layer);
        finish(g);
      };
      function finish(g) {
        map.off('pm:create', onCreate);
        S.mode = null;
        hideModeBar();
        resolve(g);
      }
      map.on('pm:create', onCreate);
      map.pm.enableDraw('Line', {
        templineStyle: { color: '#e8c547', weight: 5 },
        hintlineStyle: { color: '#24302b', dashArray: '5 6', weight: 2 },
        pathOptions: { color: '#e8c547', weight: 5 },
        finishOn: touch ? null : 'dblclick',
        tooltips: false,
      });
      showModeBar(touch ? 'Tap along the trail to add points, then Finish.' : 'Click along the trail to add points. Double-click or Finish to end.', { undo: true });
    });
  }

  // Edit points of an existing line. Resolves with the new geometry, or null if cancelled.
  function editLine(geometry) {
    return new Promise((resolve) => {
      const layer = L.polyline(toLatLngs(geometry), { color: '#e8c547', weight: 5 }).addTo(map);
      layer.pm.enable({ allowSelfIntersection: true, removeVertexOn: 'contextmenu' });
      S.mode = {
        type: 'edit',
        cancel: () => finish(null),
        done: () => finish(fromLayer(layer)),
      };
      function finish(g) {
        layer.pm.disable();
        map.removeLayer(layer);
        S.mode = null;
        hideModeBar();
        resolve(g);
      }
      const touch = matchMedia('(pointer: coarse)').matches;
      showModeBar(touch
        ? 'Drag points to move them. Drag a small mid-point to add one. Long-press a point to delete it.'
        : 'Drag points to move them. Drag a small mid-point to add one. Right-click a point to delete it.', { doneLabel: 'Save line' });
    });
  }

  $('#mode-cancel').addEventListener('click', () => S.mode && S.mode.cancel());
  $('#mode-done').addEventListener('click', () => S.mode && S.mode.done());
  $('#mode-undo').addEventListener('click', () => S.mode && S.mode.undo && S.mode.undo());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.mode) S.mode.cancel(); });

  // ---------- GPX / KML import ----------
  function thin(coords) {
    // Drop points closer than ~3 m to the previous kept point; keeps files small without changing the shape.
    const out = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      if (haversineMi(out[out.length - 1], coords[i]) > 0.0019 || i === coords.length - 1) out.push(coords[i]);
    }
    return out;
  }

  async function parseTrack(file) {
    const text = await file.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error(`${file.name} isn't a readable GPX or KML file`);
    const isKml = /\.kml$/i.test(file.name) || doc.documentElement.nodeName.toLowerCase() === 'kml';
    const fc = isKml ? toGeoJSON.kml(doc) : toGeoJSON.gpx(doc);
    const lines = [];
    let name = null;
    let date = null;
    for (const f of fc.features) {
      if (!f.geometry) continue;
      const g = f.geometry;
      let parts = [];
      if (g.type === 'LineString') parts = [g.coordinates];
      else if (g.type === 'MultiLineString') parts = g.coordinates;
      else if (g.type === 'GeometryCollection') {
        for (const sub of g.geometries) {
          if (sub.type === 'LineString') parts.push(sub.coordinates);
          if (sub.type === 'MultiLineString') parts.push(...sub.coordinates);
        }
      }
      parts = parts.filter((p) => p.length >= 2);
      if (!parts.length) continue;
      lines.push(...parts.map(thin));
      if (!name && f.properties && f.properties.name) name = String(f.properties.name).trim();
      const times = f.properties && (f.properties.time || (f.properties.coordinateProperties && f.properties.coordinateProperties.times));
      const t = Array.isArray(times) ? (Array.isArray(times[0]) ? times[0][0] : times[0]) : times;
      if (!date && t) {
        const d = new Date(t);
        if (!isNaN(d)) date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    }
    if (!date) {
      const meta = doc.querySelector('metadata > time');
      if (meta) { const d = new Date(meta.textContent); if (!isNaN(d)) date = d.toISOString().slice(0, 10); }
    }
    if (!lines.length) throw new Error(`${file.name} has no track or route in it`);
    return {
      fileName: file.name,
      name: name || file.name.replace(/\.(gpx|kml)$/i, '').replace(/[_-]+/g, ' ').trim(),
      date,
      geometry: { type: 'MultiLineString', coordinates: lines },
    };
  }

  async function readFiles(fileList) {
    const results = [];
    for (const f of fileList) {
      try { results.push(await parseTrack(f)); } catch (e) { fail(e); }
    }
    return results;
  }

  $('#gpx-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length || S.mode) return;
    const tracks = await readFiles(files);
    if (!tracks.length) return;
    if (tracks.length === 1) {
      const t = tracks[0];
      openForm({ name: t.name, geometry: t.geometry, source: 'gpx', rideDate: t.date });
    } else {
      openBulkImport(tracks);
    }
  });

  $('#btn-draw').addEventListener('click', async () => {
    if (S.mode) return;
    const g = await drawLine();
    if (g) openForm({ geometry: g, source: 'drawn' });
  });

  // ---------- Data ----------
  async function loadTrails() {
    S.trails = await api('GET', '/api/trails');
  }
  function filteredTrails() {
    const f = S.filters;
    const q = f.q.toLowerCase();
    let list = S.trails.filter((t) =>
      (!q || [t.name, t.area, t.state, t.notes, t.trail_type].some((v) => v && v.toLowerCase().includes(q))) &&
      (!f.diff || t.difficulty === f.diff) &&
      (!f.state || t.state === f.state) &&
      (!f.rider || (t.riders || []).includes(f.rider)));
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      recent: (a, b) => (b.last_ridden || '').localeCompare(a.last_ridden || '') || a.name.localeCompare(b.name),
      miles: (a, b) => (b.distance_mi || 0) - (a.distance_mi || 0),
      rides: (a, b) => b.ride_count - a.ride_count,
      rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    };
    return list.sort(by[f.sort] || by.name);
  }
  const allRiderNames = () => {
    // Members first, then anyone else who appears on rides; duplicates ignore capitalization.
    const names = new Map();
    const add = (n) => { const k = n.trim().toLowerCase(); if (k && !names.has(k)) names.set(k, n.trim()); };
    S.users.forEach((u) => add(u.display_name));
    S.trails.forEach((t) => (t.riders || []).forEach(add));
    return Array.from(names.values()).sort((a, b) => a.localeCompare(b));
  };

  // ---------- Views ----------
  const view = $('#view');
  function setTab(name) {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    if (S.mode) return toast('Finish or cancel the map edit first', true);
    if (S.form && !confirm('Discard this unsaved trail?')) return;
    closeForm();
    S.selectedId = null;
    setHash('');
    const v = b.dataset.view;
    if (v === 'list') renderList();
    if (v === 'stats') renderStats();
    if (v === 'account') renderAccount();
    drawTrailsOnMap();
  }));

  function setHash(h) {
    const target = h ? `#${h}` : ' ';
    if ((location.hash || ' ') !== target) history.replaceState(null, '', h ? `#${h}` : location.pathname);
  }

  // ----- Trail list -----
  function renderList() {
    S.view = 'list';
    setTab('list');
    const states = Array.from(new Set(S.trails.map((t) => t.state).filter(Boolean))).sort();
    const riders = allRiderNames();
    const f = S.filters;
    view.innerHTML = `
      <div class="list-tools">
        <input class="search" id="q" type="search" placeholder="Search trails, areas, notes" value="${esc(f.q)}" aria-label="Search trails">
        <div class="filter-row">
          <select id="f-diff" aria-label="Difficulty"><option value="">Any difficulty</option>${DIFFS.map((d) => `<option ${f.diff === d ? 'selected' : ''}>${d}</option>`).join('')}</select>
          <select id="f-state" aria-label="State"><option value="">Any state</option>${states.map((s) => `<option ${f.state === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
          <select id="f-rider" aria-label="Rider"><option value="">Any rider</option>${riders.map((r) => `<option ${f.rider === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
        </div>
      </div>
      <div class="list-summary"><span id="count"></span>
        <label class="small">Sort
          <select id="f-sort" aria-label="Sort trails">
            <option value="name">Name</option><option value="recent">Last ridden</option>
            <option value="miles">Longest</option><option value="rides">Most ridden</option><option value="rating">Rating</option>
          </select>
        </label>
      </div>
      <ul class="trail-list" id="trail-list"></ul>`;
    $('#f-sort').value = f.sort;
    const refresh = () => { renderListItems(); drawTrailsOnMap(); };
    $('#q').addEventListener('input', (e) => { f.q = e.target.value; refresh(); });
    $('#f-diff').addEventListener('change', (e) => { f.diff = e.target.value; refresh(); });
    $('#f-state').addEventListener('change', (e) => { f.state = e.target.value; refresh(); });
    $('#f-rider').addEventListener('change', (e) => { f.rider = e.target.value; refresh(); });
    $('#f-sort').addEventListener('change', (e) => { f.sort = e.target.value; renderListItems(); });
    renderListItems();
  }

  function renderListItems() {
    const list = filteredTrails();
    const total = list.reduce((s, t) => s + (Number(t.distance_mi) || 0), 0);
    $('#count').textContent = `${list.length} ${list.length === 1 ? 'trail' : 'trails'} · ${fmtMi(total)} mi`;
    const ul = $('#trail-list');
    if (!S.trails.length) {
      ul.innerHTML = `<li class="empty"><strong>No trails yet</strong>Use <b>Draw a trail</b> to trace one on the map, or <b>Upload GPX</b> to add a recorded ride.</li>`;
      return;
    }
    if (!list.length) {
      ul.innerHTML = `<li class="empty"><strong>No trails match</strong>Clear the search or filters to see everything.</li>`;
      return;
    }
    ul.innerHTML = list.map((t) => `
      <li><button class="trail-item" data-id="${t.id}">
        <span class="swatch" style="background:${esc(lineColor(t))}"></span>
        <span>
          <span class="t-name">${esc(t.name)}</span>
          <span class="t-meta">
            ${diffBadge(t.difficulty)}
            ${t.area || t.state ? `<span>${esc([t.area, t.state].filter(Boolean).join(', '))}</span>` : ''}
          </span>
          <span class="t-meta">${t.ride_count ? `Ridden ${t.ride_count}× · last ${fmtDate(t.last_ridden)}` : 'Not logged yet'}</span>
        </span>
        <span class="t-miles">${fmtMi(t.distance_mi)}<small>mi</small></span>
      </button></li>`).join('');
    $$('.trail-item', ul).forEach((el) => {
      const id = Number(el.dataset.id);
      el.addEventListener('click', () => openTrail(id, { fit: true }));
      el.addEventListener('mouseenter', () => { const g = layerById.get(id); if (g) g.eachLayer((l) => l.options.interactive === false && l.options.color !== '#fff' && l.setStyle({ weight: 7 })); });
      el.addEventListener('mouseleave', () => { const g = layerById.get(id); if (g) g.eachLayer((l) => l.options.interactive === false && l.options.color !== '#fff' && l.setStyle({ weight: 4 })); });
    });
  }

  // ----- Trail detail -----
  async function openTrail(id, { fit = false } = {}) {
    if (S.form) { if (!confirm('Discard this unsaved trail?')) return; closeForm(); }
    S.selectedId = id;
    S.view = 'detail';
    setTab('list');
    setHash(`trail/${id}`);
    drawTrailsOnMap();
    view.innerHTML = '<p class="muted">Loading…</p>';
    let t;
    try { t = await api('GET', `/api/trails/${id}`); } catch (e) { fail(e); return renderList(); }
    if (S.selectedId !== id) return;
    if (fit) fitGeometry(t.geometry);
    if (matchMedia('(max-width: 760px)').matches && panel.classList.contains('collapsed')) setSheet(null);
    renderDetail(t);
  }

  function elevationSvg(geometry) {
    const pts = [];
    let d = 0;
    for (const line of geometry.coordinates) {
      for (let i = 0; i < line.length; i++) {
        if (i) d += haversineMi(line[i - 1], line[i]);
        if (line[i].length > 2) pts.push([d, line[i][2] * 3.28084]);
      }
    }
    if (pts.length < 10) return '';
    const W = 360, H = 110, padL = 38, padB = 16, padT = 6;
    const maxD = pts[pts.length - 1][0] || 1;
    let minE = Math.min(...pts.map((p) => p[1])); let maxE = Math.max(...pts.map((p) => p[1]));
    if (maxE - minE < 50) { minE -= 25; maxE += 25; }
    const x = (v) => padL + (v / maxD) * (W - padL - 4);
    const y = (v) => padT + (1 - (v - minE) / (maxE - minE)) * (H - padT - padB);
    const step = Math.max(1, Math.floor(pts.length / 300));
    const sampled = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    const path = sampled.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const area = `${path}L${x(maxD).toFixed(1)},${H - padB}L${padL},${H - padB}Z`;
    const r = (v) => Math.round(v / 10) * 10;
    return `<h3>Elevation</h3>
      <svg class="elev" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Elevation profile from ${r(minE)} to ${r(maxE)} feet">
        <line class="grid" x1="${padL}" x2="${W}" y1="${y(maxE)}" y2="${y(maxE)}"/>
        <line class="grid" x1="${padL}" x2="${W}" y1="${H - padB}" y2="${H - padB}"/>
        <path class="area" d="${area}"/><path class="stroke" d="${path}"/>
        <text x="0" y="${y(maxE) + 4}">${r(maxE).toLocaleString()} ft</text>
        <text x="0" y="${H - padB}">${r(minE).toLocaleString()} ft</text>
        <text x="${padL}" y="${H - 2}">0 mi</text>
        <text x="${W - 4}" y="${H - 2}" text-anchor="end">${fmtMi(maxD)} mi</text>
      </svg>`;
  }

  function renderDetail(t) {
    const where = [t.area, t.state].filter(Boolean).join(', ');
    view.innerHTML = `
      <button class="link-btn back" id="back">‹ All trails</button>
      <div class="detail-title">
        <div>
          <h2>${esc(t.name)}</h2>
          ${where ? `<div class="detail-where">${esc(where)}</div>` : ''}
        </div>
        <button class="btn btn-secondary btn-small" id="edit">Edit</button>
      </div>
      <div class="facts">
        <div class="fact"><b>${fmtMi(t.distance_mi)}</b><span>miles</span></div>
        <div class="fact"><b>${t.elevation_gain_ft != null ? t.elevation_gain_ft.toLocaleString() : '–'}</b><span>ft climbing</span></div>
        <div class="fact"><b>${t.ride_count}</b><span>${t.ride_count === 1 ? 'ride' : 'rides'} logged</span></div>
      </div>
      <div class="chips" style="align-items:center; gap:12px">
        ${diffBadge(t.difficulty)}
        ${t.trail_type ? `<span>${esc(t.trail_type)}</span>` : ''}
        ${t.rating ? `<span class="stars" aria-label="${t.rating} out of 5">${stars(t.rating)}</span>` : ''}
      </div>
      ${t.riders && t.riders.length ? `<h3>Who's ridden it</h3><div class="chips">${t.riders.map((r) => `<span class="chip">${esc(r)}</span>`).join('')}</div>` : ''}
      ${t.notes ? `<h3>Notes</h3><p class="notes">${esc(t.notes)}</p>` : ''}
      ${elevationSvg(t.geometry)}

      <h3>Rides</h3>
      <div id="rides">
        ${t.rides.map((r) => `
          <div class="ride" data-id="${r.id}">
            <div class="ride-head">
              <span class="ride-date">${fmtDate(r.ride_date)}</span>
              <span class="ride-actions"><button class="link-btn" data-act="edit-ride">Edit</button><button class="link-btn danger" data-act="del-ride">Delete</button></span>
            </div>
            ${r.conditions ? `<div class="small muted">Conditions: ${esc(r.conditions)}</div>` : ''}
            ${r.riders.length ? `<div class="chips">${r.riders.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
            ${r.notes ? `<p class="notes">${esc(r.notes)}</p>` : ''}
          </div>`).join('')}
        ${t.rides.length ? '' : '<p class="muted">No rides logged on this trail yet.</p>'}
      </div>
      <div id="ride-form-slot"><button class="btn btn-dark btn-small" id="add-ride">Log a ride</button></div>

      <h3>Photos</h3>
      <div class="photo-grid">
        ${t.photos.map((p) => `<button data-photo="${p.id}" data-cap="${esc(p.caption || '')}"><img loading="lazy" src="/api/photos/${p.id}?thumb=1" alt="${esc(p.caption || `Photo on ${t.name}`)}"></button>`).join('')}
        <label class="photo-add">+ Add photos<input type="file" id="photo-input" accept="image/*" multiple hidden></label>
      </div>

      <div class="detail-foot btn-row">
        <button class="btn btn-secondary btn-small" id="zoom">Zoom to trail</button>
        <a class="btn btn-secondary btn-small" href="/api/trails/${t.id}/gpx">Download GPX</a>
        <button class="btn btn-secondary btn-small" id="copy-link">Copy link</button>
      </div>
      <p class="byline">Added by ${esc(t.created_by_name || 'a former member')} on ${new Date(t.created_at).toLocaleDateString()}${t.updated_by_name && t.updated_at !== t.created_at ? ` · last edited by ${esc(t.updated_by_name)} ${new Date(t.updated_at).toLocaleDateString()}` : ''} · ${t.source === 'gpx' ? 'from a GPX recording' : 'drawn on the map'}</p>`;

    $('#back').addEventListener('click', backToList);
    $('#edit').addEventListener('click', () => openForm({ ...t, existing: true }));
    $('#zoom').addEventListener('click', () => fitGeometry(t.geometry));
    $('#copy-link').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); toast('Link copied. Group members can open it after signing in.'); }
      catch { toast('Copy failed. Use the address bar link instead.', true); }
    });
    $('#add-ride').addEventListener('click', () => rideForm(t, null));
    $$('#rides .ride').forEach((el) => {
      const ride = t.rides.find((r) => r.id === Number(el.dataset.id));
      el.querySelector('[data-act=edit-ride]').addEventListener('click', () => rideForm(t, ride));
      el.querySelector('[data-act=del-ride]').addEventListener('click', async () => {
        if (!confirm(`Delete the ride on ${fmtDate(ride.ride_date)}?`)) return;
        try { await api('DELETE', `/api/rides/${ride.id}`); toast('Ride deleted'); await refreshAfterChange(t.id); } catch (e) { fail(e); }
      });
    });
    $$('.photo-grid [data-photo]').forEach((b) => b.addEventListener('click', () => openPhoto(t, Number(b.dataset.photo), b.dataset.cap)));
    $('#photo-input').addEventListener('change', (e) => uploadPhotos(t, Array.from(e.target.files || [])));
  }

  function backToList() {
    S.selectedId = null;
    setHash('');
    renderList();
    drawTrailsOnMap();
  }

  async function refreshAfterChange(id) {
    await loadTrails();
    drawTrailsOnMap();
    if (id && S.trails.some((t) => t.id === id)) openTrail(id);
    else backToList();
  }

  // ----- Rider picker used by ride forms -----
  function riderPicker(selected = []) {
    const names = allRiderNames();
    const extra = selected.filter((s) => !names.includes(s));
    return `<div class="field-label">Who rode
      <div class="rider-pick">
        ${[...names, ...extra].map((n) => `<label><input type="checkbox" name="rider" value="${esc(n)}" ${selected.includes(n) ? 'checked' : ''}>${esc(n)}</label>`).join('')}
      </div></div>
      <label>Other riders (guests), separated by commas<input type="text" name="guests" placeholder="e.g. Jake, Sam"></label>`;
  }
  function readRiders(form) {
    const picked = $$('input[name=rider]:checked', form).map((i) => i.value);
    const guests = (form.elements.guests.value || '').split(',').map((s) => s.trim()).filter(Boolean);
    return Array.from(new Set([...picked, ...guests]));
  }

  function rideForm(trail, ride) {
    const slot = $('#ride-form-slot');
    const meName = S.me.name;
    slot.innerHTML = `
      <form class="form card" id="ride-form">
        <legend style="font-family:var(--font-sign);font-weight:700;font-size:18px">${ride ? 'Edit ride' : 'Log a ride'}</legend>
        <div class="grid-2">
          <label>Date<input type="date" name="ride_date" required value="${esc(ride ? ride.ride_date : today())}"></label>
          <label>Conditions<input type="text" name="conditions" placeholder="Dry, muddy, snow…" value="${esc(ride ? ride.conditions || '' : '')}"></label>
        </div>
        ${riderPicker(ride ? ride.riders : [meName])}
        <label>Notes<textarea name="notes" placeholder="Anything worth remembering about this ride">${esc(ride ? ride.notes || '' : '')}</textarea></label>
        <p class="form-error" id="ride-err"></p>
        <div class="btn-row"><button class="btn btn-primary" type="submit">${ride ? 'Save ride' : 'Log ride'}</button><button class="btn btn-ghost" type="button" id="ride-cancel">Cancel</button></div>
      </form>`;
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('#ride-cancel').addEventListener('click', () => renderDetailAgain(trail.id));
    $('#ride-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { ride_date: f.elements.ride_date.value, conditions: f.elements.conditions.value.trim(), notes: f.elements.notes.value.trim(), riders: readRiders(f) };
      try {
        if (ride) await api('PUT', `/api/rides/${ride.id}`, body);
        else await api('POST', `/api/trails/${trail.id}/rides`, body);
        toast(ride ? 'Ride saved' : 'Ride logged');
        await refreshAfterChange(trail.id);
      } catch (err) { $('#ride-err').textContent = err.message; }
    });
  }
  const renderDetailAgain = (id) => openTrail(id);

  // ----- Photos -----
  function resizeImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image'))), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name} can't be read as an image`)); };
      img.src = url;
    });
  }
  async function uploadPhotos(trail, files) {
    if (!files.length) return;
    let done = 0;
    for (const file of files) {
      toast(`Uploading photo ${done + 1} of ${files.length}…`);
      try {
        const [big, small] = await Promise.all([resizeImage(file, 1800, 0.84), resizeImage(file, 420, 0.74)]);
        const fd = new FormData();
        fd.append('photo', big, 'photo.jpg');
        fd.append('thumb', small, 'thumb.jpg');
        await api('POST', `/api/trails/${trail.id}/photos`, fd, true);
        done++;
      } catch (e) { fail(e); }
    }
    if (done) toast(`${done} ${done === 1 ? 'photo' : 'photos'} added`);
    await refreshAfterChange(trail.id);
  }
  function openPhoto(trail, id, caption) {
    const dlg = $('#lightbox');
    $('#lightbox-img').src = `/api/photos/${id}`;
    $('#lightbox-img').alt = caption || `Photo on ${trail.name}`;
    $('#lightbox-cap').innerHTML = `${esc(caption)} <span style="margin-left:10px"><button class="link-btn" id="cap-edit" style="color:#e8c547">Edit caption</button> · <button class="link-btn" id="photo-del" style="color:#f0a097">Delete</button></span>`;
    $('#cap-edit').onclick = async () => {
      const c = prompt('Photo caption', caption || '');
      if (c === null) return;
      try { await api('PUT', `/api/photos/${id}`, { caption: c }); dlg.close(); await refreshAfterChange(trail.id); } catch (e) { fail(e); }
    };
    $('#photo-del').onclick = async () => {
      if (!confirm('Delete this photo?')) return;
      try { await api('DELETE', `/api/photos/${id}`); dlg.close(); toast('Photo deleted'); await refreshAfterChange(trail.id); } catch (e) { fail(e); }
    };
    dlg.showModal();
  }
  $('#lightbox').addEventListener('click', (e) => { if (e.target.id === 'lightbox') e.target.close(); });

  // ----- Create / edit trail form -----
  function openForm(data) {
    S.form = {
      id: data.existing ? data.id : null,
      geometry: data.geometry,
      geomChanged: !data.existing,
      source: data.source || 'drawn',
      rating: data.rating || 0,
    };
    S.selectedId = data.existing ? data.id : null;
    S.view = 'form';
    setTab('list');
    drawTrailsOnMap();
    showDraft(S.form.geometry);
    fitGeometry(S.form.geometry);
    if (matchMedia('(max-width: 760px)').matches) setSheet('expanded');

    const existing = !!data.existing;
    const states = Array.from(new Set(['UT', 'ID', 'NV', 'AZ', 'CO', 'WY', ...S.trails.map((t) => t.state).filter(Boolean)]));
    view.innerHTML = `
      <button class="link-btn back" id="form-back">‹ ${existing ? 'Back to trail' : 'All trails'}</button>
      <h2>${existing ? 'Edit trail' : 'New trail'}</h2>
      <form class="form" id="trail-form" style="margin-top:14px" novalidate>
        <div class="geom-box">
          <div><b id="geom-miles"></b> <span class="muted small" id="geom-pts"></span></div>
          <div class="btn-row">
            <button type="button" class="btn btn-secondary btn-small" id="g-edit">Edit points</button>
            <button type="button" class="btn btn-secondary btn-small" id="g-add">Draw another section</button>
            <label class="btn btn-secondary btn-small">Replace with GPX<input type="file" id="g-gpx" accept=".gpx,.kml" hidden></label>
            <button type="button" class="btn btn-secondary btn-small" id="g-redraw">Redraw</button>
          </div>
        </div>
        <label>Trail name<input type="text" name="name" required maxlength="120" value="${esc(data.name || '')}" placeholder="e.g. Hell's Revenge"></label>
        <div class="grid-2">
          <label>Area<input type="text" name="area" maxlength="120" value="${esc(data.area || '')}" placeholder="e.g. Moab" list="areas"></label>
          <label>State<input type="text" name="state" maxlength="40" value="${esc(data.state || '')}" list="states"></label>
        </div>
        <datalist id="areas">${Array.from(new Set(S.trails.map((t) => t.area).filter(Boolean))).map((a) => `<option value="${esc(a)}">`).join('')}</datalist>
        <datalist id="states">${states.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
        <div class="field-label">Difficulty
          <div class="diff-pick">
            ${DIFFS.map((d) => `<label class="diff-${d}"><input type="radio" name="difficulty" value="${d}" ${data.difficulty === d ? 'checked' : ''}><span class="diff-icon"></span>${d}</label>`).join('')}
          </div>
        </div>
        <div class="grid-2">
          <label>Trail type
            <select name="trail_type"><option value="">—</option>${TYPES.map((x) => `<option ${data.trail_type === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
          </label>
          <div class="field-label">Rating
            <div class="rating-pick" id="rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-n="${n}" aria-label="${n} stars">★</button>`).join('')}</div>
          </div>
        </div>
        <div class="field-label">Line color
          <div class="color-row">
            <label style="display:flex;flex-direction:row;align-items:center;gap:6px;font-weight:500;color:var(--ink)"><input type="checkbox" id="custom-color" ${data.color ? 'checked' : ''}> Use a custom color</label>
            <input type="color" name="color" value="${esc(data.color || '#d0572f')}" ${data.color ? '' : 'disabled'} aria-label="Line color">
          </div>
        </div>
        <label>Notes<textarea name="notes" placeholder="Gas, water, parking, tricky sections, seasonal closures…">${esc(data.notes || '')}</textarea></label>
        ${existing ? '' : `
        <fieldset>
          <legend>Log a ride on this trail</legend>
          <label>Date ridden (leave blank to skip)<input type="date" name="ride_date" value="${esc(data.rideDate || '')}"></label>
          ${riderPicker([S.me.name])}
        </fieldset>`}
        <p class="form-error" id="form-err"></p>
        <div class="sticky-actions btn-row">
          <button class="btn btn-primary" type="submit">${existing ? 'Save changes' : 'Save trail'}</button>
          <button class="btn btn-ghost" type="button" id="form-cancel">Cancel</button>
          ${existing ? '<button class="btn btn-danger" type="button" id="form-delete" style="margin-left:auto">Delete trail</button>' : ''}
        </div>
      </form>`;

    const form = $('#trail-form');
    const updateGeomInfo = () => {
      const g = S.form.geometry;
      $('#geom-miles').textContent = `${fmtMi(geomMiles(g))} mi`;
      $('#geom-pts').textContent = `${geomPoints(g).toLocaleString()} points${g.coordinates.length > 1 ? ` in ${g.coordinates.length} sections` : ''}`;
    };
    updateGeomInfo();

    const setRating = (n) => {
      S.form.rating = S.form.rating === n ? 0 : n;
      $$('#rating button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) <= S.form.rating));
    };
    $$('#rating button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.n) <= S.form.rating);
      b.addEventListener('click', () => setRating(Number(b.dataset.n)));
    });
    $('#custom-color').addEventListener('change', (e) => { form.elements.color.disabled = !e.target.checked; });

    const geomChanged = (g) => {
      S.form.geometry = g;
      S.form.geomChanged = true;
      showDraft(g);
      updateGeomInfo();
    };
    const withMap = async (fn) => {
      showDraft(null);
      const g = await fn();
      if (g) geomChanged(g); else showDraft(S.form.geometry);
      if (matchMedia('(max-width: 760px)').matches) setSheet('expanded');
    };
    $('#g-edit').addEventListener('click', () => withMap(() => editLine(S.form.geometry)));
    $('#g-add').addEventListener('click', () => {
      // keep the current line visible while drawing the extra section
      withMap(async () => { showDraft(S.form.geometry); const g = await drawLine(); return g ? mergeGeoms(S.form.geometry, g) : null; });
    });
    $('#g-redraw').addEventListener('click', () => withMap(() => drawLine()));
    $('#g-gpx').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      const [t] = await readFiles(files);
      if (t) { S.form.source = 'gpx'; geomChanged(t.geometry); fitGeometry(t.geometry); }
    });

    const leave = () => {
      const id = S.form.id;
      closeForm();
      if (id) openTrail(id); else backToList();
    };
    $('#form-back').addEventListener('click', leave);
    $('#form-cancel').addEventListener('click', leave);
    if (existing) {
      $('#form-delete').addEventListener('click', async () => {
        if (!confirm(`Delete "${data.name}" with all its rides and photos? This can't be undone.`)) return;
        try {
          await api('DELETE', `/api/trails/${data.id}`);
          closeForm();
          toast('Trail deleted');
          await refreshAfterChange(null);
        } catch (e) { fail(e); }
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (S.mode) return toast('Finish the map edit first', true);
      const el = form.elements;
      const name = el.name.value.trim();
      if (!name) { $('#form-err').textContent = 'Give the trail a name.'; el.name.focus(); return; }
      const body = {
        name,
        area: el.area.value.trim(),
        state: el.state.value.trim(),
        difficulty: (form.querySelector('input[name=difficulty]:checked') || {}).value || null,
        trail_type: el.trail_type.value || null,
        rating: S.form.rating || null,
        color: $('#custom-color').checked ? el.color.value : null,
        notes: el.notes.value.trim(),
        source: S.form.source,
      };
      if (S.form.geomChanged) body.geometry = S.form.geometry;
      if (!existing && el.ride_date.value) {
        body.ride = { ride_date: el.ride_date.value, riders: readRiders(form) };
      }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        let id = S.form.id;
        if (existing) await api('PUT', `/api/trails/${id}`, body);
        else id = (await api('POST', '/api/trails', body)).id;
        closeForm();
        toast(existing ? 'Changes saved' : 'Trail saved');
        await refreshAfterChange(id);
      } catch (err) {
        $('#form-err').textContent = err.message;
        btn.disabled = false;
      }
    });
    setTimeout(() => { if (!existing && !data.name) form.elements.name.focus(); }, 50);
  }

  function closeForm() {
    if (S.mode) S.mode.cancel();
    S.form = null;
    showDraft(null);
  }

  // ----- Bulk GPX import -----
  function openBulkImport(tracks) {
    S.view = 'bulk';
    setTab('list');
    const all = { type: 'MultiLineString', coordinates: tracks.flatMap((t) => t.geometry.coordinates) };
    showDraft(all);
    fitGeometry(all);
    view.innerHTML = `
      <button class="link-btn back" id="bulk-back">‹ All trails</button>
      <h2>Import ${tracks.length} trails</h2>
      <p class="muted" style="margin-top:6px">Each file becomes its own trail. Check the names now; you can add difficulty, notes and photos to each one afterward.</p>
      <form class="form" id="bulk-form">
        ${tracks.map((t, i) => `
          <div class="card" style="margin:0">
            <label>Trail name<input type="text" name="name-${i}" value="${esc(t.name)}" required></label>
            <div class="small muted" style="margin-top:6px">${esc(t.fileName)} · ${fmtMi(geomMiles(t.geometry))} mi${t.date ? ` · recorded ${fmtDate(t.date)}` : ''}</div>
          </div>`).join('')}
        <label style="display:flex;flex-direction:row;gap:8px;align-items:center;color:var(--ink);font-weight:500">
          <input type="checkbox" id="bulk-rides" checked> Log a ride on each file's recorded date
        </label>
        ${riderPicker([S.me.name])}
        <p class="form-error" id="bulk-err"></p>
        <div class="btn-row"><button class="btn btn-primary" type="submit">Import ${tracks.length} trails</button><button class="btn btn-ghost" type="button" id="bulk-cancel">Cancel</button></div>
      </form>`;
    const cancel = () => { showDraft(null); backToList(); };
    $('#bulk-back').addEventListener('click', cancel);
    $('#bulk-cancel').addEventListener('click', cancel);
    $('#bulk-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const riders = readRiders(form);
      const logRides = $('#bulk-rides').checked;
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      let ok = 0;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const body = { name: form.elements[`name-${i}`].value.trim() || t.name, geometry: t.geometry, source: 'gpx' };
        if (logRides && t.date) body.ride = { ride_date: t.date, riders };
        try { await api('POST', '/api/trails', body); ok++; } catch (err) { fail(new Error(`${t.fileName}: ${err.message}`)); }
      }
      showDraft(null);
      toast(`Imported ${ok} of ${tracks.length} trails`);
      await loadTrails();
      backToList();
      fitAll();
    });
  }

  // ----- Stats -----
  async function renderStats() {
    S.view = 'stats';
    setTab('stats');
    view.innerHTML = '<p class="muted">Loading…</p>';
    let s;
    try { s = await api('GET', '/api/stats'); } catch (e) { return fail(e); }
    if (S.view !== 'stats') return;
    const maxMiles = Math.max(1, ...s.riders.map((r) => r.miles));
    view.innerHTML = `
      <h2>Group stats</h2>
      <div class="big-stats" style="margin-top:14px">
        <div><b>${s.trails}</b><span>trails on the map</span></div>
        <div><b>${fmtMi(s.miles)}</b><span>miles of trail</span></div>
        <div><b>${s.rides}</b><span>rides logged</span></div>
        <div><b>${s.trails_ridden}</b><span>trails with a logged ride</span></div>
      </div>
      <h3>Riders</h3>
      ${s.riders.length ? `<table class="tbl"><thead><tr><th>Rider</th><th class="num">Rides</th><th class="num">Trails</th><th class="num">Miles</th></tr></thead><tbody>
        ${s.riders.map((r) => `<tr><td>${esc(r.rider)}<div class="bar" style="width:${(r.miles / maxMiles) * 100}%"></div></td><td class="num">${r.rides}</td><td class="num">${r.trails}</td><td class="num">${fmtMi(r.miles)}</td></tr>`).join('')}
      </tbody></table><p class="small muted" style="margin-top:6px">Miles count the trail's length each time a rider logs a ride on it.</p>` : '<p class="muted">Log rides on trails to see who has ridden the most.</p>'}
      ${s.years.length ? `<h3>By year</h3><table class="tbl"><thead><tr><th>Year</th><th class="num">Rides</th><th class="num">Trail miles</th></tr></thead><tbody>
        ${s.years.map((y) => `<tr><td>${y.year}</td><td class="num">${y.rides}</td><td class="num">${fmtMi(y.miles)}</td></tr>`).join('')}</tbody></table>` : ''}`;
  }

  // ----- Account & admin -----
  async function renderAccount() {
    S.view = 'account';
    setTab('account');
    const me = S.me;
    view.innerHTML = `
      <h2>${esc(me.name)}</h2>
      <p class="muted">Signed in as ${esc(me.username)}${me.isAdmin ? ' · admin' : ''}</p>
      <div class="btn-row"><button class="btn btn-secondary btn-small" id="logout">Sign out</button></div>

      <h3>Change password</h3>
      <form class="form" id="pw-form">
        <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
        <label>New password (8+ characters)<input type="password" name="next" autocomplete="new-password" minlength="8" required></label>
        <p class="form-error" id="pw-err"></p>
        <div><button class="btn btn-dark btn-small" type="submit">Change password</button></div>
      </form>

      <h3>Back up and export</h3>
      <p class="small muted">Download every trail as one GPX for onX, Gaia or a GPS unit, or a full backup with rides and notes.</p>
      <div class="btn-row">
        <a class="btn btn-secondary btn-small" href="/api/export/gpx">All trails (GPX)</a>
        <a class="btn btn-secondary btn-small" href="/api/export/geojson">Full backup (GeoJSON)</a>
      </div>
      <div id="admin"></div>`;
    $('#logout').addEventListener('click', async () => { await api('POST', '/api/logout'); location.href = '/login'; });
    $('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('POST', '/api/me/password', { current: f.elements.current.value, next: f.elements.next.value });
        f.reset(); $('#pw-err').textContent = ''; toast('Password changed');
      } catch (err) { $('#pw-err').textContent = err.message; }
    });
    if (me.isAdmin) renderAdmin();
  }

  async function renderAdmin() {
    S.users = await api('GET', '/api/users');
    const box = $('#admin');
    if (!box) return;
    box.innerHTML = `
      <h3>Group members</h3>
      ${S.users.map((u) => `
        <div class="user-row" data-id="${u.id}">
          <div class="who"><b>${esc(u.display_name)}${u.is_admin ? '<span class="badge">Admin</span>' : ''}</b><span>${esc(u.username)}</span></div>
          <div class="ride-actions">
            <button class="link-btn" data-act="rename">Rename</button>
            <button class="link-btn" data-act="reset">Reset password</button>
            ${u.id !== S.me.id ? `<button class="link-btn" data-act="admin">${u.is_admin ? 'Remove admin' : 'Make admin'}</button><button class="link-btn danger" data-act="del">Remove</button>` : ''}
          </div>
        </div>`).join('')}
      <form class="form card" id="user-form">
        <legend style="font-family:var(--font-sign);font-weight:700;font-size:18px">Add a member</legend>
        <div class="grid-2">
          <label>Name shown on rides<input type="text" name="display_name" placeholder="Mike" required></label>
          <label>Username<input type="text" name="username" placeholder="mike" autocapitalize="none" required></label>
        </div>
        <label>Temporary password (8+ characters)<input type="text" name="password" minlength="8" required></label>
        <label style="display:flex;flex-direction:row;gap:8px;align-items:center;color:var(--ink);font-weight:500"><input type="checkbox" name="is_admin"> Can manage members</label>
        <p class="form-error" id="user-err"></p>
        <div><button class="btn btn-dark btn-small" type="submit">Add member</button></div>
      </form>`;
    $$('.user-row', box).forEach((row) => {
      const u = S.users.find((x) => x.id === Number(row.dataset.id));
      row.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
        try {
          if (b.dataset.act === 'rename') {
            const n = prompt('Name shown on rides', u.display_name);
            if (!n || !n.trim()) return;
            await api('PUT', `/api/users/${u.id}`, { display_name: n.trim() });
            if (u.id === S.me.id) S.me.name = n.trim();
            toast('Name updated');
            renderAdmin();
          } else if (b.dataset.act === 'reset') {
            const pw = prompt(`New password for ${u.display_name} (8+ characters)`);
            if (!pw) return;
            await api('PUT', `/api/users/${u.id}`, { password: pw });
            toast(`Password reset for ${u.display_name}`);
          } else if (b.dataset.act === 'admin') {
            await api('PUT', `/api/users/${u.id}`, { is_admin: !u.is_admin });
            renderAdmin();
          } else if (b.dataset.act === 'del') {
            if (!confirm(`Remove ${u.display_name}? Their trails and rides stay on the map.`)) return;
            await api('DELETE', `/api/users/${u.id}`);
            toast(`${u.display_name} removed`);
            renderAdmin();
          }
        } catch (e) { fail(e); }
      }));
    });
    $('#user-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('POST', '/api/users', {
          display_name: f.elements.display_name.value.trim(), username: f.elements.username.value.trim(),
          password: f.elements.password.value, is_admin: f.elements.is_admin.checked,
        });
        toast('Member added. Send them the username and temporary password.');
        renderAdmin();
      } catch (err) { $('#user-err').textContent = err.message; }
    });
  }

  // ---------- Start ----------
  async function start() {
    try {
      const [me, cfg, users] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/config'), api('GET', '/api/users')]);
      S.me = me;
      S.users = users;
      $('#app-name').textContent = cfg.appName;
      document.title = cfg.appName;
      await loadTrails();
    } catch (e) { return fail(e); }
    drawTrailsOnMap();
    const m = location.hash.match(/^#trail\/(\d+)/);
    if (m && S.trails.some((t) => t.id === Number(m[1]))) {
      openTrail(Number(m[1]), { fit: true });
    } else {
      renderList();
      fitAll();
    }
  }
  start();
})();
