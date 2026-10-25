// Every item that travels gets a physical little object: a photo print, a
// sheet of paper, a folder. The themes throw these around; they never see
// file types.

import type { ItemKind } from '../../../shared/types';

export interface Sprite {
  canvas: HTMLCanvasElement;
  kind: ItemKind;
  /** cached low-res version for the pixel theme */
  pixel?: HTMLCanvasElement;
  dataUrl?: string;
}

export interface SpriteSource {
  kind: ItemKind;
  name: string;
  text?: string;
  thumb?: string | ImageBitmap | HTMLImageElement | null;
}

const S = 128;

const FAMILY: { test: RegExp; color: string }[] = [
  { test: /^(pdf)$/, color: '#e5484d' },
  { test: /^(docx?|pages|rtf|odt|txt|md)$/, color: '#3e7bfa' },
  { test: /^(xlsx?|numbers|csv|ods)$/, color: '#2e9e5b' },
  { test: /^(pptx?|key|odp)$/, color: '#f26b1d' },
  { test: /^(mp4|mov|mkv|webm|avi|m4v)$/, color: '#d6409f' },
  { test: /^(mp3|wav|aiff?|flac|m4a|ogg)$/, color: '#0e9f8e' },
  { test: /^(zip|rar|7z|tar|gz|dmg|iso)$/, color: '#a07042' },
  { test: /^(js|ts|tsx|py|rs|go|swift|json|html|css|sh|c|cpp|java|kt)$/, color: '#5b6b8c' },
  { test: /^(psd|ai|fig|sketch|svg|blend|xd)$/, color: '#c2410c' },
];

function canvas(size = S) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

export function extOf(name: string) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

async function loadImage(src: SpriteSource['thumb']): Promise<CanvasImageSource | null> {
  if (!src) return null;
  if (typeof src !== 'string') return src;
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

export async function makeSprite(src: SpriteSource): Promise<Sprite> {
  const c = canvas();
  const g = c.getContext('2d')!;
  const img = await loadImage(src.thumb);
  if (src.kind === 'image' && img) photo(g, img);
  else if (src.kind === 'folder') folder(g, src.name);
  else if (src.kind === 'text') note(g, src.text ?? src.name);
  else if (src.kind === 'link') link(g, src.text ?? src.name);
  else if (img) preview(g, img, src.name);
  else paper(g, src.name);
  return { canvas: c, kind: src.kind };
}

function size(img: CanvasImageSource) {
  const w = (img as HTMLImageElement).naturalWidth || (img as ImageBitmap).width || 1;
  const h = (img as HTMLImageElement).naturalHeight || (img as ImageBitmap).height || 1;
  return { w, h };
}

/** a print with a white border, tilted a hair */
function photo(g: CanvasRenderingContext2D, img: CanvasImageSource) {
  const { w, h } = size(img);
  const max = 104;
  const k = Math.min(max / w, max / h);
  const iw = Math.max(40, w * k);
  const ih = Math.max(40, h * k);
  const b = 5;
  const x = (S - iw) / 2;
  const y = (S - ih) / 2;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  g.fillStyle = '#f7f5f0';
  rr(g, x - b, y - b, iw + b * 2, ih + b * 2, 4);
  g.fill();
  g.restore();
  g.save();
  rr(g, x, y, iw, ih, 2);
  g.clip();
  const cover = Math.max(iw / w, ih / h);
  g.drawImage(img, x + (iw - w * cover) / 2, y + (ih - h * cover) / 2, w * cover, h * cover);
  g.restore();
}

function sheet(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const fold = 20;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.4)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  g.fillStyle = '#f4f1ea';
  g.beginPath();
  g.moveTo(x + 5, y);
  g.lineTo(x + w - fold, y);
  g.lineTo(x + w, y + fold);
  g.lineTo(x + w, y + h - 5);
  g.quadraticCurveTo(x + w, y + h, x + w - 5, y + h);
  g.lineTo(x + 5, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - 5);
  g.lineTo(x, y + 5);
  g.quadraticCurveTo(x, y, x + 5, y);
  g.fill();
  g.restore();
  // dog-ear
  g.fillStyle = '#d9d3c7';
  g.beginPath();
  g.moveTo(x + w - fold, y);
  g.lineTo(x + w - fold, y + fold - 4);
  g.quadraticCurveTo(x + w - fold, y + fold, x + w - fold + 4, y + fold);
  g.lineTo(x + w, y + fold);
  g.closePath();
  g.fill();
}

function paper(g: CanvasRenderingContext2D, name: string) {
  const w = 84;
  const h = 106;
  const x = (S - w) / 2;
  const y = (S - h) / 2;
  sheet(g, x, y, w, h);
  const ext = extOf(name);
  const color = FAMILY.find((f) => f.test.test(ext))?.color ?? '#6b6f7a';
  g.fillStyle = '#c9c3b6';
  for (let i = 0; i < 4; i++) g.fillRect(x + 12, y + 18 + i * 9, (i === 3 ? 30 : 52) - (i % 2) * 6, 3);
  g.fillStyle = color;
  rr(g, x + 10, y + h - 40, w - 20, 28, 5);
  g.fill();
  const label = (ext || 'file').toUpperCase().slice(0, 5);
  g.fillStyle = '#fff';
  g.font = `700 ${label.length > 3 ? 13 : 16}px "JetBrains Mono", ui-monospace, monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, S / 2, y + h - 26);
}

function preview(g: CanvasRenderingContext2D, img: CanvasImageSource, name: string) {
  const w = 88;
  const h = 108;
  const x = (S - w) / 2;
  const y = (S - h) / 2;
  sheet(g, x, y, w, h);
  g.save();
  rr(g, x + 6, y + 6, w - 12, h - 12, 3);
  g.clip();
  const { w: iw, h: ih } = size(img);
  const k = Math.min((w - 12) / iw, (h - 12) / ih);
  g.drawImage(img, x + 6 + (w - 12 - iw * k) / 2, y + 6 + (h - 12 - ih * k) / 2, iw * k, ih * k);
  g.restore();
  const ext = extOf(name);
  if (ext) {
    const color = FAMILY.find((f) => f.test.test(ext))?.color ?? '#6b6f7a';
    g.fillStyle = color;
    rr(g, x + w - 38, y + h - 22, 34, 16, 4);
    g.fill();
    g.fillStyle = '#fff';
    g.font = '700 10px "JetBrains Mono", ui-monospace, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(ext.toUpperCase().slice(0, 4), x + w - 21, y + h - 14);
  }
}

function folder(g: CanvasRenderingContext2D, name: string) {
  const w = 108;
  const h = 82;
  const x = (S - w) / 2;
  const y = (S - h) / 2 + 4;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.4)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  g.fillStyle = '#d99a26';
  rr(g, x, y - 10, 44, 20, 5);
  g.fill();
  rr(g, x, y, w, h, 7);
  g.fill();
  g.restore();
  g.fillStyle = '#f7f0e2';
  rr(g, x + 6, y + 4, w - 12, 20, 3);
  g.fill();
  const grad = g.createLinearGradient(0, y + 12, 0, y + h);
  grad.addColorStop(0, '#f8c55a');
  grad.addColorStop(1, '#eaa93a');
  g.fillStyle = grad;
  rr(g, x, y + 12, w, h - 12, 7);
  g.fill();
  g.fillStyle = 'rgba(80,45,0,0.55)';
  g.font = '600 11px -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const label = name.length > 14 ? `${name.slice(0, 13)}…` : name;
  g.fillText(label, S / 2, y + h / 2 + 10);
}

function wrap(g: CanvasRenderingContext2D, text: string, width: number, lines: number) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > width && line) {
      out.push(line);
      line = w;
      if (out.length === lines) break;
    } else line = test;
  }
  if (out.length < lines && line) out.push(line);
  if (out.length === lines && words.join(' ').length > out.join(' ').length) out[lines - 1] = `${out[lines - 1].replace(/.$/, '')}…`;
  return out;
}

function note(g: CanvasRenderingContext2D, text: string) {
  const w = 96;
  const h = 100;
  const x = (S - w) / 2;
  const y = (S - h) / 2;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.4)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  g.fillStyle = '#fbf8f1';
  rr(g, x, y, w, h, 4);
  g.fill();
  g.restore();
  g.strokeStyle = 'rgba(62,123,250,0.18)';
  g.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    g.beginPath();
    g.moveTo(x + 6, y + 22 + i * 11.5);
    g.lineTo(x + w - 6, y + 22 + i * 11.5);
    g.stroke();
  }
  g.fillStyle = '#2a2722';
  g.font = '500 10px -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  wrap(g, text, w - 16, 7).forEach((l, i) => g.fillText(l, x + 8, y + 20 + i * 11.5));
}

function link(g: CanvasRenderingContext2D, url: string) {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // keep the raw text
  }
  const w = 108;
  const h = 70;
  const x = (S - w) / 2;
  const y = (S - h) / 2;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.4)';
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  g.fillStyle = '#f4f1ea';
  rr(g, x, y, w, h, 10);
  g.fill();
  g.restore();
  // a chain link, two rounded capsules
  g.strokeStyle = '#3e7bfa';
  g.lineWidth = 4;
  g.lineCap = 'round';
  g.save();
  g.translate(S / 2, y + 24);
  g.rotate(-Math.PI / 4);
  rr(g, -15, -6, 18, 12, 6);
  g.stroke();
  rr(g, -3, -6, 18, 12, 6);
  g.stroke();
  g.restore();
  g.fillStyle = '#2a2722';
  g.font = '600 11px -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const label = host.length > 18 ? `${host.slice(0, 17)}…` : host;
  g.fillText(label, S / 2, y + h - 17);
}

/** 20×20 sprite with a 16-colour palette and a dark outline, for the pixel theme */
export function pixelate(sprite: Sprite, palette: number[][]) {
  if (sprite.pixel) return sprite.pixel;
  const N = 18;
  const small = canvas(N);
  const sg = small.getContext('2d', { willReadFrequently: true })!;
  sg.imageSmoothingEnabled = true;
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(sprite.canvas, 6, 6, S - 12, S - 12, 0, 0, N, N);
  const data = sg.getImageData(0, 0, N, N);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 110) {
      d[i + 3] = 0;
      continue;
    }
    let best = palette[0];
    let bd = Infinity;
    for (const p of palette) {
      const dist = (p[0] - d[i]) ** 2 * 0.3 + (p[1] - d[i + 1]) ** 2 * 0.59 + (p[2] - d[i + 2]) ** 2 * 0.11;
      if (dist < bd) {
        bd = dist;
        best = p;
      }
    }
    d[i] = best[0];
    d[i + 1] = best[1];
    d[i + 2] = best[2];
    d[i + 3] = 255;
  }
  const out = canvas(N + 2);
  const og = out.getContext('2d')!;
  const outline = og.createImageData(N + 2, N + 2);
  const o = outline.data;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= N || y >= N ? 0 : d[(y * N + x) * 4 + 3]);
  for (let y = -1; y <= N; y++)
    for (let x = -1; x <= N; x++) {
      const k = ((y + 1) * (N + 2) + (x + 1)) * 4;
      if (at(x, y)) {
        const s = (y * N + x) * 4;
        o[k] = d[s];
        o[k + 1] = d[s + 1];
        o[k + 2] = d[s + 2];
        o[k + 3] = 255;
      } else if (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1)) {
        o[k] = 16;
        o[k + 1] = 18;
        o[k + 2] = 28;
        o[k + 3] = 255;
      }
    }
  og.putImageData(outline, 0, 0);
  sprite.pixel = out;
  return out;
}

export function spriteThumb(sprite: Sprite) {
  if (!sprite.dataUrl) sprite.dataUrl = sprite.canvas.toDataURL();
  return sprite.dataUrl;
}

const tintCanvas = document.createElement('canvas');

/** The sprite washed with a colour (toast browning, mercury silvering, redshift). Valid until the next call. */
export function tinted(src: HTMLCanvasElement, amount: number, rgb: number[]) {
  if (amount < 0.02) return src;
  const t = tintCanvas;
  if (t.width !== src.width) {
    t.width = src.width;
    t.height = src.height;
  }
  const g = t.getContext('2d')!;
  g.globalCompositeOperation = 'copy';
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(1, amount)})`;
  g.fillRect(0, 0, t.width, t.height);
  g.globalCompositeOperation = 'source-over';
  return t;
}
