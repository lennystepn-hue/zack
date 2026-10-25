// A Schwarzschild black hole, ray-traced per pixel: photons bend around the
// hole, the far side of the accretion disk lifts over the shadow, the side
// spinning toward you burns brighter. Items get stretched on the way in.

import { clamp, ease, lerp, Spring } from '../fx/motion';
import { tinted } from '../fx/sprite';
import { Theme, type Flying, type Point } from './base';

const VERT = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

export const BLACK_HOLE_FRAG = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uR;
uniform float uTime;
uniform float uSpin;
uniform float uHeat;
uniform float uZoom;
uniform float uRing;
uniform float uBloom;
uniform float uShock;
uniform float uDormant;
uniform float uBlue;
uniform vec2 uTilt;
uniform float uJitter;
uniform float uLens;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.55;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.07 + 3.1; a *= 0.5; }
  return s;
}
vec3 blackbody(float t) {
  vec3 c = mix(vec3(0.30, 0.03, 0.01), vec3(0.98, 0.26, 0.04), smoothstep(0.05, 0.45, t));
  c = mix(c, vec3(1.0, 0.56, 0.16), smoothstep(0.40, 0.82, t));
  c = mix(c, vec3(1.0, 0.86, 0.62), smoothstep(0.85, 1.25, t));
  c = mix(c, vec3(0.80, 0.90, 1.0), smoothstep(1.25, 1.80, t));
  return c;
}

// density of the disk at a point, rotating differentially; two phase-shifted
// layers crossfade so the spiral never winds itself into noise
float diskDensity(vec2 xz, float r) {
  float omega = pow(r, -1.5);
  float ph = uSpin * omega * 2.2;
  float cyc = 6.0;
  float fa = fract(ph / cyc), fb = fract(ph / cyc + 0.5);
  float wa = 1.0 - abs(2.0 * fa - 1.0);
  float d = 0.0;
  for (int k = 0; k < 2; k++) {
    float f = k == 0 ? fa : fb;
    float w = k == 0 ? wa : 1.0 - wa;
    float a = atan(xz.y, xz.x) - f * cyc;
    vec3 q = vec3(cos(a) * 2.1, sin(a) * 2.1, r * 1.65 + float(k) * 7.3);
    float n = fbm(q) * 0.75 + 0.35 * fbm(vec3(cos(a) * 5.0, sin(a) * 5.0, r * 4.5 + float(k) * 3.7));
    d += w * n;
  }
  return d;
}

vec3 stars(vec3 d) {
  vec3 p = d * 70.0;
  vec3 c = floor(p);
  vec3 f = fract(p) - 0.5;
  float h = hash(c);
  vec3 off = (vec3(hash(c + 1.7), hash(c + 3.1), hash(c + 5.3)) - 0.5) * 0.6;
  float s = step(0.955, h) * smoothstep(0.22, 0.0, length(f - off));
  float tw = 0.65 + 0.35 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
  return vec3(0.85, 0.9, 1.0) * s * tw * (0.5 + hash(c + 9.0));
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 q0 = (px - uCenter) / uR;
  q0.y = -q0.y;
  float L0 = length(q0);
  vec2 q = q0;

  if (uShock >= 0.0) {
    float d = L0 - uShock;
    q *= 1.0 + 0.07 * exp(-d * d * 70.0) * sin(d * 55.0) * (1.0 - uShock / 1.7);
  }
  if (uJitter > 0.0) q += uJitter * 0.018 * (vec2(hash(vec3(floor(uTime * 40.0), 1.0, 2.0)), hash(vec3(3.0, floor(uTime * 40.0), 4.0))) - 0.5);

  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float heat = uHeat;

  if (L0 < 1.32) {
    float incl = 0.155 + uTilt.y;
    float yaw = uTilt.x;
    float D = 26.0;
    vec3 cam = D * vec3(sin(yaw) * cos(incl), sin(incl), -cos(yaw) * cos(incl));
    vec3 fw = normalize(-cam);
    vec3 rt = normalize(cross(vec3(0.0, 1.0, 0.0), fw));
    vec3 up = cross(fw, rt);
    float fov = 0.305 / uZoom;
    vec3 dir = normalize(fw + (q.x * rt + q.y * up) * fov);
    float rIn = 2.35, rOut = 9.4;
    bool captured = true;

    // Each photon stays in the plane spanned by the camera position and its
    // direction, so trace the orbit equation u'' + u = 1.5u² (u = 1/r) in
    // that plane. Stable, cheap, and the shadow edge comes out clean.
    vec3 e1 = normalize(cam);
    float vr = dot(dir, e1);
    vec3 perp = dir - vr * e1;
    float vp = max(length(perp), 1e-5);
    vec3 e2 = perp / vp;
    float u = 1.0 / D;
    float du = -u * vr / vp;
    float phi = 0.0;
    float umax = u;
    vec3 pos = cam;
    vec3 vel = dir;

    for (int i = 0; i < 260; i++) {
      float dphi = mix(0.11, 0.022, smoothstep(0.06, 0.55, u));
      du += (-u + 1.5 * u * u) * dphi * 0.5;
      u += du * dphi;
      du += (-u + 1.5 * u * u) * dphi * 0.5;
      phi += dphi;
      umax = max(umax, u);
      if (u >= 1.0) break;
      if (u <= 0.0) { captured = false; break; }
      vec3 prev = pos;
      pos = (cos(phi) * e1 + sin(phi) * e2) / u;
      vel = normalize(pos - prev);
      if (prev.y * pos.y < 0.0) {
        float t = prev.y / (prev.y - pos.y);
        vec3 hp = mix(prev, pos, t);
        float rr = length(hp.xz);
        if (rr > rIn && rr < rOut) {
          float dens = diskDensity(hp.xz, rr);
          float edge = smoothstep(rIn, rIn + 0.55, rr) * (1.0 - smoothstep(rOut - 3.2, rOut, rr));
          float I = pow(rIn / rr, 1.25);
          vec3 vt = normalize(vec3(-hp.z, 0.0, hp.x));
          float beta = clamp(sqrt(0.5 / rr), 0.0, 0.62);
          float gamma = inversesqrt(1.0 - beta * beta);
          float cosT = dot(vt, -normalize(vel));
          float g = clamp(1.0 / (gamma * (1.0 - beta * cosT)), 0.35, 2.1) * sqrt(max(0.05, 1.0 - 1.0 / rr));
          float temp = (pow(I, 0.3) * 0.95 + dens * 0.25) * g * (0.62 + 0.45 * heat) + uBlue * 0.55;
          vec3 c = blackbody(temp) * I * g * g * g * (0.45 + 1.4 * dens) * (0.7 + 0.9 * heat) * 2.9;
          c = 1.0 - exp(-c * 1.1);
          float a = clamp((0.25 + 1.05 * dens) * edge * (0.55 + 0.45 * I), 0.0, 0.97);
          col += (1.0 - alpha) * c * a;
          alpha += (1.0 - alpha) * a;
        }
      }
      if (u < 1.0 / (D * 1.3) && du < 0.0) { captured = false; break; }
      if (alpha > 0.985) { captured = false; break; }
    }

    float lens = (1.0 - smoothstep(0.5, 1.05, L0)) * uLens * 0.75;
    if (captured) {
      alpha = 1.0;
    } else {
      // photons that skimmed the photon sphere pile up into a thin bright ring
      float skim = exp(-pow((1.0 / umax - 1.5) * 6.5, 2.0)) * (0.45 + 0.4 * heat);
      vec3 rc = mix(vec3(1.0, 0.78, 0.5), vec3(0.75, 0.88, 1.0), uBlue) * skim;
      col += (1.0 - alpha) * rc;
      alpha += (1.0 - alpha) * clamp(skim, 0.0, 1.0);
      vec3 dir = normalize(vel);
      vec3 st = stars(dir) * lens;
      col += (1.0 - alpha) * (st + vec3(0.006, 0.008, 0.016) * lens);
      alpha += (1.0 - alpha) * clamp(lens * 0.5 + dot(st, vec3(0.33)), 0.0, 1.0);
    }

    float shadowQ = 0.335 * uZoom;
    float ring = exp(-pow((L0 - shadowQ) / 0.045, 2.0));
    col += vec3(1.0, 0.82, 0.6) * ring * uRing * 1.6;
    alpha = max(alpha, clamp(ring * uRing, 0.0, 1.0));
  }

  // white-hole flash for things coming out
  float bloom = exp(-L0 * L0 * 9.0) * uBloom;
  col += vec3(1.0, 0.95, 0.88) * bloom * 1.6;
  alpha = clamp(alpha + bloom, 0.0, 1.0);

  // warm haze that bleeds onto the desktop
  float glow = exp(-pow(max(L0 - 0.25, 0.0) / 0.48, 1.6)) * (0.10 + 0.10 * heat);
  vec3 gc = mix(vec3(1.0, 0.5, 0.18), vec3(0.6, 0.75, 1.0), uBlue);
  col += (1.0 - alpha) * gc * glow;
  alpha += (1.0 - alpha) * glow * 0.55;

  float lum = dot(col, vec3(0.3, 0.59, 0.11));
  col = mix(col, vec3(lum) * vec3(0.55, 0.62, 0.82), uDormant * 0.85) * (1.0 - 0.55 * uDormant);
  o = vec4(col, alpha);
}`;

export class Singularity extends Theme {
  readonly id = 'singularity' as const;

  private gl!: WebGL2RenderingContext;
  private canvas!: HTMLCanvasElement;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private spin = 0;
  private spinSpeed = new Spring(1, 20, 9);
  private zoom = new Spring(1, 70, 11);
  private heat = new Spring(0.8, 30, 10);
  private ring = 0;
  private bloom = 0;
  private shock = -1;
  private side = 0;
  private origin = { x: 0, y: 0 };
  private lost = false;

  protected setup() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'portal';
    this.host.appendChild(this.canvas);
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, powerPreference: 'high-performance' });
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
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, BLACK_HOLE_FRAG));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    gl.useProgram(p);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['uRes', 'uCenter', 'uR', 'uTime', 'uSpin', 'uHeat', 'uZoom', 'uRing', 'uBloom', 'uShock', 'uDormant', 'uBlue', 'uTilt', 'uJitter', 'uLens'])
      this.u[n] = gl.getUniformLocation(p, n);
  }

  protected layout() {
    const { R, cx, cy, dpr } = this.L;
    this.side = Math.ceil(R * 2.7);
    this.origin = { x: cx - this.side / 2, y: cy - this.side / 2 };
    const q = Math.min(dpr, 2);
    this.canvas.width = Math.round(this.side * q);
    this.canvas.height = Math.round(this.side * q);
    Object.assign(this.canvas.style, { width: `${this.side}px`, height: `${this.side}px`, left: `${this.origin.x}px`, top: `${this.origin.y}px` });
  }

  protected teardown() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }

  protected animating() {
    return this.ring > 0.01 || this.bloom > 0.01 || this.shock >= 0 || !this.zoom.settled();
  }

  protected draw(dt: number) {
    const h = this.hover.value;
    const c = this.charge.value;
    const d = this.dormant.value;
    this.zoom.target = 1 + 0.2 * (this.mood === 'hover' ? 1 : 0) + 0.12 * (this.mood === 'charging' ? 1 : 0) - 0.08 * (this.mood === 'dormant' ? 1 : 0);
    this.heat.target = 0.85 + 0.4 * (this.mood === 'hover' ? 1 : 0) + 0.7 * c - 0.5 * (this.mood === 'dormant' ? 1 : 0);
    this.spinSpeed.target = this.mood === 'dormant' ? 0.25 : 1 + 2.4 * h + 4 * c;
    this.zoom.step(dt);
    this.heat.step(dt);
    this.spinSpeed.step(dt);
    this.spin += dt * this.spinSpeed.value;
    this.ring *= Math.exp(-dt * 3.2);
    this.bloom *= Math.exp(-dt * 4.5);
    if (this.shock >= 0) {
      this.shock += dt * 1.25;
      if (this.shock > 1.7) this.shock = -1;
    }
    if (this.lost) return;

    const gl = this.gl;
    const k = this.canvas.width / this.side;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(this.u.uCenter, (this.L.cx - this.origin.x) * k, (this.L.cy - this.origin.y) * k);
    gl.uniform1f(this.u.uR, this.L.R * k);
    gl.uniform1f(this.u.uTime, this.time);
    gl.uniform1f(this.u.uSpin, this.spin);
    gl.uniform1f(this.u.uHeat, this.heat.value);
    gl.uniform1f(this.u.uZoom, this.zoom.value);
    gl.uniform1f(this.u.uRing, this.ring);
    gl.uniform1f(this.u.uBloom, this.bloom);
    gl.uniform1f(this.u.uShock, this.shock);
    gl.uniform1f(this.u.uDormant, d);
    gl.uniform1f(this.u.uBlue, c * 0.7);
    const wobble = Math.sin(this.time * 0.21) * 0.012;
    gl.uniform2f(this.u.uTilt, this.ptr.x.value * 0.09 + wobble, -this.ptr.y.value * 0.06 + Math.sin(this.time * 0.17) * 0.01);
    gl.uniform1f(this.u.uJitter, c * c);
    gl.uniform1f(this.u.uLens, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  protected onSwallowed() {
    this.ring = 1;
    this.shock = 0.1;
    this.heat.kick(2.5);
    this.zoom.kick(-0.9);
  }

  protected onEmerge() {
    this.bloom = 1.2;
    this.ring = 0.8;
    this.shock = 0.05;
    this.zoom.kick(1.6);
  }

  protected onIgnite() {
    this.bloom = 0.9;
    this.ring = 1;
    this.shock = 0.05;
    this.heat.kick(4);
  }

  /** In along a tightening spiral, stretched along the radius, reddened. */
  protected placeIn(f: Flying, t: number) {
    const { cx, cy, R } = this.L;
    const dx = f.from.x - cx;
    const dy = f.from.y - cy;
    const r0 = Math.max(Math.hypot(dx, dy), R * 0.55);
    const a0 = Math.atan2(dy, dx);
    // a tug right away, then the fall accelerates
    const e = 0.2 * t + 0.8 * t * t * t;
    const r = lerp(r0, R * 0.04, e);
    const a = a0 + 3.4 * e ** 1.5;
    f.x = cx + Math.cos(a) * r;
    f.y = cy + Math.sin(a) * r;
    f.scale = lerp(0.82, 0.08, e ** 1.1);
    f.depth = clamp(1 - r / (R * 0.9));
    f.rot = a;
    f.alpha = 1 - clamp((t - 0.88) / 0.12);
  }

  protected placeEmerge(f: Flying, t: number, to: Point) {
    const e = ease.outBack(clamp(t / 0.8), 1.5);
    f.x = lerp(this.L.cx, to.x, e);
    f.y = lerp(this.L.cy, to.y, e);
    f.scale = lerp(0.05, 1, e);
    f.rot = lerp(f.seed > 0.5 ? 0.7 : -0.7, 0, ease.outCubic(t));
    f.alpha = clamp(t * 6);
    f.depth = 1 - ease.outCubic(t);
  }

  protected drawFlying(f: Flying) {
    const g = this.g;
    const size = this.spriteSize * f.scale;
    if (size < 0.5) return;
    if (f.phase === 'in') {
      // spaghettification: stretch along the radius as tidal forces win
      const k = clamp((f.depth - 0.3) / 0.7);
      const radial = Math.atan2(f.y - this.L.cy, f.x - this.L.cx);
      const src = tinted(f.sprite.canvas, k * 0.85, [255, 70, 25]);
      g.save();
      g.globalAlpha = f.alpha;
      g.translate(f.x, f.y);
      g.rotate(radial);
      g.scale(1 + 2.6 * k, 1 - 0.72 * k);
      g.rotate(f.rot * 0.3 - radial);
      g.drawImage(src, -size / 2, -size / 2, size, size);
      g.restore();
      return;
    }
    if (f.phase === 'emerge') {
      // a short zoom smear behind it, then it settles cold-blue to normal
      const src = tinted(f.sprite.canvas, f.depth * 0.6, [150, 190, 255]);
      for (let i = 3; i >= 1; i--) {
        const s = size * (1 + i * 0.12 * f.depth);
        g.save();
        g.globalAlpha = f.alpha * 0.18 * f.depth;
        g.translate(f.x, f.y);
        g.rotate(f.rot);
        g.drawImage(src, -s / 2, -s / 2, s, s);
        g.restore();
      }
      g.save();
      g.globalAlpha = f.alpha;
      g.translate(f.x, f.y);
      g.rotate(f.rot);
      g.drawImage(src, -size / 2, -size / 2, size, size);
      g.restore();
      return;
    }
    super.drawFlying(f);
  }
}
