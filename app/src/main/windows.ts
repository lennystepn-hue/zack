import { app, BrowserWindow, screen, shell, type BrowserWindowConstructorOptions } from 'electron';
import type { HitShape } from '../shared/types';
import { join } from 'node:path';
import type { PortalService } from './service';

export const WIDGET_W = 260;
export const WIDGET_H = 330;

const preload = join(__dirname, '../preload/index.js');

function pageUrl(win: BrowserWindow, page: string, hash = '') {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) return win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html${hash}`);
  return win.loadFile(join(__dirname, `../renderer/${page}.html`), hash ? { hash: hash.slice(1) } : undefined);
}

const secure: BrowserWindowConstructorOptions['webPreferences'] = {
  preload,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: false,
  spellcheck: false,
  autoplayPolicy: 'no-user-gesture-required',
  backgroundThrottling: false,
};

// Nothing inside our windows should ever navigate or spawn windows.
function lockDown(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL;
    if (dev && url.startsWith(dev)) return;
    e.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

export class Windows {
  widget: BrowserWindow | null = null;
  settings: BrowserWindow | null = null;
  private summonedAt = 0;
  private summonTimer: ReturnType<typeof setTimeout> | null = null;
  private svc: PortalService;
  private shapes: HitShape[] = [];
  private ignoring = false;
  private hovered = false;
  moving = false;

  constructor(svc: PortalService) {
    this.svc = svc;
    // Only the visible object catches the mouse. A cheap poll of the cursor
    // decides, which also works mid-drag, when the OS sends no mouse moves.
    setInterval(() => this.trackCursor(), 33).unref();
  }

  setShapes(shapes: HitShape[]) {
    this.shapes = shapes;
  }

  private trackCursor() {
    const win = this.widget;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const z = this.svc.store.settings.scale || 1;
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const x = (c.x - b.x) / z;
    const y = (c.y - b.y) / z;
    const inside = c.x >= b.x && c.y >= b.y && c.x < b.x + b.width && c.y < b.y + b.height;
    const over =
      this.moving ||
      (inside &&
        this.shapes.some((s) => (s.type === 'circle' ? (x - s.x) ** 2 + (y - s.y) ** 2 <= s.r ** 2 : x >= s.x && y >= s.y && x <= s.x + s.w && y <= s.y + s.h)));
    // Linux can't forward mouse moves through an ignoring window, so it stays solid there
    if (process.platform !== 'linux' && over === this.ignoring) {
      this.ignoring = !over;
      win.setIgnoreMouseEvents(!over, { forward: true });
    }
    if (over !== this.hovered) {
      this.hovered = over;
      win.webContents.send('portal:hover', over);
    }
  }

  createWidget() {
    const s = this.svc.store.settings;
    const scale = s.scale || 1;
    const w = Math.round(WIDGET_W * scale);
    const h = Math.round(WIDGET_H * scale);
    const pos = this.restorePosition(w, h);

    const win = new BrowserWindow({
      width: w,
      height: h,
      x: pos.x,
      y: pos.y,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: s.alwaysOnTop,
      roundedCorners: false,
      title: 'Zack',
      webPreferences: secure,
    });
    this.widget = win;
    lockDown(win);
    this.applyTop();
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });

    win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(scale));
    win.once('ready-to-show', () => win.showInactive());
    win.on('moved', () => {
      const [x, y] = win.getPosition();
      this.svc.store.widget = { x, y };
    });
    win.on('closed', () => (this.widget = null));
    void pageUrl(win, 'widget');
    return win;
  }

  private restorePosition(w: number, h: number) {
    const saved = this.svc.store.widget;
    if (saved) {
      const visible = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return saved.x + w / 2 > a.x && saved.x + w / 2 < a.x + a.width && saved.y + h / 2 > a.y && saved.y + h / 2 < a.y + a.height;
      });
      if (visible) return saved;
    }
    const a = screen.getPrimaryDisplay().workArea;
    return { x: a.x + a.width - w - 28, y: a.y + a.height - h - 28 };
  }

  applyTop() {
    const win = this.widget;
    if (!win) return;
    const on = this.svc.store.settings.alwaysOnTop;
    if (process.platform === 'darwin') win.setAlwaysOnTop(on, 'floating');
    else win.setAlwaysOnTop(on);
  }

  applyScale() {
    const win = this.widget;
    if (!win) return;
    const scale = this.svc.store.settings.scale || 1;
    const [x, y] = win.getPosition();
    const [ow, oh] = win.getSize();
    const w = Math.round(WIDGET_W * scale);
    const h = Math.round(WIDGET_H * scale);
    // grow around the bottom-right corner, where the widget usually lives
    win.setBounds({ x: x + ow - w, y: y + oh - h, width: w, height: h });
    win.webContents.setZoomFactor(scale);
  }

  widgetVisible() {
    return !!this.widget?.isVisible() && this.summonedAt === 0;
  }

  toggleWidget(force?: boolean) {
    const win = this.widget ?? this.createWidget();
    const show = force ?? !win.isVisible();
    this.summonedAt = 0;
    if (show) win.showInactive();
    else win.hide();
  }

  /** Something arrived while the portal was tucked away: show it for the animation, then tuck it back. */
  summon() {
    const win = this.widget;
    if (!win || !this.svc.store.settings.summonOnReceive) return;
    if (win.isVisible() && this.summonedAt === 0) return;
    this.summonedAt = Date.now();
    win.showInactive();
    if (this.summonTimer) clearTimeout(this.summonTimer);
    this.summonTimer = setTimeout(() => {
      if (this.summonedAt && Date.now() - this.summonedAt >= 6500) {
        this.summonedAt = 0;
        win.hide();
      }
    }, 7000);
  }

  /** The user touched a summoned widget, so it stays. */
  keep() {
    this.summonedAt = 0;
  }

  openSettings(section?: string) {
    if (this.settings) {
      if (section) this.settings.webContents.send('settings:section', section);
      this.settings.show();
      this.settings.focus();
      if (process.platform === 'darwin') app.focus({ steal: true });
      return;
    }
    const mac = process.platform === 'darwin';
    const winOS = process.platform === 'win32';
    const win = new BrowserWindow({
      width: 480,
      height: 680,
      minWidth: 480,
      minHeight: 560,
      show: false,
      title: 'Zack',
      backgroundColor: mac || winOS ? '#00000000' : '#121214',
      transparent: false,
      titleBarStyle: mac ? 'hiddenInset' : 'hidden',
      trafficLightPosition: { x: 18, y: 18 },
      titleBarOverlay: winOS ? { color: '#00000000', symbolColor: '#d8d4cc', height: 40 } : process.platform === 'linux' ? { color: '#121214', symbolColor: '#d8d4cc', height: 40 } : undefined,
      vibrancy: mac ? 'under-window' : undefined,
      visualEffectState: 'active',
      backgroundMaterial: winOS ? 'mica' : undefined,
      fullscreenable: false,
      maximizable: false,
      webPreferences: secure,
    });
    this.settings = win;
    lockDown(win);
    win.once('ready-to-show', () => {
      win.show();
      if (mac) app.focus({ steal: true });
    });
    win.on('closed', () => (this.settings = null));
    void pageUrl(win, 'settings', section ? `#${section}` : '');
  }

  broadcast(channel: string, payload: unknown) {
    for (const w of [this.widget, this.settings]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
