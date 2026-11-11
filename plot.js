/* plot.js — canvas step-function plot with shaded bands, zoom and PNG export.
 * No dependencies. Series are always drawn as step functions (value held until the next point).
 */
(function (root) {
  'use strict';

  function niceTicks(min, max, count) {
    if (!(max > min)) { max = min + 1; }
    const span = max - min, raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }

  function fmt(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e5 || a < 1e-3) return v.toExponential(1);
    return String(+v.toPrecision(4));
  }

  function lowerBound(xs, v) { // first index with xs[i] >= v
    let lo = 0, hi = xs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  }

  class StepPlot {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.data = null;
      this.view = null;
      this.full = null;
      this.sel = null;
      this.m = { l: 64, r: 16, t: 34, b: 46 };
      this._bind();
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.draw()).observe(canvas);
    }

    // data: {title, xLabel, yLabel, series:[{name, color, x, y, lo?, hi?, width?, alpha?, legend?}]}
    setData(data, keepView) {
      this.data = data;
      if (!data) { this.draw(); return; }
      let x0 = Infinity, x1 = -Infinity, y1 = 0;
      for (const s of data.series) {
        if (!s.x.length) continue;
        x0 = Math.min(x0, s.x[0]); x1 = Math.max(x1, s.x[s.x.length - 1]);
        const top = s.hi || s.y;
        for (let i = 0; i < top.length; i++) if (top[i] > y1) y1 = top[i];
      }
      if (!isFinite(x0)) { x0 = 0; x1 = 1; }
      if (x1 <= x0) x1 = x0 + 1;
      if (y1 <= 0) y1 = 1;
      this.full = { x0, x1, y0: 0, y1: y1 * 1.05 };
      if (!keepView || !this.view) this.view = Object.assign({}, this.full);
      this.draw();
    }

    resetView() { if (this.full) { this.view = Object.assign({}, this.full); this.draw(); } }

    toBlob(cb) { this.draw(); this.canvas.toBlob(cb, 'image/png'); }

    _plotRect() {
      const w = this.canvas.clientWidth || 600, h = this.canvas.clientHeight || 380;
      return { w, h, x: this.m.l, y: this.m.t, pw: Math.max(10, w - this.m.l - this.m.r), ph: Math.max(10, h - this.m.t - this.m.b) };
    }

    _bind() {
      const c = this.canvas;
      const pos = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      c.style.touchAction = 'none';
      c.addEventListener('pointerdown', e => {
        if (!this.data) return;
        const p = pos(e), r = this._plotRect();
        if (p.x < r.x || p.x > r.x + r.pw || p.y < r.y || p.y > r.y + r.ph) return;
        this.sel = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', e => {
        if (!this.sel) return;
        const p = pos(e); this.sel.x1 = p.x; this.sel.y1 = p.y; this.draw();
      });
      c.addEventListener('pointerup', e => {
        if (!this.sel) return;
        const s = this.sel; this.sel = null;
        if (Math.abs(s.x1 - s.x0) > 6 && Math.abs(s.y1 - s.y0) > 6) {
          const a = this._toData(Math.min(s.x0, s.x1), Math.max(s.y0, s.y1));
          const b = this._toData(Math.max(s.x0, s.x1), Math.min(s.y0, s.y1));
          this.view = { x0: a.x, x1: b.x, y0: Math.max(0, a.y), y1: b.y };
        }
        this.draw();
      });
      c.addEventListener('dblclick', () => this.resetView());
      c.addEventListener('wheel', e => {
        if (!this.data) return;
        e.preventDefault();
        const p = pos(e), d = this._toData(p.x, p.y), f = e.deltaY < 0 ? 0.8 : 1.25, v = this.view;
        this.view = {
          x0: d.x - (d.x - v.x0) * f, x1: d.x + (v.x1 - d.x) * f,
          y0: Math.max(0, d.y - (d.y - v.y0) * f), y1: d.y + (v.y1 - d.y) * f
        };
        this.draw();
      }, { passive: false });
    }

    _toData(px, py) {
      const r = this._plotRect(), v = this.view;
      return { x: v.x0 + (px - r.x) / r.pw * (v.x1 - v.x0), y: v.y1 - (py - r.y) / r.ph * (v.y1 - v.y0) };
    }

    draw() {
      const cv = this.canvas, ctx = this.ctx;
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const r = this._plotRect();
      if (cv.width !== Math.round(r.w * dpr) || cv.height !== Math.round(r.h * dpr)) { cv.width = Math.round(r.w * dpr); cv.height = Math.round(r.h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, r.w, r.h);
      if (!this.data) {
        ctx.fillStyle = '#6b7280'; ctx.font = '14px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Press Run to see a trajectory here', r.w / 2, r.h / 2);
        return;
      }
      const v = this.view;
      const X = x => r.x + (x - v.x0) / (v.x1 - v.x0) * r.pw;
      const Y = y => r.y + (1 - (y - v.y0) / (v.y1 - v.y0)) * r.ph;

      // grid + ticks
      ctx.font = '12px system-ui, sans-serif'; ctx.lineWidth = 1;
      ctx.strokeStyle = '#e5e7eb'; ctx.fillStyle = '#374151';
      ctx.textAlign = 'center';
      for (const t of niceTicks(v.x0, v.x1, Math.max(3, r.pw / 90))) {
        const px = Math.round(X(t)) + 0.5; ctx.beginPath(); ctx.moveTo(px, r.y); ctx.lineTo(px, r.y + r.ph); ctx.stroke();
        ctx.fillText(fmt(t), px, r.y + r.ph + 16);
      }
      ctx.textAlign = 'right';
      for (const t of niceTicks(v.y0, v.y1, Math.max(3, r.ph / 50))) {
        const py = Math.round(Y(t)) + 0.5; ctx.beginPath(); ctx.moveTo(r.x, py); ctx.lineTo(r.x + r.pw, py); ctx.stroke();
        ctx.fillText(fmt(t), r.x - 8, py + 4);
      }
      ctx.strokeStyle = '#9ca3af'; ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.pw, r.ph);

      // series (clipped to the plot area)
      ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.pw, r.ph); ctx.clip();
      for (const s of this.data.series) if (s.lo && s.hi) this._band(s, X, Y);
      for (const s of this.data.series) this._line(s, X, Y, r);
      ctx.restore();

      // labels
      ctx.fillStyle = '#111827'; ctx.textAlign = 'left'; ctx.font = '600 14px system-ui, sans-serif';
      if (this.data.title) ctx.fillText(this.data.title, r.x, 20);
      ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#374151'; ctx.textAlign = 'center';
      if (this.data.xLabel) ctx.fillText(this.data.xLabel, r.x + r.pw / 2, r.h - 8);
      if (this.data.yLabel) { ctx.save(); ctx.translate(14, r.y + r.ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(this.data.yLabel, 0, 0); ctx.restore(); }

      // legend
      let lx = r.x + 8; const ly = r.y + 14;
      ctx.textAlign = 'left';
      for (const s of this.data.series) {
        if (s.legend === false || !s.name) continue;
        const wText = ctx.measureText(s.name).width;
        if (lx + wText + 30 > r.x + r.pw) break;
        ctx.fillStyle = s.color; ctx.fillRect(lx, ly - 8, 14, 3 + (s.width || 1.6));
        ctx.fillStyle = '#111827'; ctx.fillText(s.name, lx + 20, ly);
        lx += wText + 36;
      }

      if (this.sel) {
        const s = this.sel;
        ctx.fillStyle = 'rgba(37,99,235,0.12)'; ctx.strokeStyle = '#2563eb';
        ctx.fillRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
        ctx.strokeRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
      }
    }

    _band(s, X, Y) {
      const ctx = this.ctx, n = s.x.length;
      if (!n) return;
      ctx.beginPath();
      ctx.moveTo(X(s.x[0]), Y(s.hi[0]));
      for (let i = 1; i < n; i++) { ctx.lineTo(X(s.x[i]), Y(s.hi[i - 1])); ctx.lineTo(X(s.x[i]), Y(s.hi[i])); }
      ctx.lineTo(X(s.x[n - 1]), Y(s.lo[n - 1]));
      for (let i = n - 1; i >= 1; i--) { ctx.lineTo(X(s.x[i]), Y(s.lo[i])); ctx.lineTo(X(s.x[i - 1]), Y(s.lo[i - 1])); }
      ctx.closePath();
      ctx.globalAlpha = 0.2; ctx.fillStyle = s.color; ctx.fill(); ctx.globalAlpha = 1;
    }

    _line(s, X, Y, r) {
      const ctx = this.ctx, xs = s.x, ys = s.y, n = xs.length, v = this.view;
      if (!n) return;
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6; ctx.lineJoin = 'miter';
      ctx.globalAlpha = s.alpha === undefined ? 1 : s.alpha;
      const i0 = Math.max(0, lowerBound(xs, v.x0) - 1);
      const i1 = Math.min(n - 1, lowerBound(xs, v.x1) + 1);
      ctx.beginPath();
      if (i1 - i0 > 4 * r.pw) {
        // far more points than pixels: draw a min/max envelope per pixel column
        let col = null, mn = 0, mx = 0;
        const flush = () => { if (col !== null) { ctx.moveTo(col + 0.5, Y(mn)); ctx.lineTo(col + 0.5, Y(mx)); } };
        for (let i = i0; i <= i1; i++) {
          const c = Math.floor(X(xs[i]));
          if (c !== col) { flush(); col = c; mn = mx = ys[i]; }
          else { if (ys[i] < mn) mn = ys[i]; if (ys[i] > mx) mx = ys[i]; }
        }
        flush();
      } else {
        ctx.moveTo(X(xs[i0]), Y(ys[i0]));
        for (let i = i0 + 1; i <= i1; i++) { ctx.lineTo(X(xs[i]), Y(ys[i - 1])); ctx.lineTo(X(xs[i]), Y(ys[i])); }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // small histogram used by the V1 figure
  function drawHistogram(canvas, hist, title, meanValue) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = canvas.clientWidth || 320, h = canvas.clientHeight || 200;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    const m = { l: 44, r: 10, t: 28, b: 32 }, pw = w - m.l - m.r, ph = h - m.t - m.b;
    const e = hist.edges, cmax = Math.max.apply(null, hist.counts) || 1, lo = e[0], hi = e[e.length - 1];
    const X = x => m.l + (x - lo) / (hi - lo) * pw, Y = c => m.t + ph - c / cmax * ph;
    ctx.fillStyle = '#2563eb';
    hist.counts.forEach((c, i) => { const x0 = X(e[i]), x1 = X(e[i + 1]); ctx.fillRect(x0 + 0.5, Y(c), Math.max(1, x1 - x0 - 1), m.t + ph - Y(c)); });
    ctx.strokeStyle = '#9ca3af'; ctx.strokeRect(m.l + 0.5, m.t + 0.5, pw, ph);
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = '#374151'; ctx.textAlign = 'center';
    for (const t of niceTicks(lo, hi, 5)) ctx.fillText(fmt(t), X(t), m.t + ph + 14);
    ctx.textAlign = 'right';
    for (const t of niceTicks(0, cmax, 3)) ctx.fillText(fmt(t), m.l - 5, Y(t) + 4);
    if (meanValue !== undefined && isFinite(meanValue)) { ctx.strokeStyle = '#dc2626'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(X(meanValue), m.t); ctx.lineTo(X(meanValue), m.t + ph); ctx.stroke(); ctx.setLineDash([]); }
    ctx.textAlign = 'left'; ctx.font = '600 12px system-ui, sans-serif'; ctx.fillStyle = '#111827';
    ctx.fillText(title, m.l, 17);
    ctx.textAlign = 'center'; ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = '#374151';
    ctx.fillText('final value (red line = mean)', m.l + pw / 2, h - 5);
  }

  root.StepPlot = StepPlot;
  root.drawHistogram = drawHistogram;
})(typeof window !== 'undefined' ? window : this);
