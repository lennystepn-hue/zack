// A small, hungry creature. It watches your cursor, opens wide when you
// bring it something, chews, gulps, burps. On the other machine it turns
// queasy and coughs the thing back up, much relieved.

import { clamp, ease, lerp, Spring } from '../fx/motion';
import { Theme, type Flying, type Point } from './base';

const C = {
  body: '#5fd39c',
  shade: '#3aa874',
  belly: '#b5f2d0',
  line: '#17402c',
  horn: '#ffcf5c',
  hornLine: '#8a6414',
  cheek: 'rgba(255,128,150,0.55)',
  mouth: '#4a0f1e',
  tongue: '#ff6f8f',
  tooth: '#fffaf0',
  eye: '#ffffff',
  pupil: '#10231a',
  queasy: '#9fca6a',
};

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  kind: 'z' | 'spark' | 'bubble' | 'drop';
}

export class Monster extends Theme {
  readonly id = 'monster' as const;
  readonly spriteSize = 74;
  readonly timing = { swallow: 1900, stagger: 300, emerge: 1450, present: 1700, dock: 460 };

  private canvas!: HTMLCanvasElement;
  private c!: CanvasRenderingContext2D;
  private mouth = new Spring(0, 160, 12);
  private squashY = new Spring(1, 180, 10);
  private eyeOpen = new Spring(1, 300, 22);
  private lookX = new Spring(0, 60, 12);
  private lookY = new Spring(0, 60, 12);
  private cheeks = new Spring(0, 80, 9);
  private blinkAt = 2.5;
  private happyUntil = 0;
  private bits: Bit[] = [];
  private fired = new WeakMap<Flying, Set<string>>();

  private readonly cx = 130;
  private readonly cy = 146;

  protected setup() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'portal';
    this.host.appendChild(this.canvas);
    this.c = this.canvas.getContext('2d')!;
  }

  protected teardown() {
    this.canvas.remove();
  }

  protected layout() {
    const { w, h, dpr } = this.L;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    Object.assign(this.canvas.style, { width: `${w}px`, height: `${h}px`, left: '0px', top: '0px' });
  }

  hitShape() {
    return { type: 'circle' as const, x: this.cx, y: this.cy, r: 70 };
  }

  presentPoint(): Point {
    return { x: this.cx, y: 50 };
  }

  protected animating() {
    return this.bits.length > 0 || !this.mouth.settled() || !this.squashY.settled() || !this.cheeks.settled() || this.time < this.happyUntil;
  }

  private mouthPos() {
    return { x: this.cx + this.lookX.value * 3, y: this.cy + 22 };
  }

  protected draw(dt: number) {
    const { w, h, dpr } = this.L;
    const c = this.c;
    const hv = this.hover.value;
    const ch = this.charge.value;
    const d = this.dormant.value;
    const asleep = d > 0.5;

    // what the face is doing, decided per frame from what's happening
    const eating = this.flying.find((f) => f.phase === 'in');
    const coughing = this.flying.find((f) => f.phase === 'emerge');
    let mouthTarget = asleep ? 0 : hv * 0.85;
    if (eating) {
      if (eating.t < 0.6) mouthTarget = 0.6 + 0.6 * clamp(eating.t / 0.4);
      else if (eating.t < 0.64) mouthTarget = 0;
      else if (eating.t < 0.92) mouthTarget = 0.18 + 0.18 * Math.sin((eating.t - 0.64) * 70) ** 2;
      else mouthTarget = 0;
    }
    if (coughing) {
      if (coughing.t < 0.28) mouthTarget = 0.05;
      else if (coughing.t < 0.6) mouthTarget = 1.25;
      else mouthTarget = 0.1;
    }
    this.mouth.target = mouthTarget;
    this.cheeks.target = this.mood === 'charging' ? 0.4 + ch * 0.6 : coughing && coughing.t < 0.3 ? 1.2 : eating && eating.t > 0.62 && eating.t < 0.92 ? 0.8 : 0;
    this.squashY.target = coughing && coughing.t < 0.28 ? 1.08 : 1;

    // eyes follow the pointer; when idle they wander a little
    const wander = this.pointerOn ? 0 : Math.sin(this.time * 0.37) * 0.4;
    this.lookX.target = clamp(this.ptr.x.value * 1.4 + wander, -1, 1);
    this.lookY.target = clamp(this.ptr.y.value * 1.4, -1, 1);
    this.blinkAt -= dt;
    let eyeTarget = asleep ? 0 : 1;
    if (this.blinkAt < 0) {
      eyeTarget = 0;
      if (this.blinkAt < -0.12) this.blinkAt = 2.2 + Math.random() * 3.5;
    }
    this.eyeOpen.target = eyeTarget;
    for (const s of [this.mouth, this.squashY, this.eyeOpen, this.lookX, this.lookY, this.cheeks]) s.step(dt);

    if (asleep && Math.random() < dt * 0.8) this.bits.push({ x: this.cx + 30, y: this.cy - 40, vx: 8, vy: -14, life: 2.2, max: 2.2, kind: 'z' });

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w * dpr, h * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.save();
    if (d > 0.01) c.filter = `saturate(${1 - d * 0.6}) brightness(${1 - d * 0.25})`;

    // breathing, leaning toward the pointer, queasy wobble
    const breathe = 1 + Math.sin(this.time * (asleep ? 1.2 : 2.2)) * 0.018;
    const wobble = this.mood === 'charging' ? Math.sin(this.time * (10 + ch * 14)) * 0.025 * (0.3 + ch) : 0;
    const sy = this.squashY.value * breathe;
    const sx = 1 / Math.sqrt(sy);
    c.translate(this.cx, this.cy + 52);
    c.rotate(this.lookX.value * 0.05 + wobble);
    c.scale(sx, sy);
    c.translate(-this.cx, -(this.cy + 52));

    this.drawShadow();
    this.drawFeet();
    this.drawHorns();
    this.drawBody(ch);
    this.drawEyes(asleep, ch);
    this.drawMouth();
    this.drawCheeks();
    c.restore();

    // little things in the air
    this.bits = this.bits.filter((b) => (b.life -= dt) > 0);
    for (const b of this.bits) {
      b.vy += (b.kind === 'drop' ? 380 : b.kind === 'spark' ? 60 : 0) * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const k = b.life / b.max;
      if (b.kind === 'z') {
        c.font = `700 ${10 + (1 - k) * 8}px "JetBrains Mono", ui-monospace, monospace`;
        c.fillStyle = `rgba(220,255,236,${k})`;
        c.fillText('z', b.x + Math.sin(this.time * 2 + b.y) * 4, b.y);
      } else if (b.kind === 'bubble') {
        c.strokeStyle = `rgba(220,255,236,${k})`;
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(b.x, b.y, 3 + (1 - k) * 6, 0, Math.PI * 2);
        c.stroke();
      } else if (b.kind === 'drop') {
        c.fillStyle = `rgba(180,240,255,${k})`;
        c.beginPath();
        c.ellipse(b.x, b.y, 2.2, 3.4, Math.atan2(b.vy, b.vx) + Math.PI / 2, 0, Math.PI * 2);
        c.fill();
      } else {
        c.fillStyle = `rgba(255,230,120,${k})`;
        c.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + this.time * 4;
          c.lineTo(b.x + Math.cos(a) * 5 * k, b.y + Math.sin(a) * 5 * k);
          c.lineTo(b.x + Math.cos(a + Math.PI / 4) * 1.6, b.y + Math.sin(a + Math.PI / 4) * 1.6);
        }
        c.fill();
      }
    }
  }

  private drawShadow() {
    const c = this.c;
    c.save();
    c.scale(1, 0.18);
    const g = c.createRadialGradient(this.cx, (this.cy + 66) / 0.18, 4, this.cx, (this.cy + 66) / 0.18, 74);
    g.addColorStop(0, 'rgba(0,0,0,0.38)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(this.cx, (this.cy + 66) / 0.18, 74, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  private drawFeet() {
    const c = this.c;
    c.fillStyle = C.shade;
    c.strokeStyle = C.line;
    c.lineWidth = 2.5;
    for (const dx of [-30, 30]) {
      c.beginPath();
      c.ellipse(this.cx + dx, this.cy + 60, 17, 9, 0, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
  }

  private drawHorns() {
    const c = this.c;
    c.fillStyle = C.horn;
    c.strokeStyle = C.hornLine;
    c.lineWidth = 2.2;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(this.cx + s * 24, this.cy - 52);
      c.quadraticCurveTo(this.cx + s * 40, this.cy - 82, this.cx + s * 46, this.cy - 74);
      c.quadraticCurveTo(this.cx + s * 46, this.cy - 58, this.cx + s * 38, this.cy - 44);
      c.closePath();
      c.fill();
      c.stroke();
    }
  }

  private bodyPath() {
    // a soft rounded lump, wider at the bottom, drawn as a closed curve
    const p = new Path2D();
    const x = this.cx;
    const y = this.cy;
    p.moveTo(x, y - 64);
    p.bezierCurveTo(x + 46, y - 64, x + 70, y - 34, x + 70, y + 6);
    p.bezierCurveTo(x + 72, y + 46, x + 44, y + 62, x, y + 62);
    p.bezierCurveTo(x - 44, y + 62, x - 72, y + 46, x - 70, y + 6);
    p.bezierCurveTo(x - 70, y - 34, x - 46, y - 64, x, y - 64);
    return p;
  }

  private drawBody(ch: number) {
    const c = this.c;
    const body = this.bodyPath();
    const g = c.createRadialGradient(this.cx - 22, this.cy - 36, 10, this.cx, this.cy, 90);
    const queasy = this.mood === 'charging' ? ch * 0.6 : 0;
    g.addColorStop(0, mix('#8ff0c0', C.queasy, queasy));
    g.addColorStop(0.55, mix(C.body, C.queasy, queasy));
    g.addColorStop(1, mix(C.shade, '#6f9a45', queasy));
    c.fillStyle = g;
    c.fill(body);
    c.save();
    c.clip(body);
    c.fillStyle = C.belly;
    c.globalAlpha = 0.55;
    c.beginPath();
    c.ellipse(this.cx, this.cy + 40, 42, 30, 0, 0, Math.PI * 2);
    c.fill();
    // fuzz: a few short strokes along the top edge
    c.globalAlpha = 0.25;
    c.strokeStyle = '#ffffff';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(this.cx - 26, this.cy - 30, 18, Math.PI * 1.15, Math.PI * 1.45);
    c.stroke();
    c.restore();
    c.strokeStyle = C.line;
    c.lineWidth = 3;
    c.stroke(body);
  }

  private drawEyes(asleep: boolean, ch: number) {
    const c = this.c;
    const open = this.eyeOpen.value;
    const happy = this.time < this.happyUntil;
    for (const s of [-1, 1]) {
      const ex = this.cx + s * 22;
      const ey = this.cy - 20;
      if (asleep || happy || open < 0.15) {
        // closed: a calm line, or ^ ^ when happy
        c.strokeStyle = C.line;
        c.lineWidth = 3;
        c.lineCap = 'round';
        c.beginPath();
        if (happy) {
          c.moveTo(ex - 10, ey + 3);
          c.quadraticCurveTo(ex, ey - 9, ex + 10, ey + 3);
        } else {
          c.moveTo(ex - 10, ey);
          c.quadraticCurveTo(ex, ey + 5, ex + 10, ey);
        }
        c.stroke();
        continue;
      }
      const r = 15 + this.hover.value * 2;
      c.save();
      c.translate(ex, ey);
      c.scale(1, open);
      c.fillStyle = C.eye;
      c.strokeStyle = C.line;
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      // queasy eyes go a little spirally
      const swirl = this.mood === 'charging' ? ch : 0;
      const px = this.lookX.value * 6 + Math.cos(this.time * 9) * swirl * 3;
      const py = this.lookY.value * 5 + Math.sin(this.time * 9) * swirl * 3;
      c.fillStyle = C.pupil;
      c.beginPath();
      c.arc(px, py, 7.5 - this.hover.value * 1.5, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(px - 2.5, py - 3, 2.4, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  private drawMouth() {
    const c = this.c;
    const m = this.mouthPos();
    const open = Math.max(0, this.mouth.value);
    if (open < 0.06) {
      c.strokeStyle = C.line;
      c.lineWidth = 3;
      c.lineCap = 'round';
      c.beginPath();
      const queasy = this.mood === 'charging';
      if (queasy) {
        // a wavy, uncertain line
        for (let i = 0; i <= 8; i++) c.lineTo(m.x - 14 + i * 3.5, m.y + Math.sin(i * 1.6 + this.time * 8) * 1.8);
      } else {
        c.moveTo(m.x - 14, m.y - 2);
        c.quadraticCurveTo(m.x, m.y + 9, m.x + 14, m.y - 2);
      }
      c.stroke();
      return;
    }
    const w = 18 + open * 16;
    const h = 4 + open * 24;
    c.save();
    c.beginPath();
    c.ellipse(m.x, m.y + h * 0.3, w, h, 0, 0, Math.PI * 2);
    c.fillStyle = C.mouth;
    c.fill();
    c.clip();
    c.fillStyle = C.tongue;
    c.beginPath();
    c.ellipse(m.x + 3, m.y + h * 1.05, w * 0.7, h * 0.55, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = C.tooth;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.moveTo(m.x + s * 6, m.y + h * 0.3 - h);
      c.lineTo(m.x + s * 14, m.y + h * 0.3 - h);
      c.lineTo(m.x + s * 10, m.y + h * 0.3 - h + 8);
      c.closePath();
      c.fill();
    }
    c.restore();
    c.strokeStyle = C.line;
    c.lineWidth = 3;
    c.beginPath();
    c.ellipse(m.x, m.y + h * 0.3, w, h, 0, 0, Math.PI * 2);
    c.stroke();
  }

  private drawCheeks() {
    const c = this.c;
    const k = this.cheeks.value;
    c.fillStyle = C.cheek;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(this.cx + s * (42 + k * 6), this.cy + 6, 10 + k * 8, 6 + k * 6, 0, 0, Math.PI * 2);
      c.fill();
    }
  }

  private cue(f: Flying) {
    let done = this.fired.get(f);
    if (!done) this.fired.set(f, (done = new Set()));
    const once = (key: string, cond: boolean, fn: () => void) => {
      if (cond && !done!.has(key)) {
        done!.add(key);
        fn();
      }
    };
    if (f.phase === 'in') {
      once('chomp', f.t > 0.6, () => {
        this.squashY.target = 0.86;
        this.squashY.kick(-3);
        this.sfx?.land();
      });
    }
    if (f.phase === 'emerge') {
      once('bleh', f.t > 0.3, () => {
        this.squashY.kick(4);
        const m = this.mouthPos();
        for (let i = 0; i < 8; i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.8;
          const sp = 80 + Math.random() * 90;
          this.bits.push({ x: m.x, y: m.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.8, max: 0.8, kind: Math.random() < 0.5 ? 'drop' : 'spark' });
        }
      });
      once('relief', f.t > 0.75, () => (this.happyUntil = this.time + 1.6));
    }
  }

  protected onSwallowed() {
    this.happyUntil = this.time + 1.4;
    const m = this.mouthPos();
    for (let i = 0; i < 3; i++) this.bits.push({ x: m.x + 10 + i * 6, y: m.y - 4, vx: 6 + i * 4, vy: -26 - i * 8, life: 1.2, max: 1.2, kind: 'bubble' });
  }

  protected onIgnite() {
    this.happyUntil = this.time + 2;
    this.squashY.kick(5);
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      this.bits.push({ x: this.cx, y: this.cy - 60, vx: Math.cos(a) * 90, vy: Math.sin(a) * 90, life: 1, max: 1, kind: 'spark' });
    }
  }

  /** float over to the open mouth and get chomped */
  protected placeIn(f: Flying, t: number) {
    const m = this.mouthPos();
    const e = ease.inOutCubic(clamp(t / 0.6));
    f.x = lerp(f.from.x, m.x, e);
    f.y = lerp(f.from.y, m.y + 8, e) - Math.sin(e * Math.PI) * 18;
    f.scale = lerp(0.9, 0.35, e);
    f.rot = e * (f.seed > 0.5 ? 1.2 : -1.2);
    f.depth = e;
    f.alpha = t < 0.6 ? 1 : 0;
  }

  /** coughed up from the mouth, tumbling, then caught in the air */
  protected placeEmerge(f: Flying, t: number, to: Point) {
    const m = this.mouthPos();
    if (t < 0.3) {
      f.alpha = 0;
      f.x = m.x;
      f.y = m.y;
      f.scale = 0.3;
      f.depth = 1;
      return;
    }
    const k = (t - 0.3) / 0.7;
    const e = ease.outBack(k, 1.6);
    f.alpha = 1;
    f.x = lerp(m.x, to.x, ease.outCubic(k));
    f.y = lerp(m.y, to.y, e) - Math.sin(k * Math.PI) * 22;
    f.scale = lerp(0.3, 1, ease.outCubic(k));
    f.rot = (1 - ease.outCubic(k)) * (f.seed > 0.5 ? 2.4 : -2.4);
    f.depth = 1 - k;
  }

  protected drawFlying(f: Flying) {
    this.cue(f);
    if (f.alpha <= 0) return;
    super.drawFlying(f);
  }
}

function mix(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(lerp((pa >> s) & 255, (pb >> s) & 255, clamp(t)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
