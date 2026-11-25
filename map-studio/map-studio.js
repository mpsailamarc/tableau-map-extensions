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
  const TYPES = { shapes: 'Shapes (geometry)', symbols: 'Symbols', density: 'Density (heat map)', bars: '3D bars', hexbin: 'Hex bins', tracks: 'Tracks (paths over time)', pies: 'Pie charts', arcs: 'Flow arcs', cartogram: 'Cartogram (area by a measure)' };
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
  const G = { map: 'flat', style: 'dark', base: true, lf: '', sv: 'fit', fixed: null, rot: false, rs: 6, tm: 'period', tn: 3, tall: null, tg: 'exact', tsp: 1.5, tloop: true, fade: false, fn: 4, dismissed: [] };    // global options; lf = the "layer column", sv = start view (fit | world | fixed)
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
  const dateCut = n => !/^(YEAR|QUARTER|MONTH|WEEK|DAY|HOUR)\(/i.test(n);          // YEAR(Date) is a number but is not a measure to size by
  const bestMeasure = list => list.find(n => isMeasure(n) && dateCut(n)) || list.find(dateCut) || null;
  const yearCol = cx => { const c = cx.cols.find(c => (c.dataType === 'int' || c.dataType === 'date' || c.dataType === 'date-time' || c.dataType === 'float') && /^(attr\()?year\(|^year$/i.test(c.name)); return c ? c.name : null; };
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
    else if (T.idx < 0 && noAll()) T.idx = T.steps.length - 1;          // unless "All dates" is allowed in the layer settings, a cartogram always shows one date: start on the latest
  }
  // The "All dates" button is a setting for every map type (Time line, in the panel). It is off by default: the map always shows one date, starting on the latest.
  const allowAll = () => G.tall === true, noAll = () => !allowAll();
  function fadeOf(it) {          // how solid an older mark still is: 1 for the current step, down to nearly clear after the fade length
    if (!G.fade || it.t == null || T.idx < 0) return 1;
    const age = T.idx - (T.index.get(it.t) || 0); if (age <= 0) return 1;
    return Math.max(0.06, 1 - age / Math.max(1, G.tm === 'trail' ? Math.min(G.fn, G.tn) : G.fn));
  }
  function timeVisible(it) {
    if (it.t == null) return true;
    const i = T.index.get(it.t), cur = T.idx;
    return G.tm === 'cum' ? i <= cur : G.tm === 'trail' ? (i <= cur && i > cur - G.tn) : i === cur;
  }
  function applyTime() {
    const on = T.steps.length > 1 && T.idx >= 0;
    for (const m of models) {
      if (m.L.type === 'cartogram' && m.f.time && T.steps.length > 1) {          // a cartogram shows one date at a time; "All dates" (if allowed) adds the dates up
        if (T.idx < 0 && allowAll() && m.agg) m.items = m.agg;
        else { const cur = T.idx >= 0 ? T.steps[T.idx] : T.steps[T.steps.length - 1]; m.items = m.base.filter(it => it.t == null || it.t === cur); }
      }
      else m.items = on && m.f.time ? m.base.filter(timeVisible) : m.base;
    }
    for (const m of models) if (m.L.type === 'cartogram') cartoLayout(m);
    updateNote();
  }
  let refreshInfo = '';
  const hms = () => new Date().toTimeString().slice(0, 8);
  TX.params.onChange = () => { if (loaded) { renderPanel(); redraw(); } };
  TX.onRefresh = (ph, i) => { refreshInfo = ph === 'start' ? ' · updating from Tableau… (' + hms() + ')' : ph === 'read' ? ' · read ' + fmt(i.rows) + ' rows in ' + i.s.toFixed(1) + ' s, drawing…' : refreshInfo.replace(/, drawing…$/, '') + ', done at ' + hms() + ' (' + i.s.toFixed(1) + ' s in all)'; updateNote(); };
  function updateNote() {
    note.textContent = models.map(m => m.L.on ? m.L.name + ' ' + fmt(m.items.length) + (m.items.length !== m.base.length ? ' of ' + fmt(m.base.length) : '') + (m.skipped ? ' (' + m.skipped + ' skipped)' : '') + (m.L.type === 'cartogram' && m.zsz < 0.98 ? ' (zoomed in: shapes drawn at ' + Math.round(m.zsz * 100) + '% of map scale, dashed = true size)' : '') : '').filter(Boolean).join(' · ') + refreshInfo;
  }

  // ================= layers =================
  let uid = 0;
  function newLayer(type, name, id) {
    return { id: id || 'L' + Date.now().toString(36) + (uid++), name: name || TYPES[type], type, on: true, lv: '', f: {},
      st: { color: '', ramp: type === 'arcs' ? 'heat' : type === 'hexbin' ? 'div' : 'blues', alpha: type === 'cartogram' ? 0.92 : 0.8, outline: true, shape: 'circle', size: 1, lw: 1, curve: 0.22, arrows: false, anim: false, top: 0, labels: false, ocolor: '', dramp: 'fire', radius: 1, intensity: 1, bw: 1, bh: 1, hex: 3, agg: 'count', log: true, bagg: 'sum', head: true, cmorph: 1, csep: true, cghost: true, cdrop: true, cdecl: true, cshape: 'outline', cdisc: true, cmode: 'fit', cscl: 1 } };
  }
  // Dashboard mode has no Marks card tiles, so defaults are guessed from the names and types of a sheet's columns.
  function guess(cx) {
    const C = cx.cols, names = C.map(c => c.name), nonSp = C.filter(c => c.dataType !== 'spatial');
    const lonC = names.filter(isLon), latC = names.filter(isLat);
    const oRe = /orig|from|source|depart/i, dRe = /dest|(^|[^a-z])to([^a-z]|$)|target|arriv/i;
    const oCols = nonSp.map(c => c.name).filter(n => oRe.test(n)), dCols = nonSp.map(c => c.name).filter(n => dRe.test(n) && !oCols.includes(n));
    const og = classify(oCols), dg = classify(dCols);
    const used = new Set([...oCols, ...dCols]);
    const meas = C.filter(c => isNumCol(c) && !isLon(c.name) && !isLat(c.name)).map(c => c.name).sort((a, b) => (isMeasure(a) && dateCut(a) ? 0 : dateCut(a) ? 1 : 2) - (isMeasure(b) && dateCut(b) ? 0 : dateCut(b) ? 1 : 2));          // aggregated measures first, YEAR(...) last
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
        case 'cartogram': return { lon: pick('lon', g.lon), lat: pick('lat', g.lat), geom: pick('geom', g.spatial[0]), name: pick('name', g.plain[0]), color: pick('color', g.plain[1] || null), size: pick('size', bestMeasure(g.meas)), time: pick('time', g.date[0] || yearCol(cx)) };
        case 'symbols': return { lon: pick('lon', g.lon), lat: pick('lat', g.lat), name: pick('name', g.plain[0]), size: pick('size', g.meas[0]), color: pick('color', g.plain[1]), time: pick('time', g.date[0]) };
        case 'density': return { lon: pick('lon', g.lon), lat: pick('lat', g.lat), weight: pick('weight', null), time: pick('time', g.date[0]) };
        case 'hexbin': return { lon: pick('lon', g.lon), lat: pick('lat', g.lat), weight: pick('weight', null), time: pick('time', g.date[0]) };
        case 'tracks': return { lon: pick('lon', g.lon), lat: pick('lat', g.lat), group: pick('group', g.plain[0]), width: pick('width', g.meas[0]), color: pick('color', null), time: pick('time', g.date[0]) };
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
      case 'cartogram': return { lon: pick('lon', loc.lon), lat: pick('lat', loc.lat), geom: pick('geom', spatialCols(cx)[0]), name: pick('name', loc.name), color: pick('color', col), size: pick('size', siz), time: pick('time', dateCols(cx)[0] || yearCol(cx)) };
      case 'symbols': return { lon: pick('lon', loc.lon), lat: pick('lat', loc.lat), name: pick('name', loc.name), size: pick('size', siz), color: pick('color', col), time: pick('time', dateCols(cx)[0]) };
      case 'density': return { lon: pick('lon', loc.lon), lat: pick('lat', loc.lat), weight: pick('weight', siz), time: pick('time', dateCols(cx)[0]) };
      case 'hexbin': return { lon: pick('lon', loc.lon), lat: pick('lat', loc.lat), weight: pick('weight', siz), time: pick('time', dateCols(cx)[0]) };
      case 'tracks': return { lon: pick('lon', loc.lon), lat: pick('lat', loc.lat), group: pick('group', col), width: pick('width', siz), color: pick('color', col), time: pick('time', dateCols(cx)[0]) };
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
  // the area the data covers; longitudes are also tracked on a 0..360 scale, so data around the date line (Fiji, Samoa, Alaska + Russia) gets a small box instead of the whole world
  const stackExt = (m, lon, lat) => { const e = m.ext || (m.ext = { a: 180, b: -180, c: 90, d: -90, a2: 540, b2: -180 }), w = lon < 0 ? lon + 360 : lon; e.a = Math.min(e.a, lon); e.b = Math.max(e.b, lon); e.c = Math.min(e.c, lat); e.d = Math.max(e.d, lat); e.a2 = Math.min(e.a2, w); e.b2 = Math.max(e.b2, w); };

  // ================= build one layer =================
  function build(L) {
    const m = { L, f: fieldsOf(L), cols: ctxOf(L).cols, items: [], skipped: 0, leg: [], ext: null, msg: '' };
    if (DASH && !D.sheets[L.sheet]) { m.msg = 'choose which sheet feeds this layer'; m.base = m.items; return m; }
    try {
      ({ shapes: buildShapes, symbols: buildSymbols, density: buildDensity, bars: buildBars, hexbin: buildHex, tracks: buildTracks, pies: buildPies, arcs: buildArcs, cartogram: buildCartogram })[L.type](m, rowsFor(L));
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

  // ================= layer: cartogram (every shape is resized so that its AREA follows a measure) =================
  // Each region keeps its real position and shape; it is scaled about its own centre so that area is proportional to the measure. With the whole
  // data set in view the total area stays the same as on the real map, so a region only grows or shrinks relative to the others. Islands and
  // other separate pieces stay at their true offsets and are scaled about their own centres. Overlaps are then eased apart along the
  // direction between the regions' real positions, so neighbours keep their compass bearing. The real outlines can stay visible (dashed).
  const KM_DEG = 111.195, R_KM = 6371, CDROP_DEG = 50;
  const carInfo = new WeakMap();
  function ringKm2(r) { let a = 0; const n = r.length / 2; for (let i = 0; i < n - 1; i++) a += (r[2 * i + 2] - r[2 * i]) * D2R * (2 + Math.sin(r[2 * i + 1] * D2R) + Math.sin(r[2 * i + 3] * D2R)); return Math.abs(a) * R_KM * R_KM / 2; }
  function ringCen(r) { let A = 0, cx = 0, cy = 0; const n = r.length / 2; for (let i = 0; i < n - 1; i++) { const x0 = r[2 * i], y0 = r[2 * i + 1], x1 = r[2 * i + 2], y1 = r[2 * i + 3], k = x0 * y1 - x1 * y0; A += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k; } return Math.abs(A) < 1e-12 ? { x: r[0], y: r[1] } : { x: cx / (3 * A), y: cy / (3 * A) }; }
  const angDeg = (lo1, la1, lo2, la2) => Math.acos(Math.max(-1, Math.min(1, Math.sin(la1 * D2R) * Math.sin(la2 * D2R) + Math.cos(la1 * D2R) * Math.cos(la2 * D2R) * Math.cos((lo2 - lo1) * D2R)))) / D2R;
  function cartoInfo(g, drop) {          // per geometry (cached): its pieces, true area, home point, and the pieces that count (remote ones can be left out)
    let per = carInfo.get(g); if (!per) carInfo.set(g, per = new Map());
    let I = per.get(drop); if (I) return I;
    const all = g.polys.map(p => { let a = ringKm2(p.rings[0]); for (let i = 1; i < p.rings.length; i++) a -= ringKm2(p.rings[i]); const c = ringCen(p.rings[0]); return { p, a: Math.max(a, 0), cx: c.x, cy: c.y }; });
    let main = all[0]; for (const q of all) if (q.a > main.a) main = q;
    const keep = all.filter(q => q === main || drop > 180 || angDeg(main.cx, main.cy, q.cx, q.cy) <= drop);
    const bb = [Infinity, Infinity, -Infinity, -Infinity]; keep.forEach(q => { const b = q.p.bbox; bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]); bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]); });
    const cl = Math.max(0.15, Math.cos(main.cy * D2R));
    I = { keep, A: keep.reduce((a, q) => a + q.a, 0), hx: main.cx, hy: main.cy, mb: main.p.bbox, half: Math.hypot((main.p.bbox[2] - main.p.bbox[0]) * cl, main.p.bbox[3] - main.p.bbox[1]) / 2, bb, gk: { polys: keep.map(q => q.p), lines: [], pts: [], bbox: bb, lab: [main.cx, main.cy] } };
    per.set(drop, I); return I;
  }
  // No spatial field? Then the layer uses the extension's built-in country outlines, matched by country name or ISO3 code.
  const nrm = x => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  const PLACE_ALIAS = { turkiye: 'Turkey', bahamasthe: 'Bahamas', gambiathe: 'Gambia', congokinshasa: 'Dem. Rep. Congo', congobrazzaville: 'Congo', fijiislands: 'Fiji', southsudan: 'S. Sudan', equatorialguinea: 'Eq. Guinea', bosniaandherzegovina: 'Bosnia and Herz.', centralafricanrepublic: 'Central African Rep.', dominicanrepublic: 'Dominican Rep.', swaziland: 'eSwatini', macedonia: 'North Macedonia', burma: 'Myanmar', laopdr: 'Laos', republicofkorea: 'South Korea', russianfederation: 'Russia' };
  const placeCountry = name => findCountry(name) || (PLACE_ALIAS[nrm(name)] ? findCountry(PLACE_ALIAS[nrm(name)]) : null);
  const PLACE_XY = {americansamoa:[-170.7,-14.3],andorra:[1.5,42.5],antiguaandbarbuda:[-61.8,17.1],aruba:[-70.0,12.5],bahrain:[50.5,26.0],barbados:[-59.5,13.2],bermuda:[-64.8,32.3],bruneidarussalam:[114.7,4.5],caboverde:[-23.6,15.1],capeverde:[-23.6,15.1],caymanislands:[-81.2,19.3],comoros:[43.3,-11.7],curacao:[-69.0,12.2],dominica:[-61.4,15.4],faroeislands:[-6.9,62.0],frenchpolynesia:[-149.4,-17.7],grenada:[-61.7,12.1],guam:[144.8,13.4],hongkong:[114.2,22.3],hongkongsarchina:[114.2,22.3],isleofman:[-4.5,54.2],kiribati:[173.0,1.4],liechtenstein:[9.55,47.1],macaosarchina:[113.5,22.2],macau:[113.5,22.2],maldives:[73.2,3.2],malta:[14.4,35.9],marshallislands:[171.0,7.1],mauritius:[57.6,-20.3],micronesia:[158.2,6.9],micronesiafedsts:[158.2,6.9],monaco:[7.4,43.7],saintkittsandnevis:[-62.7,17.3],saintlucia:[-61,13.9],saintmartin:[-63,18.08],saintvincentandthegrenadines:[-61.2,13.2],samoa:[-172.4,-13.7],sanmarino:[12.45,43.9],saotomeandprincipe:[6.6,0.2],seychelles:[55.5,-4.7],singapore:[103.8,1.35],sintmaarten:[-63.05,18.05],sintmaartendutchpart:[-63.05,18.05],solomonislands:[160.0,-9.6],stkittsandnevis:[-62.7,17.3],stlucia:[-61.0,13.9],stmartinfrenchpart:[-63.0,18.08],stvincentandthegrenadines:[-61.2,13.2],tonga:[-175.0,-20.0],turksandcaicos:[-71.8,21.7],turksandcaicosislands:[-71.8,21.7]};          // centres of small countries and territories that the built-in outlines leave out (lon, lat)
  const placeXY = nm => PLACE_XY[nrm(nm)] || (() => { const q = window.PLACES && window.PLACES.find(p => String(p[0]).toLowerCase() === String(nm).toLowerCase()); return q ? [q[1], q[2]] : null; })();
  const worldGeoms = new Map();
  function placeGeom(c) {
    let g = worldGeoms.get(c.n); if (g) return g;
    const w = window.WORLD && window.WORLD.find(x => x.n === c.n); if (!w) return null;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    const polys = w.r.map(r => {
      const n = r.length / 2, closed = r[0] === r[2 * n - 2] && r[1] === r[2 * n - 1], a = new Float64Array((n + (closed ? 0 : 1)) * 2);
      for (let i = 0; i < r.length; i++) a[i] = r[i] / 20; if (!closed) { a[2 * n] = a[0]; a[2 * n + 1] = a[1]; }
      const pb = [Infinity, Infinity, -Infinity, -Infinity]; for (let i = 0; i < a.length; i += 2) { pb[0] = Math.min(pb[0], a[i]); pb[2] = Math.max(pb[2], a[i]); pb[1] = Math.min(pb[1], a[i + 1]); pb[3] = Math.max(pb[3], a[i + 1]); }
      bb[0] = Math.min(bb[0], pb[0]); bb[1] = Math.min(bb[1], pb[1]); bb[2] = Math.max(bb[2], pb[2]); bb[3] = Math.max(bb[3], pb[3]);
      return { rings: [a], bbox: pb };
    });
    g = { polys, lines: [], pts: [], bbox: bb, lab: c.c.slice() }; worldGeoms.set(c.n, g); return g;
  }
  const A_DOT = 80;          // km²: a nominal "real size" for a place that is only a dot on the real map
  const discInfo = (lon, lat) => { const b = [lon - 0.5, lat - 0.5, lon + 0.5, lat + 0.5]; return { keep: [], A: A_DOT, hx: lon, hy: lat, half: 0, bb: b, disc: true, gk: { polys: [], lines: [], pts: [], bbox: b, lab: [lon, lat] } }; };
  function buildCartogram(m, rows) {
    const f = m.f, byName = !f.geom, st = m.L.st;          // no spatial field: use the built-in country outlines, matched by name
    if (byName && !f.name && !(f.lon && f.lat)) { m.msg = 'put a spatial field on Detail, or a country name on Location (the built-in country outlines are then used)'; return; }
    if (!f.size) { m.msg = 'choose the measure that sets each shape\'s area (Size)'; return; }
    const drop = st.cdrop === false ? 999 : CDROP_DEG, seen = new Map();
    for (const r of rows) {
      let g = null, info = null, key = null;
      if (byName) {
        const nm = f.name && !isNull(r[f.name]) ? str(r[f.name]) : '', c = nm ? placeCountry(nm) : null;
        if (c) { g = placeGeom(c); key = c.n; }
        if (!g) {          // no outline for this place: a circle, if we know where it is
          if (st.cdisc === false) { m.skipped++; continue; }
          let lon = f.lon ? num(r[f.lon]) : null, lat = f.lat ? num(r[f.lat]) : null;
          if (lon == null || lat == null) { const q = nm ? placeXY(nm) : null; if (!q) { m.skipped++; continue; } lon = q[0]; lat = q[1]; }
          info = discInfo(lon, lat); key = 'xy:' + nm.toLowerCase() + '|' + lon.toFixed(2) + ',' + lat.toFixed(2);
        }
      } else {
        const v = raw(r[f.geom]); if (v == null) continue;
        g = WKT.parse(v); if (!g || !g.polys.length) { m.skipped++; continue; }
      }
      const s = num(r[f.size]); if (s == null || s <= 0) { m.skipped++; continue; }
      if (key && !f.time && seen.has(key)) { seen.get(key).s += s; continue; }          // several rows for one place and no time field: they are added up
      if (!info) info = cartoInfo(g, drop); if (!(info.A > 0)) { m.skipped++; continue; }
      const it = { row: r, g: g || info.gk, info, name: f.name ? str(r[f.name]) : '', s, t0: f.time ? tsOf(r[f.time]) : null, akey: key || String(raw(r[f.geom])) };
      m.items.push(it); if (key && !f.time) seen.set(key, it);
      stackExt(m, info.bb[0], info.bb[1]); stackExt(m, info.bb[2], info.bb[3]);
    }
    if (f.time) { const ag = new Map(); for (const it of m.items) { const a = ag.get(it.akey); if (a) a.s += it.s; else ag.set(it.akey, { ...it, t0: null, t: null }); } m.agg = [...ag.values()]; }          // all dates added up, for the "All dates" option
    const lg = colorize(m.items, i => i.row[f.color], f.color, st); if (lg) m.leg.push(lg);
    m.leg.push({ title: f.size, size: maxOf(1e-9, m.items, i => i.s), min: minOfPos(m.items, i => i.s), circles: true, area: true });
  }
  const merDeg = lat => Math.log(Math.tan(Math.PI / 4 + Math.max(-84, Math.min(84, lat)) * D2R / 2)) / D2R;          // Mercator northing, in degrees
  const invMer = y => (2 * Math.atan(Math.exp(y * D2R)) - Math.PI / 2) / D2R;
  function cartoLayout(m) {          // runs whenever the shown rows change (a new time step, a filter), the morph slider moves, the map is zoomed, or flat <-> globe is switched
    const st = m.L.st, t = st.cmorph == null ? 1 : st.cmorph, its = m.items, N = its.length; if (!N) return;
    const flatV = G.map !== 'globe', circles = st.cshape === 'circle', sep = st.csep !== false && N <= 900 && t > 0.02; m.view = G.map;          // at morph 0% it is the real map: nothing moves
    its.sort((a, b) => b.s - a.s);          // big first, small on top
    // On the flat (Mercator) map a shape at latitude L is drawn 1/cos^2(L) times too large, so sizes are worked out in what is SEEN. The globe has no such distortion.
    const sec2 = lat => { if (!flatV) return 1; const c = Math.cos(Math.min(Math.abs(lat), 78) * D2R); return 1 / (c * c); };
    const Ae = its.map(it => it.info.A * sec2(it.info.hy));
    let sA = 0, sV = 0, sAll = 0, bi = -1, Knone = Infinity; its.forEach((it, i) => { sAll += it.s; if (!it.info.disc) { sA += Ae[i]; sV += it.s; if (bi < 0 || it.s > its[bi].s) bi = i; Knone = Math.min(Knone, Ae[i] / it.s); } });
    const zr = zoomRel(), szt = st.cdecl !== false && zr > 1 ? Math.pow(Math.pow(zr, -0.5), t) : 1; m.zr = zr; m.zsz = szt;          // semantic zoom: zoomed in, shapes grow only with the square root of the zoom
    const hx = new Float64Array(N), hy = new Float64Array(N), px = new Float64Array(N), py = new Float64Array(N), rc = new Float64Array(N), rq = new Float64Array(N), fe = new Float64Array(N), fb = new Float64Array(N), hf = new Float64Array(N), isD = new Uint8Array(N);
    its.forEach((it, i) => {          // flat map: Mercator coordinates; globe: sinusoidal (equal-area) coordinates; both in degrees
      const I = it.info; isD[i] = circles || I.disc ? 1 : 0;
      hf[i] = I.disc ? 0 : flatV ? Math.hypot(I.mb[2] - I.mb[0], merDeg(I.mb[3]) - merDeg(I.mb[1])) / 2 : I.half;          // extent of the MAIN land mass: Alaska, Svalbard and the like do not inflate a country's room
      if (flatV) { hx[i] = I.hx; hy[i] = merDeg(I.hy); } else { hx[i] = I.hx * Math.max(0.15, Math.cos(I.hy * D2R)); hy[i] = I.hy; }
    });
    const fitMode = (st.cmode || 'fit') === 'fit', tolOf = (i, j) => (rc[i] + rc[j]) * (isD[i] || isD[j] ? 1.02 : fitMode ? 1.0 : 0.8);          // fit mode keeps the shapes' circles clear of each other
    function place(K, sz, steps, passes) {          // size every shape for this scale and ease overlaps apart; returns how much overlap is left (average per shape)
      for (let i = 0; i < N; i++) {
        fb[i] = Math.pow(Math.sqrt(K * its[i].s / Ae[i]), t); fe[i] = fb[i] * sz;
        const req = Math.sqrt(Ae[i] * fe[i] * fe[i] / Math.PI) / KM_DEG; let r = req;
        if (!isD[i]) { const cr = req > 0 ? hf[i] * fe[i] / req : 1; r = req * (1 + (Math.min(Math.max(cr, 1), 2.2) - 1) * 0.25); }
        rc[i] = r; rq[i] = req; px[i] = hx[i]; py[i] = hy[i];
      }
      if (!sep) return 0;
      for (let step = 0; step < steps; step++) {
        if (step) for (let i = 0; i < N; i++) { px[i] += (hx[i] - px[i]) * 0.1; py[i] += (hy[i] - py[i]) * 0.1; }
        for (let pass = 0; pass < passes; pass++) for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
          const dx = px[j] - px[i], dy = py[j] - py[i], d = Math.hypot(dx, dy) || 1e-6, min = tolOf(i, j);
          if (d >= min) continue;
          let ux = hx[j] - hx[i], uy = hy[j] - hy[i]; const ul = Math.hypot(ux, uy);          // push along the REAL bearing between the two
          if (ul < 1e-3) { ux = dx / d; uy = dy / d; } else { ux /= ul; uy /= ul; }
          const o = (min - d) * 0.9, wi = rc[j] * rc[j] / (rc[i] * rc[i] + rc[j] * rc[j]), wj = 1 - wi;
          px[i] -= ux * o * wi; py[i] -= uy * o * wi; px[j] += ux * o * wj; py[j] += uy * o * wj;
        }
      }
      let res = 0; for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { const min = tolOf(i, j), d = Math.hypot(px[j] - px[i], py[j] - py[i]); if (d < min) res += 1 - d / min; }
      return res / N;
    }
    function turned() {          // share of neighbouring pairs whose direction from one to the other changed by more than about 45 degrees (Portugal ending up north of Spain)
      let n = 0, bad = 0;
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
        const ux = hx[j] - hx[i], uy = hy[j] - hy[i], d0 = Math.hypot(ux, uy); if (d0 < 1e-3 || d0 > 2.5 * (rc[i] + rc[j])) continue;
        n++; const vx = px[j] - px[i], vy = py[j] - py[i], d1 = Math.hypot(vx, vy) || 1e-6; if ((ux * vx + uy * vy) / (d0 * d1) < 0.7) bad++;
      }
      return n ? bad / n : 0;
    }
    // The overall scale (area per unit of the measure). Places that are only dots never set it.
    //   fit   : the largest scale at which the shapes fit without overlapping AND stay on their real compass bearings, never above "big" (default)
    //   big   : the biggest shape (largest measure) is drawn at exactly its real size
    //   none  : no shape is ever larger than its real size (the strictest)
    //   total : all shapes together keep the real total area
    const anc = st.cmode || 'fit'; let K = 0;
    if (sV > 0) {
      const Kbig = Ae[bi] / its[bi].s;
      if (anc === 'total') K = sA / sV; else if (anc === 'none') K = Knone; else K = Kbig;
      if (anc === 'fit' && sep) {          // search (by halving) for the biggest scale that leaves no overlap; remembered until the data or the view changes
        const key = [N, Math.round(sV), t, flatV, circles].join('|');
        if (m.kfit && m.kfit.key === key) K = m.kfit.K;
        else {
          const ok = k => place(k, 1, 24, 2) <= 0.02 && turned() <= 0.03;
          if (!ok(Kbig)) { let lo = Kbig / 400, hi = Kbig; for (let it = 0; it < 9; it++) { const mid = Math.sqrt(lo * hi); if (ok(mid)) lo = mid; else hi = mid; } K = lo; }
          m.kfit = { key, K };
        }
      }
    } else if (sAll > 0) K = 2.2e7 / sAll;
    K *= st.cscl == null ? 1 : st.cscl;
    place(K, szt, 60, 4);
    its.forEach((it, i) => {
      const I = it.info, hl = I.hy; let dlon, dlat;
      if (flatV) { dlon = px[i] - hx[i]; dlat = invMer(py[i]) - hl; } else { dlon = (px[i] - hx[i]) / Math.max(0.15, Math.cos(hl * D2R)); dlat = py[i] - hy[i]; }
      dlat = Math.max(-84 - hl, Math.min(84 - hl, dlat));
      const polys = [], bb = [Infinity, Infinity, -Infinity, -Infinity], f = fe[i];
      if (isD[i]) {          // a circle: round on the flat map (conformal Mercator) and round on the globe
        const lonc = I.hx + dlon, latc = hl + dlat, R = rq[i], ring = new Float64Array(74), cl = Math.max(0.15, Math.cos(latc * D2R)), my = merDeg(latc);
        for (let k = 0; k <= 36; k++) { const th = k / 36 * 2 * Math.PI, cs = Math.cos(th), sn = Math.sin(th); ring[2 * k] = flatV ? lonc + R * cs : lonc + R * cs / cl; ring[2 * k + 1] = Math.max(-85, Math.min(85, flatV ? invMer(my + R * sn) : latc + R * sn)); }
        const pb = [Infinity, Infinity, -Infinity, -Infinity]; for (let k = 0; k < 74; k += 2) { pb[0] = Math.min(pb[0], ring[k]); pb[2] = Math.max(pb[2], ring[k]); pb[1] = Math.min(pb[1], ring[k + 1]); pb[3] = Math.max(pb[3], ring[k + 1]); }
        polys.push({ rings: [ring], bbox: pb }); bb[0] = pb[0]; bb[1] = pb[1]; bb[2] = pb[2]; bb[3] = pb[3];
      } else for (const q of I.keep) {
        const rings = q.p.rings.map(r => { const o = new Float64Array(r.length); for (let k = 0; k < r.length; k += 2) { o[k] = q.cx + dlon + (r[k] - q.cx) * f; o[k + 1] = Math.max(-85, Math.min(85, q.cy + dlat + (r[k + 1] - q.cy) * f)); } return o; });
        const pb = [Infinity, Infinity, -Infinity, -Infinity];
        for (const r of rings) for (let k = 0; k < r.length; k += 2) { if (r[k] < pb[0]) pb[0] = r[k]; if (r[k] > pb[2]) pb[2] = r[k]; if (r[k + 1] < pb[1]) pb[1] = r[k + 1]; if (r[k + 1] > pb[3]) pb[3] = r[k + 1]; }
        polys.push({ rings, bbox: pb }); bb[0] = Math.min(bb[0], pb[0]); bb[1] = Math.min(bb[1], pb[1]); bb[2] = Math.max(bb[2], pb[2]); bb[3] = Math.max(bb[3], pb[3]);
      }
      it.g = { polys, lines: [], pts: [], bbox: bb, lab: [I.hx + dlon, hl + dlat] }; it.fe = I.disc ? null : fb[i];
    });
  }
  const zoomRel = () => (G.map === 'globe' ? globe.k / (globe.homeK || 1) : flat.z / (flat.hv ? flat.hv.z : 1));          // zoom relative to the start view
  let zoomTimer = 0;
  function checkZoom() {          // the map or globe was zoomed, or flat <-> globe was switched: lay the cartogram out again (after the wheel pauses)
    if (zoomTimer || !models.length) return; const zr = zoomRel();
    if (!models.some(m => m.L.on && m.L.type === 'cartogram' && m.items.length && (m.view !== G.map || (m.L.st.cdecl !== false && Math.abs(Math.log(zr / (m.zr || 1))) > 0.04)))) return;
    zoomTimer = setTimeout(() => { zoomTimer = 0; for (const m of models) if (m.L.on && m.L.type === 'cartogram') cartoLayout(m); updateNote(); redraw(); }, 90);
  }
  function drawGhostFlat(c, v, m) {          // the real outlines, dashed, under the resized shapes
    const S = v.S0 * v.z, W = v.W, H = v.H; c.save(); c.globalAlpha = 0.75; c.lineWidth = 1; c.setLineDash([3, 3]); c.strokeStyle = G.style === 'dark' ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.5)';
    for (const it of m.items) {
      const F = flatCache(it.info.gk);
      for (const off of [-1, 0, 1]) {
        const x0 = (F.b[0] + off - v.cx) * S + W / 2, x1 = (F.b[2] + off - v.cx) * S + W / 2, y0 = (F.b[1] - v.cy) * S + H / 2, y1 = (F.b[3] - v.cy) * S + H / 2;
        if (x1 < -10 || x0 > W + 10 || y1 < -10 || y0 > H + 10) continue;
        c.beginPath(); F.polys.forEach(r => tracePath(c, r, off, v, S, true)); c.stroke();
      }
    }
    c.restore();
  }
  function drawGhostGlobe(c, g, m) {
    c.save(); c.globalAlpha = 0.75; c.lineWidth = 1; c.setLineDash([3, 3]); c.strokeStyle = G.style === 'dark' ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.5)';
    for (const it of m.items) { c.beginPath(); let any = false; for (const ring of globeCache(it.info.gk).polys) if (g.landPath(c, ring, true)) any = true; if (any) c.stroke(); }
    c.restore();
  }
  function buildSymbols(m, rows) {
    const f = m.f; if (!f.lon || !f.lat) { m.msg = 'choose a longitude and a latitude field'; return; }
    for (const r of rows) {
      const lon = num(r[f.lon]), lat = num(r[f.lat]); if (lon == null || lat == null) continue;
      m.items.push({ row: r, lon, lat, name: f.name ? str(r[f.name]) : '', s: f.size ? num(r[f.size]) : null, t0: f.time ? tsOf(r[f.time]) : null }); stackExt(m, lon, lat);
    }
    m.smax = maxOf(1e-9, m.items, i => i.s || 0);
    const lg = colorize(m.items, i => i.row[f.color], f.color, m.L.st); if (lg) m.leg.push(lg);
    if (f.size) m.leg.push({ title: f.size, size: m.smax, min: minOfPos(m.items, i => i.s), circles: true });
    m.items.sort((a, b) => (b.s || 0) - (a.s || 0));         // big first, small on top
  }
  function buildTracks(m, rows) {
    const f = m.f; if (!f.lon || !f.lat) { m.msg = 'choose a longitude and a latitude field'; return; }
    let i = 0;
    for (const r of rows) {
      const lon = num(r[f.lon]), lat = num(r[f.lat]); if (lon == null || lat == null) continue;
      m.items.push({ row: r, lon, lat, name: f.group ? str(r[f.group]) : m.L.name, w: f.width ? num(r[f.width]) : null, t0: f.time ? tsOf(r[f.time]) : null, i: i++ }); stackExt(m, lon, lat);
    }
    m.items.sort((a, b) => (a.t0 == null || b.t0 == null ? a.i - b.i : a.t0 - b.t0 || a.i - b.i));          // oldest first, so a track is drawn in the order it was travelled
    m.wmax = maxOf(1e-9, m.items, i => i.w || 0);
    const cf = m.L.f.color === '-' ? null : (f.color || f.group), lg = colorize(m.items, i => i.row[cf], cf, m.L.st); if (lg) { if (lg.cat) lg.max = 8; m.leg.push(lg); }          // 8 = how many categories the legend lists. For a colour ramp, max is the top of the scale and must stay as it is else m.leg.push({ swatch: true, title: 'All tracks', col: () => m.L.st.color || STYLE[G.style].dflt });
    // the width sample takes the colour the tracks are really drawn in: the fixed colour, else the colour scale (a mid tone), else grey for categories
    if (f.width) m.leg.push({ title: f.width, size: m.wmax, line: true, col: () => (m.L.st.color && m.L.st.color !== 'transparent' ? m.L.st.color : lg && lg.ramp ? ramp(lg.ramp, 0.7) : lg && lg.cat ? '#9aa3ad' : STYLE[G.style].dflt) });
  }
  function buildHex(m, rows) {
    const f = m.f; if (!f.lon || !f.lat) { m.msg = 'choose a longitude and a latitude field'; return; }
    for (const r of rows) {
      const lon = num(r[f.lon]), lat = num(r[f.lat]); if (lon == null || lat == null || Math.abs(lat) > 90) continue;
      const w = f.weight ? num(r[f.weight]) : null;
      m.items.push({ lon, lat, w, t0: f.time ? tsOf(r[f.time]) : null }); stackExt(m, lon, lat);
    }
    m.hexLg = { title: '', ramp: (RAMPS[m.L.st.ramp] || RAMPS.div)[1], min: 0, max: 1 }; m.leg.push(m.hexLg);
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
    if (f.value) m.leg.push({ title: f.value, size: m.pmax, min: minOfPos(m.items, p => p.n), circles: true });
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
      symPath(c, st.shape, P[0], P[1], s); c.globalAlpha = st.alpha * dim(m, it) * fadeOf(it); c.fillStyle = colOf(m, it) || T.dflt; c.fill(); c.globalAlpha = 1;
      const hollow = colOf(m, it) === 'transparent';
      c.strokeStyle = st.ocolor || (hollow ? (G.style === 'dark' ? 'rgba(255,255,255,.85)' : 'rgba(0,0,0,.75)') : 'rgba(0,0,0,.45)'); c.lineWidth = hover && hover.it === it ? 2 : hollow ? 1.3 : 0.6; c.globalAlpha = fadeOf(it); c.stroke(); c.globalAlpha = 1;
      if (st.labels && it.name && fadeOf(it) > 0.5) label(c, it.name, P[0] + s + 3, P[1] + 4);
    }
  }
  function hitSymbols(x, y, m) {
    let best = null, bd = 1e9;
    for (const it of m.items) { if (!it._s) continue; const d = (it._x - x) ** 2 + (it._y - y) ** 2, lim = Math.max(64, it._s * it._s); if (d < bd && d < lim) { bd = d; best = it; } }
    return best;
  }

  // ================= layer: tracks =================
  // One line per track (e.g. a storm), through its points in time order. The line is as long as the points the time line currently shows, so
  // "Everything up to this step" leaves a trail behind a dot at the latest position.
  function trackGroups(m) {
    if (m._tsrc === m.items) return m._trk;
    const by = new Map(); for (const it of m.items) { let a = by.get(it.name); if (!a) by.set(it.name, a = []); a.push(it); }
    m._tsrc = m.items; m._trk = [...by.values()]; return m._trk;
  }
  function drawTracks(c, env, m) {
    const st = m.L.st, T = STYLE[G.style], hotName = hover && hover.m === m ? hover.it.name : null, trk = trackGroups(m), lim = env.flat ? env.SW * 0.5 : 1e9;
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const pts of trk) {          // the dot at a track's latest point fades with the other marks once that track has ended
      const hot = hotName === pts[0].name, fade = hotName && !hot ? 0.2 : 1; let prev = null;
      for (const it of pts) {
        const P = env.pt(it.lon, it.lat); it._s = 0; if (!P) { prev = null; continue; } it._x = P[0]; it._y = P[1]; it._s = 1;
        const col = it.col || st.color || T.dflt;
        if (prev && Math.abs(P[0] - prev[0]) < lim) {
          const wpx = (m.f.width && it.w != null ? 1 + Math.sqrt(Math.max(0, it.w) / m.wmax) * 5 : 2) * st.lw * (hot ? 1.5 : 1);
          c.beginPath(); c.moveTo(prev[0], prev[1]); c.lineTo(P[0], P[1]); c.lineWidth = wpx; c.strokeStyle = col; c.globalAlpha = st.alpha * fade * fadeOf(it); c.stroke();
        }
        prev = P;
      }
      c.globalAlpha = 1;
      const last = pts[pts.length - 1];
      if (last && last._s) {
        if (st.head !== false) { c.beginPath(); c.arc(last._x, last._y, 4.5 * Math.max(0.8, st.lw), 0, 6.3); c.globalAlpha = fade * fadeOf(last); c.fillStyle = last.col || st.color || T.dflt; c.fill(); c.strokeStyle = G.style === 'dark' ? 'rgba(255,255,255,.9)' : 'rgba(0,0,0,.7)'; c.lineWidth = 1.3; c.stroke(); c.globalAlpha = 1; }
        if (st.labels && last.name && fadeOf(last) > 0.5) label(c, last.name, last._x + 8, last._y + 4);
      }
    }
  }
  function hitTracks(x, y, m) {
    let best = null, bd = 100;
    for (const it of m.items) { if (!it._s) continue; const d = (it._x - x) ** 2 + (it._y - y) ** 2; if (d < bd) { bd = d; best = it; } }
    return best;
  }

  // ================= layer: hex bins =================
  // Points are dropped into a honeycomb laid out in map (Mercator) space, so the cells are regular on the flat map; each cell is coloured by how many points
  // it holds (or the sum / average of a measure), on a log or linear scale.
  const SQ3 = Math.sqrt(3);
  function hexBins(m) {
    const st = m.L.st, key = st.hex + '|' + st.agg + '|' + (m.f.weight || '') + '|' + st.log + '|' + st.ramp;
    if (m._hsrc === m.items && m._hkey === key) return m._bins;
    const R = (st.hex || 3) / 360 / SQ3, cells = new Map(), agg = m.f.weight ? st.agg : 'count';
    for (const it of m.items) {
      const px = mxOf(it.lon), py = myOf(Math.max(-84, Math.min(84, it.lat)));
      const qf = (SQ3 / 3 * px - py / 3) / R, rf = (2 / 3 * py) / R, sf = -qf - rf;
      let q = Math.round(qf), r = Math.round(rf), s2 = Math.round(sf); const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s2 - sf);
      if (dq > dr && dq > ds) q = -r - s2; else if (dr > ds) r = -q - s2;
      const k = q + ',' + r; let b = cells.get(k); if (!b) { b = { q, r, n: 0, sum: 0, nw: 0 }; cells.set(k, b); }
      b.n++; if (it.w != null) { b.sum += it.w; b.nw++; }
    }
    const bins = [];
    for (const b of cells.values()) {
      b.v = agg === 'sum' ? b.sum : agg === 'avg' ? (b.nw ? b.sum / b.nw : 0) : b.n;
      b.cx = R * SQ3 * (b.q + b.r / 2); b.cy = R * 1.5 * b.r; b.lon = toLon(b.cx); b.lat = toLat(b.cy); bins.push(b);
    }
    let mn = Infinity, mx = -Infinity; for (const b of bins) { if (b.v < mn) mn = b.v; if (b.v > mx) mx = b.v; }
    if (!bins.length) { mn = 0; mx = 1; }
    const log = st.log && mn > 0 && mx > mn; m._hlog = log; m._hmin = mn; m._hmax = mx; m._hR = R;
    for (const b of bins) b.t = mx > mn ? (log ? (Math.log(b.v) - Math.log(mn)) / (Math.log(mx) - Math.log(mn)) : (b.v - mn) / (mx - mn)) : 0.5;
    if (m.hexLg) { const lbl = agg === 'sum' ? 'Sum of ' + m.f.weight : agg === 'avg' ? 'Average ' + m.f.weight : 'Count'; Object.assign(m.hexLg, { title: lbl + ' per bin' + (log ? ' (log scale)' : ''), ramp: (RAMPS[st.ramp] || RAMPS.div)[1], min: mn, max: mx }); }
    m._bins = bins; m._hsrc = m.items; m._hkey = key; return bins;
  }
  function drawHex(c, env, m) {
    const st = m.L.st, bins = hexBins(m), R = m._hR, Rr = RAMPS[st.ramp] || RAMPS.div, hot = hover && hover.m === m ? hover.it : null;
    for (const b of bins) {
      b._r = 0; let poly = null;
      if (env.flat) {
        const P = env.pt(b.lon, b.lat); if (!P) continue; const rp = R * env.SW; b._x = P[0]; b._y = P[1]; b._r = rp;
        poly = []; for (let k = 0; k < 6; k++) { const a = (30 + 60 * k) * D2R; poly.push([P[0] + rp * Math.cos(a), P[1] + rp * Math.sin(a)]); }
      } else {
        const P = env.pt(b.lon, b.lat); if (!P) continue; poly = [];
        for (let k = 0; k < 6; k++) { const a = (30 + 60 * k) * D2R, V = env.g.ll(toLon(b.cx + R * Math.cos(a)), toLat(b.cy + R * Math.sin(a))); if (V[2] <= 0.02) { poly = null; break; } poly.push(V); }
        if (!poly) continue; b._x = P[0]; b._y = P[1]; b._r = Math.max(...poly.map(V => Math.hypot(V[0] - P[0], V[1] - P[1])));
      }
      c.beginPath(); poly.forEach((V, i) => c[i ? 'lineTo' : 'moveTo'](V[0], V[1])); c.closePath();
      c.globalAlpha = st.alpha * (hot && hot !== b ? 0.55 : 1); c.fillStyle = ramp(Rr[1], b.t); c.fill(); c.globalAlpha = 1;
      if (st.outline !== false || hot === b) { c.strokeStyle = hot === b ? '#fff' : 'rgba(255,255,255,.35)'; c.lineWidth = hot === b ? 2 : 0.6; c.stroke(); }
    }
  }
  function hitHex(x, y, m) {
    let best = null, bd = 1e9; if (!m._bins) return null;
    for (const b of m._bins) { if (!b._r) continue; const d = Math.hypot(b._x - x, b._y - y); if (d <= b._r * 0.87 && d < bd) { bd = d; best = b; } }
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
  // Rows that share a location (e.g. one row per year for a country) are combined into one bar, so bars never pile up on each other.
  function barGroups(m) {
    const st = m.L.st, key = (st.bagg || 'sum') + '|' + st.ramp + '|' + (m.f.color || '');
    if (m._gsrc === m.items && m._gkey === key) return m._grp;
    const ag = (a, how) => { if (!a.length) return null; if (how === 'max') return a.reduce((x, y) => Math.max(x, y)); const t = a.reduce((x, y) => x + y, 0); return how === 'avg' ? t / a.length : t; };
    const how = st.bagg || 'sum', groups = new Map(), ci = m.f.color && colInfo(m.f.color, m.cols), cMeasure = !!ci && (isMeasure(m.f.color) || isNumCol(ci));
    for (const it of m.items) {
      const k = it.lon.toFixed(4) + ',' + it.lat.toFixed(4); let g = groups.get(k);
      if (!g) { g = { lon: it.lon, lat: it.lat, name: it.name, first: it, row: it.row, n: 0, hs: [], cs: [] }; groups.set(k, g); }
      g.n++; if (it.s != null) g.hs.push(it.s); if (cMeasure) { const v = num(it.row[m.f.color]); if (v != null) g.cs.push(v); }
    }
    const list = [...groups.values()]; let gmax = 1e-9, cmin = Infinity, cmax = -Infinity;
    for (const g of list) { g.s = ag(g.hs, how); if (g.s != null && g.s > gmax) gmax = g.s; g.cv = ag(g.cs, how); if (g.cv != null) { if (g.cv < cmin) cmin = g.cv; if (g.cv > cmax) cmax = g.cv; } }
    const R = (RAMPS[st.ramp] || RAMPS.blues)[1];
    for (const g of list) g.col = cMeasure ? (g.cv == null ? null : ramp(R, cmax > cmin ? (g.cv - cmin) / (cmax - cmin) : 0.5)) : g.first.col;
    const lc = m.leg.find(l => l.ramp), ls = m.leg.find(l => l.bar);
    if (lc && cMeasure) { lc.ramp = R; lc.min = cmin === Infinity ? 0 : cmin; lc.max = cmax === -Infinity ? 1 : cmax; }
    if (ls) ls.size = gmax;
    m._gsrc = m.items; m._gkey = key; m._gmax = gmax; m._grp = list; return list;
  }
  function drawBars(c, env, m) {
    const st = m.L.st, T = STYLE[G.style], zf = Math.min(1.8, 0.7 + env.z * 0.15), maxH = 120 * (st.bh || 1) * zf, w = (9 + 5 * Math.min(2.5, env.z * 0.5)) * (st.bw || 1);
    const pts = [], grp = barGroups(m);
    for (const it of grp) {
      it._w = 0; const B = env.pt(it.lon, it.lat); if (!B) continue;
      const hpx = Math.max(2, (m.f.height && it.s != null ? Math.max(0, it.s) / m._gmax : 0.3) * maxH);
      let Tp;
      if (env.flat) Tp = [B[0], B[1] - hpx, 1]; else Tp = env.g.ll(it.lon, it.lat, 1 + hpx / env.g.R);
      pts.push({ it, B, Tp });
    }
    pts.sort(env.flat ? (a, b) => a.B[1] - b.B[1] : (a, b) => a.B[2] - b.B[2]);          // far ones first, near ones cover them
    c.lineJoin = 'round';
    for (const { it, B, Tp } of pts) {
      const cc = it.col || m.L.st.color || T.fill, col = cc === 'transparent' ? T.fill : cc, dx = Tp[0] - B[0], dy = Tp[1] - B[1], len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
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
    for (const it of (m._grp || [])) {
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
      g.globalAlpha = Math.min(1, I * fadeOf(it) * (weighted ? 0.35 + 0.65 * Math.sqrt(it.w / m.wmax) : 1)); g.drawImage(sp, P[0] * S - half, P[1] * S - half);
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
    if (m.L.type === 'cartogram' && st.cghost !== false) drawGhostFlat(c, v, m);
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
    if (m.L.type === 'cartogram' && st.cghost !== false) drawGhostGlobe(c, g, m);
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
  // Each layer gets a small card. Inside it, every field has its own labelled section: COLOUR (a ramp or a list), then SIZE / AREA / HEIGHT / WIDTH
  // (a sample of the largest and smallest mark). The card only gets a title when the layer has a name of its own.
  function drawLegend(c, W, H) {
    const vis = models.filter(m => m.L.on && m.L.st.legend !== false && m.base.length && m.leg.length); if (!vis.length) return;
    const w = 190, ROW = 16, GAP = 8, SEC = 17;
    const defaultName = n => Object.values(TYPES).includes(n) || ['Shapes', 'Symbols', 'Flows', 'Pies'].includes(n);
    const titled = m => DASH || !defaultName(m.L.name);          // a sheet map with the standard name needs no title; a dashboard needs it to tell the layers apart
    const sizeLabel = lg => (lg.area ? 'Area' : lg.line ? 'Width' : lg.bar ? 'Height' : 'Size');
    const heightOf = m => {
      let h = 8 + (titled(m) ? 17 : 0);
      for (const lg of m.leg) {
        if (lg.swatch) h += 18;
        else if (lg.size != null) h += SEC + (lg.circles ? 32 : 18);
        else if (lg.cat) h += SEC + Math.min(lg.cat.size, lg.max || 6) * ROW + (lg.cat.size > (lg.max || 6) ? ROW : 0);
        else if (lg.ramp) h += SEC + 30;
      }
      return h + 4;
    };
    const section = (c, x, yy, label, name) => { c.font = '9px ' + FONT; c.fillStyle = '#777'; c.fillText(label.toUpperCase(), x + 10, yy); c.font = 'bold 11px ' + FONT; c.fillStyle = '#111'; c.fillText(trunc(name, 22), x + 56, yy); };
    // one card per layer, stacked up from the bottom left; a new column starts when the next card would not fit
    let x = 8, bottom = H - 20; c.textBaseline = 'middle';
    for (const m of vis) {
      const h = heightOf(m); if (h > H - 30) continue;
      if (bottom - h < 8 && bottom !== H - 20) { x += w + GAP; bottom = H - 20; }
      const y = bottom - h; bottom = y - GAP;
      panel(c, x, y, w, h); let yy = y + 12;
      if (titled(m)) { c.font = 'bold 11px ' + FONT; c.fillStyle = '#000'; c.textAlign = 'left'; c.fillText(trunc(m.L.name, 28), x + 8, yy); yy += 17; }
      for (const lg of m.leg) {
        c.textAlign = 'left'; c.fillStyle = '#222';
        if (lg.swatch) { const cl = lg.col(); c.strokeStyle = cl === 'transparent' ? '#999' : cl; c.lineWidth = 3; c.lineCap = 'round'; c.beginPath(); c.moveTo(x + 11, yy); c.lineTo(x + 27, yy); c.stroke(); c.fillStyle = '#222'; c.font = '11px ' + FONT; c.fillText(lg.title, x + 34, yy); yy += 18; continue; }
        if (lg.size != null) {
          section(c, x, yy, sizeLabel(lg), ml(m, lg.title)); yy += SEC;
          c.font = '11px ' + FONT; c.fillStyle = '#222';
          if (lg.circles) {          // the largest and the smallest mark, as drawn: area follows the value
            const R = 12, top = yy - 3, hasMin = lg.min != null && lg.min < lg.size, r2 = hasMin ? Math.max(2.5, R * Math.sqrt(lg.min / lg.size)) : 0;
            c.fillStyle = 'rgba(110,120,135,.28)'; c.strokeStyle = 'rgba(0,0,0,.5)'; c.lineWidth = 1;
            c.beginPath(); c.arc(x + 24, top + R, R, 0, 6.3); c.fill(); c.stroke();
            if (hasMin) { c.beginPath(); c.arc(x + 24, top + 2 * R - r2, r2, 0, 6.3); c.fill(); c.stroke(); }
            c.fillStyle = '#222'; c.fillText('largest  ' + fmtC(lg.size), x + 46, top + 7); if (hasMin) c.fillText('smallest  ' + fmtC(lg.min), x + 46, top + 2 * R - 3);
            yy += 32;
          } else if (lg.line && lg.col) {
            const cl = lg.col(); c.lineCap = 'round'; c.strokeStyle = cl === 'transparent' ? '#999' : cl; c.lineWidth = 1; c.beginPath(); c.moveTo(x + 10, yy); c.lineTo(x + 24, yy); c.stroke(); c.lineWidth = 4; c.beginPath(); c.moveTo(x + 24, yy); c.lineTo(x + 38, yy); c.stroke();
            c.fillStyle = '#222'; c.fillText('largest  ' + fmtC(lg.size), x + 46, yy); yy += 18;
          } else { c.fillText('largest  ' + fmtC(lg.size), x + 10, yy); yy += 18; }
          continue;
        }
        if (lg.title) section(c, x, yy, lg.words ? 'Density' : 'Colour', lg.words ? lg.title.replace(/^Density:?\s*/, '') || 'points' : ml(m, lg.title)); yy += SEC;
        c.font = '11px ' + FONT;
        if (lg.cat) {
          const cats = [...lg.cat].slice(0, lg.max || 6);
          cats.forEach(([n, col]) => { c.fillStyle = col; c.fillRect(x + 10, yy - 5, 14, 10); c.strokeStyle = 'rgba(0,0,0,.35)'; c.strokeRect(x + 10, yy - 5, 14, 10); c.fillStyle = '#222'; c.fillText(trunc(n, 26), x + 30, yy); yy += ROW; });
          if (lg.cat.size > cats.length) { c.fillStyle = '#666'; c.fillText('+' + (lg.cat.size - cats.length) + ' more', x + 30, yy); yy += ROW; }
        } else if (lg.ramp) {
          const gr = c.createLinearGradient(x + 10, 0, x + w - 10, 0); lg.ramp.forEach(st => gr.addColorStop(st[0], st[1]));
          c.fillStyle = gr; c.fillRect(x + 10, yy - 5, w - 20, 9); c.fillStyle = '#222'; c.textAlign = 'left'; c.fillText(lg.words ? lg.words[0] : fmtC(lg.min), x + 10, yy + 12);
          c.textAlign = 'right'; c.fillText(lg.words ? lg.words[1] : fmtC(lg.max), x + w - 10, yy + 12); c.textAlign = 'left'; yy += 30;
        }
      }
    }
    c.textBaseline = 'alphabetic';
  }
  const fmtC = n => { const a = Math.abs(n); for (const [d, t] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= d) return +(n / d).toFixed(Math.abs(n / d) < 10 ? 2 : Math.abs(n / d) < 100 ? 1 : 0) + t; return String(+n.toFixed(a < 10 ? 2 : a < 100 ? 1 : 0)); };          // 16,200,000,000,000 -> 16.2T
  const minOfPos = (arr, f) => { let mn = Infinity; for (let i = 0; i < arr.length; i++) { const v = f(arr[i]); if (v > 0 && v < mn) mn = v; } return mn === Infinity ? null : mn; };
  // "Measure swapper": a layer can name its measure after a workbook parameter (e.g. "Measure to Display"), so legends and tooltips say what is shown instead of "SUM(Measure)"
  const paramLabel = name => { const q = TX.params && TX.params.list.find(x => x.name === name); return q ? q.label : ''; };
  const ml = (m, n) => { if (!n || !m.L.param) return n; const lab = paramLabel(m.L.param); if (!lab) return n; const f = m.f; return [f.size, f.height, f.weight, f.width, f.value].includes(n) ? lab : n; };
  const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  // ================= tooltip =================
  function titleOf(m, it) {
    if (m.L.type === 'arcs') { const nm = n => n.label || n.lat.toFixed(2) + ', ' + n.lon.toFixed(2); return nm(it.a) + ' → ' + nm(it.b); }
    if (it.name) return it.name;
    for (const k of Object.keys(it.row)) { const col = colInfo(k, m.cols); if (col && col.dataType === 'string' && !isNull(it.row[k])) return str(it.row[k]); }
    return m.L.name;
  }
  function tipHtml(m, it) {
    if (m.L.type === 'bars') {
      const how = { sum: 'Sum', avg: 'Average', max: 'Maximum' }[m.L.st.bagg || 'sum'], k = n => '<span class="k">' + esc(n) + ':</span> ';
      return '<b>' + esc(it.name || titleOf(m, it)) + '</b>' + (m.f.height && it.s != null ? '<br>' + k(ml(m, m.f.height) + (it.n > 1 ? ' (' + how.toLowerCase() + ' of ' + it.n + ' rows)' : '')) + fmt(Math.round(it.s * 100) / 100) : '') +
        (m.f.color && m.f.color !== m.f.height && it.cv != null ? '<br>' + k(m.f.color) + fmt(Math.round(it.cv * 100) / 100) : '') + (m.f.color && it.cv == null && it.first ? '<br>' + k(m.f.color) + esc(str(it.row[m.f.color])) : '');
    }
    if (m.L.type === 'hexbin') {
      const agg = m.f.weight ? m.L.st.agg : 'count', pt = n => '<span class="k">' + n + '</span> ';
      return '<b>' + fmt(it.n) + ' point' + (it.n === 1 ? '' : 's') + '</b>' + (agg !== 'count' && m.f.weight ? '<br>' + pt((agg === 'sum' ? 'Sum of ' : 'Average ') + esc(ml(m, m.f.weight)) + ':') + fmt(Math.round(it.v * 100) / 100) : '') + '<br>' + pt('Centre:') + it.lat.toFixed(2) + ', ' + it.lon.toFixed(2);
    }
    if (m.L.type === 'pies') {
      return '<b>' + esc(it.name) + '</b>' + m.pnames.filter(n => it.s.get(n)).map(n => '<span style="color:' + m.pcol.get(n) + '">&#9632;</span> ' + esc(n) + ': <b style="display:inline">' + fmt(it.s.get(n)) + '</b>').join('<br>') +
        (m.f.value ? '<br><span class="k">Total ' + esc(ml(m, m.f.value)) + ':</span> ' + fmt(it.n) : '');
    }
    const hide = new Set(Object.values(m.f).filter(Boolean).filter(n => { const c = colInfo(n, m.cols); return (c && c.dataType === 'spatial') || isLonOrLatUsed(m, n); }));
    const title = titleOf(m, it), out = [];
    for (const k of Object.keys(it.row)) {
      if (hide.has(k) || /\(generated\)$/.test(k) || isNull(it.row[k]) || (colInfo(k, m.cols) || {}).dataType === 'spatial') continue;
      const t = str(it.row[k]); if (t === title) continue;
      out.push('<span class="k">' + esc(ml(m, k)) + ':</span> ' + esc(t));
    }
    return '<b>' + esc(title) + '</b>' + out.join('<br>') + (m.L.type === 'cartogram' && it.fe != null ? '<br><span class="k">Drawn at</span> ' + Math.round(it.fe * it.fe * 100) + '% of its real area' : '');
  }
  const isLonOrLatUsed = (m, n) => ['lon', 'lat', 'olon', 'olat', 'dlon', 'dlat'].some(k => m.f[k] === n);

  // ================= views =================
  const DRAW = {
    flat: (c, v) => {
      checkZoom(); const env = flatEnv(v);
      for (const m of models) {
        if (!m.L.on || !m.items.length) continue;
        if (m.L.type === 'shapes' || m.L.type === 'cartogram') drawShapesFlat(c, v, m);
        else if (m.L.type === 'symbols') drawSymbols(c, env, m);
        else if (m.L.type === 'density') drawDensity(c, env, m);
        else if (m.L.type === 'bars') drawBars(c, env, m);
        else if (m.L.type === 'hexbin') drawHex(c, env, m);
        else if (m.L.type === 'tracks') drawTracks(c, env, m);
        else if (m.L.type === 'pies') drawPies(c, env, m);
        else { drawArcsFlat(c, v, m); drawArcNodes(c, env, m); }
      }
      drawLegend(c, v.W, v.H);
    },
    globe: (c, g) => {
      checkZoom(); const env = globeEnv(g);
      for (const m of models) {
        if (!m.L.on || !m.items.length) continue;
        if (m.L.type === 'shapes' || m.L.type === 'cartogram') drawShapesGlobe(c, g, m);
        else if (m.L.type === 'symbols') drawSymbols(c, env, m);
        else if (m.L.type === 'density') drawDensity(c, env, m);
        else if (m.L.type === 'bars') drawBars(c, env, m);
        else if (m.L.type === 'hexbin') drawHex(c, env, m);
        else if (m.L.type === 'tracks') drawTracks(c, env, m);
        else if (m.L.type === 'pies') drawPies(c, env, m);
        else { drawArcsGlobe(c, g, m); drawArcNodes(c, env, m); }
      }
      drawLegend(c, g.W, g.H);
    }
  };
  const HIT = { shapes: hitShapes, cartogram: hitShapes, symbols: hitSymbols, density: () => null, bars: hitBars, hexbin: hitHex, tracks: hitTracks, pies: hitPies, arcs: hitArcs };      // a density layer is a surface, so it has nothing to hover
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
  const landOn = () => G.base && !models.some(m => m.L.on && m.L.type === 'cartogram' && m.L.st.cghost === false);          // a cartogram with "real outlines" off also hides the real country shapes of the base map
  function applyStyle() { const T = STYLE[G.style]; flat.theme = { bg: T.bg, land: T.land, stroke: T.stroke }; globe.setTheme(G.style); document.body.style.background = T.bg; flat.showLand = globe.showLand = landOn(); }
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
    const n = T.steps.length; tl.hidden = n < 2; if (n < 2) return; tlAll.hidden = noAll();          // no "All" button when a cartogram is on the time line
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
  tlAll.addEventListener('click', () => { if (noAll()) return; T.playing = false; T.idx = -1; applyTime(); updateTL(); redraw(); });
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
      globe.setHome(wrap180(lon), lat); globe.setHomeK(Math.max(1, Math.min(12, 0.85 / Math.sin(Math.min(ang, 1.4)))));
    }
    return true;
  }

  // ================= data =================
  function rebuild() {
    models = layers.map(build); ext = null; buildTimeline(); applyTime(); updateTL(); applyStyle();
    models.forEach(m => { if (m.L.on && m.ext) { ext = ext || { a: 180, b: -180, c: 90, d: -90, a2: 540, b2: -180 }; ext.a = Math.min(ext.a, m.ext.a); ext.b = Math.max(ext.b, m.ext.b); ext.c = Math.min(ext.c, m.ext.c); ext.d = Math.max(ext.d, m.ext.d); ext.a2 = Math.min(ext.a2, m.ext.a2); ext.b2 = Math.max(ext.b2, m.ext.b2); } });
    if (ext && ext.b2 - ext.a2 < ext.b - ext.a) { ext.a = ext.a2; ext.b = ext.b2; }          // the shorter way round the globe
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
    G.tall = g('tall', '') === '' ? null : g('tall', '') === '1'; G.tm = g('tm', 'period'); G.tn = parseInt(g('tn', '3'), 10) || 3; G.tg = g('tg', 'exact'); G.tsp = parseFloat(g('tsp', '1.5')) || 1.5; G.tloop = g('tloop', '1') === '1'; G.fade = g('fade', '0') === '1'; G.fn = parseInt(g('fn', '4'), 10) || 4;
    try { G.dismissed = JSON.parse(g('dismissed', '[]')); } catch (e) { G.dismissed = []; }
    try { const s = g('layers', ''); if (s) { layers = JSON.parse(s); auto = false; } } catch (e) { /* ignore a damaged value */ }
  }
  TX.settings.onError = err => show('<b>Your settings could not be saved</b><br>' + esc(String(err && err.message || err)) + '<br>They will be lost if the extension reloads. Try again, or save the workbook.');
  function persist() { if (typeof TX.mode === 'function' && TX.mode() === 'viewing') return; clearTimeout(saveT); saveT = setTimeout(writeSettings, 400); }          // a viewer's changes last for the session only (viewers cannot save workbook settings)
  function writeSettings() {
    {
      TX.settings.set('map', G.map); TX.settings.set('style', G.style); TX.settings.set('base', G.base ? '1' : '0'); TX.settings.set('lf', G.lf); TX.settings.set('sv', G.sv); TX.settings.set('rot', G.rot ? '1' : '0'); TX.settings.set('rs', String(G.rs)); TX.settings.set('fixed', JSON.stringify(G.fixed));
      TX.settings.set('tall', G.tall == null ? '' : G.tall ? '1' : '0'); TX.settings.set('tm', G.tm); TX.settings.set('tn', String(G.tn)); TX.settings.set('tg', G.tg); TX.settings.set('tsp', String(G.tsp)); TX.settings.set('tloop', G.tloop ? '1' : '0'); TX.settings.set('fade', G.fade ? '1' : '0'); TX.settings.set('fn', String(G.fn));
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
    rebuild(); renderPanel();
    if (!TX.demo && !layers.length) show('<b>No layers loaded</b><br>' + esc(diagText()) + '<br>Sheets seen: ' + (Object.keys(sheets).join(', ') || 'none') + '. Layers: 0. Open the panel to choose a layer type.');
  }

  // ================= Layers panel =================
  const pbody = $('pbody'), openIds = new Set();
  let pbody2 = null, panel2 = null;
  {          // two cards side by side: "Map" (everyone) and "Layer setup" (the author)
    const p1 = $('panel'), cards = document.createElement('div'); cards.id = 'cards'; p1.parentNode.insertBefore(cards, p1); cards.appendChild(p1);
    p1.querySelector('summary').textContent = 'Map';
    panel2 = document.createElement('details'); panel2.className = 'ctl studio'; panel2.id = 'panel2'; panel2.innerHTML = '<summary>Layer setup</summary><div class="body" id="pbody2"></div>'; cards.appendChild(panel2); pbody2 = $('pbody2');
    [p1, panel2].forEach(d => { const sm = d.querySelector('summary'); sm.innerHTML = '<span>' + sm.textContent + '</span><button type="button" class="xclose" title="Close">&times;</button>'; });          // a cross closes an open card
    cards.addEventListener('click', e => { const x = e.target.closest('.xclose'); if (x) { e.preventDefault(); e.stopPropagation(); x.closest('details').open = false; } });
  }
  const optsOf = (L, key, pred) => {
    const dflt = fieldsOf({ ...L, f: {} })[key], cur = L.f[key] || '', lead = DASH ? 'Auto: ' : 'Marks card: ';
    let h = '<option value=""' + (cur === '' ? ' selected' : '') + '>' + (dflt ? lead + esc(trunc(dflt, 22)) : (DASH ? 'Auto (none found)' : 'Marks card (not set)')) + '</option><option value="-"' + (cur === '-' ? ' selected' : '') + '>(none)</option>';
    const cx = ctxOf(L), list = cx.cols.filter(c => (pred || (() => true))(c, cx)).map(c => c.name); if (cur && cur !== '-' && !list.includes(cur)) list.unshift(cur);
    return h + list.map(n => '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(trunc(n, 28)) + '</option>').join('');
  };
  // A measure field: a number by type, an aggregate by name (SUM(...), AGG(...)), or - for calculated fields Tableau types oddly - one whose values are numbers.
  const numericLike = (c, cx) => {
    if (isNumCol(c) || isMeasure(c.name)) return true;
    if (!cx || ['spatial', 'date', 'date-time', 'bool'].includes(c.dataType)) return false;
    for (let i = 0, n = 0; i < cx.rows.length && n < 40; i++) { const v = raw(cx.rows[i][c.name]); if (v == null || v === '') continue; n++; if (typeof v === 'number') return true; if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v.replace(/,/g, '')))) return true; return false; }
    return false;
  };
  const timeable = c => c.dataType === 'date' || c.dataType === 'date-time' || c.dataType === 'int', any = () => true, numeric = (c, cx) => numericLike(c, cx), spatial = c => c.dataType === 'spatial', nonSpatial = c => c.dataType !== 'spatial';
  function fsel(L, key, label, pred) { return '<label>' + label + '<select data-l="' + L.id + '" data-k="f.' + key + '">' + optsOf(L, key, pred) + '</select></label>'; }
  function rng(L, key, label, min, max, step) { return '<label>' + label + '<input type="range" data-l="' + L.id + '" data-k="st.' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + L.st[key] + '"></label>'; }
  function chk(L, key, label) { return '<label class="chk"><input type="checkbox" data-l="' + L.id + '" data-k="st.' + key + '"' + (L.st[key] ? ' checked' : '') + '>&nbsp;' + label + '</label>'; }
  function palette(L) { return '<label>Palette<select data-l="' + L.id + '" data-k="st.ramp">' + Object.entries(RAMPS).map(([k, v]) => '<option value="' + k + '"' + (L.st.ramp === k ? ' selected' : '') + '>' + v[0] + '</option>').join('') + '</select></label>'; }
  const isClear = L => L.st.color === 'transparent';
  function fixedColor(L) { return '<label>Fixed colour<span><input type="color" data-l="' + L.id + '" data-k="st.color" value="' + (L.st.color && !isClear(L) ? L.st.color : '#4aa3df') + '"' + (isClear(L) ? ' style="opacity:.35"' : '') + '> <button type="button" data-act="clearcolor" data-l="' + L.id + '" title="Use the default colour">auto</button> <button type="button" data-act="transparent" data-l="' + L.id + '" title="No colour: see-through fill (shapes) or hollow symbols"' + (isClear(L) ? ' style="font-weight:bold;outline:1px solid #4aa3df"' : '') + '>transparent</button></span></label>'; }
  function outlineColor(L) { return '<label>Outline colour<span><input type="color" data-l="' + L.id + '" data-k="st.ocolor" value="' + (L.st.ocolor || '#f28e2b') + '"> <button type="button" data-act="clearocolor" data-l="' + L.id + '" title="Use the default outline">auto</button></span></label>'; }
  // Each layer's controls come in two parts: SETUP (type, which fields feed the map: for the author, Card 2) and VIEW (how it looks: for everyone, Card 1).
  // Labels follow one scheme in every type: "Label" / "Place name" for names, "Measure (what it drives)" for the number, "Colour by", "Show labels", "Size".
  function layerParts(L) {
    const st = L.st; let S = '', V = '';
    const sel = (k, label, pairs, cur, title) => '<label' + (title ? ' title="' + title + '"' : '') + '>' + label + '<select data-l="' + L.id + '" data-k="st.' + k + '">' + pairs.map(([v, n]) => '<option value="' + v + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>';
    // Fixed colour only applies when nothing sets the colour; the palette only applies to a colour scale (a measure). Otherwise they would do nothing, so they are not shown.
    const fl = fieldsOf(L), pal = L.type === 'hexbin' || (fl.color && isMeasure(fl.color)) ? palette(L) : '', fx = fl.color ? '' : fixedColor(L), oc = outlineColor(L), op = rng(L, 'alpha', 'Opacity', 0.1, 1, 0.05), labels = chk(L, 'labels', 'Show labels');
    S += '<label>Type<select data-l="' + L.id + '" data-k="type">' + Object.entries(TYPES).filter(([k]) => !(DASH && k === 'cartogram')).map(([k, v]) => '<option value="' + k + '"' + (L.type === k ? ' selected' : '') + '>' + v + '</option>').join('') + '</select></label>';
    if (DASH) {
      const sn = Object.keys(D.sheets);
      S += '<label>Data from sheet<select data-l="' + L.id + '" data-k="sheet"><option value="">(choose a sheet)</option>' + sn.map(n => '<option value="' + esc(n) + '"' + (n === L.sheet ? ' selected' : '') + '>' + esc(trunc(n, 26)) + '</option>').join('') + (L.sheet && !sn.includes(L.sheet) ? '<option value="' + esc(L.sheet) + '" selected>' + esc(trunc(L.sheet, 26)) + ' (missing)</option>' : '') + '</select></label>';
    } else if (G.lf && TX.demo) {
      const vals = [...new Set(D.rows.map(r => str(r[G.lf])))].slice(0, 200).sort();
      S += '<label>Rows where ' + esc(trunc(G.lf, 14)) + ' =<select data-l="' + L.id + '" data-k="lv"><option value="">(all rows)</option>' + vals.map(v => '<option value="' + esc(v) + '"' + (v === L.lv ? ' selected' : '') + '>' + esc(trunc(v, 26)) + '</option>').join('') + '</select></label>';
    }
    if (L.type === 'cartogram') {
      if (st.cmorph == null) st.cmorph = 1; if (st.cscl == null) st.cscl = 1; if (!st.cmode) st.cmode = 'fit'; if (!st.cshape) st.cshape = 'outline'; ['csep', 'cghost', 'cdrop', 'cdecl', 'cdisc'].forEach(k => { if (st[k] == null) st[k] = true; });
      S += fsel(L, 'geom', 'Geometry', spatial) + fsel(L, 'name', 'Place name', nonSpatial) + fsel(L, 'size', 'Measure (area)', numeric) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'time', 'Time field', timeable) + fsel(L, 'lon', 'Longitude (optional)', numeric) + fsel(L, 'lat', 'Latitude (optional)', numeric) +
        sel('cmode', 'Scale so that', [['fit', 'no overlap, real positions: the largest scale that fits'], ['big', 'the biggest shape keeps its real size'], ['none', 'no shape is larger than its real size'], ['total', 'all shapes keep the real total area']], st.cmode, 'How the overall scale is fixed') +
        chk(L, 'cdrop', 'Hide remote overseas pieces (over 50&deg; from the main land)') + chk(L, 'cdisc', 'Places with no outline as circles') +
        '<div class="sub">Each shape keeps its real position and is resized so its area follows the measure. Use a measure that adds up (population, sales, GDP); the share of the total area stays the same as on the real map. With <b>no Geometry field</b>, the built-in country outlines are used, matched on Place name (country names or ISO3 codes). Longitude and latitude place the places that have no outline. Pick a Time field (e.g. the year) to step through time.</div>';
      V += sel('cshape', 'Shape', [['outline', 'Country / region outlines'], ['circle', 'Circles']], st.cshape) + rng(L, 'cmorph', 'Real map &#8596; cartogram', 0, 1, 0.05) + rng(L, 'cscl', 'Shape size (100% = as set)', 0.2, 1.5, 0.05) +
        chk(L, 'cghost', 'Show the real country shapes underneath (dashed outlines and base map)') + chk(L, 'csep', 'Separate overlapping shapes') + chk(L, 'cdecl', 'Declutter when zooming in (spaces the shapes apart)') +
        pal + fx + op + rng(L, 'lw', 'Line width', 0.3, 4, 0.1) + chk(L, 'outline', 'Outline') + (st.outline ? oc : '') + labels;
    } else if (L.type === 'shapes') {
      S += fsel(L, 'geom', 'Geometry', spatial) + fsel(L, 'name', 'Label', nonSpatial) + fsel(L, 'size', 'Measure (point size)', numeric) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'time', 'Time field', timeable);
      V += pal + fx + op + rng(L, 'lw', 'Line width', 0.3, 4, 0.1) + chk(L, 'outline', 'Outline') + (st.outline ? oc : '') + labels;
    } else if (L.type === 'symbols') {
      S += fsel(L, 'lon', 'Longitude', numeric) + fsel(L, 'lat', 'Latitude', numeric) + fsel(L, 'name', 'Label', nonSpatial) + fsel(L, 'size', 'Measure (size)', numeric) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'time', 'Time field', timeable);
      V += '<label>Symbol<select data-l="' + L.id + '" data-k="st.shape">' + SHAPES.map(([k, n]) => '<option value="' + k + '"' + (st.shape === k ? ' selected' : '') + '>' + n + '</option>').join('') + '</select></label>' + pal + fx + oc + rng(L, 'size', 'Size', 0.4, 3, 0.05) + op + labels;
    } else if (L.type === 'tracks') {
      S += fsel(L, 'lon', 'Longitude', numeric) + fsel(L, 'lat', 'Latitude', numeric) + fsel(L, 'group', 'Track (one line per)', nonSpatial) + fsel(L, 'width', 'Measure (line width)', numeric) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'time', 'Time field', timeable) +
        '<div class="sub">The time field sets the order of the points along each track. To keep the trail while playing, set Time line &rarr; Show to <b>Everything up to this step</b>.</div>';
      V += pal + fx + rng(L, 'lw', 'Line width', 0.3, 4, 0.1) + op + chk(L, 'head', 'Dot at the latest point') + labels;
    } else if (L.type === 'hexbin') {
      if (st.hex == null) st.hex = 3; if (!st.agg) st.agg = 'count'; if (st.log == null) st.log = true;
      S += fsel(L, 'lon', 'Longitude', numeric) + fsel(L, 'lat', 'Latitude', numeric) + fsel(L, 'weight', 'Measure (optional)', numeric) + fsel(L, 'time', 'Time field', timeable) +
        sel('agg', 'Colour shows', [['count', 'Number of points'], ['sum', 'Sum of the measure'], ['avg', 'Average of the measure']], st.agg);
      V += rng(L, 'hex', 'Hex size (degrees)', 0.5, 12, 0.5) + pal + op + chk(L, 'log', 'Log colour scale') + chk(L, 'outline', 'Outline');
    } else if (L.type === 'bars') {
      if (st.bh == null) st.bh = 1; if (st.bw == null) st.bw = 1;
      S += fsel(L, 'lon', 'Longitude', numeric) + fsel(L, 'lat', 'Latitude', numeric) + fsel(L, 'name', 'Label', nonSpatial) + fsel(L, 'height', 'Measure (height)', numeric) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'time', 'Time field', timeable) +
        sel('bagg', 'Combine rows at a location', [['sum', 'Sum'], ['avg', 'Average'], ['max', 'Maximum']], st.bagg || 'sum', 'When several rows sit on the same location (e.g. one per year), they are combined into one bar');
      V += pal + fx + oc + rng(L, 'bh', 'Bar height', 0.2, 3, 0.05) + rng(L, 'bw', 'Bar width', 0.3, 3, 0.05) + op + '<label class="chk" title="The name, or the height value if there is no name"><input type="checkbox" data-l="' + L.id + '" data-k="st.labels"' + (st.labels ? ' checked' : '') + '>&nbsp;Show labels</label>';
    } else if (L.type === 'density') {
      if (st.radius == null) st.radius = 1; if (st.intensity == null) st.intensity = 1; if (!DRAMPS[st.dramp]) st.dramp = 'fire';
      S += fsel(L, 'lon', 'Longitude', numeric) + fsel(L, 'lat', 'Latitude', numeric) + fsel(L, 'weight', 'Measure (weight, optional)', numeric) + fsel(L, 'time', 'Time field', timeable);
      V += '<label>Palette<select data-l="' + L.id + '" data-k="st.dramp">' + Object.entries(DRAMPS).map(([k, v]) => '<option value="' + k + '"' + (st.dramp === k ? ' selected' : '') + '>' + v[0] + '</option>').join('') + '</select></label>' + rng(L, 'radius', 'Radius', 0.3, 3, 0.05) + rng(L, 'intensity', 'Intensity', 0.2, 4, 0.05) + op;
    } else if (L.type === 'pies') {
      S += fsel(L, 'name', 'Place name', nonSpatial) + fsel(L, 'lon', 'Longitude (optional)', numeric) + fsel(L, 'lat', 'Latitude (optional)', numeric) + fsel(L, 'slice', 'Slice by', nonSpatial) + fsel(L, 'value', 'Measure (slice size)', numeric);
      V += rng(L, 'size', 'Size', 0.4, 2.5, 0.05) + op;
    } else {
      S += fsel(L, 'oname', 'Origin place', nonSpatial) + fsel(L, 'olon', 'Origin longitude', numeric) + fsel(L, 'olat', 'Origin latitude', numeric) + fsel(L, 'dname', 'Destination place', nonSpatial) + fsel(L, 'dlon', 'Destination longitude', numeric) + fsel(L, 'dlat', 'Destination latitude', numeric) +
        fsel(L, 'width', 'Measure (width)', numeric) + fsel(L, 'color', 'Colour by', nonSpatial) + fsel(L, 'time', 'Time field', timeable);
      V += pal + fx + sel('top', 'Routes shown', [[0, 'All'], [10, 'Top 10'], [25, 'Top 25'], [50, 'Top 50'], [100, 'Top 100'], [250, 'Top 250']], +st.top) + rng(L, 'lw', 'Line width', 0.3, 3, 0.05) + rng(L, 'curve', 'Curve', 0, 0.5, 0.02) + op +
        sel('ends', 'Route ends', [['dots', 'Dots'], ['arrows', 'Arrowheads'], ['none', 'Plain lines']], endsOf(st)) + chk(L, 'anim', 'Animate flow') + '<label class="chk"><input type="checkbox" data-l="' + L.id + '" data-k="st.nlab"' + (st.nlab !== false ? ' checked' : '') + '>&nbsp;Show labels</label>';
    }
    const plist = (TX.params && TX.params.list) || [];          // measure swapper: name the measure after a parameter
    S += plist.length || L.param ? '<label title="For a sheet whose measure is switched by a parameter: the legend and tooltips name the measure after the parameter\'s current value">Name the measure from parameter<select data-l="' + L.id + '" data-k="param"><option value="">(none)</option>' + plist.map(q => '<option value="' + esc(q.name) + '"' + (q.name === L.param ? ' selected' : '') + '>' + esc(trunc(q.name, 26)) + '</option>').join('') + (L.param && !plist.some(q => q.name === L.param) ? '<option value="' + esc(L.param) + '" selected>' + esc(trunc(L.param, 22)) + ' (not found)</option>' : '') + '</select></label>' + (L.param && paramLabel(L.param) ? '<div class="sub">Now showing: <b>' + esc(paramLabel(L.param)) + '</b></div>' : '') : '';
    return { setup: S, view: V };
  }
  function diagText() {
    const i = TX.settings.info, hm = d => d.toTimeString().slice(0, 8);
    if (TX.demo) return 'Demo mode: settings are not stored.';
    return 'At start the workbook held ' + (i.loaded == null ? '?' : i.loaded) + ' saved setting(s)' + (i.restored.length ? ', and ' + i.restored.length + ' were restored from the copy kept on this computer' : '') + '. ' +
      'Layers now: ' + layers.length + '. ' + (i.last ? (i.last.ok ? 'Last save ' + hm(i.last.at) + ': OK, workbook now holds ' + i.last.keys + ' setting(s).' : 'Last save ' + hm(i.last.at) + ' FAILED: ' + i.last.error) : 'Nothing saved yet this session.');
  }
  TX.settings.onSaved = () => { const e = $('diag'); if (e) e.textContent = diagText(); const i = TX.settings.info; if (i.last && i.last.ok && /could not be saved/.test(hint.innerHTML)) show(''); };
  const isViewing = () => typeof TX.mode === 'function' && TX.mode() === 'viewing';          // a viewer (not the author) of the workbook
  function renderPanel() {
    const sc = pbody.scrollTop, sc2 = pbody2 ? pbody2.scrollTop : 0;
    const radio = (g, label, pairs, cur) => '<div class="rad"><span class="rl">' + label + '</span>' + pairs.map(([v, n]) => '<label class="chk"><input type="radio" name="r-' + g + '" data-g="' + g + '" value="' + v + '"' + (cur === v ? ' checked' : '') + '>&nbsp;' + n + '</label>').join('') + '</div>';
    const startView = '<label title="Where the map opens, and where the home button goes">Start view<select data-g="sv"><option value="fit"' + (G.sv === 'fit' ? ' selected' : '') + '>Fit to the data</option><option value="world"' + (G.sv === 'world' ? ' selected' : '') + '>Whole world</option><option value="fixed"' + (G.sv === 'fixed' ? ' selected' : '') + '>Saved view</option></select></label>' +
      '<div class="sv"><button type="button" data-act="setview" title="Pan and zoom first, then press this">Use current view as start</button>' + (G.sv === 'fixed' && !G.fixed ? ' <span class="sub">none saved yet</span>' : '') + '</div>';
    let c1 = '<div class="grp">' + radio('map', 'Map', [['flat', 'Flat'], ['globe', 'Globe (3D)']], G.map) +
      (G.map === 'globe' ? '<label class="chk"><input type="checkbox" data-g="rot"' + (G.rot ? ' checked' : '') + '>&nbsp;Auto-rotate the globe</label>' + (G.rot ? '<label>Rotation speed<input type="range" data-g="rs" min="1" max="30" step="1" value="' + G.rs + '"></label>' : '') : '') +
      radio('style', 'Style', [['dark', 'Dark'], ['light', 'Light']], G.style) +
      '<label class="chk"><input type="checkbox" data-g="base"' + (G.base ? ' checked' : '') + '>&nbsp;Show country base map</label></div>';
    // Time line: only the options that can do something for the layers that are on. (Options that would have no effect are not offered.)
    const live = models.filter(m => m.L.on && m.f.time);
    const showOpts = live.some(m => m.L.type !== 'cartogram'), fadeOpts = live.some(m => ['symbols', 'tracks', 'density'].includes(m.L.type));
    c1 += '<div class="grp"><div class="lh">Time line <span class="sub">' + (T.steps.length > 1 ? '(' + T.steps.length + ' steps)' : '(no time field in use)') + '</span></div>' + (T.steps.length > 1 ?
      (showOpts ? '<label>Show<select data-g="tm"><option value="period"' + (G.tm === 'period' ? ' selected' : '') + '>This step only</option><option value="cum"' + (G.tm === 'cum' ? ' selected' : '') + '>Everything up to this step</option><option value="trail"' + (G.tm === 'trail' ? ' selected' : '') + '>The last few steps</option></select></label>' +
        (G.tm === 'trail' ? '<label>Steps kept<input type="range" data-g="tn" min="2" max="12" step="1" value="' + G.tn + '"></label>' : '') : '') +
      '<label>Step by<select data-g="tg"><option value="exact"' + (G.tg === 'exact' ? ' selected' : '') + '>Each date value</option><option value="year"' + (G.tg === 'year' ? ' selected' : '') + '>Year</option><option value="month"' + (G.tg === 'month' ? ' selected' : '') + '>Month</option><option value="day"' + (G.tg === 'day' ? ' selected' : '') + '>Day</option></select></label>' +
      '<label>Speed<input type="range" data-g="tsp" min="0.25" max="6" step="0.25" value="' + G.tsp + '"></label><label class="chk"><input type="checkbox" data-g="tloop"' + (G.tloop ? ' checked' : '') + '>&nbsp;Loop</label>' +
      '<label class="chk" title="Adds an All button to the play bar. Off: the map always shows one date. A cartogram adds the dates up when All is used"><input type="checkbox" data-g="tall"' + (allowAll() ? ' checked' : '') + '>&nbsp;Allow "All dates" on the time line</label>' +
      (fadeOpts ? '<label class="chk" title="Marks from earlier steps become more transparent the older they are (symbols, tracks and density)"><input type="checkbox" data-g="fade"' + (G.fade ? ' checked' : '') + '>&nbsp;Fade out older marks</label>' + (G.fade ? '<label>Fade over (steps)<input type="range" data-g="fn" min="1" max="30" step="1" value="' + G.fn + '"></label>' : '') : '')
      : '<div class="sub">Choose a date field under <b>Time field</b> in the layer to get a play button.</div>') + '</div>';
    const head = L => '<summary><button type="button" data-act="toggle" class="chev" title="Show / hide the settings"></button><input type="checkbox" data-l="' + L.id + '" data-k="on" title="Show / hide"' + (L.on ? ' checked' : '') + '> <input class="nm" type="text" data-l="' + L.id + '" data-k="name" value="' + esc(L.name) + '"> ' +
      (DASH ? '<button type="button" data-act="up" data-l="' + L.id + '" title="Draw later (on top)">&uarr;</button><button type="button" data-act="down" data-l="' + L.id + '" title="Draw earlier">&darr;</button><button type="button" data-act="del" data-l="' + L.id + '" title="Remove layer">&times;</button>' : '') + '</summary>';
    const legendChk = L => '<label class="chk" title="Show a legend card for this layer"><input type="checkbox" data-l="' + L.id + '" data-k="st.legend"' + (L.st.legend !== false ? ' checked' : '') + '>&nbsp;Legend card</label>';
    const activeChk = L => L.type === 'density' ? '' : '<label class="chk" title="Off: the layer is only drawn. Hover and tooltips ignore it"><input type="checkbox" data-l="' + L.id + '" data-k="st.active"' + (L.st.active !== false ? ' checked' : '') + '>&nbsp;Interactive</label>';          // a density layer has nothing to hover
    const addCtl = (DASH || !layers.length) ? '<div class="add"><select id="addType">' + Object.entries(TYPES).filter(([k]) => !(DASH && k === 'cartogram')).map(([k, v]) => '<option value="' + k + '">' + v + '</option>').join('') + '</select><button type="button" data-act="add">+ Add layer</button></div>' : '';
    const autoNote = auto && layers.length ? '<div class="sub">' + (DASH ? 'One layer was set up for each sheet that has map fields. Change anything here to take control.' : 'The layer was set up automatically from the Marks card. Change anything here to take control.') + '</div>' : '';
    const me = [...document.scripts].find(x => /map-studio\.js/.test(x.src)), ver = me && (me.src.match(/[?&]v=(\d+)/) || [])[1];
    const colsOf = DASH ? Object.entries(D.sheets).flatMap(([n, sh]) => sh.cols.map(c => n + ': ' + c.name + ' (' + c.dataType + ')')) : D.cols.map(c => c.name + ' (' + c.dataType + ')');
    const fieldsSent = '<details class="fl"><summary class="sub">Fields Tableau sent (' + colsOf.length + ')</summary><div class="sub">' + (colsOf.map(esc).join('<br>') || 'none') + '</div></details>';
    const maint = fieldsSent + '<div class="sv"><button type="button" data-act="reload" title="Save your settings and download the latest version of this extension. Then use the Reload option in Tableau">Save &amp; fetch latest</button> <span class="sub">' + (ver ? 'version ' + ver : '') + '</span></div><div class="sub" id="diag">' + esc(diagText()) + '</div>';
    // Card 1 (Map) = what everyone can change; Card 2 (Layer setup) = what the map is built from, for the author
    let c2 = '<div class="grp"><div class="lh">Where the map opens</div>' + startView + '</div>';          // the start view is the author's choice, so it lives in Layer setup
    if (DASH) {          // dashboard extension: one layer per sheet. Card 1 only turns layers on and off; each layer's setup and appearance are in Card 2
      c1 += '<div class="grp"><div class="lh">Layers</div>' + [...layers].reverse().map(L => '<label class="chk"><input type="checkbox" data-l="' + L.id + '" data-k="on"' + (L.on ? ' checked' : '') + '>&nbsp;' + esc(L.name) + '</label>').join('') + (layers.length ? '' : '<div class="sub">No layers yet.</div>') + '</div>';
      c2 += '<div class="lh">Layers <span class="sub">(top of the list is drawn last)</span></div>';
      [...layers].reverse().forEach(L => { const q = layerParts(L); c2 += '<details class="lyr" data-id="' + L.id + '"' + (openIds.has(L.id) ? ' open' : '') + '>' + head(L) + '<div class="lb"><div class="two">' + legendChk(L) + activeChk(L) + '</div>' + q.setup + q.view + '</div></details>'; });
    } else {
      layers.forEach(L => { const q = layerParts(L); c1 += '<div class="grp"><div class="lh">' + esc(L.name) + ' <span class="sub">appearance</span></div>' + legendChk(L) + q.view + '</div>'; c2 += '<details class="lyr" data-id="' + L.id + '" open>' + head(L) + '<div class="lb">' + activeChk(L) + q.setup + '</div></details>'; });
    }
    c2 += addCtl + autoNote + maint;
    pbody.innerHTML = c1; pbody.scrollTop = sc; pbody2.innerHTML = c2; pbody2.scrollTop = sc2; panel2.hidden = isViewing();
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
      if (k === 'tm' || k === 'tn' || k === 'tsp' || k === 'tloop' || k === 'fade' || k === 'fn') { applyTime(); redraw(); updateTL(); if (k === 'tm' || k === 'fade') renderPanel(); return; }
      if (k === 'sv') { applyFit(); flat.reset(); globe.reset(); homed = true; renderPanel(); redraw(); return; }
      if (k === 'map') { applyMap(); renderPanel(); } else if (k === 'style' || k === 'base') { applyStyle(); redraw(); } else { rebuild(); renderPanel(); }
      return;
    }
    const L = byId(t.dataset.l); if (!L) return; claim();
    let v = valueOf(t); if (t.dataset.k === 'st.top') v = +v;
    if (t.dataset.k === 'type' && [...Object.values(TYPES), 'Shapes', 'Symbols', 'Flows', 'Pies'].includes(L.name)) L.name = TYPES[v];      // keep an automatic name in step with the type
    setPath(L, t.dataset.k, v); persist();
    if (t.type === 'range') { if (t.dataset.k === 'st.hex') { persist(); rebuild(); } else if (t.dataset.k === 'st.cmorph' || t.dataset.k === 'st.cscl') { applyTime(); redraw(); } else { redraw(); tick(); } return; }
    if (t.dataset.k === 'on' || t.dataset.k.startsWith('st.') && !['st.ramp', 'st.dramp', 'st.color'].includes(t.dataset.k) && t.dataset.k !== 'st.top') { /* draw-time options */ }
    rebuild(); if (['type', 'lv', 'sheet', 'f.time', 'f.color', 'st.outline', 'on', 'param'].includes(t.dataset.k)) renderPanel();
  }
  const bodies = [pbody, pbody2].filter(Boolean);
  bodies.forEach(b => b.addEventListener('input', e => { if (e.target.type === 'range' || e.target.type === 'color') applyInput(e.target); }));
  bodies.forEach(b => b.addEventListener('change', e => { if (e.target.type !== 'range' && e.target.type !== 'color') applyInput(e.target); }));
  bodies.forEach(b => b.addEventListener('toggle', e => { const d = e.target; if (d.dataset && d.dataset.id) { d.open ? openIds.add(d.dataset.id) : openIds.delete(d.dataset.id); } }, true));
  const onClick = e => {
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
  };
  bodies.forEach(b => { b.addEventListener('click', onClick); b.addEventListener('pointerdown', e => e.stopPropagation()); });

  // ================= demo (outside Tableau): a union of three tables =================
  async function demoLoader() {
    if (new URLSearchParams(location.search).get('tracks')) {          // test: storm-like tracks that start and end at different dates
      const rows = [], NAMES = ['Ana', 'Ben', 'Carl', 'Dora', 'Eli', 'Faye', 'Gus', 'Hana'];
      NAMES.forEach((nm, i) => { const n = 10 + (i % 3) * 3, lat0 = 12 + (i % 4) * 4, lon0 = -80 + i * 6; for (let k = 0; k < n; k++) rows.push({ Storm: TX.cell(nm), Longitude: TX.cell(lon0 - k * 1.6), Latitude: TX.cell(lat0 + k * 0.9 + Math.sin(k / 2)), 'SUM(Wind)': TX.cell(20 + k * 15 + i * 5), 'SUM(Pressure)': TX.cell(1000 - k * 6 - i), Date: { value: new Date(2020, 0, 1 + i * 3 + k), formattedValue: 'd' } }); });
      G.fade = true; G.tm = 'cum'; G.fn = 6;
      return { rows, cols: [{ name: 'Storm', dataType: 'string' }, { name: 'Longitude', dataType: 'float' }, { name: 'Latitude', dataType: 'float' }, { name: 'SUM(Wind)', dataType: 'float' }, { name: 'SUM(Pressure)', dataType: 'float' }, { name: 'Date', dataType: 'date' }], enc: {},
        preset: [Object.assign(newLayer('tracks', 'Storms', 'demo-tracks'), { f: { lon: 'Longitude', lat: 'Latitude', group: 'Storm', time: 'Date', color: 'SUM(Wind)', width: 'SUM(Pressure)' } })] };
    }
    if (new URLSearchParams(location.search).get('data') === 'ne') {      // the Natural Earth countries as a plain spatial table
      const only = new URLSearchParams(location.search).get('only');      // e.g. only=Australia,New Zealand to test a regional view
      const rows = (await TX.fetchCSV('../data/ne_110m_countries.csv')).filter(r => !only || only.split(',').includes(r.Admin)).map(r => ({ Admin: TX.cell(r.Admin), Continent: TX.cell(r.Continent), 'SUM(Population)': TX.cell(Number(r.Population), fmt(Number(r.Population))), 'COLLECT(Geometry)': { value: r.Geometry, formattedValue: 'Polygon' } }));
      if (new URLSearchParams(location.search).get('nogeom')) {          // test: a table with country names, a year and a measure, but no spatial field (like World Indicators)
        const out = [], skew = new URLSearchParams(location.search).get('skew'), cf = { Europe: 60, 'North America': 40, Asia: 8, Africa: 1, 'South America': 4, Oceania: 30 }, mulOf = (nm, k, cont) => (1 + ((nm.length * 7 + k * 13) % 10) / 10 * k) * (skew ? (cf[cont] || 1) : 1);
        for (const r of rows) for (let k = 0; k < 3; k++) out.push({ Admin: r.Admin, Continent: r.Continent, 'YEAR(Year)': TX.cell(2010 + k), 'SUM(GDP)': TX.cell(Math.round(Number(r['SUM(Population)'].value) * mulOf(String(r.Admin.value), k, String(r.Continent.value)))), Calculation_1: TX.cell(Number(r['SUM(Population)'].value) / 1000) });          // a calculated field that Tableau types as text
        if (!new URLSearchParams(location.search).get('only')) for (const [nm, pop] of [['Singapore', 5.3e6], ['Malta', 4.2e5], ['Bahrain', 1.3e6], ['Hong Kong SAR, China', 7.2e6], ['Barbados', 2.8e5], ['Maldives', 3.4e5]]) for (let k = 0; k < 3; k++) out.push({ Admin: TX.cell(nm), Continent: TX.cell('Asia'), 'YEAR(Year)': TX.cell(2010 + k), 'SUM(GDP)': TX.cell(Math.round(pop * (1 + k * 0.2))) });
        return { rows: out, cols: [{ name: 'Admin', dataType: 'string' }, { name: 'Continent', dataType: 'string' }, { name: 'YEAR(Year)', dataType: 'int' }, { name: 'SUM(GDP)', dataType: 'float' }].concat(new URLSearchParams(location.search).get('calc') ? [{ name: 'Calculation_1', dataType: 'string' }] : []), enc: { location: [{ name: 'Admin' }] },
          preset: [Object.assign(newLayer('cartogram', TYPES.cartogram, 'demo-cartogram'), { f: {} })] };
      }
      const ty = new URLSearchParams(location.search).get('type');          // e.g. &type=cartogram opens the demo with that layer type
      const pre = ty && TYPES[ty] ? [Object.assign(newLayer(ty, TYPES[ty], 'demo-' + ty), { f: { geom: 'COLLECT(Geometry)', name: 'Admin', color: 'Continent', size: 'SUM(Population)' } })] : null;
      return { rows, cols: [{ name: 'Admin', dataType: 'string' }, { name: 'Continent', dataType: 'string' }, { name: 'SUM(Population)', dataType: 'float' }, { name: 'COLLECT(Geometry)', dataType: 'spatial' }],
        enc: { location: [{ name: 'Admin' }], color: [{ name: 'Continent' }] }, preset: pre };
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
