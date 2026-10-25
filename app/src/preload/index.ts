import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Bridge, PortalEvent } from '../shared/types';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const bridge: Bridge = {
  getState: () => invoke('portal:state'),
  on(listener) {
    const h = (_e: unknown, ev: PortalEvent) => listener(ev);
    ipcRenderer.on('portal:event', h);
    return () => ipcRenderer.off('portal:event', h);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  dropPaths: (paths) => invoke('portal:drop-paths', paths),
  dropText: (text) => invoke('portal:drop-text', text),
  dropBuffers: (buffers) => invoke('portal:drop-buffers', buffers),
  sendClipboard: () => invoke('portal:send-clipboard'),
  fileIcon: (path) => invoke('portal:file-icon', path),
  setSettings: (patch) => invoke('portal:set-settings', patch),
  createCode: () => invoke('portal:create-code'),
  cancelCode: () => invoke('portal:cancel-code'),
  join: (code) => invoke('portal:join', code),
  unpair: () => invoke('portal:unpair'),
  forget: (id) => invoke('portal:forget', id),
  rename: (name) => invoke('portal:rename', name),
  chooseSaveDir: () => invoke('portal:choose-save-dir'),
  openItem: (id) => invoke('portal:open-item', id),
  revealItem: (id) => invoke('portal:reveal-item', id),
  copyItem: (id) => invoke('portal:copy-item', id),
  removeItem: (id) => invoke('portal:remove-item', id),
  startDrag: (id) => ipcRenderer.send('portal:start-drag', id),
  openSettings: (section) => ipcRenderer.send('portal:open-settings', section),
  contextMenu: () => ipcRenderer.send('portal:context-menu'),
  itemMenu: (id) => ipcRenderer.send('portal:item-menu', id),
  hideWidget: () => ipcRenderer.send('portal:hide-widget'),
  openSaveDir: () => ipcRenderer.send('portal:open-save-dir'),
  moveStart: () => ipcRenderer.send('portal:move-start'),
  moveEnd: () => ipcRenderer.send('portal:move-end'),
};

contextBridge.exposeInMainWorld('zack', bridge);
contextBridge.exposeInMainWorld('zackHost', {
  keep: () => ipcRenderer.send('portal:keep'),
  capture: (name: string) => ipcRenderer.send('portal:capture', name),
  onSection: (fn: (s: string) => void) => ipcRenderer.on('settings:section', (_e, s: string) => fn(s)),
  hitShapes: (shapes: unknown) => ipcRenderer.send('portal:hit-shapes', shapes),
  onHover: (fn: (over: boolean) => void) => ipcRenderer.on('portal:hover', (_e, over: boolean) => fn(over)),
});
