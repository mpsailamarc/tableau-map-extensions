/* Orthographic 3D globe (canvas), ported from the GlobeMap class in advanced-maps-gallery.html.
   Needs window.WORLD and common/basemap.js. Exposes Basemap.GlobeView. */
(function () {
  'use strict';
  const D2R = Math.PI / 180;
  // every country ring as unit-sphere xyz
  const RINGS = [];
  window.WORLD.forEach(c => c.r.forEach(r => {
    const n = r.length / 2, o = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const l = r[2 * i] / 20 * D2R, p = r[2 * i + 1] / 20 * D2R, cp = Math.cos(p); o[3 * i] = cp * Math.cos(l); o[3 * i + 1] = cp * Math.sin(l); o[3 * i + 2] = Math.sin(p); }
    RINGS.push(o);
  }));
  const THEMES = {
    dark: { bg: '#0b1118', o0: '#27415c', o1: '#10202f', land: '#46505b', stroke: '#6b7783', grat: 'rgba(255,255,255,.09)', limb: 'rgba(160,200,255,.5)', atmo: 'rgba(90,150,220,.35)' },
    light: { bg: '#dbe6ea', o0: '#cfe0e7', o1: '#a9c2cc', land: '#f3f2ee', stroke: '#b4b4ae', grat: 'rgba(0,0,0,.08)', limb: 'rgba(60,90,110,.5)', atmo: 'rgba(90,150,200,.3)' }
  };

  class GlobeView {
    constructor(host, opts) {
      this.host = host; this.opts = opts || {}; this.theme = THEMES.dark;
      this.cv = document.createElement('canvas'); host.appendChild(this.cv); this.ctx = this.cv.getContext('2d');
      this.tip = document.createElement('div'); this.tip.className = 'tip'; host.appendChild(this.tip);
      this.showLand = true; this.homeK = 1; this.homeLon = 125; this.homeLat = -18; this.lon = 125; this.lat = -18; this.k = 1; this.W = 0; this.H = 0; this.dpr = 1; this.hits = [];
      const zc = document.createElement('div'); zc.className = 'zoomctl globectl'; host.appendChild(zc); this.zc = zc;
      zc.innerHTML = '<button title="Zoom in">+</button><button title="Zoom out">&minus;</button><button title="Reset view">&#8962;</button>';
      const [bi, bo, br] = zc.querySelectorAll('button');
      bi.onclick = () => this.zoomBy(1.4); bo.onclick = () => this.zoomBy(1 / 1.4); br.onclick = () => { this.reset(); this.draw(); };
      this.bind();
      new ResizeObserver(() => this.resize()).observe(host);
      this.setVisible(false);
    }
    setTheme(name) { this.theme = THEMES[name] || THEMES.dark; }
    setHome(lon, lat) { this.homeLon = lon; this.homeLat = lat; }
    reset() { this.lon = this.homeLon; this.lat = this.homeLat; this.k = this.homeK || 1; }
    setHomeK(k) { this.homeK = k; }
    /* screen -> [lon, lat] or null when off the globe */
    inv(x, y) {
      this.prep(); const R = this.R, u = (x - this.cx) / R, v = -(y - this.cy) / R, q = u * u + v * v; if (q > 1) return null;
      const w = Math.sqrt(1 - q), x1 = w * this.cp - v * this.sp, Z = v * this.cp + w * this.sp, X = x1 * this.cl - u * this.sl, Y = x1 * this.sl + u * this.cl;
      return [Math.atan2(Y, X) / D2R, Math.asin(Math.max(-1, Math.min(1, Z))) / D2R];
    }
    setVisible(v) { this.visible = v; this.cv.style.display = v ? 'block' : 'none'; this.zc.style.display = v ? 'flex' : 'none'; if (!v) this.hideTip(); else this.resize(); }
    resize() {
      const W = this.host.clientWidth, H = this.host.clientHeight; if (!W || !H) return;
      this.dpr = Math.min(2, window.devicePixelRatio || 1); this.W = W; this.H = H;
      this.cv.width = Math.round(W * this.dpr); this.cv.height = Math.round(H * this.dpr); this.cv.style.width = W + 'px'; this.cv.style.height = H + 'px';
      if (this.visible) this.draw();
    }
    get R() { return Math.min(this.W, this.H) * 0.45 * this.k; }
    zoomBy(f) { this.k = Math.max(0.6, Math.min(12, this.k * f)); this.draw(); }
    prep() { const l = this.lon * D2R, p = this.lat * D2R; this.cl = Math.cos(l); this.sl = Math.sin(l); this.cp = Math.cos(p); this.sp = Math.sin(p); this.cx = this.W / 2; this.cy = this.H / 2; }
    /* unit vector -> [screen x, screen y, depth (>0 = facing us), distance from centre in globe radii] */
    vv(X, Y, Z, r = 1) {
      const x1 = X * this.cl + Y * this.sl, y1 = -X * this.sl + Y * this.cl, u = y1, v = Z * this.cp - x1 * this.sp, w = x1 * this.cp + Z * this.sp, R = this.R;
      return [this.cx + R * r * u, this.cy - R * r * v, w, r * Math.hypot(u, v)];
    }
    ll(lon, lat, r = 1) { const l = lon * D2R, p = lat * D2R, cp = Math.cos(p); return this.vv(cp * Math.cos(l), cp * Math.sin(l), Math.sin(p), r); }
    landPath(c, xyz, append) {
      const n = xyz.length / 3, U = new Float32Array(n), V = new Float32Array(n), Wd = new Float32Array(n), R = this.R, cx = this.cx, cy = this.cy;
      let s = -1;
      for (let i = 0; i < n; i++) {
        const X = xyz[3 * i], Y = xyz[3 * i + 1], Z = xyz[3 * i + 2], x1 = X * this.cl + Y * this.sl, y1 = -X * this.sl + Y * this.cl;
        U[i] = y1; V[i] = Z * this.cp - x1 * this.sp; Wd[i] = x1 * this.cp + Z * this.sp; if (s < 0 && Wd[i] > 0) s = i;
      }
      if (s < 0) return false;
      if (!append) c.beginPath();
      c.moveTo(cx + R * U[s], cy - R * V[s]);
      let prev = s, exitA = 0;
      for (let k = 1; k <= n; k++) {
        const cur = (s + k) % n, pw = Wd[prev], qw = Wd[cur];
        if (pw > 0 && qw > 0) c.lineTo(cx + R * U[cur], cy - R * V[cur]);
        else if (pw > 0 && qw <= 0) { const t = pw / (pw - qw), iu = U[prev] + (U[cur] - U[prev]) * t, iv = V[prev] + (V[cur] - V[prev]) * t, L = Math.hypot(iu, iv) || 1; exitA = Math.atan2(iv, iu); c.lineTo(cx + R * iu / L, cy - R * iv / L); }
        else if (pw <= 0 && qw > 0) {
          const t = pw / (pw - qw), iu = U[prev] + (U[cur] - U[prev]) * t, iv = V[prev] + (V[cur] - V[prev]) * t, L = Math.hypot(iu, iv) || 1;
          let d = Math.atan2(iv, iu) - exitA; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
          const st = Math.max(1, Math.ceil(Math.abs(d) / 0.12)); for (let j = 1; j <= st; j++) { const a = exitA + d * j / st; c.lineTo(cx + R * Math.cos(a), cy - R * Math.sin(a)); }
          c.lineTo(cx + R * iu / L, cy - R * iv / L); c.lineTo(cx + R * U[cur], cy - R * V[cur]);
        }
        prev = cur;
      }
      c.closePath(); return true;
    }
    draw() {
      if (!this.visible || !this.W) return;
      this.prep(); const c = this.ctx, R = this.R, cx = this.cx, cy = this.cy, T = this.theme;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); c.fillStyle = T.bg; c.fillRect(0, 0, this.W, this.H);
      let g = c.createRadialGradient(cx, cy, R * 0.98, cx, cy, R * 1.12); g.addColorStop(0, T.atmo); g.addColorStop(1, 'rgba(90,150,220,0)');
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, R * 1.12, 0, 6.3); c.fill();
      g = c.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R); g.addColorStop(0, T.o0); g.addColorStop(1, T.o1);
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, R, 0, 6.3); c.fill();
      c.strokeStyle = T.grat; c.lineWidth = 1; c.beginPath();
      for (let lo = -180; lo < 180; lo += 30) { let pen = false; for (let la = -90; la <= 90; la += 4) { const P = this.ll(lo, la); if (P[2] > 0) { pen ? c.lineTo(P[0], P[1]) : c.moveTo(P[0], P[1]); pen = true; } else pen = false; } }
      for (let la = -60; la <= 60; la += 30) { let pen = false; for (let lo = -180; lo <= 180; lo += 4) { const P = this.ll(lo, la); if (P[2] > 0) { pen ? c.lineTo(P[0], P[1]) : c.moveTo(P[0], P[1]); pen = true; } else pen = false; } }
      c.stroke();
      c.fillStyle = T.land; c.strokeStyle = T.stroke; c.lineWidth = 0.7;
      if (this.showLand) for (const xyz of RINGS) if (this.landPath(c, xyz)) { c.fill(); c.stroke(); }
      c.beginPath(); c.arc(cx, cy, R, 0, 6.3); c.strokeStyle = T.limb; c.lineWidth = 1.2; c.stroke();
      this.hits = []; if (this.opts.draw) this.opts.draw(c, this);
    }
    bind() {
      const cv = this.cv; let drag = null;
      cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, lon: this.lon, lat: this.lat }; cv.classList.add('drag'); this.hideTip(); if (this.opts.onGrab) this.opts.onGrab(); });
      cv.addEventListener('pointermove', e => {
        const r = cv.getBoundingClientRect();
        if (drag) {
          const f = 57.2958 / this.R; this.lon = drag.lon - (e.clientX - drag.x) * f; this.lat = Math.max(-85, Math.min(85, drag.lat + (e.clientY - drag.y) * f));
          this.lon = ((this.lon + 540) % 360) - 180; this.draw(); return;
        }
        if (this.opts.onHover) this.opts.onHover(e.clientX - r.left, e.clientY - r.top, e, this);
      });
      const end = () => { drag = null; cv.classList.remove('drag'); };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
      cv.addEventListener('pointerleave', () => { if (!drag && this.opts.onHover) this.opts.onHover(null); });
      cv.addEventListener('wheel', e => { e.preventDefault(); this.zoomBy(Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
    }
    showTip(html, e) { Basemap.MapView.prototype.showTip.call(this, html, e); }
    hideTip() { this.tip.style.display = 'none'; }
  }
  Basemap.GlobeView = GlobeView;
})();
