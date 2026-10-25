// Electron's clipboard is async and W3C-shaped now: a list of items, each a
// bag of MIME types. Files copied in Finder / Explorer only show up as raw
// platform formats, so we look for those by name.

import { clipboard, ClipboardItem, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ClipboardContents {
  files: string[];
  text: string;
  image: Buffer | null;
}

const FILE_FORMAT = /public\.file-url|FileNameW|text\/uri-list|gnome-copied-files|NSFilenamesPboardType/i;

export async function readClipboard(): Promise<ClipboardContents> {
  const out: ClipboardContents = { files: [], text: '', image: null };
  let items: Electron.ClipboardItem[] = [];
  try {
    items = await clipboard.read();
  } catch {
    return out;
  }
  for (const item of items) {
    for (const type of item.types) {
      try {
        if (FILE_FORMAT.test(type)) {
          const blob = (await item.getType(type)) as Blob;
          out.files.push(...parseFiles(type, Buffer.from(await blob.arrayBuffer())));
        } else if (type === 'text/plain' && !out.text) {
          out.text = await ((await item.getType(type)) as Blob).text();
        } else if ((type === 'image/png' || type === 'image/jpeg' || type === 'image/tiff') && !out.image) {
          const raw = Buffer.from(await ((await item.getType(type)) as Blob).arrayBuffer());
          out.image = type === 'image/png' ? raw : nativeImage.createFromBuffer(raw).toPNG();
        }
      } catch {
        // a format that disappeared between listing and reading
      }
    }
  }
  out.files = [...new Set(out.files)].filter((p) => existsSync(p));
  return out;
}

function parseFiles(type: string, raw: Buffer): string[] {
  if (/FileNameW/i.test(type)) return [raw.toString('ucs2').replace(/\0+$/, '')];
  const text = raw.toString('utf8');
  if (/NSFilenamesPboardType/i.test(type)) return [...text.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => decodeXml(m[1]));
  return text
    .split(/\r?\n|\0/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('file://'))
    .map((l) => {
      try {
        return fileURLToPath(l);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

function decodeXml(s: string) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function copyText(text: string) {
  return clipboard.writeText(text).catch(() => {});
}

/** Puts an image file on the clipboard as PNG; resolves false if it couldn't be decoded. */
export async function copyImageFile(path: string) {
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return false;
  const png = img.toPNG();
  try {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
    return true;
  } catch {
    return false;
  }
}
