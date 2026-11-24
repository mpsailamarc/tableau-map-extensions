/* Routes as curved arcs — Tableau viz extension.
   Encodings (see routes-arcs.trex):
     origin      : up to 3 fields -> a place name and/or its longitude + latitude
     destination : same as origin
     width       : measure -> line width
     color       : any field -> dimension = one colour per member, measure = colour ramp
   Everything else (filters, extra Detail / Tooltip fields) is plain Tableau: the extension draws whatever rows the sheet returns. */
(function () {
  'use strict';
  const { MapView, GlobeView, findCountry, ramp, panel, esc, fmt } = Basemap;
  const D2R = Math.PI / 180, wrap180 = d => ((d + 540) % 360) - 180;
  const PAL = ['#f2a541', '#59c3c3', '#e4572e', '#6c9bd2', '#8bc34a', '#c678dd', '#ff7ab6', '#b0b0b0', '#e8d44d', '#4e79a7'];
  const RAMP = [[0, '#4aa3df'], [0.5, '#f5d76e'], [1, '#e4572e']];
  const STYLE = {
    dark: { bg: '#1b232c', land: '#3b4651', stroke: '#566370', label: '#fff', glow: 'rgba(255,255,255,.9)', dflt: '#f2a541' },
    light: { bg: '#dbe6ea', land: '#f3f2ee', stroke: '#b4b4ae', label: '#222', glow: 'rgba(255,255,255,.95)', dflt: '#d9822b' }
  };
  const content = document.getElementById('content'), hint = document.getElementById('hint'), note = document.getElementById('note');
  const $ = id => document.getElementById(id);

  // ---- options (kept in the workbook through extension settings) ----
  const S = {
    map: TX.settings.get('map', 'flat'), style: TX.settings.get('style', 'dark'), top: +TX.settings.get('top', '0'),
    lw: parseFloat(TX.settings.get('lw', '1')) || 1, curve: parseFloat(TX.settings.get('curve', '0.22')),
    arrows: TX.settings.get('arrows', '0') === '1', anim: TX.settings.get('anim', '0') === '1'
  };
  if (!isFinite(S.curve)) S.curve = 0.22;
  const save = (k, v) => TX.settings.set(k, String(v));
  let model = null, hover = null, phase = 0, homed = false;

  // ---- place resolution ----
  const placeIdx = new Map();
  (window.PLACES || []).forEach(p => placeIdx.set(p[0].toLowerCase(), p));
  function lookup(name) {
    if (name == null || name === '') return null;
    const p = placeIdx.get(String(name).toLowerCase());
    if (p) return { lon: p[1], lat: p[2] };
    const c = findCountry(name);
    return c ? { lon: c.c[0], lat: c.c[1] } : null;
  }
  const bare = n => String(n).replace(/^(SUM|AVG|MIN|MAX|ATTR|MEDIAN|CNT|CNTD|AGG|COUNT|COUNTD)\((.*)\)$/i, '$2');
  const isLon = n => { n = bare(n).toLowerCase(); return n.includes('longitude') || /(^|[^a-z])(lon|lng|long)([^a-z]|$)/.test(n) || /(lon|lng)$/.test(n); };
  const isLat = n => { n = bare(n).toLowerCase(); return n.includes('latitude') || /(^|[^a-z])lat([^a-z]|$)/.test(n) || /lat$/.test(n); };
  function classify(fields) {
    const p = { name: null, lon: null, lat: null };
    const rest = [];
    for (const f of fields) { if (!p.lon && isLon(f.name)) p.lon = f; else if (!p.lat && isLat(f.name)) p.lat = f; else rest.push(f); }
    if (!p.lon && !p.lat) {          // no recognisable names: fall back to field order  [name, lon, lat]
      if (rest.length >= 3) { p.name = rest[0]; p.lon = rest[1]; p.lat = rest[2]; }
      else if (rest.length === 2 && fields.length === 2) { p.lon = rest[0]; p.lat = rest[1]; }
      else p.name = rest[0] || null;
    } else p.name = rest[0] || null;
    return p;
  }
  const numVal = c => { if (!c || c.value === null || c.value === '' || c.value === undefined) return null; const v = Number(c.value); return isFinite(v) ? v : null; };
  function resolve(p, row, nodes, role) {
    let lon = p.lon ? numVal(row[p.lon.name]) : null, lat = p.lat ? numVal(row[p.lat.name]) : null;
    const label = p.name ? String(row[p.name.name].formattedValue) : '';
    if (lon == null || lat == null || Math.abs(lat) > 90 || Math.abs(lon) > 360) {
      const g = lookup(label); if (!g) return null; lon = g.lon; lat = g.lat;
    }
    const key = lon.toFixed(3) + ',' + lat.toFixed(3);
    let n = nodes.get(key);
    if (!n) { n = { lon, lat, label, o: false, d: false, key }; nodes.set(key, n); }
    if (!n.label && label) n.label = label;
    n[role] = true; return n;
  }
  const isMeasureField = f => /^(SUM|AVG|MIN|MAX|MEDIAN|CNT|CNTD|AGG|COUNT|COUNTD|ATTR)\(/i.test(f.name) && !/^ATTR\(/i.test(f.name) ||
    /measure/i.test(String(f.role || f.dataRole || ''));

  function build(rows, enc) {
    const O = enc.origin, D = enc.destination; if (!O || !D) return null;
    const po = classify(O), pd = classify(D), Wf = enc.width && enc.width[0], Cf = enc.color && enc.color[0];
    const nodes = new Map(), routes = []; let skipped = 0;
    for (const r of rows) {
      const a = resolve(po, r, nodes, 'o'), b = resolve(pd, r, nodes, 'd');
      if (!a || !b) { skipped++; continue; }
      if (a === b) continue;
      let w = Wf ? numVal(r[Wf.name]) : null; if (w != null && w < 0) w = 0;
      routes.push({ a, b, w, row: r, cv: Cf ? r[Cf.name] : null });
    }
    routes.sort((x, y) => (y.w || 0) - (x.w || 0));
    const wmax = Math.max(1e-9, ...routes.map(r => r.w || 0));
    // colour
    let cat = null, cmin = 0, cmax = 1;
    const colorIsMeasure = !!Cf && isMeasureField(Cf);
    if (Cf && !colorIsMeasure) {
      const tot = new Map(); routes.forEach(r => { const k = String(r.cv.formattedValue); tot.set(k, (tot.get(k) || 0) + (r.w || 1)); });
      const names = [...tot.keys()].sort((x, y) => tot.get(y) - tot.get(x));
      cat = new Map(names.map((n, i) => [n, PAL[i % PAL.length]]));
    } else if (Cf) {
      const vs = routes.map(r => numVal(r.cv)).filter(v => v != null); cmin = Math.min(...vs); cmax = Math.max(...vs);
    }
    routes.forEach(r => {
      if (cat) r.col = cat.get(String(r.cv.formattedValue));
      else if (Cf) { const v = numVal(r.cv); r.col = v == null ? '#999' : ramp(RAMP, cmax > cmin ? (v - cmin) / (cmax - cmin) : 0.5); }
      else r.col = null;
    });
    // centre of the data on the sphere
    let sx = 0, sy = 0, sz = 0; nodes.forEach(n => { const p = n.lat * D2R, l = n.lon * D2R; sx += Math.cos(p) * Math.cos(l); sy += Math.cos(p) * Math.sin(l); sz += Math.sin(p); });
    const hl = nodes.size ? Math.atan2(sy, sx) / D2R : 125, hp = nodes.size ? Math.atan2(sz, Math.hypot(sx, sy)) / D2R : -18;
    const hide = new Set([po.lon, po.lat, pd.lon, pd.lat].filter(Boolean).map(f => f.name));
    const nameFields = new Set([po.name, pd.name].filter(Boolean).map(f => f.name));
    return { routes, nodes: [...nodes.values()], wmax, Wf, Cf, cat, cmin, cmax, skipped, hl, hp, hide, nameFields, po, pd };
  }
  const visible = () => {
    if (!model) return [];
    const r = S.top ? model.routes.slice(0, S.top) : model.routes;
    return r.slice().reverse();                           // widest drawn last, on top
  };
  const baseW = (r, z) => (r.w == null && !model.Wf ? 1.6 : 0.8 + Math.sqrt((r.w || 0) / model.wmax) * 6 * Math.min(1.4, 0.8 + z * 0.15)) * S.lw;
  const routeCol = r => r.col || STYLE[S.style].dflt;
  const title = r => (r.a.label || r.a.lat.toFixed(2) + ', ' + r.a.lon.toFixed(2)) + ' → ' + (r.b.label || r.b.lat.toFixed(2) + ', ' + r.b.lon.toFixed(2));

  // ---- shared drawing bits ----
  function arrowHead(c, x, y, ux, uy, w) {
    const hl = 4 + w * 1.5, hw = hl * 0.45;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x - ux * hl - uy * hw, y - uy * hl + ux * hw); c.lineTo(x - ux * hl + uy * hw, y - uy * hl - ux * hw); c.closePath(); c.fill();
  }
  function drawNodes(c, proj, z) {
    const T = STYLE[S.style], nOrig = model.nodes.filter(n => n.o).length;
    c.textAlign = 'left';
    for (const n of model.nodes) {
      const P = proj(n); if (!P) continue;
      const orig = n.o;
      c.beginPath(); c.arc(P[0], P[1], orig ? 4.5 : 2.8, 0, 6.3);
      c.fillStyle = orig ? '#ffd24a' : '#fff'; c.fill(); c.strokeStyle = orig ? '#222' : 'rgba(0,0,0,.55)'; c.lineWidth = 1; c.stroke();
      if (n.label && (z >= 2.2 || (orig && nOrig <= 20 && z >= 1))) {
        c.font = (orig ? 'bold ' : '') + '11px -apple-system, "Segoe UI", Arial, sans-serif';
        c.lineWidth = 3; c.strokeStyle = S.style === 'dark' ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.8)'; c.strokeText(n.label, P[0] + 7, P[1] + 4);
        c.fillStyle = T.label; c.fillText(n.label, P[0] + 7, P[1] + 4);
      }
    }
  }
  function drawLegend(c, W, H, z) {
    const m = model; if (!m.Wf && !m.Cf) return;
    c.font = '11px -apple-system, "Segoe UI", Arial, sans-serif'; c.textBaseline = 'middle';
    const cats = m.cat ? [...m.cat].slice(0, 8) : [], more = m.cat ? m.cat.size - cats.length : 0;
    const hC = m.Cf ? (m.cat ? 18 + cats.length * 16 + (more > 0 ? 16 : 0) : 46) : 0, hW = m.Wf ? 18 + 3 * 17 : 0;
    const w = 168, h = hC + hW + 10, x = 8, y = Math.max(8, H - h - 20);
    panel(c, x, y, w, h); let yy = y + 14; c.fillStyle = '#222';
    if (m.Cf) {
      c.font = 'bold 11px -apple-system, "Segoe UI", Arial, sans-serif'; c.fillText(m.Cf.name, x + 10, yy); c.font = '11px -apple-system, "Segoe UI", Arial, sans-serif';
      if (m.cat) {
        yy += 18; cats.forEach(([n, col]) => { c.fillStyle = col; c.fillRect(x + 10, yy - 3, 16, 5); c.fillStyle = '#222'; c.fillText(n.length > 24 ? n.slice(0, 23) + '…' : n, x + 32, yy); yy += 16; });
        if (more > 0) { c.fillStyle = '#666'; c.fillText('+' + more + ' more', x + 32, yy); yy += 16; }
      } else {
        const g = c.createLinearGradient(x + 10, 0, x + w - 10, 0); RAMP.forEach(s => g.addColorStop(s[0], s[1]));
        c.fillStyle = g; c.fillRect(x + 10, yy + 7, w - 20, 9); c.fillStyle = '#222'; c.textAlign = 'left'; c.fillText(fmt(Math.round(m.cmin)), x + 10, yy + 27);
        c.textAlign = 'right'; c.fillText(fmt(Math.round(m.cmax)), x + w - 10, yy + 27); c.textAlign = 'left'; yy += 46 - 14 + 6;
      }
      yy += 2;
    }
    if (m.Wf) {
      c.fillStyle = '#222'; c.font = 'bold 11px -apple-system, "Segoe UI", Arial, sans-serif'; c.fillText(m.Wf.name, x + 10, yy + 4); c.font = '11px -apple-system, "Segoe UI", Arial, sans-serif'; yy += 22;
      [0.1, 0.5, 1].forEach(f => {
        const lw = (0.8 + Math.sqrt(f) * 6 * Math.min(1.4, 0.8 + z * 0.15)) * S.lw;
        c.strokeStyle = '#666'; c.lineWidth = lw; c.lineCap = 'round'; c.beginPath(); c.moveTo(x + 12, yy); c.lineTo(x + 44, yy); c.stroke();
        c.fillStyle = '#222'; c.fillText(fmt(Math.round(m.wmax * f)), x + 54, yy); yy += 17;
      });
    }
    c.lineCap = 'butt';
  }
  function tipHtml(r) {
    const row = r.row, out = [];
    for (const n of Object.keys(row)) {
      if (model.hide.has(n) || model.nameFields.has(n)) continue;
      out.push('<span class="k">' + esc(n) + ':</span> ' + esc(row[n].formattedValue));
    }
    return '<b>' + esc(title(r)) + '</b>' + out.join('<br>');
  }

  // ---- flat map ----
  function flatGeom(v, r) {
    const A = r.a, B = r.b, P0 = v.px(A.lon, A.lat), P1 = v.px(A.lon + wrap180(B.lon - A.lon), B.lat);
    const dx = P1[0] - P0[0], dy = P1[1] - P0[1], L = Math.hypot(dx, dy) || 1; let nx = dy / L, ny = -dx / L; if (ny > 0) { nx = -nx; ny = -ny; }
    return { P0, P1, C: [(P0[0] + P1[0]) / 2 + nx * L * S.curve, (P0[1] + P1[1]) / 2 + ny * L * S.curve] };
  }
  function drawFlat(c, v) {
    if (!model) return;
    const T = STYLE[S.style], SW = v.S0 * v.z, list = visible(), geo = [];
    c.lineCap = 'round';
    for (const r of list) {
      const g = flatGeom(v, r), w = baseW(r, v.z); geo.push([r, g, w]);
      c.strokeStyle = routeCol(r); c.lineWidth = w; c.globalAlpha = hover ? (hover === r ? 1 : 0.18) : 0.72;
      for (const off of [-SW, 0, SW]) {
        const x0 = g.P0[0] + off, x1 = g.P1[0] + off, cx = g.C[0] + off;
        if (Math.max(x0, x1, cx) < -20 || Math.min(x0, x1, cx) > v.W + 20) continue;
        c.beginPath(); c.moveTo(x0, g.P0[1]); c.quadraticCurveTo(cx, g.C[1], x1, g.P1[1]); c.stroke();
      }
    }
    if (S.arrows) {
      for (const [r, g, w] of geo) {
        const dx = g.P1[0] - g.C[0], dy = g.P1[1] - g.C[1], L = Math.hypot(dx, dy) || 1; c.fillStyle = routeCol(r); c.globalAlpha = hover ? (hover === r ? 1 : 0.18) : 0.9;
        for (const off of [-SW, 0, SW]) { const x = g.P1[0] + off; if (x < -20 || x > v.W + 20) continue; arrowHead(c, x, g.P1[1], dx / L, dy / L, w); }
      }
    }
    if (S.anim) {
      c.setLineDash([1.5, 14]); c.lineDashOffset = -phase; c.strokeStyle = T.glow; c.globalAlpha = 0.95;
      for (const [r, g, w] of geo) {
        c.lineWidth = Math.max(1.6, w * 0.55);
        for (const off of [-SW, 0, SW]) {
          const x0 = g.P0[0] + off, x1 = g.P1[0] + off, cx = g.C[0] + off; if (Math.max(x0, x1, cx) < -20 || Math.min(x0, x1, cx) > v.W + 20) continue;
          c.beginPath(); c.moveTo(x0, g.P0[1]); c.quadraticCurveTo(cx, g.C[1], x1, g.P1[1]); c.stroke();
        }
      }
      c.setLineDash([]);
    }
    c.globalAlpha = 1;
    drawNodes(c, n => {
      const P = v.px(n.lon, n.lat); // draw the copy nearest the centre of the screen
      let best = P[0], d = Math.abs(P[0] - v.W / 2);
      for (const off of [-SW, SW]) { const dd = Math.abs(P[0] + off - v.W / 2); if (dd < d) { d = dd; best = P[0] + off; } }
      return best < -10 || best > v.W + 10 ? null : [best, P[1]];
    }, v.z);
    drawLegend(c, v.W, v.H, v.z);
  }
  function flatHover(x, y, e, v) {
    if (x == null || !model) { setHover(null); flat.hideTip(); return; }
    const SW = v.S0 * v.z; let best = null, bd = 81;
    for (const r of visible()) {
      const g = flatGeom(v, r);
      for (const off of [-SW, 0, SW]) for (let t = 0; t <= 1.0001; t += 0.04) {
        const u = 1 - t, px = u * u * (g.P0[0] + off) + 2 * u * t * (g.C[0] + off) + t * t * (g.P1[0] + off), py = u * u * g.P0[1] + 2 * u * t * g.C[1] + t * t * g.P1[1], d = (px - x) ** 2 + (py - y) ** 2;
        if (d < bd) { bd = d; best = r; }
      }
    }
    setHover(best); if (!best) { flat.hideTip(); return; } flat.showTip(tipHtml(best), e);
  }

  // ---- globe ----
  function drawGlobe(c, g) {
    if (!model) return;
    const T = STYLE[S.style], list = visible(), lines = [];
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const r of list) {
      const A = r.a, B = r.b, la = A.lat * D2R, lb = B.lat * D2R;
      const a = [Math.cos(la) * Math.cos(A.lon * D2R), Math.cos(la) * Math.sin(A.lon * D2R), Math.sin(la)], b = [Math.cos(lb) * Math.cos(B.lon * D2R), Math.cos(lb) * Math.sin(B.lon * D2R), Math.sin(lb)];
      const d = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))); if (d < 1e-4) continue;
      const n = Math.max(24, Math.ceil(d * 36)), lift = (0.02 + 0.2 * (d / Math.PI)) * (S.curve / 0.22), pts = [];
      for (let i = 0; i <= n; i++) {
        const f = i / n, s0 = Math.sin((1 - f) * d) / Math.sin(d), s1 = Math.sin(f * d) / Math.sin(d);
        const P = g.vv(a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1, 1 + lift * Math.sin(Math.PI * f));
        pts.push(P[2] >= 0 || P[3] > 1 ? P : null);
      }
      const w = baseW(r, 1) * Math.min(1.6, 0.8 + g.k * 0.15) / Math.min(1.4, 0.95) * 0.9;
      c.strokeStyle = routeCol(r); c.fillStyle = routeCol(r); c.lineWidth = w; c.globalAlpha = hover ? (hover === r ? 1 : 0.18) : 0.85;
      c.beginPath(); let pen = false; pts.forEach(P => { if (!P) { pen = false; return; } pen ? c.lineTo(P[0], P[1]) : c.moveTo(P[0], P[1]); pen = true; }); c.stroke();
      if (S.arrows) { const E = pts[n], Q = pts[n - 3]; if (E && Q) { const dx = E[0] - Q[0], dy = E[1] - Q[1], L = Math.hypot(dx, dy); if (L > 0.5) arrowHead(c, E[0], E[1], dx / L, dy / L, w); } }
      lines.push([pts, w]); g.hits.push({ r, pts: pts.filter(Boolean) });
    }
    if (S.anim) {
      c.setLineDash([1.5, 14]); c.lineDashOffset = -phase; c.strokeStyle = T.glow; c.globalAlpha = 0.95;
      for (const [pts, w] of lines) {
        c.lineWidth = Math.max(1.6, w * 0.55); c.beginPath(); let pen = false;
        pts.forEach(P => { if (!P) { pen = false; return; } pen ? c.lineTo(P[0], P[1]) : c.moveTo(P[0], P[1]); pen = true; }); c.stroke();
      }
      c.setLineDash([]);
    }
    c.globalAlpha = 1;
    drawNodes(c, n => { const P = g.ll(n.lon, n.lat); return P[2] <= 0.02 ? null : P; }, g.k * 1.2);
    drawLegend(c, g.W, g.H, 1);
  }
  function globeHover(x, y, e, g) {
    if (x == null || !model) { setHover(null); globe.hideTip(); return; }
    let best = null, bd = 81;
    g.hits.forEach(h => h.pts.forEach(P => { const d = (P[0] - x) ** 2 + (P[1] - y) ** 2; if (d < bd) { bd = d; best = h.r; } }));
    setHover(best); if (!best) { globe.hideTip(); return; } globe.showTip(tipHtml(best), e);
  }

  // ---- views ----
  const flat = new MapView(content, { wrap: true, draw: drawFlat, onHover: flatHover });
  const globe = new GlobeView(content, { draw: drawGlobe, onHover: globeHover });
  const active = () => (S.map === 'globe' ? globe : flat);
  function applyStyle() {
    const T = STYLE[S.style]; flat.theme = { bg: T.bg, land: T.land, stroke: T.stroke }; globe.setTheme(S.style);
    document.body.style.background = T.bg;
  }
  function applyMap() {
    flat.setVisible(S.map !== 'globe'); globe.setVisible(S.map === 'globe'); $('curveL').querySelector('input').title = S.map === 'globe' ? 'Arc height' : 'Curvature'; redraw();
  }
  function setHover(r) { if (hover !== r) { hover = r; redraw(); } }
  function redraw() { active().draw(); }
  function applyHome() { flat.setHome(model.hl); globe.setHome(model.hl, model.hp); }

  // ---- options UI ----
  const bind = (id, ev, fn) => $(id).addEventListener(ev, fn);
  $('map').value = S.map; $('style').value = S.style; $('top').value = S.top; $('lw').value = S.lw; $('curve').value = S.curve; $('arrows').checked = S.arrows; $('anim').checked = S.anim;
  bind('map', 'change', e => { S.map = e.target.value; save('map', S.map); applyMap(); });
  bind('style', 'change', e => { S.style = e.target.value; save('style', S.style); applyStyle(); redraw(); });
  bind('top', 'change', e => { S.top = +e.target.value; save('top', S.top); updateNote(); redraw(); });
  bind('lw', 'input', e => { S.lw = +e.target.value; save('lw', S.lw); redraw(); });
  bind('curve', 'input', e => { S.curve = +e.target.value; save('curve', S.curve); redraw(); });
  bind('arrows', 'change', e => { S.arrows = e.target.checked; save('arrows', S.arrows ? 1 : 0); redraw(); });
  bind('anim', 'change', e => { S.anim = e.target.checked; save('anim', S.anim ? 1 : 0); if (S.anim) tick(); });
  let raf = 0;
  function tick() {
    cancelAnimationFrame(raf); if (!S.anim) { redraw(); return; }
    phase = (performance.now() / 45) % 15.5; redraw(); raf = requestAnimationFrame(tick);
  }

  // ---- data ----
  function updateNote() {
    if (!model) { note.textContent = ''; return; }
    note.textContent = model.routes.length + ' routes' + (S.top && model.routes.length > S.top ? ' (top ' + S.top + ' shown)' : '') + (model.skipped ? ' · ' + model.skipped + ' row(s) skipped: place not found' : '');
  }
  function show(msg) { hint.innerHTML = msg; hint.hidden = !msg; }
  function onData(d) {
    if (d.error) { show('<b>Something went wrong</b><br>' + esc(d.error)); return; }
    model = build(d.rows, d.enc); hover = null;
    if (!model) {
      show('<b>Routes as curved arcs</b><br>Drag a place field to <b>Origin</b> and one to <b>Destination</b> on the Marks card (a name, or a name plus longitude and latitude). Add a measure to <b>Width</b> and any field to <b>Color</b>. Filters work as usual.');
      note.textContent = ''; redraw(); return;
    }
    show(model.routes.length ? '' : '<b>No routes to draw</b><br>No row had both a resolvable origin and destination. Drop longitude and latitude on the tiles, or use place names the extension knows (countries and major cities).');
    updateNote();
    applyHome(); if (!homed && model.nodes.length) { flat.reset(); globe.reset(); homed = true; }
    redraw();
  }

  async function demoLoader() {
    const rows = await TX.fetchCSV('../data/australia_flights.csv');
    const agg = new Map();
    rows.filter(r => Number(r.Year) >= 2017).forEach(r => {
      const k = r['Origin City'] + '|' + r['Destination City'];
      const a = agg.get(k) || { r, n: 0 }; a.n += Number(r.Flights); agg.set(k, a);
    });
    const out = [...agg.values()].map(({ r, n }) => ({
      'Origin City': TX.cell(r['Origin City']), 'Origin Longitude': TX.cell(Number(r['Origin Longitude'])), 'Origin Latitude': TX.cell(Number(r['Origin Latitude'])),
      'Destination City': TX.cell(r['Destination City']), 'Destination Longitude': TX.cell(Number(r['Destination Longitude'])), 'Destination Latitude': TX.cell(Number(r['Destination Latitude'])),
      'Destination Region': TX.cell(r['Destination Region']), 'SUM(Flights)': TX.cell(n, fmt(n))
    }));
    return { rows: out, enc: {
      origin: [{ name: 'Origin City' }, { name: 'Origin Longitude' }, { name: 'Origin Latitude' }],
      destination: [{ name: 'Destination City' }, { name: 'Destination Longitude' }, { name: 'Destination Latitude' }],
      width: [{ name: 'SUM(Flights)' }], color: [{ name: 'Destination Region' }] } };
  }

  applyStyle(); applyMap();
  TX.ready(() => {      // saved options can only be read after the Extensions API has started
    S.map = TX.settings.get('map', S.map); S.style = TX.settings.get('style', S.style); S.top = +TX.settings.get('top', String(S.top));
    S.lw = parseFloat(TX.settings.get('lw', String(S.lw))) || 1; S.curve = parseFloat(TX.settings.get('curve', String(S.curve))); if (!isFinite(S.curve)) S.curve = 0.22;
    S.arrows = TX.settings.get('arrows', S.arrows ? '1' : '0') === '1'; S.anim = TX.settings.get('anim', S.anim ? '1' : '0') === '1';
    $('map').value = S.map; $('style').value = S.style; $('top').value = S.top; $('lw').value = S.lw; $('curve').value = S.curve; $('arrows').checked = S.arrows; $('anim').checked = S.anim;
    applyStyle(); applyMap(); if (S.anim) tick();
  });
  TX.start(onData, demoLoader);
  if (S.anim) tick();
})();
