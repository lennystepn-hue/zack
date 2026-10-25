// Shared choreography. Every theme gets the same beats (swallow, emerge,
// present, dock) on the same clock; what the portal looks like and how a
// sprite moves through it is up to the theme.

import type { HitShape, ThemeId } from '../../../shared/types';
import { clamp, ease, lerp, Spring } from '../fx/motion';
import type { Sfx } from '../fx/audio';
import type { Sprite } from '../fx/sprite';

export type Mood = 'dormant' | 'idle' | 'hover' | 'charging';

export interface Layout {
  w: number;
  h: number;
  cx: number;
  cy: number;
  R: number;
  dpr: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Dock extends Point {
  size: number;
}

export interface Timing {
  swallow: number;
  stagger: number;
  emerge: number;
  present: number;
  dock: number;
}

export interface Flying {
  sprite: Sprite;
  dir: 'in' | 'out';
  start: number;
  from: Point;
  dock?: Dock;
  seed: number;
  x: number;
  y: number;
  scale: number;
  rot: number;
  alpha: number;
  /** 0 at the rim, 1 gone (in) / just born (out) */
  depth: number;
  phase: 'wait' | 'in' | 'emerge' | 'present' | 'dock';
  t: number;
  done: () => void;
  fired?: boolean;
}

export abstract class Theme {
  abstract readonly id: ThemeId;
  /** css px of a sprite while it is being presented */
  readonly spriteSize: number = 76;
  readonly timing: Timing = { swallow: 1050, stagger: 120, emerge: 760, present: 1750, dock: 480 };

  sfx: Sfx | null = null;
  mood: Mood = 'idle';

  protected L!: Layout;
  protected host!: HTMLElement;
  protected fx!: HTMLCanvasElement;
  protected g!: CanvasRenderingContext2D;
  protected hover = new Spring(0, 90, 15);
  protected charge = new Spring(0, 40, 11);
  protected dormant = new Spring(0, 30, 11);
  protected chargeTarget = 0;
  protected ptr = { x: new Spring(0, 50, 12), y: new Spring(0, 50, 12) };
  protected pointerOn = false;
  protected flying: Flying[] = [];
  protected now = 0;
  protected time = 0;

  attach(host: HTMLElement, L: Layout) {
    this.host = host;
    this.fx = document.createElement('canvas');
    this.fx.className = 'fx';
    this.g = this.fx.getContext('2d')!;
    this.setup();
    host.appendChild(this.fx);
    this.resize(L);
    this.setMood(this.mood);
  }

  resize(L: Layout) {
    this.L = L;
    this.fx.width = Math.round(L.w * L.dpr);
    this.fx.height = Math.round(L.h * L.dpr);
    this.fx.style.width = `${L.w}px`;
    this.fx.style.height = `${L.h}px`;
    this.layout();
  }

  detach() {
    for (const f of this.flying) f.done();
    this.flying = [];
    this.teardown();
    this.fx.remove();
  }

  setMood(m: Mood) {
    const was = this.mood;
    this.mood = m;
    this.hover.target = m === 'hover' ? 1 : 0;
    this.dormant.target = m === 'dormant' ? 1 : 0;
    if (m !== 'charging') this.chargeTarget = 0;
    this.charge.target = m === 'charging' ? Math.max(0.12, this.chargeTarget) : 0;
    if (m === 'hover' && was !== 'hover') this.sfx?.hover();
    if (m === 'charging' && was !== 'charging') this.sfx?.chargeStart();
    if (m !== 'charging' && was === 'charging') this.sfx?.chargeStop();
  }

  setCharge(p: number) {
    this.chargeTarget = clamp(p);
    if (this.mood === 'charging') this.charge.target = Math.max(0.12, this.chargeTarget);
    this.sfx?.chargeLevel(this.chargeTarget);
  }

  setPointer(p: Point | null) {
    this.pointerOn = !!p;
    if (!p) {
      this.ptr.x.target = 0;
      this.ptr.y.target = 0;
      return;
    }
    this.ptr.x.target = clamp((p.x - this.L.cx) / this.L.R, -1.6, 1.6);
    this.ptr.y.target = clamp((p.y - this.L.cy) / this.L.R, -1.6, 1.6);
  }

  /** Pulls sprites in from where they were dropped. Resolves once the last one is gone. */
  swallow(sprites: Sprite[], from: Point) {
    const promises = sprites.slice(0, 6).map(
      (sprite, i) =>
        new Promise<void>((done) => {
          const jitter = sprites.length > 1 ? { x: (i - (sprites.length - 1) / 2) * 14, y: (i % 2) * -8 } : { x: 0, y: 0 };
          this.flying.push(this.fly(sprite, 'in', { x: from.x + jitter.x, y: from.y + jitter.y }, i * this.timing.stagger, done));
        }),
    );
    return Promise.all(promises).then(() => undefined);
  }

  /** Spits a sprite out, holds it up for a moment, then files it into the shelf. */
  emit(sprite: Sprite, dock?: Dock) {
    return new Promise<void>((done) => {
      const f = this.fly(sprite, 'out', { x: this.L.cx, y: this.L.cy }, 0, done);
      f.dock = dock;
      this.flying.push(f);
    });
  }

  ignite() {
    this.sfx?.ignite();
    this.onIgnite();
  }

  busy() {
    return (
      this.flying.length > 0 ||
      this.mood === 'hover' ||
      this.mood === 'charging' ||
      !this.hover.settled() ||
      !this.charge.settled() ||
      !this.dormant.settled() ||
      this.pointerOn ||
      this.animating()
    );
  }

  tick(now: number, dt: number) {
    this.now = now;
    this.time += dt;
    this.hover.step(dt);
    this.charge.step(dt);
    this.dormant.step(dt);
    this.ptr.x.step(dt);
    this.ptr.y.step(dt);
    this.advance(now);
    this.draw(dt);
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.clearRect(0, 0, this.fx.width, this.fx.height);
    this.g.setTransform(this.L.dpr, 0, 0, this.L.dpr, 0, 0);
    this.drawOverlay(dt);
    // sprites in presentation sit on top of everything
    for (const f of this.flying) if (f.phase !== 'wait') this.drawFlying(f);
  }

  private fly(sprite: Sprite, dir: 'in' | 'out', from: Point, delay: number, done: () => void): Flying {
    return {
      sprite,
      dir,
      start: performance.now() + delay,
      from,
      seed: Math.random(),
      x: from.x,
      y: from.y,
      scale: dir === 'in' ? 1 : 0,
      rot: 0,
      alpha: dir === 'in' ? 1 : 0,
      depth: dir === 'in' ? 0 : 1,
      phase: 'wait',
      t: 0,
      done,
    };
  }

  private advance(now: number) {
    const T = this.timing;
    const keep: Flying[] = [];
    for (const f of this.flying) {
      const age = now - f.start;
      if (age < 0) {
        keep.push(f);
        continue;
      }
      if (f.dir === 'in') {
        f.phase = 'in';
        f.t = clamp(age / T.swallow);
        this.placeIn(f, f.t);
        if (f.t >= 1) {
          this.onSwallowed(f);
          this.sfx?.swallowed();
          f.done();
          continue;
        }
        if (!f.fired) {
          f.fired = true;
          this.sfx?.swallow();
        }
      } else {
        if (!f.fired) {
          f.fired = true;
          this.onEmerge(f);
          this.sfx?.emerge();
        }
        const p = this.presentPoint();
        if (age < T.emerge) {
          f.phase = 'emerge';
          f.t = age / T.emerge;
          this.placeEmerge(f, f.t, p);
        } else if (age < T.emerge + T.present || !f.dock) {
          f.phase = 'present';
          f.t = clamp((age - T.emerge) / T.present);
          const bob = Math.sin((age - T.emerge) / 380) * 2.2;
          f.x = p.x;
          f.y = p.y + bob;
          f.scale = 1;
          f.rot = Math.sin((age - T.emerge) / 600) * 0.025;
          f.alpha = 1;
          f.depth = 0;
          if (!f.dock && f.t >= 1) {
            f.done();
            continue;
          }
        } else {
          f.phase = 'dock';
          f.t = clamp((age - T.emerge - T.present) / T.dock);
          const e = ease.inOutCubic(f.t);
          const d = f.dock!;
          const arc = Math.sin(e * Math.PI) * -18;
          f.x = lerp(p.x, d.x, e);
          f.y = lerp(p.y, d.y, e) + arc;
          f.scale = lerp(1, d.size / this.spriteSize, e);
          f.rot = lerp(f.rot, 0, e);
          f.alpha = 1;
          if (f.t >= 1) {
            this.sfx?.land();
            f.done();
            continue;
          }
        }
      }
      keep.push(f);
    }
    this.flying = keep;
  }

  /** Default sprite drawing: a plain transformed image on the fx layer. */
  protected drawFlying(f: Flying) {
    const g = this.g;
    const s = this.spriteSize * f.scale;
    g.save();
    g.globalAlpha = clamp(f.alpha);
    g.translate(f.x, f.y);
    g.rotate(f.rot);
    g.drawImage(f.sprite.canvas, -s / 2, -s / 2, s, s);
    g.restore();
  }

  presentPoint(): Point {
    return { x: this.L.cx, y: this.L.cy };
  }

  /** The part of the widget that is "the object"; everything else lets clicks through. */
  hitShape(): HitShape {
    return { type: 'circle', x: this.L.cx, y: this.L.cy, r: this.L.R * 0.98 };
  }

  protected layout() {}
  protected drawOverlay(_dt: number) {}
  protected animating() {
    return false;
  }
  protected onSwallowed(_f: Flying) {}
  protected onEmerge(_f: Flying) {}
  protected onIgnite() {}
  protected abstract setup(): void;
  protected abstract teardown(): void;
  protected abstract draw(dt: number): void;
  protected abstract placeIn(f: Flying, t: number): void;
  protected abstract placeEmerge(f: Flying, t: number, to: Point): void;
}
