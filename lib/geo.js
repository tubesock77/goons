'use strict';

const R_MILES = 3958.7613;
const M_TO_FT = 3.28084;

function haversineMi(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

// geometry: GeoJSON MultiLineString, coordinates [lng, lat, ele_meters?]
function computeStats(geometry) {
  let dist = 0;
  let gainM = 0;
  let minM = Infinity;
  let maxM = -Infinity;
  let hasEle = false;
  const THRESHOLD_M = 3; // ignore GPS elevation jitter smaller than this

  for (const line of geometry.coordinates) {
    let ref = null;
    for (let i = 0; i < line.length; i++) {
      if (i > 0) dist += haversineMi(line[i - 1], line[i]);
      const ele = line[i][2];
      if (typeof ele === 'number' && Number.isFinite(ele)) {
        hasEle = true;
        if (ele < minM) minM = ele;
        if (ele > maxM) maxM = ele;
        if (ref === null) ref = ele;
        else if (ele - ref > THRESHOLD_M) { gainM += ele - ref; ref = ele; }
        else if (ref - ele > THRESHOLD_M) { ref = ele; }
      }
    }
  }
  return {
    distanceMi: Math.round(dist * 100) / 100,
    gainFt: hasEle ? Math.round(gainM * M_TO_FT) : null,
    minFt: hasEle ? Math.round(minM * M_TO_FT) : null,
    maxFt: hasEle ? Math.round(maxM * M_TO_FT) : null,
  };
}

function esc(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function toGpx(trails, creator, waypoints = []) {
  const SYM = { gas: 'Gas Station', camp: 'Campground', water: 'Drinking Water', hazard: 'Danger Area', view: 'Scenic Area', trailhead: 'Trail Head', food: 'Restaurant', other: 'Flag, Blue' };
  const wpts = waypoints.map((w) => `  <wpt lat="${w.lat}" lon="${w.lng}"><name>${esc(w.name)}</name>${w.notes ? `<desc>${esc(w.notes)}</desc>` : ''}<sym>${SYM[w.kind] || SYM.other}</sym><type>${esc(w.kind)}</type></wpt>`).join('\n');
  const tracks = trails.map((t) => {
    const segs = t.geometry.coordinates.map((line) =>
      '    <trkseg>\n' +
      line.map((c) => `      <trkpt lat="${c[1]}" lon="${c[0]}">${c.length > 2 ? `<ele>${c[2]}</ele>` : ''}</trkpt>`).join('\n') +
      '\n    </trkseg>'
    ).join('\n');
    const desc = [t.area, t.state, t.difficulty, t.notes].filter(Boolean).join(' — ');
    return `  <trk>\n    <name>${esc(t.name)}</name>\n${desc ? `    <desc>${esc(desc)}</desc>\n` : ''}${segs}\n  </trk>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${esc(creator)}" xmlns="http://www.topografix.com/GPX/1/1">
${wpts ? wpts + '\n' : ''}${tracks}
</gpx>
`;
}

module.exports = { computeStats, toGpx, haversineMi };
