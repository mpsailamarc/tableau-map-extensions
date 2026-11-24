/* Map studio — one Tableau viz extension for many map types. The worksheet version draws a single layer; the dashboard version (window.MS_DASHBOARD) stacks one layer per sheet.
   Marks card tiles (see map-studio.trex): Location, Destination, Size, Color. Geometry (a spatial field) goes on Detail.
   Everything else is configured per layer in the Layers panel: each layer has a type (shapes / symbols / pies / flow arcs),
   its own fields, colours and sizes. Several data sets can be combined into one sheet with a union and split into layers with a
   "layer column". Any Tableau filter just changes the rows the extension receives. */
(function () {
  'use strict';
  const { MapView, GlobeView, findCountry, ramp, panel, esc, fmt, mxOf, myOf } = Basemap;
  const D2R = Math.PI / 180, wrap180 = d => ((d + 540) % 360) - 180;
  const FONT = '-apple-system, "Segoe UI", Arial, sans-serif';
  const PAL = ['#f2a541', '#59c3c3', '#e4572e', '#6c9bd2', '#8bc34a', '#c678dd', '#ff7ab6', '#b0b0b0', '#e8d44d', '#4e79a7'];
  const MEDAL = { gold: '#f0c13d', silver: '#b6adaa', bronze: '#9a6b57' };
  const RAMPS = {
    blues: ['Blues', [[0, '#dbe9f6'], [0.5, '#5b9bd5'], [1, '#08306b']]],
    heat: ['Blue - yellow - red', [[0, '#4aa3df'], [0.5, '#f5d76e'], [1, '#e4572e']]],
    green: ['Greens', [[0, '#e5f5e0'], [0.5, '#74c476'], [1, '#00441b']]],
    purple: ['Purples', [[0, '#efedf5'], [0.5, '#9e9ac8'], [1, '#3f007d']]],
    div: ['Diverging', [[0, '#52698a'], [0.3, '#a9b6c7'], [0.5, '#e8e4e3'], [0.68, '#f08c80'], [1, '#bf2f38']]]
  };
  const STYLE = {
    dark: { bg: '#1b232c', land: '#3b4651', stroke: '#566370', label: '#fff', glow: 'rgba(255,255,255,.9)', dflt: '#f2a541', fill: '#4aa3df', halo: 'rgba(0,0,0,.55)' },
    light: { bg: '#dbe6ea', land: '#f3f2ee', stroke: '#b4b4ae', label: '#222', glow: 'rgba(255,255,255,.95)', dflt: '#d9822b', fill: '#3c7fb8', halo: 'rgba(255,255,255,.8)' }
  };
  const TYPES = { shapes: 'Shapes (geometry)', symbols: 'Symbols', density: 'Density (heat map)', bars: '3D bars', pies: 'Pie charts', arcs: 'Flow arcs' };
  // density palettes: low density is see-through, high density is solid (like Tableau's Density mark)
  const DRAMPS = {
    fire: ['Yellow - red', [[0, '#fff3b0'], [0.4, '#f7a24b'], [0.75, '#e4572e'], [1, '#8c1c13']]],
    ember: ['Dark red', [[0, '#f6c8b6'], [0.5, '#d9523e'], [1, '#5c0a0a']]],
    ocean: ['Blue - green', [[0, '#d4f1f4'], [0.45, '#4cc3c9'], [1, '#08306b']]],
    plasma: ['Purple - orange', [[0, '#f9e04b'], [0.5, '#e4572e'], [1, '#4b0f6b']]],
    mono: ['White', [[0, '#ffffff'], [1, '#ffffff']]]
  };
  const SHAPES = [['triangle', 'Triangle'], ['circle', 'Circle'], ['square', 'Square'], ['diamond', 'Diamond'], ['star', 'Star']];
  const content = document.getElementById('content'), hint = document.getElementById('hint'), note = document.getElementById('note');
  const $ = id => document.getElementById(id);

  // ================= state =================
  const G = { map: 'flat', style: 'dark', base: true, lf: '', sv: 'fit', fixed: null, rot: false, rs: 6, tm: 'period', tn: 3, tg: 'exact', tsp: 1.5, tloop: true, dismissed: [] };    // global options; lf = the "layer column", sv = start view (fit | world | fixed)
  // Two ways to get data: as a worksheet extension (the one sheet it sits on) or as a dashboard extension (one sheet per layer).
  const DASH = !!window.MS_DASHBOARD;
  let layers = [], auto = true, loaded = false, D = { rows: [], enc: {}, cols: [], preset: null, sheets: {} };
  const T = { steps: [], index: new Map(), idx: -1, playing: false, acc: 0, grain: 'day' };      // the time line shared by all layers
  let lastExtKey = null, models = [], hover = null, phase = 0, homed = false, ext = null, raf = 0, saveT = 0;

  // ================= cell + column helpers =================
  const maxOf = (floor, arr, f) => { let mx = floor; for (let i = 0; i < arr.length; i++) { const v = f(arr[i]); if (v > mx) mx = v; } return mx; };      // Math.max(...) overflows the stack on big row counts
  const raw = c => (c == null ? null : (c.nativeValue !== undefined ? c.nativeValue : c.value));
  const isNull = c => { const v = raw(c); return v == null || v === ''; };
  const num = c => { const v = raw(c); if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
  const str = c => (c == null ? '' : String(c.formattedValue != null ? c.formattedValue : raw(c)));
  const ctxOf = L => (DASH ? (D.sheets[L && L.sheet] || { rows: [], cols: [], enc: {} }) : D);      // the rows / columns a layer reads
  const colInfo = (n, cols) => (cols || D.cols).find(c => c.name === n);
  const spatialCols = cx => (cx || D).cols.filter(c => c.dataType === 'spatial').map(c => c.name);
  const isNumCol = c => c.dataType === 'int' || c.dataType === 'float';
  const isMeasure = n => /^(SUM|AVG|MIN|MAX|MEDIAN|CNT|CNTD|AGG|COUNT|COUNTD|STDEV|VAR)\(/i.test(n || '');
  const bare = n => String(n).replace(/^(SUM|AVG|MIN|MAX|ATTR|MEDIAN|CNT|CNTD|AGG|COUNT|COUNTD|COLLECT)\((.*)\)$/i, '$2');
  const isLon = n => { n = bare(n).toLowerCase(); return n.includes('longitude') || /(^|[^a-z])(lon|lng|long)([^a-z]|$)/.test(n) || /(lon|lng)$/.test(n); };
  const isLat = n => { n = bare(n).toLowerCase(); return n.includes('latitude') || /(^|[^a-z])lat([^a-z]|$)/.test(n) || /lat$/.test(n); };
  function classify(names) {            // a tile holding up to 3 fields -> {name, lon, lat}
    const p = { name: null, lon: null, lat: null }, rest = [];
    for (const f of names) { if (!p.lon && isLon(f)) p.lon = f; else if (!p.lat && isLat(f)) p.lat = f; else rest.push(f); }
    if (!p.lon && !p.lat) {
      if (rest.length >= 3) { p.name = rest[0]; p.lon = rest[1]; p.lat = rest[2]; }
      else if (rest.length === 2 && names.length === 2) { p.lon = rest[0]; p.lat = rest[1]; }
      else p.name = rest[0] || null;
    } else p.name = rest[0] || null;
    p.rest = rest; return p;
  }

  // ================= time =================
  const dateCols = cx => cx.cols.filter(c => c.dataType === 'date' || c.dataType === 'date-time').map(c => c.name);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function tsOf(cell) {            // a date / datetime / 4-digit year -> UTC milliseconds (dates become midnight UTC of the same calendar day)
    const v = raw(cell); if (v == null || v === '') return null;
    let d;
    if (v instanceof Date) d = v;
    else if (typeof v === 'number') return Number.isInteger(v) && v >= 1000 && v <= 3000 ? Date.UTC(v, 0, 1) : null;
    else if (typeof v === 'string') { if (/^\d{4}$/.test(v.trim())) return Date.UTC(+v, 0, 1); const p = Date.parse(v); if (!isFinite(p)) return null; d = new Date(p); }
    else return null;
    if (isNaN(d.getTime())) return null;
    if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return d.getTime();
  }
  function bucket(ts) {
    if (ts == null || G.tg === 'exact') return ts;
    const d = new Date(ts), y = d.getUTCFullYear(), mo = d.getUTCMonth();
    return G.tg === 'year' ? Date.UTC(y, 0, 1) : G.tg === 'month' ? Date.UTC(y, mo, 1) : Date.UTC(y, mo, d.getUTCDate());
  }
  function fmtStep(ts) {
    const d = new Date(ts), y = d.getUTCFullYear();
    if (T.grain === 'year') return String(y);
    if (T.grain === 'month') return MON[d.getUTCMonth()] + ' ' + y;
    if (T.grain === 'day') return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + y;
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }
  function buildTimeline() {
    const set = new Set();
    for (const m of models) if (m.L.on && m.f.time) for (const it of m.base) { it.t = bucket(it.t0); if (it.t != null) set.add(it.t); }
    T.steps = [...set].sort((a, b) => a - b); T.index = new Map(T.steps.map((t, i) => [t, i]));
    const all = f => T.steps.every(t => f(new Date(t)));
    T.grain = all(d => d.getUTCMonth() === 0 && d.getUTCDate() === 1 && d.getUTCHours() === 0) ? 'year' : all(d => d.getUTCDate() === 1 && d.getUTCHours() === 0) ? 'month' : all(d => d.getUTCHours() === 0 && d.getUTCMinutes() === 0) ? 'day' : 'time';
    if (T.idx >= T.steps.length) T.idx = T.steps.length - 1;
    if (T.steps.length < 2) { T.idx = -1; T.playing = false; }
  }
  function timeVisible(it) {
    if (it.t == null) return true;
    const i = T.index.get(it.t), cur = T.idx;
    return G.tm === 'cum' ? i <= cur : G.tm === 'trail' ? (i <= cur && i > cur - G.tn) : i === cur;
  }
  function applyTime() {
    const on = T.steps.length > 1 && T.idx >= 0;
    for (const m of models) m.items = on && m.f.time ? m.base.filter(timeVisible) : m.base;
    updateNote();
  }
  let refreshInfo = '';
  const hms = () => new Date().toTimeString().slice(0, 8);
  TX.onRefresh = (ph, i) => { refreshInfo = ph === 'start' ? ' · updating from Tableau… (' + hms() + ')' : ph === 'read' ? ' · read ' + fmt(i.rows) + ' rows in ' + i.s.toFixed(1) + ' s, drawing…' : refreshInfo.replace(/, drawing…$/, '') + ', done at ' + hms() + ' (' + i.s.toFixed(1) + ' s in all)'; updateNote(); };
  function updateNote() {
    note.textContent = models.map(m => m.L.on ? m.L.name + ' ' + fmt(m.items.length) + (m.items.length !== m.base.length ? ' of ' + fmt(m.base.length) : '') + (m.skipped ? ' (' + m.skipped + ' skipped)' : '') : '').filter(Boolean).join(' · ') + refreshInfo;
  }

  // ================= layers =================
  let uid = 0;
  function newLayer(type, name, id) {
    return { id: id || 'L' + Date.now().toString(36) + (uid++), name: name || TYPES[type], type, on: true, lv: '', f: {},
      st: { color: '', ramp: type === 'arcs' ? 'heat' : 'blues', alpha: 0.8, outline: true, shape: 'circle', size: 1, lw: 1, curve: 0.22, arrows: false, anim: false, top: 0, labels: false, ocolor: '', dramp: 'fire', radius: 1, intensity: 1, bw: 1, bh: 1 } };
  }
  // Dashboard mode has no Marks card tiles, so defaults are guessed from the names and types of a sheet's columns.
  function guess(cx) {
    const C = cx.cols, names = C.map(c => c.name), nonSp = C.filter(c => c.dataType !== 'spatial');
    const lonC = names.filter(isLon), latC = names.filter(isLat);
    const oRe = /orig|from|source|depart/i, dRe = /dest|(^|[^a-z])to([^a-z]|$)|target|arriv/i;
    const oCols = nonSp.map(c => c.name).filter(n => oRe.test(n)), dCols = nonSp.map(c => c.name).filter(n => dRe.test(n) && !oCols.includes(n));
    const og = classify(oCols), dg = classify(dCols);
    const used = new Set([...oCols, ...dCols]);
    const meas = C.filter(c => isNumCol(c) && !isLon(c.name) && !isLat(c.name)).map(c => c.name);
    const plain = C.filter(c => c.dataType === 'string' && !used.has(c.name)).map(c => c.name);
    return { date: dateCols(cx), spatial: spatialCols(cx), lon: lonC.filter(n => !used.has(n))[0] || lonC[0] || null, lat: latC.filter(n => !used.has(n))[0] || latC[0] || null, og, dg, meas, plain,
      hasArcs: !!((og.name || og.lon) && (dg.name || dg.lon)) };
  }
  function autoLayers() {
    if (D.preset) return JSON.parse(JSON.stringify(D.preset));
    if (DASH) {
      const out = [];
      for (const [name, cx] of Object.entries(D.sheets)) {
        const g = guess(cx); let type = null;
        if (g.spatial.length) type = 'shapes'; else if (g.hasArcs) type = 'arcs'; else if (g.lon && g.lat) type = 'symbols';
        if (type) { const L = newLayer(type, name, 'auto-' + name); L.sheet = name; out.push(L); }
      }
      return out;
    }
    const e = D.enc, out = [];
    const loc = classify((e.location || []).map(x => x.name));
    if (spatialCols().length) out.push(newLayer('shapes', 'Shapes', 'auto-shapes'));
    if (e.location && e.destination) out.push(newLayer('arcs', 'Flows', 'auto-arcs'));
    else if (e.location && loc.lon && loc.lat) out.push(newLayer('symbols', 'Symbols', 'auto-symbols'));
    else if (e.location && loc.name && !out.length) out.push(newLayer('pies', 'Pies', 'auto-pies'));
    if (!out.length) {          // nothing on the Marks card tiles: guess from the fields on Detail
      const g = guess(D);
      if (g.spatial.length) out.push(newLayer('shapes', 'Shapes', 'auto-shapes'));
      else if (g.hasArcs) out.push(newLayer('arcs', 'Flows', 'auto-arcs'));
      else if (g.lon && g.lat) out.push(newLayer('symbols', 'Symbols', 'auto-symbols'));
    }
    return out;
  }
  function fieldsOf(L) {                // resolve every field a layer uses: explicit choice, else the Marks card tile (or a guess in dashboard mode)
    const f = L.f, cx = ctxOf(L), e = cx.enc || {}, nm = a => (a && a[0] ? a[0].name : null);
    const pick = (k, d) => (f[k] === '-' ? null : (f[k] || d || null));
    const g = guess(cx);
    const mk = (d) => { const o = {}; for (const k of Object.keys(d)) o[k] = d[k]; return o; };
    const guessed = (() => {
      switch (L.type) {
        case 'shapes': return { geom: pick('geom', g.spatial[0]), name: pick('name', g.plain[0]), color: pick('color', g.meas[0] || g.plain[1]), size: pick('size', null), time: pick('time', g.date[0]) };
        case 'symbols': return { lon: pick('lon', g.lon), lat: pick('lat', g.lat), name: pick('name', g.plain[0]), size: pick('size', g.meas[0]), color: pick('color', g.plain[1]), time: pick('time', g.date[0]) };
        case 'density': return { lon: pick('lon', g.lon), lat: pick('lat', g.lat), weight: pick('weight', null), time: pick('time', g.date[0]) };
        case 'bars': return { lon: pick('lon', g.lon), lat: pick('lat', g.lat), name: pick('name', g.plain[0]), height: pick('height', g.meas[0]), color: pick('color', g.meas[1] || null), time: pick('time', g.date[0]) };
        case 'pies': return { name: pick('name', g.plain[0]), lon: pick('lon', null), lat: pick('lat', null), slice: pick('slice', g.plain[1]), value: pick('value', g.meas[0]) };
        default: return { oname: pick('oname', g.og.name), olon: pick('olon', g.og.lon), olat: pick('olat', g.og.lat), dname: pick('dname', g.dg.name), dlon: pick('dlon', g.dg.lon), dlat: pick('dlat', g.dg.lat), width: pick('width', g.meas[0]), color: pick('color', g.dg.rest && g.dg.rest[1] || g.plain[0]), time: pick('time', g.date[0]) };
      }
    })();
    if (DASH) return guessed;
    const out = fieldsOfMarks(L, cx, e, nm, pick);
    for (const k of Object.keys(out)) if (out[k] == null && f[k] !== '-') out[k] = guessed[k] || null;
    return out;
  }
  function fieldsOfMarks(L, cx, e, nm, pick) {
    const loc = classify((e.location || []).map(x => x.name)), dst = classify((e.destination || []).map(x => x.name));
    const col = nm(e.color), siz = nm(e.size);
    switch (L.type) {
      case 'shapes': return { geom: pick('geom', spatialCols(cx)[0]), name: pick('name', loc.name), color: pick('color', col), size: pick('size', siz), time: pick('time', dateCols(cx)[0]) };
      case 'symbols': return { lon: pick('lon', loc.lon), lat: pick('lat', loc.lat), name: pick('name', loc.name), size: pick('size', siz), color: pick('color', col), time: pick('time', dateCols(cx)[0]) };
      case 'density': return { lon: pick('lon', loc.lon), lat: pick('lat', loc.lat), weight: pick('weight', siz), time: pick('time', dateCols(cx)[0]) };
      case 'bars': return { lon: pick('lon', loc.lon), lat: pick('lat', loc.lat), name: pick('name', loc.name), height: pick('height', siz), color: pick('color', col), time: pick('time', dateCols(cx)[0]) };
      case 'pies': return { name: pick('name', loc.name), lon: pick('lon', loc.lon), lat: pick('lat', loc.lat), slice: pick('slice', col), value: pick('value', siz) };
      default: return { oname: pick('oname', loc.name), olon: pick('olon', loc.lon), olat: pick('olat', loc.lat), dname: pick('dname', dst.name), dlon: pick('dlon', dst.lon), dlat: pick('dlat', dst.lat), width: pick('width', siz), color: pick('color', col), time: pick('time', dateCols(cx)[0]) };
    }
  }
  const rowsFor = L => { const cx = ctxOf(L); return !DASH && G.lf && L.lv ? cx.rows.filter(r => str(r[G.lf]) === L.lv) : cx.rows; };

  // ================= colour =================
  function colorize(items, cellOf, field, st) {
    if (!field) { items.forEach(i => { i.col = null; }); return null; }
    if (!isMeasure(field)) {
      const tot = new Map();
      items.forEach(i => { const k = str(cellOf(i)); i.k = k; tot.set(k, (tot.get(k) || 0) + 1); });
      const names = [...tot.keys()].sort((a, b) => tot.get(b) - tot.get(a)), cat = new Map();
      names.forEach((n, i) => cat.set(n, PAL[i % PAL.length]));
      items.forEach(i => { i.col = cat.get(i.k); });
      return { title: field, cat };
    }
    const vs = items.map(i => num(cellOf(i))); let mn = Infinity, mx = -Infinity;
    vs.forEach(v => { if (v != null) { mn = Math.min(mn, v); mx = Math.max(mx, v); } });
    const R = (RAMPS[st.ramp] || RAMPS.blues)[1];
    items.forEach((i, k) => { const v = vs[k]; i.col = v == null ? '#999' : ramp(R, mx > mn ? (v - mn) / (mx - mn) : 0.5); });
    return { title: field, min: mn, max: mx, ramp: R };
  }
  const colOf = (m, it) => it.col || m.L.st.color || STYLE[G.style].fill;
  const stackExt = (m, lon, lat) => { const e = m.ext || (m.ext = { a: 180, b: -180, c: 90, d: -90 }); e.a = Math.min(e.a, lon); e.b = Math.max(e.b, lon); e.c = Math.min(e.c, lat); e.d = Math.max(e.d, lat); };

  // ================= build one layer =================
  function build(L) {
    const m = { L, f: fieldsOf(L), cols: ctxOf(L).cols, items: [], skipped: 0, leg: [], ext: null, msg: '' };
    if (DASH && !D.sheets[L.sheet]) { m.msg = 'choose which sheet feeds this layer'; m.base = m.items; return m; }
    try {
      ({ shapes: buildShapes, symbols: buildSymbols, density: buildDensity, bars: buildBars, pies: buildPies, arcs: buildArcs })[L.type](m, rowsFor(L));
    } catch (err) { m.msg = String(err && err.message || err); m.items = []; }
    m.base = m.items;          // all items; m.items becomes the part shown at the current time step
    return m;
  }
  function buildShapes(m, rows) {
    const f = m.f; if (!f.geom) { m.msg = 'no geometry field (put a spatial field on Detail)'; return; }
    for (const r of rows) {
      const v = raw(r[f.geom]); if (v == null) continue;
      const g = WKT.parse(v); if (!g) { m.skipped++; continue; }
      m.items.push({ row: r, g, name: f.name ? str(r[f.name]) : '', s: f.size ? num(r[f.size]) : null, t0: f.time ? tsOf(r[f.time]) : null });
      stackExt(m, g.bbox[0], g.bbox[1]); stackExt(m, g.bbox[2], g.bbox[3]);
    }
    const lg = colorize(m.items, i => i.row[f.color], f.color, m.L.st); if (lg) m.leg.push(lg);
  }
  function buildSymbols(m, rows) {
    const f = m.f; if (!f.lon || !f.lat) { m.msg = 'choose a longitude and a latitude field'; return; }
    for (const r of rows) {
      const lon = num(r[f.lon]), lat = num(r[f.lat]); if (lon == null || lat == null) continue;
      m.items.push({ row: r, lon, lat, name: f.name ? str(r[f.name]) : '', s: f.size ? num(r[f.size]) : null, t0: f.time ? tsOf(r[f.time]) : null }); stackExt(m, lon, lat);
    }
    m.smax = maxOf(1e-9, m.items, i => i.s || 0);
    const lg = colorize(m.items, i => i.row[f.color], f.color, m.L.st); if (lg) m.leg.push(lg);
    if (f.size) m.leg.push({ title: f.size, size: m.smax });
    m.items.sort((a, b) => (b.s || 0) - (a.s || 0));         // big first, small on top
  }
  function buildBars(m, rows) {
    const f = m.f; if (!(f.lon && f.lat) && !f.name) { m.msg = 'choose a location: longitude and latitude, or a place name'; return; }
    const lookup = nm => { const c = findCountry(nm) || (window.PLACES && window.PLACES.find(p => p[0].toLowerCase() === nm.toLowerCase())); return c ? (c.c ? { lon: c.c[0], lat: c.c[1] } : { lon: c[1], lat: c[2] }) : null; };
    for (const r of rows) {
      let lon = f.lon ? num(r[f.lon]) : null, lat = f.lat ? num(r[f.lat]) : null; const name = f.name ? str(r[f.name]) : '';
      if (lon == null || lat == null) { if (!name) continue; const g = lookup(name); if (!g) { m.skipped++; continue; } lon = g.lon; lat = g.lat; }
      m.items.push({ row: r, lon, lat, name, s: f.height ? num(r[f.height]) : null, t0: f.time ? tsOf(r[f.time]) : null }); stackExt(m, lon, lat);
    }
    m.smax = maxOf(1e-9, m.items, i => i.s || 0);
    const lg = colorize(m.items, i => i.row[f.color], f.color, m.L.st); if (lg) m.leg.push(lg);
    if (f.height) m.leg.push({ title: f.height, size: m.smax, bar: true });
  }
  function buildDensity(m, rows) {
    const f = m.f; if (!f.lon || !f.lat) { m.msg = 'choose a longitude and a latitude field'; return; }
    for (const r of rows) {
      const lon = num(r[f.lon]), lat = num(r[f.lat]); if (lon == null || lat == null) continue;
      const w = f.weight ? num(r[f.weight]) : 1; if (w == null || w <= 0) continue;
      m.items.push({ row: r, lon, lat, w, t0: f.time ? tsOf(r[f.time]) : null }); stackExt(m, lon, lat);
    }
    m.wmax = maxOf(1e-9, m.items, i => i.w);
    m.leg.push({ title: 'Density' + (f.weight ? ': ' + f.weight : ''), ramp: (DRAMPS[m.L.st.dramp] || DRAMPS.fire)[1], words: ['Low', 'High'] });
  }
  function buildPies(m, rows) {
    const f = m.f; if (!f.name && !(f.lon && f.lat)) { m.msg = 'choose a location (country name) field'; return; }
    const pies = new Map(), tot = new Map();
    for (const r of rows) {
      let lon = f.lon ? num(r[f.lon]) : null, lat = f.lat ? num(r[f.lat]) : null, label = f.name ? str(r[f.name]) : '';
      if (lon == null || lat == null) {
        if (!f.name || isNull(r[f.name])) continue;
        const c = findCountry(label); if (!c) { m.skipped++; continue; } lon = c.c[0]; lat = c.c[1]; label = c.n;
      }
      const v = f.value ? num(r[f.value]) : 1; if (v == null || v <= 0) continue;
      const sn = f.slice ? str(r[f.slice]) : 'Total', key = lon.toFixed(3) + ',' + lat.toFixed(3);
      let p = pies.get(key); if (!p) { p = { lon, lat, name: label, s: new Map(), n: 0, rows: [r], row: r }; pies.set(key, p); stackExt(m, lon, lat); }
      p.s.set(sn, (p.s.get(sn) || 0) + v); p.n += v; tot.set(sn, (tot.get(sn) || 0) + v);
    }
    const order = ['gold', 'silver', 'bronze'];
    const names = [...tot.keys()].sort((a, b) => { const ia = order.indexOf(a.toLowerCase()), ib = order.indexOf(b.toLowerCase()); return ia >= 0 && ib >= 0 ? ia - ib : tot.get(b) - tot.get(a); });
    let ci = 0; m.pcol = new Map(); names.forEach(n => m.pcol.set(n, MEDAL[n.toLowerCase()] || PAL[ci++ % PAL.length]));
    m.pnames = names; m.items = [...pies.values()].sort((a, b) => b.n - a.n); m.pmax = maxOf(1, m.items, p => p.n);
    m.leg.push({ title: f.slice || 'Total', cat: m.pcol, max: 8 });
    if (f.value) m.leg.push({ title: f.value, size: m.pmax });
  }
  function buildArcs(m, rows) {
    const f = m.f, nodes = new Map();
    if (!(f.oname || f.olon) || !(f.dname || f.dlon)) { m.msg = 'choose origin and destination fields'; return; }
    const lookup = nm => { if (!nm) return null; const c = findCountry(nm) || (window.PLACES && (window.PLACES.find(p => p[0].toLowerCase() === nm.toLowerCase()) || null)); return c ? (c.c ? { lon: c.c[0], lat: c.c[1] } : { lon: c[1], lat: c[2] }) : null; };
    const place = (name, lonF, latF, r, role) => {
      const present = (name && !isNull(r[name])) || (lonF && !isNull(r[lonF])); if (!present) return undefined;
      let lon = lonF ? num(r[lonF]) : null, lat = latF ? num(r[latF]) : null; const label = name ? str(r[name]) : '';
      if (lon == null || lat == null || Math.abs(lat) > 90 || Math.abs(lon) > 360) { const g = lookup(label); if (!g) return null; lon = g.lon; lat = g.lat; }
      const key = lon.toFixed(3) + ',' + lat.toFixed(3); let n = nodes.get(key);
      if (!n) { n = { lon, lat, label, o: false, d: false }; nodes.set(key, n); stackExt(m, lon, lat); }
      if (!n.label && label) n.label = label; n[role] = true; return n;
    };
    for (const r of rows) {
      const a = place(f.oname, f.olon, f.olat, r, 'o'), b = place(f.dname, f.dlon, f.dlat, r, 'd');
      if (a === undefined || b === undefined) continue;
      if (!a || !b) { m.skipped++; continue; }
      if (a === b) continue;
      let w = f.width ? num(r[f.width]) : null; if (w != null && w < 0) w = 0;
      m.items.push({ a, b, w, row: r, t0: f.time ? tsOf(r[f.time]) : null });
    }
    m.items.sort((x, y) => (y.w || 0) - (x.w || 0));
    m.wmax = maxOf(1e-9, m.items, r => r.w || 0); m.nodes = [...nodes.values()];
    const lg = colorize(m.items, i => i.row[f.color], f.color, m.L.st); if (lg) m.leg.push(lg);
    if (f.width) m.leg.push({ title: f.width, size: m.wmax, line: true });
  }

  // ================= small drawing helpers =================
  function symPath(c, kind, x, y, s) {
    c.beginPath();
    if (kind === 'circle') c.arc(x, y, s * 0.8, 0, 6.3);
    else if (kind === 'square') c.rect(x - s * 0.75, y - s * 0.75, s * 1.5, s * 1.5);
    else if (kind === 'diamond') { c.moveTo(x, y - s); c.lineTo(x + s * 0.8, y); c.lineTo(x, y + s); c.lineTo(x - s * 0.8, y); c.closePath(); }
    else if (kind === 'star') { for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.45 : s * 1.1, a = -Math.PI / 2 + i * Math.PI / 5; c[i ? 'lineTo' : 'moveTo'](x + r * Math.cos(a), y + r * Math.sin(a)); } c.closePath(); }
    else { c.moveTo(x, y - s); c.lineTo(x + s * 0.85, y + s * 0.7); c.lineTo(x - s * 0.85, y + s * 0.7); c.closePath(); }
  }
  const endsOf = st => st.ends || (st.arrows ? 'arrows' : 'dots');      // how a route's two ends look: dots | arrows | none
  function arrowHead(c, x, y, ux, uy, w) {
    const hl = 4 + w * 1.5, hw = hl * 0.45;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x - ux * hl - uy * hw, y - uy * hl + ux * hw); c.lineTo(x - ux * hl + uy * hw, y - uy * hl - ux * hw); c.closePath(); c.fill();
  }
  function label(c, text, x, y, bold) {
    const T = STYLE[G.style]; c.font = (bold ? 'bold ' : '') + '11px ' + FONT; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.lineWidth = 3; c.strokeStyle = T.halo; c.strokeText(text, x, y); c.fillStyle = T.label; c.fillText(text, x, y);
  }
  const dim = (m, it) => (hover && hover.m === m ? (hover.it === it ? 1 : 0.2) : 1);

  // views -> a small "env" so point layers draw the same way on the flat map and the globe
  const flatEnv = v => { const SW = v.S0 * v.z; return { v, flat: true, z: v.z, W: v.W, H: v.H, SW,
    pt(lon, lat) { const P = v.px(lon, lat); let best = P[0], d = Math.abs(P[0] - v.W / 2); for (const off of [-SW, SW]) { const dd = Math.abs(P[0] + off - v.W / 2); if (dd < d) { d = dd; best = P[0] + off; } } return best < -40 || best > v.W + 40 || P[1] < -40 || P[1] > v.H + 40 ? null : [best, P[1]]; } }; };
  const globeEnv = g => ({ g, flat: false, z: g.k * 1.2, W: g.W, H: g.H, pt(lon, lat) { const P = g.ll(lon, lat); return P[2] <= 0.02 ? null : P; } });

  // ================= layer: symbols =================
  const symSize = (m, it, env) => { const rel = (m.f.size && it.s != null) ? Math.max(0, it.s) / m.smax : 0.25; return (3.5 + Math.sqrt(rel) * 7.5) * Math.min(1.7, 0.8 + env.z * 0.2) * m.L.st.size; };
  function drawSymbols(c, env, m) {
    const st = m.L.st, T = STYLE[G.style];
    for (const it of m.items) {
      const P = env.pt(it.lon, it.lat); if (!P) { it._s = 0; continue; }
      const s = it._s = symSize(m, it, env); it._x = P[0]; it._y = P[1];
      symPath(c, st.shape, P[0], P[1], s); c.globalAlpha = st.alpha * dim(m, it); c.fillStyle = colOf(m, it) || T.dflt; c.fill(); c.globalAlpha = 1;
      const hollow = colOf(m, it) === 'transparent';
      c.strokeStyle = st.ocolor || (hollow ? (G.style === 'dark' ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.75)') : 'rgba(0,0,0,.45)'); c.lineWidth = hover && hover.it === it ? 2 : hollow ? 1.3 : 0.6; c.stroke();
      if (st.labels && it.name) label(c, it.name, P[0] + s + 3, P[1] + 4);
    }
  }
  function hitSymbols(x, y, m) {
    let best = null, bd = 1e9;
    for (const it of m.items) { if (!it._s) continue; const d = (it._x - x) ** 2 + (it._y - y) ** 2, lim = Math.max(64, it._s * it._s); if (d < bd && d < lim) { bd = d; best = it; } }
    return best;
  }

  // ================= layer: 3D bars =================
  // Each bar is a shaded column standing on its location. On the globe it rises along the line away from the centre of the earth, so it
  // leans with the view and shows as a ring when seen end on; on the flat map it rises up the screen.
  function shade(col, k) {          // a #rrggbb / rgb() colour, lighter (k>1) or darker (k<1)
    let r, g, b; const h = /^#([0-9a-f]{6})$/i.exec(col);
    if (h) { r = parseInt(h[1].slice(0, 2), 16); g = parseInt(h[1].slice(2, 4), 16); b = parseInt(h[1].slice(4, 6), 16); }
    else { const n = String(col).match(/[\d.]+/g); if (!n || n.length < 3) return col; [r, g, b] = n.map(Number); }
    const f = v => Math.max(0, Math.min(255, Math.round(k > 1 ? v + (255 - v) * (k - 1) : v * k)));
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }
  function drawBars(c, env, m) {
    const st = m.L.st, T = STYLE[G.style], zf = Math.min(1.8, 0.7 + env.z * 0.15), maxH = 120 * (st.bh || 1) * zf, w = (9 + 5 * Math.min(2.5, env.z * 0.5)) * (st.bw || 1);
    const pts = [];
    for (const it of m.items) {
      it._w = 0; const B = env.pt(it.lon, it.lat); if (!B) continue;
      const hpx = Math.max(2, (m.f.height && it.s != null ? Math.max(0, it.s) / m.smax : 0.3) * maxH);
      let Tp;
      if (env.flat) Tp = [B[0], B[1] - hpx, 1]; else Tp = env.g.ll(it.lon, it.lat, 1 + hpx / env.g.R);
      pts.push({ it, B, Tp });
    }
    pts.sort(env.flat ? (a, b) => a.B[1] - b.B[1] : (a, b) => a.B[2] - b.B[2]);          // far ones first, near ones cover them
    c.lineJoin = 'round';
    for (const { it, B, Tp } of pts) {
      const col = colOf(m, it) === 'transparent' ? T.fill : (colOf(m, it) || T.dflt), dx = Tp[0] - B[0], dy = Tp[1] - B[1], len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
      const nx = len > 0.5 ? -dy / len : 1, ny = len > 0.5 ? dx / len : 0, hw = w / 2, rot = len > 0.5 ? Math.atan2(ny, nx) : 0, ry = len > 0.5 ? hw * 0.5 : hw;
      const hot = hover && hover.it === it; it._x = B[0]; it._y = B[1]; it._tx = Tp[0]; it._ty = Tp[1]; it._w = w;
      c.globalAlpha = st.alpha * dim(m, it);
      if (len > 0.5) {
        const gr = c.createLinearGradient(B[0] - nx * hw, B[1] - ny * hw, B[0] + nx * hw, B[1] + ny * hw);
        gr.addColorStop(0, shade(col, 0.62)); gr.addColorStop(0.35, shade(col, 1.12)); gr.addColorStop(1, shade(col, 0.55));
        c.beginPath(); c.moveTo(B[0] - nx * hw, B[1] - ny * hw); c.lineTo(Tp[0] - nx * hw, Tp[1] - ny * hw); c.lineTo(Tp[0] + nx * hw, Tp[1] + ny * hw); c.lineTo(B[0] + nx * hw, B[1] + ny * hw);
        c.ellipse(B[0], B[1], hw, ry, rot, 0, Math.PI, false); c.closePath();      // rounded foot
        c.fillStyle = gr; c.fill();
      }
      c.beginPath(); c.ellipse(Tp[0], Tp[1], hw, ry, rot, 0, 6.3); c.fillStyle = shade(col, 1.3); c.fill();      // lit top
      c.strokeStyle = st.ocolor || (hot ? '#fff' : 'rgba(0,0,0,.4)'); c.lineWidth = hot ? 2 : 0.7; c.stroke();
      c.globalAlpha = 1;
      if (st.labels) { const tx = it.name || (it.s != null ? fmt(it.s) : ''); if (tx) label(c, tx, Tp[0] + hw + 3, Tp[1] + 4); }      // labels are simply on or off, at any zoom
    }
  }
  function hitBars(x, y, m) {
    let best = null, bd = 1e9;
    for (const it of m.items) {
      if (!it._w) continue; const ax = it._x, ay = it._y, bx = it._tx - ax, by = it._ty - ay, l2 = bx * bx + by * by || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / l2)), d = Math.hypot(x - (ax + bx * t), y - (ay + by * t));
      if (d <= it._w / 2 + 3 && d < bd) { bd = d; best = it; }
    }
    return best;
  }

  // ================= layer: density (heat map) =================
  // Each point stamps a soft blob into a half-size offscreen canvas; where blobs overlap the alpha adds up, and that alpha is then mapped to the palette.
  const dSprites = new Map(), dLuts = new Map();
  function dSprite(r) {
    const k = Math.max(2, Math.round(r)); let s = dSprites.get(k); if (s) return s;
    s = document.createElement('canvas'); s.width = s.height = k * 2; const g = s.getContext('2d'), gr = g.createRadialGradient(k, k, 0, k, k, k);
    gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.35, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, k * 2, k * 2);
    if (dSprites.size > 40) dSprites.clear(); dSprites.set(k, s); return s;
  }
  function dLut(st) {
    const key = (st.dramp || 'fire') + '|' + st.alpha; let l = dLuts.get(key); if (l) return l;
    const R = (DRAMPS[st.dramp] || DRAMPS.fire)[1]; l = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) { const t = i / 255, rgb = ramp(R, t).match(/\d+/g) || [255, 255, 255]; l[i * 4] = +rgb[0]; l[i * 4 + 1] = +rgb[1]; l[i * 4 + 2] = +rgb[2]; l[i * 4 + 3] = Math.min(1, t * 1.8) * 255 * st.alpha; }
    dLuts.set(key, l); return l;
  }
  function drawDensity(c, env, m) {
    const st = m.L.st, S = 0.5, w = Math.max(1, Math.ceil(env.W * S)), h = Math.max(1, Math.ceil(env.H * S));
    const cv = m.dcv || (m.dcv = document.createElement('canvas')); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const g = cv.getContext('2d', { willReadFrequently: true }); g.clearRect(0, 0, w, h);
    const r = 16 * (st.radius || 1) * Math.min(2.2, 0.75 + env.z * 0.22) * S, sp = dSprite(r), half = sp.width / 2, I = 0.14 * (st.intensity || 1), weighted = !!m.f.weight;
    for (const it of m.items) {
      const P = env.pt(it.lon, it.lat); if (!P) continue;
      g.globalAlpha = Math.min(1, I * (weighted ? 0.35 + 0.65 * Math.sqrt(it.w / m.wmax) : 1)); g.drawImage(sp, P[0] * S - half, P[1] * S - half);
    }
    g.globalAlpha = 1;
    const img = g.getImageData(0, 0, w, h), d = img.data, lut = dLut(st);
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] * 4; d[i] = lut[a]; d[i + 1] = lut[a + 1]; d[i + 2] = lut[a + 2]; d[i + 3] = lut[a + 3]; }
    g.putImageData(img, 0, 0);
    c.imageSmoothingEnabled = true; c.drawImage(cv, 0, 0, env.W, env.H);
  }

  // ================= layer: pies =================
  const pieR = (m, n, env) => (3.5 + Math.sqrt(n / m.pmax) * (22 + Math.min(14, env.z * 4))) * Math.min(1.3, 0.85 + env.z * 0.1) * m.L.st.size * 0.8;
  function drawPies(c, env, m) {
    for (const p of m.items) {
      const P = env.pt(p.lon, p.lat); if (!P) { p._r = 0; continue; }
      const r = p._r = pieR(m, p.n, env); p._x = P[0]; p._y = P[1]; let a0 = -Math.PI / 2;
      c.globalAlpha = m.L.st.alpha * dim(m, p) + (1 - m.L.st.alpha) * 0.2;
      for (const n of m.pnames) { const val = p.s.get(n); if (!val) continue; const a1 = a0 + val / p.n * Math.PI * 2; c.beginPath(); c.moveTo(P[0], P[1]); c.arc(P[0], P[1], r, a0, a1); c.closePath(); c.fillStyle = m.pcol.get(n); c.fill(); a0 = a1; }
      c.globalAlpha = 1; c.beginPath(); c.arc(P[0], P[1], r, 0, 6.3); c.strokeStyle = 'rgba(0,0,0,.75)'; c.lineWidth = hover && hover.it === p ? 2 : 1; c.stroke();
    }
  }
  function hitPies(x, y, m) {
    let best = null, bd = 1e9;
    for (const p of m.items) { if (!p._r) continue; const d = Math.hypot(p._x - x, p._y - y); if (d <= p._r && d < bd) { bd = d; best = p; } }
    return best;
  }

  // ================= layer: arcs =================
  const baseW = (m, r, z) => (r.w == null && !m.f.width ? 1.6 : 0.8 + Math.sqrt((r.w || 0) / m.wmax) * 6 * Math.min(1.4, 0.8 + z * 0.15)) * m.L.st.lw;
  const arcCol = (m, r) => r.col || m.L.st.color || STYLE[G.style].dflt;
  const visArcs = m => { const r = m.L.st.top ? m.items.slice(0, m.L.st.top) : m.items; return r.slice().reverse(); };
  function arcGeom(v, r, curve) {
    const A = r.a, B = r.b, P0 = v.px(A.lon, A.lat), P1 = v.px(A.lon + wrap180(B.lon - A.lon), B.lat);
    const dx = P1[0] - P0[0], dy = P1[1] - P0[1], L = Math.hypot(dx, dy) || 1; let nx = dy / L, ny = -dx / L; if (ny > 0) { nx = -nx; ny = -ny; }
    return { P0, P1, C: [(P0[0] + P1[0]) / 2 + nx * L * curve, (P0[1] + P1[1]) / 2 + ny * L * curve] };
  }
  function drawArcsFlat(c, v, m) {
    const st = m.L.st, T = STYLE[G.style], SW = v.S0 * v.z, geo = []; c.lineCap = 'round';
    for (const r of visArcs(m)) {
      const g = arcGeom(v, r, st.curve), w = baseW(m, r, v.z); geo.push([r, g, w]);
      c.strokeStyle = arcCol(m, r); c.lineWidth = w; c.globalAlpha = (hover && hover.m === m ? (hover.it === r ? 1 : 0.18) : 0.72) * Math.min(1, st.alpha + 0.2);
      for (const off of [-SW, 0, SW]) {
        const x0 = g.P0[0] + off, x1 = g.P1[0] + off, cx = g.C[0] + off; if (Math.max(x0, x1, cx) < -20 || Math.min(x0, x1, cx) > v.W + 20) continue;
        c.beginPath(); c.moveTo(x0, g.P0[1]); c.quadraticCurveTo(cx, g.C[1], x1, g.P1[1]); c.stroke();
      }
    }
    if (endsOf(st) === 'arrows') for (const [r, g, w] of geo) {
      const dx = g.P1[0] - g.C[0], dy = g.P1[1] - g.C[1], L = Math.hypot(dx, dy) || 1; c.fillStyle = arcCol(m, r); c.globalAlpha = hover && hover.m === m ? (hover.it === r ? 1 : 0.18) : 0.9;
      for (const off of [-SW, 0, SW]) { const x = g.P1[0] + off; if (x < -20 || x > v.W + 20) continue; arrowHead(c, x, g.P1[1], dx / L, dy / L, w); }
    }
    if (st.anim) {
      c.setLineDash([1.5, 14]); c.lineDashOffset = -phase; c.strokeStyle = T.glow; c.globalAlpha = 0.95;
      for (const [, g, w] of geo) { c.lineWidth = Math.max(1.6, w * 0.55); for (const off of [-SW, 0, SW]) { const x0 = g.P0[0] + off, x1 = g.P1[0] + off, cx = g.C[0] + off; if (Math.max(x0, x1, cx) < -20 || Math.min(x0, x1, cx) > v.W + 20) continue; c.beginPath(); c.moveTo(x0, g.P0[1]); c.quadraticCurveTo(cx, g.C[1], x1, g.P1[1]); c.stroke(); } }
      c.setLineDash([]);
    }
    c.globalAlpha = 1; c.lineCap = 'butt';
  }
  function drawArcsGlobe(c, g, m) {
    const st = m.L.st, T = STYLE[G.style], lines = []; c.lineCap = 'round'; c.lineJoin = 'round'; m.hits = [];
    for (const r of visArcs(m)) {
      const A = r.a, B = r.b, la = A.lat * D2R, lb = B.lat * D2R;
      const a = [Math.cos(la) * Math.cos(A.lon * D2R), Math.cos(la) * Math.sin(A.lon * D2R), Math.sin(la)], b = [Math.cos(lb) * Math.cos(B.lon * D2R), Math.cos(lb) * Math.sin(B.lon * D2R), Math.sin(lb)];
      const d = Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))); if (d < 1e-4) continue;
      const n = Math.max(24, Math.ceil(d * 36)), lift = (0.02 + 0.2 * (d / Math.PI)) * (st.curve / 0.22), pts = [];
      for (let i = 0; i <= n; i++) {
        const fr = i / n, s0 = Math.sin((1 - fr) * d) / Math.sin(d), s1 = Math.sin(fr * d) / Math.sin(d);
        const P = g.vv(a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1, 1 + lift * Math.sin(Math.PI * fr));
        pts.push(P[2] >= 0 || P[3] > 1 ? P : null);
      }
      const w = baseW(m, r, 1) * Math.min(1.6, 0.8 + g.k * 0.15) / 1.4 * 0.9 * 1.0;
      c.strokeStyle = arcCol(m, r); c.fillStyle = arcCol(m, r); c.lineWidth = w; c.globalAlpha = (hover && hover.m === m ? (hover.it === r ? 1 : 0.18) : 0.85) * Math.min(1, st.alpha + 0.2);
      c.beginPath(); let pen = false; pts.forEach(P => { if (!P) { pen = false; return; } pen ? c.lineTo(P[0], P[1]) : c.moveTo(P[0], P[1]); pen = true; }); c.stroke();
      if (endsOf(st) === 'arrows') { const E = pts[n], Q = pts[n - 3]; if (E && Q) { const dx = E[0] - Q[0], dy = E[1] - Q[1], L = Math.hypot(dx, dy); if (L > 0.5) arrowHead(c, E[0], E[1], dx / L, dy / L, w); } }
      lines.push([pts, w]); m.hits.push({ r, pts: pts.filter(Boolean) });
    }
    if (st.anim) {
      c.setLineDash([1.5, 14]); c.lineDashOffset = -phase; c.strokeStyle = T.glow; c.globalAlpha = 0.95;
      for (const [pts, w] of lines) { c.lineWidth = Math.max(1.6, w * 0.55); c.beginPath(); let pen = false; pts.forEach(P => { if (!P) { pen = false; return; } pen ? c.lineTo(P[0], P[1]) : c.moveTo(P[0], P[1]); pen = true; }); c.stroke(); }
      c.setLineDash([]);
    }
    c.globalAlpha = 1; c.lineCap = 'butt';
  }
  function drawArcNodes(c, env, m) {
    const dots = endsOf(m.L.st) === 'dots';
    const nodes = m.items === m.base ? m.nodes : [...new Set(m.items.flatMap(r => [r.a, r.b]))];      // only the places on the routes shown now
    const nOrig = nodes.filter(n => n.o).length;
    for (const n of nodes) {
      const P = env.pt(n.lon, n.lat); if (!P) continue;
      if (dots) { c.beginPath(); c.arc(P[0], P[1], n.o ? 4.5 : 2.8, 0, 6.3); c.fillStyle = n.o ? '#ffd24a' : '#fff'; c.fill(); c.strokeStyle = n.o ? '#222' : 'rgba(0,0,0,.55)'; c.lineWidth = 1; c.stroke(); }
      if (m.L.st.nlab !== false && n.label && (env.z >= 2.2 || (n.o && nOrig <= 20 && env.z >= 1))) label(c, n.label, P[0] + 7, P[1] + 4, n.o);
    }
  }
  function hitArcs(x, y, m, view) {
    let best = null, bd = 81;
    if (view === globe) { (m.hits || []).forEach(h => h.pts.forEach(P => { const d = (P[0] - x) ** 2 + (P[1] - y) ** 2; if (d < bd) { bd = d; best = h.r; } })); return best; }
    const SW = view.S0 * view.z;
    for (const r of visArcs(m)) {
      const g = arcGeom(view, r, m.L.st.curve);
      for (const off of [-SW, 0, SW]) for (let t = 0; t <= 1.0001; t += 0.04) {
        const u = 1 - t, px = u * u * (g.P0[0] + off) + 2 * u * t * (g.C[0] + off) + t * t * (g.P1[0] + off), py = u * u * g.P0[1] + 2 * u * t * g.C[1] + t * t * g.P1[1], d = (px - x) ** 2 + (py - y) ** 2;
        if (d < bd) { bd = d; best = r; }
      }
    }
    return best;
  }

  // ================= layer: shapes (WKT geometry) =================
  function flatCache(g) {              // Mercator copies of the rings, built once
    if (g._f) return g._f;
    const conv = a => { const n = a.length / 2, mx = new Float64Array(n), my = new Float64Array(n); for (let i = 0; i < n; i++) { mx[i] = mxOf(a[2 * i]); my[i] = myOf(a[2 * i + 1]); } return { mx, my }; };
    const F = { polys: [], lines: g.lines.map(conv), b: [mxOf(g.bbox[0]), myOf(g.bbox[3]), mxOf(g.bbox[2]), myOf(g.bbox[1])] };
    g.polys.forEach(p => p.rings.forEach(r => F.polys.push(conv(r))));
    return (g._f = F);
  }
  function xyzOf(a, dense) {           // unit-sphere vertices; long edges are subdivided along the great circle
    const n = a.length / 2, out = [];
    const v = i => { const l = a[2 * i] * D2R, p = a[2 * i + 1] * D2R, cp = Math.cos(p); return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)]; };
    let prev = v(0); out.push(prev[0], prev[1], prev[2]);
    for (let i = 1; i < n; i++) {
      const cur = v(i), d = Math.acos(Math.max(-1, Math.min(1, prev[0] * cur[0] + prev[1] * cur[1] + prev[2] * cur[2])));
      if (dense && d > 0.04) { const k = Math.min(200, Math.ceil(d / 0.04)), sd = Math.sin(d); for (let j = 1; j < k; j++) { const f = j / k, s0 = Math.sin((1 - f) * d) / sd, s1 = Math.sin(f * d) / sd; out.push(prev[0] * s0 + cur[0] * s1, prev[1] * s0 + cur[1] * s1, prev[2] * s0 + cur[2] * s1); } }
      out.push(cur[0], cur[1], cur[2]); prev = cur;
    }
    return new Float32Array(out);
  }
  function globeCache(g) { return g._g || (g._g = { polys: g.polys.flatMap(p => p.rings.map(r => xyzOf(r, true))), lines: g.lines.map(l => xyzOf(l, true)) }); }

  function tracePath(c, ring, off, v, S, close) {
    const n = ring.mx.length, W2 = v.W / 2, H2 = v.H / 2; let lx = 0, ly = 0;
    for (let i = 0; i < n; i++) {
      const x = (ring.mx[i] - v.cx + off) * S + W2, y = (ring.my[i] - v.cy) * S + H2;
      if (i === 0) { c.moveTo(x, y); lx = x; ly = y; }
      else if (Math.abs(x - lx) > 0.4 || Math.abs(y - ly) > 0.4 || i === n - 1) { c.lineTo(x, y); lx = x; ly = y; }
    }
    if (close) c.closePath();
  }
  function shapeStyle(c, m, it, isLine) {
    const st = m.L.st, hi = hover && hover.it === it, col = colOf(m, it);
    c.globalAlpha = st.alpha * (hover && hover.m === m && !hi ? 0.7 : 1);
    if (isLine) { c.strokeStyle = col; c.lineWidth = (st.lw * 1.3) + (hi ? 2 : 0); c.globalAlpha = Math.min(1, st.alpha + 0.2); return; }
    c.fillStyle = col;
  }
  function outline(c, m, it) {
    const hi = hover && hover.it === it;
    if (m.L.st.outline || hi) { c.globalAlpha = 1; c.strokeStyle = hi ? (G.style === 'dark' ? '#fff' : '#000') : (m.L.st.ocolor || (G.style === 'dark' ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.4)')); c.lineWidth = hi ? 1.8 : 0.6 * Math.max(0.6, m.L.st.lw); c.stroke(); }
  }
  function drawShapesFlat(c, v, m) {
    const S = v.S0 * v.z, W = v.W, H = v.H, st = m.L.st; c.lineJoin = 'round'; c.lineCap = 'round';
    for (const it of m.items) {
      const g = it.g, F = flatCache(g), hi = hover && hover.it === it;
      for (const off of [-1, 0, 1]) {
        const x0 = (F.b[0] + off - v.cx) * S + W / 2, x1 = (F.b[2] + off - v.cx) * S + W / 2, y0 = (F.b[1] - v.cy) * S + H / 2, y1 = (F.b[3] - v.cy) * S + H / 2;
        if (x1 < -10 || x0 > W + 10 || y1 < -10 || y0 > H + 10) continue;
        if (F.polys.length) { c.beginPath(); F.polys.forEach(r => tracePath(c, r, off, v, S, true)); shapeStyle(c, m, it); c.fill('evenodd'); outline(c, m, it); }
        if (F.lines.length) { c.beginPath(); F.lines.forEach(r => tracePath(c, r, off, v, S, false)); shapeStyle(c, m, it, true); c.stroke(); }
        if (st.labels && it.name && F.polys.length && x1 - x0 > it.name.length * 6 + 10 && Math.abs(x1 - x0) < W * 3) { const q = v.px(g.lab[0], g.lab[1]); label(c, it.name, q[0] + off * S - it.name.length * 2.8, q[1] + 4); }
      }
      if (g.pts.length) pointShapes(c, m, it, flatEnv(v));
    }
    c.globalAlpha = 1;
  }
  function pointShapes(c, m, it, env) {
    for (const p of it.g.pts) {
      const P = env.pt(p[0], p[1]); if (!P) continue;
      const s = (it.s != null ? 3 + Math.sqrt(Math.max(0, it.s) / Math.max(1e-9, m.smaxS || (m.smaxS = maxOf(1e-9, m.items, i => i.s || 0)))) * 8 : 4) * m.L.st.size;
      c.beginPath(); c.arc(P[0], P[1], s, 0, 6.3); c.globalAlpha = m.L.st.alpha; c.fillStyle = colOf(m, it); c.fill(); c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 0.6; c.stroke();
    }
  }
  function drawShapesGlobe(c, g, m) {
    const st = m.L.st; c.lineJoin = 'round'; c.lineCap = 'round'; const hitsL = []; m.lineHits = hitsL;
    for (const it of m.items) {
      const G2 = globeCache(it.g);
      if (G2.polys.length) {
        c.beginPath(); let any = false; for (const ring of G2.polys) if (g.landPath(c, ring, true)) any = true;
        if (any) { shapeStyle(c, m, it); c.fill('evenodd'); outline(c, m, it); }
        if (any && st.labels && it.name) { const P = g.ll(it.g.lab[0], it.g.lab[1]); if (P[2] > 0.35 && g.k > 1.6) label(c, it.name, P[0] - it.name.length * 2.8, P[1] + 4); }
      }
      for (const ln of G2.lines) {
        shapeStyle(c, m, it, true); c.beginPath(); let pen = false; const pts = [];
        for (let i = 0; i < ln.length; i += 3) { const P = g.vv(ln[i], ln[i + 1], ln[i + 2]); if (P[2] <= 0) { pen = false; continue; } pen ? c.lineTo(P[0], P[1]) : c.moveTo(P[0], P[1]); pen = true; pts.push(P); }
        c.stroke(); hitsL.push({ it, pts });
      }
      if (it.g.pts.length) pointShapes(c, m, it, globeEnv(g));
    }
    c.globalAlpha = 1;
  }
  function inRing(r, lon, lat) {
    let ins = false; const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  function inGeom(g, lon, lat) {
    for (const k of [0, -360, 360]) {
      const x = lon + k;
      for (const p of g.polys) {
        const b = p.bbox; if (x < b[0] || x > b[2] || lat < b[1] || lat > b[3]) continue;
        let ins = false; for (const r of p.rings) if (inRing(r, x, lat)) ins = !ins;
        if (ins) return true;
      }
    }
    return false;
  }
  function hitShapes(x, y, m, view) {
    const ll = view.inv(x, y);
    if (ll) for (let i = m.items.length - 1; i >= 0; i--) if (inGeom(m.items[i].g, ll[0], ll[1])) return m.items[i];
    // lines: nearest vertex / segment on screen
    if (!m.items.some(i => i.g.lines.length)) return null;
    let best = null, bd = 64;
    if (view === globe) { (m.lineHits || []).forEach(h => h.pts.forEach(P => { const d = (P[0] - x) ** 2 + (P[1] - y) ** 2; if (d < bd) { bd = d; best = h.it; } })); return best; }
    const S = view.S0 * view.z;
    for (const it of m.items) {
      if (!it.g.lines.length) continue; const F = flatCache(it.g);
      for (const r of F.lines) for (const off of [-1, 0, 1]) for (let i = 0; i < r.mx.length - 1; i++) {
        const ax = (r.mx[i] - view.cx + off) * S + view.W / 2, ay = (r.my[i] - view.cy) * S + view.H / 2, bx = (r.mx[i + 1] - view.cx + off) * S + view.W / 2, by = (r.my[i + 1] - view.cy) * S + view.H / 2;
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)), d = (ax + t * dx - x) ** 2 + (ay + t * dy - y) ** 2;
        if (d < bd) { bd = d; best = it; }
      }
    }
    return best;
  }

  // ================= legend =================
  function drawLegend(c, W, H) {
    const vis = models.filter(m => m.L.on && m.L.st.legend !== false && m.base.length && m.leg.length); if (!vis.length) return;
    const w = 178, ROW = 16, GAP = 8;
    const heightOf = m => { let h = 10 + 17; for (const lg of m.leg) { let ht = 16; if (lg.cat) ht += Math.min(lg.cat.size, lg.max || 6) * ROW + (lg.cat.size > (lg.max || 6) ? ROW : 0); else if (lg.ramp) ht += 30; else if (lg.size != null) ht = 18; h += ht; } return h + 4; };
    // one card per layer, stacked up from the bottom left; a new column starts when the next card would not fit
    let x = 8, bottom = H - 20; c.textBaseline = 'middle';
    for (const m of vis) {
      const h = heightOf(m); if (h > H - 30) continue;
      if (bottom - h < 8 && bottom !== H - 20) { x += w + GAP; bottom = H - 20; }
      const y = bottom - h; bottom = y - GAP;
      panel(c, x, y, w, h); let yy = y + 14;
      c.font = 'bold 11px ' + FONT; c.fillStyle = '#000'; c.textAlign = 'left'; c.fillText(trunc(m.L.name, 26), x + 8, yy); yy += 17;
      for (const lg of m.leg) {
        c.textAlign = 'left'; c.fillStyle = '#222';
        if (lg.size != null) { c.font = '11px ' + FONT; c.fillText((lg.line ? 'Width: ' : lg.bar ? 'Height: ' : 'Size: ') + trunc(lg.title, 14) + ' (max ' + fmt(Math.round(lg.size)) + ')', x + 10, yy); yy += 18; continue; }
        c.font = 'bold 11px ' + FONT; c.fillText(trunc(lg.title, 26), x + 10, yy); c.font = '11px ' + FONT; yy += 16;
        if (lg.cat) {
          const cats = [...lg.cat].slice(0, lg.max || 6);
          cats.forEach(([n, col]) => { c.fillStyle = col; c.fillRect(x + 10, yy - 5, 14, 10); c.strokeStyle = 'rgba(0,0,0,.35)'; c.strokeRect(x + 10, yy - 5, 14, 10); c.fillStyle = '#222'; c.fillText(trunc(n, 24), x + 30, yy); yy += ROW; });
          if (lg.cat.size > cats.length) { c.fillStyle = '#666'; c.fillText('+' + (lg.cat.size - cats.length) + ' more', x + 30, yy); yy += ROW; }
        } else if (lg.ramp) {
          const gr = c.createLinearGradient(x + 10, 0, x + w - 10, 0); lg.ramp.forEach(st => gr.addColorStop(st[0], st[1]));
          c.fillStyle = gr; c.fillRect(x + 10, yy - 5, w - 20, 9); c.fillStyle = '#222'; c.textAlign = 'left'; c.fillText(lg.words ? lg.words[0] : fmt(Math.round(lg.min)), x + 10, yy + 12);
          c.textAlign = 'right'; c.fillText(lg.words ? lg.words[1] : fmt(Math.round(lg.max)), x + w - 10, yy + 12); c.textAlign = 'left'; yy += 30;
        }
      }
    }
    c.textBaseline = 'alphabetic';
  }
  const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // ================= tooltip =================
  function titleOf(m, it) {
    if (m.L.type === 'arcs') { const nm = n => n.label || n.lat.toFixed(2) + ', ' + n.lon.toFixed(2); return nm(it.a) + ' → ' + nm(it.b); }
    if (it.name) return it.name;
    for (const k of Object.keys(it.row)) { const col = colInfo(k, m.cols); if (col && col.dataType === 'string' && !isNull(it.row[k])) return str(it.row[k]); }
    return m.L.name;
  }
  function tipHtml(m, it) {
    if (m.L.type === 'pies') {
      return '<b>' + esc(it.name) + '</b>' + m.pnames.filter(n => it.s.get(n)).map(n => '<span style="color:' + m.pcol.get(n) + '">&#9632;</span> ' + esc(n) + ': <b style="display:inline">' + fmt(it.s.get(n)) + '</b>').join('<br>') +
        (m.f.value ? '<br><span class="k">Total ' + esc(m.f.value) + ':</span> ' + fmt(it.n) : '');
    }
    const hide = new Set(Object.values(m.f).filter(Boolean).filter(n => { const c = colInfo(n, m.cols); return (c && c.dataType === 'spatial') || isLonOrLatUsed(m, n); }));
    const title = titleOf(m, it), out = [];
    for (const k of Object.keys(it.row)) {
      if (hide.has(k) || /\(generated\)$/.test(k) || isNull(it.row[k]) || (colInfo(k, m.cols) || {}).dataType === 'spatial') continue;
      const t = str(it.row[k]); if (t === title) continue;
      out.push('<span class="k">' + esc(k) + ':</span> ' + esc(t));
    }
    return '<b>' + esc(title) + '</b>' + out.join('<br>');
  }
  const isLonOrLatUsed = (m, n) => ['lon', 'lat', 'olon', 'olat', 'dlon', 'dlat'].some(k => m.f[k] === n);

  // ================= views =================
  const DRAW = {
    flat: (c, v) => {
      const env = flatEnv(v);
      for (const m of models) {
        if (!m.L.on || !m.items.length) continue;
        if (m.L.type === 'shapes') drawShapesFlat(c, v, m);
        else if (m.L.type === 'symbols') drawSymbols(c, env, m);
        else if (m.L.type === 'density') drawDensity(c, env, m);
        else if (m.L.type === 'bars') drawBars(c, env, m);
        else if (m.L.type === 'pies') drawPies(c, env, m);
        else { drawArcsFlat(c, v, m); drawArcNodes(c, env, m); }
      }
      drawLegend(c, v.W, v.H);
    },
    globe: (c, g) => {
      const env = globeEnv(g);
      for (const m of models) {
        if (!m.L.on || !m.items.length) continue;
        if (m.L.type === 'shapes') drawShapesGlobe(c, g, m);
        else if (m.L.type === 'symbols') drawSymbols(c, env, m);
        else if (m.L.type === 'density') drawDensity(c, env, m);
        else if (m.L.type === 'bars') drawBars(c, env, m);
        else if (m.L.type === 'pies') drawPies(c, env, m);
        else { drawArcsGlobe(c, g, m); drawArcNodes(c, env, m); }
      }
      drawLegend(c, g.W, g.H);
    }
  };
  const HIT = { shapes: hitShapes, symbols: hitSymbols, density: () => null, bars: hitBars, pies: hitPies, arcs: hitArcs };      // a density layer is a surface, so it has nothing to hover
  function onHover(x, y, e, view) {
    const tipV = view || active();
    if (x == null) { setHover(null); tipV.hideTip(); return; }
    let h = null;
    for (let i = models.length - 1; i >= 0 && !h; i--) {
      const m = models[i]; if (!m.L.on || !m.items.length || m.L.st.active === false) continue;      // a layer set to not interactive has no hover
      const it = HIT[m.L.type](x, y, m, tipV); if (it) h = { m, it };
    }
    setHover(h); if (!h) { tipV.hideTip(); return; } tipV.showTip(tipHtml(h.m, h.it), e);
  }
  const flat = new MapView(content, { wrap: true, draw: DRAW.flat, onHover, onSized: () => { if (!homed && models.length) rebuild(); } });
  const globe = new GlobeView(content, { draw: DRAW.globe, onHover });
  const active = () => (G.map === 'globe' ? globe : flat);
  function applyStyle() { const T = STYLE[G.style]; flat.theme = { bg: T.bg, land: T.land, stroke: T.stroke }; globe.setTheme(G.style); document.body.style.background = T.bg; flat.showLand = globe.showLand = G.base; }
  function applyMap() { flat.setVisible(G.map !== 'globe'); globe.setVisible(G.map === 'globe'); redraw(); tick(); }
  function setHover(h) { const same = (!h && !hover) || (h && hover && h.m === hover.m && h.it === hover.it); if (!same) { hover = h; redraw(); } }
  function redraw() { active().draw(); }
  // animation loop: flowing dashes on arcs, and the globe turning by itself
  let lastT = 0, dragging = false, resumeAt = 0;
  const spinning = () => G.map === 'globe' && G.rot;
  function tick() {
    cancelAnimationFrame(raf);
    const arcsAnim = models.some(m => m.L.on && m.L.type === 'arcs' && m.L.st.anim && m.items.length);
    if (!arcsAnim && !spinning() && !T.playing) { lastT = 0; return; }
    const now = performance.now(), dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0; lastT = now;
    phase = (now / 45) % 15.5;
    if (T.playing) { T.acc += dt; if (T.acc >= 1 / G.tsp) { T.acc = 0; stepTime(); } }
    if (spinning() && !dragging && !hover && now > resumeAt) globe.lon = wrap180(globe.lon - G.rs * dt);   // west to east, like the earth
    redraw(); raf = requestAnimationFrame(tick);
  }
  globe.cv.addEventListener('pointerdown', () => { dragging = true; });
  const letGo = () => { if (dragging) { dragging = false; resumeAt = performance.now() + 1500; } };
  globe.cv.addEventListener('pointerup', letGo); globe.cv.addEventListener('pointercancel', letGo);

  // ---- time line (play button, slider) ----
  const tl = $('tl'), tlPlay = $('tlPlay'), tlSlider = $('tlSlider'), tlLabel = $('tlLabel'), tlAll = $('tlAll');
  function updateTL() {
    const n = T.steps.length; tl.hidden = n < 2; if (n < 2) return;
    tlSlider.max = n - 1; tlSlider.value = T.idx < 0 ? n - 1 : T.idx;
    tlLabel.textContent = T.idx < 0 ? 'All dates' : fmtStep(T.steps[T.idx]) + '  (' + (T.idx + 1) + '/' + n + ')';
    tlPlay.textContent = T.playing ? '\u275A\u275A' : '\u25B6'; tlPlay.title = T.playing ? 'Pause' : 'Play';
  }
  function stepTime() {
    const n = T.steps.length; T.idx++;
    if (T.idx >= n) { if (G.tloop) T.idx = 0; else { T.idx = n - 1; T.playing = false; } }
    applyTime(); updateTL(); redraw();
  }
  tlPlay.addEventListener('click', () => {
    const n = T.steps.length; if (n < 2) return;
    if (T.playing) { T.playing = false; updateTL(); return; }
    if (T.idx < 0 || T.idx >= n - 1) T.idx = 0;
    T.playing = true; T.acc = 0; applyTime(); updateTL(); redraw(); tick();
  });
  tlSlider.addEventListener('input', () => { T.playing = false; T.idx = +tlSlider.value; applyTime(); updateTL(); redraw(); });
  tlAll.addEventListener('click', () => { T.playing = false; T.idx = -1; applyTime(); updateTL(); redraw(); });
  tl.addEventListener('pointerdown', e => e.stopPropagation()); tl.addEventListener('wheel', e => e.stopPropagation());

  // ---- fit the views to the data ----
  const toLon = cx => ((cx * 360 - 180 + 540) % 360 + 360) % 360 - 180, toLat = cy => (2 * Math.atan(Math.exp(2 * Math.PI * (0.5 - cy))) - Math.PI / 2) / D2R;
  function applyFit() {
    if (!flat.S0 || !flat.W) return false;          // the map has no size yet (the page is still being laid out): try again once it has
    const e = ext, f = G.fixed;
    if (G.sv === 'fixed' && f) {            // a view the user saved: lon, lat and how many degrees fit across the shorter side
      flat.setHome(f.lon); flat.setHomeView(mxOf(f.lon), myOf(Math.max(-84, Math.min(84, f.lat))), Math.max(1, Math.min(60, Math.min(flat.W, flat.H) * 360 / (flat.S0 * f.span))));
      globe.setHome(f.lon, f.lat); globe.setHomeK(Math.max(0.6, Math.min(12, 57.3 / (0.45 * f.span)))); return true;
    }
    if (G.sv === 'world' || !e || e.b - e.a > 300) { flat.setHome(10); flat.setHomeView(null); globe.setHome(10, 20); globe.setHomeK(1); }
    else {
      const lon = (e.a + e.b) / 2, lat = (e.c + e.d) / 2, dm = Math.max(1e-4, mxOf(e.b) - mxOf(e.a)), dy = Math.max(1e-4, myOf(e.c) - myOf(e.d));
      const z = Math.max(1, Math.min(40, 0.8 * Math.min(flat.W / (flat.S0 * dm), flat.H / (flat.S0 * dy))));
      flat.setHomeView((mxOf(e.a) + mxOf(e.b)) / 2, (myOf(e.c) + myOf(e.d)) / 2, z);
      const ang = Math.max(0.02, Math.acos(Math.max(-1, Math.min(1, Math.sin(e.c * D2R) * Math.sin(lat * D2R) + Math.cos(e.c * D2R) * Math.cos(lat * D2R) * Math.cos((e.b - e.a) / 2 * D2R)))));
      globe.setHome(lon, lat); globe.setHomeK(Math.max(1, Math.min(12, 0.85 / Math.sin(Math.min(ang, 1.4)))));
    }
    return true;
  }

  // ================= data =================
  function rebuild() {
    models = layers.map(build); ext = null; buildTimeline(); applyTime(); updateTL();
    models.forEach(m => { if (m.L.on && m.ext) { ext = ext || { a: 180, b: -180, c: 90, d: -90 }; ext.a = Math.min(ext.a, m.ext.a); ext.b = Math.max(ext.b, m.ext.b); ext.c = Math.min(ext.c, m.ext.c); ext.d = Math.max(ext.d, m.ext.d); } });
    const total = models.reduce((a, m) => a + (m.L.on ? m.base.length : 0), 0);
    if (!layers.length && DASH) show('<b>Map studio (dashboard)</b><br>Add worksheets to this dashboard (they can be hidden), one per layer, with the fields it needs on <b>Detail</b>: a spatial field, or longitude and latitude, or origin and destination. Then open <b>Layers</b> and add a layer for each sheet.');
    else if (!layers.length) show('<b>Map studio</b><br>Put a spatial field (e.g. Geometry) on <b>Detail</b>, or a longitude and latitude on <b>Location</b>, or open the <b>Layer</b> panel and choose a type.');
    else if (!total) show('<b>Nothing to draw yet</b><br>' + models.map(m => esc(m.L.name) + ': ' + esc(m.msg || 'no matching rows')).join('<br>') + '<br>Open the panel to choose fields.');
    else show('');
    updateNote();
    if (!homed && (ext || G.sv !== 'fit')) { if (applyFit() !== false) { flat.reset(); globe.reset(); homed = true; } } else if (ext || G.sv !== 'fit') applyFit();
    // When the data now covers a different area (a filter from another sheet or dashboard, say), swing the map and the globe over to it. Only in "Fit to the data" mode.
    const key = ext ? [ext.a, ext.b, ext.c, ext.d].map(v => Math.round(v * 2) / 2).join(',') : '';
    if (homed && G.sv === 'fit' && key && key !== lastExtKey && lastExtKey !== null) { flat.reset(); globe.reset(); }
    if (key || lastExtKey === null) lastExtKey = key;
    tick(); redraw();
  }
  function show(msg) { hint.innerHTML = msg; hint.hidden = !msg; }
  function loadSettings() {
    const g = TX.settings.get;
    G.map = g('map', G.map); G.style = g('style', G.style); G.base = g('base', '1') === '1'; G.lf = g('lf', ''); G.sv = g('sv', 'fit'); G.rot = g('rot', '0') === '1'; G.rs = parseFloat(g('rs', '6')) || 6; try { G.fixed = JSON.parse(g('fixed', 'null')); } catch (e) { G.fixed = null; }
    G.tm = g('tm', 'period'); G.tn = parseInt(g('tn', '3'), 10) || 3; G.tg = g('tg', 'exact'); G.tsp = parseFloat(g('tsp', '1.5')) || 1.5; G.tloop = g('tloop', '1') === '1';
    try { G.dismissed = JSON.parse(g('dismissed', '[]')); } catch (e) { G.dismissed = []; }
    try { const s = g('layers', ''); if (s) { layers = JSON.parse(s); auto = false; } } catch (e) { /* ignore a damaged value */ }
  }
  TX.settings.onError = err => show('<b>Your settings could not be saved</b><br>' + esc(String(err && err.message || err)) + '<br>They will be lost if the extension reloads. Try again, or save the workbook.');
  function persist() { clearTimeout(saveT); saveT = setTimeout(writeSettings, 400); }
  function writeSettings() {
    {
      TX.settings.set('map', G.map); TX.settings.set('style', G.style); TX.settings.set('base', G.base ? '1' : '0'); TX.settings.set('lf', G.lf); TX.settings.set('sv', G.sv); TX.settings.set('rot', G.rot ? '1' : '0'); TX.settings.set('rs', String(G.rs)); TX.settings.set('fixed', JSON.stringify(G.fixed));
      TX.settings.set('tm', G.tm); TX.settings.set('tn', String(G.tn)); TX.settings.set('tg', G.tg); TX.settings.set('tsp', String(G.tsp)); TX.settings.set('tloop', G.tloop ? '1' : '0');
      TX.settings.set('dismissed', JSON.stringify(G.dismissed)); TX.settings.set('layers', JSON.stringify(layers));
    }
  }
  function onData(d) {
    if (d.error) { show('<b>Something went wrong</b><br>' + esc(d.error)); return; }
    if (!loaded) { loaded = true; if (!TX.demo) loadSettings(); else if (d.layerField) G.lf = d.layerField; applyStyle(); applyMap(); }
    // A filter can leave a sheet (or the whole viz) with no rows, and then Tableau may report no columns either. Keep the last known columns so the layer's fields and choices don't vanish.
    const sheets = d.sheets || {};
    for (const [n, s] of Object.entries(sheets)) if (!(s.cols || []).length && D.sheets[n] && D.sheets[n].cols.length) sheets[n] = { ...s, cols: D.sheets[n].cols };
    const cols = (d.cols && d.cols.length) || !d.rows || d.rows.length ? (d.cols || []) : D.cols;
    D = { rows: d.rows || [], enc: d.enc || {}, cols, preset: d.preset || null, sheets };
    if (auto || !layers || !layers.length) { layers = autoLayers(); auto = true; }
    else if (DASH) {          // saved layers stay as they are, but a sheet that has map fields now and no layer yet (it was empty or still loading when they were saved) gets one
      const have = new Set(layers.map(l => l.sheet)); let added = false;
      for (const L of autoLayers()) if (!have.has(L.sheet) && !G.dismissed.includes(L.id)) { layers.push(L); added = true; }
      if (added) persist();
    }
    if (!DASH && layers.length > 1) layers = layers.slice(0, 1);      // the worksheet extension draws exactly one layer
    T.idx = -1; T.playing = false; T.acc = 0;      // new data from Tableau (a filter, say) always starts on "All dates"
    rebuild(); renderPanel();
    if (!TX.demo && !layers.length) show('<b>No layers loaded</b><br>' + esc(diagText()) + '<br>Sheets seen: ' + (Object.keys(sheets).join(', ') || 'none') + '. Layers: 0. Open the panel to choose a layer type.');
  }

  // ================= Layers panel =================
  const pbody = $('pbody'), openIds = new Set();
  const optsOf = (L, key, pred) => {
    const dflt = fieldsOf({ ...L, f: {} })[key], cur = L.f[key] || '', lead = DASH ? 'Auto: ' : 'Marks card: ';
    let h = '<option value=""' + (cur === '' ? ' selected' : '') + '>' + (dflt ? lead + esc(trunc(dflt, 22)) : (DASH ? 'Auto (none found)' : 'Marks card (not set)')) + '</option><option value="-"' + (cur === '-' ? ' selected' : '') + '>(none)</option>';
    const list = ctxOf(L).cols.filter(pred || (() => true)).map(c => c.name); if (cur && cur !== '-' && !list.includes(cur)) list.unshift(cur);
    return h + list.map(n => '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(trunc(n, 28)) + '</option>').join('');
  };
  const timeable = c => c.dataType === 'date' || c.dataType === 'date-time' || c.dataType === 'int', any = () => true, numeric = c => isNumCol(c), spatial = c => c.dataType === 'spatial', nonSpatial = c => c.dataType !== 'spatial';
  function fsel(L, key, label, pred) { return '<label>' + label + '<select data-l="' + L.id + '" data-k="f.' + key + '">' + optsOf(L, key, pred) + '</select></label>'; }
  function rng(L, key, label, min, max, step) { return '<label>' + label + '<input type="range" data-l="' + L.id + '" data-k="st.' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + L.st[key] + '"></label>'; }
  function chk(L, key, label) { return '<label class="chk"><input type="checkbox" data-l="' + L.id + '" data-k="st.' + key + '"' + (L.st[key] ? ' checked' : '') + '>&nbsp;' + label + '</label>'; }
  function palette(L) { return '<label>Palette<select data-l="' + L.id + '" data-k="st.ramp">' + Object.entries(RAMPS).map(([k, v]) => '<option value="' + k + '"' + (L.st.ramp === k ? ' selected' : '') + '>' + v[0] + '</option>').join('') + '</select></label>'; }
  const isClear = L => L.st.color === 'transparent';
  function fixedColor(L) { return '<label>Fixed colour<span><input type="color" data-l="' + L.id + '" data-k="st.color" value="' + (L.st.color && !isClear(L) ? L.st.color : '#4aa3df') + '"' + (isClear(L) ? ' style="opacity:.35"' : '') + '> <button type="button" data-act="clearcolor" data-l="' + L.id + '" title="Use the default colour">auto</button> <button type="button" data-act="transparent" data-l="' + L.id + '" title="No colour: see-through fill (shapes) or hollow symbols"' + (isClear(L) ? ' style="font-weight:bold;outline:1px solid #4aa3df"' : '') + '>transparent</button></span></label>'; }
  function outlineColor(L) { return '<label>Outline colour<span><input type="color" data-l="' + L.id + '" data-k="st.ocolor" value="' + (L.st.ocolor || '#f28e2b') + '"> <button type="button" data-act="clearocolor" data-l="' + L.id + '" title="Use the default outline">auto</button></span></label>'; }
  function layerBody(L) {
    let h = '';
    h += '<label>Type<select data-l="' + L.id + '" data-k="type">' + Object.entries(TYPES).map(([k, v]) => '<option value="' + k + '"' + (L.type === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></label>';
    if (DASH) {
      const sn = Object.keys(D.sheets);
      h += '<label>Data from sheet<select data-l="' + L.id + '" data-k="sheet"><option value="">(choose a sheet)</option>' + sn.map(n => '<option value="' + esc(n) + '"' + (n === L.sheet ? ' selected' : '') + '>' + esc(trunc(n, 26)) + '</option>').join('') + (L.sheet && !sn.includes(L.sheet) ? '<option value="' + esc(L.sheet) + '" selected>' + esc(trunc(L.sheet, 26)) + ' (missing)</option>' : '') + '</select></label>';
    } else if (G.lf && TX.demo) {
      const vals = [...new Set(D.rows.map(r => str(r[G.lf])))].slice(0, 200).sort();
      h += '<label>Rows where ' + esc(trunc(G.lf, 14)) + ' =<select data-l="' + L.id + '" data-k="lv"><option value="">(all rows)</option>' + vals.map(v => '<option value="' + esc(v) + '"' + (v === L.lv ? ' selected' : '') + '>' + esc(trunc(v, 26)) + '</option>').join('') + '</select></label>';
    }
    if (L.type === 'shapes') {
      h += fsel(L, 'geom', 'Geometry', spatial) + fsel(L, 'name', 'Name / label', nonSpatial) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'size', 'Size by (points)', numeric) + fsel(L, 'time', 'Time field', timeable) + palette(L) + fixedColor(L) + outlineColor(L) +
        rng(L, 'alpha', 'Opacity', 0.1, 1, 0.05) + rng(L, 'lw', 'Line width', 0.3, 4, 0.1) + chk(L, 'outline', 'Outline') + chk(L, 'labels', 'Labels');
    } else if (L.type === 'symbols') {
      h += fsel(L, 'lon', 'Longitude', numeric) + fsel(L, 'lat', 'Latitude', numeric) + fsel(L, 'name', 'Name / label', nonSpatial) + fsel(L, 'size', 'Size by', numeric) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'time', 'Time field', timeable) +
        '<label>Symbol<select data-l="' + L.id + '" data-k="st.shape">' + SHAPES.map(([k, n]) => '<option value="' + k + '"' + (L.st.shape === k ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>' +
        palette(L) + fixedColor(L) + outlineColor(L) + rng(L, 'size', 'Symbol size', 0.4, 3, 0.05) + rng(L, 'alpha', 'Opacity', 0.1, 1, 0.05) + chk(L, 'labels', 'Labels');
    } else if (L.type === 'bars') {
      if (L.st.bh == null) L.st.bh = 1; if (L.st.bw == null) L.st.bw = 1;
      h += fsel(L, 'lon', 'Longitude', numeric) + fsel(L, 'lat', 'Latitude', numeric) + fsel(L, 'name', 'Location name', nonSpatial) + fsel(L, 'height', 'Height by', numeric) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'time', 'Time field', timeable) +
        palette(L) + fixedColor(L) + outlineColor(L) + rng(L, 'bh', 'Max height', 0.2, 3, 0.05) + rng(L, 'bw', 'Bar width', 0.3, 3, 0.05) + rng(L, 'alpha', 'Opacity', 0.1, 1, 0.05) + chk(L, 'labels', 'Show labels (name, or the height value if there is no name)');
    } else if (L.type === 'density') {
      const st = L.st; if (st.radius == null) st.radius = 1; if (st.intensity == null) st.intensity = 1; if (!DRAMPS[st.dramp]) st.dramp = 'fire';
      h += fsel(L, 'lon', 'Longitude', numeric) + fsel(L, 'lat', 'Latitude', numeric) + fsel(L, 'weight', 'Weight by (optional)', numeric) + fsel(L, 'time', 'Time field', timeable) +
        '<label>Palette<select data-l="' + L.id + '" data-k="st.dramp">' + Object.entries(DRAMPS).map(([k, v]) => '<option value="' + k + '"' + (st.dramp === k ? ' selected' : '') + '>' + v[0] + '</option>').join('') + '</select></label>' +
        rng(L, 'radius', 'Radius', 0.3, 3, 0.05) + rng(L, 'intensity', 'Intensity', 0.2, 4, 0.05) + rng(L, 'alpha', 'Opacity', 0.1, 1, 0.05);
    } else if (L.type === 'pies') {
      h += fsel(L, 'name', 'Location (country)', nonSpatial) + fsel(L, 'lon', 'Longitude (optional)', numeric) + fsel(L, 'lat', 'Latitude (optional)', numeric) + fsel(L, 'slice', 'Slice (dimension)', nonSpatial) + fsel(L, 'value', 'Value (measure)', numeric) + rng(L, 'size', 'Pie size', 0.4, 2.5, 0.05) + rng(L, 'alpha', 'Opacity', 0.1, 1, 0.05);
    } else {
      h += fsel(L, 'oname', 'Origin name', nonSpatial) + fsel(L, 'olon', 'Origin longitude', numeric) + fsel(L, 'olat', 'Origin latitude', numeric) +
        fsel(L, 'dname', 'Destination name', nonSpatial) + fsel(L, 'dlon', 'Destination longitude', numeric) + fsel(L, 'dlat', 'Destination latitude', numeric) +
        fsel(L, 'width', 'Width by', numeric) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'time', 'Time field', timeable) + palette(L) + fixedColor(L) +
        '<label>Routes shown<select data-l="' + L.id + '" data-k="st.top">' + [[0, 'All'], [10, 'Top 10'], [25, 'Top 25'], [50, 'Top 50'], [100, 'Top 100'], [250, 'Top 250']].map(([v, n]) => '<option value="' + v + '"' + (+L.st.top === v ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>' +
        rng(L, 'lw', 'Line width', 0.3, 3, 0.05) + rng(L, 'curve', 'Curve', 0, 0.5, 0.02) + rng(L, 'alpha', 'Opacity', 0.1, 1, 0.05) + '<label>Route ends<select data-l="' + L.id + '" data-k="st.ends">' + [['dots', 'Dots'], ['arrows', 'Arrowheads'], ['none', 'Plain lines']].map(([v, n]) => '<option value="' + v + '"' + (endsOf(L.st) === v ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>' + chk(L, 'anim', 'Animate flow') + '<label class="chk"><input type="checkbox" data-l="' + L.id + '" data-k="st.nlab"' + (L.st.nlab !== false ? ' checked' : '') + '>&nbsp;Show place labels</label>';
    }
    return h;
  }
  function diagText() {
    const i = TX.settings.info, hm = d => d.toTimeString().slice(0, 8);
    if (TX.demo) return 'Demo mode: settings are not stored.';
    return 'At start the workbook held ' + (i.loaded == null ? '?' : i.loaded) + ' saved setting(s)' + (i.restored.length ? ', and ' + i.restored.length + ' were restored from the copy kept on this computer' : '') + '. ' +
      'Layers now: ' + layers.length + '. ' + (i.last ? (i.last.ok ? 'Last save ' + hm(i.last.at) + ': OK, workbook now holds ' + i.last.keys + ' setting(s).' : 'Last save ' + hm(i.last.at) + ' FAILED: ' + i.last.error) : 'Nothing saved yet this session.');
  }
  TX.settings.onSaved = () => { const e = $('diag'); if (e) e.textContent = diagText(); const i = TX.settings.info; if (i.last && i.last.ok && /could not be saved/.test(hint.innerHTML)) show(''); };
  function renderPanel() {
    const sc = pbody.scrollTop;
    let h = '<div class="grp"><label>Map<select data-g="map"><option value="flat"' + (G.map === 'flat' ? ' selected' : '') + '>Flat</option><option value="globe"' + (G.map === 'globe' ? ' selected' : '') + '>Globe (3D)</option></select></label>' +
      (G.map === 'globe' ? '<label class="chk"><input type="checkbox" data-g="rot"' + (G.rot ? ' checked' : '') + '>&nbsp;Auto-rotate the globe</label>' + (G.rot ? '<label>Rotation speed<input type="range" data-g="rs" min="1" max="30" step="1" value="' + G.rs + '"></label>' : '') : '') +
      '<label>Style<select data-g="style"><option value="dark"' + (G.style === 'dark' ? ' selected' : '') + '>Dark</option><option value="light"' + (G.style === 'light' ? ' selected' : '') + '>Light</option></select></label>' +
      '<label class="chk"><input type="checkbox" data-g="base"' + (G.base ? ' checked' : '') + '>&nbsp;Show country base map</label>' +
      '<label title="Where the map opens, and where the home button goes">Start view<select data-g="sv"><option value="fit"' + (G.sv === 'fit' ? ' selected' : '') + '>Fit to the data</option><option value="world"' + (G.sv === 'world' ? ' selected' : '') + '>Whole world</option><option value="fixed"' + (G.sv === 'fixed' ? ' selected' : '') + '>Saved view</option></select></label>' +
      '<div class="sv"><button type="button" data-act="setview" title="Pan and zoom first, then press this">Use current view as start</button>' + (G.sv === 'fixed' && !G.fixed ? ' <span class="sub">none saved yet</span>' : '') + '</div>' +
      (true ? '' : '<label title="A column that says which layer each row belongs to, e.g. after a union of several tables">Layer column<select data-g="lf"><option value="">(none)</option>' + D.cols.filter(nonSpatial).map(c => '<option value="' + esc(c.name) + '"' + (c.name === G.lf ? ' selected' : '') + '>' + esc(trunc(c.name, 26)) + '</option>').join('') + '</select></label>') + '</div>';
    h += '<div class="grp"><div class="lh">Time line <span class="sub">' + (T.steps.length > 1 ? '(' + T.steps.length + ' steps)' : '(no time field in use)') + '</span></div>' + (T.steps.length > 1 ?
      '<label>Show<select data-g="tm"><option value="period"' + (G.tm === 'period' ? ' selected' : '') + '>This step only</option><option value="cum"' + (G.tm === 'cum' ? ' selected' : '') + '>Everything up to this step</option><option value="trail"' + (G.tm === 'trail' ? ' selected' : '') + '>The last few steps</option></select></label>' +
      (G.tm === 'trail' ? '<label>Steps kept<input type="range" data-g="tn" min="2" max="12" step="1" value="' + G.tn + '"></label>' : '') +
      '<label>Step by<select data-g="tg"><option value="exact"' + (G.tg === 'exact' ? ' selected' : '') + '>Each date value</option><option value="year"' + (G.tg === 'year' ? ' selected' : '') + '>Year</option><option value="month"' + (G.tg === 'month' ? ' selected' : '') + '>Month</option><option value="day"' + (G.tg === 'day' ? ' selected' : '') + '>Day</option></select></label>' +
      '<label>Speed<input type="range" data-g="tsp" min="0.25" max="6" step="0.25" value="' + G.tsp + '"></label><label class="chk"><input type="checkbox" data-g="tloop"' + (G.tloop ? ' checked' : '') + '>&nbsp;Loop</label>'
      : '<div class="sub">Choose a date field under <b>Time field</b> in the layer to get a play button.</div>') + '</div>';
    h += '<div class="lh">' + (DASH ? 'Layers <span class="sub">(top of the list is drawn last)</span>' : 'Layer') + '</div>';
    [...layers].reverse().forEach(L => {
      h += '<details class="lyr" data-id="' + L.id + '"' + (openIds.has(L.id) || !DASH ? ' open' : '') + '><summary><button type="button" data-act="toggle" class="chev" title="Show / hide the settings"></button><input type="checkbox" data-l="' + L.id + '" data-k="on" title="Show / hide"' + (L.on ? ' checked' : '') + '> <input class="nm" type="text" data-l="' + L.id + '" data-k="name" value="' + esc(L.name) + '"> ' +
(DASH ? '<button type="button" data-act="up" data-l="' + L.id + '" title="Draw later (on top)">&uarr;</button><button type="button" data-act="down" data-l="' + L.id + '" title="Draw earlier">&darr;</button><button type="button" data-act="del" data-l="' + L.id + '" title="Remove layer">&times;</button>' : '') + '</summary><div class="lb"><div class="two"><label class="chk" title="Show a legend card for this layer"><input type="checkbox" data-l="' + L.id + '" data-k="st.legend"' + (L.st.legend !== false ? ' checked' : '') + '>&nbsp;Legend card</label><label class="chk" title="Off: the layer is only drawn. Hover and tooltips ignore it"><input type="checkbox" data-l="' + L.id + '" data-k="st.active"' + (L.st.active !== false ? ' checked' : '') + '>&nbsp;Interactive</label></div>' + layerBody(L) + '</div></details>';
    });
    if (DASH || !layers.length) h += '<div class="add"><select id="addType">' + Object.entries(TYPES).map(([k, v]) => '<option value="' + k + '">' + v + '</option>').join('') + '</select><button type="button" data-act="add">+ Add layer</button></div>';
    if (auto && layers.length) h += '<div class="sub">' + (DASH ? 'One layer was set up for each sheet that has map fields. Change anything here to take control.' : 'The layer was set up automatically from the Marks card. Change anything here to take control.') + '</div>';
    const me = [...document.scripts].find(s => /map-studio\.js/.test(s.src)), ver = me && (me.src.match(/[?&]v=(\d+)/) || [])[1];
    h += '<div class="sv"><button type="button" data-act="reload" title="Save your settings and download the latest version of this extension. Then use the Reload option in Tableau">Save &amp; fetch latest</button> <span class="sub">' + (ver ? 'version ' + ver : '') + '</span></div><div class="sub" id="diag">' + esc(diagText()) + '</div>';
    pbody.innerHTML = h; pbody.scrollTop = sc;
  }
  const byId = id => layers.find(l => l.id === id);
  function claim() { if (auto) { auto = false; } }
  function setPath(obj, path, v) { const p = path.split('.'); let o = obj; while (p.length > 1) o = o[p.shift()] || (o[p[0]] = {}); o[p[0]] = v; }
  function valueOf(t) { return t.type === 'checkbox' ? t.checked : t.type === 'range' ? +t.value : t.value; }
  function applyInput(t, final) {
    if (t.dataset.g) {
      const k = t.dataset.g, v = valueOf(t); G[k] = v; claim(); persist();
      if (k === 'rot' || k === 'rs') { tick(); if (k === 'rot') renderPanel(); return; }
      if (k === 'tg') { rebuild(); renderPanel(); return; }
      if (k === 'tm' || k === 'tn' || k === 'tsp' || k === 'tloop') { applyTime(); redraw(); updateTL(); if (k === 'tm') renderPanel(); return; }
      if (k === 'sv') { applyFit(); flat.reset(); globe.reset(); homed = true; renderPanel(); redraw(); return; }
      if (k === 'map') { applyMap(); renderPanel(); } else if (k === 'style' || k === 'base') { applyStyle(); redraw(); } else { rebuild(); renderPanel(); }
      return;
    }
    const L = byId(t.dataset.l); if (!L) return; claim();
    let v = valueOf(t); if (t.dataset.k === 'st.top') v = +v;
    setPath(L, t.dataset.k, v); persist();
    if (t.type === 'range') { redraw(); tick(); return; }
    if (t.dataset.k === 'on' || t.dataset.k.startsWith('st.') && !['st.ramp', 'st.dramp', 'st.color'].includes(t.dataset.k) && t.dataset.k !== 'st.top') { /* draw-time options */ }
    rebuild(); if (['type', 'lv', 'sheet', 'f.time'].includes(t.dataset.k)) renderPanel();
  }
  pbody.addEventListener('input', e => { if (e.target.type === 'range' || e.target.type === 'color') applyInput(e.target); });
  pbody.addEventListener('change', e => { if (e.target.type !== 'range' && e.target.type !== 'color') applyInput(e.target); });
  pbody.addEventListener('toggle', e => { const d = e.target; if (d.dataset && d.dataset.id) { d.open ? openIds.add(d.dataset.id) : openIds.delete(d.dataset.id); } }, true);
  pbody.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]'); if (!b) return; e.preventDefault(); e.stopPropagation();
    if (b.dataset.act === 'setview') {
      const v = active(), lon = v === flat ? toLon(flat.cx) : globe.lon, lat = v === flat ? toLat(flat.cy) : globe.lat;
      const span = v === flat ? Math.min(flat.W, flat.H) * 360 / (flat.S0 * flat.z) : 57.3 / (0.45 * globe.k);
      G.fixed = { lon, lat, span }; G.sv = 'fixed'; claim(); persist(); applyFit(); flat.reset(); globe.reset(); redraw(); renderPanel(); return;
    }
    if (b.dataset.act === 'reload') {          // settings live in the workbook, so they come back after the page reloads
      b.disabled = true; b.textContent = 'Saving settings…'; clearTimeout(saveT); if (!auto) writeSettings();
      const urls = [location.href.split('#')[0], ...[...document.querySelectorAll('script[src],link[rel=stylesheet][href]')].map(e => e.src || e.href).filter(u => u.startsWith(location.origin))];
      TX.settings.save().then(() => { b.textContent = 'Fetching latest…'; return Promise.all(urls.map(u => fetch(u, { cache: 'reload' }).catch(() => null))); }).then(() => { b.disabled = false; b.textContent = 'Save & fetch latest'; show('<b>Settings saved and latest files downloaded</b><br>Now reload the extension with Tableau\'s own Reload (the dashboard object\'s menu).'); })      // reload only once the settings are safely saved in the workbook
        .catch(err => { b.disabled = false; b.textContent = 'Save & fetch latest'; show('<b>Not saved: your settings could not be saved</b><br>' + esc(String(err && err.message || err)) + '<br>Save the workbook and try again.'); });
      return;
    }
    if (b.dataset.act === 'toggle') { const d = b.closest('details'); d.open = !d.open; return; }
    claim(); const act = b.dataset.act, i = layers.findIndex(l => l.id === b.dataset.l);
    if (act === 'add') { const L = newLayer($('addType').value); if (DASH) L.sheet = Object.keys(D.sheets)[0] || ''; layers.push(L); openIds.add(L.id); }
    else if (act === 'del' && i >= 0) { const L = layers[i]; if (DASH && L.sheet && !G.dismissed.includes('auto-' + L.sheet)) G.dismissed.push('auto-' + L.sheet); layers.splice(i, 1); }      // remember a removed sheet's layer so it is not added back
    else if (act === 'up' && i >= 0 && i < layers.length - 1) [layers[i], layers[i + 1]] = [layers[i + 1], layers[i]];
    else if (act === 'down' && i > 0) [layers[i], layers[i - 1]] = [layers[i - 1], layers[i]];
    else if (act === 'clearcolor' && i >= 0) layers[i].st.color = '';
    else if (act === 'transparent' && i >= 0) layers[i].st.color = 'transparent';
    else if (act === 'clearocolor' && i >= 0) layers[i].st.ocolor = '';
    persist(); rebuild(); renderPanel();
  });
  pbody.addEventListener('pointerdown', e => e.stopPropagation());

  // ================= demo (outside Tableau): a union of three tables =================
  async function demoLoader() {
    if (new URLSearchParams(location.search).get('data') === 'ne') {      // the Natural Earth countries as a plain spatial table
      const only = new URLSearchParams(location.search).get('only');      // e.g. only=Australia,New Zealand to test a regional view
      const rows = (await TX.fetchCSV('../data/ne_110m_countries.csv')).filter(r => !only || only.split(',').includes(r.Admin)).map(r => ({ Admin: TX.cell(r.Admin), Continent: TX.cell(r.Continent), 'SUM(Population)': TX.cell(Number(r.Population), fmt(Number(r.Population))), 'COLLECT(Geometry)': { value: r.Geometry, formattedValue: 'Polygon' } }));
      return { rows, cols: [{ name: 'Admin', dataType: 'string' }, { name: 'Continent', dataType: 'string' }, { name: 'SUM(Population)', dataType: 'float' }, { name: 'COLLECT(Geometry)', dataType: 'spatial' }],
        enc: { location: [{ name: 'Admin' }], color: [{ name: 'Continent' }] } };
    }
    const NULL = { value: null, nativeValue: null, formattedValue: 'Null' }, rows = [];
    const keys = ['Layer', 'Admin', 'COLLECT(Geometry)', 'SUM(Score)', 'Peak', 'Longitude', 'Latitude', 'SUM(Altitude)', 'Origin City', 'Origin Longitude', 'Origin Latitude', 'Destination City', 'Destination Longitude', 'Destination Latitude', 'Destination Region', 'SUM(Flights)', 'Year'];
    const mk = o => { const r = {}; keys.forEach(k => { r[k] = o[k] === undefined ? NULL : o[k]; }); return r; };
    const hash = s => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 100; };
    for (const c of window.WORLD) {
      const polys = c.r.map(r => { const pts = []; for (let i = 0; i < r.length; i += 2) pts.push((r[i] / 20) + ' ' + (r[i + 1] / 20)); pts.push(pts[0]); return '((' + pts.join(', ') + '))'; });
      const s = hash(c.n);
      rows.push(mk({ Layer: TX.cell('Countries'), Admin: TX.cell(c.n), 'COLLECT(Geometry)': { value: "GEOGRAPHY('MULTIPOLYGON(" + polys.join(',') + ")')", formattedValue: 'MultiPolygon' }, 'SUM(Score)': TX.cell(s) }));
    }
    (await TX.fetchCSV('../data/mountains.csv')).filter(r => Number(r.Altitude) >= 3500).forEach(r => rows.push(mk({ Layer: TX.cell('Peaks'), Peak: TX.cell(r.Peak), Longitude: TX.cell(Number(r.Longitude)), Latitude: TX.cell(Number(r.Latitude)), 'SUM(Altitude)': TX.cell(Number(r.Altitude), fmt(Number(r.Altitude))) })));
    const agg = new Map();
    (await TX.fetchCSV('../data/australia_flights.csv')).filter(r => Number(r.Year) >= 2017).forEach(r => { const k = r['Origin City'] + '|' + r['Destination City'] + '|' + r.Year; const a = agg.get(k) || { r, n: 0 }; a.n += Number(r.Flights); agg.set(k, a); });
    agg.forEach(({ r, n }) => rows.push(mk({ Year: { value: new Date(Number(r.Year), 0, 1), formattedValue: r.Year }, Layer: TX.cell('Flights'), 'Origin City': TX.cell(r['Origin City']), 'Origin Longitude': TX.cell(Number(r['Origin Longitude'])), 'Origin Latitude': TX.cell(Number(r['Origin Latitude'])),
      'Destination City': TX.cell(r['Destination City']), 'Destination Longitude': TX.cell(Number(r['Destination Longitude'])), 'Destination Latitude': TX.cell(Number(r['Destination Latitude'])), 'Destination Region': TX.cell(r['Destination Region']), 'SUM(Flights)': TX.cell(n, fmt(n)) })));
    const cols = keys.map(k => ({ name: k, dataType: k === 'COLLECT(Geometry)' ? 'spatial' : k === 'Year' ? 'date' : /Score|Altitude|Flights|Longitude|Latitude/.test(k) ? 'float' : 'string' }));
    if (DASH) {          // one sheet per source table, each with only its own columns (like separate worksheets)
      const sheets = {};
      for (const name of ['Countries', 'Peaks', 'Flights']) {
        const mine = rows.filter(r => str(r.Layer) === name), cs = cols.filter(c => c.name !== 'Layer' && mine.some(r => !isNull(r[c.name])));
        sheets[name] = { cols: cs.slice().sort((x, y) => x.name.localeCompare(y.name)), rows: mine.map(r => Object.fromEntries(cs.map(c => [c.name, r[c.name]]))) };
      }
      return { sheets };
    }
    const L = (type, name, lv, f, st) => { const l = newLayer(type, name, 'demo-' + type); l.lv = lv; l.f = f; Object.assign(l.st, st || {}); return l; };
    const q = new URLSearchParams(location.search), only = q.get('layers');
    let preset = [
      L('shapes', 'Countries', 'Countries', { geom: 'COLLECT(Geometry)', name: 'Admin', color: 'SUM(Score)' }, { ramp: 'blues', labels: true }),
      L('symbols', 'Peaks', 'Peaks', { lon: 'Longitude', lat: 'Latitude', name: 'Peak', size: 'SUM(Altitude)', color: 'SUM(Altitude)' }, { ramp: 'div', shape: 'triangle' }),
      L('arcs', 'Flights from Australia', 'Flights', { oname: 'Origin City', olon: 'Origin Longitude', olat: 'Origin Latitude', dname: 'Destination City', dlon: 'Destination Longitude', dlat: 'Destination Latitude', width: 'SUM(Flights)', color: 'Destination Region' }, { top: 100 })
    ];
    if (only) preset = preset.filter(l => only.split(',').includes(l.type));
    return { rows, cols, enc: {}, preset, layerField: 'Layer' };
  }

  // ================= go =================
  applyStyle(); applyMap();
  if (!TX.demo) {
    show('Connecting to Tableau…');
    const t0 = Date.now(), wd = setInterval(() => { if (loaded) { clearInterval(wd); return; } if (Date.now() - t0 > 6000) show('<b>Still waiting for Tableau</b><br>Stage: ' + esc(TX.stage.s) + ' (' + Math.round((Date.now() - TX.stage.at) / 1000) + ' s). If this stays, Tableau did not reconnect the extension after the reload: close and reopen the workbook, or use the extension\'s own Reload in Tableau.'); }, 1000);
  }
  (DASH ? TX.startDashboard : TX.start)(onData, demoLoader);
})();
