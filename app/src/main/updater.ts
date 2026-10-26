import { app, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream, existsSync } from 'node:fs';
import { access, chmod, constants, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import type { UpdateState } from '../shared/types';

// Updates come from this repository's GitHub releases and nowhere else. The
// API only says which version is the latest: the download URL and the file
// name are built here, every file has to match the release's SHA256SUMS.txt
// before anything is installed, and a version is only ever replaced by a
// newer one.
const REPO = 'lennystepn-hue/zack';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD = `https://github.com/${REPO}/releases/download`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
// a copy built against another relay would be "updated" onto this one
const OFFICIAL_RELAY = 'https://zack-portal.lennystepn.workers.dev';
const MAX_SIZE = 400 * 1024 * 1024;
const EVERY = 6 * 60 * 60 * 1000;
const BUNDLE_ID = 'services.lenny.zack';
// On a Mac an update has to carry this team's Developer ID signature as well,
// so a file swapped on the release page is refused even with a fitting checksum.
const TEAM_ID = 'UKP7WY42H3';
const SIGNED_BY_US = `=anchor apple generic and identifier "${BUNDLE_ID}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${TEAM_ID}"`;

const run = promisify(execFile);

// Node's fetch, like the relay transport. Chromium's (net.fetch) never answered
// in release builds, where its cookie store is encrypted with a keychain key.
const get = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, { headers: { 'user-agent': `Zack/${app.getVersion()}`, ...headers }, signal: AbortSignal.timeout(20_000) });

class UpdateError extends Error {
  constructor(readonly code: 'network' | 'checksum' | 'signature' | 'install') {
    super(code);
  }
}

type Version = [number, number, number];

function parse(v: string): Version | null {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function newer(a: Version, b: Version) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** .../Zack.app/Contents/MacOS/Zack → .../Zack.app */
function macBundle() {
  const bundle = join(dirname(process.execPath), '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

/** How this copy was installed decides whether it can replace itself. */
type Kind = 'mac' | 'nsis' | 'appimage';
function installKind(): Kind | null {
  if (!app.isPackaged) return null;
  if (process.platform === 'darwin') return macBundle() ? 'mac' : null;
  // the portable exe and the zip have no installer to run
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_FILE && existsSync(join(dirname(process.execPath), 'Uninstall Zack.exe')) ? 'nsis' : null;
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'appimage' : null;
  return null;
}

function assetName(kind: Kind, version: string) {
  if (kind === 'mac') return `Zack-${version}-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
  if (kind === 'nsis') return `Zack-${version}-win-setup.exe`;
  return `Zack-${version}-linux-x64.AppImage`;
}

async function writable(kind: Kind) {
  const can = (p: string) => access(p, constants.W_OK).then(() => true, () => false);
  if (kind === 'mac') {
    const bundle = macBundle()!;
    return (await can(bundle)) && (await can(dirname(bundle)));
  }
  if (kind === 'appimage') return can(dirname(process.env.APPIMAGE!));
  return true;
}

function checksum(sums: string, name: string) {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1];
  }
  return null;
}

// Waits for the old process to be gone (it holds the single-instance lock),
// swaps the app bundle with a way back if the move fails, and starts the new one.
const SWAP_MAC = `pid=$1; app=$2; new=$3; shift 3
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$app.old"
if mv "$app" "$app.old"; then
  if mv "$new" "$app"; then rm -rf "$app.old"; else mv "$app.old" "$app"; fi
fi
exec open -n "$app" --args "$@"`;

const RELAUNCH = `pid=$1; shift
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
exec "$@"`;

export class Updater extends EventEmitter {
  state: UpdateState = __ZACK_SERVER__ === OFFICIAL_RELAY ? { phase: 'idle' } : { phase: 'off' };
  private latest: { version: string; tag: string } | null = null;
  // the download sits in our own profile folder until it is installed
  private dir = join(app.getPath('userData'), 'update');

  start() {
    void rm(this.dir, { recursive: true, force: true }).catch(() => {});
    if (!app.isPackaged || this.state.phase === 'off') return;
    setTimeout(() => void this.check(false), 30_000).unref();
    setInterval(() => void this.check(false), EVERY).unref();
  }

  private set(s: UpdateState) {
    this.state = s;
    this.emit('state', s);
  }

  /** A check the user asked for shows its outcome; the periodic one only speaks up when there is something new. */
  async check(manual: boolean) {
    if (['off', 'checking', 'downloading', 'installing'].includes(this.state.phase)) return;
    if (manual) this.set({ phase: 'checking' });
    try {
      const res = await get(LATEST, { accept: 'application/vnd.github+json' });
      if (!res.ok) throw new UpdateError('network');
      const body = (await res.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: { name?: unknown }[] };
      const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
      const latest = parse(tag);
      const mine = parse(app.getVersion());
      if (!latest || !mine || body.draft || body.prerelease || !newer(latest, mine)) {
        this.latest = null;
        if (manual) this.set({ phase: 'current' });
        return;
      }
      const version = latest.join('.');
      const kind = installKind();
      const names = new Set((Array.isArray(body.assets) ? body.assets : []).map((a) => a?.name));
      const auto = !!kind && names.has(assetName(kind, version)) && names.has('SHA256SUMS.txt') && (await writable(kind));
      this.latest = { version, tag };
      this.set({ phase: 'available', version, auto });
    } catch {
      if (manual) this.set({ phase: 'error', error: 'network' });
    }
  }

  async install() {
    const latest = this.latest;
    if (!latest || this.state.phase !== 'available') return;
    // a copy that can't replace itself sends people to the download page
    if (!this.state.auto) return void shell.openExternal(RELEASES_PAGE);
    const kind = installKind()!;
    const name = assetName(kind, latest.version);
    const { version, tag } = latest;
    try {
      this.set({ phase: 'downloading', version, progress: 0 });
      await rm(this.dir, { recursive: true, force: true });
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const expected = checksum(await this.text(`${DOWNLOAD}/${tag}/SHA256SUMS.txt`), name);
      if (!expected) throw new UpdateError('checksum');
      const file = join(this.dir, name);
      const got = await this.download(`${DOWNLOAD}/${tag}/${name}`, file, (progress) => this.set({ phase: 'downloading', version, progress }));
      if (got !== expected) throw new UpdateError('checksum');
      this.set({ phase: 'installing', version });
      if (kind === 'mac') await this.installMac(file, version);
      else if (kind === 'nsis') this.installWindows(file);
      else await this.installAppImage(file);
    } catch (e) {
      this.set({ phase: 'error', error: e instanceof UpdateError ? e.code : 'install' });
      await rm(this.dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async text(url: string) {
    const res = await get(url);
    if (!res.ok) throw new UpdateError('network');
    const text = await res.text();
    if (text.length > 64 * 1024) throw new UpdateError('checksum');
    return text;
  }

  /** Streams to disk and returns the SHA-256 of what arrived. */
  private async download(url: string, to: string, progress: (p: number) => void) {
    // no overall time limit, a slow line may need a while for 100 MB; a line that stalls is given up on
    const ctrl = new AbortController();
    let stall = setTimeout(() => ctrl.abort(), 30_000);
    const alive = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(), 30_000);
    };
    try {
      const res = await fetch(url, { headers: { 'user-agent': `Zack/${app.getVersion()}` }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new UpdateError('network');
      const total = Number(res.headers.get('content-length')) || 0;
      if (total > MAX_SIZE) throw new UpdateError('network');
      const hash = createHash('sha256');
      let got = 0;
      let shown = -1;
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          alive();
          got += chunk.length;
          if (got > MAX_SIZE) return done(new UpdateError('network'));
          hash.update(chunk);
          const p = total ? Math.min(100, Math.floor((got / total) * 100)) : 0;
          if (p !== shown) progress((shown = p));
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as ReadableStream<Uint8Array>), meter, createWriteStream(to, { flags: 'wx', mode: 0o600 }));
      return hash.digest('hex');
    } catch (e) {
      throw e instanceof UpdateError ? e : new UpdateError('network');
    } finally {
      clearTimeout(stall);
    }
  }

  private async installMac(dmg: string, version: string) {
    const bundle = macBundle()!;
    const mnt = join(this.dir, 'mnt');
    const staged = join(this.dir, 'Zack.app');
    await mkdir(mnt);
    await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-quiet', '-mountpoint', mnt, dmg]);
    try {
      const src = join(mnt, 'Zack.app');
      const plist = join(src, 'Contents', 'Info.plist');
      const read = async (key: string) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', plist])).stdout.trim();
      if ((await read('CFBundleIdentifier')) !== BUNDLE_ID || (await read('CFBundleShortVersionString')) !== version) throw new UpdateError('checksum');
      await run('/usr/bin/ditto', [src, staged]);
    } finally {
      await run('/usr/bin/hdiutil', ['detach', mnt, '-force', '-quiet']).catch(() => {});
    }
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--test-requirement', SIGNED_BY_US, staged]).catch(() => {
      throw new UpdateError('signature');
    });
    // Zack quarantines what it writes. This copy is ours by checksum and
    // signature; with the flag every update would start with Gatekeeper's
    // "downloaded from the internet" question.
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {});
    const args = process.argv.slice(1).filter((a) => !a.startsWith('-psn_'));
    spawn('/bin/sh', ['-c', SWAP_MAC, 'zack-update', String(process.pid), bundle, staged, ...args], { detached: true, stdio: 'ignore' }).unref();
    this.quit();
  }

  private installWindows(setup: string) {
    // the one-click installer closes what's left of us, installs silently and starts the new version
    spawn(setup, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    this.quit();
  }

  private async installAppImage(file: string) {
    const target = process.env.APPIMAGE!;
    const next = `${target}.update`;
    await copyFile(file, next);
    await chmod(next, 0o755);
    await rename(next, target);
    spawn('/bin/sh', ['-c', RELAUNCH, 'zack-update', String(process.pid), target, ...process.argv.slice(1)], { detached: true, stdio: 'ignore' }).unref();
    this.quit();
  }

  private quit() {
    app.quit();
    // something holding the quit up mustn't leave the update half done
    setTimeout(() => app.exit(0), 8000).unref();
  }
}
