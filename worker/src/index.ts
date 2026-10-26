// zack. relay — a Worker that never sees plaintext.
// Devices encrypt everything client-side; this only routes envelopes,
// stores ciphertext chunks in R2 for a day, and keeps presence per room.

import { Room } from './room';
import { PairSlot } from './pair';
import { Quota } from './quota';
import { b64url, hmac, json, safeEqual } from './util';

export { Room, PairSlot, Quota };

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  PAIRS: DurableObjectNamespace<PairSlot>;
  QUOTA: DurableObjectNamespace<Quota>;
  DAILY_UPLOAD_GB: string;
  DAILY_DOWNLOADS: string;
  BLOBS: R2Bucket;
  PAIR_LIMIT: RateLimit;
  CREATE_LIMIT: RateLimit;
  UPLOAD_LIMIT: RateLimit;
  ROOM_SECRET: string;
}

async function limited(limiter: RateLimit, req: Request) {
  // an IPv6 user owns a whole /64: count it as one address
  const raw = req.headers.get('cf-connecting-ip') ?? 'local';
  const ip = raw.includes(':') ? raw.split(':').slice(0, 4).join(':') : raw;
  const { success } = await limiter.limit({ key: ip });
  return !success;
}

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_CHUNK = 17 * 1024 * 1024; // 16 MiB plaintext + GCM tag, with headroom
const MAX_CHUNKS = 16384;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
};

async function roomToken(env: Env, roomId: string) {
  return b64url(await hmac(env.ROOM_SECRET, `room:${roomId}`));
}

async function authorized(env: Env, roomId: string, presented: string | null) {
  if (!presented) return false;
  return safeEqual(presented, await roomToken(env, roomId));
}

function bearer(req: Request) {
  const h = req.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

// Browsers and Node can't set headers on a WebSocket handshake, so the room
// token and the device's own secret ride in the subprotocol list:
// ["zack.v1", "auth.<room token>", "dev.<device secret>"].
function wsProto(req: Request, prefix: string) {
  const protos = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim());
  const hit = protos.find((p) => p.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (parts.length === 0) return json({ name: 'zack', ok: true, v: 1 });
      if (parts[0] !== 'v1') return json({ error: 'not_found' }, 404);

      // POST /v1/rooms → a fresh room id and its capability token
      if (parts[1] === 'rooms' && parts.length === 2 && req.method === 'POST') {
        if (await limited(env.CREATE_LIMIT, req)) return json({ error: 'slow_down' }, 429);
        const roomId = b64url(crypto.getRandomValues(new Uint8Array(16)));
        return json({ roomId, token: await roomToken(env, roomId) }, 201);
      }

      // /v1/pair/:slot — a one-shot, ten-minute mailbox for the pairing envelope
      if (parts[1] === 'pair' && parts.length === 3) {
        const slot = parts[2];
        if (!ID.test(slot)) return json({ error: 'bad_slot' }, 400);
        if (await limited(env.PAIR_LIMIT, req)) return json({ error: 'slow_down' }, 429);
        const stub = env.PAIRS.get(env.PAIRS.idFromName(slot));
        return stub.fetch(req);
      }

      if (parts[1] === 'rooms' && parts.length >= 4) {
        const roomId = parts[2];
        if (!ID.test(roomId)) return json({ error: 'bad_room' }, 400);
        const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));

        // GET /v1/rooms/:room/ws
        if (parts[3] === 'ws') {
          if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'expected_websocket' }, 426);
          if (!(await authorized(env, roomId, wsProto(req, 'auth.')))) return json({ error: 'unauthorized' }, 401);
          const fwd = new Request(req);
          fwd.headers.set('x-room', roomId);
          const secret = wsProto(req, 'dev.');
          if (secret && /^[A-Za-z0-9_-]{22,64}$/.test(secret)) fwd.headers.set('x-device-secret', secret);
          else fwd.headers.delete('x-device-secret');
          return room.fetch(fwd);
        }

        if (!(await authorized(env, roomId, bearer(req)))) return json({ error: 'unauthorized' }, 401);

        // /v1/rooms/:room/blobs/:drop[/:index]
        if (parts[3] === 'blobs') {
          const dropId = parts[4];
          if (!dropId || !ID.test(dropId)) return json({ error: 'bad_drop' }, 400);
          const prefix = `r/${roomId}/${dropId}/`;

          const index = Number(parts[5]);
          if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) return json({ error: 'bad_index' }, 400);
          const key = prefix + index;

          if (req.method !== 'PUT' && req.method !== 'GET') return json({ error: 'method' }, 405);
          // nothing goes into or out of R2 that the room didn't announce
          if (!(await room.chunkAllowed(dropId, index, req.method === 'PUT' ? 'put' : 'get'))) return json({ error: req.method === 'PUT' ? 'not_announced' : 'gone' }, req.method === 'PUT' ? 409 : 404);

          if (req.method === 'PUT') {
            // the relay is public: cap how fast any one address can fill the bucket
            if (await limited(env.UPLOAD_LIMIT, req)) return json({ error: 'slow_down' }, 429);
            const len = Number(req.headers.get('content-length') ?? NaN);
            if (!Number.isFinite(len) || len <= 0 || len > MAX_CHUNK) return json({ error: 'bad_length' }, 413);
            const limit = (Number(env.DAILY_UPLOAD_GB) || 10) * 1e9;
            const quota = await env.QUOTA.get(env.QUOTA.idFromName('relay')).take('up', len, limit);
            if (!quota.ok) return json({ error: 'daily_limit' }, 429, { 'x-zack-limit': 'daily', 'retry-after': String(secondsToMidnight()) });
            await env.BLOBS.put(key, req.body, { httpMetadata: { contentType: 'application/octet-stream' } });
            return new Response(null, { status: 201, headers: cors });
          }

          if (req.method === 'GET') {
            const reads = Number(env.DAILY_DOWNLOADS) || 300_000;
            const quota = await env.QUOTA.get(env.QUOTA.idFromName('relay')).take('down', 1, reads);
            if (!quota.ok) return json({ error: 'daily_limit' }, 429, { 'x-zack-limit': 'daily', 'retry-after': String(secondsToMidnight()) });
            const obj = await env.BLOBS.get(key);
            if (!obj) return json({ error: 'gone' }, 404);
            return new Response(obj.body, {
              headers: { ...cors, 'content-type': 'application/octet-stream', 'content-length': String(obj.size) },
            });
          }
        }
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: 'internal' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

function secondsToMidnight() {
  const now = new Date();
  return Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000);
}
