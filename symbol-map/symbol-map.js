/* Choice of symbol — Tableau viz extension.
   Encodings (see symbol-map.trex):
     lon, lat : measures giving the position of each mark (put the row-level id, e.g. Peak, on Detail)
     size     : measure -> symbol size
     color    : measure -> colour ramp
   The symbol shape is chosen from the dropdown inside the extension (saved with the workbook). */
(function () {
  'use strict';
  const { MapView, ramp, panel, esc, fmt } = Basemap;
  const ALT = [[0, '#52698a'], [0.3, '#a9b6c7'], [0.5, '#e8e4e3'], [0.68, '#f08c80'], [1, '#bf2f38']];
  const SHAPES = [['triangle', 'Triangle'], ['circle', 'Circle'], ['square', 'Square'], ['diamond', 'Diamond'], ['star', 'Star']];
  const content = document.getElementById('content');
  const hint = document.getElementById('hint');
  const note = document.getElementById('note');
  const shapeSel = document.getElementById('shape'), mkSlider = document.getElementById('mk');
  shapeSel.innerHTML = SHAPES.map(([k, n]) => '<option value="' + k + '">' + n + '</option>').join('');
  let model = null, shape = TX.settings.get('shape', 'triangle'), mk = parseFloat(TX.settings.get('mk', '1')) || 1;
  shapeSel.value = shape; mkSlider.value = mk;

  function symPath(c, kind, x, y, s) {
    c.beginPath();
    if (kind === 'circle') c.arc(x, y, s * 0.8, 0, 6.3);
    else if (kind === 'square') c.rect(x - s * 0.75, y - s * 0.75, s * 1.5, s * 1.5);
    else if (kind === 'diamond') { c.moveTo(x, y - s); c.lineTo(x + s * 0.8, y); c.lineTo(x, y + s); c.lineTo(x - s * 0.8, y); c.closePath(); }
    else if (kind === 'star') { for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.45 : s * 1.1, a = -Math.PI / 2 + i * Math.PI / 5; c[i ? 'lineTo' : 'moveTo'](x + r * Math.cos(a), y + r * Math.sin(a)); } c.closePath(); }
    else { c.moveTo(x, y - s); c.lineTo(x + s * 0.85, y + s * 0.7); c.lineTo(x - s * 0.85, y + s * 0.7); c.closePath(); }
  }
  const num = (r, f) => { const v = Number(r[f.name].value); return isFinite(v) && r[f.name].value !== null && r[f.name].value !== '' ? v : null; };

  function build(rows, enc) {
    const X = enc.lon && enc.lon[0], Y = enc.lat && enc.lat[0], S = enc.size && enc.size[0], C = enc.color && enc.color[0];
    if (!X || !Y) return null;
    const pts = []; let smin = 1e18, smax = -1e18, cmin = 1e18, cmax = -1e18;
    for (const r of rows) {
      const lon = num(r, X), lat = num(r, Y); if (lon == null || lat == null) continue;
      const s = S ? num(r, S) : null, c = C ? num(r, C) : null;
      if (s != null) { smin = Math.min(smin, s); smax = Math.max(smax, s); }
      if (c != null) { cmin = Math.min(cmin, c); cmax = Math.max(cmax, c); }
      pts.push({ lon, lat, s, c, row: r });
    }
    pts.forEach(p => { p.t = (C && p.c != null && cmax > cmin) ? (p.c - cmin) / (cmax - cmin) : 0.5; });
    pts.sort((a, b) => (b.s || 0) - (a.s || 0)); // big first, small on top
    return { pts, S, C, smin, smax, cmin, cmax };
  }
  const symSize = (p, m, v) => {
    const rel = (m.S && p.s != null && m.smax > 0) ? Math.max(0, p.s) / m.smax : 0.25; // size relative to the largest value
    return (3.5 + Math.sqrt(rel) * 7.5) * Math.min(1.7, 0.8 + v.z * 0.2) * mk;
  };

  function drawLegend(c, v, m) {
    c.font = '11px -apple-system, "Segoe UI", Arial, sans-serif'; c.textBaseline = 'middle';
    const w = 170, h = (m.C ? 54 : 0) + (m.S ? 56 : 0) + 6; if (!m.C && !m.S) return;
    const x = 8, y = Math.max(8, v.H - h - 22); panel(c, x, y, w, h);
    let yy = y + 14;
    if (m.C) {
      c.fillStyle = '#222'; c.font = 'bold 11px -apple-system, "Segoe UI", Arial, sans-serif'; c.fillText(m.C.name, x + 10, yy); c.font = '11px -apple-system, "Segoe UI", Arial, sans-serif';
      const g = c.createLinearGradient(x + 10, 0, x + w - 10, 0); ALT.forEach(s => g.addColorStop(s[0], s[1]));
      c.fillStyle = g; c.fillRect(x + 10, yy + 7, w - 20, 9); c.fillStyle = '#222'; c.textAlign = 'left'; c.fillText(fmt(Math.round(m.cmin)), x + 10, yy + 26);
      c.textAlign = 'right'; c.fillText(fmt(Math.round(m.cmax)), x + w - 10, yy + 26); c.textAlign = 'left'; yy += 48;
    }
    if (m.S) {
      c.fillStyle = '#222'; c.font = 'bold 11px -apple-system, "Segoe UI", Arial, sans-serif'; c.fillText(m.S.name, x + 10, yy); c.font = '11px -apple-system, "Segoe UI", Arial, sans-serif';
      let xx = x + 24; [0.1, 0.5, 1].forEach(f => {
        const s = (3.5 + Math.sqrt(f) * 7.5) * Math.min(1.7, 0.8 + v.z * 0.2) * mk;
        symPath(c, shape, xx, yy + 20, s); c.fillStyle = '#ccc'; c.fill(); c.strokeStyle = '#555'; c.lineWidth = 0.7; c.stroke();
        c.fillStyle = '#222'; c.textAlign = 'center'; c.fillText(fmt(Math.round(m.smax * f)), xx, yy + 42); c.textAlign = 'left'; xx += 50;
      });
    }
  }

  function draw(c, v) {
    if (!model) return;
    for (const p of model.pts) {
      const P = v.px(p.lon, p.lat); p._x = P[0]; p._y = P[1];
      if (P[0] < -20 || P[0] > v.W + 20 || P[1] < -20 || P[1] > v.H + 20) { p._s = 0; continue; }
      const s = p._s = symSize(p, model, v);
      symPath(c, shape, P[0], P[1], s);
      c.globalAlpha = 0.85; c.fillStyle = model.C ? ramp(ALT, p.t) : '#d9534f'; c.fill(); c.globalAlpha = 1;
      c.strokeStyle = 'rgba(0,0,0,.4)'; c.lineWidth = 0.5; c.stroke();
    }
    drawLegend(c, v, model);
  }

  function hover(x, y, e) {
    if (x == null || !model) { view.hideTip(); return; }
    let best = null, bd = 1e9;
    for (const p of model.pts) { if (!p._s) continue; const d = (p._x - x) ** 2 + (p._y - y) ** 2, lim = Math.max(64, p._s * p._s); if (d < bd && d < lim) { bd = d; best = p; } }
    if (!best) { view.hideTip(); return; }
    const names = Object.keys(best.row);
    // the first non-numeric field is the mark's title (e.g. the Peak name)
    const title = names.find(n => isNaN(Number(best.row[n].value))) || names[0];
    view.showTip('<b>' + esc(best.row[title].formattedValue) + '</b>' + names.filter(n => n !== title).map(n =>
      '<span class="k">' + esc(n) + ':</span> ' + esc(best.row[n].formattedValue)).join('<br>'), e);
  }

  const view = new MapView(content, { draw, onHover: hover });
  shapeSel.addEventListener('change', () => { shape = shapeSel.value; TX.settings.set('shape', shape); view.draw(); });
  mkSlider.addEventListener('input', () => { mk = +mkSlider.value; TX.settings.set('mk', String(mk)); view.draw(); });

  function show(msg) { hint.innerHTML = msg; hint.hidden = !msg; }
  function onData(d) {
    if (d.error) { show('<b>Something went wrong</b><br>' + esc(d.error)); return; }
    model = build(d.rows, d.enc);
    if (!model) { show('<b>Choice of symbol</b><br>Drag a measure to <b>Longitude</b> and one to <b>Latitude</b> on the Marks card, put an id (e.g. Peak) on <b>Detail</b>, then add <b>Size</b> and <b>Color</b> measures.'); view.draw(); note.textContent = ''; return; }
    show(model.pts.length ? '' : '<b>No marks to draw</b><br>No rows have both a longitude and a latitude.');
    note.textContent = model.pts.length + ' marks';
    view.draw();
  }

  async function demoLoader() {
    const rows = await TX.fetchCSV('../data/mountains.csv');
    const out = rows.filter(r => Number(r.Altitude) >= 3000 && r.Prominence !== '').map(r => ({
      Peak: TX.cell(r.Peak), 'SUM(Longitude)': TX.cell(Number(r.Longitude)), 'SUM(Latitude)': TX.cell(Number(r.Latitude)),
      'SUM(Prominence)': TX.cell(Number(r.Prominence), fmt(Number(r.Prominence))), 'SUM(Altitude)': TX.cell(Number(r.Altitude), fmt(Number(r.Altitude))) }));
    return { rows: out, enc: { lon: [{ name: 'SUM(Longitude)' }], lat: [{ name: 'SUM(Latitude)' }], size: [{ name: 'SUM(Prominence)' }], color: [{ name: 'SUM(Altitude)' }] } };
  }
  TX.ready(() => { shape = TX.settings.get('shape', shape); mk = parseFloat(TX.settings.get('mk', String(mk))) || 1; shapeSel.value = shape; mkSlider.value = mk; });
  TX.start(onData, demoLoader);
})();
