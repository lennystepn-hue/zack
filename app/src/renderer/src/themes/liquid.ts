// A puddle of liquid metal. Files sink in with real ripples; on the other
// machine the surface swells, a column of metal rises, and the file is
// left standing where it melts away.

import { clamp, ease, lerp, Spring } from '../fx/motion';
import { tinted } from '../fx/sprite';
import { Theme, type Flying, type Point } from './base';

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const MAX_RIPPLES = 6;
const MAX_BLOBS = 8;

const FRAG = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 uRes;
uniform float uK;
uniform float uTime;
uniform vec3 uPool;       // centre x, y, radius x (css px)
uniform float uSquash;    // ry / rx
uniform vec4 uRip[${MAX_RIPPLES}];  // x, y (pool units), age (s, <0 off), amplitude
uniform vec4 uBlob[${MAX_BLOBS}];  // x, y, r (css px), on
uniform float uBulge;
uniform float uHover;
uniform vec2 uPtr;
uniform float uDormant;
uniform float uWarm;

float height(vec2 p) {
  float h = 0.016 * (sin(p.x * 7.0 + uTime * 1.3) + sin(p.y * 9.0 - uTime * 1.1) + sin((p.x + p.y) * 5.0 + uTime * 0.7)) * (1.0 + uHover);
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRip[i];
    if (r.z < 0.0) continue;
    float d = length(p - r.xy);
    float front = r.z * 0.75 + 0.04;
    float w = sin(d * 30.0 - r.z * 16.0) * exp(-r.z * 1.7) * exp(-d * 1.4) * smoothstep(front, front - 0.25, d);
    h += r.w * 0.05 * w;
  }
  h += uBulge * 0.22 * exp(-dot(p, p) / 0.07);
  h -= uHover * 0.035 * exp(-dot(p - uPtr, p - uPtr) / 0.04);
  return h;
}

// a dark studio: black floor, a dim sky, two hard light boxes and a bright horizon line
vec3 env(vec3 d) {
  float y = d.y;
  vec3 sky = mix(vec3(0.2, 0.21, 0.23), vec3(0.82, 0.84, 0.88), smoothstep(0.05, 0.95, y));
  float horizon = exp(-pow(y - 0.08, 2.0) * 140.0) * 0.9;
  float box1 = exp(-(pow(d.x - 0.32, 2.0) * 34.0 + pow(d.z + 0.5, 2.0) * 14.0)) * step(0.0, y);
  float box2 = exp(-(pow(d.x + 0.55, 2.0) * 60.0 + pow(d.z + 0.15, 2.0) * 26.0)) * step(0.0, y);
  vec3 c = sky + vec3(0.95, 0.97, 1.0) * horizon + vec3(1.0) * box1 * 2.2 + mix(vec3(0.6, 0.75, 1.0), vec3(1.0, 0.72, 0.45), uWarm) * box2 * 1.3;
  return y < 0.0 ? mix(vec3(0.06, 0.065, 0.07), c, smoothstep(-0.15, 0.0, y)) : c;
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uK;
  vec3 col = vec3(0.0);
  float alpha = 0.0;

  // pool
  vec2 p = vec2(px.x - uPool.x, (px.y - uPool.y) / uSquash) / uPool.z;
  float ang = atan(p.y, p.x);
  float edge = 1.0 + 0.025 * sin(ang * 4.0 + uTime * 0.8) + 0.018 * sin(ang * 7.0 - uTime * 1.1) + uBulge * 0.04;
  float rr = length(p);
  float aa = 1.5 / (uPool.z * uK * uSquash);
  if (rr < edge + aa) {
    float e = 0.004;
    float h = height(p);
    float gx = (height(p + vec2(e, 0.0)) - h) / e;
    float gy = (height(p + vec2(0.0, e)) - h) / e;
    vec3 n = normalize(vec3(-gx, 1.0, gy));
    vec3 v = normalize(vec3(0.0, -0.5, 0.87));
    vec3 c = env(reflect(v, n)) * vec3(0.93, 0.95, 0.98);
    float rim = smoothstep(edge - 0.1, edge, rr);
    c *= 1.0 - rim * 0.55;
    c += vec3(1.0) * pow(rim, 3.0) * step(p.y, 0.0) * 0.5;
    col = c;
    alpha = smoothstep(edge + aa, edge - aa, rr);
  }
  // contact shadow around the puddle
  float shade = (1.0 - smoothstep(edge, edge + 0.3, rr)) * step(edge, rr) * 0.35;
  col *= alpha;
  alpha = max(alpha, shade);

  // metaballs: drops and the rising column
  float F = 0.0;
  for (int i = 0; i < ${MAX_BLOBS}; i++) {
    vec4 b = uBlob[i];
    if (b.w < 0.5) continue;
    vec2 d = px - b.xy;
    F += b.z * b.z / max(dot(d, d), 0.01);
  }
  // derivatives must be taken outside any branch
  float hgt = clamp(1.0 - 1.0 / max(F, 0.001), 0.0, 1.0);
  vec2 g = vec2(dFdx(hgt), dFdy(hgt)) * uK * 7.0;
  if (F > 0.6) {
    vec3 n = normalize(vec3(-g.x, g.y, 1.0));
    // a standing blob mirrors the room: sky above, floor below, light boxes on the shoulders
    vec3 c = env(normalize(vec3(n.x * 1.25, 0.24 + n.y * 0.75, -0.45 - n.x * 0.3))) * vec3(0.93, 0.95, 0.98);
    float a = smoothstep(0.95, 1.08, F);
    col = mix(col, c, a);
    alpha = max(alpha, a);
  }

  float lum = dot(col, vec3(0.3, 0.59, 0.11));
  col = mix(col, vec3(lum) * 0.7, uDormant * 0.6);
  o = vec4(col, alpha);
}`;

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export class Liquid extends Theme {
  readonly id = 'liquid' as const;
  readonly spriteSize = 76;
  readonly timing = { swallow: 1500, stagger: 240, emerge: 1700, present: 1700, dock: 460 };

  private gl!: WebGL2RenderingContext;
  private canvas!: HTMLCanvasElement;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private ripples: { x: number; y: number; t0: number; amp: number }[] = [];
  private drops: Drop[] = [];
  private bulge = new Spring(0, 40, 7);
  private nextIdle = 2;
  private fired = new WeakMap<Flying, Set<string>>();
  private lost = false;

  private readonly pool = { x: 130, y: 172, rx: 82, squash: 0.36 };

  protected setup() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'portal';
    this.host.appendChild(this.canvas);
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) throw new Error('webgl2 unavailable');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.compile();
    });
    this.compile();
  }

  private compile() {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['uRes', 'uK', 'uTime', 'uPool', 'uSquash', 'uRip', 'uBlob', 'uBulge', 'uHover', 'uPtr', 'uDormant', 'uWarm'])
      this.u[n] = gl.getUniformLocation(p, n);
  }

  protected teardown() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }

  protected layout() {
    const { w, dpr } = this.L;
    const h = 240;
    const q = Math.min(dpr, 2);
    this.canvas.width = Math.round(w * q);
    this.canvas.height = Math.round(h * q);
    Object.assign(this.canvas.style, { width: `${w}px`, height: `${h}px`, left: '0px', top: '0px' });
  }

  hitShape() {
    return { type: 'rect' as const, x: 40, y: 128, w: 180, h: 82 };
  }

  presentPoint(): Point {
    return { x: 130, y: 74 };
  }

  protected animating() {
    return this.ripples.length > 0 || this.drops.length > 0 || !this.bulge.settled();
  }

  /** css px → pool units */
  private toPool(x: number, y: number) {
    return { x: (x - this.pool.x) / this.pool.rx, y: (y - this.pool.y) / this.pool.squash / this.pool.rx };
  }

  private ripple(x: number, y: number, amp = 1) {
    const p = this.toPool(x, y);
    this.ripples.push({ x: p.x, y: p.y, t0: this.time, amp });
    if (this.ripples.length > MAX_RIPPLES) this.ripples.shift();
  }

  private splash(x: number, y: number, n: number, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
      const sp = (90 + Math.random() * 90) * power;
      this.drops.push({ x, y: y - 4, vx: Math.cos(a) * sp * 0.6, vy: Math.sin(a) * sp, r: 3 + Math.random() * 3 });
    }
  }

  protected draw(dt: number) {
    const ch = this.charge.value;
    const hv = this.hover.value;

    // the surface swells while something is on its way
    const emerging = this.flying.find((f) => f.phase === 'emerge');
    let bulgeTarget = this.mood === 'charging' ? 0.25 + ch * 0.55 + Math.sin(this.time * 5) * 0.08 * ch : 0;
    if (emerging) bulgeTarget = emerging.t < 0.4 ? lerp(0.4, 1, emerging.t / 0.4) : emerging.t < 0.75 ? 0.6 : 0;
    this.bulge.target = bulgeTarget;
    this.bulge.step(dt);
    if (this.mood === 'charging' && Math.random() < ch * 0.03) this.splash(this.pool.x + (Math.random() - 0.5) * 30, this.pool.y, 1, 0.6);

    // now and then a drip from nowhere, so it never looks frozen
    this.nextIdle -= dt;
    if (this.nextIdle <= 0 && this.mood !== 'dormant') {
      this.ripple(this.pool.x + (Math.random() - 0.5) * 100, this.pool.y + (Math.random() - 0.5) * 30, 0.35);
      this.nextIdle = 3 + Math.random() * 4;
    }

    // drops fly, fall back, and ring the surface
    const keep: Drop[] = [];
    for (const d of this.drops) {
      d.vy += 520 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (d.vy > 0 && d.y >= this.pool.y - 2) {
        this.ripple(d.x, Math.min(d.y, this.pool.y + 10), 0.6);
        continue;
      }
      keep.push(d);
    }
    this.drops = keep;
    this.ripples = this.ripples.filter((r) => this.time - r.t0 < 3.2);

    const blobs: number[] = [];
    const blob = (x: number, y: number, r: number) => blobs.length < MAX_BLOBS * 4 && blobs.push(x, y, r, 1);
    for (const d of this.drops) blob(d.x, d.y, d.r);
    for (const f of this.flying) this.columnFor(f, blob);
    while (blobs.length < MAX_BLOBS * 4) blobs.push(0, 0, 0, 0);

    if (this.lost) return;
    const gl = this.gl;
    const k = this.canvas.width / this.L.w;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uK, k);
    gl.uniform1f(this.u.uTime, this.time);
    gl.uniform3f(this.u.uPool, this.pool.x, this.pool.y, this.pool.rx);
    gl.uniform1f(this.u.uSquash, this.pool.squash);
    const rip: number[] = [];
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const r = this.ripples[i];
      rip.push(r ? r.x : 0, r ? r.y : 0, r ? this.time - r.t0 : -1, r ? r.amp : 0);
    }
    gl.uniform4fv(this.u.uRip, rip);
    gl.uniform4fv(this.u.uBlob, blobs);
    gl.uniform1f(this.u.uBulge, this.bulge.value);
    gl.uniform1f(this.u.uHover, hv);
    const ptr = this.toPool(this.L.cx + this.ptr.x.value * this.L.R, this.L.cy + this.ptr.y.value * this.L.R);
    gl.uniform2f(this.u.uPtr, ptr.x, ptr.y);
    gl.uniform1f(this.u.uDormant, this.dormant.value);
    gl.uniform1f(this.u.uWarm, 0.5 + 0.5 * Math.sin(this.time * 0.2));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** the rising column of metal that delivers an item */
  private columnFor(f: Flying, blob: (x: number, y: number, r: number) => void) {
    if (f.phase !== 'emerge') return;
    const t = f.t;
    const to = this.presentPoint();
    const base = { x: this.pool.x, y: this.pool.y - 6 };
    if (t < 0.38 || t > 0.86) return;
    const rise = ease.outCubic(clamp((t - 0.38) / 0.3));
    const melt = clamp((t - 0.66) / 0.2);
    const topY = lerp(base.y, to.y, rise);
    const r = 30 * (1 - ease.inCubic(melt));
    blob(base.x, base.y, 20 * (1 - melt));
    blob(base.x, lerp(base.y, topY, 0.5), 14 * (1 - melt * 1.2));
    if (r > 0.5) blob(to.x, topY, r);
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
    if (f.phase === 'in')
      once('touch', f.t > 0.42, () => {
        this.ripple(this.pool.x, this.pool.y, 1.4);
        this.splash(this.pool.x, this.pool.y, 4);
      });
    if (f.phase === 'emerge') {
      once('crown', f.t > 0.36, () => this.ripple(this.pool.x, this.pool.y, 1.2));
      once('melt', f.t > 0.7, () => this.splash(this.presentPoint().x, this.presentPoint().y + 10, 5, 0.5));
    }
  }

  protected onIgnite() {
    this.ripple(this.pool.x, this.pool.y, 1.6);
    this.splash(this.pool.x, this.pool.y, 7, 1.2);
  }

  protected placeIn(f: Flying, t: number) {
    const above = { x: this.pool.x, y: this.pool.y - 58 };
    if (t < 0.38) {
      const e = ease.inOutCubic(t / 0.38);
      f.x = lerp(f.from.x, above.x, e);
      f.y = lerp(f.from.y, above.y, e) - Math.sin(e * Math.PI) * 20;
      f.scale = lerp(0.9, 0.78, e);
      f.rot = lerp(0.2, 0, e);
      f.depth = 0;
      f.alpha = 1;
    } else {
      const e = ease.inOutCubic((t - 0.38) / 0.62);
      f.x = above.x;
      f.y = lerp(above.y, this.pool.y + 18, e);
      f.scale = lerp(0.78, 0.6, e);
      f.rot = 0;
      f.depth = e;
      f.alpha = 1 - clamp((t - 0.85) / 0.15);
    }
  }

  protected placeEmerge(f: Flying, t: number, to: Point) {
    f.x = to.x;
    f.y = to.y;
    f.rot = 0;
    f.scale = t < 0.66 ? 0.9 : lerp(0.9, 1, ease.outBack(clamp((t - 0.66) / 0.34), 2));
    f.alpha = t < 0.66 ? 0 : 1;
    f.depth = 1 - clamp((t - 0.66) / 0.34);
  }

  protected drawFlying(f: Flying) {
    this.cue(f);
    const g = this.g;
    const s = this.spriteSize * f.scale;
    if (f.alpha <= 0) return;
    g.save();
    if (f.phase === 'in' && f.depth > 0) {
      // under the surface it's gone: clip at the waterline
      g.beginPath();
      g.rect(0, 0, this.L.w, this.pool.y - 2);
      g.clip();
    }
    g.globalAlpha = f.alpha;
    g.translate(f.x, f.y);
    g.rotate(f.rot);
    // coated in metal as it goes under, and still wet as it comes out
    const silver = f.phase === 'in' ? clamp(f.depth * 1.4) * 0.75 : f.phase === 'emerge' ? f.depth * 0.8 : 0;
    g.drawImage(tinted(f.sprite.canvas, silver, [205, 212, 222]), -s / 2, -s / 2, s, s);
    g.restore();
  }
}
