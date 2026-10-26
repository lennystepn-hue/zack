import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { deleteChunks, json } from './util';

const DAY = 24 * 60 * 60 * 1000;
// Inline drops are tiny and include rekeys, which must outlive a long vacation.
const INLINE_TTL = 30 * DAY;
const STALE_UPLOAD = 2 * 60 * 60 * 1000;
const MAX_ENV = 512 * 1024;
const PLATFORMS = new Set(['mac', 'win', 'linux']);
const ID = /^[A-Za-z0-9_-]{16,64}$/;
// a socket that sends more than this in 10 s is closed
const MESSAGE_BUDGET = 200;
// small drops (text, links, rekeys) live in this object's storage: a daily budget for them
const DAILY_INLINE_BYTES = 200 * 1024 * 1024;

type Attachment = { id: string };

type DeviceRow = { id: string; name: string; platform: string; first_seen: number; last_seen: number; secret_hash: string | null };
type DropRow = { id: string; sender: string; env: string; size: number; chunks: number; ready: number; created: number };

type ClientMsg =
  | { t: 'announce'; id: string; to?: string[] | null; env: string; size: number; chunks: number }
  | { t: 'progress'; id: string; p: number; c?: number }
  | { t: 'ready'; id: string }
  | { t: 'cancel'; id: string }
  | { t: 'ack'; id: string }
  | { t: 'rename'; name: string }
  | { t: 'forget'; device: string };

// A room is one portal: the set of devices that share a key. Sockets hibernate
// between messages, so an idle portal costs nothing.
export class Room extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS drops (id TEXT PRIMARY KEY, sender TEXT NOT NULL, env TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, ready INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (drop_id TEXT NOT NULL, device TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (drop_id, device));
      CREATE TABLE IF NOT EXISTS forgotten (id TEXT PRIMARY KEY);
    `);
    const columns = this.sql.exec<{ name: string }>('PRAGMA table_info(devices)').toArray().map((c) => c.name);
    if (!columns.includes('secret_hash')) this.sql.exec('ALTER TABLE devices ADD COLUMN secret_hash TEXT');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const roomId = req.headers.get('x-room');
    const id = url.searchParams.get('d') ?? '';
    // names arrive sealed by the clients; to the relay they are opaque text
    const name = clean(url.searchParams.get('n') ?? '', 400) || 'Unnamed';
    const platform = url.searchParams.get('p') ?? '';
    const secret = req.headers.get('x-device-secret') ?? '';
    if (!roomId || !ID.test(id) || !PLATFORMS.has(platform)) return json({ error: 'bad_hello' }, 400);
    this.sql.exec('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)', 'room', roomId);

    // A device id is bound to the secret it first came with. Removed devices
    // stay out, and once anyone was removed the room takes no newcomers: the
    // others have moved on to a fresh room by then.
    if (this.sql.exec('SELECT 1 FROM forgotten WHERE id = ?', id).toArray().length) return json({ error: 'forgotten' }, 403);
    const hash = secret ? await sha256(secret) : null;
    const now = Date.now();
    const known = this.sql.exec<DeviceRow>('SELECT * FROM devices WHERE id = ?', id).toArray()[0];
    if (known) {
      if (known.secret_hash && known.secret_hash !== hash) return json({ error: 'not_you' }, 403);
      this.sql.exec('UPDATE devices SET name = ?, platform = ?, last_seen = ?, secret_hash = COALESCE(secret_hash, ?) WHERE id = ?', name, platform, now, hash, id);
    } else {
      if (this.locked()) return json({ error: 'locked' }, 403);
      this.sql.exec('INSERT INTO devices (id, name, platform, first_seen, last_seen, secret_hash) VALUES (?, ?, ?, ?, ?, ?)', id, name, platform, now, now, hash);
    }

    for (const old of this.ctx.getWebSockets(id)) old.close(4000, 'replaced');

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id } satisfies Attachment);

    send(server, { t: 'welcome', you: id, devices: this.devices() });
    if (!known) this.broadcast({ t: 'joined', device: this.device(id) }, id);
    this.broadcast({ t: 'presence', devices: this.devices() }, id);

    // Everything that piled up while this device was away.
    const pending = this.sql
      .exec<DropRow>(
        `SELECT d.* FROM drops d JOIN deliveries v ON v.drop_id = d.id
         WHERE v.device = ? AND v.acked = 0 ORDER BY d.created`,
        id,
      )
      .toArray();
    for (const d of pending) send(server, announceOf(d));

    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'zack.v1' } });
  }

  /** Asked by the Worker before it touches R2: only chunks of announced drops exist. */
  async chunkAllowed(dropId: string, index: number, mode: 'put' | 'get') {
    const d = this.sql.exec<DropRow>('SELECT * FROM drops WHERE id = ?', dropId).toArray()[0];
    if (!d || index >= d.chunks) return false;
    return mode === 'get' || !d.ready;
  }

  private budgets = new WeakMap<WebSocket, { start: number; count: number }>();

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return;
    const me = (ws.deserializeAttachment() as Attachment).id;
    const now = Date.now();
    const budget = this.budgets.get(ws) ?? { start: now, count: 0 };
    if (now - budget.start > 10_000) Object.assign(budget, { start: now, count: 0 });
    budget.count++;
    this.budgets.set(ws, budget);
    if (budget.count > MESSAGE_BUDGET) return ws.close(4008, 'too_chatty');
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { t: 'error', code: 'bad_json' });
    }
    this.sql.exec('UPDATE devices SET last_seen = ? WHERE id = ?', Date.now(), me);

    switch (msg.t) {
      case 'announce': {
        if (!ID.test(msg.id) || typeof msg.env !== 'string' || msg.env.length > MAX_ENV) return send(ws, { t: 'error', code: 'bad_drop', id: msg.id });
        if (this.sql.exec('SELECT 1 FROM drops WHERE id = ?', msg.id).toArray().length) return send(ws, { t: 'error', code: 'dup', id: msg.id });
        const allowance = await this.env.QUOTA.get(this.env.QUOTA.idFromName('relay')).take('meta', msg.env.length, DAILY_INLINE_BYTES);
        if (!allowance.ok) return send(ws, { t: 'error', code: 'daily_limit', id: msg.id });
        const everyone = this.sql.exec<{ id: string }>('SELECT id FROM devices WHERE id != ?', me).toArray().map((r) => r.id);
        const to = Array.isArray(msg.to) && msg.to.length ? everyone.filter((d) => msg.to!.includes(d)) : everyone;
        const chunks = Math.max(0, Math.floor(Number(msg.chunks) || 0));
        const row: DropRow = {
          id: msg.id,
          sender: me,
          env: msg.env,
          size: Math.max(0, Number(msg.size) || 0),
          chunks,
          ready: chunks === 0 ? 1 : 0,
          created: Date.now(),
        };
        this.sql.exec(
          'INSERT INTO drops (id, sender, env, size, chunks, ready, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
          row.id, row.sender, row.env, row.size, row.chunks, row.ready, row.created,
        );
        for (const d of to) this.sql.exec('INSERT INTO deliveries (drop_id, device) VALUES (?, ?)', row.id, d);
        let online = 0;
        for (const d of to) {
          const sockets = this.ctx.getWebSockets(d);
          if (sockets.length) online++;
          for (const s of sockets) send(s, announceOf(row));
        }
        send(ws, { t: 'sent', id: row.id, recipients: to.length, online });
        if (!to.length) await this.dropDrop(row.id, row.chunks);
        await this.ensureAlarm();
        return;
      }

      case 'progress': {
        const p = Math.min(1, Math.max(0, Number(msg.p) || 0));
        // c = index of a chunk that just landed, so receivers can stream it right away
        const c = Number.isInteger(msg.c) && (msg.c as number) >= 0 ? msg.c : undefined;
        this.toRecipients(msg.id, me, c === undefined ? { t: 'progress', id: msg.id, p } : { t: 'progress', id: msg.id, p, c });
        return;
      }

      case 'ready': {
        this.sql.exec('UPDATE drops SET ready = 1 WHERE id = ? AND sender = ?', msg.id, me);
        this.toRecipients(msg.id, me, { t: 'ready', id: msg.id });
        return;
      }

      case 'cancel': {
        const mine = this.sql.exec<DropRow>('SELECT * FROM drops WHERE id = ? AND sender = ?', msg.id, me).toArray()[0];
        if (!mine) return;
        this.toRecipients(msg.id, me, { t: 'cancel', id: msg.id });
        await this.dropDrop(msg.id, mine.chunks);
        return;
      }

      case 'ack': {
        this.sql.exec('UPDATE deliveries SET acked = 1 WHERE drop_id = ? AND device = ?', msg.id, me);
        const drop = this.sql.exec<DropRow>('SELECT * FROM drops WHERE id = ?', msg.id).toArray()[0];
        if (!drop) return;
        for (const s of this.ctx.getWebSockets(drop.sender)) send(s, { t: 'delivered', id: msg.id, by: me });
        const open = this.sql.exec('SELECT 1 FROM deliveries WHERE drop_id = ? AND acked = 0', msg.id).toArray().length;
        if (!open) await this.dropDrop(msg.id, drop.chunks);
        return;
      }

      case 'rename': {
        const name = clean(String(msg.name ?? ''), 400);
        if (!name) return;
        this.sql.exec('UPDATE devices SET name = ? WHERE id = ?', name, me);
        this.broadcast({ t: 'presence', devices: this.devices() });
        return;
      }

      case 'forget': {
        const target = String(msg.device ?? '');
        if (!ID.test(target)) return;
        this.sql.exec('DELETE FROM devices WHERE id = ?', target);
        this.sql.exec('INSERT OR IGNORE INTO forgotten (id) VALUES (?)', target);
        this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('locked', '1')");
        this.sql.exec('DELETE FROM deliveries WHERE device = ?', target);
        for (const s of this.ctx.getWebSockets(target)) {
          send(s, { t: 'forgotten' });
          s.close(4001, 'forgotten');
        }
        this.broadcast({ t: 'presence', devices: this.devices() });
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.left(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket) {
    this.left(ws);
  }

  async alarm() {
    const now = Date.now();
    const expired = this.sql
      .exec<DropRow>(
        'SELECT * FROM drops WHERE (chunks > 0 AND created < ?) OR created < ? OR (ready = 0 AND created < ?)',
        now - DAY, now - INLINE_TTL, now - STALE_UPLOAD,
      )
      .toArray();
    for (const d of expired) await this.dropDrop(d.id, d.chunks);
    await this.ensureAlarm();
  }

  private left(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    this.sql.exec('UPDATE devices SET last_seen = ? WHERE id = ?', Date.now(), att.id);
    this.broadcast({ t: 'presence', devices: this.devices(ws) }, att.id);
  }

  private locked() {
    return this.sql.exec("SELECT 1 FROM meta WHERE k = 'locked'").toArray().length > 0;
  }

  private async ensureAlarm() {
    const left = this.sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM drops').one().c;
    if (!left) return this.ctx.storage.deleteAlarm();
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }

  private async dropDrop(id: string, chunks: number) {
    this.sql.exec('DELETE FROM deliveries WHERE drop_id = ?', id);
    this.sql.exec('DELETE FROM drops WHERE id = ?', id);
    const room = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'room'").toArray()[0]?.v;
    if (chunks > 0 && room) await deleteChunks(this.env.BLOBS, `r/${room}/${id}/`, chunks);
  }

  private toRecipients(dropId: string, sender: string, msg: object) {
    const rows = this.sql
      .exec<{ device: string }>(
        'SELECT v.device FROM deliveries v JOIN drops d ON d.id = v.drop_id WHERE v.drop_id = ? AND d.sender = ?',
        dropId, sender,
      )
      .toArray();
    for (const r of rows) for (const s of this.ctx.getWebSockets(r.device)) send(s, msg);
  }

  private broadcast(msg: object, except?: string) {
    for (const s of this.ctx.getWebSockets()) {
      const att = s.deserializeAttachment() as Attachment | null;
      if (att && att.id !== except) send(s, msg);
    }
  }

  private device(id: string) {
    const r = this.sql.exec<DeviceRow>('SELECT * FROM devices WHERE id = ?', id).toArray()[0];
    return r && { id: r.id, name: r.name, platform: r.platform, online: true, lastSeen: r.last_seen };
  }

  private devices(closing?: WebSocket) {
    return this.sql
      .exec<DeviceRow>('SELECT * FROM devices ORDER BY first_seen')
      .toArray()
      .map((r) => ({
        id: r.id,
        name: r.name,
        platform: r.platform,
        online: this.ctx.getWebSockets(r.id).some((s) => s !== closing && s.readyState === 1),
        lastSeen: r.last_seen,
      }));
  }
}

function announceOf(d: DropRow) {
  return { t: 'announce', id: d.id, from: d.sender, env: d.env, size: d.size, chunks: d.chunks, ready: !!d.ready, at: d.created };
}

function send(ws: WebSocket, msg: object) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket already gone; presence will catch up
  }
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function clean(s: string, max: number) {
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
