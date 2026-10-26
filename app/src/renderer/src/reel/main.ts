// Scripted demos of the real widgets for the README and social clips. A drawn
// cursor drags a file and fires real drag-and-drop events, so the widgets do
// exactly what they do in the app. Runs in a browser on real time, or inside
// Cuttle on the video's clock (window.cuttle), frame-exact.
//
//   reel.html?mode=hero                 two desktops, Mac → Windows
//   reel.html?mode=solo&theme=warp      one look: swallow, then receive

import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/silkscreen/400.css';
import '../widget/widget.css';
import './reel.css';
import type { PortalItem, ThemeId } from '../../../shared/types';
import { setSound } from '../fx/audio';
import { ease } from '../fx/motion';
import { mockBridge, photo } from '../lib/mock';
import { THEMES } from '../themes';
import { PortalWidget, W, H } from '../widget/portal';

interface CuttleApi {
  params?: Record<string, unknown>;
  onFrame(cb: (t: number) => void): void;
  ready(p: Promise<unknown>): void;
}

const cut = (window as unknown as { cuttle?: CuttleApi }).cuttle;
const query = new URLSearchParams(location.search);
const param = (name: string, fallback: string) => String(cut?.params?.[name] ?? query.get(name) ?? fallback);
const mode = param('mode', 'hero');
const theme = param('theme', 'singularity') as ThemeId;
setSound(false);

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

type Mock = ReturnType<typeof mockBridge>;
const starting: Promise<void>[] = [];
interface Placed {
  bridge: Mock;
  root: HTMLElement;
  scale: number;
}

// where each look's object sits inside the 260×330 widget
const TARGET: Record<ThemeId, [number, number]> = {
  singularity: [130, 126],
  rift: [130, 126],
  warp: [130, 138],
  toaster: [130, 132],
  liquid: [130, 160],
  monster: [130, 150],
};

function el(tag: string, cls: string, parent: HTMLElement, html = '') {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

function place(parent: HTMLElement, bridge: Mock, scale: number, pos: Partial<Record<'left' | 'right' | 'top' | 'bottom', string>>): Placed {
  const wrap = el('div', 'wrap', parent);
  Object.assign(wrap.style, { width: `${W * scale}px`, height: `${H * scale}px`, ...pos });
  const inner = el('div', 'w', wrap);
  inner.style.transform = `scale(${scale})`;
  starting.push(new PortalWidget(inner, bridge, { pixelScale: scale, keys: false }).start());
  return { bridge, root: inner, scale };
}

/** A file lying on the desktop: the thing the cursor picks up. */
function icon(parent: HTMLElement, x: number, y: number, img: string, name: string) {
  const e = el('div', 'icon', parent, `<img src="${img}" alt=""><span>${name}</span>`);
  Object.assign(e.style, { left: `${x}px`, top: `${y}px` });
  return e;
}

const bytes = (dataUrl: string) => Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));

type Payload = { file: File; preview: string; label: string } | { text: string; preview: string; label: string };

function photoPayload(seed: number, name: string): Payload {
  const url = photo(seed);
  return { file: new File([bytes(url)], name, { type: 'image/jpeg' }), preview: url, label: name };
}

function pdfPayload(name: string): Payload {
  // a little page with a red band, drawn the way the app draws documents
  const c = document.createElement('canvas');
  c.width = 120;
  c.height = 150;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f1ea';
  g.beginPath();
  g.roundRect(14, 6, 92, 138, 6);
  g.fill();
  g.fillStyle = '#c9c3b6';
  for (let i = 0; i < 5; i++) g.fillRect(26, 26 + i * 12, i === 4 ? 40 : 66, 4);
  g.fillStyle = '#e5484d';
  g.beginPath();
  g.roundRect(24, 100, 72, 30, 6);
  g.fill();
  g.fillStyle = '#fff';
  g.font = '700 16px "JetBrains Mono", monospace';
  g.textAlign = 'center';
  g.fillText('PDF', 60, 121);
  return { file: new File([new Uint8Array(42_000)], name, { type: 'application/pdf' }), preview: c.toDataURL(), label: name };
}

function textPayload(text: string, label: string): Payload {
  const c = document.createElement('canvas');
  c.width = 120;
  c.height = 120;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fbf8f1';
  g.beginPath();
  g.roundRect(10, 10, 100, 100, 6);
  g.fill();
  g.fillStyle = '#2a2722';
  g.font = '500 12px -apple-system, system-ui, sans-serif';
  text.split(' ').reduce<string[]>((lines, w) => {
    const last = lines[lines.length - 1];
    if (last && (last + ' ' + w).length < 14) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
    return lines;
  }, []).slice(0, 6).forEach((l, i) => g.fillText(l, 20, 32 + i * 15));
  return { text, preview: c.toDataURL(), label };
}

/**
 * A cursor that walks to a file, picks it up and drags it into a portal,
 * firing dragenter/dragover/drop on the widget like the OS would.
 */
function drag(stage: HTMLElement, opts: { start: [number, number]; from: [number, number]; target: Placed; aim: [number, number]; payload: Payload; t0: number; tPick: number; tDrop: number }) {
  const cursor = el('div', 'cursor', stage, '<svg viewBox="0 0 24 24"><path d="M4 2l15 11.5-6.6.9 3.8 7.3-2.8 1.3-3.7-7.4L4 20z"/></svg>');
  const ghost = el('div', 'ghost', stage, `<img src="${opts.payload.preview}" alt="">`);
  const dt = new DataTransfer();
  if ('file' in opts.payload) dt.items.add(opts.payload.file);
  else dt.setData('text/plain', opts.payload.text);
  let entered = false;
  let dropped = false;

  const portal = () => {
    const r = opts.target.root.getBoundingClientRect();
    const k = r.width / W;
    return { x: r.left + opts.aim[0] * k, y: r.top + opts.aim[1] * k, rect: r };
  };

  return (t: number) => {
    const p = portal();
    let x: number;
    let y: number;
    if (t < opts.tPick) {
      const e = ease.inOutCubic(Math.min(1, Math.max(0, (t - opts.t0) / (opts.tPick - opts.t0 - 0.05))));
      x = opts.start[0] + (opts.from[0] - opts.start[0]) * e;
      y = opts.start[1] + (opts.from[1] - opts.start[1]) * e;
    } else if (t < opts.tDrop) {
      const e = ease.inOutCubic((t - opts.tPick) / (opts.tDrop - opts.tPick));
      // a gentle arc, the way a hand moves
      x = opts.from[0] + (p.x - opts.from[0]) * e;
      y = opts.from[1] + (p.y - opts.from[1]) * e - Math.sin(e * Math.PI) * 60;
    } else {
      const e = ease.outCubic(Math.min(1, (t - opts.tDrop) / 0.8));
      x = p.x + 46 * e;
      y = p.y + 70 * e;
    }
    const visible = t >= opts.t0 && t < opts.tDrop + 1.1;
    cursor.style.opacity = String(visible ? Math.min(1, (t - opts.t0) / 0.2) * (t > opts.tDrop + 0.7 ? Math.max(0, 1 - (t - opts.tDrop - 0.7) / 0.4) : 1) : 0);
    cursor.style.transform = `translate(${x}px, ${y}px) scale(${t > opts.tPick - 0.06 && t < opts.tPick + 0.06 ? 0.88 : 1})`;
    const carrying = t >= opts.tPick && t < opts.tDrop;
    ghost.style.opacity = carrying ? '0.88' : '0';
    ghost.style.transform = `translate(${x - 52}px, ${y - 40}px) rotate(-4deg)`;

    if (carrying) {
      const r = p.rect;
      const inside = x > r.left && x < r.right && y > r.top && y < r.bottom;
      const ev = (type: string) => opts.target.root.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true }));
      if (inside && !entered) {
        entered = true;
        ev('dragenter');
      }
      if (entered) ev('dragover');
    }
    if (t >= opts.tDrop && !dropped) {
      dropped = true;
      opts.target.root.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: p.x, clientY: p.y, bubbles: true }));
    }
  };
}

function clock(tick: (t: number) => void) {
  // the first frame waits until every widget has its theme up
  cut?.ready(Promise.all(starting));
  if (cut) return cut.onFrame(tick);
  const start = performance.now();
  const loop = () => {
    tick((performance.now() - start) / 1000);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

const stage = el('main', `reel reel-${mode}`, document.body);
const once = new Set<string>();
const at = (t: number, when: number, key: string, fn: () => void) => {
  if (t >= when && !once.has(key)) {
    once.add(key);
    fn();
  }
};

if (mode === 'hero') {
  // Mac on the left, Windows on the right; a photo crosses over
  const left = el('section', 'desk mac', stage, '<div class="os"><b>MacBook Pro</b><span>macOS</span></div>');
  const right = el('section', 'desk win', stage, '<div class="os"><b>Gaming PC</b><span>Windows 11</span></div>');
  el('div', 'divider', stage);
  let b!: Mock;
  const relay = (to: () => Mock) => (item: PortalItem) => setTimeout(() => to().demo.incoming(0, 1800, { ...item, dir: 'in' }), 250);
  const a = mockBridge({ self: { name: 'MacBook Pro', platform: 'mac' }, peer: { name: 'Gaming PC', platform: 'win' }, theme, onSend: relay(() => b) });
  b = mockBridge({ self: { name: 'Gaming PC', platform: 'win' }, peer: { name: 'MacBook Pro', platform: 'mac' }, theme });
  const scale = 1.75;
  const pa = place(left, a, scale, { right: '70px', bottom: '40px' });
  place(right, b, scale, { right: '70px', bottom: '40px' });
  const payload = photoPayload(4, 'Sonnenuntergang.jpg');
  icon(left, 150, 330, payload.preview, payload.label);
  const run = drag(stage, { start: [520, 760], from: [205, 380], target: pa, aim: TARGET[theme], payload, t0: 0.35, tPick: 1.1, tDrop: 2.4 });
  clock((t) => run(t));
} else {
  // one look on its own: something goes in, something else comes out
  const desk = el('section', 'desk solo', stage);
  const info = THEMES.find((x) => x.id === theme)!;
  el('div', 'tag', desk, `<b>${info.name}</b>`);
  const a = mockBridge({ self: { name: 'MacBook Pro', platform: 'mac' }, peer: { name: 'Gaming PC', platform: 'win' }, theme });
  const scale = 2.1;
  const pa = place(desk, a, scale, { left: `${960 - (W * scale) / 2}px`, top: `${540 - (H * scale) / 2 + 10}px` });
  const plan: Record<ThemeId, { send: Payload; receive: number }> = {
    singularity: { send: photoPayload(4, 'Sonnenuntergang.jpg'), receive: 2 },
    warp: { send: pdfPayload('Rechnung.pdf'), receive: 0 },
    rift: { send: photoPayload(7, 'Berge.jpg'), receive: 2 },
    toaster: { send: photoPayload(5, 'Brunch.jpg'), receive: 0 },
    liquid: { send: pdfPayload('Vertrag.pdf'), receive: 0 },
    monster: { send: textPayload('Futter für das Monster', 'Notiz'), receive: 1 },
  };
  const p = plan[theme];
  icon(desk, 470, 250, p.send.preview, p.send.label);
  const tDrop = 1.5;
  const run = drag(stage, { start: [700, 640], from: [525, 300], target: pa, aim: TARGET[theme], payload: p.send, t0: 0.15, tPick: 0.75, tDrop });
  // the reply comes in once the swallow has played out
  const swallow = { singularity: 1.05, rift: 1.05, warp: 1.75, toaster: 1.6, liquid: 1.5, monster: 1.9 }[theme];
  clock((t) => {
    run(t);
    at(t, tDrop + swallow + 0.35, 'reply', () => a.demo.incoming(p.receive, 1000));
  });
}
