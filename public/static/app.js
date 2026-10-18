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
    let res;
    try { res = await fetch(url, opts); } catch {
      throw new Error(method === 'GET' ? "No connection, and this isn't saved on this device yet." : "No connection. This can't be saved until you have signal.");
    }
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
  const sectionColor = (t, i) => (t.sections && t.sections[i] && t.sections[i].color) || lineColor(t);
  const hasSections = (t) => t.geometry.coordinates.length > 1 || (t.sections || []).some((x) => x && (x.color || x.label));
  const lineMiles = (line) => line.reduce((s, c, i) => (i ? s + haversineMi(line[i - 1], c) : 0), 0);
  // Keep the sections list the same length as the geometry's lines
  const fitSections = (secs, n) => Array.from({ length: n }, (_, i) => ({ color: null, label: null, ...((secs || [])[i] || {}) }));
  const SECTION_SWATCHES = ['#d0572f', '#e8c547', '#2e8b57', '#2b6cb0', '#7a4bb3', '#1f2622', '#c2185b', '#8a6a3b'];
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
    filters: { q: '', diff: '', state: '', rider: '', sort: 'name', ridden: store.get('ridden') || '' },
    waypoints: [],
    planned: [],
    listMode: 'trails',          // Trails tab shows trails or waypoints
    wpFilter: { q: '', kind: '' },
    wpForm: null,                // waypoint being created or edited
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
    'USGS satellite': L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, maxNativeZoom: 16, attribution: 'USGS The National Map',
    }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    }),
    'Streets': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Streets © Esri, HERE, Garmin, © OpenStreetMap contributors',
    }),
    'Satellite + roads': L.layerGroup([
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri, Maxar' }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }),
    ]),
  };
  // ----- State outlines (bundled boundary file), with states we've ridden shaded -----
  map.createPane('states');
  map.getPane('states').style.zIndex = 350; // above base maps, below trail lines
  map.getPane('states').style.pointerEvents = 'none';
  const stateLayer = L.layerGroup();
  let stateFeatures = [];
  let stateShapes = null;
  const STATE_STYLE = { pane: 'states', interactive: false, color: '#5b3f8c', weight: 2, opacity: 0.85, fill: true, fillOpacity: 0, dashArray: '8 5' };

  function bbox(geom) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }
  function inRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inGeom(pt, f) {
    const b = f._bbox;
    if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) return false;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    return polys.some((poly) => inRing(pt, poly[0]) && !poly.slice(1).some((hole) => inRing(pt, hole)));
  }
  // Which states each trail passes through (checks points along the line)
  function trailStates(t) {
    const found = new Set();
    for (const line of t.geometry.coordinates) {
      const step = Math.max(1, Math.floor(line.length / 25));
      for (let i = 0; i < line.length; i += step) {
        for (const f of stateFeatures) if (inGeom(line[i], f)) { found.add(f.properties.abbr); break; }
      }
    }
    return found;
  }
  function riddenStates() {
    const s = new Map();
    for (const t of S.trails) for (const abbr of trailStates(t)) s.set(abbr, (s.get(abbr) || 0) + 1);
    return s;
  }
  function labelPoint(f) {
    // centre of the largest polygon's bounding box; good enough for a label
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let best = null; let area = -1;
    for (const p of polys) {
      const b = bbox({ type: 'Polygon', coordinates: p });
      const a = (b[2] - b[0]) * (b[3] - b[1]);
      if (a > area) { area = a; best = b; }
    }
    return [(best[1] + best[3]) / 2, (best[0] + best[2]) / 2];
  }
  function shadeStates() {
    if (!stateShapes) return;
    const ridden = riddenStates();
    stateShapes.eachLayer((l) => {
      const n = ridden.get(l.feature.properties.abbr) || 0;
      l.setStyle({ fillColor: '#e8c547', fillOpacity: n ? 0.16 : 0 });
    });
  }
  fetch('/static/data/us-states.json').then((r) => r.json()).then((fc) => {
    stateFeatures = fc.features.map((f) => Object.assign(f, { _bbox: bbox(f.geometry) }));
    stateShapes = L.geoJSON(fc, { style: () => STATE_STYLE }).addTo(stateLayer);
    for (const f of stateFeatures) {
      L.marker(labelPoint(f), {
        pane: 'states', interactive: false, keyboard: false,
        icon: L.divIcon({ className: 'state-label', html: `<span>${esc(f.properties.name)}</span>`, iconSize: null }),
      }).addTo(stateLayer);
    }
    shadeStates();
    if (S.view === 'stats') renderStats();
  }).catch(() => { /* outlines are optional; the map still works without them */ });
  const updateLabelZoom = () => map.getContainer().classList.toggle('state-labels-on', map.getZoom() >= 5 && map.getZoom() <= 8);
  map.on('zoomend', updateLabelZoom);
  updateLabelZoom();

  const waypointLayer = L.layerGroup();
  const overlays = {
    'Waypoints': waypointLayer,
    'State lines': stateLayer,
    'Known trails (OSM)': L.tileLayer('https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png', {
      maxZoom: 18, opacity: 0.8, attribution: 'Trails: © waymarkedtrails.org',
    }),
  };
  const savedBase = store.get('basemap');
  (bases[savedBase] || bases.Topo).addTo(map);
  // Remember which overlays are on or off; new overlays start with their default
  const OVERLAY_DEFAULTS = { 'Waypoints': true, 'State lines': true, 'Known trails (OSM)': false };
  let overlayPrefs;
  try { overlayPrefs = JSON.parse(store.get('overlays2')) || {}; } catch { overlayPrefs = {}; }
  Object.keys(overlays).forEach((name) => {
    const on = name in overlayPrefs ? overlayPrefs[name] : OVERLAY_DEFAULTS[name];
    if (on) overlays[name].addTo(map);
  });
  L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => store.set('basemap', e.name));
  function setBase(name) {
    if (!bases[name]) return;
    Object.values(bases).forEach((l) => { if (map.hasLayer(l)) map.removeLayer(l); });
    bases[name].addTo(map);
    store.set('basemap', name);
  }
  const saveOverlays = () => {
    const prefs = {};
    Object.keys(overlays).forEach((n) => { prefs[n] = map.hasLayer(overlays[n]); });
    store.set('overlays2', JSON.stringify(prefs));
  };
  map.on('overlayadd overlayremove', saveOverlays);
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
      const unridden = !t.ride_count;
      const lines = ll.map((part, i) => L.polyline(part, { color: sectionColor(t, i), weight: selected ? 6 : unridden ? 5 : 4, opacity: dim ? 0.5 : 1, interactive: false,
        lineCap: 'round', dashArray: unridden ? '1 9' : t.difficulty === 'Expert' ? '10 6' : null }));
      const hit = L.polyline(ll, { color: '#000', weight: 20, opacity: 0, pmIgnore: true });
      hit.bindTooltip(t.name, { sticky: true, className: 'trail-tip', direction: 'top', offset: [0, -8] });
      hit.on('click', () => { if (!S.mode) openTrail(t.id); });
      hit.on('mouseover', () => { const el = $(`.trail-item[data-id="${t.id}"]`); if (el) el.classList.add('hover'); });
      hit.on('mouseout', () => { const el = $(`.trail-item[data-id="${t.id}"]`); if (el) el.classList.remove('hover'); });
      const g = L.featureGroup([casing, ...lines, hit]);
      g.addTo(trailLayer);
      layerById.set(t.id, g);
    }
    // keep the selected trail on top
    if (S.selectedId && layerById.has(S.selectedId)) layerById.get(S.selectedId).eachLayer((l) => l.bringToFront());
  }

  function showDraft(geometry, sections, highlight = -1, withBreaks = false) {
    if (draftLayer) { map.removeLayer(draftLayer); draftLayer = null; }
    if (!geometry) return;
    const ll = toLatLngs(geometry);
    const secs = sections || [];
    const layers = [L.polyline(ll, { color: '#24302b', weight: 9, opacity: 0.85, interactive: false, pmIgnore: true })];
    ll.forEach((part, i) => {
      const c = (secs[i] && secs[i].color) || '#e8c547';
      if (i === highlight) layers.push(L.polyline(part, { color: '#fff', weight: 13, opacity: 0.9, interactive: false, pmIgnore: true }));
      layers.push(L.polyline(part, { color: c, weight: i === highlight ? 8 : 5, interactive: false, pmIgnore: true }));
    });
    if (withBreaks && ll.length > 1) {
      // dots where one section ends and the next begins
      ll.slice(1).forEach((part) => layers.push(L.circleMarker(part[0], { radius: 6, color: '#24302b', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false, pmIgnore: true })));
    }
    draftLayer = L.featureGroup(layers).addTo(map);
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

  function showModeBar(text, { undo = false, undoLabel = 'Undo point', doneLabel = 'Finish', hideDone = false } = {}) {
    $('#mode-text').textContent = text;
    $('#mode-undo').hidden = !undo;
    $('#mode-undo').textContent = undoLabel;
    $('#mode-done').textContent = doneLabel;
    $('#mode-done').hidden = hideDone;
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

  // Split a line into sections by tapping on it. Resolves with { geometry, sections } or null if cancelled.
  function splitLine(geometry, sections) {
    return new Promise((resolve) => {
      let geom = JSON.parse(JSON.stringify(geometry));
      let secs = fitSections(sections, geom.coordinates.length);
      let splits = 0;
      showDraft(geom, secs, -1, true);
      map.getContainer().classList.add('crosshair');
      const onClick = (e) => {
        // find the closest point on any line, measured in screen pixels
        const p = map.latLngToLayerPoint(e.latlng);
        let best = null;
        geom.coordinates.forEach((line, li) => {
          for (let k = 0; k < line.length - 1; k++) {
            const a = map.latLngToLayerPoint([line[k][1], line[k][0]]);
            const b = map.latLngToLayerPoint([line[k + 1][1], line[k + 1][0]]);
            const dx = b.x - a.x; const dy = b.y - a.y;
            const len2 = dx * dx + dy * dy || 1;
            const tt = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
            const d = Math.hypot(a.x + tt * dx - p.x, a.y + tt * dy - p.y);
            if (!best || d < best.d) best = { d, li, k, tt };
          }
        });
        if (!best || best.d > 24) return toast('Tap right on the trail line to split it', true);
        const line = geom.coordinates[best.li];
        const A = line[best.k]; const B = line[best.k + 1];
        let first; let second;
        if (best.tt < 0.02) { first = line.slice(0, best.k + 1); second = line.slice(best.k); }
        else if (best.tt > 0.98) { first = line.slice(0, best.k + 2); second = line.slice(best.k + 1); }
        else {
          const P = [A[0] + (B[0] - A[0]) * best.tt, A[1] + (B[1] - A[1]) * best.tt];
          if (A.length > 2 && B.length > 2) P.push(Math.round((A[2] + (B[2] - A[2]) * best.tt) * 10) / 10);
          first = [...line.slice(0, best.k + 1), P];
          second = [P, ...line.slice(best.k + 1)];
        }
        if (first.length < 2 || second.length < 2) return toast("That's the end of the line. Tap somewhere in the middle.", true);
        geom.coordinates.splice(best.li, 1, first, second);
        // the new piece starts with the same color and label; change it in the list afterward
        secs.splice(best.li + 1, 0, { ...secs[best.li] });
        splits++;
        showDraft(geom, secs, -1, true);
        $('#mode-text').textContent = `${splits} ${splits === 1 ? 'split' : 'splits'}, ${geom.coordinates.length} sections. Keep tapping to add more, or tap Done.`;
      };
      map.on('click', onClick);
      S.mode = {
        type: 'split',
        cancel: () => finish(null),
        done: () => finish(splits ? { geometry: geom, sections: secs } : null),
      };
      function finish(result) {
        map.off('click', onClick);
        map.getContainer().classList.remove('crosshair');
        S.mode = null;
        hideModeBar();
        resolve(result);
      }
      showModeBar('Tap the trail where each new section should start.', { doneLabel: 'Done' });
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
    const points = [];
    let name = null;
    let date = null;
    for (const f of fc.features) {
      if (!f.geometry) continue;
      const g = f.geometry;
      if (g.type === 'Point') {
        const pr = f.properties || {};
        const wpName = String(pr.name || pr.desc || 'Waypoint').trim().slice(0, 100);
        points.push({ name: wpName, kind: guessKind(`${wpName} ${pr.sym || ''} ${pr.type || ''}`), notes: pr.desc && pr.desc !== wpName ? String(pr.desc).slice(0, 3000) : (pr.cmt || null), lat: g.coordinates[1], lng: g.coordinates[0] });
        continue;
      }
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
    if (!lines.length && !points.length) throw new Error(`${file.name} has no track, route or waypoints in it`);
    return {
      fileName: file.name,
      points,
      name: name || file.name.replace(/\.(gpx|kml)$/i, '').replace(/[_-]+/g, ' ').trim(),
      date,
      geometry: lines.length ? { type: 'MultiLineString', coordinates: lines } : null,
    };
  }

  function guessKind(text) {
    const t = text.toLowerCase();
    if (/gas|fuel|petrol|station/.test(t)) return 'gas';
    if (/camp|tent|campground|site/.test(t)) return 'camp';
    if (/water|spring|creek|drink/.test(t)) return 'water';
    if (/danger|hazard|caution|careful|warning|wash ?out|cliff|drop|ledge|steep|\bruts?\b|mud ?hole|washed/.test(t)) return 'hazard';
    if (/view|scenic|overlook|vista|photo|arch|bridge/.test(t)) return 'view';
    if (/trail ?head|parking|staging|unload|start|lot/.test(t)) return 'trailhead';
    if (/food|restaurant|cafe|diner|burger|grill|eat/.test(t)) return 'food';
    return 'other';
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
    const parsed = await readFiles(files);
    if (!parsed.length) return;
    const tracks = parsed.filter((t) => t.geometry);
    const pointsOnly = parsed.filter((t) => !t.geometry).flatMap((t) => t.points);
    if (pointsOnly.length) {
      if (confirm(`Add ${pointsOnly.length} ${pointsOnly.length === 1 ? 'waypoint' : 'waypoints'} from ${tracks.length ? 'the files without tracks' : 'this file'}?`)) {
        try {
          await api('POST', '/api/waypoints', { waypoints: pointsOnly });
          await loadWaypoints();
          toast(`${pointsOnly.length} waypoints added`);
          if (!tracks.length) fitPoints(pointsOnly);
        } catch (err) { fail(err); }
      }
    }
    if (!tracks.length) return;
    if (tracks.length === 1) {
      const t = tracks[0];
      openForm({ name: t.name, geometry: t.geometry, source: 'gpx', rideDate: t.date, gpxWaypoints: t.points });
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
    shadeStates();
  }
  function filteredTrails() {
    const f = S.filters;
    const q = f.q.toLowerCase();
    let list = S.trails.filter((t) =>
      (!q || [t.name, t.area, t.state, t.notes, t.trail_type].some((v) => v && v.toLowerCase().includes(q))) &&
      (!f.diff || t.difficulty === f.diff) &&
      (!f.state || t.state === f.state) &&
      (!f.rider || (t.riders || []).includes(f.rider)) &&
      riddenMatch(t, f.ridden));
    const by = {
      name: (a, b) => a.name.localeCompare(b.name),
      recent: (a, b) => (b.last_ridden || '').localeCompare(a.last_ridden || '') || a.name.localeCompare(b.name),
      miles: (a, b) => (b.distance_mi || 0) - (a.distance_mi || 0),
      rides: (a, b) => b.ride_count - a.ride_count,
      rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    };
    return list.sort(by[f.sort] || by.name);
  }
  function riddenMatch(t, mode) {
    if (!mode) return true;
    const me = (S.me ? S.me.name : '').toLowerCase();
    const mine = (t.riders || []).some((r) => r.toLowerCase() === me);
    if (mode === 'ridden') return t.ride_count > 0;
    if (mode === 'unridden') return !t.ride_count;
    if (mode === 'me') return mine;
    if (mode === 'notme') return !mine;
    return true;
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
    closeWaypointForm();
    clearPlanMarker();
    S.selectedId = null;
    S.selectedWp = null;
    drawWaypoints();
    setHash('');
    const v = b.dataset.view;
    if (v === 'list') renderList();
    if (v === 'rides') renderRides();
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
    if (S.listMode === 'waypoints') return renderWaypointList();
    const states = Array.from(new Set(S.trails.map((t) => t.state).filter(Boolean))).sort();
    const riders = allRiderNames();
    const f = S.filters;
    view.innerHTML = `
      ${listModeSwitch()}
      <div class="list-tools">
        <input class="search" id="q" type="search" placeholder="Search trails, areas, notes" value="${esc(f.q)}" aria-label="Search trails">
        <div class="filter-row">
          <select id="f-ridden" aria-label="Show">
            <option value="">All trails</option><option value="ridden">Ridden</option><option value="unridden">Not ridden yet</option>
            <option value="me">Ridden by me</option><option value="notme">Not ridden by me</option>
          </select>
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
    $('#f-ridden').value = f.ridden;
    bindListModeSwitch();
    const refresh = () => { renderListItems(); drawTrailsOnMap(); };
    $('#f-ridden').addEventListener('change', (e) => { f.ridden = e.target.value; store.set('ridden', f.ridden); refresh(); });
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
      ${hasSections(t) ? `<h3>Sections</h3><div class="section-list">${t.geometry.coordinates.map((line, i) => `
        <button class="section-item" data-sec="${i}">
          <span class="section-swatch" style="background:${esc(sectionColor(t, i))}"></span>
          <span>${esc((t.sections[i] && t.sections[i].label) || `Section ${i + 1}`)}</span>
          <span class="muted small">${fmtMi(lineMiles(line))} mi</span>
        </button>`).join('')}</div>` : ''}
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

      <h3>Waypoints</h3>
      <div class="wp-mini-list">
        ${S.waypoints.filter((w) => w.trail_id === t.id).map((w) => `
          <button class="wp-mini" data-wp="${w.id}">${wpIconHtml(w.kind, 24)}<span>${esc(w.name)}</span><span class="muted small">${esc(WP_KINDS[w.kind].label)}</span></button>`).join('')
          || '<p class="muted">No waypoints on this trail yet.</p>'}
      </div>
      <button class="btn btn-secondary btn-small" id="add-wp-here">Add a waypoint</button>

      <h3>Photos</h3>
      <div class="photo-grid">
        ${t.photos.map((p) => `<button data-photo="${p.id}" data-cap="${esc(p.caption || '')}"><img loading="lazy" src="/api/photos/${p.id}?thumb=1" alt="${esc(p.caption || `Photo on ${t.name}`)}"></button>`).join('')}
        <label class="photo-add">+ Add photos<input type="file" id="photo-input" accept="image/*" multiple hidden></label>
      </div>

      <div class="detail-foot btn-row">
        <button class="btn btn-secondary btn-small" id="zoom">Zoom to trail</button>
        <a class="btn btn-secondary btn-small" href="/api/trails/${t.id}/gpx">Download GPX</a>
        <button class="btn btn-secondary btn-small" id="copy-link">Copy link</button>
        <button class="btn btn-secondary btn-small" id="plan-here">Plan a ride here</button>
      </div>
      <p class="byline">Added by ${esc(t.created_by_name || 'a former member')} on ${new Date(t.created_at).toLocaleDateString()}${t.updated_by_name && t.updated_at !== t.created_at ? ` · last edited by ${esc(t.updated_by_name)} ${new Date(t.updated_at).toLocaleDateString()}` : ''} · ${t.source === 'gpx' ? 'from a GPX recording' : 'drawn on the map'}</p>`;

    $('#back').addEventListener('click', backToList);
    $('#edit').addEventListener('click', () => openForm({ ...t, existing: true }));
    $('#zoom').addEventListener('click', () => fitGeometry(t.geometry));
    $$('[data-wp]').forEach((b) => b.addEventListener('click', () => openWaypoint(Number(b.dataset.wp))));
    $('#add-wp-here').addEventListener('click', async () => {
      const ll = await pickPoint('Tap the map where the waypoint goes.');
      if (ll) openWaypointForm({ lat: ll.lat, lng: ll.lng, trail_id: t.id, backTo: t.id });
    });
    $('#plan-here').addEventListener('click', () => { setTab('rides'); openPlannedForm({ title: t.name, trail_ids: [t.id] }); });
    $$('[data-sec]').forEach((b) => b.addEventListener('click', () => {
      const i = Number(b.dataset.sec);
      fitGeometry({ type: 'MultiLineString', coordinates: [t.geometry.coordinates[i]] });
      // briefly highlight the section on the map
      const ll = toLatLngs({ coordinates: [t.geometry.coordinates[i]] });
      const flash = L.featureGroup([
        L.polyline(ll, { color: '#fff', weight: 14, opacity: 0.9, interactive: false }),
        L.polyline(ll, { color: sectionColor(t, i), weight: 8, interactive: false }),
      ]).addTo(map);
      setTimeout(() => map.removeLayer(flash), 1800);
    }));
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
      sections: fitSections(data.sections, data.geometry.coordinates.length),
    };
    S.selectedId = data.existing ? data.id : null;
    S.view = 'form';
    setTab('list');
    drawTrailsOnMap();
    showDraft(S.form.geometry, S.form.sections);
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
            <button type="button" class="btn btn-secondary btn-small" id="g-split">Split into sections</button>
          </div>
          <div id="sections"></div>
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
        ${data.gpxWaypoints && data.gpxWaypoints.length ? `
        <label style="display:flex;flex-direction:row;gap:8px;align-items:center;color:var(--ink);font-weight:500">
          <input type="checkbox" id="gpx-wps" checked> Also add the ${data.gpxWaypoints.length} ${data.gpxWaypoints.length === 1 ? 'waypoint' : 'waypoints'} from this file
        </label>` : ''}
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

    const redrawDraft = (hl = -1) => showDraft(S.form.geometry, S.form.sections, hl);
    function renderSections() {
      const box = $('#sections');
      const lines = S.form.geometry.coordinates;
      if (lines.length < 2) {
        box.innerHTML = '<p class="small muted" style="margin:10px 0 0">Want parts of this trail in different colors? Use <b>Split into sections</b>, then pick a color for each piece.</p>';
        return;
      }
      box.innerHTML = `<div class="sections-head">Sections <span class="muted small">— leave a color blank to use the trail's color</span></div>` +
        lines.map((line, i) => {
          const sec = S.form.sections[i];
          return `<div class="section-row" data-i="${i}">
            <div class="section-top">
              <span class="section-num">${i + 1}</span>
              <input type="text" class="section-label" maxlength="60" placeholder="Label, e.g. Rocky climb" value="${esc(sec.label || '')}" aria-label="Section ${i + 1} label">
              <span class="small muted section-mi">${fmtMi(lineMiles(line))} mi</span>
            </div>
            <div class="swatches" role="group" aria-label="Section ${i + 1} color">
              <button type="button" class="swatch-btn none ${sec.color ? '' : 'on'}" data-color="" title="Use the trail's color" aria-label="Use the trail's color"></button>
              ${SECTION_SWATCHES.map((c) => `<button type="button" class="swatch-btn ${sec.color === c ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}
              <input type="color" class="swatch-custom" value="${esc(sec.color || '#d0572f')}" title="Pick any color" aria-label="Pick any color">
            </div>
            <div class="section-actions">
              <button type="button" class="link-btn" data-act="zoom">Zoom to</button>
              ${i < lines.length - 1 ? '<button type="button" class="link-btn" data-act="join">Join with next</button>' : ''}
              <button type="button" class="link-btn danger" data-act="del">Delete section</button>
            </div>
          </div>`;
        }).join('');
      $$('.section-row', box).forEach((row) => {
        const i = Number(row.dataset.i);
        row.addEventListener('mouseenter', () => redrawDraft(i));
        row.addEventListener('mouseleave', () => redrawDraft());
        row.addEventListener('focusin', () => redrawDraft(i));
        row.querySelector('.section-label').addEventListener('input', (e) => { S.form.sections[i].label = e.target.value; });
        const setColor = (c) => {
          S.form.sections[i].color = c || null;
          $$('.swatch-btn', row).forEach((b) => b.classList.toggle('on', (b.dataset.color || null) === (c || null)));
          redrawDraft(i);
        };
        $$('.swatch-btn', row).forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color)));
        row.querySelector('.swatch-custom').addEventListener('input', (e) => setColor(e.target.value));
        row.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
          const g = S.form.geometry;
          if (b.dataset.act === 'zoom') {
            fitGeometry({ type: 'MultiLineString', coordinates: [g.coordinates[i]] });
            redrawDraft(i);
            return;
          }
          if (b.dataset.act === 'join') {
            const a = g.coordinates[i]; const next = g.coordinates[i + 1];
            const touching = haversineMi(a[a.length - 1], next[0]) < 0.003;
            g.coordinates.splice(i, 2, [...a, ...(touching ? next.slice(1) : next)]);
            S.form.sections.splice(i + 1, 1);
          } else if (b.dataset.act === 'del') {
            if (!confirm(`Delete section ${i + 1} from the line?`)) return;
            g.coordinates.splice(i, 1);
            S.form.sections.splice(i, 1);
          }
          S.form.geomChanged = true;
          redrawDraft();
          updateGeomInfo();
          renderSections();
        }));
      });
    }
    renderSections();

    const setRating = (n) => {
      S.form.rating = S.form.rating === n ? 0 : n;
      $$('#rating button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) <= S.form.rating));
    };
    $$('#rating button').forEach((b) => {
      b.classList.toggle('on', Number(b.dataset.n) <= S.form.rating);
      b.addEventListener('click', () => setRating(Number(b.dataset.n)));
    });
    $('#custom-color').addEventListener('change', (e) => { form.elements.color.disabled = !e.target.checked; });

    const geomChanged = (g, sections) => {
      S.form.geometry = g;
      S.form.sections = fitSections(sections !== undefined ? sections : S.form.sections, g.coordinates.length);
      S.form.geomChanged = true;
      redrawDraft();
      updateGeomInfo();
      renderSections();
    };
    const withMap = async (fn) => {
      showDraft(null);
      const g = await fn();
      if (g) geomChanged(g); else redrawDraft();
      if (matchMedia('(max-width: 760px)').matches) setSheet('expanded');
    };
    $('#g-edit').addEventListener('click', () => withMap(() => editLine(S.form.geometry)));
    $('#g-add').addEventListener('click', () => {
      // keep the current line visible while drawing the extra section
      withMap(async () => { redrawDraft(); const g = await drawLine(); return g ? mergeGeoms(S.form.geometry, g) : null; });
    });
    $('#g-redraw').addEventListener('click', async () => {
      showDraft(null);
      const g = await drawLine();
      if (g) geomChanged(g, []); else redrawDraft();
    });
    $('#g-split').addEventListener('click', async () => {
      if (S.mode) return;
      const r = await splitLine(S.form.geometry, S.form.sections);
      if (r) { geomChanged(r.geometry, r.sections); toast(`Now ${r.geometry.coordinates.length} sections. Pick a color for each one below.`); $('#sections').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else redrawDraft();
      if (matchMedia('(max-width: 760px)').matches) setSheet('expanded');
    });
    $('#g-gpx').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      const [t] = await readFiles(files);
      if (t) { S.form.source = 'gpx'; geomChanged(t.geometry, []); fitGeometry(t.geometry); }
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
      body.sections = S.form.sections.map((x) => ({ color: x.color || null, label: (x.label || '').trim() || null }));
      if (!existing && el.ride_date.value) {
        body.ride = { ride_date: el.ride_date.value, riders: readRiders(form) };
      }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        let id = S.form.id;
        if (existing) await api('PUT', `/api/trails/${id}`, body);
        else id = (await api('POST', '/api/trails', body)).id;
        if ($('#gpx-wps') && $('#gpx-wps').checked) {
          await api('POST', '/api/waypoints', { waypoints: data.gpxWaypoints.map((w) => ({ ...w, trail_id: id })) });
          await loadWaypoints();
        }
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
        try {
          const { id } = await api('POST', '/api/trails', body);
          if (t.points.length) await api('POST', '/api/waypoints', { waypoints: t.points.map((w) => ({ ...w, trail_id: id })) });
          ok++;
        } catch (err) { fail(new Error(`${t.fileName}: ${err.message}`)); }
      }
      showDraft(null);
      toast(`Imported ${ok} of ${tracks.length} trails`);
      await loadTrails();
      await loadWaypoints();
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
      ${stateFeatures.length ? (() => {
        const ridden = Array.from(riddenStates().entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const name = (abbr) => (stateFeatures.find((f) => f.properties.abbr === abbr) || { properties: { name: abbr } }).properties.name;
        return `<h3>States ridden</h3>${ridden.length
          ? `<p class="muted small">${ridden.length} ${ridden.length === 1 ? 'state' : 'states'}, shaded yellow on the map when State lines is on.</p>
             <div class="chips">${ridden.map(([a, n]) => `<button class="chip chip-btn" data-state="${esc(a)}">${esc(name(a))} · ${n} ${n === 1 ? 'trail' : 'trails'}</button>`).join('')}</div>`
          : '<p class="muted">Add trails to start filling in the map.</p>'}`;
      })() : ''}
      <h3>Riders</h3>
      ${s.riders.length ? `<table class="tbl"><thead><tr><th>Rider</th><th class="num">Rides</th><th class="num">Trails</th><th class="num">Miles</th></tr></thead><tbody>
        ${s.riders.map((r) => `<tr><td>${esc(r.rider)}<div class="bar" style="width:${(r.miles / maxMiles) * 100}%"></div></td><td class="num">${r.rides}</td><td class="num">${r.trails}</td><td class="num">${fmtMi(r.miles)}</td></tr>`).join('')}
      </tbody></table><p class="small muted" style="margin-top:6px">Miles count the trail's length each time a rider logs a ride on it.</p>` : '<p class="muted">Log rides on trails to see who has ridden the most.</p>'}
      ${s.years.length ? `<h3>By year</h3><table class="tbl"><thead><tr><th>Year</th><th class="num">Rides</th><th class="num">Trail miles</th></tr></thead><tbody>
        ${s.years.map((y) => `<tr><td>${y.year}</td><td class="num">${y.rides}</td><td class="num">${fmtMi(y.miles)}</td></tr>`).join('')}</tbody></table>` : ''}`;
    $$('[data-state]', view).forEach((b) => b.addEventListener('click', () => {
      const f = stateFeatures.find((x) => x.properties.abbr === b.dataset.state);
      if (!f) return;
      if (!map.hasLayer(stateLayer)) { stateLayer.addTo(map); saveOverlays(); }
      map.fitBounds([[f._bbox[1], f._bbox[0]], [f._bbox[3], f._bbox[2]]], { padding: [20, 20] });
    }));
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

      <h3>Offline maps</h3>
      <div id="offline"></div>

      <h3>Back up and export</h3>
      <p class="small muted">Download every trail as one GPX for onX, Gaia or a GPS unit, or a full backup with rides and notes.</p>
      <div class="btn-row">
        <a class="btn btn-secondary btn-small" href="/api/export/gpx">All trails (GPX)</a>
        <a class="btn btn-secondary btn-small" href="/api/export/geojson">Full backup (GeoJSON)</a>
      </div>
      <div id="admin"></div>`;
    $('#logout').addEventListener('click', async () => {
      try { await api('POST', '/api/logout'); } catch { /* offline: still clear this device */ }
      try { await caches.delete('api-v1'); } catch { /* no cache storage */ }
      location.href = '/login';
    });
    renderOffline();
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

  // =====================================================================
  // Waypoints
  // =====================================================================
  const WP_KINDS = {
    gas: { label: 'Gas', color: '#d0572f', glyph: '<rect x="5" y="4" width="8" height="16" rx="1"/><path d="M5 10h8M13 8h2l2 2v6.5a1.5 1.5 0 0 0 3 0V9l-2.5-2.5"/>' },
    camp: { label: 'Camping', color: '#2e8b57', glyph: '<path d="M3 20h18M5 20L12 6l7 14M12 20l-2.5-5h5z"/>' },
    water: { label: 'Water', color: '#2b6cb0', glyph: '<path d="M12 3.5s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>' },
    hazard: { label: 'Hazard', color: '#b23a2b', glyph: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>' },
    view: { label: 'Viewpoint', color: '#7a4bb3', glyph: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>' },
    trailhead: { label: 'Trailhead / parking', color: '#24302b', glyph: '<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>' },
    food: { label: 'Food', color: '#8a6a3b', glyph: '<path d="M7 3v8a2 2 0 0 0 4 0V3M9 3v18M17 3c-2 2-2 6 0 8v10"/>' },
    other: { label: 'Other', color: '#5f6a63', glyph: '<circle cx="12" cy="12" r="4"/>' },
  };
  const wpIconHtml = (kind, size = 28) => {
    const k = WP_KINDS[kind] || WP_KINDS.other;
    return `<span class="wp-icon" style="width:${size}px;height:${size}px;background:${k.color}"><svg viewBox="0 0 24 24" width="${Math.round(size * 0.58)}" height="${Math.round(size * 0.58)}" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${k.glyph}</svg></span>`;
  };
  const wpDivIcon = (kind, big) => L.divIcon({
    className: `wp-marker${big ? ' wp-marker-big' : ''}`,
    html: wpIconHtml(kind, big ? 36 : 28),
    iconSize: big ? [36, 36] : [28, 28],
    iconAnchor: big ? [18, 18] : [14, 14],
  });

  async function loadWaypoints() {
    S.waypoints = await api('GET', '/api/waypoints');
    drawWaypoints();
  }

  function drawWaypoints() {
    waypointLayer.clearLayers();
    for (const w of S.waypoints) {
      if (S.wpForm && S.wpForm.id === w.id) continue; // shown as the draggable draft while editing
      const m = L.marker([w.lat, w.lng], { icon: wpDivIcon(w.kind, S.selectedWp === w.id), title: w.name, riseOnHover: true });
      m.bindTooltip(w.name, { className: 'trail-tip', direction: 'top', offset: [0, -14] });
      m.on('click', () => { if (!S.mode) openWaypoint(w.id); });
      m.addTo(waypointLayer);
    }
  }

  function fitPoints(points) {
    const b = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 14 });
  }

  // The nearest trail to a spot, if one is within half a mile
  function nearestTrail(lat, lng) {
    let best = null;
    for (const t of S.trails) {
      for (const line of t.geometry.coordinates) {
        const step = Math.max(1, Math.floor(line.length / 200));
        for (let i = 0; i < line.length; i += step) {
          const d = haversineMi([lng, lat], line[i]);
          if (!best || d < best.d) best = { d, id: t.id };
        }
      }
    }
    return best && best.d < 0.5 ? best.id : null;
  }

  // Ask for a spot on the map (tap, or use GPS). Resolves with a LatLng, or null if cancelled.
  function pickPoint(text) {
    return new Promise((resolve) => {
      map.getContainer().classList.add('crosshair');
      const onClick = (e) => finish(e.latlng);
      map.on('click', onClick);
      S.mode = {
        type: 'pick',
        cancel: () => finish(null),
        done: () => {},
        undo: () => {
          if (!navigator.geolocation) return toast('Location is not available on this device', true);
          toast('Finding your location…');
          navigator.geolocation.getCurrentPosition(
            (pos) => finish(L.latLng(pos.coords.latitude, pos.coords.longitude)),
            () => toast('Could not get your location. Tap the map instead.', true),
            { enableHighAccuracy: true, timeout: 15000 });
        },
      };
      function finish(ll) {
        map.off('click', onClick);
        map.getContainer().classList.remove('crosshair');
        S.mode = null;
        hideModeBar();
        resolve(ll);
      }
      showModeBar(text, { undo: true, undoLabel: 'Use my location', hideDone: true });
    });
  }

  $('#btn-waypoint').addEventListener('click', async () => {
    if (S.mode) return;
    if (S.form && !confirm('Discard this unsaved trail?')) return;
    closeForm();
    const ll = await pickPoint('Tap the map where the waypoint goes, or use your location.');
    if (ll) openWaypointForm({ lat: ll.lat, lng: ll.lng });
  });

  // ----- Trails / Waypoints switch at the top of the Trails tab -----
  function listModeSwitch() {
    return `<div class="seg" role="tablist" aria-label="Show trails or waypoints">
      <button type="button" data-mode="trails" class="${S.listMode === 'trails' ? 'on' : ''}">Trails <span class="muted">${S.trails.length}</span></button>
      <button type="button" data-mode="waypoints" class="${S.listMode === 'waypoints' ? 'on' : ''}">Waypoints <span class="muted">${S.waypoints.length}</span></button>
    </div>`;
  }
  function bindListModeSwitch() {
    $$('.seg [data-mode]').forEach((b) => b.addEventListener('click', () => {
      S.listMode = b.dataset.mode;
      renderList();
    }));
  }

  function renderWaypointList() {
    const f = S.wpFilter;
    view.innerHTML = `
      ${listModeSwitch()}
      <div class="list-tools">
        <input class="search" id="wq" type="search" placeholder="Search waypoints" value="${esc(f.q)}" aria-label="Search waypoints">
        <div class="kind-chips">
          <button type="button" class="kind-chip ${f.kind ? '' : 'on'}" data-kind="">All</button>
          ${Object.entries(WP_KINDS).map(([k, v]) => `<button type="button" class="kind-chip ${f.kind === k ? 'on' : ''}" data-kind="${k}">${wpIconHtml(k, 18)}${esc(v.label)}</button>`).join('')}
        </div>
      </div>
      <ul class="trail-list" id="wp-list"></ul>`;
    bindListModeSwitch();
    const draw = () => {
      const q = f.q.toLowerCase();
      const list = S.waypoints.filter((w) => (!f.kind || w.kind === f.kind) &&
        (!q || [w.name, w.notes].some((v) => v && v.toLowerCase().includes(q))));
      const ul = $('#wp-list');
      if (!S.waypoints.length) {
        ul.innerHTML = '<li class="empty"><strong>No waypoints yet</strong>Use <b>Add waypoint</b> to mark gas, camps, water, hazards and viewpoints. Waypoints in GPX files are added when you upload them.</li>';
        return;
      }
      if (!list.length) { ul.innerHTML = '<li class="empty"><strong>No waypoints match</strong>Clear the search or pick All.</li>'; return; }
      ul.innerHTML = list.map((w) => {
        const t = S.trails.find((x) => x.id === w.trail_id);
        return `<li><button class="trail-item wp-item" data-wp="${w.id}">
          ${wpIconHtml(w.kind, 30)}
          <span><span class="t-name">${esc(w.name)}</span>
            <span class="t-meta"><span>${esc(WP_KINDS[w.kind].label)}</span>${t ? `<span>on ${esc(t.name)}</span>` : ''}</span></span>
          <span></span>
        </button></li>`;
      }).join('');
      $$('[data-wp]', ul).forEach((b) => b.addEventListener('click', () => openWaypoint(Number(b.dataset.wp), { fit: true })));
    };
    $('#wq').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
    $$('.kind-chip').forEach((b) => b.addEventListener('click', () => {
      f.kind = b.dataset.kind;
      $$('.kind-chip').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    }));
    draw();
  }

  // ----- Waypoint detail -----
  function openWaypoint(id, { fit = false } = {}) {
    const w = S.waypoints.find((x) => x.id === id);
    if (!w) return;
    if (S.form) { if (!confirm('Discard this unsaved trail?')) return; closeForm(); }
    closeWaypointForm();
    S.view = 'waypoint';
    S.selectedId = null;
    S.selectedWp = id;
    setTab('list');
    setHash(`waypoint/${id}`);
    drawTrailsOnMap();
    drawWaypoints();
    if (fit) map.setView([w.lat, w.lng], Math.max(map.getZoom(), 13));
    if (matchMedia('(max-width: 760px)').matches && panel.classList.contains('collapsed')) setSheet(null);
    const t = S.trails.find((x) => x.id === w.trail_id);
    const coords = `${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}`;
    view.innerHTML = `
      <button class="link-btn back" id="wp-back">‹ All waypoints</button>
      <div class="detail-title">
        <div style="display:flex;gap:12px;align-items:center">${wpIconHtml(w.kind, 40)}<div><h2>${esc(w.name)}</h2><div class="detail-where">${esc(WP_KINDS[w.kind].label)}</div></div></div>
        <button class="btn btn-secondary btn-small" id="wp-edit">Edit</button>
      </div>
      ${t ? `<p style="margin-top:14px">On <button class="link-btn" id="wp-trail">${esc(t.name)}</button></p>` : ''}
      ${w.notes ? `<h3>Notes</h3><p class="notes">${esc(w.notes)}</p>` : ''}
      <h3>Location</h3>
      <p><span class="coords">${coords}</span> <button class="link-btn" id="wp-copy" style="margin-left:8px">Copy</button></p>
      <div class="btn-row" style="margin-top:12px">
        <a class="btn btn-dark btn-small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${w.lat},${w.lng}">Directions</a>
        <button class="btn btn-secondary btn-small" id="wp-zoom">Zoom to</button>
      </div>
      <p class="byline">Added by ${esc(w.created_by_name || 'a former member')} on ${new Date(w.created_at).toLocaleDateString()}</p>`;
    $('#wp-back').addEventListener('click', () => { S.selectedWp = null; drawWaypoints(); S.listMode = 'waypoints'; setHash(''); renderList(); });
    $('#wp-edit').addEventListener('click', () => openWaypointForm({ ...w }));
    $('#wp-zoom').addEventListener('click', () => map.setView([w.lat, w.lng], 15));
    $('#wp-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(coords); toast('Coordinates copied'); } catch { toast(coords); }
    });
    if (t) $('#wp-trail').addEventListener('click', () => { S.selectedWp = null; drawWaypoints(); openTrail(t.id, { fit: true }); });
  }

  // ----- Waypoint create / edit -----
  let wpDraftMarker = null;
  function closeWaypointForm() {
    if (wpDraftMarker) { map.removeLayer(wpDraftMarker); wpDraftMarker = null; }
    if (S.wpForm) { S.wpForm = null; drawWaypoints(); }
  }

  function openWaypointForm(data) {
    closeWaypointForm();
    const existing = !!data.id;
    S.wpForm = { id: data.id || null, lat: data.lat, lng: data.lng, kind: data.kind || 'other' };
    S.view = 'wp-form';
    setTab('list');
    drawWaypoints();
    const suggested = data.trail_id !== undefined ? data.trail_id : nearestTrail(data.lat, data.lng);
    const trails = [...S.trails].sort((a, b) => a.name.localeCompare(b.name));
    const placeDraft = () => {
      if (wpDraftMarker) map.removeLayer(wpDraftMarker);
      wpDraftMarker = L.marker([S.wpForm.lat, S.wpForm.lng], { icon: wpDivIcon(S.wpForm.kind, true), draggable: true, zIndexOffset: 1000 }).addTo(map);
      wpDraftMarker.on('dragend', () => {
        const ll = wpDraftMarker.getLatLng();
        S.wpForm.lat = ll.lat; S.wpForm.lng = ll.lng;
        $('#wp-coords').textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
      });
    };
    placeDraft();
    if (!map.getBounds().contains([data.lat, data.lng])) map.setView([data.lat, data.lng], Math.max(map.getZoom(), 13));
    if (matchMedia('(max-width: 760px)').matches) setSheet('expanded');

    view.innerHTML = `
      <button class="link-btn back" id="wpf-back">‹ Back</button>
      <h2>${existing ? 'Edit waypoint' : 'New waypoint'}</h2>
      <form class="form" id="wp-form" style="margin-top:14px" novalidate>
        <div class="field-label">Type
          <div class="kind-pick">
            ${Object.entries(WP_KINDS).map(([k, v]) => `<label><input type="radio" name="kind" value="${k}" ${S.wpForm.kind === k ? 'checked' : ''}>${wpIconHtml(k, 26)}<span>${esc(v.label)}</span></label>`).join('')}
          </div>
        </div>
        <label>Name<input type="text" name="name" maxlength="100" value="${esc(data.name || '')}" placeholder="e.g. Sinclair in Green River"></label>
        <label>Trail
          <select name="trail_id"><option value="">Not on a trail</option>${trails.map((t) => `<option value="${t.id}" ${suggested === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        </label>
        <label>Notes<textarea name="notes" placeholder="Hours, conditions, how to find it…">${esc(data.notes || '')}</textarea></label>
        <div class="geom-box">
          <div><b>Location</b> <span class="muted small" id="wp-coords">${data.lat.toFixed(5)}, ${data.lng.toFixed(5)}</span></div>
          <p class="small muted" style="margin:6px 0 0">Drag the marker on the map to fine-tune it.</p>
          <div class="btn-row"><button type="button" class="btn btn-secondary btn-small" id="wp-move">Pick a new spot</button></div>
        </div>
        <p class="form-error" id="wp-err"></p>
        <div class="sticky-actions btn-row">
          <button class="btn btn-primary" type="submit">${existing ? 'Save changes' : 'Save waypoint'}</button>
          <button class="btn btn-ghost" type="button" id="wp-cancel">Cancel</button>
          ${existing ? '<button class="btn btn-danger" type="button" id="wp-delete" style="margin-left:auto">Delete</button>' : ''}
        </div>
      </form>`;
    const form = $('#wp-form');
    $$('input[name=kind]', form).forEach((r) => r.addEventListener('change', () => { S.wpForm.kind = r.value; placeDraft(); }));
    const leave = () => {
      closeWaypointForm();
      if (existing) openWaypoint(data.id);
      else if (data.backTo) openTrail(data.backTo);
      else renderList();
    };
    $('#wpf-back').addEventListener('click', leave);
    $('#wp-cancel').addEventListener('click', leave);
    $('#wp-move').addEventListener('click', async () => {
      if (wpDraftMarker) wpDraftMarker.setOpacity(0.4);
      const ll = await pickPoint('Tap the new spot for this waypoint.');
      if (ll) {
        S.wpForm.lat = ll.lat; S.wpForm.lng = ll.lng;
        $('#wp-coords').textContent = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
      }
      placeDraft();
      if (matchMedia('(max-width: 760px)').matches) setSheet('expanded');
    });
    if (existing) {
      $('#wp-delete').addEventListener('click', async () => {
        if (!confirm(`Delete the waypoint "${data.name}"?`)) return;
        try {
          await api('DELETE', `/api/waypoints/${data.id}`);
          closeWaypointForm();
          S.selectedWp = null;
          await loadWaypoints();
          toast('Waypoint deleted');
          S.listMode = 'waypoints';
          setHash('');
          renderList();
        } catch (e) { fail(e); }
      });
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (S.mode) return toast('Finish picking the spot first', true);
      const el = form.elements;
      const kind = S.wpForm.kind;
      const body = {
        name: el.name.value.trim() || WP_KINDS[kind].label,
        kind,
        notes: el.notes.value.trim(),
        trail_id: el.trail_id.value ? Number(el.trail_id.value) : null,
        lat: S.wpForm.lat,
        lng: S.wpForm.lng,
      };
      try {
        let id = S.wpForm.id;
        if (existing) await api('PUT', `/api/waypoints/${id}`, body);
        else id = (await api('POST', '/api/waypoints', body)).id;
        closeWaypointForm();
        await loadWaypoints();
        toast(existing ? 'Waypoint saved' : 'Waypoint added');
        openWaypoint(id);
      } catch (err) { $('#wp-err').textContent = err.message; }
    });
    if (!existing) setTimeout(() => form.elements.name.focus(), 50);
  }

  // =====================================================================
  // Planned rides with sign-ups
  // =====================================================================
  let planMarker = null;
  function clearPlanMarker() { if (planMarker) { map.removeLayer(planMarker); planMarker = null; } }
  function showPlanMarker(lat, lng, label) {
    clearPlanMarker();
    planMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: 'wp-marker wp-marker-big', html: '<span class="meet-flag" aria-hidden="true">Meet</span>', iconSize: [52, 26], iconAnchor: [26, 26] }),
      zIndexOffset: 1000,
    }).addTo(map);
    if (label) planMarker.bindTooltip(label, { className: 'trail-tip', direction: 'top', offset: [0, -26] });
  }

  async function loadPlanned() {
    S.planned = await api('GET', '/api/planned');
    updateRidesBadge();
  }
  function myStatus(p) {
    const s = p.signups.find((x) => x.user_id === S.me.id);
    return s ? s.status : null;
  }
  function updateRidesBadge() {
    const t = today();
    const n = S.planned.filter((p) => p.ride_date >= t && !myStatus(p)).length;
    const b = $('#rides-badge');
    b.hidden = !n;
    b.textContent = n;
    b.title = `${n} upcoming ${n === 1 ? 'ride needs' : 'rides need'} your answer`;
  }
  const dayParts = (d) => {
    const [y, m, day] = d.split('-').map(Number);
    const dt = new Date(y, m - 1, day);
    return { dow: dt.toLocaleDateString(undefined, { weekday: 'short' }), md: dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), full: dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) };
  };
  const fmtTime = (t) => {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    if (!Number.isFinite(h)) return t;
    return new Date(2000, 0, 1, h, m || 0).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };

  async function renderRides() {
    S.view = 'rides';
    setTab('rides');
    clearPlanMarker();
    view.innerHTML = '<p class="muted">Loading…</p>';
    try { await loadPlanned(); } catch (e) { fail(e); }
    if (S.view !== 'rides') return;
    const t = today();
    const upcoming = S.planned.filter((p) => p.ride_date >= t);
    const past = S.planned.filter((p) => p.ride_date < t).reverse();
    view.innerHTML = `
      <div class="detail-title"><h2>Rides</h2><button class="btn btn-primary btn-small" id="plan-new">Plan a ride</button></div>
      <h3>Coming up</h3>
      ${upcoming.length ? upcoming.map(planCard).join('') : '<div class="empty"><strong>Nothing planned</strong>Use <b>Plan a ride</b> to pick a date and trails, and everyone can say whether they\'re in.</div>'}
      ${past.length ? `<h3>Recent</h3>${past.map(planCard).join('')}` : ''}`;
    $('#plan-new').addEventListener('click', () => openPlannedForm({}));
    bindPlanCards();
  }

  function planCard(p) {
    const d = dayParts(p.ride_date);
    const isPast = p.ride_date < today();
    const mine = myStatus(p);
    const by = (st) => p.signups.filter((x) => x.status === st);
    const trails = p.trail_ids.map((id) => S.trails.find((t) => t.id === id)).filter(Boolean);
    const miles = trails.reduce((s, t) => s + (Number(t.distance_mi) || 0), 0);
    const waiting = S.users.filter((u) => !p.signups.some((x) => x.user_id === u.id));
    return `<article class="plan-card ${isPast ? 'past' : ''}" data-plan="${p.id}">
      <div class="plan-date"><span>${esc(d.dow)}</span><b>${esc(d.md)}</b></div>
      <div class="plan-body">
        <h4>${esc(p.title)}</h4>
        <div class="muted small">${[p.meet_time ? `Meet ${esc(fmtTime(p.meet_time))}` : '', p.meet_place ? esc(p.meet_place) : ''].filter(Boolean).join(' at ')}</div>
        ${trails.length ? `<div class="chips plan-trails">${trails.map((t) => `<button class="chip chip-btn" data-trail="${t.id}">${esc(t.name)}</button>`).join('')}<span class="muted small">${fmtMi(miles)} mi</span></div>` : ''}
        ${p.notes ? `<p class="notes small" style="margin-top:8px">${esc(p.notes)}</p>` : ''}
        ${isPast ? '' : `
        <div class="rsvp" role="group" aria-label="Are you going?">
          <button class="rsvp-btn going ${mine === 'going' ? 'on' : ''}" data-rsvp="going">Going <b>${by('going').length}</b></button>
          <button class="rsvp-btn maybe ${mine === 'maybe' ? 'on' : ''}" data-rsvp="maybe">Maybe <b>${by('maybe').length}</b></button>
          <button class="rsvp-btn out ${mine === 'out' ? 'on' : ''}" data-rsvp="out">Can't make it <b>${by('out').length}</b></button>
        </div>`}
        <div class="who small">
          ${['going', 'maybe', 'out'].map((st) => by(st).length ? `<div><span class="who-label">${{ going: isPast ? 'Went' : 'Going', maybe: 'Maybe', out: "Can't" }[st]}:</span> ${by(st).map((x) => esc(x.name)).join(', ')}</div>` : '').join('')}
          ${!isPast && waiting.length ? `<div class="muted"><span class="who-label">No answer yet:</span> ${waiting.map((u) => esc(u.display_name)).join(', ')}</div>` : ''}
        </div>
        <div class="plan-actions">
          ${p.meet_lat != null ? '<button class="link-btn" data-act="map">Meeting spot</button>' : ''}
          ${trails.length ? '<button class="link-btn" data-act="trails">Show trails</button>' : ''}
          <button class="link-btn" data-act="edit">Edit</button>
          <button class="link-btn danger" data-act="del">Delete</button>
          ${isPast && !p.logged && trails.length ? '<button class="btn btn-primary btn-small" data-act="log">Log this ride</button>' : ''}
          ${p.logged ? '<span class="logged">✓ Logged to the trails</span>' : ''}
        </div>
        <div class="log-slot"></div>
      </div>
    </article>`;
  }

  function bindPlanCards() {
    $$('.plan-card').forEach((card) => {
      const p = S.planned.find((x) => x.id === Number(card.dataset.plan));
      $$('[data-trail]', card).forEach((b) => b.addEventListener('click', () => openTrail(Number(b.dataset.trail), { fit: true })));
      $$('[data-rsvp]', card).forEach((b) => b.addEventListener('click', async () => {
        const status = myStatus(p) === b.dataset.rsvp ? null : b.dataset.rsvp; // tap again to clear
        try {
          await api('POST', `/api/planned/${p.id}/signup`, { status });
          renderRides();
        } catch (e) { fail(e); }
      }));
      $$('[data-act]', card).forEach((b) => b.addEventListener('click', async () => {
        const act = b.dataset.act;
        if (act === 'map') {
          showPlanMarker(p.meet_lat, p.meet_lng, p.meet_place || p.title);
          map.setView([p.meet_lat, p.meet_lng], Math.max(map.getZoom(), 13));
          if (matchMedia('(max-width: 760px)').matches) setSheet('collapsed');
        } else if (act === 'trails') {
          const coords = p.trail_ids.map((id) => S.trails.find((t) => t.id === id)).filter(Boolean).flatMap((t) => t.geometry.coordinates);
          if (coords.length) fitGeometry({ type: 'MultiLineString', coordinates: coords });
          if (matchMedia('(max-width: 760px)').matches) setSheet('collapsed');
        } else if (act === 'edit') {
          openPlannedForm(p);
        } else if (act === 'del') {
          if (!confirm(`Delete "${p.title}"? Everyone's answers go with it.`)) return;
          try { await api('DELETE', `/api/planned/${p.id}`); toast('Ride deleted'); renderRides(); } catch (e) { fail(e); }
        } else if (act === 'log') {
          logPlannedForm(card, p);
        }
      }));
    });
  }

  function logPlannedForm(card, p) {
    const went = p.signups.filter((x) => x.status === 'going').map((x) => x.name);
    const trails = p.trail_ids.map((id) => S.trails.find((t) => t.id === id)).filter(Boolean);
    const slot = $('.log-slot', card);
    slot.innerHTML = `
      <form class="form card" id="plog">
        <p class="small muted" style="margin:0">This adds a ride on ${fmtDate(p.ride_date)} to each trail you check, with these riders.</p>
        <div class="field-label">Trails ridden
          <div class="rider-pick">${trails.map((t) => `<label><input type="checkbox" name="trail" value="${t.id}" checked>${esc(t.name)}</label>`).join('')}</div>
        </div>
        ${riderPicker(went.length ? went : [S.me.name])}
        <label>Conditions<input type="text" name="conditions" placeholder="Dry, muddy, snow…"></label>
        <div class="btn-row"><button class="btn btn-primary btn-small" type="submit">Log ride</button><button class="btn btn-ghost btn-small" type="button" id="plog-cancel">Cancel</button></div>
      </form>`;
    $('#plog-cancel').addEventListener('click', () => { slot.innerHTML = ''; });
    $('#plog').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const trailIds = $$('input[name=trail]:checked', f).map((i) => Number(i.value));
      if (!trailIds.length) return toast('Check at least one trail', true);
      try {
        const r = await api('POST', `/api/planned/${p.id}/log`, { trail_ids: trailIds, riders: readRiders(f), conditions: f.elements.conditions.value.trim() });
        toast(`Ride logged on ${r.logged} ${r.logged === 1 ? 'trail' : 'trails'}`);
        await loadTrails();
        drawTrailsOnMap();
        renderRides();
      } catch (err) { fail(err); }
    });
  }

  function openPlannedForm(data) {
    S.view = 'plan-form';
    setTab('rides');
    S.planForm = { meet_lat: data.meet_lat ?? null, meet_lng: data.meet_lng ?? null, trail_ids: new Set(data.trail_ids || []) };
    clearPlanMarker();
    if (S.planForm.meet_lat != null) showPlanMarker(S.planForm.meet_lat, S.planForm.meet_lng);
    const existing = !!data.id;
    const trails = [...S.trails].sort((a, b) => a.name.localeCompare(b.name));
    view.innerHTML = `
      <button class="link-btn back" id="pf-back">‹ Rides</button>
      <h2>${existing ? 'Edit ride' : 'Plan a ride'}</h2>
      <form class="form" id="plan-form" style="margin-top:14px" novalidate>
        <label>Ride name<input type="text" name="title" maxlength="120" value="${esc(data.title || '')}" placeholder="e.g. Moab weekend"></label>
        <div class="grid-2">
          <label>Date<input type="date" name="ride_date" value="${esc(data.ride_date || '')}" min="${existing ? '' : today()}"></label>
          <label>Meet at (time)<input type="time" name="meet_time" value="${esc(data.meet_time || '')}"></label>
        </div>
        <label>Meeting place<input type="text" name="meet_place" maxlength="200" value="${esc(data.meet_place || '')}" placeholder="e.g. Maverik in Green River"></label>
        <div class="geom-box">
          <div><b>Meeting spot on the map</b> <span class="muted small" id="pf-spot">${S.planForm.meet_lat != null ? 'Set' : 'Not set'}</span></div>
          <div class="btn-row"><button type="button" class="btn btn-secondary btn-small" id="pf-pick">Pick on map</button><button type="button" class="btn btn-ghost btn-small" id="pf-clear" ${S.planForm.meet_lat != null ? '' : 'hidden'}>Clear</button></div>
        </div>
        <div class="field-label">Trails
          <input class="search" id="pf-q" type="search" placeholder="Find a trail" style="margin-top:4px">
          <div class="trail-checks" id="pf-trails">
            ${trails.length ? trails.map((t) => `<label data-name="${esc(t.name.toLowerCase())}"><input type="checkbox" value="${t.id}" ${S.planForm.trail_ids.has(t.id) ? 'checked' : ''}><span>${esc(t.name)}</span><span class="muted small">${fmtMi(t.distance_mi)} mi</span></label>`).join('') : '<p class="muted small">No trails on the map yet.</p>'}
          </div>
        </div>
        <label>Notes<textarea name="notes" placeholder="Gear, gas plan, who's trailering…">${esc(data.notes || '')}</textarea></label>
        <p class="form-error" id="pf-err"></p>
        <div class="sticky-actions btn-row">
          <button class="btn btn-primary" type="submit">${existing ? 'Save ride' : 'Create ride'}</button>
          <button class="btn btn-ghost" type="button" id="pf-cancel">Cancel</button>
        </div>
      </form>`;
    const form = $('#plan-form');
    const leave = () => { clearPlanMarker(); renderRides(); };
    $('#pf-back').addEventListener('click', leave);
    $('#pf-cancel').addEventListener('click', leave);
    $('#pf-q').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      $$('#pf-trails label').forEach((l) => { l.hidden = q && !l.dataset.name.includes(q); });
    });
    $$('#pf-trails input').forEach((i) => i.addEventListener('change', () => {
      const id = Number(i.value);
      if (i.checked) S.planForm.trail_ids.add(id); else S.planForm.trail_ids.delete(id);
    }));
    $('#pf-pick').addEventListener('click', async () => {
      const ll = await pickPoint('Tap the meeting spot, or use your location.');
      if (ll) {
        S.planForm.meet_lat = ll.lat; S.planForm.meet_lng = ll.lng;
        showPlanMarker(ll.lat, ll.lng);
        $('#pf-spot').textContent = 'Set';
        $('#pf-clear').hidden = false;
      }
      if (matchMedia('(max-width: 760px)').matches) setSheet('expanded');
    });
    $('#pf-clear').addEventListener('click', () => {
      S.planForm.meet_lat = null; S.planForm.meet_lng = null;
      clearPlanMarker();
      $('#pf-spot').textContent = 'Not set';
      $('#pf-clear').hidden = true;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const el = form.elements;
      const body = {
        title: el.title.value.trim(),
        ride_date: el.ride_date.value,
        meet_time: el.meet_time.value || null,
        meet_place: el.meet_place.value.trim(),
        meet_lat: S.planForm.meet_lat,
        meet_lng: S.planForm.meet_lng,
        trail_ids: Array.from(S.planForm.trail_ids),
        notes: el.notes.value.trim(),
      };
      if (!body.title) { $('#pf-err').textContent = 'Give the ride a name.'; el.title.focus(); return; }
      if (!body.ride_date) { $('#pf-err').textContent = 'Pick a date.'; el.ride_date.focus(); return; }
      try {
        if (existing) await api('PUT', `/api/planned/${data.id}`, body);
        else await api('POST', '/api/planned', body);
        toast(existing ? 'Ride saved' : "Ride created. You're marked as going.");
        clearPlanMarker();
        renderRides();
      } catch (err) { $('#pf-err').textContent = err.message; }
    });
    if (!existing && !data.title) setTimeout(() => form.elements.title.focus(), 50);
  }

  // =====================================================================
  // Offline maps
  // =====================================================================
  const OFFLINE_LAYERS = {
    'usgs-topo': { label: 'USGS topo', base: 'USGS topo', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile', kb: 20 },
    'usgs-imagery': { label: 'USGS satellite', base: 'USGS satellite', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile', kb: 30 },
  };
  const DETAIL = { 13: 'Overview (roads and big trails)', 14: 'Standard', 15: 'Detailed (recommended)', 16: 'Most detail (large download)' };
  const MAX_TILES = 9000;

  const getAreas = () => { try { return JSON.parse(store.get('offlineAreas')) || []; } catch { return []; } };
  const setAreas = (a) => store.set('offlineAreas', JSON.stringify(a));

  function lng2x(lng, z) { return Math.floor(((lng + 180) / 360) * 2 ** z); }
  function lat2y(lat, z) {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  }
  function tileList(bounds, zmin, zmax) {
    const out = [];
    for (let z = zmin; z <= zmax; z++) {
      const x0 = lng2x(bounds.getWest(), z); const x1 = lng2x(bounds.getEast(), z);
      const y0 = lat2y(bounds.getNorth(), z); const y1 = lat2y(bounds.getSouth(), z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
    }
    return out;
  }
  const zMinFor = (zmax) => Math.max(5, Math.min(Math.floor(map.getZoom()), zmax) - 3);

  let offlineJob = null;
  let offlineRect = null;

  async function renderOffline() {
    const box = $('#offline');
    if (!box) return;
    const supported = 'caches' in window && 'serviceWorker' in navigator;
    const areas = getAreas();
    let usage = '';
    try {
      const est = await navigator.storage.estimate();
      usage = `Using ${(est.usage / 1048576).toFixed(0)} MB on this device.`;
    } catch { /* not available */ }
    box.innerHTML = supported ? `
      <p class="small muted">Save the area on the map now so the map still works with no signal. Once it's saved, the site opens offline with your trails and waypoints. On a phone, add the site to your home screen first so the saved maps aren't cleared.</p>
      ${areas.length ? `<div class="areas">${areas.map((a) => `
        <div class="user-row" data-area="${a.id}">
          <div class="who"><b>${esc(a.name)}</b><span>${esc(OFFLINE_LAYERS[a.layer].label)} · ${a.tiles.toLocaleString()} tiles · ${(a.bytes / 1048576).toFixed(0)} MB · ${new Date(a.date).toLocaleDateString()}</span></div>
          <div class="ride-actions"><button class="link-btn" data-act="view">View</button><button class="link-btn danger" data-act="del">Delete</button></div>
        </div>`).join('')}</div>` : ''}
      <form class="form card" id="off-form">
        <legend style="font-family:var(--font-sign);font-weight:700;font-size:18px">Save the map area on screen</legend>
        <label>Name<input type="text" name="name" maxlength="60" placeholder="e.g. Moab"></label>
        <div class="grid-2">
          <label>Map<select name="layer">${Object.entries(OFFLINE_LAYERS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
          <label>Detail<select name="zmax">${Object.entries(DETAIL).map(([z, l]) => `<option value="${z}" ${z === '15' ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <p class="small" id="off-est"></p>
        <div id="off-progress" hidden><div class="progress"><div id="off-bar"></div></div><p class="small muted" id="off-status"></p></div>
        <div class="btn-row">
          <button class="btn btn-dark btn-small" type="submit" id="off-go">Save for offline</button>
          <button class="btn btn-ghost btn-small" type="button" id="off-cancel" hidden>Stop</button>
        </div>
      </form>
      <p class="small muted" style="margin-top:8px">${usage} Only USGS maps can be saved; the other map styles don't allow downloading.</p>`
      : '<p class="muted">This browser doesn\'t support offline maps. Try Chrome or Safari.</p>';
    if (!supported) return;

    const form = $('#off-form');
    const estimate = () => {
      if (!$('#off-est')) return;
      const zmax = Number(form.elements.zmax.value);
      const n = tileList(map.getBounds(), zMinFor(zmax), zmax).length;
      const mb = (n * OFFLINE_LAYERS[form.elements.layer.value].kb) / 1024;
      const tooBig = n > MAX_TILES;
      $('#off-est').innerHTML = tooBig
        ? `<span style="color:var(--danger)">That's ${n.toLocaleString()} tiles, too many at once. Zoom the map in to a smaller area or choose less detail.</span>`
        : `About ${n.toLocaleString()} tiles, roughly ${mb < 1 ? '<1' : mb.toFixed(0)} MB. Covers what's on the map now.`;
      $('#off-go').disabled = tooBig || !!offlineJob;
    };
    estimate();
    form.elements.zmax.addEventListener('change', estimate);
    form.elements.layer.addEventListener('change', estimate);
    map.off('moveend', S.offlineEstimate || (() => {}));
    S.offlineEstimate = () => { if (S.view === 'account') estimate(); };
    map.on('moveend', S.offlineEstimate);

    $$('[data-area]', box).forEach((row) => {
      const a = areas.find((x) => x.id === row.dataset.area);
      row.querySelector('[data-act=view]').addEventListener('click', () => {
        setBase(OFFLINE_LAYERS[a.layer].base);
        const b = L.latLngBounds(a.bounds);
        map.fitBounds(b);
        if (offlineRect) map.removeLayer(offlineRect);
        offlineRect = L.rectangle(b, { color: '#24302b', weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(map);
        setTimeout(() => { if (offlineRect) { map.removeLayer(offlineRect); offlineRect = null; } }, 4000);
      });
      row.querySelector('[data-act=del]').addEventListener('click', async () => {
        if (!confirm(`Delete the offline map "${a.name}" from this device?`)) return;
        await caches.delete(`offline-${a.id}`);
        setAreas(getAreas().filter((x) => x.id !== a.id));
        toast('Offline map deleted');
        renderOffline();
      });
    });

    $('#off-cancel').addEventListener('click', () => { if (offlineJob) offlineJob.cancelled = true; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (offlineJob) return;
      if (!navigator.onLine) return toast('You need a connection to download maps', true);
      const layer = form.elements.layer.value;
      const zmax = Number(form.elements.zmax.value);
      const bounds = map.getBounds();
      const tiles = tileList(bounds, zMinFor(zmax), zmax);
      if (tiles.length > MAX_TILES) return;
      try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* best effort */ }
      // make sure the service worker is running so the saved tiles get used
      try { await navigator.serviceWorker.register('/sw.js'); } catch { /* ignore */ }
      const id = String(Date.now());
      const name = form.elements.name.value.trim() || `Area saved ${new Date().toLocaleDateString()}`;
      const cache = await caches.open(`offline-${id}`);
      const job = offlineJob = { cancelled: false, done: 0, failed: 0, bytes: 0 };
      $('#off-progress').hidden = false;
      $('#off-cancel').hidden = false;
      $('#off-go').disabled = true;
      const show = () => {
        if (!$('#off-bar')) return; // user moved to another tab; the download keeps going
        $('#off-bar').style.width = `${(job.done / tiles.length) * 100}%`;
        $('#off-status').textContent = `Saved ${job.done.toLocaleString()} of ${tiles.length.toLocaleString()} tiles (${(job.bytes / 1048576).toFixed(1)} MB)${job.failed ? ` · ${job.failed} unavailable` : ''}. Keep this screen open.`;
      };
      let next = 0;
      const worker = async () => {
        while (!job.cancelled && next < tiles.length) {
          const [z, x, y] = tiles[next++];
          try {
            const res = await fetch(`/tiles/${layer}/${z}/${y}/${x}`, { credentials: 'same-origin' });
            if (res.ok) {
              const blob = await res.blob();
              job.bytes += blob.size;
              await cache.put(`${OFFLINE_LAYERS[layer].url}/${z}/${y}/${x}`, new Response(blob, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg' } }));
            } else job.failed++;
          } catch { job.failed++; }
          job.done++;
          if (job.done % 10 === 0 || job.done === tiles.length) show();
        }
      };
      show();
      await Promise.all(Array.from({ length: 6 }, worker));
      offlineJob = null;
      if (job.cancelled) {
        await caches.delete(`offline-${id}`);
        toast('Download stopped. Nothing was saved.');
      } else if (job.done - job.failed === 0) {
        await caches.delete(`offline-${id}`);
        toast("Couldn't download any map tiles. Check your connection and try again.", true);
      } else {
        const saved = job.done - job.failed;
        if (job.failed) toast(`${job.failed} tiles couldn't be downloaded; the rest were saved.`, true);
        setAreas([...getAreas(), { id, name, layer, zmax, tiles: saved, bytes: job.bytes, date: new Date().toISOString(),
          bounds: [[bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getEast()]] }]);
        toast(`"${name}" saved for offline use`);
      }
      if (S.view === 'account') renderOffline();
    });
  }

  function updateOfflineFlag() {
    $('#offline-flag').hidden = navigator.onLine;
  }
  window.addEventListener('online', updateOfflineFlag);
  window.addEventListener('offline', () => { updateOfflineFlag(); useOfflineBase(); });

  // With no signal, switch to the map style that was saved for offline use
  function useOfflineBase() {
    const areas = getAreas();
    if (!areas.length) return;
    const latest = areas[areas.length - 1];
    const base = OFFLINE_LAYERS[latest.layer].base;
    if (!map.hasLayer(bases[base])) {
      setBase(base);
      toast(`Offline: switched to ${base}, which you saved on this device`);
    }
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
      await Promise.all([loadWaypoints().catch(() => {}), loadPlanned().catch(() => {})]);
    } catch (e) { return fail(e); }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    updateOfflineFlag();
    if (!navigator.onLine) useOfflineBase();
    drawTrailsOnMap();
    const m = location.hash.match(/^#trail\/(\d+)/);
    const wm = location.hash.match(/^#waypoint\/(\d+)/);
    if (m && S.trails.some((t) => t.id === Number(m[1]))) {
      openTrail(Number(m[1]), { fit: true });
    } else if (wm && S.waypoints.some((w) => w.id === Number(wm[1]))) {
      openWaypoint(Number(wm[1]), { fit: true });
    } else {
      renderList();
      fitAll();
    }
  }
  start();
})();
