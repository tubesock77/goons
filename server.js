'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Pool } = require('pg');
const { computeStats, toGpx } = require('./lib/geo');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const APP_NAME = process.env.APP_NAME || 'Geriatric Goons Adventures';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

// Render's internal database URL needs no SSL. Set PGSSL=true when using an external URL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const q = (text, params) => pool.query(text, params);

// ---------- Startup: schema + first admin ----------
async function init() {
  await q(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const u = process.env.ADMIN_USERNAME;
    const p = process.env.ADMIN_PASSWORD;
    if (u && p) {
      await q(
        'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES ($1,$2,$3,TRUE)',
        [u.toLowerCase().trim(), process.env.ADMIN_DISPLAY_NAME || u.trim().charAt(0).toUpperCase() + u.trim().slice(1), await bcrypt.hash(p, 12)]
      );
      console.log(`Created first admin account "${u}".`);
    } else {
      console.warn('No users exist. Set ADMIN_USERNAME and ADMIN_PASSWORD to create the first admin.');
    }
  }
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); // map tile servers require a referrer
  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    store: new PgSession({ pool, tableName: 'session' }),
    name: 'traillog.sid',
    secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  })
);

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- Auth helpers ----------
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  return res.redirect('/login');
}
function requireAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  return res.status(403).json({ error: 'Admins only' });
}
// Simple CSRF guard: state-changing API calls must come from our own fetch() code.
function requireAjax(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') === 'fetch') return next();
  return res.status(403).json({ error: 'Bad request origin' });
}

// Basic login throttling: 10 failed attempts per 15 minutes per IP.
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) return false;
  return a.count >= 10;
}
function recordFail(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) attempts.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
  else a.count++;
}

// ---------- Public pages ----------
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const ip = req.ip;
  if (throttled(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const username = String(req.body.username || '').toLowerCase().trim();
  const password = String(req.body.password || '');
  const { rows } = await q('SELECT * FROM users WHERE username = $1', [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    recordFail(ip);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  attempts.delete(ip);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.user = { id: user.id, username: user.username, name: user.display_name, isAdmin: user.is_admin };
    res.json({ ok: true });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('traillog.sid');
    res.json({ ok: true });
  });
});

app.get('/api/config', (req, res) => res.json({ appName: APP_NAME }));

// Static assets (JS/CSS) are not sensitive; all data goes through the protected API.
app.use('/static', express.static(path.join(__dirname, 'public', 'static'), { maxAge: '1h' }));
// Offline support: service worker, app manifest and icons (no data in these)
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: APP_NAME, short_name: APP_NAME.length > 14 ? APP_NAME.split(' ').map((w) => w[0]).join('').slice(0, 6) : APP_NAME,
    start_url: '/', scope: '/', display: 'standalone', background_color: '#24302b', theme_color: '#24302b',
    icons: [
      { src: '/static/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/static/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

// Map libraries are served from node_modules so the app doesn't depend on outside CDNs.
const vendor = (p) => express.static(path.join(__dirname, 'node_modules', p), { maxAge: '7d' });
app.use('/vendor/leaflet', vendor('leaflet/dist'));
app.use('/vendor/geoman', vendor('@geoman-io/leaflet-geoman-free/dist'));
app.use('/vendor/togeojson', vendor('@tmcw/togeojson/dist'));

// ---------- Everything below requires sign-in ----------
app.use(requireAuth);
app.use('/api', requireAjax);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ----- Me / users -----
app.get('/api/me', (req, res) => res.json(req.session.user));

app.post('/api/me/password', wrap(async (req, res) => {
  const { current, next } = req.body;
  if (!next || String(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const { rows } = await q('SELECT password_hash FROM users WHERE id=$1', [req.session.user.id]);
  if (!rows[0] || !(await bcrypt.compare(String(current || ''), rows[0].password_hash))) {
    return res.status(400).json({ error: 'Current password is wrong' });
  }
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(next), 12), req.session.user.id]);
  res.json({ ok: true });
}));

app.get('/api/users', wrap(async (req, res) => {
  const { rows } = await q('SELECT id, username, display_name, is_admin FROM users ORDER BY display_name');
  res.json(rows);
}));

app.post('/api/users', requireAdmin, wrap(async (req, res) => {
  const username = String(req.body.username || '').toLowerCase().trim();
  const displayName = String(req.body.display_name || req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9._-]{2,32}$/.test(username)) return res.status(400).json({ error: 'Username: 2–32 letters, numbers, dots, dashes' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const { rows } = await q(
      'INSERT INTO users (username, display_name, password_hash, is_admin) VALUES ($1,$2,$3,$4) RETURNING id, username, display_name, is_admin',
      [username, displayName, await bcrypt.hash(password, 12), !!req.body.is_admin]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'That username is taken' });
    throw e;
  }
}));

app.put('/api/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { display_name, password, is_admin } = req.body;
  if (display_name !== undefined) {
    await q('UPDATE users SET display_name=$1 WHERE id=$2', [String(display_name).trim().slice(0, 60), id]);
    if (id === req.session.user.id) req.session.user.name = String(display_name).trim().slice(0, 60);
  }
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(String(password), 12), id]);
  }
  if (is_admin !== undefined) {
    if (id === req.session.user.id && !is_admin) return res.status(400).json({ error: "You can't remove your own admin access" });
    await q('UPDATE users SET is_admin=$1 WHERE id=$2', [!!is_admin, id]);
  }
  res.json({ ok: true });
}));

app.delete('/api/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  await q('DELETE FROM users WHERE id=$1', [id]);
  res.json({ ok: true });
}));

// ----- Trails -----
const TRAIL_LIST_SQL = `
  SELECT t.id, t.name, t.area, t.state, t.difficulty, t.trail_type, t.rating, t.color, t.notes,
         t.geometry, t.sections, t.source, t.distance_mi::float AS distance_mi, t.elevation_gain_ft,
         t.min_ele_ft, t.max_ele_ft, t.created_at, t.updated_at,
         cu.display_name AS created_by_name, uu.display_name AS updated_by_name,
         COALESCE(r.ride_count, 0)::int AS ride_count,
         to_char(r.last_ridden, 'YYYY-MM-DD') AS last_ridden,
         to_char(r.first_ridden, 'YYYY-MM-DD') AS first_ridden,
         rr.riders,
         COALESCE(p.photo_count, 0)::int AS photo_count
  FROM trails t
  LEFT JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users uu ON uu.id = t.updated_by
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS ride_count, MAX(ride_date) AS last_ridden, MIN(ride_date) AS first_ridden
    FROM rides WHERE trail_id = t.id
  ) r ON TRUE
  LEFT JOIN LATERAL (
    SELECT ARRAY(SELECT DISTINCT x FROM rides, unnest(riders) AS x WHERE trail_id = t.id ORDER BY 1) AS riders
  ) rr ON TRUE
  LEFT JOIN LATERAL (SELECT COUNT(*) AS photo_count FROM photos WHERE trail_id = t.id) p ON TRUE
`;

function cleanTrail(body) {
  const str = (v, max = 200) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, max).trim());
  const rating = body.rating ? Math.max(1, Math.min(5, parseInt(body.rating, 10) || 0)) || null : null;
  return {
    name: str(body.name, 120),
    area: str(body.area, 120),
    state: str(body.state, 40),
    difficulty: str(body.difficulty, 20),
    trail_type: str(body.trail_type, 40),
    rating,
    color: body.color && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : null,
    notes: str(body.notes, 10000),
  };
}

function cleanSections(list, lineCount) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (let i = 0; i < lineCount; i++) {
    const x = arr[i] || {};
    out.push({
      color: typeof x.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(x.color) ? x.color : null,
      label: x.label ? String(x.label).trim().slice(0, 60) : null,
    });
  }
  return out;
}

function validateGeometry(g) {
  if (!g || !Array.isArray(g.coordinates)) return null;
  let lines;
  if (g.type === 'LineString') lines = [g.coordinates];
  else if (g.type === 'MultiLineString') lines = g.coordinates;
  else return null;
  const out = [];
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    const pts = [];
    for (const c of line) {
      if (!Array.isArray(c) || c.length < 2) continue;
      const lng = Number(c[0]), lat = Number(c[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const p = [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
      if (c.length > 2 && Number.isFinite(Number(c[2]))) p.push(Math.round(Number(c[2]) * 10) / 10);
      pts.push(p);
    }
    if (pts.length >= 2) out.push(pts);
  }
  if (!out.length) return null;
  return { type: 'MultiLineString', coordinates: out };
}

app.get('/api/trails', wrap(async (req, res) => {
  const { rows } = await q(TRAIL_LIST_SQL + ' ORDER BY t.name');
  res.json(rows);
}));

app.get('/api/trails/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await q(TRAIL_LIST_SQL + ' WHERE t.id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  const rides = await q(
    `SELECT r.id, to_char(r.ride_date, 'YYYY-MM-DD') AS ride_date, r.riders, r.conditions, r.notes,
            u.display_name AS created_by_name
     FROM rides r LEFT JOIN users u ON u.id = r.created_by
     WHERE trail_id=$1 ORDER BY ride_date DESC, r.id DESC`, [id]);
  const photos = await q(
    `SELECT p.id, p.caption, p.created_at, u.display_name AS uploaded_by_name
     FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by
     WHERE trail_id=$1 ORDER BY p.created_at`, [id]);
  res.json({ ...rows[0], rides: rides.rows, photos: photos.rows });
}));

app.post('/api/trails', wrap(async (req, res) => {
  const t = cleanTrail(req.body);
  if (!t.name) return res.status(400).json({ error: 'Trail name is required' });
  const geom = validateGeometry(req.body.geometry);
  if (!geom) return res.status(400).json({ error: 'Trail needs a line with at least 2 points' });
  const s = computeStats(geom);
  const source = ['gpx', 'import'].includes(req.body.source) ? req.body.source : 'drawn';
  const uid = req.session.user.id;
  const { rows } = await q(
    `INSERT INTO trails (name, area, state, difficulty, trail_type, rating, color, notes, geometry, source,
                         distance_mi, elevation_gain_ft, min_ele_ft, max_ele_ft, created_by, updated_by, sections)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16) RETURNING id`,
    [t.name, t.area, t.state, t.difficulty, t.trail_type, t.rating, t.color, t.notes, geom, source,
     s.distanceMi, s.gainFt, s.minFt, s.maxFt, uid, JSON.stringify(cleanSections(req.body.sections, geom.coordinates.length))]
  );
  const trailId = rows[0].id;
  // Optional first ride logged together with the trail
  if (req.body.ride && req.body.ride.ride_date) {
    await insertRide(trailId, req.body.ride, uid);
  }
  res.json({ id: trailId });
}));

app.put('/api/trails/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const t = cleanTrail(req.body);
  if (!t.name) return res.status(400).json({ error: 'Trail name is required' });
  const sets = ['name=$1', 'area=$2', 'state=$3', 'difficulty=$4', 'trail_type=$5', 'rating=$6', 'color=$7', 'notes=$8',
                'updated_by=$9', 'updated_at=now()'];
  const params = [t.name, t.area, t.state, t.difficulty, t.trail_type, t.rating, t.color, t.notes, req.session.user.id];
  if (req.body.geometry) {
    const geom = validateGeometry(req.body.geometry);
    if (!geom) return res.status(400).json({ error: 'Trail needs a line with at least 2 points' });
    const s = computeStats(geom);
    params.push(geom, s.distanceMi, s.gainFt, s.minFt, s.maxFt);
    const n = params.length;
    sets.push(`geometry=$${n - 4}`, `distance_mi=$${n - 3}`, `elevation_gain_ft=$${n - 2}`, `min_ele_ft=$${n - 1}`, `max_ele_ft=$${n}`);
  }
  if (req.body.sections !== undefined) {
    let lineCount;
    if (req.body.geometry) lineCount = validateGeometry(req.body.geometry).coordinates.length;
    else {
      const cur = await q('SELECT jsonb_array_length(geometry->\'coordinates\') AS n FROM trails WHERE id=$1', [id]);
      lineCount = cur.rows[0] ? cur.rows[0].n : 0;
    }
    params.push(JSON.stringify(cleanSections(req.body.sections, lineCount)));
    sets.push(`sections=$${params.length}`);
  }
  params.push(id);
  const r = await q(`UPDATE trails SET ${sets.join(', ')} WHERE id=$${params.length}`, params);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

app.delete('/api/trails/:id', wrap(async (req, res) => {
  await q('DELETE FROM trails WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.get('/api/trails/:id/gpx', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM trails WHERE id=$1', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).send('Not found');
  const fname = rows[0].name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'trail';
  res.setHeader('Content-Type', 'application/gpx+xml');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}.gpx"`);
  const wps = await q('SELECT name, kind, notes, lat, lng FROM waypoints WHERE trail_id=$1 ORDER BY name', [rows[0].id]);
  res.send(toGpx([rows[0]], APP_NAME, wps.rows));
}));

// ----- Rides -----
async function insertRide(trailId, body, uid) {
  const date = String(body.ride_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Ride date is required'), { status: 400 });
  const riders = Array.isArray(body.riders) ? body.riders.map((r) => String(r).trim().slice(0, 60)).filter(Boolean) : [];
  const { rows } = await q(
    'INSERT INTO rides (trail_id, ride_date, riders, conditions, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [trailId, date, riders, body.conditions ? String(body.conditions).slice(0, 200) : null,
     body.notes ? String(body.notes).slice(0, 5000) : null, uid]
  );
  return rows[0].id;
}

app.post('/api/trails/:id/rides', wrap(async (req, res) => {
  const id = await insertRide(Number(req.params.id), req.body, req.session.user.id);
  res.json({ id });
}));

app.put('/api/rides/:id', wrap(async (req, res) => {
  const date = String(req.body.ride_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Ride date is required' });
  const riders = Array.isArray(req.body.riders) ? req.body.riders.map((r) => String(r).trim().slice(0, 60)).filter(Boolean) : [];
  await q('UPDATE rides SET ride_date=$1, riders=$2, conditions=$3, notes=$4 WHERE id=$5',
    [date, riders, req.body.conditions || null, req.body.notes || null, Number(req.params.id)]);
  res.json({ ok: true });
}));

app.delete('/api/rides/:id', wrap(async (req, res) => {
  await q('DELETE FROM rides WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ----- Photos (stored in the database; the browser shrinks them before upload) -----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 2 } });
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

app.post('/api/trails/:id/photos', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]), wrap(async (req, res) => {
  const photo = req.files && req.files.photo && req.files.photo[0];
  const thumb = req.files && req.files.thumb && req.files.thumb[0];
  if (!photo || !IMAGE_TYPES.includes(photo.mimetype)) return res.status(400).json({ error: 'Upload a JPG, PNG or WebP image' });
  const { rows } = await q(
    'INSERT INTO photos (trail_id, caption, mime, data, thumb, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [Number(req.params.id), req.body.caption ? String(req.body.caption).slice(0, 300) : null, photo.mimetype,
     photo.buffer, thumb ? thumb.buffer : null, req.session.user.id]
  );
  res.json({ id: rows[0].id });
}));

app.get('/api/photos/:id', wrap(async (req, res) => {
  const wantThumb = req.query.thumb === '1';
  const { rows } = await q(`SELECT mime, ${wantThumb ? 'COALESCE(thumb, data)' : 'data'} AS img FROM photos WHERE id=$1`, [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).send('Not found');
  res.setHeader('Content-Type', wantThumb ? 'image/jpeg' : rows[0].mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(rows[0].img);
}));

app.put('/api/photos/:id', wrap(async (req, res) => {
  await q('UPDATE photos SET caption=$1 WHERE id=$2', [req.body.caption ? String(req.body.caption).slice(0, 300) : null, Number(req.params.id)]);
  res.json({ ok: true });
}));

app.delete('/api/photos/:id', wrap(async (req, res) => {
  await q('DELETE FROM photos WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ----- Stats -----
app.get('/api/stats', wrap(async (req, res) => {
  const totals = await q(`SELECT COUNT(*)::int AS trails, COALESCE(SUM(distance_mi),0)::float AS miles FROM trails`);
  const rides = await q(`SELECT COUNT(*)::int AS rides, COUNT(DISTINCT trail_id)::int AS trails_ridden FROM rides`);
  const riders = await q(`
    SELECT rider, COUNT(*)::int AS rides, COUNT(DISTINCT r.trail_id)::int AS trails,
           COALESCE(SUM(t.distance_mi),0)::float AS miles
    FROM rides r CROSS JOIN LATERAL unnest(r.riders) AS rider
    JOIN trails t ON t.id = r.trail_id
    GROUP BY rider ORDER BY miles DESC`);
  const years = await q(`
    SELECT EXTRACT(YEAR FROM ride_date)::int AS year, COUNT(*)::int AS rides,
           COALESCE(SUM(t.distance_mi),0)::float AS miles
    FROM rides r JOIN trails t ON t.id = r.trail_id GROUP BY 1 ORDER BY 1 DESC`);
  res.json({ ...totals.rows[0], ...rides.rows[0], riders: riders.rows, years: years.rows });
}));

// ----- Backup / export everything -----
app.get('/api/export/geojson', wrap(async (req, res) => {
  const trails = await q('SELECT * FROM trails ORDER BY id');
  const rides = await q(`SELECT trail_id, to_char(ride_date,'YYYY-MM-DD') AS ride_date, riders, conditions, notes FROM rides ORDER BY ride_date`);
  const wps = await q('SELECT name, kind, notes, lat, lng, trail_id FROM waypoints ORDER BY id');
  const byTrail = {};
  for (const r of rides.rows) (byTrail[r.trail_id] = byTrail[r.trail_id] || []).push(r);
  const fc = {
    type: 'FeatureCollection',
    exported_at: new Date().toISOString(),
    features: trails.rows.map((t) => ({
      type: 'Feature',
      geometry: t.geometry,
      properties: {
        name: t.name, area: t.area, state: t.state, difficulty: t.difficulty, trail_type: t.trail_type,
        rating: t.rating, color: t.color, notes: t.notes, source: t.source, sections: t.sections,
        distance_mi: t.distance_mi === null ? null : Number(t.distance_mi), elevation_gain_ft: t.elevation_gain_ft,
        rides: (byTrail[t.id] || []).map(({ trail_id, ...r }) => r),
      },
    })).concat(wps.rows.map((w) => {
      const t = trails.rows.find((x) => x.id === w.trail_id);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [w.lng, w.lat] },
        properties: { waypoint: true, name: w.name, kind: w.kind, notes: w.notes, trail: t ? t.name : null },
      };
    })),
  };
  res.setHeader('Content-Disposition', `attachment; filename="trails-backup-${new Date().toISOString().slice(0, 10)}.geojson"`);
  res.json(fc);
}));

app.get('/api/export/gpx', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM trails ORDER BY name');
  const wps = await q('SELECT name, kind, notes, lat, lng FROM waypoints ORDER BY name');
  res.setHeader('Content-Type', 'application/gpx+xml');
  res.setHeader('Content-Disposition', 'attachment; filename="all-trails.gpx"');
  res.send(toGpx(rows, APP_NAME, wps.rows));
}));


// ----- Waypoints -----
const WAYPOINT_KINDS = ['gas', 'camp', 'water', 'hazard', 'view', 'trailhead', 'food', 'other'];
function cleanWaypoint(b) {
  const lat = Number(b.lat); const lng = Number(b.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw Object.assign(new Error('Waypoint needs a location'), { status: 400 });
  }
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw Object.assign(new Error('Waypoint name is required'), { status: 400 });
  return {
    name,
    kind: WAYPOINT_KINDS.includes(b.kind) ? b.kind : 'other',
    notes: b.notes ? String(b.notes).trim().slice(0, 3000) : null,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    trail_id: b.trail_id ? Number(b.trail_id) || null : null,
  };
}
const WAYPOINT_SQL = `SELECT w.id, w.name, w.kind, w.notes, w.lat, w.lng, w.trail_id, w.created_at, w.updated_at,
  u.display_name AS created_by_name FROM waypoints w LEFT JOIN users u ON u.id = w.created_by`;

app.get('/api/waypoints', wrap(async (req, res) => {
  const { rows } = await q(WAYPOINT_SQL + ' ORDER BY w.name');
  res.json(rows);
}));

app.post('/api/waypoints', wrap(async (req, res) => {
  // Accepts one waypoint, or { waypoints: [...] } for a GPX import
  const list = Array.isArray(req.body.waypoints) ? req.body.waypoints.slice(0, 500) : [req.body];
  const ids = [];
  for (const raw of list) {
    const w = cleanWaypoint(raw);
    const { rows } = await q(
      'INSERT INTO waypoints (name, kind, notes, lat, lng, trail_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [w.name, w.kind, w.notes, w.lat, w.lng, w.trail_id, req.session.user.id]);
    ids.push(rows[0].id);
  }
  res.json(Array.isArray(req.body.waypoints) ? { ids } : { id: ids[0] });
}));

app.put('/api/waypoints/:id', wrap(async (req, res) => {
  const w = cleanWaypoint(req.body);
  const r = await q('UPDATE waypoints SET name=$1, kind=$2, notes=$3, lat=$4, lng=$5, trail_id=$6, updated_at=now() WHERE id=$7',
    [w.name, w.kind, w.notes, w.lat, w.lng, w.trail_id, Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

app.delete('/api/waypoints/:id', wrap(async (req, res) => {
  await q('DELETE FROM waypoints WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ----- Planned rides & sign-ups -----
function cleanPlanned(b) {
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) throw Object.assign(new Error('Give the ride a name'), { status: 400 });
  const date = String(b.ride_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Object.assign(new Error('Pick a date'), { status: 400 });
  const lat = Number(b.meet_lat); const lng = Number(b.meet_lng);
  const hasLoc = b.meet_lat !== null && b.meet_lat !== '' && b.meet_lat !== undefined && Number.isFinite(lat) && Number.isFinite(lng);
  return {
    title, date,
    meet_time: b.meet_time ? String(b.meet_time).slice(0, 20) : null,
    meet_place: b.meet_place ? String(b.meet_place).trim().slice(0, 200) : null,
    meet_lat: hasLoc ? lat : null,
    meet_lng: hasLoc ? lng : null,
    trail_ids: Array.isArray(b.trail_ids) ? b.trail_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 30) : [],
    notes: b.notes ? String(b.notes).trim().slice(0, 5000) : null,
  };
}

app.get('/api/planned', wrap(async (req, res) => {
  const { rows } = await q(`
    SELECT p.id, p.title, to_char(p.ride_date,'YYYY-MM-DD') AS ride_date, p.meet_time, p.meet_place, p.meet_lat, p.meet_lng,
           p.trail_ids, p.notes, p.logged, p.created_at, u.display_name AS created_by_name,
           COALESCE((SELECT json_agg(json_build_object('user_id', s.user_id, 'name', su.display_name, 'status', s.status, 'note', s.note)
                     ORDER BY su.display_name)
                     FROM ride_signups s JOIN users su ON su.id = s.user_id WHERE s.planned_ride_id = p.id), '[]') AS signups
    FROM planned_rides p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.ride_date >= CURRENT_DATE - INTERVAL '120 days'
    ORDER BY p.ride_date, p.id`);
  res.json(rows);
}));

app.post('/api/planned', wrap(async (req, res) => {
  const p = cleanPlanned(req.body);
  const { rows } = await q(
    `INSERT INTO planned_rides (title, ride_date, meet_time, meet_place, meet_lat, meet_lng, trail_ids, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.title, p.date, p.meet_time, p.meet_place, p.meet_lat, p.meet_lng, p.trail_ids, p.notes, req.session.user.id]);
  // The organizer is going by default
  await q(`INSERT INTO ride_signups (planned_ride_id, user_id, status) VALUES ($1,$2,'going') ON CONFLICT DO NOTHING`,
    [rows[0].id, req.session.user.id]);
  res.json({ id: rows[0].id });
}));

app.put('/api/planned/:id', wrap(async (req, res) => {
  const p = cleanPlanned(req.body);
  const r = await q(
    `UPDATE planned_rides SET title=$1, ride_date=$2, meet_time=$3, meet_place=$4, meet_lat=$5, meet_lng=$6, trail_ids=$7, notes=$8 WHERE id=$9`,
    [p.title, p.date, p.meet_time, p.meet_place, p.meet_lat, p.meet_lng, p.trail_ids, p.notes, Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

app.delete('/api/planned/:id', wrap(async (req, res) => {
  await q('DELETE FROM planned_rides WHERE id=$1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

app.post('/api/planned/:id/signup', wrap(async (req, res) => {
  const status = ['going', 'maybe', 'out'].includes(req.body.status) ? req.body.status : null;
  const id = Number(req.params.id);
  if (!status) {
    await q('DELETE FROM ride_signups WHERE planned_ride_id=$1 AND user_id=$2', [id, req.session.user.id]);
  } else {
    await q(`INSERT INTO ride_signups (planned_ride_id, user_id, status, note) VALUES ($1,$2,$3,$4)
             ON CONFLICT (planned_ride_id, user_id) DO UPDATE SET status=EXCLUDED.status, note=EXCLUDED.note, updated_at=now()`,
      [id, req.session.user.id, status, req.body.note ? String(req.body.note).slice(0, 200) : null]);
  }
  res.json({ ok: true });
}));

// Turn a finished planned ride into ride-log entries on each of its trails
app.post('/api/planned/:id/log', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await q(`SELECT *, to_char(ride_date,'YYYY-MM-DD') AS d FROM planned_rides WHERE id=$1`, [id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: 'Not found' });
  const riders = Array.isArray(req.body.riders) ? req.body.riders.map((r) => String(r).trim().slice(0, 60)).filter(Boolean) : [];
  const trailIds = Array.isArray(req.body.trail_ids) ? req.body.trail_ids.map(Number) : p.trail_ids;
  let n = 0;
  for (const tid of trailIds) {
    const ok = await q('SELECT 1 FROM trails WHERE id=$1', [tid]);
    if (!ok.rowCount) continue;
    await insertRide(tid, { ride_date: p.d, riders, conditions: req.body.conditions, notes: req.body.notes || p.title }, req.session.user.id);
    n++;
  }
  await q('UPDATE planned_rides SET logged=TRUE WHERE id=$1', [id]);
  res.json({ ok: true, logged: n });
}));


// ----- Explore public trail data (Forest Service MVUM, BLM, OpenStreetMap) -----
const USFS_MVUM = process.env.EXPLORE_USFS_URL || 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_01/MapServer';
const BLM_GTLF = process.env.EXPLORE_BLM_URL || 'https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF/MapServer';
const BLM_WHERE = "PLAN_MODE_TRNSPRT='Motorized' AND PLAN_OHV_ROUTE_DSGNTN IN ('Open','Limited')";
const OVERPASS = process.env.EXPLORE_OVERPASS_URL ? [process.env.EXPLORE_OVERPASS_URL] : ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const UA = `${APP_NAME} (private trail log for a small riding group)`;
const USFS_FIELDS = 'id,name,forestname,districtname,securityid,motorcycle,motorcycle_datesopen,seasonal,trailclass,trailsystem,mvum_symbol_name,gis_miles,symbol';
const BLM_FIELDS = 'ROUTE_PRMRY_NM,ROUTE_SCNDRY_SPCL_DSGNTN_NM,OBSRVE_ROUTE_USE_CLASS,OBSRVE_SRFCE_TYPE,PLAN_OHV_ROUTE_DSGNTN,PLAN_ASSET_CLASS,ADMIN_ST,GIS_MILES';

async function fetchJson(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const r5 = (n) => Math.round(n * 1e5) / 1e5;
const cleanLines = (lines) => lines.map((l) => l.map((c) => [r5(c[0]), r5(c[1])])).filter((l) => l.length >= 2);
function linesFromGeoJson(g) {
  if (!g) return [];
  if (g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString') return g.coordinates;
  return [];
}
const lineMi = (l) => l.reduce((s, c, i) => (i ? s + require('./lib/geo').haversineMi(l[i - 1], c) : 0), 0);
const isOpen = (v) => v && String(v).trim() && !/^(no|n|closed|null)$/i.test(String(v).trim());
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).trim();

function arcgisQueryUrl(base, layer, where, envelope, fields, extra = '') {
  const p = new URLSearchParams({
    where, outFields: fields, returnGeometry: 'true', outSR: '4326', f: 'geojson',
    geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    maxAllowableOffset: '0.00003', resultRecordCount: '1500',
  });
  if (envelope) p.set('geometry', envelope.join(','));
  return `${base}/${layer}/query?${p.toString()}${extra}`;
}

function usfsResult(groupKey, feats) {
  const a = feats[0].properties;
  const lines = cleanLines(feats.flatMap((f) => linesFromGeoJson(f.geometry)));
  const nm = a.name && a.name.trim() ? titleCase(a.name) : `Forest Service ${a.layerKind === 'road' ? 'road' : 'trail'} ${a.id || ''}`.trim();
  const facts = [
    a.mvum_symbol_name,
    isOpen(a.motorcycle) ? `Motorcycles: open${a.motorcycle_datesopen ? ` ${a.motorcycle_datesopen}` : ''}` : 'Motorcycles: check the MVUM',
    a.forestname ? `${titleCase(a.forestname)}${a.districtname ? `, ${titleCase(a.districtname)}` : ''}` : null,
    a.id ? `Route number ${a.id}` : null,
  ].filter(Boolean);
  return {
    key: `usfs:${groupKey}`, source: 'usfs', sourceLabel: 'Forest Service', kind: a.layerKind,
    name: nm, ref: a.id || null, motorcycle: isOpen(a.motorcycle) ? 'open' : 'unknown',
    seasonal: a.motorcycle_datesopen || null, facts,
    geometry: { type: 'MultiLineString', coordinates: lines },
    miles: Math.round(lines.reduce((s, l) => s + lineMi(l), 0) * 10) / 10,
  };
}

function blmResult(groupKey, feats) {
  const a = feats[0].properties;
  const lines = cleanLines(feats.flatMap((f) => linesFromGeoJson(f.geometry)));
  const facts = [
    a.PLAN_OHV_ROUTE_DSGNTN ? `OHV designation: ${a.PLAN_OHV_ROUTE_DSGNTN}` : null,
    a.OBSRVE_ROUTE_USE_CLASS ? `Route type: ${a.OBSRVE_ROUTE_USE_CLASS}` : null,
    a.OBSRVE_SRFCE_TYPE ? `Surface: ${a.OBSRVE_SRFCE_TYPE}` : null,
    a.ROUTE_SCNDRY_SPCL_DSGNTN_NM ? a.ROUTE_SCNDRY_SPCL_DSGNTN_NM : null,
    a.ADMIN_ST ? `BLM ${a.ADMIN_ST}` : null,
  ].filter(Boolean);
  return {
    key: `blm:${groupKey}`, source: 'blm', sourceLabel: 'BLM', kind: 'route',
    name: a.ROUTE_PRMRY_NM ? String(a.ROUTE_PRMRY_NM).trim() : 'BLM route', ref: null,
    motorcycle: 'open', seasonal: null, facts,
    geometry: { type: 'MultiLineString', coordinates: lines },
    miles: Math.round(lines.reduce((s, l) => s + lineMi(l), 0) * 10) / 10,
  };
}

function osmResult(name, ways) {
  const lines = cleanLines(ways.map((w) => (w.geometry || []).map((g) => [g.lon, g.lat])));
  const tags = ways[0].tags || {};
  const pick = (k) => { const v = ways.map((w) => (w.tags || {})[k]).find(Boolean); return v || null; };
  const hw = pick('highway');
  const facts = [
    hw === 'track' ? `Dirt track${pick('tracktype') ? ` (${pick('tracktype')})` : ''}` : hw === 'path' ? 'Trail / singletrack' : hw ? `Road (${hw})` : null,
    pick('surface') ? `Surface: ${pick('surface')}` : null,
    pick('motorcycle') ? `Motorcycles: ${pick('motorcycle')}` : null,
    pick('ref') ? `Number ${pick('ref')}` : null,
    pick('operator') ? pick('operator') : null,
  ].filter(Boolean);
  return {
    key: `osm:${name.toLowerCase()}`, source: 'osm', sourceLabel: 'OpenStreetMap', kind: hw === 'path' ? 'trail' : 'road',
    name, ref: tags.ref || null,
    motorcycle: /^(yes|designated|permissive)$/.test(pick('motorcycle') || '') ? 'open' : 'unknown', seasonal: null, facts,
    geometry: { type: 'MultiLineString', coordinates: lines },
    miles: Math.round(lines.reduce((s, l) => s + lineMi(l), 0) * 10) / 10,
  };
}

function group(features, keyFn) {
  const m = new Map();
  for (const f of features) {
    const k = keyFn(f);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(f);
  }
  return m;
}

async function searchUsfs(env) {
  const out = [];
  for (const [layer, kind] of [[2, 'trail'], [1, 'road']]) {
    const fc = await fetchJson(arcgisQueryUrl(USFS_MVUM, layer, '1=1', env, USFS_FIELDS));
    const feats = (fc.features || []).map((f) => ({ ...f, properties: { ...f.properties, layerKind: kind } }));
    // Roads: keep the named ones and anything open to motorcycles; unnamed numbered roads are too many to list
    const keep = kind === 'trail' ? feats : feats.filter((f) => (f.properties.name || '').trim());
    for (const [k, fs] of group(keep, (f) => `${kind}:${f.properties.securityid || ''}:${f.properties.id || f.properties.name}`)) out.push(usfsResult(k, fs));
  }
  return out;
}

async function searchBlm(env) {
  const fc = await fetchJson(arcgisQueryUrl(BLM_GTLF, 0, `${BLM_WHERE} AND ROUTE_PRMRY_NM IS NOT NULL`, env, BLM_FIELDS));
  const out = [];
  for (const [k, fs] of group(fc.features || [], (f) => (f.properties.ROUTE_PRMRY_NM || '').trim().toLowerCase())) out.push(blmResult(k, fs));
  return out;
}

async function searchOsm([w, s, e, n]) {
  const bbox = `${s},${w},${n},${e}`;
  const query = `[out:json][timeout:25];
(
  way["highway"~"^(track|path|unclassified)$"]["name"]["motorcycle"!~"^(no|private)$"]["access"!~"^(no|private)$"]["surface"!~"^(asphalt|paved|concrete)$"](${bbox});
  way["highway"]["name"]["motorcycle"~"^(yes|designated|permissive)$"](${bbox});
);
out geom 1500;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const data = await fetchJson(url, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 30000);
      const out = [];
      for (const [k, ways] of group(data.elements || [], (el) => (el.tags && el.tags.name ? el.tags.name.trim() : null))) out.push(osmResult(k, ways));
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function parseBbox(q) {
  const v = ['w', 's', 'e', 'n'].map((k) => Number(q[k]));
  if (!v.every(Number.isFinite) || v[0] >= v[2] || v[1] >= v[3]) throw Object.assign(new Error('Bad map area'), { status: 400 });
  if (v[2] - v[0] > 0.8 || v[3] - v[1] > 0.6) throw Object.assign(new Error('Zoom in a bit more. The search area is too big.'), { status: 400 });
  return v;
}

app.get('/api/explore/search', wrap(async (req, res) => {
  const env = parseBbox(req.query);
  const wanted = String(req.query.sources || 'usfs,blm,osm').split(',');
  const jobs = { usfs: searchUsfs, blm: searchBlm, osm: searchOsm };
  const status = {};
  const results = [];
  await Promise.all(Object.entries(jobs).filter(([k]) => wanted.includes(k)).map(async ([k, fn]) => {
    try { const r = await fn(env); results.push(...r); status[k] = { ok: true, count: r.length }; }
    catch (e) { status[k] = { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message }; console.warn(`explore ${k} failed:`, e.message); }
  }));
  results.forEach((r) => { r.miles = r.miles || 0; });
  results.sort((a, b) => (a.source === b.source ? b.miles - a.miles : ['usfs', 'blm', 'osm'].indexOf(a.source) - ['usfs', 'blm', 'osm'].indexOf(b.source)));
  res.json({ results: results.filter((r) => r.geometry.coordinates.length).slice(0, 300), status });
}));

// What's at a tapped spot on the Forest Service / BLM layers
app.get('/api/explore/identify', wrap(async (req, res) => {
  const lat = Number(req.query.lat); const lng = Number(req.query.lng);
  const env = parseBbox(req.query.w ? req.query : { w: lng - 0.05, s: lat - 0.05, e: lng + 0.05, n: lat + 0.05 });
  const width = Math.min(4000, Number(req.query.width) || 800); const height = Math.min(4000, Number(req.query.height) || 600);
  const layers = String(req.query.layers || 'usfs,blm').split(',');
  const common = {
    geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', sr: '4326', tolerance: '8',
    mapExtent: env.join(','), imageDisplay: `${width},${height},96`, returnGeometry: 'true', maxAllowableOffset: '0.00003', f: 'json',
    returnFieldName: 'true', returnUnformattedValues: 'true',
  };
  // Older servers answer with field aliases ("Forest Name"); map those back to field names
  const USFS_ALIASES = { name: 'name', id: 'id', motorcycle: 'motorcycle', motorcycledatesopen: 'motorcycle_datesopen', motorcyledatesopen: 'motorcycle_datesopen',
    forestname: 'forestname', rangerdistrictname: 'districtname', districtname: 'districtname', forestcode: 'securityid', securityid: 'securityid',
    mvumsymbolname: 'mvum_symbol_name', gismiles: 'gis_miles', seasonal: 'seasonal', trailclass: 'trailclass', trailsystem: 'trailsystem' };
  const normUsfs = (attrs) => {
    const a = {};
    for (const [k, v] of Object.entries(attrs || {})) {
      const key = USFS_ALIASES[k.toLowerCase().replace(/[^a-z0-9]/g, '')] || k.toLowerCase();
      a[key] = v === 'Null' || v === '' ? null : v;
    }
    return a;
  };
  const toLines = (g) => (g && g.paths ? g.paths : []);
  const out = [];
  await Promise.all([
    layers.includes('usfs') && (async () => {
      const p = new URLSearchParams({ ...common, layers: 'all:1,2' });
      const r = await fetchJson(`${USFS_MVUM}/identify?${p}`).catch(() => ({ results: [] }));
      for (const hit of (r.results || []).slice(0, 3)) {
        const a = normUsfs(hit.attributes);
        a.layerKind = hit.layerId === 1 ? 'road' : 'trail';
        out.push(usfsResult(`${a.layerKind}:${a.securityid || ''}:${a.id || a.name}`, [{ properties: a, geometry: { type: 'MultiLineString', coordinates: toLines(hit.geometry) } }]));
      }
    })(),
    layers.includes('blm') && (async () => {
      const p = new URLSearchParams({ ...common, layers: 'all:0', layerDefs: JSON.stringify({ 0: BLM_WHERE }) });
      const r = await fetchJson(`${BLM_GTLF}/identify?${p}`).catch(() => ({ results: [] }));
      for (const hit of (r.results || []).slice(0, 3)) {
        const a = Object.fromEntries(Object.entries(hit.attributes || {}).map(([k, v]) => [k.toUpperCase(), v === 'Null' ? null : v]));
        out.push(blmResult(`${(a.ROUTE_PRMRY_NM || '').toLowerCase()}`, [{ properties: a, geometry: { type: 'MultiLineString', coordinates: toLines(hit.geometry) } }]));
      }
    })(),
  ].filter(Boolean));
  res.json({ results: out });
}));

// The complete line for a public route (all its segments), so it can be added as a trail
app.get('/api/explore/route', wrap(async (req, res) => {
  const { key } = req.query;
  const lat = Number(req.query.lat); const lng = Number(req.query.lng);
  const near = Number.isFinite(lat) && Number.isFinite(lng) ? [lng - 0.4, lat - 0.3, lng + 0.4, lat + 0.3] : null;
  const esc1 = (v) => String(v).replace(/'/g, "''");
  let m;
  if ((m = /^usfs:(trail|road):([^:]*):(.+)$/.exec(key || ''))) {
    const [, kind, forest, id] = m;
    const where = `id='${esc1(id)}'${forest ? ` AND securityid='${esc1(forest)}'` : ''}`;
    const fc = await fetchJson(arcgisQueryUrl(USFS_MVUM, kind === 'road' ? 1 : 2, where, null, USFS_FIELDS));
    const feats = (fc.features || []).map((f) => ({ ...f, properties: { ...f.properties, layerKind: kind } }));
    if (!feats.length) return res.status(404).json({ error: 'Route not found' });
    return res.json(usfsResult(`${kind}:${forest}:${id}`, feats));
  }
  if ((m = /^blm:(.+)$/.exec(key || ''))) {
    const fc = await fetchJson(arcgisQueryUrl(BLM_GTLF, 0, `${BLM_WHERE} AND LOWER(ROUTE_PRMRY_NM)='${esc1(m[1])}'`, near, BLM_FIELDS));
    if (!(fc.features || []).length) return res.status(404).json({ error: 'Route not found' });
    return res.json(blmResult(m[1], fc.features));
  }
  res.status(400).json({ error: 'Unknown route' });
}));

// ----- Offline map tiles -----
// Tiles for offline use are downloaded through here so the browser can store them.
// Only USGS (public domain) maps are offered; other providers don't allow bulk downloads.
const TILE_SOURCES = {
  'usgs-topo': 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile',
  'usgs-imagery': 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile',
};
app.get('/tiles/:layer/:z/:y/:x', wrap(async (req, res) => {
  const base = TILE_SOURCES[req.params.layer];
  const z = Number(req.params.z); const y = Number(req.params.y); const x = Number(req.params.x);
  if (!base || ![z, y, x].every(Number.isInteger) || z < 0 || z > 16 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
    return res.status(400).send('Bad tile');
  }
  const r = await fetch(`${base}/${z}/${y}/${x}`, { headers: { 'User-Agent': `${APP_NAME} trail map (offline tile cache)` } });
  if (!r.ok) return res.status(r.status === 404 ? 404 : 502).send('Tile unavailable');
  res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.send(Buffer.from(await r.arrayBuffer()));
}));

// ---------- Errors ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Photo is too large (6 MB max)' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

// The database can still be starting when the app boots (e.g. on a first deploy), so retry for ~2 minutes.
async function initWithRetry(attempt = 1) {
  try {
    await init();
  } catch (e) {
    const retryable = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '57P03'].includes(e.code);
    if (!retryable || attempt >= 24) throw e;
    console.log(`Database not ready (${e.code}); retrying in 5s (attempt ${attempt} of 24)…`);
    await new Promise((r) => setTimeout(r, 5000));
    return initWithRetry(attempt + 1);
  }
}

initWithRetry()
  .then(() => app.listen(PORT, () => console.log(`${APP_NAME} running on port ${PORT}`)))
  .catch((e) => {
    console.error('Startup failed:', e);
    process.exit(1);
  });
