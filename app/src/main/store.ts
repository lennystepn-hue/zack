import { app, safeStorage } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { RoomCreds } from '../core/client';
import { newId, newSecret } from '../core/crypto';
import type { Platform, PortalItem, Settings } from '../shared/types';

interface Persisted {
  deviceId: string;
  /** proves to the relay that this device id is ours */
  deviceSecret: string;
  deviceName: string;
  settings: Settings;
  widget?: { x: number; y: number };
  /** room credentials, sealed by the OS keychain where that is reliable */
  room?: { sealed: boolean; value: string } | null;
  server?: string;
}

export const platform: Platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';

const MAX_HISTORY = 40;

function defaultName() {
  if (process.platform === 'darwin') {
    try {
      const n = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim();
      if (n) return n;
    } catch {
      // fall through to the hostname
    }
  }
  return hostname().replace(/\.local$/i, '').replace(/[-_]+/g, ' ').trim() || 'Computer';
}

function defaultSettings(): Settings {
  return {
    theme: 'singularity',
    sound: true,
    autoCopyText: true,
    autoCopyImages: true,
    autoOpenLinks: false,
    summonOnReceive: true,
    alwaysOnTop: true,
    launchAtLogin: false,
    saveDir: join(app.getPath('downloads'), 'Zack'),
    target: '*',
    hotkey: 'CommandOrControl+Alt+Z',
    scale: 1,
    language: 'auto',
  };
}

// The keychain is only worth it where it is silent and real: DPAPI on Windows,
// Keychain for a packaged Mac build (dev builds would prompt on every rebuild),
// and a real secret service on Linux, not the plain-text fallback.
function keychainUsable() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === 'darwin') return app.isPackaged;
  if (process.platform === 'linux') return safeStorage.getSelectedStorageBackend() !== 'basic_text';
  return true;
}

export class Store {
  private dir = app.getPath('userData');
  private file = join(this.dir, 'config.json');
  private historyFile = join(this.dir, 'history.json');
  private seenFile = join(this.dir, 'seen.json');
  private seen = new Set<string>();
  private data: Persisted;
  history: PortalItem[] = [];
  room: RoomCreds | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    mkdirSync(this.dir, { recursive: true });
    const loaded = readJson<Partial<Persisted>>(this.file) ?? {};
    this.data = {
      deviceId: loaded.deviceId ?? newId(),
      deviceSecret: loaded.deviceSecret ?? newSecret(),
      deviceName: loaded.deviceName ?? defaultName(),
      settings: { ...defaultSettings(), ...loaded.settings },
      widget: loaded.widget,
      room: loaded.room ?? null,
      server: loaded.server,
    };
    this.room = this.unsealRoom();
    this.seen = new Set(readJson<string[]>(this.seenFile) ?? []);
    this.history = (readJson<PortalItem[]>(this.historyFile) ?? []).map((i) =>
      i.status === 'sending' || i.status === 'incoming' ? { ...i, status: 'failed' as const } : i,
    );
    this.flush();
  }

  get deviceId() {
    return this.data.deviceId;
  }
  get deviceSecret() {
    return this.data.deviceSecret;
  }
  get deviceName() {
    return this.data.deviceName;
  }
  set deviceName(v: string) {
    this.data.deviceName = v;
    this.save();
  }
  get settings() {
    return this.data.settings;
  }
  patchSettings(patch: Partial<Settings>) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }
  get widget() {
    return this.data.widget;
  }
  set widget(v: { x: number; y: number } | undefined) {
    this.data.widget = v;
    this.save();
  }
  get server() {
    // an environment variable may point a development build elsewhere, never a release
    return (!app.isPackaged && process.env.ZACK_SERVER) || this.data.server || __ZACK_SERVER__;
  }

  setRoom(room: RoomCreds | null) {
    this.room = room;
    if (!room) this.data.room = null;
    else if (keychainUsable()) this.data.room = { sealed: true, value: safeStorage.encryptString(JSON.stringify(room)).toString('base64') };
    else this.data.room = { sealed: false, value: JSON.stringify(room) };
    this.flush();
  }

  private unsealRoom(): RoomCreds | null {
    const r = this.data.room;
    if (!r) return null;
    try {
      return JSON.parse(r.sealed ? safeStorage.decryptString(Buffer.from(r.value, 'base64')) : r.value);
    } catch {
      return null;
    }
  }

  upsertItem(item: PortalItem) {
    const i = this.history.findIndex((h) => h.id === item.id);
    if (i >= 0) this.history[i] = item;
    else this.history.unshift(item);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    this.save();
    return item;
  }

  patchItem(id: string, patch: Partial<PortalItem>) {
    const item = this.history.find((h) => h.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    this.save();
    return item;
  }

  removeItem(id: string) {
    this.history = this.history.filter((h) => h.id !== id);
    this.save();
  }

  /** Every drop ever received, so a replayed one is never delivered twice. */
  wasSeen(id: string) {
    return this.seen.has(id);
  }

  markSeen(id: string) {
    this.seen.add(id);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-4000));
    this.save();
  }

  item(id: string) {
    return this.history.find((h) => h.id === id) ?? null;
  }

  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    writeAtomic(this.file, JSON.stringify(this.data, null, 2));
    writeAtomic(this.historyFile, JSON.stringify(this.history));
    writeAtomic(this.seenFile, JSON.stringify([...this.seen]));
  }
}

function readJson<T>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, body: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, file);
}
