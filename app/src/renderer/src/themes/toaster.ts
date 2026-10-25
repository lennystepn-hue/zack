// A cherry-red enamel toaster. Files become slices of bread with the file
// branded on them, drop into a slot, the lever goes down, the coils glow;
// on the other machine the toast pops up with a ding.

import { clamp, ease, lerp, Spring } from '../fx/motion';
import type { Sprite } from '../fx/sprite';
import { Theme, type Flying, type Point } from './base';

interface Puff {
  x: number;
  y: number;
  r: number;
  life: number;
  max: number;
}

const toasts = new WeakMap<Sprite, HTMLCanvasElement>();

/** The item, branded onto a slice of bread. */
function toastOf(sprite: Sprite) {
  let t = toasts.get(sprite);
  if (t) return t;
  t = document.createElement('canvas');
  t.width = t.height = 128;
  const g = t.getContext('2d')!;
  const slice = (inset: number) => {
    const p = new Path2D();
    const l = 16 + inset;
    const r = 112 - inset;
    const b = 120 - inset;
    p.moveTo(l + 4, b);
    p.lineTo(l, 58);
    p.bezierCurveTo(l - 12, 50, l - 8, 14 + inset, 46, 14 + inset);
    p.bezierCurveTo(56, 6 + inset, 72, 6 + inset, 82, 14 + inset);
    p.bezierCurveTo(r + 8, 14 + inset, r + 12, 50, r, 58);
    p.lineTo(r - 4, b);
    p.quadraticCurveTo(64, b + 3, l + 4, b);
    return p;
  };
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.4)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  g.fillStyle = '#b8762f';
  g.fill(slice(0));
  g.restore();
  const crumb = g.createRadialGradient(64, 66, 10, 64, 66, 60);
  crumb.addColorStop(0, '#f7dfaa');
  crumb.addColorStop(0.7, '#eac47f');
  crumb.addColorStop(1, '#d79c52');
  g.fillStyle = crumb;
  g.fill(slice(7));
  // the item, burnt in
  g.save();
  g.clip(slice(12));
  g.globalAlpha = 0.9;
  g.globalCompositeOperation = 'multiply';
  g.drawImage(sprite.canvas, 22, 26, 84, 84);
  g.restore();
  // a few pores
  g.fillStyle = 'rgba(150,95,40,0.25)';
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    g.arc(30 + ((i * 37) % 70), 34 + ((i * 53) % 74), 1 + (i % 3) * 0.6, 0, Math.PI * 2);
    g.fill();
  }
  toasts.set(sprite, t);
  return t;
}

export class Toaster extends Theme {
  readonly id = 'toaster' as const;
  readonly spriteSize = 78;
  readonly timing = { swallow: 1600, stagger: 260, emerge: 1350, present: 1700, dock: 460 };

  private canvas!: HTMLCanvasElement;
  private c!: CanvasRenderingContext2D;
  private lever = new Spring(0, 260, 14);
  private heat = new Spring(0, 14, 6);
  private tilt = new Spring(0, 70, 10);
  private puffs: Puff[] = [];
  private slotFor = new WeakMap<Flying, number>();
  private nextSlot = 0;
  private fired = new WeakMap<Flying, Set<string>>();

  // geometry (css px)
  private readonly body = { x: 48, y: 104, w: 164, h: 98 };
  private readonly slots = [
    { x: 84, w: 40 },
    { x: 136, w: 40 },
  ];

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
    return { type: 'rect' as const, x: 40, y: 94, w: 196, h: 118 };
  }

  presentPoint(): Point {
    return { x: 130, y: 56 };
  }

  protected animating() {
    return this.puffs.length > 0 || !this.lever.settled() || this.heat.value > 0.01 || !this.tilt.settled();
  }

  private slotCenter(i: number) {
    const s = this.slots[i];
    return s.x + s.w / 2;
  }

  protected draw(dt: number) {
    const { w, h, dpr } = this.L;
    const c = this.c;
    const hv = this.hover.value;
    const ch = this.charge.value;
    const d = this.dormant.value;

    // the lever stays down while something cooks, in either direction
    const cooking = this.flying.some((f) => (f.phase === 'in' && f.t > 0.6) || (f.phase === 'emerge' && f.t < 0.2)) || this.mood === 'charging';
    this.lever.target = cooking ? 1 : hv * 0.15;
    this.heat.target = cooking ? 0.55 + ch * 0.45 : hv * 0.12;
    this.tilt.target = this.pointerOn ? clamp(this.ptr.x.value, -1, 1) * 0.035 : 0;
    this.lever.step(dt);
    this.heat.step(dt);
    this.tilt.step(dt);
    const heat = clamp(this.heat.value);

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w * dpr, h * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.save();
    c.translate(130, 206);
    c.rotate(this.tilt.value);
    if (cooking) c.translate((Math.random() - 0.5) * 0.9 * (0.4 + ch), 0);
    c.translate(-130, -206);
    if (d > 0.01) c.filter = `grayscale(${d * 0.9}) brightness(${1 - d * 0.35})`;

    this.drawShadow();
    this.drawCord(d);
    this.drawLeverTrack();
    for (const f of this.flying) if (this.inside(f)) this.drawInSlot(f);
    this.drawBody(heat);
    this.drawLever();
    c.restore();

    // heat haze and steam above the slots
    if (heat > 0.05) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const i of [0, 1]) {
        const x = this.slotCenter(i);
        const g = c.createRadialGradient(x, 108, 2, x, 98, 36);
        g.addColorStop(0, `rgba(255,120,40,${0.6 * heat})`);
        g.addColorStop(1, 'rgba(255,80,20,0)');
        c.fillStyle = g;
        c.fillRect(x - 42, 60, 84, 56);
      }
      c.restore();
      c.save();
      c.strokeStyle = `rgba(255,225,200,${0.14 * heat})`;
      c.lineWidth = 1.2;
      for (let k = 0; k < 4; k++) {
        const x0 = 88 + k * 28;
        c.beginPath();
        for (let y = 102; y > 58; y -= 3) c.lineTo(x0 + Math.sin(y * 0.18 + this.time * 6 + k) * 3, y);
        c.stroke();
      }
      c.restore();
      if (Math.random() < heat * 0.08) this.puffs.push({ x: this.slotCenter(Math.random() < 0.5 ? 0 : 1) + (Math.random() - 0.5) * 20, y: 104, r: 4, life: 1.2, max: 1.2 });
    }

    this.puffs = this.puffs.filter((p) => (p.life -= dt) > 0);
    for (const p of this.puffs) {
      const k = 1 - p.life / p.max;
      p.y -= dt * 22;
      p.x += Math.sin(this.time * 2 + p.r) * dt * 6;
      c.fillStyle = `rgba(240,240,244,${0.3 * (1 - k)})`;
      c.beginPath();
      c.arc(p.x, p.y, p.r + k * 10, 0, Math.PI * 2);
      c.fill();
    }
  }

  private drawShadow() {
    const c = this.c;
    c.save();
    c.scale(1, 0.13);
    const g = c.createRadialGradient(130, 210 / 0.13, 4, 130, 210 / 0.13, 92);
    g.addColorStop(0, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(130, 210 / 0.13, 92, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  private drawCord(d: number) {
    const c = this.c;
    c.strokeStyle = '#1c1c1f';
    c.lineWidth = 3.2;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(54, 186);
    // unplugged when dormant: the cord lies there instead of running off
    if (d > 0.5) c.bezierCurveTo(30, 194, 26, 214, 44, 214);
    else c.bezierCurveTo(28, 190, 22, 210, 0, 212);
    c.stroke();
  }

  private loaf() {
    // tight shoulders, so the top is flat where the slots are
    const { x, y, w, h } = this.body;
    const p = new Path2D();
    p.moveTo(x + 14, y + h);
    p.quadraticCurveTo(x, y + h, x, y + h - 14);
    p.lineTo(x, y + 26);
    p.bezierCurveTo(x, y + 8, x + 8, y, x + 26, y);
    p.lineTo(x + w - 26, y);
    p.bezierCurveTo(x + w - 8, y, x + w, y + 8, x + w, y + 26);
    p.lineTo(x + w, y + h - 14);
    p.quadraticCurveTo(x + w, y + h, x + w - 14, y + h);
    p.closePath();
    return p;
  }

  private drawBody(heat: number) {
    const c = this.c;
    const { x, y, w, h } = this.body;
    const shape = this.loaf();

    // enamel
    const g = c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#ff7a66');
    g.addColorStop(0.35, '#e9473b');
    g.addColorStop(1, '#a92a22');
    c.fillStyle = g;
    c.fill(shape);

    c.save();
    c.clip(shape);
    // roundness toward the sides
    const side = c.createLinearGradient(x, 0, x + w, 0);
    side.addColorStop(0, 'rgba(40,0,0,0.45)');
    side.addColorStop(0.14, 'rgba(40,0,0,0)');
    side.addColorStop(0.86, 'rgba(40,0,0,0)');
    side.addColorStop(1, 'rgba(40,0,0,0.5)');
    c.fillStyle = side;
    c.fillRect(x, y, w, h);
    // a soft window reflection on the left, a drifting one across
    const sheen = c.createLinearGradient(x + 14, 0, x + 44, 0);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0.32)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = sheen;
    c.fillRect(x + 14, y + 10, 30, h - 40);
    const sweep = x + ((this.time * 12) % (w + 120)) - 60;
    const hl = c.createLinearGradient(sweep - 18, 0, sweep + 18, 0);
    hl.addColorStop(0, 'rgba(255,255,255,0)');
    hl.addColorStop(0.5, 'rgba(255,255,255,0.14)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = hl;
    c.fillRect(sweep - 18, y, 36, h);
    // the coils light the enamel from the top
    if (heat > 0.02) {
      const warm = c.createLinearGradient(0, y, 0, y + 46);
      warm.addColorStop(0, `rgba(255,170,80,${0.45 * heat})`);
      warm.addColorStop(1, 'rgba(255,170,80,0)');
      c.fillStyle = warm;
      c.fillRect(x, y, w, 46);
    }
    // chrome band
    const by = y + h - 30;
    const band = c.createLinearGradient(0, by, 0, by + 14);
    band.addColorStop(0, '#fdfdfd');
    band.addColorStop(0.35, '#b9c0c9');
    band.addColorStop(0.55, '#f2f4f6');
    band.addColorStop(1, '#7f8893');
    c.fillStyle = band;
    c.fillRect(x, by, w, 14);
    c.fillStyle = 'rgba(0,0,0,0.25)';
    c.fillRect(x, by + 14, w, 1);
    c.restore();

    // crisp highlight along the top curve
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(x + 4, y + 26);
    c.bezierCurveTo(x + 5, y + 12, x + 10, y + 5, x + 28, y + 4);
    c.stroke();
    c.restore();
    c.strokeStyle = 'rgba(60,0,0,0.6)';
    c.lineWidth = 1.2;
    c.stroke(shape);

    // the top face, seen just from above, with the two slots set into it
    const face = new Path2D();
    face.roundRect(x + 30, y - 1.5, w - 60, 8, 4);
    const fg = c.createLinearGradient(0, y - 1.5, 0, y + 6.5);
    fg.addColorStop(0, '#ff8f7e');
    fg.addColorStop(1, '#e9574a');
    c.fillStyle = fg;
    c.fill(face);
    c.strokeStyle = 'rgba(90,10,0,0.35)';
    c.lineWidth = 1;
    c.stroke(face);
    for (const s of this.slots) {
      const slot = new Path2D();
      slot.roundRect(s.x, y + 0.2, s.w, 4.6, 2.3);
      const r = Math.round(lerp(22, 255, heat));
      const gg = Math.round(lerp(10, 96, heat));
      c.fillStyle = `rgb(${r},${gg},${Math.round(lerp(10, 30, heat))})`;
      c.fill(slot);
      // chrome lip on the near edge only, like a real slot
      c.strokeStyle = 'rgba(255,255,255,0.75)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(s.x + 2, y + 5.4);
      c.lineTo(s.x + s.w - 2, y + 5.4);
      c.stroke();
    }

    // browning dial, indicator light, engraved badge
    const dx = x + 30;
    const dy = y + 50;
    const dial = c.createRadialGradient(dx - 3, dy - 3, 1, dx, dy, 10);
    dial.addColorStop(0, '#ffffff');
    dial.addColorStop(1, '#8e97a2');
    c.fillStyle = dial;
    c.beginPath();
    c.arc(dx, dy, 9, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.4)';
    c.stroke();
    c.strokeStyle = '#222';
    c.lineWidth = 2;
    c.beginPath();
    const a = -2.2 + heat * 2.6;
    c.moveTo(dx, dy);
    c.lineTo(dx + Math.cos(a) * 6, dy + Math.sin(a) * 6);
    c.stroke();
    const lx = x + 30;
    const ly = y + 70;
    c.fillStyle = heat > 0.1 ? `rgba(255,${Math.round(150 - heat * 60)},40,1)` : '#5a1a14';
    c.beginPath();
    c.arc(lx, ly, 3.2, 0, Math.PI * 2);
    c.fill();
    if (heat > 0.1) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      const glow = c.createRadialGradient(lx, ly, 1, lx, ly, 12);
      glow.addColorStop(0, `rgba(255,140,40,${0.7 * heat})`);
      glow.addColorStop(1, 'rgba(255,140,40,0)');
      c.fillStyle = glow;
      c.fillRect(lx - 12, ly - 12, 24, 24);
      c.restore();
    }
    c.font = '700 9px "JetBrains Mono", ui-monospace, monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = 'rgba(255,255,255,0.7)';
    c.fillText('zack.', 130, y + h - 22);
    c.fillStyle = 'rgba(40,46,54,0.75)';
    c.fillText('zack.', 130, y + h - 23);

    // chrome feet
    c.fillStyle = '#c3c9d0';
    c.beginPath();
    c.roundRect(x + 18, y + h - 1, 20, 7, 3);
    c.roundRect(x + w - 38, y + h - 1, 20, 7, 3);
    c.fill();
  }

  private leverY() {
    return lerp(this.body.y + 24, this.body.y + 62, clamp(this.lever.value, -0.1, 1.05));
  }

  private drawLeverTrack() {
    const c = this.c;
    const { x, w, y } = this.body;
    c.fillStyle = '#2a0c09';
    c.beginPath();
    c.roundRect(x + w - 6, y + 22, 6, 50, 3);
    c.fill();
  }

  private drawLever() {
    const c = this.c;
    const { x, w } = this.body;
    const ky = this.leverY();
    const knob = new Path2D();
    knob.roundRect(x + w - 4, ky - 5, 22, 11, 5);
    const kg = c.createLinearGradient(0, ky - 5, 0, ky + 6);
    kg.addColorStop(0, '#45484f');
    kg.addColorStop(1, '#0d0e11');
    c.fillStyle = kg;
    c.fill(knob);
    c.fillStyle = 'rgba(255,255,255,0.3)';
    c.fillRect(x + w, ky - 3, 14, 1);
  }

  private inside(f: Flying) {
    return (f.phase === 'in' && f.t > 0.42) || (f.phase === 'emerge' && f.t < 0.24);
  }

  private drawInSlot(f: Flying) {
    const c = this.c;
    const s = this.spriteSize * f.scale;
    c.save();
    c.beginPath();
    c.rect(0, 0, this.L.w, this.body.y + 3);
    c.clip();
    c.translate(f.x, f.y);
    c.scale(0.7, 1);
    c.drawImage(toastOf(f.sprite), -s / 2, -s / 2, s, s);
    c.restore();
  }

  protected drawFlying(f: Flying) {
    if (this.inside(f)) return;
    this.cue(f);
    if (f.phase === 'dock') return super.drawFlying(f);
    const g = this.g;
    const s = this.spriteSize * f.scale;
    g.save();
    g.globalAlpha = f.alpha;
    g.translate(f.x, f.y);
    g.rotate(f.rot);
    g.drawImage(toastOf(f.sprite), -s / 2, -s / 2, s, s);
    g.restore();
  }

  private cue(f: Flying) {
    let done = this.fired.get(f);
    if (!done) this.fired.set(f, (done = new Set()));
    if (f.phase === 'emerge' && f.t > 0.2 && !done.has('pop')) {
      done.add('pop');
      this.lever.target = 0;
      this.lever.kick(-14);
      for (let i = 0; i < 4; i++) this.puffs.push({ x: this.slotCenter(this.slotFor.get(f) ?? 0) + (Math.random() - 0.5) * 30, y: 102, r: 5, life: 0.9, max: 0.9 });
    }
  }

  private slotOf(f: Flying) {
    let i = this.slotFor.get(f);
    if (i === undefined) {
      i = this.nextSlot++ % 2;
      this.slotFor.set(f, i);
    }
    return i;
  }

  protected onSwallowed(f: Flying) {
    for (let i = 0; i < 6; i++) this.puffs.push({ x: this.slotCenter(this.slotOf(f)) + (Math.random() - 0.5) * 24, y: 102, r: 4, life: 1.1, max: 1.1 });
  }

  protected onIgnite() {
    this.lever.kick(-10);
    for (let i = 0; i < 10; i++) this.puffs.push({ x: 90 + Math.random() * 80, y: 102, r: 4, life: 1.2, max: 1.2 });
  }

  /** hop over a slot, line up, drop in */
  protected placeIn(f: Flying, t: number) {
    const sx = this.slotCenter(this.slotOf(f));
    const above = { x: sx, y: 56 };
    if (t < 0.32) {
      const e = ease.inOutCubic(t / 0.32);
      f.x = lerp(f.from.x, above.x, e);
      f.y = lerp(f.from.y, above.y, e) - Math.sin(e * Math.PI) * 26;
      f.scale = lerp(0.95, 0.78, e);
      f.rot = lerp(0.25, 0, e);
      f.depth = 0;
      f.alpha = 1;
    } else if (t < 0.42) {
      f.x = sx;
      f.y = above.y;
      f.scale = 0.78;
      f.rot = 0;
      f.depth = 0;
      f.alpha = 1;
    } else {
      const e = ease.inCubic(clamp((t - 0.42) / 0.2));
      f.x = sx;
      f.y = lerp(above.y, 160, e);
      f.scale = 0.78;
      f.rot = 0;
      f.depth = e;
      f.alpha = 1;
    }
  }

  /** wait in the slot, POP up high with a spin, land in front */
  protected placeEmerge(f: Flying, t: number, to: Point) {
    const sx = this.slotCenter(this.slotOf(f));
    if (t < 0.2) {
      f.x = sx;
      f.y = 148;
      f.scale = 0.78;
      f.rot = 0;
      f.alpha = 1;
      f.depth = 1;
      return;
    }
    if (t < 0.55) {
      const e = ease.outCubic((t - 0.2) / 0.35);
      f.x = lerp(sx, to.x, e * 0.6);
      f.y = lerp(148, 4, e);
      f.scale = lerp(0.78, 0.92, e);
      f.rot = e * Math.PI * 2 * (sx < 130 ? -1 : 1);
      f.alpha = 1;
      f.depth = 1 - e;
      return;
    }
    const k = (t - 0.55) / 0.45;
    const e = ease.outBack(k, 1.8);
    f.x = lerp(lerp(sx, to.x, 0.6), to.x, ease.outCubic(k));
    f.y = lerp(4, to.y, e);
    f.scale = lerp(0.92, 1, k);
    f.rot = 0;
    f.alpha = 1;
    f.depth = 0;
  }
}
