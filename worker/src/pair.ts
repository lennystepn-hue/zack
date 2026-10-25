import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { json } from './util';

const TTL = 10 * 60 * 1000;
const MAX_ENVELOPE = 8 * 1024;

// One instance per pairing slot. The slot name is a slow hash of the code the
// user reads off one screen and types on the other; the envelope inside is
// encrypted with a different derivation of the same code.
export class PairSlot extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const store = this.ctx.storage;

    if (req.method === 'POST') {
      if (await store.get('envelope')) return json({ error: 'taken' }, 409);
      const body = (await req.json().catch(() => null)) as { envelope?: unknown } | null;
      const envelope = body?.envelope;
      if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE) return json({ error: 'bad_envelope' }, 400);
      const expires = Date.now() + TTL;
      await store.put({ envelope, expires });
      await store.setAlarm(expires);
      return json({ expires }, 201);
    }

    if (req.method === 'GET') {
      const envelope = await store.get<string>('envelope');
      const expires = (await store.get<number>('expires')) ?? 0;
      if (!envelope || expires < Date.now()) return json({ error: 'not_found' }, 404);
      await store.deleteAll();
      await store.deleteAlarm();
      return json({ envelope });
    }

    if (req.method === 'DELETE') {
      await store.deleteAll();
      await store.deleteAlarm();
      return new Response(null, { status: 204 });
    }

    return json({ error: 'method' }, 405);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
