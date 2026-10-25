// Two fake desktops, one portal on each, wired to each other. Drop real files
// from Finder onto the left portal and watch them come out on the right.
// Built for checking the animations and for screen-recording them.

import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/silkscreen/400.css';
import '../widget/widget.css';
import './stage.css';
import type { PortalItem, ThemeId } from '../../../shared/types';
import { mockBridge, SAMPLES } from '../lib/mock';
import { THEMES } from '../themes';
import { PortalWidget } from '../widget/portal';

const params = new URLSearchParams(location.search);
let theme = (params.get('theme') as ThemeId) ?? 'singularity';
const view = params.get('view') ?? 'duo';
const scale = Number(params.get('scale') ?? (view === 'grid' ? 1.15 : 1.35));

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

const app = document.createElement('main');
app.className = `stage-${view}`;
document.body.appendChild(app);

const bar = document.createElement('header');
bar.innerHTML = `
  <div class="brand">zack<span>.</span></div>
  <nav class="themes">${THEMES.map((t) => `<button data-theme="${t.id}">${t.name}</button>`).join('')}</nav>
  <div class="spacer"></div>
  <nav class="acts">
    <button data-act="photo">Foto schicken</button>
    <button data-act="text">Text schicken</button>
    <button data-act="file">PDF schicken</button>
    <button data-act="back">Zurück schicken</button>
  </nav>`;
app.appendChild(bar);

const floor = document.createElement('section');
floor.className = 'floor';
app.appendChild(floor);

type Mock = ReturnType<typeof mockBridge>;
const desks: { bridge: Mock; widget: PortalWidget }[] = [];

function desk(label: string, os: string, cls: string, bridge: Mock) {
  const el = document.createElement('div');
  el.className = `desk ${cls}`;
  el.innerHTML = `<div class="os"><b>${label}</b><span>${os}</span></div><div class="wrap" style="--s:${scale}"><div class="w"></div></div>`;
  floor.appendChild(el);
  const widget = new PortalWidget(el.querySelector('.w') as HTMLElement, bridge, { pixelScale: scale, keys: false });
  void widget.start();
  desks.push({ bridge, widget });
}

const relay = (to: () => Mock) => (item: PortalItem) => {
  // the other side starts charging once the upload is underway
  setTimeout(() => to().demo.incoming(0, item.kind === 'text' || item.kind === 'link' ? 0 : 1800, { ...item, dir: 'in' }), 250);
};

if (view === 'solo') {
  const b = mockBridge({ theme });
  desk('', '', `solo ${params.get('bg') ?? 'mac'}`, b);
} else if (view === 'grid') {
  for (const t of THEMES) {
    const b = mockBridge({ theme: t.id });
    desk(t.name, t.tagline[navigator.language.startsWith('de') ? 'de' : 'en'], 'grid', b);
  }
} else {
  let left!: Mock;
  let right!: Mock;
  left = mockBridge({ self: { name: 'MacBook Pro', platform: 'mac' }, peer: { name: 'Gaming PC', platform: 'win' }, theme, onSend: relay(() => right) });
  right = mockBridge({ self: { name: 'Gaming PC', platform: 'win' }, peer: { name: 'MacBook Pro', platform: 'mac' }, theme, onSend: relay(() => left) });
  desk('MacBook Pro', 'macOS', 'mac', left);
  desk('Gaming PC', 'Windows 11', 'win', right);
}

function setTheme(id: ThemeId) {
  theme = id;
  bar.querySelectorAll<HTMLButtonElement>('.themes button').forEach((b) => b.classList.toggle('on', b.dataset.theme === id));
  if (view !== 'grid') desks.forEach((d) => d.bridge.demo.theme(id));
  history.replaceState(null, '', `?${new URLSearchParams({ ...Object.fromEntries(params), theme: id })}`);
}
setTheme(theme);

bar.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b) return;
  if (b.dataset.theme) return setTheme(b.dataset.theme as ThemeId);
  const [a, z] = desks;
  const from = b.dataset.act === 'back' ? z : a;
  if (b.dataset.act === 'photo' || b.dataset.act === 'back') sendSample(from, 0);
  if (b.dataset.act === 'text') sendSample(from, 1);
  if (b.dataset.act === 'file') sendSample(from, 2);
});

/** fakes a drop in the middle of the left portal */
function sendSample(d: { bridge: Mock }, index: number) {
  const s = SAMPLES[index];
  const thumb = s.kind === 'image' ? d.bridge.demo.photo(index + 4) : undefined;
  const root = (desks.find((x) => x.bridge === d.bridge) ?? desks[0]).widget as unknown as { root: HTMLElement };
  const target = root.root;
  const dt = new DataTransfer();
  if (s.kind === 'text') dt.setData('text/plain', s.text!);
  else {
    const bytes = thumb ? Uint8Array.from(atob(thumb.split(',')[1]), (c) => c.charCodeAt(0)) : new Uint8Array(s.size % 4000);
    dt.items.add(new File([bytes], s.kind === 'image' ? 'IMG_4182.jpg' : s.name, { type: s.kind === 'image' ? 'image/jpeg' : 'application/pdf' }));
  }
  const r = target.getBoundingClientRect();
  const x = r.left + r.width * (0.18 + Math.random() * 0.1);
  const y = r.top + r.height * 0.12;
  for (const type of ['dragenter', 'dragover']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, clientX: x, clientY: y, bubbles: true }));
  setTimeout(() => target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true })), 450);
}

(window as unknown as { stage: unknown }).stage = { desks, sendSample, setTheme };
