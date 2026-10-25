// The widget: one portal, a status line, a shelf of recent things.
// Mountable anywhere, so the stage page can run three of them side by side.

import { formatBytes, strings } from '../../../shared/i18n';
import type { Bridge, DroppedBuffer, HitShape, PortalEvent, PortalItem, PortalState, ThemeId } from '../../../shared/types';
import { setSound, sfxFor } from '../fx/audio';
import { wait } from '../fx/motion';
import { makeSprite, spriteThumb, type Sprite } from '../fx/sprite';
import { createTheme, Loop, type Layout, type Mood, type Theme } from '../themes';

export const W = 260;
export const H = 330;
const SHELF = 5;
const CHIP = 34;
const GAP = 8;

const ICONS = {
  clip: '<svg viewBox="0 0 20 20"><rect x="5" y="4" width="10" height="13" rx="2"/><path d="M8 4V3h4v1"/><path d="M8 9h4M8 12h3"/></svg>',
  folder: '<svg viewBox="0 0 20 20"><path d="M3 6.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15V8a1.5 1.5 0 0 0-1.5-1.5H10L8.5 4.5h-4A1.5 1.5 0 0 0 3 6z"/></svg>',
  settings: '<svg viewBox="0 0 20 20"><path d="M4 6h7M15 6h1M4 14h1M9 14h7"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/></svg>',
};

interface ZackHost {
  keep(): void;
  hitShapes?(shapes: HitShape[]): void;
  onHover?(fn: (over: boolean) => void): void;
}

export interface PortalOptions {
  /** the stage page renders widgets scaled up; canvases follow so they stay crisp */
  pixelScale?: number;
  /** global shortcuts (paste, settings); off when several widgets share a page */
  keys?: boolean;
}

export class PortalWidget {
  private root: HTMLElement;
  private bridge: Bridge;
  private state!: PortalState;
  private theme: Theme | null = null;
  private loop = new Loop();
  private L: Layout;
  private opts: PortalOptions;
  private el!: Record<'stage' | 'status' | 'statusText' | 'caption' | 'capTitle' | 'capSub' | 'shelf' | 'actions' | 'dot', HTMLElement>;
  private dragDepth = 0;
  private dragging = false;
  private ownDrag = false;
  private incoming = new Map<string, number>();
  /** ids whose arrival is being played out right now */
  private charging = new Set<string>();
  private outgoing = new Map<string, { peer: string; p: number }>();
  private emitQueue: Promise<void> = Promise.resolve();
  private docking = new Set<string>();
  private sprites = new Map<string, Promise<Sprite>>();
  private flash: { text: string; until: number; kind?: string } | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private peekTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private host = (window as unknown as { zackHost?: ZackHost }).zackHost;

  constructor(root: HTMLElement, bridge: Bridge, opts: PortalOptions = {}) {
    this.root = root;
    this.bridge = bridge;
    this.opts = opts;
    this.L = { w: W, h: H, cx: W / 2, cy: 126, R: 82, dpr: this.dpr() };
  }

  private dpr() {
    return Math.min(3, (window.devicePixelRatio || 1) * (this.opts.pixelScale ?? 1));
  }

  /** client coordinates → widget css px, whatever transform the page applies */
  private local(e: { clientX: number; clientY: number }) {
    const r = this.root.getBoundingClientRect();
    const k = r.width / W || 1;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  }

  get t() {
    return strings(this.state?.lang ?? 'en');
  }

  async start() {
    this.build();
    this.state = await this.bridge.getState();
    this.bridge.on((e) => this.onEvent(e));
    this.useTheme(this.state.settings.theme);
    this.render();
    this.bindDrop();
    window.addEventListener('resize', () => this.relayout());
  }

  // ── dom ─────────────────────────────────────────────────────────────────

  private build() {
    this.root.classList.add('zw');
    this.root.innerHTML = `
      <div class="stage"></div>
      <div class="actions">
        <button data-act="clip">${ICONS.clip}</button>
        <button data-act="folder">${ICONS.folder}</button>
        <button data-act="settings">${ICONS.settings}</button>
      </div>
      <div class="info">
        <div class="pill status"><i class="dot"></i><span class="txt"></span></div>
        <div class="pill caption"><b></b><small></small></div>
      </div>
      <div class="shelf"></div>`;
    const $ = (s: string) => this.root.querySelector(s) as HTMLElement;
    this.el = {
      stage: $('.stage'),
      status: $('.status'),
      statusText: $('.status .txt'),
      dot: $('.status .dot'),
      caption: $('.caption'),
      capTitle: $('.caption b'),
      capSub: $('.caption small'),
      shelf: $('.shelf'),
      actions: $('.actions'),
    };

    // press and drag anywhere on the portal to move the widget; a plain click opens the actions
    let press: { x: number; y: number } | null = null;
    let moving = false;
    const grab = (e: MouseEvent) => {
      if (e.button !== 0) return;
      press = { x: e.screenX, y: e.screenY };
      moving = false;
    };
    this.el.stage.addEventListener('mousedown', grab);
    this.el.status.addEventListener('mousedown', grab);
    window.addEventListener('mousemove', (e) => {
      if (!press || moving || !(e.buttons & 1)) return;
      if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < 4) return;
      moving = true;
      this.root.classList.add('moving');
      this.root.classList.remove('show-actions');
      this.bridge.moveStart();
    });
    const release = () => {
      if (moving) this.bridge.moveEnd();
      this.root.classList.remove('moving');
      press = null;
      // let the click that follows this mouseup see that it was a drag
      setTimeout(() => (moving = false));
    };
    window.addEventListener('mouseup', release);
    window.addEventListener('blur', () => moving && release());
    this.el.stage.addEventListener('click', () => {
      if (moving) return;
      if (!this.state.paired) return this.bridge.openSettings('pair');
      this.root.classList.toggle('show-actions');
    });
    // In the app the main process tells us when the cursor is over the object
    // (the window clicks through everywhere else); in a browser, plain DOM hover.
    if (this.host?.onHover) this.host.onHover((over) => this.setHovered(over));
    else {
      this.root.addEventListener('mouseenter', () => this.setHovered(true));
      this.root.addEventListener('mouseleave', () => this.setHovered(false));
    }
    new MutationObserver(() => this.syncHit()).observe(this.root, { attributes: true, attributeFilter: ['class'] });
    this.root.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.chip')) return;
      e.preventDefault();
      this.bridge.contextMenu();
    });
    this.el.actions.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.dataset.act;
      this.root.classList.remove('show-actions');
      if (act === 'clip') void this.bridge.sendClipboard();
      if (act === 'folder') this.bridge.openSaveDir();
      if (act === 'settings') this.bridge.openSettings();
    });
    this.el.actions.querySelectorAll('button').forEach((b) => {
      const label = () => ({ clip: this.t.sendClipboard, folder: this.t.openReceived, settings: this.t.settings })[b.dataset.act as 'clip'];
      b.addEventListener('mouseenter', () => this.setHint(label()));
      b.addEventListener('mouseleave', () => this.setHint(null));
    });
    if (this.opts.keys !== false) window.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        void this.bridge.sendClipboard();
      }
      if (mod && e.key === ',') this.bridge.openSettings();
      if (e.key === 'Escape') this.root.classList.remove('show-actions');
    });
  }

  private setHovered(over: boolean) {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (over) {
      this.host?.keep();
      this.root.classList.add('hovered');
      return;
    }
    // a little grace, so moving from the portal down to the shelf doesn't blink
    this.hoverTimer = setTimeout(() => {
      this.root.classList.remove('hovered', 'show-actions');
    }, 380);
  }

  private lastHit = '';
  /** Tells the main process which pixels are "solid" right now. */
  private syncHit() {
    if (!this.theme || !this.host?.hitShapes) return;
    const shapes: HitShape[] = [this.theme.hitShape()];
    const c = this.root.classList;
    if (c.contains('hovered') || c.contains('status-on') || c.contains('captioned') || c.contains('peek') || c.contains('show-actions')) {
      // the column under the portal, where the status, actions and shelf live
      shapes.push({ type: 'rect', x: 22, y: this.L.cy + 40, w: W - 44, h: H - this.L.cy - 44 });
    }
    const key = JSON.stringify(shapes);
    if (key === this.lastHit) return;
    this.lastHit = key;
    this.host.hitShapes(shapes);
  }

  private hint: string | null = null;
  private setHint(h: string | null) {
    this.hint = h;
    this.renderStatus();
  }

  private relayout() {
    this.L = { ...this.L, dpr: this.dpr() };
    this.theme?.resize(this.L);
  }

  // ── theme ───────────────────────────────────────────────────────────────

  private useTheme(id: ThemeId) {
    if (this.theme?.id === id) return;
    const old = this.theme;
    const next = createTheme(id);
    next.sfx = sfxFor(next.id);
    this.root.dataset.theme = next.id;
    const swap = () => {
      old?.detach();
      next.attach(this.el.stage, this.L);
      next.setMood(this.mood());
      this.theme = next;
      this.loop.set(next);
      this.el.stage.classList.remove('fading');
      this.syncHit();
    };
    if (old) {
      this.el.stage.classList.add('fading');
      setTimeout(swap, 180);
    } else swap();
  }

  private mood(): Mood {
    if (this.dragging) return 'hover';
    if (!this.state.paired || !this.state.connected) return 'dormant';
    if (this.incoming.size || this.charging.size) return 'charging';
    return 'idle';
  }

  private updateMood() {
    this.theme?.setMood(this.mood());
    this.loop.kick();
  }

  // ── drag & drop ─────────────────────────────────────────────────────────

  private bindDrop() {
    const over = (e: DragEvent) => {
      e.preventDefault();
      if (this.ownDrag) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
        return;
      }
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      this.theme?.setPointer(this.local(e));
      if (!this.dragging) {
        this.dragging = true;
        this.updateMood();
      }
    };
    const root = this.root;
    root.addEventListener('dragenter', (e) => {
      this.dragDepth++;
      over(e);
    });
    root.addEventListener('dragover', over);
    root.addEventListener('dragleave', () => {
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) this.endDrag();
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      const at = this.local(e);
      this.dragDepth = 0;
      if (this.ownDrag) return this.endDrag();
      void this.handleDrop(e.dataTransfer, at);
    });
  }

  private endDrag() {
    this.dragging = false;
    this.theme?.setPointer(null);
    this.updateMood();
  }

  private async handleDrop(dt: DataTransfer | null, at: { x: number; y: number }) {
    if (!dt) return this.endDrag();
    const files = [...dt.files];
    const paths: string[] = [];
    const buffers: DroppedBuffer[] = [];
    const sprites: Promise<Sprite>[] = [];

    for (const f of files) {
      const path = this.bridge.pathForFile(f);
      const image = f.type.startsWith('image/');
      const folder = !f.type && f.size % 4096 === 0 && !/\.[a-z0-9]{1,6}$/i.test(f.name);
      sprites.push(
        (async () => {
          let thumb: ImageBitmap | null = null;
          if (image) thumb = await Promise.race([createImageBitmap(f).catch(() => null), wait(180).then(() => null)]);
          return makeSprite({ kind: image ? 'image' : folder ? 'folder' : 'file', name: f.name, thumb });
        })(),
      );
      if (path) paths.push(path);
      else if (f.size < 512 * 1024 * 1024) buffers.push({ name: f.name || 'Dropped', mime: f.type || 'application/octet-stream', data: await f.arrayBuffer() });
    }

    let text = '';
    if (!files.length) {
      const uri = dt.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#'));
      text = dt.getData('text/plain') || uri || '';
      if (text.trim()) {
        const link = /^https?:\/\/\S+$/i.test(text.trim());
        sprites.push(makeSprite({ kind: link ? 'link' : 'text', name: text.trim(), text: text.trim() }));
      }
    }
    if (!sprites.length) return this.endDrag();

    // the theme gets a beat of "release" before the pull
    const ready = await Promise.all(sprites);
    this.dragging = false;
    this.theme?.setPointer(null);
    this.updateMood();
    if (!this.state.paired) {
      this.bridge.openSettings('pair');
      return;
    }
    void this.theme?.swallow(ready, at);
    this.loop.kick();
    if (paths.length) await this.bridge.dropPaths(paths);
    if (buffers.length) await this.bridge.dropBuffers(buffers);
    if (text.trim()) await this.bridge.dropText(text);
  }

  // ── events ──────────────────────────────────────────────────────────────

  private onEvent(e: PortalEvent) {
    switch (e.type) {
      case 'state': {
        const prevTheme = this.state.settings.theme;
        this.state = e.state;
        setSound(e.state.settings.sound);
        if (e.state.settings.theme !== prevTheme) this.useTheme(e.state.settings.theme);
        this.updateMood();
        this.render();
        return;
      }
      case 'theme':
        this.state.settings.theme = e.theme;
        this.useTheme(e.theme);
        return;
      case 'outgoing':
        this.outgoing.set(e.item.id, { peer: e.item.peer, p: 0 });
        this.upsert(e.item);
        if (e.origin === 'clipboard') void this.spriteFor(e.item).then((s) => this.theme?.swallow([s], { x: this.L.cx, y: -40 }));
        this.loop.kick();
        this.renderStatus();
        return;
      case 'progress':
        if (e.dir === 'out') {
          const o = this.outgoing.get(e.id);
          if (o) o.p = e.progress;
        } else {
          this.incoming.set(e.id, e.progress);
          this.theme?.setCharge(e.progress);
        }
        this.renderStatus();
        return;
      case 'incoming':
        this.incoming.set(e.item.id, e.item.progress ?? 0);
        this.upsert(e.item);
        this.docking.add(e.item.id);
        this.theme?.setCharge(0);
        this.updateMood();
        this.renderStatus();
        return;
      case 'arrived': {
        const charged = this.incoming.delete(e.item.id);
        this.upsert(e.item);
        this.docking.add(e.item.id);
        if (charged) this.charging.add(e.item.id);
        this.queueEmit(e.item, charged);
        this.renderStatus();
        return;
      }
      case 'delivered': {
        this.outgoing.delete(e.id);
        this.setFlash(`✓ ${this.t.delivered} · ${e.by}`, 'ok');
        this.theme?.sfx?.land();
        return;
      }
      case 'failed': {
        this.outgoing.delete(e.id);
        if (this.incoming.delete(e.id)) this.updateMood();
        this.docking.delete(e.id);
        this.setFlash(this.errorText(e.error), 'err');
        this.renderShelf();
        return;
      }
      case 'linked':
        this.theme?.ignite();
        this.loop.kick();
        this.showCaption(e.device.name, this.t.linked, 2600);
        return;
      case 'notice':
        this.setFlash(e.text);
        return;
    }
  }

  private errorText(code: string) {
    const de = this.state.lang === 'de';
    const map: Record<string, [string, string]> = {
      no_devices: ['Kein anderes Gerät im Portal', 'No other device in this portal'],
      offline: ['Offline', 'Offline'],
      network: ['Verbindung unterbrochen', 'Connection dropped'],
      expired: ['Abgelaufen', 'Expired'],
      stalled: ['Übertragung hängt', 'Transfer stalled'],
      cancelled: ['Abgebrochen', 'Cancelled'],
      corrupt: ['Daten beschädigt, verworfen', 'Corrupted, discarded'],
      text_too_long: ['Text zu lang', 'Text too long'],
      daily_limit: ['Tageslimit erreicht, morgen geht’s weiter', 'Daily limit reached, back tomorrow'],
    };
    const m = map[code] ?? ['Fehlgeschlagen', 'Failed'];
    return `× ${de ? m[0] : m[1]}`;
  }

  private upsert(item: PortalItem) {
    const i = this.state.history.findIndex((h) => h.id === item.id);
    if (i >= 0) this.state.history[i] = item;
    else this.state.history.unshift(item);
  }

  private spriteFor(item: PortalItem) {
    let s = this.sprites.get(item.id);
    if (!s) {
      s = makeSprite({ kind: item.kind, name: item.name, text: item.text, thumb: item.thumb });
      this.sprites.set(item.id, s);
    }
    return s;
  }

  private queueEmit(item: PortalItem, charged: boolean) {
    this.emitQueue = this.emitQueue.then(async () => {
      // a beat of build-up even for things that arrive instantly
      if (!charged) {
        this.charging.add(item.id);
        this.updateMood();
        for (let p = 0; p <= 1; p += 0.25) {
          this.theme?.setCharge(p);
          await wait(70);
        }
      }
      this.charging.delete(item.id);
      this.updateMood();
      const sprite = await this.spriteFor(item);
      const dock = this.dockPoint();
      const timing = this.theme?.timing;
      const shown = this.theme?.emit(sprite, dock);
      this.loop.kick();
      if (timing) {
        setTimeout(() => this.showCaption(this.titleFor(item), this.subtitleFor(item), timing.present), timing.emerge * 0.7);
      }
      await shown;
      this.docking.delete(item.id);
      this.renderShelf(item.id);
      this.renderStatus();
      // show where it went, then get out of the way again
      this.root.classList.add('peek');
      if (this.peekTimer) clearTimeout(this.peekTimer);
      this.peekTimer = setTimeout(() => this.root.classList.remove('peek'), 2200);
    });
  }

  private titleFor(item: PortalItem) {
    if (item.kind === 'text') return `„${item.name}“`;
    return item.name;
  }

  private subtitleFor(item: PortalItem) {
    const t = this.t;
    const kind = { text: t.text, link: t.link, image: t.image, file: t.file, folder: t.folder }[item.kind];
    const parts = [kind];
    if (item.kind !== 'text' && item.kind !== 'link') parts.push(formatBytes(item.size, this.state.lang));
    parts.push(`${t.fromDevice} ${item.peer}`);
    if (item.copied) parts.push(t.copied);
    return parts.join(' · ');
  }

  private dockPoint() {
    const y = 298;
    const count = Math.min(SHELF, this.visibleShelf().length + 1);
    const width = count * CHIP + (count - 1) * GAP;
    return { x: W / 2 - width / 2 + CHIP / 2, y, size: CHIP - 4 };
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private render() {
    this.renderStatus();
    this.renderShelf();
  }

  private setFlash(text: string, kind?: string) {
    this.flash = { text, until: Date.now() + 2600, kind };
    this.renderStatus();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.renderStatus(), 2700);
  }

  private showCaption(title: string, sub: string, ms: number) {
    this.el.capTitle.textContent = title;
    this.el.capSub.textContent = sub;
    this.root.classList.add('captioned');
    setTimeout(() => {
      this.root.classList.remove('captioned');
    }, ms);
  }

  private others() {
    return this.state.devices.filter((d) => d.id !== this.state.self.id);
  }

  private renderStatus() {
    const t = this.t;
    const s = this.state;
    if (!s) return;
    const others = this.others();
    const online = others.filter((d) => d.online);
    let text: string;
    let dot = 'off';
    const out = [...this.outgoing.values()].find((o) => o.p < 1);
    const inc = [...this.incoming.values()];
    if (this.flash && this.flash.until > Date.now()) {
      text = this.flash.text;
      dot = this.flash.kind === 'err' ? 'err' : 'on';
    } else if (this.hint) {
      text = this.hint;
      dot = online.length ? 'on' : 'off';
    } else if (out) {
      text = `↑ ${Math.round(out.p * 100)} %  ·  ${out.peer}`;
      dot = 'busy';
    } else if (inc.length) {
      text = `↓ ${Math.round(Math.max(...inc) * 100)} %`;
      dot = 'busy';
    } else if (!s.paired) {
      text = t.notPaired;
      dot = 'hollow';
    } else if (!s.connected) {
      text = t.connecting;
      dot = 'off';
    } else if (!others.length) {
      text = t.noDevices;
      dot = 'away';
    } else {
      const target = others.find((d) => d.id === s.settings.target);
      const one = target ?? (others.length === 1 ? others[0] : null);
      text = one ? one.name : `${others.length} ${t.devices}`;
      dot = (one ? one.online : online.length > 0) ? 'on' : 'away';
      if (one && !one.online) text = `${one.name} · ${t.offline.toLowerCase()}`;
    }
    this.el.statusText.textContent = text;
    this.el.dot.className = `dot ${dot}`;
    // the name alone isn't worth screen space; progress, errors and setup are
    const important = !!(this.flash && this.flash.until > Date.now()) || !!out || inc.length > 0 || !s.paired;
    this.root.classList.toggle('status-on', important);
  }

  private visibleShelf() {
    return this.state.history.filter((h) => !this.docking.has(h.id) && h.status !== 'failed').slice(0, SHELF);
  }

  private async renderShelf(fresh?: string) {
    const items = this.visibleShelf();
    const shelf = this.el.shelf;
    const existing = new Map([...shelf.children].map((c) => [(c as HTMLElement).dataset.id!, c as HTMLElement]));
    const next: HTMLElement[] = [];
    for (const item of items) {
      let chip = existing.get(item.id);
      if (!chip) {
        chip = document.createElement('div');
        chip.className = `chip ${item.dir}`;
        chip.dataset.id = item.id;
        chip.draggable = true;
        const img = document.createElement('img');
        img.alt = '';
        chip.appendChild(img);
        void this.spriteFor(item).then((s) => (img.src = spriteThumb(s)));
        chip.addEventListener('click', () => void this.bridge.openItem(item.id));
        chip.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.bridge.itemMenu(item.id);
        });
        chip.addEventListener('mouseenter', () => {
          const it = this.state.history.find((h) => h.id === item.id);
          this.setHint(it ? `${it.dir === 'in' ? '↓' : '↑'} ${it.kind === 'text' ? `„${it.name}“` : it.name}` : null);
        });
        chip.addEventListener('mouseleave', () => {
          this.setHint(null);
        });
        chip.addEventListener('dragstart', (e) => {
          e.preventDefault();
          this.ownDrag = true;
          setTimeout(() => (this.ownDrag = false), 1500);
          this.bridge.startDrag(item.id);
        });
        if (item.id === fresh) chip.classList.add('fresh');
      }
      next.push(chip);
    }
    shelf.replaceChildren(...next);
  }
}
