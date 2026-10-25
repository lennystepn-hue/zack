import type { ThemeId } from '../../../shared/types';
import type { Theme } from './base';
import { Liquid } from './liquid';
import { Monster } from './monster';
import { Rift } from './rift';
import { Singularity } from './singularity';
import { Toaster } from './toaster';
import { Warp } from './warp';

export type { Theme } from './base';
export type { Layout, Mood, Point, Dock } from './base';

export const THEMES: { id: ThemeId; name: string; tagline: { de: string; en: string } }[] = [
  { id: 'singularity', name: 'Singularity', tagline: { de: 'Ein schwarzes Loch, echt geraytraced', en: 'A black hole, actually ray-traced' } },
  { id: 'warp', name: 'Warp Pipe', tagline: { de: 'Rein in die Röhre, raus auf dem anderen PC', en: 'Down the pipe, up on the other machine' } },
  { id: 'rift', name: 'Rift', tagline: { de: 'Ein Riss aus glühenden Funken', en: 'A tear in the air, edged in sparks' } },
  { id: 'toaster', name: 'Toaster', tagline: { de: 'Rein in den Schlitz, drüben ploppt der Toast', en: 'Into the slot, out pops the toast' } },
  { id: 'liquid', name: 'Liquid Metal', tagline: { de: 'Versinkt im Quecksilber, steigt drüben auf', en: 'Sinks into mercury, rises over there' } },
  { id: 'monster', name: 'Monster', tagline: { de: 'Frisst deine Dateien, spuckt sie drüben aus', en: 'Eats your files, coughs them up over there' } },
];

export function createTheme(id: ThemeId): Theme {
  if (id === 'warp') return new Warp();
  if (id === 'rift') return new Rift();
  if (id === 'toaster') return new Toaster();
  if (id === 'monster') return new Monster();
  try {
    // probe once so a machine without WebGL2 still gets a portal
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) return new Rift();
    probe.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    return new Rift();
  }
  return id === 'liquid' ? new Liquid() : new Singularity();
}

/** Drives a theme from requestAnimationFrame, dropping to ~30fps while nothing happens. */
export class Loop {
  private theme: Theme | null = null;
  private last = 0;
  private skip = false;
  private raf = 0;
  private hidden = false;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      if (!this.hidden) this.kick();
    });
  }

  set(theme: Theme | null) {
    this.theme = theme;
    this.kick();
  }

  kick() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.hidden || !this.theme) return;
    const busy = this.theme.busy();
    this.skip = !busy && !this.skip;
    if (busy || !this.skip) {
      this.theme.tick(now, Math.min(busy ? 0.05 : 0.1, (now - this.last) / 1000));
      this.last = now;
    }
    this.raf = requestAnimationFrame(this.frame);
  };
}
