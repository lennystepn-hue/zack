import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

// One instance for the whole relay: counts uploaded bytes per UTC day, so the
// bill has a ceiling no matter how many people find the URL.
export class Quota extends DurableObject<Env> {
  async reserve(bytes: number, limit: number): Promise<{ ok: boolean; used: number }> {
    const day = new Date().toISOString().slice(0, 10);
    const saved = await this.ctx.storage.get<{ day: string; used: number }>('quota');
    const used = saved?.day === day ? saved.used : 0;
    if (used + bytes > limit) return { ok: false, used };
    await this.ctx.storage.put('quota', { day, used: used + bytes });
    return { ok: true, used: used + bytes };
  }
}
