// The transport: one socket per device for presence and envelopes, plain
// HTTPS for ciphertext chunks. Nothing in here knows about Electron, so the
// whole round trip can be exercised from a Node script against `wrangler dev`.

import { EventEmitter } from 'node:events';
import { open as openFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Device, ItemKind, Platform } from '../shared/types.ts';
import {
  CHUNK_SIZE,
  dropKey,
  newId,
  newCode,
  newRoomKey,
  normalizeCode,
  openChunk,
  openName,
  openEnvelope,
  openMeta,
  pairSecrets,
  sealChunk,
  sealEnvelope,
  sealMeta,
  sealName,
} from './crypto.ts';

const DROP_ID = /^[A-Za-z0-9_-]{16,64}$/;

export interface RoomCreds {
  server: string;
  roomId: string;
  token: string;
  key: string;
}

export interface SelfInfo {
  id: string;
  name: string;
  platform: Platform;
  /** binds this device id on the relay; nobody else can connect as us */
  secret: string;
}

export interface DropMeta {
  v: 1;
  kind: ItemKind;
  name: string;
  size: number;
  mime?: string;
  text?: string;
  thumb?: string;
  folder?: boolean;
  chunkSize: number;
  /** sealed copy of the chunk count, so the relay can't truncate a file */
  chunks: number;
  from: { name: string; platform: Platform };
  /** device-to-device housekeeping that never shows up in the UI */
  control?: { type: 'rekey'; room: RoomCreds };
}

export interface Announce {
  id: string;
  from: string;
  meta: DropMeta;
  size: number;
  chunks: number;
  ready: boolean;
  at: number;
}

const PARALLEL = 3;
const DEBUG = !!process.env.ZACK_DEBUG;
const INLINE_TEXT_LIMIT = 200_000;

export async function createRoom(server: string): Promise<RoomCreds> {
  const res = await fetch(new URL('/v1/rooms', server), { method: 'POST' });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const { roomId, token } = (await res.json()) as { roomId: string; token: string };
  return { server, roomId, token, key: newRoomKey() };
}

export interface PairPayload {
  v: 1;
  room: RoomCreds;
  from: { name: string; platform: Platform };
}

export async function publishPairing(room: RoomCreds, from: PairPayload['from']) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    const { slot, key } = await pairSecrets(code);
    const envelope = sealEnvelope(key, { v: 1, room, from } satisfies PairPayload);
    const res = await fetch(new URL(`/v1/pair/${slot}`, room.server), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelope }),
    });
    if (res.status === 409) continue;
    if (!res.ok) throw new Error(`relay ${res.status}`);
    const { expires } = (await res.json()) as { expires: number };
    return { code, expires, slot };
  }
  throw new Error('no free pairing slot');
}

export async function withdrawPairing(server: string, slot: string) {
  await fetch(new URL(`/v1/pair/${slot}`, server), { method: 'DELETE' }).catch(() => {});
}

export async function redeemPairing(server: string, input: string): Promise<PairPayload> {
  const code = normalizeCode(input);
  if (!code) throw new PortalError('bad_code');
  const { slot, key } = await pairSecrets(code);
  const res = await fetch(new URL(`/v1/pair/${slot}`, server));
  if (res.status === 404) throw new PortalError('unknown_code');
  if (!res.ok) throw new Error(`relay ${res.status}`);
  const { envelope } = (await res.json()) as { envelope: string };
  return openEnvelope<PairPayload>(key, envelope);
}

export class PortalError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

type ServerMsg =
  | { t: 'welcome'; you: string; devices: Device[] }
  | { t: 'presence'; devices: Device[] }
  | { t: 'joined'; device: Device }
  | { t: 'announce'; id: string; from: string; env: string; size: number; chunks: number; ready: boolean; at: number }
  | { t: 'progress'; id: string; p: number; c?: number }
  | { t: 'ready'; id: string }
  | { t: 'cancel'; id: string }
  | { t: 'sent'; id: string; recipients: number; online: number }
  | { t: 'delivered'; id: string; by: string }
  | { t: 'forgotten' }
  | { t: 'pong' }
  | { t: 'error'; code: string; id?: string };

export interface ClientEvents {
  connection: [online: boolean];
  presence: [devices: Device[]];
  joined: [device: Device];
  announce: [a: Announce];
  'remote-progress': [id: string, p: number];
  ready: [id: string];
  cancel: [id: string];
  sent: [id: string, recipients: number, online: number];
  delivered: [id: string, by: string];
  forgotten: [];
}

export class PortalClient extends EventEmitter<ClientEvents> {
  room: RoomCreds;
  self: SelfInfo;
  devices: Device[] = [];
  online = false;

  private ws: WebSocket | null = null;
  private outbox: string[] = [];
  private retry = 0;
  private stopped = true;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPong = 0;
  private waiters = new Map<string, (r: { recipients: number; online: number }) => void>();
  private gates = new Map<string, Gate>();

  constructor(room: RoomCreds, self: SelfInfo) {
    super();
    this.room = room;
    this.self = self;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.setOnline(false);
  }

  /** Skip the backoff, e.g. after the machine wakes up. */
  nudge() {
    if (this.stopped) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.raw('{"t":"ping"}');
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.retry = 0;
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    const url = new URL(`/v1/rooms/${this.room.roomId}/ws`, this.room.server);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('d', this.self.id);
    url.searchParams.set('n', sealName(this.room.key, this.self.name));
    url.searchParams.set('p', this.self.platform);

    const ws = new WebSocket(url, ['zack.v1', `auth.${this.room.token}`, `dev.${this.self.secret}`]);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.lastPong = Date.now();
      this.setOnline(true);
      for (const m of this.outbox.splice(0)) ws.send(m);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 45_000) return ws.close(4002, 'silent');
        ws.send('{"t":"ping"}');
      }, 20_000);
    });

    ws.addEventListener('message', (ev) => {
      this.lastPong = Date.now();
      if (typeof ev.data !== 'string') return;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    });

    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.setOnline(false);
      if (this.stopped) return;
      const delay = Math.min(20_000, 800 * 2 ** this.retry++) + Math.random() * 400;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    ws.addEventListener('close', down);
    ws.addEventListener('error', () => ws.close());
  }

  private setOnline(v: boolean) {
    if (this.online === v) return;
    this.online = v;
    this.emit('connection', v);
  }

  private handle(msg: ServerMsg) {
    switch (msg.t) {
      case 'welcome':
      case 'presence':
        this.devices = msg.devices.map((d) => ({ ...d, name: openName(this.room.key, d.name) }));
        this.emit('presence', msg.devices);
        return;
      case 'joined':
        this.emit('joined', { ...msg.device, name: openName(this.room.key, msg.device.name) });
        return;
      case 'announce': {
        // the id ends up in a file name: never trust the relay with that
        if (!DROP_ID.test(msg.id)) return;
        try {
          const meta = openMeta<DropMeta>(dropKey(this.room.key, msg.id), msg.id, msg.env);
          if (meta.chunks !== msg.chunks) throw new Error('chunk count mismatch');
          // start listening for chunk notices now, before anyone asks to download
          if (msg.chunks > 0 && !this.gates.has(msg.id)) {
            const gate = new Gate();
            if (msg.ready) gate.open();
            this.gates.set(msg.id, gate);
          }
          this.emit('announce', { id: msg.id, from: msg.from, meta, size: meta.size, chunks: meta.chunks, ready: msg.ready, at: msg.at });
        } catch {
          // sealed with a key we don't have (stale room); acknowledge so it stops coming back
          this.send({ t: 'ack', id: msg.id });
        }
        return;
      }
      case 'progress':
        if (typeof msg.c === 'number') this.gates.get(msg.id)?.mark(msg.c);
        this.emit('remote-progress', msg.id, msg.p);
        return;
      case 'ready':
        this.gates.get(msg.id)?.open();
        this.emit('ready', msg.id);
        return;
      case 'cancel':
        this.gates.get(msg.id)?.abort(new PortalError('cancelled'));
        this.emit('cancel', msg.id);
        return;
      case 'sent':
        this.waiters.get(msg.id)?.({ recipients: msg.recipients, online: msg.online });
        this.waiters.delete(msg.id);
        this.emit('sent', msg.id, msg.recipients, msg.online);
        return;
      case 'delivered':
        this.emit('delivered', msg.id, msg.by);
        return;
      case 'forgotten':
        // removed from the portal: hang up and don't come back
        this.stop();
        this.emit('forgotten');
        return;
    }
  }

  private raw(s: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.outbox.push(s);
  }

  send(msg: object) {
    this.raw(JSON.stringify(msg));
  }

  /** Ephemeral messages are pointless once stale, so they never queue. */
  private sendNow(msg: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private announce(id: string, meta: DropMeta, chunks: number, to: string[] | null) {
    const env = sealMeta(dropKey(this.room.key, id), id, meta);
    const settled = new Promise<{ recipients: number; online: number }>((resolve) => this.waiters.set(id, resolve));
    this.send({ t: 'announce', id, to, env, size: meta.size, chunks });
    return settled;
  }

  rename(name: string) {
    this.self = { ...this.self, name };
    this.send({ t: 'rename', name: sealName(this.room.key, name) });
  }

  forget(deviceId: string) {
    this.send({ t: 'forget', device: deviceId });
  }

  ack(id: string) {
    this.send({ t: 'ack', id });
  }

  async sendText(text: string, kind: 'text' | 'link', to: string[] | null, id = newId()) {
    const size = Buffer.byteLength(text);
    if (size > INLINE_TEXT_LIMIT) throw new PortalError('text_too_long');
    const meta: DropMeta = { v: 1, kind, name: kind === 'link' ? text : 'Text', size, text, chunkSize: 0, chunks: 0, from: this.fromInfo() };
    const r = await this.announce(id, meta, 0, to);
    if (!r.recipients) throw new PortalError('no_devices');
    return { id, ...r };
  }

  /** Hands the remaining devices a fresh room; the old one is left to expire. */
  async sendRekey(room: RoomCreds, to: string[]) {
    const meta: DropMeta = { v: 1, kind: 'text', name: '', size: 0, chunkSize: 0, chunks: 0, from: this.fromInfo(), control: { type: 'rekey', room } };
    return this.announce(newId(), meta, 0, to);
  }

  async sendFile(
    path: string,
    partial: Omit<DropMeta, 'v' | 'size' | 'chunkSize' | 'chunks' | 'from'>,
    to: string[] | null,
    onProgress: (p: number) => void,
    id = newId(),
    signal?: AbortSignal,
  ) {
    const size = (await stat(path)).size;
    const chunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    const meta: DropMeta = { v: 1, ...partial, size, chunkSize: CHUNK_SIZE, chunks, from: this.fromInfo() };
    const key = dropKey(this.room.key, id);
    const r = await this.announce(id, meta, chunks, to);
    if (!r.recipients) throw new PortalError('no_devices');

    const fh = await openFile(path, 'r');
    let done = 0;
    try {
      await pool(chunks, PARALLEL, async (i) => {
        if (signal?.aborted) throw new PortalError('cancelled');
        const len = Math.min(CHUNK_SIZE, size - i * CHUNK_SIZE);
        const buf = Buffer.alloc(Math.max(0, len));
        if (len > 0) await fh.read(buf, 0, len, i * CHUNK_SIZE);
        const sealed = sealChunk(key, id, i, buf);
        await this.http('PUT', `/blobs/${id}/${i}`, sealed);
        done++;
        const p = done / chunks;
        onProgress(p);
        // every finished chunk is announced, so receivers can fetch it while the rest uploads
        this.sendNow({ t: 'progress', id, p, c: i });
      });
    } catch (err) {
      this.send({ t: 'cancel', id });
      throw err;
    } finally {
      await fh.close();
    }
    this.send({ t: 'ready', id });
    return { id, ...r };
  }

  /** Gives up on a download that is waiting for chunks that will never come. */
  abort(id: string, code = 'stalled') {
    this.gates.get(id)?.abort(new PortalError(code));
  }

  /**
   * Writes the decrypted drop into `dir` under a temporary name and returns its
   * path. Starts before the sender has finished: each chunk is fetched as soon
   * as the sender reports it landed.
   */
  async download(a: Announce, dir: string, onProgress: (p: number) => void) {
    const key = dropKey(this.room.key, a.id);
    const tmp = join(dir, `.zack-${a.id}.part`);
    let gate = this.gates.get(a.id);
    if (!gate) {
      gate = new Gate();
      if (a.ready) gate.open();
      this.gates.set(a.id, gate);
    }
    const fh = await openFile(tmp, 'w');
    let done = 0;
    try {
      await pool(a.chunks, PARALLEL, async (i) => {
        await gate.wait(i);
        if (gate.aborted) throw gate.aborted;
        let res: Response;
        for (;;) {
          try {
            res = await this.http('GET', `/blobs/${a.id}/${i}`);
            break;
          } catch (err) {
            // not uploaded yet (we joined mid-transfer and missed its notice): wait for it
            if (err instanceof PortalError && err.code === 'expired' && !gate.ready) {
              await new Promise((r) => setTimeout(r, 500));
              if (gate.aborted) throw gate.aborted;
              continue;
            }
            throw err;
          }
        }
        const t0 = Date.now();
        const body = new Uint8Array(await res.arrayBuffer());
        if (DEBUG) console.log(`[zack] chunk ${i} body ${body.length}B in ${Date.now() - t0}ms`);
        const plain = openChunk(key, a.id, i, body);
        const expected = i === a.chunks - 1 ? a.size - i * a.meta.chunkSize : a.meta.chunkSize;
        if (plain.length !== expected) throw new PortalError('corrupt');
        await fh.write(plain, 0, plain.length, i * a.meta.chunkSize);
        onProgress(++done / a.chunks);
      });
    } catch (err) {
      this.gates.delete(a.id);
      await fh.close();
      await rm(tmp, { force: true });
      throw err;
    }
    this.gates.delete(a.id);
    await fh.close();
    return tmp;
  }

  private async http(method: 'GET' | 'PUT', path: string, body?: Uint8Array) {
    const url = new URL(`/v1/rooms/${this.room.roomId}${path}`, this.room.server);
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const t0 = Date.now();
        if (DEBUG) console.log(`[zack] ${method} ${path} start`);
        const res = await fetch(url, {
          method,
          headers: { authorization: `Bearer ${this.room.token}`, ...(body ? { 'content-type': 'application/octet-stream' } : {}) },
          body: body as BodyInit | undefined,
        });
        if (DEBUG) console.log(`[zack] ${method} ${path} ${res.status} headers after ${Date.now() - t0}ms`);
        if (res.ok) return res;
        if (res.status === 404 && method === 'GET') throw new PortalError('expired');
        // the relay's daily allowance is used up: no point retrying until tomorrow
        if (res.status === 429 && res.headers.get('x-zack-limit') === 'daily') throw new PortalError('daily_limit');
        // 429: the relay asks us to slow down; back off and try again like a 5xx
        if (res.status < 500 && res.status !== 429) throw new PortalError(`http_${res.status}`);
        lastErr = new Error(`relay ${res.status}`);
      } catch (err) {
        if (err instanceof PortalError) throw err;
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
    throw lastErr;
  }

  private fromInfo() {
    return { name: this.self.name, platform: this.self.platform };
  }
}


/** Tracks which chunks of an in-flight upload are already on the relay. */
class Gate {
  ready = false;
  aborted: Error | null = null;
  private have = new Set<number>();
  private waiting = new Map<number, (() => void)[]>();

  mark(i: number) {
    this.have.add(i);
    this.waiting.get(i)?.forEach((f) => f());
    this.waiting.delete(i);
  }

  open() {
    this.ready = true;
    for (const list of this.waiting.values()) list.forEach((f) => f());
    this.waiting.clear();
  }

  abort(err: Error) {
    this.aborted = err;
    this.open();
  }

  /** Resolves when chunk i is known to be there, or after a while anyway (a missed notice must not block). */
  wait(i: number, patience = 3000) {
    if (this.ready || this.have.has(i)) return Promise.resolve();
    return new Promise<void>((r) => {
      const t = setTimeout(r, patience);
      this.waiting.set(i, [...(this.waiting.get(i) ?? []), () => (clearTimeout(t), r())]);
    });
  }
}

async function pool(count: number, width: number, task: (i: number) => Promise<void>) {
  let next = 0;
  let failed: unknown = null;
  const lane = async () => {
    while (next < count && !failed) {
      const i = next++;
      try {
        await task(i);
      } catch (err) {
        failed = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, count) }, lane));
  if (failed) throw failed;
}
