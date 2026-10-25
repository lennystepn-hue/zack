// Tray icons, drawn with signed distances and written as PNG by hand, so the
// repo needs no image tooling. The app icon is rendered from the real shader
// by scripts/render-icon.mjs.
//   node scripts/make-icons.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const out = join(import.meta.dirname, '..', 'resources');
mkdirSync(out, { recursive: true });

function crc32(buf: Buffer) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(w: number, h: number, rgba: Uint8Array) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

type Shade = (x: number, y: number) => [number, number, number, number];

/** 4×4 supersampling per pixel; coordinates are in a 0..1 square */
function render(size: number, shade: Shade) {
  const px = new Uint8Array(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < ss; j++)
        for (let i = 0; i < ss; i++) {
          const [cr, cg, cb, ca] = shade((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      const k = (y * size + x) * 4;
      const n = ss * ss;
      px[k + 3] = Math.round((a / n) * 255);
      if (a > 0) {
        px[k] = Math.round(r / a);
        px[k + 1] = Math.round(g / a);
        px[k + 2] = Math.round(b / a);
      }
    }
  return px;
}

// the mark: a ring with an off-centre core, like looking into a tunnel
const mark = (x: number, y: number, ink: [number, number, number], ring = 0.385, width = 0.1): [number, number, number, number] => {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const d = Math.hypot(dx, dy);
  const onRing = Math.abs(d - ring) < width / 2;
  const core = Math.hypot(dx + 0.035, dy + 0.035) < 0.15;
  return onRing || core ? [...ink, 1] : [0, 0, 0, 0];
};

for (const [name, size] of [['trayTemplate.png', 18], ['trayTemplate@2x.png', 36]] as const) {
  writeFileSync(join(out, name), png(size, size, render(size, (x, y) => mark(x, y, [0, 0, 0], 0.37, 0.12))));
}

// Windows and Linux trays have no template images: amber ring on a dark coin
writeFileSync(
  join(out, 'tray.png'),
  png(
    32,
    32,
    render(32, (x, y) => {
      const d = Math.hypot(x - 0.5, y - 0.5);
      if (d > 0.48) return [0, 0, 0, 0];
      const m = mark(x, y, [255, 179, 92], 0.33, 0.1);
      return m[3] ? m : [22, 17, 13, 1];
    }),
  ),
);

console.log('tray icons written to', out);
