// All sound is synthesized on the spot: no samples, nothing borrowed.

import type { ThemeId } from '../../../shared/types';

export interface Sfx {
  hover(): void;
  swallow(): void;
  swallowed(): void;
  emerge(): void;
  land(): void;
  chargeStart(): void;
  chargeLevel(p: number): void;
  chargeStop(): void;
  ignite(): void;
}

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let enabled = true;
let noiseBuf: AudioBuffer | null = null;

export function setSound(on: boolean) {
  enabled = on;
  if (out) out.gain.value = on ? 0.6 : 0;
}

function ac() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    out = ctx.createGain();
    out.gain.value = enabled ? 0.6 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    // a short feedback delay gives everything a little room without a reverb impulse
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.11;
    const fb = ctx.createGain();
    fb.gain.value = 0.22;
    const wet = ctx.createGain();
    wet.gain.value = 0.18;
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    damp.frequency.value = 2400;
    out.connect(comp);
    out.connect(delay);
    delay.connect(damp).connect(fb).connect(delay);
    damp.connect(wet).connect(comp);
    comp.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function noise() {
  const c = ac();
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

interface ToneOpts {
  type?: OscillatorType;
  f0: number;
  f1?: number;
  dur: number;
  gain: number;
  attack?: number;
  at?: number;
  curve?: 'exp' | 'lin';
}

function tone(o: ToneOpts) {
  if (!enabled) return;
  const c = ac();
  const t = c.currentTime + (o.at ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1 !== undefined) {
    if (o.curve === 'lin') osc.frequency.linearRampToValueAtTime(o.f1, t + o.dur);
    else osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + o.dur);
  }
  const a = o.attack ?? 0.008;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  osc.connect(g).connect(out!);
  osc.start(t);
  osc.stop(t + o.dur + 0.05);
}

interface NoiseOpts {
  dur: number;
  f0: number;
  f1?: number;
  q?: number;
  gain: number;
  type?: BiquadFilterType;
  attack?: number;
  at?: number;
}

function hiss(o: NoiseOpts) {
  if (!enabled) return;
  const c = ac();
  const t = c.currentTime + (o.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noise();
  src.loop = true;
  const f = c.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.Q.value = o.q ?? 1;
  f.frequency.setValueAtTime(o.f0, t);
  if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
  const g = c.createGain();
  const a = o.attack ?? 0.05;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  src.connect(f).connect(g).connect(out!);
  src.start(t, Math.random());
  src.stop(t + o.dur + 0.05);
}

function crackle(count: number, spread: number, gain: number, at = 0) {
  for (let i = 0; i < count; i++) {
    hiss({ dur: 0.006 + Math.random() * 0.018, f0: 2500 + Math.random() * 5000, q: 0.7, gain: gain * (0.4 + Math.random() * 0.6), type: 'highpass', attack: 0.001, at: at + Math.random() * spread });
  }
}

/** A sustained voice for the "something is coming" build-up. */
class Drone {
  private nodes: { stop(): void }[] = [];
  private osc: OscillatorNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  private base: number;
  private span: number;
  private type: OscillatorType;
  private level: number;

  constructor(base: number, span: number, type: OscillatorType, level: number) {
    this.base = base;
    this.span = span;
    this.type = type;
    this.level = level;
  }

  start() {
    if (!enabled || this.osc) return;
    const c = ac();
    const t = c.currentTime;
    this.osc = c.createOscillator();
    this.osc.type = this.type;
    this.osc.frequency.value = this.base;
    const lfo = c.createOscillator();
    lfo.frequency.value = 6;
    const lfoGain = c.createGain();
    lfoGain.gain.value = this.base * 0.04;
    lfo.connect(lfoGain).connect(this.osc.frequency);
    this.filter = c.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 300;
    this.gain = c.createGain();
    this.gain.gain.setValueAtTime(0.0001, t);
    this.gain.gain.exponentialRampToValueAtTime(this.level, t + 0.4);
    this.osc.connect(this.filter).connect(this.gain).connect(out!);
    this.osc.start();
    lfo.start();
    this.nodes = [this.osc, lfo];
  }

  set(p: number) {
    if (!this.osc || !ctx) return;
    const t = ctx.currentTime;
    this.osc.frequency.setTargetAtTime(this.base + this.span * p, t, 0.15);
    this.filter!.frequency.setTargetAtTime(300 + 1800 * p, t, 0.15);
  }

  stop() {
    if (!this.osc || !ctx) return;
    const t = ctx.currentTime;
    this.gain!.gain.setTargetAtTime(0.0001, t, 0.08);
    const nodes = this.nodes;
    setTimeout(() => nodes.forEach((n) => n.stop()), 500);
    this.osc = null;
  }
}

function singularity(): Sfx {
  const drone = new Drone(42, 70, 'sawtooth', 0.09);
  return {
    hover: () => {
      tone({ f0: 46, f1: 58, dur: 1.1, gain: 0.22, attack: 0.35 });
      hiss({ dur: 0.9, f0: 220, f1: 420, gain: 0.05, type: 'lowpass', attack: 0.3 });
    },
    swallow: () => {
      hiss({ dur: 1.0, f0: 2200, f1: 180, q: 1.4, gain: 0.32, attack: 0.25 });
      tone({ f0: 240, f1: 52, dur: 1.0, gain: 0.08, attack: 0.3 });
    },
    swallowed: () => {
      tone({ f0: 78, f1: 30, dur: 0.75, gain: 0.7, attack: 0.004 });
      tone({ type: 'triangle', f0: 160, f1: 60, dur: 0.25, gain: 0.18, attack: 0.002 });
      hiss({ dur: 0.18, f0: 900, f1: 120, gain: 0.25, type: 'lowpass', attack: 0.002 });
    },
    emerge: () => {
      hiss({ dur: 0.4, f0: 160, f1: 3600, q: 1.1, gain: 0.3, attack: 0.3 });
      tone({ f0: 50, f1: 110, dur: 0.38, gain: 0.35, attack: 0.3 });
      for (const [f, d] of [[880, 0], [1318.5, 0.04], [1760, 0.08], [2637, 0.12]])
        tone({ f0: f, f1: f * 1.004, dur: 1.4, gain: 0.045, attack: 0.01, at: 0.34 + d });
      tone({ f0: 95, f1: 42, dur: 0.4, gain: 0.45, attack: 0.003, at: 0.34 });
    },
    land: () => tone({ f0: 1400, f1: 980, dur: 0.07, gain: 0.05 }),
    chargeStart: () => drone.start(),
    chargeLevel: (p) => drone.set(p),
    chargeStop: () => drone.stop(),
    ignite: () => {
      for (const [f, d] of [[110, 0], [164.8, 0.1], [220, 0.2], [329.6, 0.3], [440, 0.4]]) tone({ f0: f, dur: 2.4, gain: 0.07, attack: 0.5, at: d });
      hiss({ dur: 1.8, f0: 300, f1: 2400, gain: 0.08, attack: 0.9 });
    },
  };
}

function rift(): Sfx {
  let timer: ReturnType<typeof setInterval> | null = null;
  let level = 0;
  const hum = new Drone(55, 30, 'triangle', 0.06);
  return {
    hover: () => {
      crackle(14, 0.35, 0.12);
      hiss({ dur: 0.5, f0: 400, f1: 900, gain: 0.06, attack: 0.15 });
    },
    swallow: () => {
      hiss({ dur: 0.9, f0: 3000, f1: 300, q: 0.9, gain: 0.22, attack: 0.2 });
      crackle(18, 0.9, 0.1);
    },
    swallowed: () => {
      hiss({ dur: 0.45, f0: 700, f1: 90, gain: 0.4, type: 'lowpass', attack: 0.004 });
      tone({ f0: 70, f1: 38, dur: 0.4, gain: 0.35, attack: 0.003 });
      crackle(30, 0.4, 0.16);
    },
    emerge: () => {
      hiss({ dur: 0.35, f0: 250, f1: 2800, q: 0.8, gain: 0.3, attack: 0.25 });
      crackle(40, 0.7, 0.16, 0.28);
      tone({ f0: 60, f1: 120, dur: 0.32, gain: 0.25, attack: 0.25 });
      tone({ f0: 110, f1: 48, dur: 0.35, gain: 0.35, attack: 0.003, at: 0.32 });
    },
    land: () => crackle(4, 0.05, 0.08),
    chargeStart: () => {
      hum.start();
      timer = setInterval(() => crackle(Math.round(2 + level * 10), 0.12, 0.08 + level * 0.06), 120);
    },
    chargeLevel: (p) => {
      level = p;
      hum.set(p);
    },
    chargeStop: () => {
      hum.stop();
      if (timer) clearInterval(timer);
      timer = null;
    },
    ignite: () => {
      crackle(80, 1.2, 0.18);
      hiss({ dur: 1.2, f0: 200, f1: 1800, gain: 0.2, attack: 0.4 });
      tone({ f0: 55, f1: 82, dur: 1.4, gain: 0.25, attack: 0.4 });
    },
  };
}

function warp(): Sfx {
  const sq = (f0: number, f1: number | undefined, dur: number, at = 0, gain = 0.055) =>
    tone({ type: 'square', f0, f1, dur, gain, attack: 0.003, at, curve: 'lin' });
  let timer: ReturnType<typeof setInterval> | null = null;
  let level = 0;
  return {
    hover: () => sq(880, 1100, 0.06),
    swallow: () => {
      // boing onto the rim, then a gulp that slides down with the bulge
      sq(523, 784, 0.09, 0.0);
      sq(660, 990, 0.07, 0.34, 0.045);
      [620, 470, 350, 250].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f * 0.62, dur: 0.16, gain: 0.16, attack: 0.004, at: 0.62 + i * 0.22 }));
    },
    swallowed: () => {
      tone({ type: 'triangle', f0: 150, f1: 55, dur: 0.2, gain: 0.3, attack: 0.002 });
      hiss({ dur: 0.18, f0: 1800, f1: 400, gain: 0.08, type: 'bandpass', attack: 0.002 });
    },
    emerge: () => {
      // bubbling up the pipe…
      [180, 240, 320, 420].forEach((f, i) => tone({ type: 'triangle', f0: f, f1: f * 1.5, dur: 0.14, gain: 0.13, attack: 0.004, at: 0.1 + i * 0.19 }));
      // …pop, fanfare, ding
      sq(988, 1318, 0.05, 0.86, 0.06);
      [523.3, 659.3, 784, 1046.5].forEach((f, i) => sq(f, undefined, 0.07, 0.92 + i * 0.065));
      tone({ type: 'triangle', f0: 1568, dur: 0.5, gain: 0.12, attack: 0.002, at: 1.2 });
      tone({ type: 'triangle', f0: 2093, dur: 0.45, gain: 0.07, attack: 0.002, at: 1.27 });
    },
    land: () => sq(1046, undefined, 0.035, 0, 0.04),
    chargeStart: () => {
      let n = 0;
      timer = setInterval(() => sq(330 + level * 500 + (n++ % 2) * 40, undefined, 0.04, 0, 0.035), 140);
    },
    chargeLevel: (p) => (level = p),
    chargeStop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    ignite: () => [523.3, 659.3, 784, 1046.5, 1318.5, 1568].forEach((f, i) => sq(f, undefined, 0.09, i * 0.08, 0.05)),
  };
}

function toaster(): Sfx {
  const click = (at = 0, gain = 0.25) => hiss({ dur: 0.03, f0: 3200, q: 2, gain, attack: 0.001, at });
  const ding = (at = 0) => {
    for (const [f, g] of [[1975, 0.12], [2963, 0.06], [3951, 0.03]]) tone({ f0: f, dur: 1.6, gain: g, attack: 0.002, at });
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let level = 0;
  return {
    hover: () => click(0, 0.12),
    swallow: () => {
      hiss({ dur: 0.18, f0: 900, f1: 400, gain: 0.08, type: 'lowpass', attack: 0.01, at: 0.66 });
      // ka-chunk: the lever goes down
      click(0.96, 0.3);
      tone({ type: 'triangle', f0: 140, f1: 70, dur: 0.12, gain: 0.3, attack: 0.002, at: 0.98 });
      hiss({ dur: 0.9, f0: 300, gain: 0.04, type: 'lowpass', attack: 0.2, at: 1.0 });
    },
    swallowed: () => hiss({ dur: 0.35, f0: 1400, f1: 500, gain: 0.08, type: 'bandpass', attack: 0.02 }),
    emerge: () => {
      // spring, POP, ding
      click(0.24, 0.35);
      tone({ type: 'triangle', f0: 260, f1: 900, dur: 0.18, gain: 0.22, attack: 0.002, at: 0.25, curve: 'exp' });
      ding(0.3);
    },
    land: () => tone({ type: 'triangle', f0: 220, f1: 140, dur: 0.08, gain: 0.12 }),
    chargeStart: () => {
      let n = 0;
      timer = setInterval(() => {
        if (n++ % Math.max(1, Math.round(4 - level * 3)) === 0) click(0, 0.1);
      }, 70);
    },
    chargeLevel: (p) => (level = p),
    chargeStop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    ignite: () => {
      ding(0);
      ding(0.25);
    },
  };
}

function liquid(): Sfx {
  const bloop = (f: number, at = 0, gain = 0.18) => tone({ f0: f, f1: f * 0.55, dur: 0.12, gain, attack: 0.004, at });
  let timer: ReturnType<typeof setInterval> | null = null;
  let level = 0;
  return {
    hover: () => bloop(320, 0, 0.12),
    swallow: () => {
      // plunk on contact, then it glugs its way down
      tone({ f0: 980, f1: 210, dur: 0.16, gain: 0.25, attack: 0.002, at: 0.62 });
      hiss({ dur: 0.25, f0: 2400, f1: 600, gain: 0.08, type: 'bandpass', attack: 0.003, at: 0.62 });
      [260, 210, 170].forEach((f, i) => bloop(f, 0.85 + i * 0.16, 0.14));
    },
    swallowed: () => tone({ f0: 120, f1: 60, dur: 0.3, gain: 0.3, attack: 0.004 }),
    emerge: () => {
      [140, 180, 230, 300].forEach((f, i) => tone({ f0: f, f1: f * 1.6, dur: 0.1, gain: 0.14, attack: 0.004, at: 0.1 + i * 0.13 }));
      hiss({ dur: 0.5, f0: 300, f1: 2600, q: 1.2, gain: 0.12, attack: 0.25, at: 0.55 });
      for (const [f, d] of [[1318, 0], [1760, 0.05], [2637, 0.1]]) tone({ f0: f, dur: 1.3, gain: 0.04, attack: 0.01, at: 1.15 + d });
    },
    land: () => tone({ f0: 1500, f1: 900, dur: 0.06, gain: 0.06 }),
    chargeStart: () => {
      timer = setInterval(() => Math.random() < 0.3 + level * 0.5 && bloop(180 + Math.random() * 200, 0, 0.08), 160);
    },
    chargeLevel: (p) => (level = p),
    chargeStop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    ignite: () => [440, 554, 659, 880].forEach((f, i) => tone({ f0: f, dur: 1.5, gain: 0.06, attack: 0.3, at: i * 0.08 })),
  };
}

function monster(): Sfx {
  // a voice: buzzy source through two vowel-ish resonances
  const voice = (f0: number, f1: number, dur: number, at = 0, gain = 0.2, vowel: [number, number] = [700, 1200]) => {
    if (!enabled) return;
    const c = ac();
    const t = c.currentTime + at;
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const fq of vowel) {
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = fq;
      bp.Q.value = 6;
      osc.connect(bp).connect(g);
    }
    g.connect(out!);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    hover: () => voice(180, 230, 0.45, 0, 0.22, [750, 1150]),
    swallow: () => {
      voice(220, 160, 0.09, 1.14, 0.25, [600, 1000]);
      [0, 1, 2].forEach((i) => voice(150, 120, 0.1, 1.3 + i * 0.17, 0.22, [450, 900]));
    },
    swallowed: () => {
      tone({ f0: 320, f1: 110, dur: 0.16, gain: 0.3, attack: 0.003 });
      voice(85, 70, 0.4, 0.32, 0.3, [300, 700]);
    },
    emerge: () => {
      voice(140, 200, 0.35, 0.0, 0.15, [400, 800]);
      hiss({ dur: 0.12, f0: 2000, f1: 900, gain: 0.25, type: 'bandpass', attack: 0.002, at: 0.42 });
      voice(260, 420, 0.14, 0.42, 0.28, [800, 1400]);
      [880, 1320].forEach((f, i) => tone({ f0: f, f1: f * 1.2, dur: 0.1, gain: 0.08, attack: 0.003, at: 1.1 + i * 0.12 }));
    },
    land: () => tone({ f0: 900, f1: 1200, dur: 0.06, gain: 0.05 }),
    chargeStart: () => {
      timer = setInterval(() => Math.random() < 0.5 && voice(120, 100, 0.16, 0, 0.12, [450, 800]), 520);
    },
    chargeLevel: () => {},
    chargeStop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    ignite: () => [700, 900, 1200].forEach((f, i) => tone({ f0: f, f1: f * 1.3, dur: 0.12, gain: 0.08, attack: 0.003, at: i * 0.12 })),
  };
}

export function sfxFor(theme: ThemeId): Sfx {
  switch (theme) {
    case 'warp':
      return warp();
    case 'rift':
      return rift();
    case 'toaster':
      return toaster();
    case 'liquid':
      return liquid();
    case 'monster':
      return monster();
    default:
      return singularity();
  }
}
