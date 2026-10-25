// Dependency-free scrolling heart-rate trace on <canvas>. Keeps the last
// WINDOW_MS of samples in a ring buffer and redraws on an animation frame so
// the line scrolls smoothly regardless of sample cadence.

const WINDOW_MS = 60_000; // 60s visible
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class HRTrace {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.samples = []; // {t, hr}
    this.running = false;
    this.#resize();
    this._onResize = () => this.#resize();
    window.addEventListener("resize", this._onResize);
  }

  #resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w; this.h = h;
  }

  push(hr) {
    const now = performance.timeOrigin + performance.now();
    this.samples.push({ t: now, hr });
    const cutoff = now - WINDOW_MS;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.#draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.#draw();
  }

  #draw() {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    this.#grid();
    if (this.samples.length < 2) return;

    const now = performance.timeOrigin + performance.now();
    const hrs = this.samples.map((s) => s.hr);
    let lo = Math.min(...hrs) - 6, hi = Math.max(...hrs) + 6;
    if (hi - lo < 25) { const mid = (hi + lo) / 2; lo = mid - 12.5; hi = mid + 12.5; }
    const x = (t) => w - ((now - t) / WINDOW_MS) * w;
    const y = (v) => h - ((v - lo) / (hi - lo)) * (h - 8) - 4;

    const stroke = cssVar("--hr") || "#e5484d";
    // area fill
    ctx.beginPath();
    ctx.moveTo(x(this.samples[0].t), h);
    for (const s of this.samples) ctx.lineTo(x(s.t), y(s.hr));
    ctx.lineTo(x(this.samples.at(-1).t), h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, this.#alpha(stroke, 0.22));
    grad.addColorStop(1, this.#alpha(stroke, 0));
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    this.samples.forEach((s, i) => (i ? ctx.lineTo(x(s.t), y(s.hr)) : ctx.moveTo(x(s.t), y(s.hr))));
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.shadowColor = stroke;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // leading dot
    const last = this.samples.at(-1);
    ctx.beginPath();
    ctx.arc(x(last.t), y(last.hr), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.fill();
  }

  #grid() {
    const { ctx, w, h } = this;
    ctx.strokeStyle = this.#alpha(cssVar("--line") || "#333", 0.6);
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gy = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }
  }

  // Accept an oklch()/hex color and apply alpha via color-mix-free fallback.
  #alpha(color, a) {
    if (color.startsWith("oklch")) return color.replace(")", ` / ${a})`);
    return `color-mix(in oklch, ${color} ${Math.round(a * 100)}%, transparent)`;
  }

  destroy() {
    this.stop();
    window.removeEventListener("resize", this._onResize);
  }
}
