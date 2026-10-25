// A ring cut into the air with molten sparks. Sparks leave the rim
// tangentially, gravity drags them down, they cool from white to ember.

import { clamp, ease, lerp } from '../fx/motion';
import { Theme, type Flying, type Point } from './base';

const MAX = 2600;
const BUCKETS = 7;

export class Rift extends Theme {
  readonly id = 'rift' as const;

  private canvas!: HTMLCanvasElement;
  private c!: CanvasRenderingContext2D;
  private px = new Float32Array(MAX);
  private py = new Float32Array(MAX);
  private vx = new Float32Array(MAX);
  private vy = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private width = new Float32Array(MAX);
  private alive = 0;
  private carry = 0;
  private spinPhase = 0;
  private flare = 0;
  private burstQueue = 0;
  private interior!: HTMLCanvasElement;

  protected setup() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'portal';
    this.host.appendChild(this.canvas);
    this.c = this.canvas.getContext('2d')!;
    this.interior = document.createElement('canvas');
  }

  protected teardown() {
    this.canvas.remove();
  }

  protected layout() {
    const { w, h, dpr, R } = this.L;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    Object.assign(this.canvas.style, { width: `${w}px`, height: `${h}px`, left: '0px', top: '0px' });
    // the "other side": a cold, slow storm, painted once and rotated
    const s = Math.ceil(R * 2 * dpr);
    this.interior.width = this.interior.height = s;
    const g = this.interior.getContext('2d')!;
    const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grad.addColorStop(0, '#0b1220');
    grad.addColorStop(0.7, '#070a12');
    grad.addColorStop(1, '#140804');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = (0.15 + Math.random() * 0.8) * s * 0.5;
      g.strokeStyle = `rgba(${90 + Math.random() * 60},${110 + Math.random() * 60},${160 + Math.random() * 60},${0.03 + Math.random() * 0.05})`;
      g.lineWidth = (1 + Math.random() * 3) * dpr;
      g.beginPath();
      g.arc(s / 2, s / 2, r, a, a + 0.4 + Math.random() * 1.4);
      g.stroke();
    }
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(200,220,255,${0.15 + Math.random() * 0.4})`;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * s * 0.45;
      g.fillRect(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r, dpr, dpr);
    }
  }

  protected animating() {
    return this.alive > 0 || this.flare > 0.01;
  }

  private spawn(n: number, ringR: number, opts: { speed?: number; out?: number; life?: number; at?: Point; spread?: number } = {}) {
    const { cx, cy } = this.L;
    for (let i = 0; i < n && this.alive < MAX; i++) {
      const k = this.alive++;
      const a = Math.random() * Math.PI * 2;
      // brighter clusters orbit the rim, so it never looks like uniform noise
      const hot = 0.5 + 0.5 * Math.sin(a * 3 + this.spinPhase * 2) * Math.sin(a * 2 - this.spinPhase * 1.3);
      const base = opts.at ? opts.at : { x: cx + Math.cos(a) * ringR, y: cy + Math.sin(a) * ringR };
      const spread = opts.spread ?? 1.6;
      this.px[k] = base.x + (Math.random() - 0.5) * spread;
      this.py[k] = base.y + (Math.random() - 0.5) * spread;
      const sp = (opts.speed ?? 150) * (0.55 + Math.random() * 0.9) * (0.7 + hot * 0.6);
      const tx = -Math.sin(a);
      const ty = Math.cos(a);
      const out = (opts.out ?? 25) * (Math.random() * 1.6 - 0.35);
      if (opts.at) {
        this.vx[k] = Math.cos(a) * sp;
        this.vy[k] = Math.sin(a) * sp;
      } else {
        this.vx[k] = tx * sp + Math.cos(a) * out;
        this.vy[k] = ty * sp + Math.sin(a) * out;
      }
      this.maxLife[k] = this.life[k] = (opts.life ?? 0.55) * (0.4 + Math.random() * 0.9);
      this.width[k] = 0.8 + Math.random() * 1.3;
    }
  }

  protected draw(dt: number) {
    const { cx, cy, R, dpr, w, h } = this.L;
    const c = this.c;
    const hv = this.hover.value;
    const ch = this.charge.value;
    const dorm = this.dormant.value;
    this.flare *= Math.exp(-dt * 2.8);
    this.spinPhase += dt * (1 + hv * 1.5 + ch * 3);

    const ringR = R * (0.8 + 0.08 * hv + 0.05 * ch + 0.04 * this.flare) + this.ptr.x.value * 0;
    const rate = (dorm > 0.5 ? 90 : 900) + hv * 1800 + ch * 2600 + this.flare * 2200;
    this.carry += rate * dt * (1 - dorm * 0.85);
    const n = Math.floor(this.carry);
    this.carry -= n;
    // sparks bend toward a dragged file
    this.spawn(n, ringR, { speed: 150 + hv * 60 + ch * 120 + this.flare * 140, out: 25 + this.flare * 90, life: 0.55 + ch * 0.25 });
    if (this.burstQueue > 0) {
      this.spawn(this.burstQueue, ringR, { speed: 320, out: 220, life: 0.9 });
      this.burstQueue = 0;
    }

    // physics
    const gravity = 420;
    const drag = Math.exp(-dt * 1.4);
    const pull = this.pointerOn ? 1 : 0;
    const pxT = cx + this.ptr.x.value * R;
    const pyT = cy + this.ptr.y.value * R;
    for (let i = 0; i < this.alive; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const j = --this.alive;
        this.px[i] = this.px[j];
        this.py[i] = this.py[j];
        this.vx[i] = this.vx[j];
        this.vy[i] = this.vy[j];
        this.life[i] = this.life[j];
        this.maxLife[i] = this.maxLife[j];
        this.width[i] = this.width[j];
        i--;
        continue;
      }
      if (pull) {
        const dx = pxT - this.px[i];
        const dy = pyT - this.py[i];
        const d2 = dx * dx + dy * dy + 400;
        this.vx[i] += (dx / d2) * 9000 * dt;
        this.vy[i] += (dy / d2) * 9000 * dt;
      }
      this.vy[i] += gravity * dt;
      this.vx[i] *= drag;
      this.vy[i] *= drag;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
    }

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w * dpr, h * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    // interior
    c.save();
    c.beginPath();
    c.arc(cx, cy, ringR - 1, 0, Math.PI * 2);
    c.clip();
    c.globalAlpha = 0.9 - dorm * 0.35;
    c.translate(cx, cy);
    c.rotate(this.spinPhase * 0.12);
    c.drawImage(this.interior, -ringR, -ringR, ringR * 2, ringR * 2);
    c.restore();

    // inner heat at the rim
    c.globalCompositeOperation = 'lighter';
    const glow = c.createRadialGradient(cx, cy, ringR * 0.7, cx, cy, ringR * 1.35);
    const gA = (0.22 + hv * 0.2 + ch * 0.35 + this.flare * 0.4) * (1 - dorm * 0.8);
    glow.addColorStop(0, 'rgba(255,120,30,0)');
    glow.addColorStop(0.42, `rgba(255,150,50,${gA})`);
    glow.addColorStop(1, 'rgba(255,90,20,0)');
    c.fillStyle = glow;
    c.fillRect(cx - R * 1.6, cy - R * 1.6, R * 3.2, R * 3.2);

    // the cut itself: a few flickering strokes
    for (let k = 0; k < 3; k++) {
      c.strokeStyle = k === 0 ? `rgba(255,236,200,${0.85 - dorm * 0.6})` : `rgba(255,${150 - k * 30},40,${0.35 - dorm * 0.25})`;
      c.lineWidth = k === 0 ? 1.6 : 3 + k * 2.5;
      c.beginPath();
      const wob = 0.35 + k * 0.35;
      for (let a = 0; a <= Math.PI * 2 + 0.01; a += Math.PI / 120) {
        const r = ringR + Math.sin(a * 7 + this.time * (9 + k * 3)) * wob + Math.sin(a * 13 - this.time * 14) * wob * 0.5;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (a === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.stroke();
    }

    // sparks as streaks, cooling with age; bucketed so it's a handful of strokes, not thousands
    for (let bucket = 0; bucket < BUCKETS; bucket++) {
      for (const thick of [0, 1]) {
        c.beginPath();
        let any = false;
        for (let i = 0; i < this.alive; i++) {
          const age = 1 - this.life[i] / this.maxLife[i];
          if (Math.min(BUCKETS - 1, Math.floor(age * BUCKETS)) !== bucket || (this.width[i] > 1.4 ? 1 : 0) !== thick) continue;
          c.moveTo(this.px[i], this.py[i]);
          c.lineTo(this.px[i] - this.vx[i] * 0.022, this.py[i] - this.vy[i] * 0.022);
          any = true;
        }
        if (!any) continue;
        const age = (bucket + 0.5) / BUCKETS;
        const g = Math.round(lerp(240, 70, clamp(age * 1.3)));
        const b = Math.round(lerp(200, 10, clamp(age * 2)));
        c.strokeStyle = `rgba(255,${g},${b},${(1 - age) * (1 - dorm * 0.5)})`;
        c.lineWidth = (thick ? 1.9 : 1.05) * (1 - age * 0.45);
        c.stroke();
      }
    }
    c.globalCompositeOperation = 'source-over';
  }

  protected onSwallowed() {
    this.flare = 1;
    this.burstQueue = 260;
  }

  protected onEmerge() {
    this.flare = 1.2;
    this.burstQueue = 340;
  }

  protected onIgnite() {
    this.flare = 1.5;
    this.burstQueue = 600;
  }

  protected placeIn(f: Flying, t: number) {
    const { cx, cy, R } = this.L;
    const e = ease.inCubic(t);
    f.x = lerp(f.from.x, cx, e);
    f.y = lerp(f.from.y, cy, e);
    const d = Math.hypot(f.x - cx, f.y - cy);
    f.depth = clamp(1 - d / (R * 0.8));
    f.scale = lerp(0.8, 0.12, e);
    f.rot = e * (f.seed > 0.5 ? 2.2 : -2.2);
    f.alpha = 1 - clamp((t - 0.8) / 0.2);
    // embers shed by the item once it crosses the rim
    if (f.depth > 0 && Math.random() < 0.7) {
      const s = (this.spriteSize * f.scale) / 2;
      this.spawn(3, 0, { at: { x: f.x + (Math.random() - 0.5) * s * 2, y: f.y + (Math.random() - 0.5) * s * 2 }, speed: 60, life: 0.45, spread: 2 });
    }
  }

  protected placeEmerge(f: Flying, t: number, to: Point) {
    const e = ease.outBack(clamp(t / 0.75), 1.4);
    f.x = lerp(this.L.cx, to.x, e);
    f.y = lerp(this.L.cy, to.y, e);
    f.scale = lerp(0.1, 1, e);
    f.rot = lerp(f.seed > 0.5 ? -0.5 : 0.5, 0, ease.outCubic(t));
    f.alpha = clamp(t * 5);
    f.depth = 1 - t;
    if (t < 0.5) {
      const s = (this.spriteSize * f.scale) / 2;
      this.spawn(6, 0, { at: { x: f.x + (Math.random() - 0.5) * s * 2, y: f.y + (Math.random() - 0.5) * s * 2 }, speed: 140, life: 0.6, spread: 3 });
    }
  }

  protected drawFlying(f: Flying) {
    const g = this.g;
    const size = this.spriteSize * f.scale;
    if (size < 0.5) return;
    g.save();
    g.translate(f.x, f.y);
    g.rotate(f.rot);
    g.globalAlpha = f.alpha;
    if (f.depth > 0.05 && (f.phase === 'in' || f.phase === 'emerge')) {
      // hot edge glow while it passes through
      g.shadowColor = `rgba(255,140,40,${0.9 * f.depth})`;
      g.shadowBlur = 18 * f.depth;
    }
    g.drawImage(f.sprite.canvas, -size / 2, -size / 2, size, size);
    g.restore();
  }
}
