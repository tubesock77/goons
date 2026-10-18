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
const APP_NAME = process.env.APP_NAME || 'Trail Log';

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
  res.setHeader('Referrer-Policy', 'same-origin');
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
         t.geometry, t.source, t.distance_mi::float AS distance_mi, t.elevation_gain_ft,
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
  const source = req.body.source === 'gpx' ? 'gpx' : 'drawn';
  const uid = req.session.user.id;
  const { rows } = await q(
    `INSERT INTO trails (name, area, state, difficulty, trail_type, rating, color, notes, geometry, source,
                         distance_mi, elevation_gain_ft, min_ele_ft, max_ele_ft, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING id`,
    [t.name, t.area, t.state, t.difficulty, t.trail_type, t.rating, t.color, t.notes, geom, source,
     s.distanceMi, s.gainFt, s.minFt, s.maxFt, uid]
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
  res.send(toGpx([rows[0]], APP_NAME));
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
        rating: t.rating, color: t.color, notes: t.notes, source: t.source,
        distance_mi: t.distance_mi === null ? null : Number(t.distance_mi), elevation_gain_ft: t.elevation_gain_ft,
        rides: (byTrail[t.id] || []).map(({ trail_id, ...r }) => r),
      },
    })),
  };
  res.setHeader('Content-Disposition', `attachment; filename="trails-backup-${new Date().toISOString().slice(0, 10)}.geojson"`);
  res.json(fc);
}));

app.get('/api/export/gpx', wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM trails ORDER BY name');
  res.setHeader('Content-Type', 'application/gpx+xml');
  res.setHeader('Content-Disposition', 'attachment; filename="all-trails.gpx"');
  res.send(toGpx(rows, APP_NAME));
}));

// ---------- Errors ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Photo is too large (6 MB max)' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

init()
  .then(() => app.listen(PORT, () => console.log(`${APP_NAME} running on port ${PORT}`)))
  .catch((e) => {
    console.error('Startup failed:', e);
    process.exit(1);
  });
