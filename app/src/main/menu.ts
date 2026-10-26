import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import tray1x from '../../resources/trayTemplate.png?asset';
import tray2x from '../../resources/trayTemplate@2x.png?asset';
import trayColor from '../../resources/tray.png?asset';
import type { ThemeId } from '../shared/types';
import type { PortalService } from './service';
import type { Windows } from './windows';

const THEMES: { id: ThemeId; key: 'themeSingularity' | 'themeWarp' | 'themeRift' | 'themeToaster' | 'themeLiquid' | 'themeMonster' }[] = [
  { id: 'singularity', key: 'themeSingularity' },
  { id: 'warp', key: 'themeWarp' },
  { id: 'rift', key: 'themeRift' },
  { id: 'toaster', key: 'themeToaster' },
  { id: 'liquid', key: 'themeLiquid' },
  { id: 'monster', key: 'themeMonster' },
];

function accel(hotkey: string) {
  return hotkey.replace('CommandOrControl', 'CmdOrCtrl');
}

export function portalMenu(svc: PortalService, win: Windows): MenuItemConstructorOptions[] {
  const t = svc.t;
  const s = svc.store.settings;
  const others = (svc.client?.devices ?? []).filter((d) => d.id !== svc.store.deviceId);
  const visible = !!win.widget?.isVisible();
  const update = svc.updateState();
  return [
    ...(update.phase === 'available'
      ? ([{ label: `${t.updateTo} ${update.version}…`, click: () => win.openSettings('update') }, { type: 'separator' }] as MenuItemConstructorOptions[])
      : []),
    { label: visible ? t.hidePortal : t.showPortal, click: () => win.toggleWidget() },
    { label: t.sendClipboard, accelerator: accel(s.hotkey), registerAccelerator: false, enabled: !!svc.client, click: () => void svc.sendClipboard() },
    { type: 'separator' },
    {
      label: t.sendTo,
      enabled: others.length > 1,
      submenu: [
        { label: t.everyone, type: 'radio', checked: s.target === '*', click: () => svc.setSettings({ target: '*' }) },
        { type: 'separator' },
        ...others.map<MenuItemConstructorOptions>((d) => ({
          label: d.online ? d.name : `${d.name}  ·  ${t.offline.toLowerCase()}`,
          type: 'radio',
          checked: s.target === d.id,
          click: () => svc.setSettings({ target: d.id }),
        })),
      ],
    },
    {
      label: t.look,
      submenu: THEMES.map<MenuItemConstructorOptions>((th) => ({
        label: t[th.key],
        type: 'radio',
        checked: s.theme === th.id,
        click: () => svc.setSettings({ theme: th.id }),
      })),
    },
    { label: t.openReceived, click: () => svc.openSaveDir() },
    { type: 'separator' },
    { label: svc.store.room ? t.settings : t.pairDevice, click: () => win.openSettings(svc.store.room ? undefined : 'pair') },
    { label: t.quit, accelerator: 'CmdOrCtrl+Q', registerAccelerator: false, click: () => app.quit() },
  ];
}

export function itemMenu(svc: PortalService, id: string): MenuItemConstructorOptions[] {
  const t = svc.t;
  const item = svc.store.item(id);
  if (!item) return [];
  const hasFile = !!item.path;
  const textual = item.kind === 'text' || item.kind === 'link';
  const live = item.status === 'sending' || item.status === 'incoming';
  return [
    { label: t.cancel, visible: live, click: () => svc.cancelItem(id) },
    { type: 'separator', visible: live },
    { label: t.open, enabled: hasFile || item.kind === 'link', visible: item.kind !== 'text' && !live, click: () => svc.openItem(id) },
    { label: t.reveal, visible: hasFile, click: () => svc.revealItem(id) },
    { label: t.copy, visible: textual || item.kind === 'image', click: () => svc.copyItem(id) },
    { type: 'separator' },
    { label: t.remove, click: () => svc.removeItem(id) },
  ];
}

export function createTray(svc: PortalService, win: Windows) {
  let icon: Electron.NativeImage;
  if (process.platform === 'darwin') {
    icon = nativeImage.createFromPath(tray1x);
    icon.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(tray2x).toPNG() });
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(trayColor);
  }
  const tray = new Tray(icon);
  tray.setToolTip('Zack');
  const open = () => tray.popUpContextMenu(Menu.buildFromTemplate(portalMenu(svc, win)));
  tray.on('click', () => (process.platform === 'darwin' ? open() : win.toggleWidget()));
  tray.on('right-click', open);
  // Linux tray implementations often only support the attached menu
  if (process.platform === 'linux') {
    const refresh = () => tray.setContextMenu(Menu.buildFromTemplate(portalMenu(svc, win)));
    refresh();
    svc.on('event', (e) => (e.type === 'state' || e.type === 'update') && refresh());
  }
  return tray;
}
