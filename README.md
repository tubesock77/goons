# Trail Log

A private map and ride log for our riding group. Every trail we've ridden lives on one shared map. Each trail has its details, the rides we've logged on it, and photos.

## What it does

- **Add trails two ways.** Upload a GPX or KML file from onX, Gaia, Strava, Backtracks or a GPS unit. Or draw a trail by hand on the map, which is how to add the ones we rode before anyone recorded them.
- **Edit lines on the map.** Drag points, add points, delete points, draw extra sections (spurs, connectors), redraw from scratch, or swap the line for a GPX later.
- **Trail details.** Name, area, state, difficulty (Easy ● / Moderate ■ / Hard ◆ / Expert ◆◆), trail type, 1–5 star rating, notes and an optional custom line color. Miles, climbing and an elevation profile are calculated automatically from GPX files.
- **Ride log.** Log each time the group rides a trail: date, who went (members plus guests), conditions and notes. A GPX upload fills in the ride date from the recording.
- **Photos** on every trail. They're shrunk in the browser before upload, so phone photos upload quickly.
- **Search and filters** by name, area, difficulty, state or rider. Sort by name, last ridden, length, most ridden or rating.
- **Group stats.** Totals, a per-rider leaderboard and a year-by-year breakdown.
- **Map layers.** Topo, USGS topo, satellite, streets, plus an optional overlay of known trails from OpenStreetMap. There's also a "show my location" button.
- **Exports.** GPX for any trail or for all trails (load them into onX or Gaia for offline use), plus a full GeoJSON backup with rides and notes.
- **Private.** Everything requires a login. Admins add members and reset passwords from the Account tab.
- **Works on phones.** On a phone the map sits on top and the trail panel slides up from the bottom.

## Deploy on Render (about 10 minutes)

### 1. Put the code on GitHub

1. On GitHub, create a new **private** repository, for example `trail-log`. Don't add a README.
2. Upload the code. Either:
   - **Website:** on the empty repo page, click **uploading an existing file**, drag in everything from this folder (including the hidden `.gitignore`, but not `node_modules` if you ran it locally) and commit.
   - **Command line:**
     ```bash
     cd trail-log
     git init
     git add .
     git commit -m "Trail Log"
     git branch -M main
     git remote add origin https://github.com/YOUR-USERNAME/trail-log.git
     git push -u origin main
     ```

### 2. Create the app on Render with the Blueprint

1. In Render, click **New +** then **Blueprint**.
2. Connect GitHub if asked, and pick the `trail-log` repo.
3. Render reads `render.yaml` and shows two things to create: the **trail-log** web service and the **trail-log-db** Postgres database.
4. It asks for two values:
   - `ADMIN_USERNAME`: your login, e.g. `cody`
   - `ADMIN_PASSWORD`: a strong password, 8+ characters
5. Click **Apply**. The first deploy takes a few minutes.
6. Open the `https://trail-log-xxxx.onrender.com` URL Render gives you and sign in.

`SESSION_SECRET` is generated for you. Plans are set to `starter` (web) and `basic-256mb` (database). You can change either in `render.yaml` or in the Render dashboard.

### 3. Add the group

Sign in, open **Account**, and use **Add a member** for each rider. Pick a username and a temporary password, then text them the site link and their login. Each person can change their own password under **Account**.

The name you enter for each member is what shows up in the "Who rode" checkboxes and the stats.

### 4. Optional: your own domain

In Render, go to the trail-log service, then **Settings > Custom Domains**, add something like `trails.yourgroup.com`, and follow the DNS steps.

## Updating the app later

Any change pushed to the `main` branch on GitHub deploys automatically. The trails, rides, photos and members live in the database and are not touched by deploys.

## Backups

- **Account > Full backup (GeoJSON)** downloads every trail, with its rides and notes. It's good to grab one now and then.
- Render's paid Postgres plans also keep their own database backups (see the database's **Recovery** page in Render).
- Photos are stored in the database. The GeoJSON backup doesn't include them, but Render's database backups do.

## Tips for adding trails

- **From onX Offroad:** open the track, choose **Share / Export**, and pick **GPX** (or KML). Then upload it with **Upload GPX**.
- **From Gaia GPS:** open the track, then **Export > GPX**.
- **Several files at once:** select several GPX files in the upload dialog. Each becomes its own trail, and you can rename them before importing.
- **Old trails with no recording:** use **Draw a trail**. Switch to **Satellite** or **USGS topo**, and turn on **Known trails (OSM)** in the layers menu so you can trace the actual route. On a phone, tap along the trail and press **Finish**. On a computer, click along it and double-click to end.
- **Fixing a line:** open the trail, then **Edit > Edit points**. On a computer, right-click a point to delete it. On a phone, long-press it.

Drawn trails don't have elevation data, so climbing shows "–" for them. If you later record one, use **Edit > Replace with GPX** to get the real line and elevation.

## Command-line user tool

If you're ever locked out, open the trail-log service in Render, go to **Shell**, and run:

```bash
npm run create-user -- cody NewPassword123 --admin
```

This creates the user, or resets the password if the user already exists.

## Running it on your own computer (optional)

You need Node 20+ and a Postgres database.

```bash
npm install
cp .env.example .env      # then edit DATABASE_URL and the admin login
npm run local             # http://localhost:3000
```

## How it's built

- **Server:** Node + Express (`server.js`), Postgres for everything (trails, rides, photos, members, sessions). The tables are created automatically on startup (`db/schema.sql`).
- **Front end:** plain HTML/CSS/JS in `public/`, with no build step. Maps use Leaflet, drawing and editing use Leaflet-Geoman, and GPX/KML parsing uses togeojson. All three are served from the app itself rather than outside CDNs.
- **Security:** passwords are hashed with bcrypt, sessions use httpOnly cookies stored in Postgres, login attempts are throttled, and every page and API call requires sign-in.
