import { app, nativeImage } from 'electron';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readlink, rm, stat, symlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import type { ItemKind } from '../shared/types';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.avif']);
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const SKIP = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export function kindOf(path: string): ItemKind {
  return IMAGE_EXT.has(extname(path).toLowerCase()) ? 'image' : 'file';
}

export function mimeOf(path: string) {
  const ext = extname(path).toLowerCase().slice(1);
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', mp4: 'video/mp4',
    mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', json: 'application/json', svg: 'image/svg+xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** A name from another machine is untrusted: no paths, no device names, nothing Windows would choke on. */
export function safeName(name: string, fallback = 'file') {
  let n = name.replace(/\\/g, '/').split('/').pop() ?? '';
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!n) n = fallback;
  if (RESERVED.test(n)) n = `_${n}`;
  if (n.length > 180) {
    const ext = extname(n).slice(0, 16);
    n = n.slice(0, 180 - ext.length) + ext;
  }
  return n;
}

export async function uniquePath(dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    try {
      await lstat(candidate);
    } catch {
      return candidate;
    }
  }
  return join(dir, `${stem} ${Date.now()}${ext}`);
}

// already-compressed formats gain nothing from deflate and just cost time
const STORED = /\.(zip|gz|xz|7z|rar|dmg|iso|jpe?g|png|gif|webp|heic|avif|mp4|mov|mkv|webm|mp3|m4a|aac|ogg|flac|pdf|woff2?|asar|car|nib)$/i;

interface Entry {
  abs: string;
  name: string;
  kind: 'file' | 'link' | 'dir';
  size: number;
  mode: number;
}

/**
 * Packs a folder (or an app bundle) into a zip at `out`. Keeps permissions and
 * symlinks, so a .app still runs on the other side; never hangs on a bad file.
 */
export async function zipFolder(dir: string, out: string, onProgress?: (p: number) => void) {
  const root = basename(dir);
  const entries: Entry[] = [];
  const walk = async (abs: string, rel: string) => {
    const list = await readdir(abs, { withFileTypes: true });
    if (!list.length) entries.push({ abs, name: rel, kind: 'dir', size: 0, mode: 0o755 });
    for (const e of list) {
      if (SKIP.has(e.name)) continue;
      const child = join(abs, e.name);
      const name = posix.join(rel, e.name);
      const st = await lstat(child).catch(() => null);
      if (!st) continue;
      if (st.isSymbolicLink()) entries.push({ abs: child, name, kind: 'link', size: 0, mode: st.mode });
      else if (st.isDirectory()) await walk(child, name);
      else if (st.isFile()) entries.push({ abs: child, name, kind: 'file', size: st.size, mode: st.mode });
    }
  };
  await walk(dir, root);

  const total = entries.reduce((n, e) => n + e.size, 0) || 1;
  const zip = new yazl.ZipFile();
  const failed = new Promise<never>((_, reject) => zip.on('error', reject));
  for (const e of entries) {
    if (e.kind === 'dir') zip.addEmptyDirectory(e.name);
    else if (e.kind === 'link') {
      const target = await readlink(e.abs).catch(() => null);
      if (target !== null) zip.addBuffer(Buffer.from(target), e.name, { mode: 0o120755, compress: false });
    } else {
      zip.addFile(e.abs, e.name, { mode: e.mode, compress: e.size < 4 * 1024 * 1024 && !STORED.test(e.name) });
    }
  }
  zip.end();
  let written = 0;
  zip.outputStream.on('data', (chunk: Buffer) => {
    written += chunk.length;
    onProgress?.(Math.min(1, written / total));
  });
  await Promise.race([pipeline(zip.outputStream, createWriteStream(out)), failed]);
  return entries.length;
}

/** Extracts into a fresh folder under `parent`; entries that try to climb out are dropped. */
export async function unzipInto(zipPath: string, parent: string, wanted: string) {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (err, z) => (err || !z ? rej(err) : res(z))),
  );
  const target = await uniquePath(parent, safeName(wanted, 'Folder'));
  await mkdir(target, { recursive: true });
  // links are made last, so nothing ever gets written through one
  const links: { dest: string; to: string }[] = [];
  const inside = (p: string) => p === target || p.startsWith(target + sep);

  await new Promise<void>((done, fail) => {
    zip.on('error', fail);
    zip.on('end', () => done());
    zip.on('entry', async (entry: yauzl.Entry) => {
      try {
        const parts = entry.fileName.split('/').filter(Boolean);
        // the archive wraps everything in one top folder; we already made our own
        const inner = parts.length > 1 ? parts.slice(1) : parts;
        const dest = resolve(target, ...inner.map((p) => safeName(p, '_')));
        if (!inside(dest)) return zip.readEntry();
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if (entry.fileName.endsWith('/')) {
          await mkdir(dest, { recursive: true });
          return zip.readEntry();
        }
        await mkdir(dirname(dest), { recursive: true });
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) =>
          zip.openReadStream(entry, (err, s) => (err || !s ? rej(err) : res(s))),
        );
        if ((mode & 0o170000) === 0o120000) {
          const chunks: Buffer[] = [];
          for await (const c of stream) chunks.push(c as Buffer);
          links.push({ dest, to: Buffer.concat(chunks).toString('utf8') });
          return zip.readEntry();
        }
        await pipeline(stream, createWriteStream(dest));
        // keep the executable bit (an app's binary needs it), never setuid and friends
        if (mode & 0o111 && process.platform !== 'win32') await chmod(dest, mode & 0o755);
        zip.readEntry();
      } catch (err) {
        fail(err);
      }
    });
    zip.readEntry();
  });
  zip.close();

  if (process.platform !== 'win32') {
    for (const l of links) {
      if (isAbsolute(l.to) || !inside(resolve(dirname(l.dest), l.to))) continue;
      await symlink(l.to, l.dest).catch(() => {});
    }
  }
  await rm(zipPath, { force: true });
  return target;
}

/** A small preview for the trip: QuickLook / Explorer thumbnails where they exist, the file icon otherwise. */
export async function thumbnailFor(path: string, kind: ItemKind): Promise<string | undefined> {
  const size = { width: 160, height: 160 };
  try {
    if (process.platform !== 'linux') {
      const t = await nativeImage.createThumbnailFromPath(path, size);
      if (!t.isEmpty()) return shrink(t, path);
    }
    if (kind === 'image') {
      const img = nativeImage.createFromPath(path);
      if (!img.isEmpty()) return shrink(img, path);
    }
  } catch {
    // no preview for this one
  }
  try {
    const icon = await app.getFileIcon(path, { size: 'large' });
    if (!icon.isEmpty()) return icon.toDataURL();
  } catch {
    // nothing to show
  }
  return undefined;
}

function shrink(img: Electron.NativeImage, path: string) {
  const { width, height } = img.getSize();
  const scale = Math.min(1, 160 / Math.max(width, height));
  const small = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img;
  // keep alpha for formats that usually have it
  if (/\.(png|gif|webp|avif)$/i.test(path)) return small.toDataURL();
  return `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}`;
}

export async function isDir(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
