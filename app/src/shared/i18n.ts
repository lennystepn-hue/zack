import type { Lang } from './types';

const de = {
  showPortal: 'Portal zeigen',
  hidePortal: 'Portal verstecken',
  sendClipboard: 'Zwischenablage senden',
  sendTo: 'Senden an',
  everyone: 'Alle Geräte',
  look: 'Look',
  openReceived: 'Empfangene Dateien öffnen',
  settings: 'Einstellungen…',
  pairDevice: 'Gerät verbinden…',
  quit: 'Zack beenden',
  open: 'Öffnen',
  reveal: 'Im Ordner zeigen',
  copy: 'Kopieren',
  remove: 'Aus Verlauf entfernen',
  cancel: 'Abbrechen',
  fromDevice: 'von',
  copied: 'kopiert',
  saved: 'gespeichert',
  delivered: 'angekommen',
  waiting: 'wartet auf',
  sending: 'unterwegs',
  notPaired: 'Portal verbinden',
  offline: 'Offline',
  connecting: 'Verbinde…',
  noDevices: 'Kein zweites Gerät',
  devices: 'Geräte',
  nothingOnClipboard: 'Zwischenablage ist leer',
  failed: 'Fehlgeschlagen',
  linked: 'verbunden',
  arrivedFrom: 'ist angekommen von',
  textArrived: 'Text in der Zwischenablage',
  folder: 'Ordner',
  image: 'Bild',
  text: 'Text',
  link: 'Link',
  file: 'Datei',
  themeSingularity: 'Singularity',
  themeWarp: 'Warp Pipe',
  themeRift: 'Rift',
  themeToaster: 'Toaster',
  themeLiquid: 'Liquid Metal',
  themeMonster: 'Monster',
} as const;

type Strings = { [K in keyof typeof de]: string };

const en: Strings = {
  showPortal: 'Show portal',
  hidePortal: 'Hide portal',
  sendClipboard: 'Send clipboard',
  sendTo: 'Send to',
  everyone: 'All devices',
  look: 'Look',
  openReceived: 'Open received files',
  settings: 'Settings…',
  pairDevice: 'Link a device…',
  quit: 'Quit Zack',
  open: 'Open',
  reveal: 'Show in folder',
  copy: 'Copy',
  remove: 'Remove from history',
  cancel: 'Cancel',
  fromDevice: 'from',
  copied: 'copied',
  saved: 'saved',
  delivered: 'arrived',
  waiting: 'waiting for',
  sending: 'in transit',
  notPaired: 'Link a portal',
  offline: 'Offline',
  connecting: 'Connecting…',
  noDevices: 'No other device',
  devices: 'devices',
  nothingOnClipboard: 'Clipboard is empty',
  failed: 'Failed',
  linked: 'linked',
  arrivedFrom: 'arrived from',
  textArrived: 'Text on your clipboard',
  folder: 'Folder',
  image: 'Image',
  text: 'Text',
  link: 'Link',
  file: 'File',
  themeSingularity: 'Singularity',
  themeWarp: 'Warp Pipe',
  themeRift: 'Rift',
  themeToaster: 'Toaster',
  themeLiquid: 'Liquid Metal',
  themeMonster: 'Monster',
};

export function strings(lang: Lang): Strings {
  return lang === 'de' ? de : en;
}

export function pickLang(locale: string): Lang {
  return locale.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function formatBytes(n: number, lang: Lang) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return `${v.toLocaleString(lang === 'de' ? 'de-DE' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[i]}`;
}
