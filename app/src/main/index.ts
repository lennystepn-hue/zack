import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DroppedBuffer, Settings } from '../shared/types';
import { createTray, itemMenu, portalMenu } from './menu';
import { PortalService } from './service';
import { Windows } from './windows';

// Separate profiles let two instances run side by side on one machine,
// which is how the whole round trip gets tested without a second computer.
// Development hooks (second profile, screenshots, dev server) exist only in
// unpackaged builds; a release ignores the environment.
const dev = !app.isPackaged;
const profile = dev && /^[a-z0-9]{1,16}$/i.test(process.env.ZACK_PROFILE ?? '') ? process.env.ZACK_PROFILE : undefined;
if (profile) app.setPath('userData', join(app.getPath('appData'), `Zack-${profile}`));
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-transparent-visuals');
app.setAppUserModelId('services.lenny.zack');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => windows?.toggleWidget(true));
  void app.whenReady().then(boot);
}

let windows: Windows | null = null;
let svc: PortalService | null = null;
let registered: string | null = null;

async function boot() {
  nativeTheme.themeSource = 'dark';
  if (process.platform === 'darwin') app.dock?.hide();
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);

  // Linux compositors need a beat before a transparent window can be created
  if (process.platform === 'linux') await new Promise((r) => setTimeout(r, 300));

  svc = new PortalService();
  windows = new Windows(svc);
  const s = svc;
  const w = windows;
  s.widgetVisible = () => w.widgetVisible();

  s.on('event', (e) => w.broadcast('portal:event', e));
  s.on('summon', () => w.summon());
  s.on('needs-pair', () => w.openSettings('pair'));
  s.on('settings', (next, patch) => applySettings(next, patch));

  registerIpc(s, w);
  w.createWidget();
  createTray(s, w);
  applySettings(s.store.settings, { hotkey: s.store.settings.hotkey, ...(s.store.settings.launchAtLogin ? { launchAtLogin: true } : {}) });
  s.start();
  if (!s.store.room) setTimeout(() => w.openSettings('pair'), 900);

  powerMonitor.on('resume', () => s.nudge());
  powerMonitor.on('unlock-screen', () => s.nudge());

  if (dev && process.env.ZACK_CAPTURE) scheduleCaptures(process.env.ZACK_CAPTURE);
}

function applySettings(next: Settings, patch: Partial<Settings>) {
  const w = windows!;
  if ('alwaysOnTop' in patch) w.applyTop();
  if ('scale' in patch) w.applyScale();
  if ('hotkey' in patch) {
    if (registered) globalShortcut.unregister(registered);
    registered = null;
    if (next.hotkey && globalShortcut.register(next.hotkey, () => void svc?.sendClipboard())) registered = next.hotkey;
  }
  if ('launchAtLogin' in patch && process.platform !== 'linux' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
  }
}

// Only our own pages get to talk to the main process.
function trusted(e: IpcMainEvent | IpcMainInvokeEvent) {
  const url = e.senderFrame?.url ?? '';
  const server = dev ? process.env.ELECTRON_RENDERER_URL : undefined;
  if (server && url.startsWith(server)) return true;
  return url.startsWith(pathToFileURL(join(__dirname, '../renderer')).href);
}

function registerIpc(s: PortalService, w: Windows) {
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error('untrusted sender');
      return fn(...args);
    });
  const on = (channel: string, fn: (e: IpcMainEvent, ...args: any[]) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      if (trusted(e)) fn(e, ...args);
    });

  const str = (v: unknown, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : '');

  handle('portal:state', () => s.state());
  handle('portal:drop-paths', (paths: unknown) => {
    w.keep();
    return s.dropPaths(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string').slice(0, 200) : []);
  });
  handle('portal:drop-text', (text: unknown) => {
    w.keep();
    return s.dropText(typeof text === 'string' ? text : '');
  });
  handle('portal:drop-buffers', (bufs: unknown) => {
    w.keep();
    const list = Array.isArray(bufs) ? (bufs as DroppedBuffer[]) : [];
    return s.dropBuffers(list.filter((b) => b && typeof b.name === 'string' && b.data instanceof ArrayBuffer).slice(0, 50));
  });
  handle('portal:send-clipboard', () => s.sendClipboard());
  handle('portal:file-icon', (path: unknown) => s.fileIcon(str(path)));
  handle('portal:set-settings', (patch: unknown) => {
    if (!patch || typeof patch !== 'object') return;
    const allowed: (keyof Settings)[] = ['theme', 'sound', 'autoCopyText', 'autoCopyImages', 'autoOpenLinks', 'summonOnReceive', 'alwaysOnTop', 'launchAtLogin', 'target', 'hotkey', 'scale', 'language'];
    const clean: Partial<Settings> = {};
    for (const k of allowed) if (k in patch) (clean as any)[k] = (patch as any)[k];
    if (clean.scale !== undefined && ![0.8, 1, 1.25].includes(clean.scale)) delete clean.scale;
    if (clean.theme !== undefined && !['singularity', 'warp', 'rift', 'toaster', 'liquid', 'monster'].includes(clean.theme)) delete clean.theme;
    if (clean.language !== undefined && !['auto', 'de', 'en'].includes(clean.language)) delete clean.language;
    s.setSettings(clean);
  });
  handle('portal:create-code', () => s.createCode());
  handle('portal:cancel-code', () => s.cancelCode());
  handle('portal:join', (code: unknown) => s.join(str(code, 32)));
  handle('portal:unpair', () => s.unpair());
  handle('portal:forget', (id: unknown) => s.forget(str(id, 64)));
  handle('portal:rename', (name: unknown) => s.rename(str(name, 64)));
  handle('portal:choose-save-dir', async () => {
    const parent = BrowserWindow.getFocusedWindow() ?? w.settings ?? undefined;
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], defaultPath: s.store.settings.saveDir };
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return null;
    s.store.patchSettings({ saveDir: r.filePaths[0] });
    s.setSettings({});
    return r.filePaths[0];
  });
  handle('portal:open-item', (id: unknown) => s.openItem(str(id, 64)));
  handle('portal:reveal-item', (id: unknown) => s.revealItem(str(id, 64)));
  handle('portal:copy-item', (id: unknown) => s.copyItem(str(id, 64)));
  handle('portal:remove-item', (id: unknown) => s.removeItem(str(id, 64)));

  on('portal:start-drag', (e, id: unknown) => {
    const d = s.dragIcon(str(id, 64));
    if (!d) return;
    e.sender.startDrag({ file: d.path, icon: d.icon ?? nativeImage.createFromDataURL(BLANK_ICON) });
  });
  on('portal:open-settings', (_e, section: unknown) => w.openSettings(str(section, 32) || undefined));
  on('portal:context-menu', (e) => {
    w.keep();
    Menu.buildFromTemplate(portalMenu(s, w)).popup({ window: BrowserWindow.fromWebContents(e.sender) ?? undefined });
  });
  on('portal:item-menu', (e, id: unknown) => {
    Menu.buildFromTemplate(itemMenu(s, str(id, 64))).popup({ window: BrowserWindow.fromWebContents(e.sender) ?? undefined });
  });
  // Dragging the portal itself moves the window. The main process follows the
  // cursor, so fast flicks don't outrun the renderer's mouse events.
  let follow: ReturnType<typeof setInterval> | null = null;
  let followUntil = 0;
  const stopFollow = () => {
    if (follow) clearInterval(follow);
    follow = null;
    w.moving = false;
    const win = w.widget;
    if (win) {
      const [x, y] = win.getPosition();
      s.store.widget = { x, y };
    }
  };
  on('portal:move-start', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return;
    w.keep();
    const c0 = screen.getCursorScreenPoint();
    const [x0, y0] = win.getPosition();
    const off = { x: c0.x - x0, y: c0.y - y0 };
    w.moving = true;
    if (follow) clearInterval(follow);
    followUntil = Date.now() + 60_000;
    follow = setInterval(() => {
      if (win.isDestroyed() || Date.now() > followUntil) return stopFollow();
      const c = screen.getCursorScreenPoint();
      win.setPosition(Math.round(c.x - off.x), Math.round(c.y - off.y));
    }, 8);
  });
  on('portal:move-end', () => stopFollow());
  on('portal:hit-shapes', (_e, shapes: unknown) => {
    if (!Array.isArray(shapes)) return;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    w.setShapes(
      shapes.slice(0, 32).map((s: any) =>
        s?.type === 'circle' ? { type: 'circle' as const, x: num(s.x), y: num(s.y), r: num(s.r) } : { type: 'rect' as const, x: num(s.x), y: num(s.y), w: num(s.w), h: num(s.h) },
      ),
    );
  });
  on('portal:hide-widget', () => w.toggleWidget(false));
  on('portal:open-save-dir', () => s.openSaveDir());
  on('portal:keep', () => w.keep());
}

// 1×1 transparent PNG for drags that have no thumbnail
const BLANK_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function scheduleCaptures(dir: string) {
  const shoot = async (name: string) => {
    const win = windows?.widget;
    if (!win) return;
    const img = await win.webContents.capturePage();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, `${name}-${profile ?? 'main'}.png`), img.toPNG());
  };
  setTimeout(() => void shoot('widget'), 4000);
  ipcMain.on('portal:capture', (e, name: unknown) => {
    if (trusted(e)) void shoot(typeof name === 'string' ? name.replace(/[^a-z0-9-]/gi, '') : 'shot');
  });
}

app.on('window-all-closed', () => {
  // the tray keeps us alive
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  svc?.stop();
});
