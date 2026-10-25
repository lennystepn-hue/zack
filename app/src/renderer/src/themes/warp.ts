// A green warp pipe on a floating island, drawn in real pixels (one art
// pixel = 4 css px). Things hop over the rim and slide down; on the other
// machine they rise out and pop up. Files turn into 18×18 sprites.

import { clamp, ease, lerp, rng } from '../fx/motion';
import { pixelate } from '../fx/sprite';
import { Theme, type Flying, type Point } from './base';

const P = 4;

const C = {
  outline: '#0d2414',
  dark: '#1d6a30',
  base: '#2c9a43',
  mid: '#47c25b',
  hi: '#9cf088',
  spec: '#eaffdc',
  g1: '#7ee26a',
  g2: '#3fae4b',
  g3: '#257a35',
  dirtHi: '#a56c37',
  dirt: '#7b4b23',
  dirtLo: '#553117',
  dirtEdge: '#2b190b',
  speck: '#c08a52',
  stone: '#8c929d',
  star: '#ffe45e',
  white: '#ffffff',
  cloud: '#f4f7ff',
  cloudLo: '#c8d2e6',
};

const PALETTE = [
  [16, 18, 28], [255, 255, 255], [244, 241, 234], [190, 186, 176], [120, 118, 112], [64, 62, 60],
  [229, 72, 77], [255, 150, 60], [255, 220, 90], [70, 194, 91], [30, 120, 60], [62, 123, 250],
  [30, 60, 140], [214, 64, 159], [160, 112, 66], [90, 50, 25],
];

interface Px {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  kind: 'dust' | 'star' | 'smoke';
}

export class Warp extends Theme {
  readonly id = 'warp' as const;
  readonly spriteSize = 72;
  readonly timing = { swallow: 1750, stagger: 220, emerge: 1550, present: 1700, dock: 460 };

  private art!: HTMLCanvasElement;
  private a!: CanvasRenderingContext2D;
  private AW = 65;
  private AH = 83;
  private bits: Px[] = [];
  private squash = 0;
  private flash = 0;
  /** things travelling through the pipe show as bulges: row (art px) and how far the walls stretch */
  private bulges: { pos: number; amp: number }[] = [];
  /** small bulges climbing up while something is on its way in */
  private rising: { pos: number; amp: number; v: number }[] = [];
  private riseAt = 0;
  private thump = 0;
  private fired = new WeakMap<Flying, Set<string>>();
  private sparkleAt = 2;
  private sparkle: { x: number; y: number; t: number } | null = null;
  private tufts: number[] = [];
  private specks: { x: number; y: number; c: string }[] = [];
  private clouds = [
    { x: 6, y: 9, s: 1.2 },
    { x: 44, y: 19, s: 0.8 },
  ];

  // geometry in art pixels
  private get mx() {
    return Math.floor(this.AW / 2);
  }
  private readonly rimTop = 29;
  private readonly bodyBottom = 49;
  private readonly ground = 50;

  protected setup() {
    this.art = document.createElement('canvas');
    this.art.className = 'portal pixel';
    this.host.appendChild(this.art);
    this.a = this.art.getContext('2d')!;
    const r = rng(7);
    this.tufts = Array.from({ length: 9 }, () => Math.floor(r() * 34));
    this.specks = Array.from({ length: 14 }, () => ({ x: Math.floor(r() * 30) + 17, y: 53 + Math.floor(r() * 5), c: r() > 0.7 ? C.stone : C.speck }));
  }

  protected teardown() {
    this.art.remove();
  }

  protected layout() {
    this.AW = Math.ceil(this.L.w / P);
    this.AH = Math.ceil(this.L.h / P);
    this.art.width = this.AW;
    this.art.height = this.AH;
    Object.assign(this.art.style, { width: `${this.AW * P}px`, height: `${this.AH * P}px`, left: '0px', top: '0px' });
  }

  hitShape() {
    // pipe and island, give or take a pixel
    return { type: 'rect' as const, x: (this.mx - 19) * P, y: (this.rimTop - 4) * P, w: 39 * P, h: (this.ground + 11 - this.rimTop + 4) * P };
  }

  presentPoint(): Point {
    return { x: this.mx * P + P / 2, y: (this.rimTop - 12) * P };
  }

  protected animating() {
    return this.bits.length > 0 || this.squash > 0 || this.flash > 0.01 || this.rising.length > 0 || this.thump > 0;
  }

  /** how many pixels the pipe wall bulges out at row y */
  private stretch(y: number) {
    let e = 0;
    for (const b of this.bulges) e += b.amp * Math.exp(-(((y - b.pos) / 2.6) ** 2));
    return Math.round(e);
  }

  private px(x: number, y: number, w: number, h: number, c: string) {
    this.a.fillStyle = c;
    this.a.fillRect(Math.round(x), Math.round(y), w, h);
  }

  private shade(u: number, _row: number) {
    if (u < 0.06) return C.base;
    if (u < 0.13) return C.hi;
    if (u < 0.19) return C.spec;
    if (u < 0.28) return C.hi;
    if (u < 0.37) return C.mid;
    if (u < 0.76) return C.base;
    if (u < 0.83) return C.dark;
    if (u < 0.88) return C.base;
    return C.dark;
  }

  private drawPipe(ox: number, oy: number) {
    const mx = this.mx + ox;
    const rimW = 27;
    const bodyW = 21;
    const top = this.rimTop + oy + (this.squash > 0 ? 1 : 0);
    const rimH = 7;
    // body, row by row, so a bulge can push the walls out where it is
    for (let y = top + rimH; y <= this.bodyBottom + oy; y++) {
      const e = this.stretch(y - oy);
      const w = bodyW + e * 2;
      const left = mx - 10 - e;
      for (let i = 0; i < w; i++) {
        const edge = i === 0 || i === w - 1;
        let c = edge ? C.outline : y === top + rimH ? C.dark : this.shade(i / (w - 1), y);
        // a glint on the swollen side sells the roundness
        if (e > 0 && !edge && i === 2) c = C.spec;
        this.px(left + i, y, 1, 1, c);
      }
    }
    // rim
    for (let y = top; y < top + rimH; y++) {
      const e = this.stretch(y - oy);
      const w = rimW + e * 2;
      const left = mx - 13 - e;
      for (let i = 0; i < w; i++) {
        const edge = i === 0 || i === w - 1 || y === top || y === top + rimH - 1;
        let c = edge ? C.outline : this.shade(i / (w - 1), y);
        if (!edge && y === top + 1) c = i > 2 && i < w - 6 ? C.hi : c;
        if (!edge && this.flash > 0 && (y + i) % 2 === 0) c = this.flash > 0.5 ? C.white : C.star;
        this.px(left + i, y, 1, 1, c);
      }
    }
    // the dark mouth, seen just over the lip
    const e = this.stretch(top - oy);
    this.px(mx - 11 - e, top - 1, rimW - 4 + e * 2, 1, C.outline);
  }

  private drawIsland(oy: number) {
    const mx = this.mx;
    const g = this.ground + oy;
    const rows: [number, number][] = [
      [-18, 36], [-18, 36], [-18, 36], [-17, 34], [-16, 32], [-14, 28], [-11, 22], [-7, 14], [-3, 6],
    ];
    rows.forEach(([dx, w], i) => {
      const y = g + i;
      for (let k = 0; k < w; k++) {
        const x = mx + dx + k;
        const edge = k === 0 || k === w - 1;
        let c: string;
        if (i === 0) c = C.g1;
        else if (i === 1) c = C.g2;
        else if (i === 2) c = k % 3 === 0 ? C.g3 : C.g2;
        else c = i >= 7 ? C.dirtLo : (k + i) % 5 === 0 ? C.dirtLo : i === 3 ? C.dirtHi : C.dirt;
        if (edge) c = i < 3 ? C.g3 : C.dirtEdge;
        this.px(x, y, 1, 1, c);
      }
    });
    for (const s of this.specks) this.px(s.x - 32 + mx, s.y + oy, 1, 1, s.c);
    // dangling roots
    this.px(mx - 5, g + 9, 1, 2, C.dirtLo);
    this.px(mx + 4, g + 8, 1, 3, C.dirtLo);
    this.px(mx + 4, g + 11, 1, 1, C.dirtEdge);
    // grass tufts that sway a pixel
    const sway = Math.floor(this.time * 1.6) % 2;
    for (let i = 0; i < this.tufts.length; i++) {
      const x = mx - 17 + this.tufts[i];
      if (x > mx - 11 && x < mx + 11) continue;
      this.px(x + (i % 2 ? sway : 0), g - 1, 1, 1, C.g1);
      if (i % 3 === 0) this.px(x + 1, g - 2, 1, 1, C.g2);
    }
  }

  private drawCloud(x: number, y: number) {
    const shape = ['  ###   ', ' #####  ', '####### ', ' oooooo '];
    shape.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        if (row[i] === '#') this.px(x + i, y + j, 1, 1, C.cloud);
        else if (row[i] === 'o') this.px(x + i, y + j, 1, 1, C.cloudLo);
      }
    });
  }

  private star(x: number, y: number, c: string, big = false) {
    this.px(x, y, 1, 1, C.white);
    this.px(x - 1, y, 1, 1, c);
    this.px(x + 1, y, 1, 1, c);
    this.px(x, y - 1, 1, 1, c);
    this.px(x, y + 1, 1, 1, c);
    if (big) {
      this.px(x - 2, y, 1, 1, c);
      this.px(x + 2, y, 1, 1, c);
      this.px(x, y - 2, 1, 1, c);
      this.px(x, y + 2, 1, 1, c);
    }
  }

  private arrow(x: number, y: number) {
    const rows = ['#####', ' ### ', '  #  '];
    rows.forEach((r, j) => {
      for (let i = 0; i < r.length; i++) if (r[i] === '#') this.px(x + i - 2, y + j, 1, 1, C.star);
    });
  }

  protected draw(dt: number) {
    const a = this.a;
    a.imageSmoothingEnabled = false;
    a.clearRect(0, 0, this.AW, this.AH);
    const h = this.hover.value;
    const ch = this.charge.value;
    const d = this.dormant.value;
    this.art.style.filter = d > 0.01 ? `grayscale(${d * 0.85}) brightness(${1 - 0.35 * d})` : '';
    this.squash = Math.max(0, this.squash - dt);
    this.flash = Math.max(0, this.flash - dt * 2.5);
    if (ch > 0.15) this.flash = Math.max(this.flash, Math.floor(this.time * (4 + ch * 10)) % 2 ? 0.3 : 0);

    for (const c of this.clouds) {
      c.x += dt * c.s * 1.4;
      if (c.x > this.AW + 2) c.x = -10;
      this.drawCloud(Math.floor(c.x), c.y);
    }

    const bob = d > 0.5 ? 0 : Math.floor(this.time / 0.8) % 2;
    this.thump = Math.max(0, this.thump - dt);
    const quake = this.thump > 0 ? (Math.floor(this.time * 40) % 2 ? 1 : -1) : 0;
    const shake = ch > 0.55 ? (Math.floor(this.time * 30) % 2 ? 1 : -1) * (Math.random() < ch - 0.3 ? 1 : 0) : 0;

    // something on its way: little bulges climb the pipe, faster as it gets closer
    if (this.mood === 'charging' && ch > 0.05) {
      this.riseAt -= dt;
      if (this.riseAt <= 0) {
        this.rising.push({ pos: this.bodyBottom + 1, amp: 1.1 + ch * 1.4, v: 26 + ch * 34 });
        this.riseAt = 0.75 - ch * 0.45;
      }
    }
    this.rising = this.rising.filter((r) => {
      r.pos -= r.v * dt;
      if (r.pos > this.rimTop + 1) return true;
      this.flash = Math.max(this.flash, 0.35);
      this.bits.push({ x: this.mx + (Math.random() - 0.5) * 10, y: this.rimTop - 1, vx: (Math.random() - 0.5) * 14, vy: -22 - Math.random() * 12, life: 0.6, max: 0.6, color: C.star, kind: 'star' });
      return false;
    });
    this.bulges = this.rising.map((r) => ({ pos: r.pos, amp: r.amp }));
    for (const f of this.flying) {
      const b = this.bulgeFor(f);
      if (b) this.bulges.push(b);
    }

    this.drawIsland(bob + (quake > 0 ? 1 : 0));
    this.drawPipe(shake + quake, bob + (quake > 0 ? 1 : 0));

    // pixel stuff in the air
    const mouth = { x: this.mx, y: this.rimTop + bob };
    if (h > 0.3 && Math.random() < h * 0.9) {
      const sx = this.ptr.x.value * this.L.R / P + this.mx;
      const sy = this.ptr.y.value * this.L.R / P + this.L.cy / P;
      this.bits.push({ x: sx + (Math.random() - 0.5) * 8, y: sy + (Math.random() - 0.5) * 8, vx: 0, vy: 0, life: 0.8, max: 0.8, color: Math.random() > 0.5 ? C.star : C.white, kind: 'dust' });
    }
    if (ch > 0.2 && Math.random() < ch * 0.5) {
      this.bits.push({ x: mouth.x + (Math.random() - 0.5) * 18, y: mouth.y - 1, vx: (Math.random() - 0.5) * 6, vy: -18 - Math.random() * 18, life: 0.9, max: 0.9, color: Math.random() > 0.4 ? C.star : C.hi, kind: 'star' });
    }
    const keep: Px[] = [];
    for (const b of this.bits) {
      b.life -= dt;
      if (b.life <= 0) continue;
      if (b.kind === 'dust') {
        b.x = lerp(b.x, mouth.x, dt * 4);
        b.y = lerp(b.y, mouth.y - 2, dt * 4);
        if (Math.abs(b.x - mouth.x) < 1.5 && Math.abs(b.y - mouth.y) < 3) continue;
      } else {
        b.vy += (b.kind === 'smoke' ? -8 : 40) * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
      }
      const fade = b.life / b.max;
      if (b.kind === 'smoke') {
        if ((Math.floor(b.x) + Math.floor(b.y)) % 2 === 0 || fade > 0.5) this.px(b.x, b.y, 2, 2, fade > 0.5 ? '#e8ecf3' : '#b8c0cc');
      } else if (b.kind === 'star' && fade > 0.4) this.star(Math.round(b.x), Math.round(b.y), b.color);
      else this.px(b.x, b.y, 1, 1, b.color);
      keep.push(b);
    }
    this.bits = keep;

    // a glint along the rim now and then
    this.sparkleAt -= dt;
    if (this.sparkleAt <= 0 && d < 0.5) {
      this.sparkle = { x: this.mx - 9 + Math.floor(Math.random() * 6), y: this.rimTop + 2 + bob, t: 0 };
      this.sparkleAt = 2.5 + Math.random() * 3;
    }
    if (this.sparkle) {
      this.sparkle.t += dt;
      if (this.sparkle.t > 0.4) this.sparkle = null;
      else this.star(this.sparkle.x, this.sparkle.y, C.spec, this.sparkle.t > 0.1 && this.sparkle.t < 0.3);
    }

    const busyMouth = this.flying.some((f) => f.phase !== 'wait');
    if (h > 0.5 && !busyMouth) this.arrow(this.mx, this.rimTop - 9 + (Math.floor(this.time * 4) % 2) + bob);

    // sprites, drawn as pixel art into the same canvas
    for (const f of this.flying) {
      if (f.phase === 'wait' || f.alpha <= 0) continue;
      this.cue(f);
      const spr = pixelate(f.sprite, PALETTE);
      const [sx, sy] = this.squashOf(f);
      const sz = spr.width * f.scale;
      const w = Math.max(2, Math.round(sz * sx));
      const h = Math.max(2, Math.round(sz * sy));
      const x = Math.round(f.x / P - w / 2);
      const y = Math.round(f.y / P - h / 2);
      const clipped = (f.phase === 'in' && f.t > 0.3) || (f.phase === 'emerge' && f.t < 0.72);
      a.save();
      if (clipped) {
        a.beginPath();
        a.rect(0, 0, this.AW, this.rimTop + bob - 1);
        a.clip();
      }
      a.globalAlpha = f.alpha;
      a.drawImage(spr, x, y, w, h);
      a.restore();
    }
  }

  /** Where in the pipe a travelling item is, as a bulge. */
  private bulgeFor(f: Flying): { pos: number; amp: number } | null {
    const top = this.rimTop + 2;
    const bottom = this.bodyBottom + 1;
    if (f.phase === 'in' && f.t > 0.33) {
      const k = (f.t - 0.33) / 0.67;
      const amp = 3.2 * clamp((f.t - 0.33) / 0.1) * (1 - clamp((f.t - 0.94) / 0.06));
      // a gulp: quick at first, a little hesitation in the middle, then down it goes
      const travel = k < 0.5 ? ease.outCubic(k / 0.5) * 0.45 : 0.45 + ease.inCubic((k - 0.5) / 0.5) * 0.55;
      return { pos: lerp(top, bottom, travel), amp: amp * (1 + 0.12 * Math.sin(this.time * 18)) };
    }
    if (f.phase === 'emerge' && f.t < 0.6) {
      const k = f.t / 0.55;
      const amp = lerp(1.2, 3.6, clamp(k)) * (1 - clamp((f.t - 0.55) / 0.05));
      return { pos: lerp(bottom, top - 1, ease.inCubic(clamp(k))), amp };
    }
    return null;
  }

  /** Cartoon squash & stretch per phase: [x, y] scale. */
  private squashOf(f: Flying): [number, number] {
    if (f.phase === 'in') {
      if (f.t < 0.3) return [1, 1];
      // squeezed into the mouth
      return [0.78, 1.18];
    }
    if (f.phase === 'emerge') {
      if (f.t < 0.72) return [0.8, 1.2];
      const k = (f.t - 0.72) / 0.28;
      if (k < 0.45) return [0.86, 1.16];
      if (k < 0.7) return [1.18, 0.84];
      return [1, 1];
    }
    if (f.phase === 'dock') return [1, 1];
    return [1, 1];
  }

  /** One-off effects at fixed beats of an item's trip. */
  private cue(f: Flying) {
    let done = this.fired.get(f);
    if (!done) this.fired.set(f, (done = new Set()));
    const once = (key: string, at: boolean, fn: () => void) => {
      if (at && !done!.has(key)) {
        done!.add(key);
        fn();
      }
    };
    if (f.phase === 'in') once('gulp', f.t > 0.33, () => (this.squash = 0.12));
    if (f.phase === 'emerge')
      once('pop', f.t > 0.56, () => {
        this.flash = 1;
        this.squash = 0;
        for (let i = 0; i < 14; i++) {
          const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
          const sp = 26 + Math.random() * 28;
          this.bits.push({ x: this.mx, y: this.rimTop - 2, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0.85, max: 0.85, color: i % 3 ? C.star : C.white, kind: 'star' });
        }
      });
  }

  protected drawFlying() {
    // drawn into the pixel canvas in draw()
  }

  /** it went all the way down: the island takes the hit, dust kicks up at the base */
  protected onSwallowed() {
    this.thump = 0.16;
    for (let i = 0; i < 10; i++) {
      const side = i % 2 ? 1 : -1;
      this.bits.push({ x: this.mx + side * (11 + Math.random() * 3), y: this.ground - 2, vx: side * (10 + Math.random() * 16), vy: -4 - Math.random() * 8, life: 0.55, max: 0.55, color: C.white, kind: 'smoke' });
    }
  }

  protected onIgnite() {
    this.flash = 1;
    for (let i = 0; i < 24; i++) {
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.8;
      const sp = 20 + Math.random() * 35;
      this.bits.push({ x: this.mx, y: this.rimTop - 2, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1.1, max: 1.1, color: i % 2 ? C.star : C.hi, kind: 'star' });
    }
  }

  /** hop onto the rim, get slurped in; from there on it's a bulge in the pipe */
  protected placeIn(f: Flying, t: number) {
    const over = { x: this.mx * P + P / 2, y: (this.rimTop - 11) * P };
    const mouth = { x: over.x, y: (this.rimTop + 9) * P };
    f.rot = 0;
    f.depth = 0;
    if (t < 0.3) {
      const e = ease.inOutCubic(t / 0.3);
      f.x = lerp(f.from.x, over.x, e);
      f.y = lerp(f.from.y, over.y, e) - Math.sin(e * Math.PI) * 34;
      f.scale = lerp(0.95, 0.8, e);
      f.alpha = 1;
    } else if (t < 0.45) {
      const e = ease.inCubic((t - 0.3) / 0.15);
      f.x = over.x;
      f.y = lerp(over.y, mouth.y, e);
      f.scale = 0.8;
      f.alpha = 1;
      f.depth = e;
    } else {
      f.alpha = 0;
      f.depth = 1;
    }
  }

  /** a bulge climbs the pipe, the rim pops, and out it jumps */
  protected placeEmerge(f: Flying, t: number, to: Point) {
    const inside = { x: to.x, y: (this.rimTop + 9) * P };
    const lip = { x: to.x, y: (this.rimTop - 5) * P };
    f.rot = 0;
    f.scale = 1;
    if (t < 0.55) {
      f.alpha = 0;
      f.depth = 1;
      f.x = inside.x;
      f.y = inside.y;
    } else if (t < 0.72) {
      const e = ease.outCubic((t - 0.55) / 0.17);
      f.alpha = 1;
      f.depth = 1 - e;
      f.x = inside.x;
      f.y = lerp(inside.y, lip.y, e);
    } else {
      const k = (t - 0.72) / 0.28;
      f.alpha = 1;
      f.depth = 0;
      f.x = to.x;
      f.y = lerp(lip.y, to.y, ease.outBack(k, 2.4)) - Math.sin(k * Math.PI) * 14;
    }
  }
}
