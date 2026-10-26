// A pretend main process, so the renderer runs in a plain browser: for the
// stage page, for design work, and for screen-recording the animations.

import type { Bridge, Device, PortalEvent, PortalItem, PortalState, Settings } from '../../../shared/types';

type Listener = (e: PortalEvent) => void;

export function photo(seed: number) {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 220;
  const g = c.getContext('2d')!;
  const hue = [18, 30, 195, 8, 160][seed % 5];
  const sky = g.createLinearGradient(0, 0, 0, 220);
  sky.addColorStop(0, `hsl(${hue + 190},45%,28%)`);
  sky.addColorStop(0.55, `hsl(${hue + 20},85%,62%)`);
  sky.addColorStop(1, `hsl(${hue + 35},90%,72%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, 320, 220);
  g.fillStyle = `hsl(${hue + 40},95%,82%)`;
  g.beginPath();
  g.arc(210, 128, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = `hsl(${hue + 230},35%,16%)`;
  g.beginPath();
  g.moveTo(0, 220);
  for (let x = 0; x <= 320; x += 20) g.lineTo(x, 150 + Math.sin(x * 0.03 + seed) * 18 + Math.sin(x * 0.11) * 6);
  g.lineTo(320, 220);
  g.fill();
  return c.toDataURL('image/jpeg', 0.85);
}

export const SAMPLES: Omit<PortalItem, 'id' | 'at' | 'status' | 'dir'>[] = [
  { kind: 'image', name: 'IMG_4182.HEIC', size: 2_841_000, peer: 'Gaming PC', peerPlatform: 'win' },
  { kind: 'text', name: 'Die Präsi ist im Ordner Q4, Folie 12 hat die neuen Zahlen. Bitte bis Freitag drüberschauen!', size: 92, peer: 'Gaming PC', text: 'Die Präsi ist im Ordner Q4, Folie 12 hat die neuen Zahlen. Bitte bis Freitag drüberschauen!' },
  { kind: 'file', name: 'Rechnung-2026-10.pdf', size: 412_000, peer: 'Gaming PC' },
  { kind: 'link', name: 'https://lenny.services', size: 22, peer: 'Gaming PC', text: 'https://lenny.services' },
  { kind: 'folder', name: 'Projekt Assets', size: 48_200_000, peer: 'Gaming PC' },
  { kind: 'file', name: 'final_cut_v3.mp4', size: 184_000_000, peer: 'Gaming PC' },
];

export interface MockOptions {
  self?: { name: string; platform: 'mac' | 'win' | 'linux' };
  peer?: { name: string; platform: 'mac' | 'win' | 'linux' };
  theme?: Settings['theme'];
  /** wire two mocks together: whatever this one sends, the other receives */
  onSend?: (item: PortalItem) => void;
}

export function mockBridge(opts: MockOptions = {}): Bridge & { demo: Demo } {
  const listeners = new Set<Listener>();
  const self = { id: 'self', name: opts.self?.name ?? 'MacBook Pro', platform: opts.self?.platform ?? ('mac' as const) };
  const pc: Device = { id: 'peer', name: opts.peer?.name ?? 'Gaming PC', platform: opts.peer?.platform ?? 'win', online: true, lastSeen: Date.now() };
  const settings: Settings = {
    theme: opts.theme ?? (new URLSearchParams(location.search).get('theme') as Settings['theme']) ?? 'singularity',
    sound: true,
    autoCopyText: true,
    autoCopyImages: true,
    autoOpenLinks: false,
    summonOnReceive: true,
    alwaysOnTop: true,
    launchAtLogin: false,
    saveDir: '~/Downloads/Zack',
    target: '*',
    hotkey: 'CommandOrControl+Alt+Z',
    scale: 1,
    language: 'auto',
  };
  const state: PortalState = {
    lang: (new URLSearchParams(location.search).get('lang') as 'de' | 'en') ?? (navigator.language.startsWith('de') ? 'de' : 'en'),
    platform: 'mac',
    paired: true,
    connected: true,
    self,
    devices: [{ ...self, online: true, lastSeen: Date.now() }, pc],
    settings,
    history: [],
    server: 'https://zack-portal.example.workers.dev',
    version: '0.2.1',
    update: { phase: 'idle' },
  };
  const emit = (e: PortalEvent) => listeners.forEach((l) => l(e));
  const update = (u: PortalState['update']) => {
    state.update = u;
    emit({ type: 'update', update: u });
  };
  const push = () => emit({ type: 'state', state: structuredClone(state) });
  let n = 0;

  const send = (partial: Omit<PortalItem, 'id' | 'at' | 'status' | 'dir' | 'peer'>, origin: 'drop' | 'clipboard') => {
    const item: PortalItem = { ...partial, id: `out${n++}`, dir: 'out', peer: pc.name, at: Date.now(), status: 'sending', progress: 0 };
    state.history.unshift(item);
    emit({ type: 'outgoing', item, origin });
    opts.onSend?.(item);
    let p = 0;
    const t = setInterval(() => {
      p = Math.min(1, p + 0.08 + Math.random() * 0.1);
      item.progress = p;
      emit({ type: 'progress', id: item.id, progress: p, dir: 'out' });
      if (p >= 1) {
        clearInterval(t);
        setTimeout(() => {
          item.status = 'delivered';
          emit({ type: 'delivered', id: item.id, by: pc.name });
          push();
        }, 500);
      }
    }, 140);
  };

  const demo = {
    incoming(index = Math.floor(Math.random() * SAMPLES.length), duration = 2200, from?: Partial<PortalItem>) {
      const s = from ? { ...SAMPLES[0], ...from } : SAMPLES[index % SAMPLES.length];
      const item: PortalItem = { ...s, id: `in${n++}`, dir: 'in', peer: pc.name, at: Date.now(), status: 'incoming', progress: 0, thumb: from ? from.thumb : s.kind === 'image' ? photo(index + 3) : undefined };
      if (s.kind === 'text' || s.kind === 'link') {
        item.status = 'received';
        item.copied = true;
        state.history.unshift(item);
        emit({ type: 'arrived', item });
        push();
        return;
      }
      emit({ type: 'incoming', item });
      const start = performance.now();
      const t = setInterval(() => {
        const p = Math.min(1, (performance.now() - start) / duration);
        emit({ type: 'progress', id: item.id, progress: p, dir: 'in' });
        if (p >= 1) {
          clearInterval(t);
          item.status = 'received';
          item.progress = 1;
          item.copied = s.kind === 'image';
          state.history.unshift(item);
          emit({ type: 'arrived', item });
          push();
        }
      }, 60);
    },
    offline(v: boolean) {
      state.connected = !v;
      push();
    },
    unpaired(v: boolean) {
      state.paired = !v;
      push();
    },
    linked() {
      emit({ type: 'linked', device: pc });
    },
    theme(id: Settings['theme']) {
      settings.theme = id;
      emit({ type: 'theme', theme: id });
      push();
    },
    photo,
  };

  const bridge: Bridge & { demo: typeof demo } = {
    demo,
    getState: async () => structuredClone(state),
    on(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    // no paths in a browser, so drops arrive as buffers and keep their pixels
    pathForFile: () => '',
    dropPaths: async (paths) => {
      for (const p of paths) {
        const name = p.split('/').pop() ?? p;
        send({ kind: /\.(png|jpe?g|gif|webp|heic)$/i.test(name) ? 'image' : 'file', name, size: 1_200_000 }, 'drop');
      }
    },
    dropText: async (text) => send({ kind: /^https?:\/\//.test(text.trim()) ? 'link' : 'text', name: text.trim().split('\n')[0].slice(0, 80), size: text.length, text }, 'drop'),
    dropBuffers: async (bufs) =>
      bufs.forEach((b) => {
        const image = b.mime.startsWith('image/');
        send({ kind: image ? 'image' : 'file', name: b.name, size: b.data.byteLength, thumb: image ? URL.createObjectURL(new Blob([b.data], { type: b.mime })) : undefined }, 'drop');
      }),
    sendClipboard: async () => send({ kind: 'text', name: 'Clipboard text', size: 14, text: 'Clipboard text' }, 'clipboard'),
    fileIcon: async () => null,
    setSettings: async (patch) => {
      Object.assign(settings, patch);
      if (patch.language) state.lang = patch.language === 'auto' ? (navigator.language.startsWith('de') ? 'de' : 'en') : patch.language;
      if (patch.theme) emit({ type: 'theme', theme: patch.theme });
      push();
    },
    createCode: async () => {
      const code = { code: 'K7QM-2XRA-9PDF', expires: Date.now() + 600_000 };
      emit({ type: 'pair-code', code });
      setTimeout(() => demo.linked(), 6000);
      return code;
    },
    cancelCode: async () => emit({ type: 'pair-code', code: null }),
    join: async (code) => (code.replace(/\W/g, '').length === 12 ? { ok: true as const } : { ok: false as const, error: 'unknown_code' }),
    unpair: async () => demo.unpaired(true),
    forget: async () => {},
    rename: async (name) => {
      self.name = name;
      push();
    },
    chooseSaveDir: async () => null,
    openItem: async () => {},
    revealItem: async () => {},
    copyItem: async () => {},
    removeItem: async (id) => {
      state.history = state.history.filter((h) => h.id !== id);
      push();
    },
    startDrag: () => {},
    openSettings: () => {},
    contextMenu: () => {},
    itemMenu: () => {},
    hideWidget: () => {},
    openSaveDir: () => {},
    moveStart: () => {},
    moveEnd: () => {},
    checkUpdate: async () => {
      update({ phase: 'checking' });
      setTimeout(() => update({ phase: 'available', version: '0.3.0', auto: true }), 900);
    },
    installUpdate: async () => {
      let progress = 0;
      const tick = setInterval(() => {
        progress = Math.min(100, progress + 7);
        update({ phase: 'downloading', version: '0.3.0', progress });
        if (progress < 100) return;
        clearInterval(tick);
        update({ phase: 'installing', version: '0.3.0' });
      }, 120);
    },
  };
  return bridge;
}

export type Demo = {
  incoming(index?: number, duration?: number, from?: Partial<PortalItem>): void;
  offline(v: boolean): void;
  unpaired(v: boolean): void;
  linked(): void;
  theme(id: Settings['theme']): void;
  photo(seed: number): string;
};
