/* Pie charts as symbols — Tableau viz extension.
   Encodings (see pie-symbol-map.trex):
     location : country (ISO3 code or English name) -> where the pie sits
     slice    : dimension that splits each pie (e.g. Medal)
     value    : measure that sizes each slice (e.g. SUM(Medals)); pie area = total over its slices */
(function () {
  'use strict';
  const { MapView, findCountry, panel, esc, fmt } = Basemap;
  const MEDAL = { gold: '#f0c13d', silver: '#b6adaa', bronze: '#9a6b57' };
  const CAT = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'];
  const content = document.getElementById('content');
  const hint = document.getElementById('hint');
  const note = document.getElementById('note');
  const kSlider = document.getElementById('pk');
  let model = null, k = 1;

  const radius = (n, v) => (3.5 + Math.sqrt(n / model.max) * (22 + Math.min(14, v.z * 4))) * Math.min(1.3, 0.85 + v.z * 0.1) * k;

  function build(rows, enc) {
    const L = enc.location && enc.location[0], S = enc.slice && enc.slice[0], V = enc.value && enc.value[0];
    if (!L) return null;
    const pies = new Map(), sliceTot = new Map(), unmatched = new Set();
    for (const r of rows) {
      const lc = r[L.name]; if (!lc) continue;
      const c = findCountry(lc.formattedValue != null ? lc.formattedValue : lc.value);
      if (!c) { unmatched.add(String(lc.formattedValue)); continue; }
      const sName = S ? String(r[S.name].formattedValue) : 'Total';
      let v = V ? Number(r[V.name].value) : 1; if (!isFinite(v) || v <= 0) continue;
      let p = pies.get(c.iso); if (!p) { p = { c: c.c, name: c.n, s: new Map(), n: 0 }; pies.set(c.iso, p); }
      p.s.set(sName, (p.s.get(sName) || 0) + v); p.n += v;
      sliceTot.set(sName, (sliceTot.get(sName) || 0) + v);
    }
    let names = [...sliceTot.keys()];
    const medalOrder = ['gold', 'silver', 'bronze'];
    names.sort((a, b) => {
      const ia = medalOrder.indexOf(a.toLowerCase()), ib = medalOrder.indexOf(b.toLowerCase());
      if (ia >= 0 && ib >= 0) return ia - ib;
      return sliceTot.get(b) - sliceTot.get(a);
    });
    const color = new Map(); let ci = 0;
    names.forEach(n => color.set(n, MEDAL[n.toLowerCase()] || CAT[ci++ % CAT.length]));
    const list = [...pies.values()].sort((a, b) => b.n - a.n);
    return { pies: list, names, color, max: Math.max(1, ...list.map(p => p.n)), unmatched: [...unmatched],
      valName: V ? V.name : 'Row count', locName: L.name, sliceName: S ? S.name : '', total: list.reduce((a, p) => a + p.n, 0) };
  }

  function drawLegend(c, v) {
    const m = model, W = v.W, H = v.H;
    c.font = '11px -apple-system, "Segoe UI", Arial, sans-serif'; c.textBaseline = 'middle';
    const names = m.names.slice(0, 8), more = m.names.length - names.length;
    const lg = [1, Math.round(m.max / 2), m.max].filter((x, i, a) => a.indexOf(x) === i);
    const rs = lg.map(x => radius(x, { z: 1 }));
    const sizeH = Math.max(...rs) * 2 + 28, h = 14 + (m.sliceName ? 18 : 0) + names.length * 16 + (more > 0 ? 16 : 0) + 12 + sizeH;
    const w = Math.max(130, 24 + rs.reduce((a, r) => a + r * 2 + 14, 0));
    const x = 8, y = Math.max(8, H - h - 22);
    panel(c, x, y, w, h);
    let yy = y + 14; c.fillStyle = '#222';
    if (m.sliceName) { c.font = 'bold 11px -apple-system, "Segoe UI", Arial, sans-serif'; c.fillText(m.sliceName, x + 10, yy); yy += 18; c.font = '11px -apple-system, "Segoe UI", Arial, sans-serif'; }
    names.forEach(n => { c.fillStyle = m.color.get(n); c.fillRect(x + 10, yy - 5, 10, 10); c.strokeStyle = 'rgba(0,0,0,.4)'; c.strokeRect(x + 10, yy - 5, 10, 10); c.fillStyle = '#222'; c.fillText(n, x + 26, yy); yy += 16; });
    if (more > 0) { c.fillStyle = '#666'; c.fillText('+' + more + ' more', x + 26, yy); yy += 16; }
    yy += 6; c.fillStyle = '#222'; c.font = 'bold 11px -apple-system, "Segoe UI", Arial, sans-serif'; c.fillText(m.valName, x + 10, yy); c.font = '11px -apple-system, "Segoe UI", Arial, sans-serif';
    let xx = x + 12; const base = yy + 8 + Math.max(...rs) * 2;
    lg.forEach((val, i) => {
      const r = rs[i];
      c.beginPath(); c.arc(xx + r, base - r, r, 0, 6.3); c.fillStyle = '#ddd'; c.fill(); c.strokeStyle = '#555'; c.stroke();
      c.fillStyle = '#222'; c.textAlign = 'center'; c.fillText(fmt(val), xx + r, base + 8); c.textAlign = 'left';
      xx += r * 2 + 14;
    });
  }

  function draw(c, v) {
    if (!model) return;
    // largest first so small pies stay visible on top
    for (const p of model.pies) {
      const P = v.px(p.c[0], p.c[1]), r = radius(p.n, v);
      p._x = P[0]; p._y = P[1]; p._r = r;
      if (P[0] < -40 || P[0] > v.W + 40 || P[1] < -40 || P[1] > v.H + 40) continue;
      let a0 = -Math.PI / 2;
      for (const n of model.names) {
        const val = p.s.get(n); if (!val) continue;
        const a1 = a0 + val / p.n * Math.PI * 2;
        c.beginPath(); c.moveTo(P[0], P[1]); c.arc(P[0], P[1], r, a0, a1); c.closePath();
        c.fillStyle = model.color.get(n); c.fill(); a0 = a1;
      }
      c.beginPath(); c.arc(P[0], P[1], r, 0, 6.3); c.strokeStyle = 'rgba(0,0,0,.75)'; c.lineWidth = 1; c.stroke();
    }
    drawLegend(c, v);
  }

  function hover(x, y, e, v) {
    if (x == null || !model) { view.hideTip(); return; }
    let best = null, bd = 1e9;
    for (const p of model.pies) { const d = Math.hypot(p._x - x, p._y - y); if (d <= p._r && d < bd) { bd = d; best = p; } }
    if (!best) { view.hideTip(); return; }
    view.showTip('<b>' + esc(best.name) + '</b>' + model.names.filter(n => best.s.get(n)).map(n =>
      '<span style="color:' + model.color.get(n) + '">&#9632;</span> ' + esc(n) + ': <b style="display:inline">' + fmt(best.s.get(n)) + '</b>').join('<br>') +
      '<br><span class="k">Total ' + esc(model.valName) + ':</span> ' + fmt(best.n), e);
  }

  const view = new MapView(content, { draw, onHover: hover });
  kSlider.addEventListener('input', () => { k = +kSlider.value; TX.settings.set('pieK', String(k)); view.draw(); });
  k = parseFloat(TX.settings.get('pieK', '1')) || 1; kSlider.value = k;

  function show(msg) { hint.innerHTML = msg; hint.hidden = !msg; }
  function onData(d) {
    if (d.error) { show('<b>Something went wrong</b><br>' + esc(d.error)); return; }
    model = build(d.rows, d.enc);
    if (!model) { show('<b>Pie charts as symbols</b><br>Drag a <b>country</b> field (name or ISO3 code) to <b>Location</b>, a dimension to <b>Slice</b> and a measure to <b>Value</b> on the Marks card.'); view.draw(); note.textContent = ''; return; }
    show(model.pies.length ? '' : '<b>No marks to draw</b><br>No rows matched a country on the map. Check the field on <b>Location</b> holds country names or ISO3 codes.');
    note.textContent = model.unmatched.length ? model.unmatched.length + ' location value(s) not matched to a country: ' + model.unmatched.slice(0, 4).join(', ') + (model.unmatched.length > 4 ? '…' : '') : '';
    view.draw();
  }

  async function demoLoader() {
    const rows = await TX.fetchCSV('../data/olympic_medals.csv');
    const agg = new Map();
    rows.filter(r => r.Edition === '2008').forEach(r => { const key = r.Country + '|' + r.Medal; agg.set(key, (agg.get(key) || 0) + Number(r.Medals)); });
    const out = [...agg].map(([key, v]) => { const [c, m] = key.split('|'); return { Country: TX.cell(c), Medal: TX.cell(m), 'SUM(Medals)': TX.cell(v, fmt(v)) }; });
    return { rows: out, enc: { location: [{ name: 'Country' }], slice: [{ name: 'Medal' }], value: [{ name: 'SUM(Medals)' }] } };
  }
  TX.ready(() => { k = parseFloat(TX.settings.get('pieK', String(k))) || 1; kSlider.value = k; });
  TX.start(onData, demoLoader);
})();
