import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

// One instance for the whole relay: daily budgets per UTC day, so the bill
// has a ceiling no matter how many people find the URL.
//   up:   bytes uploaded, each chunk charged at least MIN_CHARGE, which also
//         caps the number of R2 writes (1 M a month are free)
//   down: chunk downloads, i.e. R2 reads (10 M a month are free)
//   meta: bytes of small drops kept in Durable Object storage
const MIN_CHARGE = 512 * 1024;

export class Quota extends DurableObject<Env> {
  async take(kind: 'up' | 'down' | 'meta', amount: number, limit: number): Promise<{ ok: boolean; used: number }> {
    const day = new Date().toISOString().slice(0, 10);
    const cost = kind === 'up' ? Math.max(amount, MIN_CHARGE) : amount;
    const saved = await this.ctx.storage.get<{ day: string; used: number }>(kind);
    const used = saved?.day === day ? saved.used : 0;
    if (used + cost > limit) return { ok: false, used };
    await this.ctx.storage.put(kind, { day, used: used + cost });
    return { ok: true, used: used + cost };
  }
}
