/* Shared pan/zoom canvas world map (Mercator) used by the viz extensions.
   Ported from the hand-rolled map engine in advanced-maps-gallery.html.
   Needs window.WORLD (common/world.js). */
(function () {
  'use strict';
  const D2R = Math.PI / 180;
  const myOf = lat => {
    lat = Math.max(-84, Math.min(84, lat));
    const s = Math.sin(lat * D2R);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const mxOf = lon => (lon + 180) / 360;
  const THEME = { bg: '#dbe6ea', land: '#f3f2ee', stroke: '#b4b4ae' };

  // Pre-project every ring once to Mercator units (0..1)
  const LAND = window.WORLD.map(c => ({
    n: c.n, iso: c.i, c: c.c,
    rings: c.r.map(r => {
      const n = r.length / 2, mx = new Float32Array(n), my = new Float32Array(n);
      for (let i = 0; i < n; i++) { mx[i] = mxOf(r[2 * i] / 20); my[i] = myOf(r[2 * i + 1] / 20); }
      return { mx, my };
    })
  }));

  // ---- country lookup by ISO3 or (normalised) name ----
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  const byKey = new Map();
  LAND.forEach(c => { byKey.set(norm(c.iso), c); byKey.set(norm(c.n), c); });
  const ALIAS = {
    unitedstatesofamerica: 'USA', unitedstates: 'USA', us: 'USA', russianfederation: 'RUS', uk: 'GBR',
    unitedkingdom: 'GBR', greatbritain: 'GBR', southkorea: 'KOR', korearepublicof: 'KOR', republicofkorea: 'KOR',
    northkorea: 'PRK', czechia: 'CZE', czechrepublic: 'CZE', iranislamicrepublicof: 'IRN', vietnam: 'VNM'
  };
  Object.keys(ALIAS).forEach(k => { const c = byKey.get(norm(ALIAS[k])); if (c && !byKey.has(k)) byKey.set(k, c); });
  const findCountry = s => (s == null ? null : byKey.get(norm(s)) || null);

  // ---- colour helpers ----
  function hex2rgb(h) { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); }
  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const a = stops[i - 1], b = stops[i], u = (t - a[0]) / ((b[0] - a[0]) || 1);
        const ca = hex2rgb(a[1]), cb = hex2rgb(b[1]);
        return 'rgb(' + ca.map((v, k) => Math.round(v + (cb[k] - v) * u)).join(',') + ')';
      }
    }
    return stops[stops.length - 1][1];
  }

  class MapView {
    constructor(host, opts) {
      this.host = host; this.opts = opts || {};
      this.cv = document.createElement('canvas');
      host.appendChild(this.cv);
      this.ctx = this.cv.getContext('2d');
      this.tip = document.createElement('div'); this.tip.className = 'tip'; host.appendChild(this.tip);
      this.wrap = !!this.opts.wrap; this.showLand = true; this.hv = null; this.homeX = 0.53;   // wrap: draw the world 3x so routes can cross the date line
      this.z = 1; this.cx = this.homeX; this.cy = 0; this.W = 0; this.H = 0; this.dpr = 1;
      this.theme = THEME;
      const zc = document.createElement('div'); zc.className = 'zoomctl';
      zc.innerHTML = '<button title="Zoom in">+</button><button title="Zoom out">&minus;</button><button title="Reset view">&#8962;</button>';
      host.appendChild(zc);
      const [bi, bo, br] = zc.querySelectorAll('button');
      bi.onclick = () => this.zoomAt(this.W / 2, this.H / 2, 1.6);
      bo.onclick = () => this.zoomAt(this.W / 2, this.H / 2, 1 / 1.6);
      br.onclick = () => { this.reset(); this.draw(); };

      const cv = this.cv; let drag = null;
      cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy }; cv.classList.add('drag'); this.hideTip(); });
      cv.addEventListener('pointermove', e => {
        const r = cv.getBoundingClientRect();
        if (drag) {
          this.cx = drag.cx - (e.clientX - drag.x) / (this.S0 * this.z);
          this.cy = drag.cy - (e.clientY - drag.y) / (this.S0 * this.z);
          this.clampCenter(); this.draw();
        } else if (this.opts.onHover) this.opts.onHover(e.clientX - r.left, e.clientY - r.top, e, this);
      });
      const end = () => { drag = null; cv.classList.remove('drag'); };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
      cv.addEventListener('pointerleave', () => { if (this.opts.onHover) this.opts.onHover(null); });
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      }, { passive: false });
      cv.addEventListener('dblclick', e => { const r = cv.getBoundingClientRect(); this.zoomAt(e.clientX - r.left, e.clientY - r.top, 1.8); });
      new ResizeObserver(() => this.resize()).observe(host);
      this.resize(true);
    }
    resize(first) {
      const W = this.host.clientWidth, H = this.host.clientHeight;
      if (!W || !H) return;
      this.dpr = window.devicePixelRatio || 1;
      this.W = W; this.H = H;
      this.cv.width = Math.round(W * this.dpr); this.cv.height = Math.round(H * this.dpr);
      this.cv.style.width = W + 'px'; this.cv.style.height = H + 'px';
      const y0 = myOf(80), y1 = myOf(-58);
      this.S0 = Math.min(W / 1.0, H / (y1 - y0));
      this.homeY = (y0 + y1) / 2;
      if (first || this.cy === 0) this.cy = this.homeY;
      if (this.cv.style.display === 'none') return;
      this.draw();
    }
    reset() { if (this.hv) { this.z = this.hv.z; this.cx = this.hv.cx; this.cy = this.hv.cy; } else { this.z = 1; this.cx = this.homeX; this.cy = this.homeY; } }
    setHome(lon) { this.homeX = (lon + 180) / 360; }
    setHomeView(cx, cy, z) { this.hv = cx == null ? null : { cx, cy, z }; }
    /* screen -> [lon, lat] (lon normalised to -180..180) */
    inv(x, y) {
      const S = this.S0 * this.z, mx = this.cx + (x - this.W / 2) / S, my = this.cy + (y - this.H / 2) / S;
      return [((mx * 360 - 180 + 540) % 360 + 360) % 360 - 180, (2 * Math.atan(Math.exp(2 * Math.PI * (0.5 - my))) - Math.PI / 2) / D2R];
    }
    setVisible(v) { this.cv.style.display = v ? 'block' : 'none'; this.host.querySelector('.zoomctl').style.display = v ? 'flex' : 'none'; if (!v) this.hideTip(); else this.resize(); }
    clampCenter() {
      this.cx = this.wrap ? ((this.cx % 1) + 1) % 1 : Math.max(0, Math.min(1, this.cx));
      this.cy = Math.max(0.05, Math.min(0.95, this.cy));
    }
    zoomAt(x, y, f) {
      const nz = Math.max(1, Math.min(60, this.z * f)); f = nz / this.z;
      const S = this.S0 * this.z;
      const mx = this.cx + (x - this.W / 2) / S, my = this.cy + (y - this.H / 2) / S;
      this.z = nz; const S2 = this.S0 * this.z;
      this.cx = mx - (x - this.W / 2) / S2; this.cy = my - (y - this.H / 2) / S2;
      this.clampCenter(); this.draw();
    }
    px(lon, lat) {
      const S = this.S0 * this.z;
      return [(mxOf(lon) - this.cx) * S + this.W / 2, (myOf(lat) - this.cy) * S + this.H / 2];
    }
    draw() {
      if (!this.W) return;
      const c = this.ctx, S = this.S0 * this.z, W = this.W, H = this.H;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.fillStyle = this.theme.bg; c.fillRect(0, 0, W, H);
      c.fillStyle = this.theme.land; c.strokeStyle = this.theme.stroke; c.lineWidth = 0.6; c.lineJoin = 'round';
      if (this.showLand) for (const off of (this.wrap ? [-1, 0, 1] : [0])) for (const k of LAND) {
        c.beginPath();
        for (const r of k.rings) {
          const n = r.mx.length;
          for (let i = 0; i < n; i++) {
            const x = (r.mx[i] - this.cx + off) * S + W / 2, y = (r.my[i] - this.cy) * S + H / 2;
            if (i) c.lineTo(x, y); else c.moveTo(x, y);
          }
          c.closePath();
        }
        c.fill('evenodd'); c.stroke();
      }
      if (this.opts.draw) this.opts.draw(c, this);
    }
    showTip(html, e) {
      const t = this.tip; t.innerHTML = html; t.style.display = 'block';
      const r = this.host.getBoundingClientRect();
      let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
      if (x + t.offsetWidth > r.width - 4) x = e.clientX - r.left - t.offsetWidth - 14;
      if (y + t.offsetHeight > r.height - 4) y = r.height - t.offsetHeight - 4;
      t.style.left = Math.max(2, x) + 'px'; t.style.top = Math.max(2, y) + 'px';
    }
    hideTip() { this.tip.style.display = 'none'; }
  }

  // Rounded legend panel helper
  function panel(c, x, y, w, h) {
    c.fillStyle = 'rgba(255,255,255,.88)'; c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 1;
    c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, 6) : c.rect(x, y, w, h); c.fill(); c.stroke();
  }
  const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const fmt = n => Number(n).toLocaleString('en-US');

  window.Basemap = { MapView, findCountry, ramp, panel, esc, fmt, LAND, mxOf, myOf };
})();
