// The portal's brain: turns drops into transfers, transfers into files on
// disk and clipboard contents, and tells the windows what to animate.

import { app, nativeImage, Notification, shell } from 'electron';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  createRoom,
  PortalClient,
  PortalError,
  publishPairing,
  redeemPairing,
  withdrawPairing,
  type Announce,
  type RoomCreds,
} from '../core/client';
import { formatCode, newId } from '../core/crypto';
import { formatBytes, pickLang, strings } from '../shared/i18n';
import type { DroppedBuffer, Lang, PairCode, PortalEvent, PortalItem, PortalState, Settings } from '../shared/types';
import { copyImageFile, copyText, readClipboard } from './clipboard';
import { isDir, kindOf, mimeOf, safeName, thumbnailFor, uniquePath, unzipInto, zipFolder } from './files';
import { platform, Store } from './store';

const INLINE_LIMIT = 200_000;
const HISTORY_TEXT = 50_000;
const RISKY = new Set(['.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.js', '.jar', '.app', '.command', '.sh', '.pkg', '.dmg', '.appimage', '.deb', '.run', '.lnk', '.reg']);
const STALL = 90_000;

type Origin = 'drop' | 'clipboard';

interface Events {
  event: [PortalEvent];
  settings: [Settings, Partial<Settings>];
  summon: [];
  'needs-pair': [];
}

export class PortalService extends EventEmitter<Events> {
  store = new Store();
  client: PortalClient | null = null;
  widgetVisible: () => boolean = () => true;

  private pairing: { code: string; expires: number; slot: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private incoming = new Map<string, { a: Announce; hadUpload: boolean; up: number; down: number; seen: number; downloading: boolean }>();
  private running = 0;
  private waitingJobs: (() => void)[] = [];
  private aborts = new Map<string, AbortController>();
  private tmp = join(app.getPath('temp'), 'zack');
  private lastProgress = new Map<string, number>();

  get lang(): Lang {
    const l = this.store.settings.language;
    return l === 'de' || l === 'en' ? l : pickLang(app.getLocale());
  }

  get t() {
    return strings(this.lang);
  }

  start() {
    if (this.store.room) this.connect(this.store.room);
    setInterval(() => this.watchdog(), 15_000).unref();
  }

  stop() {
    this.client?.stop();
    this.store.flush();
  }

  nudge() {
    this.client?.nudge();
  }

  // ── connection ────────────────────────────────────────────────────────────

  private connect(room: RoomCreds) {
    if (this.client) {
      this.client.removeAllListeners();
      this.client.stop();
    }
    const c = new PortalClient(room, { id: this.store.deviceId, name: this.store.deviceName, platform });
    this.client = c;

    c.on('connection', () => this.pushState());
    c.on('presence', () => this.pushState());
    c.on('joined', (device) => {
      if (this.pairing) this.clearPairing(false);
      this.send({ type: 'linked', device });
      this.notify(`${device.name} ${this.t.linked}`, '');
      this.emit('summon');
    });
    c.on('announce', (a) => void this.onAnnounce(a));
    c.on('remote-progress', (id, p) => {
      const inc = this.incoming.get(id);
      if (!inc) return;
      inc.up = p;
      inc.seen = Date.now();
      this.progressIn(id);
    });
    c.on('ready', (id) => {
      const inc = this.incoming.get(id);
      if (inc) inc.up = 1;
      if (inc && !inc.downloading) void this.download(id);
    });
    c.on('cancel', (id) => {
      if (!this.incoming.has(id)) return;
      this.incoming.delete(id);
      this.fail(id, 'cancelled');
    });
    c.on('delivered', (id) => {
      const item = this.store.patchItem(id, { status: 'delivered', progress: 1 });
      if (item) this.send({ type: 'delivered', id, by: item.peer });
    });
    c.on('forgotten', () => {
      this.leaveLocally();
      this.send({ type: 'notice', text: this.t.offline });
    });

    c.start();
    this.pushState();
  }

  private leaveLocally() {
    this.client?.removeAllListeners();
    this.client?.stop();
    this.client = null;
    this.store.setRoom(null);
    this.pushState();
  }

  // ── state ─────────────────────────────────────────────────────────────────

  state(): PortalState {
    return {
      lang: this.lang,
      platform,
      paired: !!this.store.room,
      connected: !!this.client?.online,
      self: { id: this.store.deviceId, name: this.store.deviceName, platform },
      devices: this.client?.devices ?? [],
      settings: this.store.settings,
      history: this.store.history,
      server: this.store.room?.server ?? this.store.server,
      version: app.getVersion(),
    };
  }

  private pushState() {
    this.send({ type: 'state', state: this.state() });
  }

  private send(e: PortalEvent) {
    this.emit('event', e);
  }

  private others() {
    return (this.client?.devices ?? []).filter((d) => d.id !== this.store.deviceId);
  }

  private targets(): string[] | null {
    const t = this.store.settings.target;
    return t !== '*' && this.others().some((d) => d.id === t) ? [t] : null;
  }

  targetLabel() {
    const t = this.store.settings.target;
    const others = this.others();
    const one = others.find((d) => d.id === t) ?? (others.length === 1 ? others[0] : null);
    if (one) return one.name;
    return others.length ? `${others.length} ${this.t.devices}` : this.t.noDevices;
  }

  setSettings(patch: Partial<Settings>) {
    const next = this.store.patchSettings(patch);
    this.emit('settings', next, patch);
    if (patch.theme) this.send({ type: 'theme', theme: patch.theme });
    this.pushState();
  }

  rename(name: string) {
    const clean = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48);
    if (!clean) return;
    this.store.deviceName = clean;
    this.client?.rename(clean);
    this.pushState();
  }

  // ── pairing ───────────────────────────────────────────────────────────────

  async createCode(): Promise<PairCode> {
    let room = this.store.room;
    if (!room) {
      room = await createRoom(this.store.server);
      this.store.setRoom(room);
      this.connect(room);
    }
    if (this.pairing) this.clearPairing(true);
    const { code, expires, slot } = await publishPairing(room, { name: this.store.deviceName, platform });
    const timer = setTimeout(() => this.clearPairing(false), expires - Date.now());
    this.pairing = { code, expires, slot, timer };
    const pc = { code: formatCode(code), expires };
    this.send({ type: 'pair-code', code: pc });
    return pc;
  }

  cancelCode() {
    if (this.pairing) this.clearPairing(true);
  }

  private clearPairing(withdraw: boolean) {
    if (!this.pairing) return;
    clearTimeout(this.pairing.timer);
    if (withdraw && this.store.room) void withdrawPairing(this.store.room.server, this.pairing.slot);
    this.pairing = null;
    this.send({ type: 'pair-code', code: null });
  }

  async join(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const payload = await redeemPairing(this.store.server, code);
      if (this.pairing) this.clearPairing(true);
      this.store.setRoom(payload.room);
      this.connect(payload.room);
      this.send({ type: 'linked', device: { id: '', name: payload.from.name, platform: payload.from.platform, online: true, lastSeen: Date.now() } });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof PortalError ? err.code : 'network' };
    }
  }

  unpair() {
    if (this.pairing) this.clearPairing(true);
    this.client?.forget(this.store.deviceId);
    setTimeout(() => this.leaveLocally(), 300);
  }

  /** Removing someone else rotates the room, so whatever they kept is useless. */
  async forget(deviceId: string) {
    const c = this.client;
    if (!c || deviceId === this.store.deviceId) return;
    const remaining = this.others()
      .filter((d) => d.id !== deviceId)
      .map((d) => d.id);
    c.forget(deviceId);
    const fresh = await createRoom(this.store.server);
    if (remaining.length) await c.sendRekey(fresh, remaining);
    this.store.setRoom(fresh);
    this.connect(fresh);
  }

  // ── sending ───────────────────────────────────────────────────────────────

  private ensureReady() {
    if (this.client) return this.client;
    this.emit('needs-pair');
    return null;
  }

  /** Files go out two at a time, so one huge folder never holds up the rest. */
  private enqueue(job: () => Promise<void>) {
    const run = async () => {
      this.running++;
      try {
        await job();
      } finally {
        this.running--;
        this.waitingJobs.shift()?.();
      }
    };
    if (this.running < 2) void run();
    else this.waitingJobs.push(() => void run());
  }

  cancelItem(id: string) {
    const item = this.store.item(id);
    if (!item) return;
    if (item.dir === 'out') this.aborts.get(id)?.abort();
    else {
      this.incoming.delete(id);
      this.client?.abort(id, 'cancelled');
    }
    if (item.status === 'sending' || item.status === 'incoming') this.fail(id, 'cancelled');
  }

  async dropPaths(paths: string[], origin: Origin = 'drop') {
    if (!this.ensureReady()) return;
    for (const path of paths) {
      if (!existsSync(path)) continue;
      const folder = await isDir(path);
      const kind = folder ? 'folder' : kindOf(path);
      const item: PortalItem = {
        id: newId(),
        dir: 'out',
        kind,
        name: basename(path),
        size: folder ? 0 : (await stat(path)).size,
        mime: folder ? 'application/zip' : mimeOf(path),
        path,
        peer: this.targetLabel(),
        at: Date.now(),
        status: 'sending',
        progress: 0,
      };
      if (!folder) item.thumb = await thumbnailFor(path, kind);
      this.store.upsertItem(item);
      this.send({ type: 'outgoing', item, origin });
      this.enqueue(() => this.sendPath(item, folder));
    }
  }

  private async sendPath(item: PortalItem, folder: boolean) {
    const c = this.client;
    if (!c || !item.path) return this.fail(item.id, 'offline');
    const abort = new AbortController();
    this.aborts.set(item.id, abort);
    let src = item.path;
    let cleanup: string | null = null;
    // packing a folder is the first 15 % of the bar
    const packShare = folder ? 0.15 : 0;
    try {
      if (folder) {
        await mkdir(this.tmp, { recursive: true });
        src = cleanup = join(this.tmp, `${item.id}.zip`);
        await zipFolder(item.path, src, (p) => this.progressOut(item.id, p * packShare));
        if (abort.signal.aborted) throw new PortalError('cancelled');
        this.store.patchItem(item.id, { size: (await stat(src)).size });
      }
      await c.sendFile(
        src,
        { kind: item.kind, name: folder ? `${item.name}.zip` : item.name, mime: item.mime, thumb: item.thumb, folder },
        this.targets(),
        (p) => this.progressOut(item.id, packShare + p * (1 - packShare)),
        item.id,
        abort.signal,
      );
      const now = this.store.item(item.id);
      if (now && now.status !== 'delivered') this.store.patchItem(item.id, { status: 'waiting', progress: 1 });
      this.pushState();
    } catch (err) {
      if (this.store.item(item.id)?.status !== 'failed') this.fail(item.id, err instanceof PortalError ? err.code : 'network');
    } finally {
      this.aborts.delete(item.id);
      if (cleanup) await rm(cleanup, { force: true });
    }
  }

  async dropText(raw: string, origin: Origin = 'drop') {
    const c = this.ensureReady();
    if (!c) return;
    const text = raw.replace(/\r\n/g, '\n');
    const trimmed = text.trim();
    if (!trimmed) return;
    const kind = /^https?:\/\/\S+$/i.test(trimmed) && trimmed.length < 4096 ? 'link' : 'text';
    const body = kind === 'link' ? trimmed : text;
    const size = Buffer.byteLength(body);
    const item: PortalItem = {
      id: newId(),
      dir: 'out',
      kind,
      name: kind === 'link' ? trimmed : firstLine(trimmed),
      size,
      text: body.slice(0, HISTORY_TEXT),
      peer: this.targetLabel(),
      at: Date.now(),
      status: 'sending',
      progress: 0,
    };
    this.store.upsertItem(item);
    this.send({ type: 'outgoing', item, origin });

    // text is tiny: it never waits behind files
    const job = async () => {
      try {
        if (size <= INLINE_LIMIT) {
          await c.sendText(body, kind, this.targets(), item.id);
        } else {
          await mkdir(this.tmp, { recursive: true });
          const file = join(this.tmp, `${item.id}.txt`);
          await writeFile(file, body);
          await c.sendFile(file, { kind: 'text', name: 'Text.txt', mime: 'text/plain' }, this.targets(), (p) => this.progressOut(item.id, p), item.id);
          await rm(file, { force: true });
        }
        const now = this.store.item(item.id);
        if (now && now.status !== 'delivered') this.store.patchItem(item.id, { status: 'waiting', progress: 1 });
        this.pushState();
      } catch (err) {
        this.fail(item.id, err instanceof PortalError ? err.code : 'network');
      }
    };
    if (size <= INLINE_LIMIT) void job();
    else this.enqueue(job);
  }

  async dropBuffers(buffers: DroppedBuffer[]) {
    if (!this.ensureReady()) return;
    await mkdir(this.tmp, { recursive: true });
    const paths: string[] = [];
    for (const b of buffers) {
      const p = await uniquePath(this.tmp, safeName(b.name, 'Dropped'));
      await writeFile(p, Buffer.from(b.data));
      paths.push(p);
    }
    await this.dropPaths(paths);
  }

  async sendClipboard() {
    if (!this.ensureReady()) return;
    const clip = await readClipboard();
    if (clip.files.length) return this.dropPaths(clip.files, 'clipboard');
    if (clip.text.trim()) return this.dropText(clip.text, 'clipboard');
    if (clip.image) {
      await mkdir(this.tmp, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const p = join(this.tmp, `Clipboard ${stamp}.png`);
      await writeFile(p, clip.image);
      return this.dropPaths([p], 'clipboard');
    }
    this.send({ type: 'notice', text: this.t.nothingOnClipboard });
  }

  private progressOut(id: string, p: number) {
    this.store.patchItem(id, { progress: p });
    this.throttled(id, () => this.send({ type: 'progress', id, progress: p, dir: 'out' }), p === 1);
  }

  private throttled(id: string, fn: () => void, force = false) {
    const now = Date.now();
    if (!force && now - (this.lastProgress.get(id) ?? 0) < 80) return;
    this.lastProgress.set(id, now);
    fn();
  }

  private fail(id: string, error: string) {
    this.store.patchItem(id, { status: 'failed', error });
    this.send({ type: 'failed', id, error });
    this.pushState();
  }

  // ── receiving ─────────────────────────────────────────────────────────────

  private async onAnnounce(a: Announce) {
    const c = this.client;
    if (!c) return;

    if (a.meta.control?.type === 'rekey') {
      c.ack(a.id);
      const room = a.meta.control.room;
      setTimeout(() => {
        this.store.setRoom(room);
        this.connect(room);
      }, 250);
      return;
    }

    const known = this.store.item(a.id);
    if (known && (known.status === 'received' || known.dir === 'out')) return c.ack(a.id);
    if (this.incoming.has(a.id)) return;

    const sender = c.devices.find((d) => d.id === a.from);
    const item: PortalItem = {
      id: a.id,
      dir: 'in',
      kind: a.meta.kind,
      name: a.meta.kind === 'text' && a.meta.text ? firstLine(a.meta.text) : a.meta.folder ? a.meta.name.replace(/\.zip$/i, '') : a.meta.name,
      size: a.meta.size,
      mime: a.meta.mime,
      text: a.meta.text?.slice(0, HISTORY_TEXT),
      thumb: a.meta.thumb,
      peer: sender?.name ?? a.meta.from.name,
      peerPlatform: a.meta.from.platform,
      at: Date.now(),
      status: 'incoming',
      progress: 0,
    };

    if (a.chunks === 0) return this.receiveText(item, a.meta.text ?? '');

    this.incoming.set(a.id, { a, hadUpload: !a.ready, up: a.ready ? 1 : 0, down: 0, seen: Date.now(), downloading: false });
    this.store.upsertItem(item);
    this.send({ type: 'incoming', item });
    this.emit('summon');
    // streams: chunks are fetched as they land, even while the upload is running
    void this.download(a.id);
  }

  private async receiveText(item: PortalItem, text: string) {
    const s = this.store.settings;
    if (s.autoCopyText) {
      await copyText(text);
      item.copied = true;
    }
    if (item.kind === 'link' && s.autoOpenLinks && /^https?:\/\//i.test(text)) void shell.openExternal(text);
    item.status = 'received';
    item.progress = 1;
    this.store.upsertItem(item);
    this.send({ type: 'arrived', item });
    this.client?.ack(item.id);
    this.emit('summon');
    if (!this.widgetVisible()) this.notify(item.kind === 'link' ? item.name : this.t.textArrived, `${this.t.fromDevice} ${item.peer}`, item.id);
  }

  private progressIn(id: string, down?: number) {
    const inc = this.incoming.get(id);
    if (!inc) return;
    if (down === undefined) down = inc.down;
    inc.down = down;
    const p = inc.hadUpload ? inc.up * 0.5 + down * 0.5 : down;
    this.store.patchItem(id, { progress: p });
    this.throttled(id, () => this.send({ type: 'progress', id, progress: p, dir: 'in' }), down === 1);
  }

  private async download(id: string) {
    const inc = this.incoming.get(id);
    const c = this.client;
    if (!inc || !c) return;
    inc.downloading = true;
    const { a } = inc;
    const s = this.store.settings;
    try {
      await mkdir(s.saveDir, { recursive: true });
      const tmp = await c.download(a, s.saveDir, (p) => {
        inc.seen = Date.now();
        this.progressIn(id, p);
      });
      let path: string;
      if (a.meta.folder) {
        path = await unzipInto(tmp, s.saveDir, a.meta.name.replace(/\.zip$/i, ''));
      } else {
        path = await uniquePath(s.saveDir, safeName(a.meta.name));
        await rename(tmp, path);
      }

      let copied = false;
      let text: string | undefined;
      if (a.meta.kind === 'text') {
        text = await readFile(path, 'utf8');
        if (s.autoCopyText) {
          await copyText(text);
          copied = true;
        }
      } else if (a.meta.kind === 'image' && s.autoCopyImages) {
        copied = await copyImageFile(path);
      }

      this.incoming.delete(id);
      const item = this.store.patchItem(id, { status: 'received', progress: 1, path, copied, ...(text ? { text: text.slice(0, HISTORY_TEXT) } : {}) });
      c.ack(id);
      if (item) {
        this.send({ type: 'arrived', item });
        if (!this.widgetVisible()) this.notify(item.name, `${formatBytes(item.size, this.lang)} · ${this.t.fromDevice} ${item.peer}`, id);
      }
    } catch (err) {
      this.incoming.delete(id);
      this.fail(id, err instanceof PortalError ? err.code : 'network');
    }
  }

  private watchdog() {
    const now = Date.now();
    for (const [id, inc] of this.incoming) {
      if (now - inc.seen > STALL) {
        this.incoming.delete(id);
        this.client?.abort(id);
        this.fail(id, 'stalled');
      }
    }
  }

  // ── items ─────────────────────────────────────────────────────────────────

  openItem(id: string) {
    const item = this.store.item(id);
    if (!item) return;
    if (item.kind === 'link' && item.text && /^https?:\/\//i.test(item.text)) return void shell.openExternal(item.text);
    if (item.kind === 'text') return void this.copyItem(id);
    if (!item.path || !existsSync(item.path)) return;
    // one click should never run something that came over the wire
    if (item.dir === 'in' && RISKY.has(extname(item.path).toLowerCase())) return shell.showItemInFolder(item.path);
    void shell.openPath(item.path);
  }

  revealItem(id: string) {
    const item = this.store.item(id);
    if (item?.path && existsSync(item.path)) shell.showItemInFolder(item.path);
  }

  async copyItem(id: string) {
    const item = this.store.item(id);
    if (!item) return;
    if (item.text && (item.kind === 'text' || item.kind === 'link')) await copyText(item.text);
    else if (item.kind === 'image' && item.path) await copyImageFile(item.path);
    else if (item.path) await copyText(item.path);
  }

  removeItem(id: string) {
    this.store.removeItem(id);
    this.pushState();
  }

  dragIcon(id: string) {
    const item = this.store.item(id);
    if (!item?.path || !existsSync(item.path)) return null;
    const img = item.thumb ? nativeImage.createFromDataURL(item.thumb) : nativeImage.createEmpty();
    return { path: item.path, icon: img.isEmpty() ? null : img.resize({ width: 64 }) };
  }

  async fileIcon(path: string) {
    if (!existsSync(path)) return null;
    return (await thumbnailFor(path, kindOf(path))) ?? null;
  }

  openSaveDir() {
    const dir = this.store.settings.saveDir;
    void mkdir(dir, { recursive: true }).then(() => shell.openPath(dir));
  }

  private notify(title: string, body: string, itemId?: string) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    if (itemId) n.on('click', () => this.revealItem(itemId));
    n.show();
  }
}

function firstLine(text: string) {
  const line = text.trim().split('\n')[0];
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
