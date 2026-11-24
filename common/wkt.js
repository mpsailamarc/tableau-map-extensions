/* Minimal WKT reader for spatial values returned by Tableau (e.g. GEOGRAPHY('MULTIPOLYGON(((lon lat, ...)))')).
   WKT.parse(text) -> { polys:[{rings:[Float64Array xy,...], bbox}], lines:[Float64Array xy], pts:[[lon,lat]], bbox:[minLon,minLat,maxLon,maxLat], lab:[lon,lat] } or null.
   Longitudes are made continuous along each ring (so a shape crossing the date line has lon beyond +-180);
   a ring that encircles a pole is closed through the pole. Results are cached by text. */
(function () {
  'use strict';
  const cache = new Map();
  const TOK = /\(|\)|,|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

  function nest(s) {           // "( (x y, x y) )" -> nested arrays, leaves are [x, y(, z)]
    const root = [], st = [root]; let cur = null, m; TOK.lastIndex = 0;
    const flush = () => { if (cur) { st[st.length - 1].push(cur); cur = null; } };
    while ((m = TOK.exec(s))) {
      const t = m[0];
      if (t === '(') { const a = []; st[st.length - 1].push(a); st.push(a); }
      else if (t === ')') { flush(); if (st.length > 1) st.pop(); }
      else if (t === ',') flush();
      else (cur || (cur = [])).push(+t);
    }
    flush(); return root;
  }
  function path(tuples, closed) {
    const n = tuples.length; let a = new Float64Array(n * 2), prev = null;
    for (let i = 0; i < n; i++) {
      let lon = tuples[i][0]; const lat = tuples[i][1];
      if (prev !== null) { while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
      a[2 * i] = lon; a[2 * i + 1] = lat; prev = lon;
    }
    if (closed && n > 2 && Math.abs(a[2 * n - 2] - a[0]) > 180) {      // ring goes round a pole: close it through the pole
      let sum = 0; for (let i = 0; i < n; i++) sum += a[2 * i + 1];
      const pole = sum >= 0 ? 90 : -90, b = new Float64Array(n * 2 + 4); b.set(a);
      b[2 * n] = a[2 * n - 2]; b[2 * n + 1] = pole; b[2 * n + 2] = a[0]; b[2 * n + 3] = pole; a = b;
    }
    return a;
  }
  function bboxOf(arrs, bb) {
    for (const a of arrs) for (let i = 0; i < a.length; i += 2) {
      if (a[i] < bb[0]) bb[0] = a[i]; if (a[i] > bb[2]) bb[2] = a[i];
      if (a[i + 1] < bb[1]) bb[1] = a[i + 1]; if (a[i + 1] > bb[3]) bb[3] = a[i + 1];
    }
  }
  function centroid(r) {          // planar centroid of a ring + its |area|
    let A = 0, cx = 0, cy = 0; const n = r.length / 2;
    for (let i = 0; i < n - 1; i++) { const x0 = r[2 * i], y0 = r[2 * i + 1], x1 = r[2 * i + 2], y1 = r[2 * i + 3], k = x0 * y1 - x1 * y0; A += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k; }
    if (Math.abs(A) < 1e-12) return { a: 0, x: r[0], y: r[1] };
    return { a: Math.abs(A / 2), x: cx / (3 * A), y: cy / (3 * A) };
  }

  function parse(text) {
    if (text == null) return null;
    let g = cache.get(text); if (g !== undefined) return g;
    g = null;
    try { g = parseRaw(String(text)); } catch (e) { g = null; }
    if (cache.size > 20000) cache.clear();
    cache.set(text, g); return g;
  }
  function parseRaw(s) {
    s = s.replace(/^\s*(?:GEOGRAPHY|GEOMETRY)\s*\(\s*'/i, '').replace(/'\s*(?:,\s*\d+\s*)?\)\s*$/, '').replace(/^\s*SRID\s*=\s*\d+\s*;/i, '');
    const m = /^\s*([A-Za-z]+)/.exec(s); if (!m) return null;
    const type = m[1].toUpperCase(), root = nest(s.slice(m[0].length));
    const out = { polys: [], lines: [], pts: [], bbox: [Infinity, Infinity, -Infinity, -Infinity], lab: null };
    const isTuple = x => typeof x[0] === 'number';
    const addPoly = rings => { const rs = rings.map(r => path(r, true)).filter(r => r.length >= 6); if (rs.length) out.polys.push({ rings: rs }); };
    const body = root[0] || [];
    switch (type) {
      case 'POINT': if (body[0]) out.pts.push([body[0][0], body[0][1]]); break;
      case 'MULTIPOINT': body.forEach(p => { const t = isTuple(p) ? p : p[0]; if (t) out.pts.push([t[0], t[1]]); }); break;
      case 'LINESTRING': out.lines.push(path(body, false)); break;
      case 'MULTILINESTRING': body.forEach(l => out.lines.push(path(l, false))); break;
      case 'POLYGON': addPoly(body); break;
      case 'MULTIPOLYGON': body.forEach(addPoly); break;
      default: return null;
    }
    if (!out.polys.length && !out.lines.length && !out.pts.length) return null;
    out.polys.forEach(p => { p.bbox = [Infinity, Infinity, -Infinity, -Infinity]; bboxOf(p.rings, p.bbox); bboxOf([new Float64Array([p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]])], out.bbox); });
    bboxOf(out.lines, out.bbox); out.pts.forEach(p => bboxOf([new Float64Array(p)], out.bbox));
    // label point: centroid of the largest polygon, else middle vertex of the longest line, else the point
    if (out.polys.length) {
      let best = null; out.polys.forEach(p => { const c = centroid(p.rings[0]); if (!best || c.a > best.a) best = c; });
      out.lab = [best.x, best.y];
    } else if (out.lines.length) {
      const l = out.lines.reduce((a, b) => (b.length > a.length ? b : a)), i = Math.floor(l.length / 4) * 2; out.lab = [l[i], l[i + 1]];
    } else out.lab = out.pts[0].slice();
    return out;
  }
  window.WKT = { parse };
})();
