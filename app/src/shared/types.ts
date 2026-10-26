export type ThemeId = 'singularity' | 'warp' | 'rift' | 'toaster' | 'liquid' | 'monster';
export type Platform = 'mac' | 'win' | 'linux';
export type ItemKind = 'text' | 'link' | 'image' | 'file' | 'folder';
export type Lang = 'de' | 'en';

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  online: boolean;
  lastSeen: number;
}

export type ItemStatus = 'sending' | 'waiting' | 'delivered' | 'incoming' | 'received' | 'failed';

export interface PortalItem {
  id: string;
  dir: 'in' | 'out';
  kind: ItemKind;
  name: string;
  size: number;
  mime?: string;
  /** text and links travel inline; long texts are clipped here for the UI */
  text?: string;
  /** received file on disk, or the source of a sent one */
  path?: string;
  /** small data: URL, made by the sender */
  thumb?: string;
  peer: string;
  peerPlatform?: Platform;
  at: number;
  status: ItemStatus;
  progress?: number;
  copied?: boolean;
  error?: string;
}

export interface Settings {
  theme: ThemeId;
  sound: boolean;
  autoCopyText: boolean;
  autoCopyImages: boolean;
  autoOpenLinks: boolean;
  summonOnReceive: boolean;
  alwaysOnTop: boolean;
  launchAtLogin: boolean;
  saveDir: string;
  /** '*' for every other device, or one device id */
  target: string;
  hotkey: string;
  /** widget size: 0.8, 1 or 1.25 */
  scale: number;
  /** 'auto' follows the system language */
  language: 'auto' | Lang;
}

export interface PortalState {
  lang: Lang;
  platform: Platform;
  paired: boolean;
  connected: boolean;
  self: { id: string; name: string; platform: Platform };
  devices: Device[];
  settings: Settings;
  history: PortalItem[];
  server: string;
  version: string;
  update: UpdateState;
}

export type UpdateState =
  /** off: built against another relay, so the official releases aren't its updates */
  | { phase: 'idle' | 'checking' | 'current' | 'off' }
  /** auto: this copy can install it itself; otherwise the download page opens */
  | { phase: 'available'; version: string; auto: boolean }
  | { phase: 'downloading'; version: string; progress: number }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; error: 'network' | 'checksum' | 'signature' | 'install' };

export interface PairCode {
  code: string;
  expires: number;
}

export type PortalEvent =
  | { type: 'state'; state: PortalState }
  | { type: 'outgoing'; item: PortalItem; origin: 'drop' | 'clipboard' }
  | { type: 'incoming'; item: PortalItem }
  | { type: 'progress'; id: string; progress: number; dir: 'in' | 'out' }
  | { type: 'arrived'; item: PortalItem }
  | { type: 'delivered'; id: string; by: string }
  | { type: 'failed'; id: string; error: string }
  | { type: 'linked'; device: Device }
  | { type: 'pair-code'; code: PairCode | null }
  | { type: 'theme'; theme: ThemeId }
  | { type: 'notice'; text: string }
  | { type: 'update'; update: UpdateState };

export interface DroppedBuffer {
  name: string;
  mime: string;
  data: ArrayBuffer;
}

/** The surface the preload script exposes as window.zack */
export interface Bridge {
  getState(): Promise<PortalState>;
  on(listener: (e: PortalEvent) => void): () => void;
  pathForFile(file: File): string;
  dropPaths(paths: string[]): Promise<void>;
  dropText(text: string): Promise<void>;
  dropBuffers(buffers: DroppedBuffer[]): Promise<void>;
  sendClipboard(): Promise<void>;
  fileIcon(path: string): Promise<string | null>;
  setSettings(patch: Partial<Settings>): Promise<void>;
  createCode(): Promise<PairCode>;
  cancelCode(): Promise<void>;
  join(code: string): Promise<{ ok: true } | { ok: false; error: string }>;
  unpair(): Promise<void>;
  forget(deviceId: string): Promise<void>;
  rename(name: string): Promise<void>;
  chooseSaveDir(): Promise<string | null>;
  openItem(id: string): Promise<void>;
  revealItem(id: string): Promise<void>;
  copyItem(id: string): Promise<void>;
  removeItem(id: string): Promise<void>;
  startDrag(id: string): void;
  openSettings(section?: string): void;
  contextMenu(): void;
  hideWidget(): void;
  openSaveDir(): void;
  itemMenu(id: string): void;
  checkUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  /** the widget follows the cursor between these two calls */
  moveStart(): void;
  moveEnd(): void;
}

/** A part of the widget that should catch the mouse; everything else clicks through. */
export type HitShape = { type: 'circle'; x: number; y: number; r: number } | { type: 'rect'; x: number; y: number; w: number; h: number };
