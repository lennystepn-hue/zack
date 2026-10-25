import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/silkscreen/400.css';
import './settings.css';
import type { Bridge, Device, PairCode, PortalEvent, PortalState, Settings, ThemeId } from '../../../shared/types';
import { mockBridge } from '../lib/mock';
import { createTheme, Loop, THEMES, type Theme } from '../themes';

const bridge: Bridge = (window as unknown as { zack?: Bridge }).zack ?? mockBridge();
const host = (window as unknown as { zackHost?: { onSection(fn: (s: string) => void): void } }).zackHost;

const T = {
  de: {
    tagline: 'Ein Portal zwischen deinen Computern.',
    devicesOnline: (n: number, m: number) => (m ? `${n} von ${m} Geräten online` : 'Noch kein zweites Gerät'),
    e2e: 'Ende-zu-Ende verschlüsselt',
    portal: 'Portal',
    open: 'Neues Portal öffnen',
    openHint: 'Erzeugt einen Code für dein anderes Gerät.',
    enter: 'Code eingeben',
    enterHint: 'Du hast schon ein Portal auf einem anderen Gerät.',
    codeTitle: 'Gib diesen Code auf dem anderen Gerät ein',
    codeSteps: 'Dort: Zack öffnen → Code eingeben. Funktioniert einmal, läuft ab in',
    cancel: 'Abbrechen',
    joining: 'Verbinde…',
    linkedTo: 'Verbunden mit',
    addDevice: 'Gerät hinzufügen',
    thisDevice: 'Dieses Gerät',
    rename: 'Umbenennen',
    online: 'online',
    lastSeen: 'zuletzt',
    remove: 'Entfernen',
    removeConfirm: (n: string) => `${n} entfernen? Das Portal bekommt einen neuen Schlüssel, ${n} kann danach nichts mehr empfangen.`,
    removeNote: 'Wer entfernt wird, verliert sofort den Schlüssel: alle anderen Geräte wechseln automatisch auf einen neuen.',
    look: 'Look',
    sound: 'Sound',
    size: 'Größe',
    language: 'Sprache',
    behaviour: 'Verhalten',
    autoCopyText: 'Text direkt in die Zwischenablage',
    autoCopyImages: 'Bilder in die Zwischenablage',
    autoOpenLinks: 'Links sofort im Browser öffnen',
    summonOnReceive: 'Portal einblenden, wenn etwas ankommt',
    alwaysOnTop: 'Immer im Vordergrund',
    launchAtLogin: 'Beim Anmelden starten',
    saveDir: 'Empfangene Dateien',
    change: 'Ändern',
    hotkey: 'Zwischenablage senden',
    off: 'Aus',
    security: 'Sicherheit',
    securityText:
      'Alles wird auf deinem Gerät mit AES-256-GCM verschlüsselt, bevor es losgeht. Der Server sieht weder Inhalte noch Dateinamen. Dateien liegen höchstens 24 Stunden verschlüsselt auf Cloudflare R2 und werden nach der Zustellung sofort gelöscht.',
    relay: 'Relay',
    leave: 'Portal auf diesem Gerät verlassen',
    leaveConfirm: 'Dieses Gerät aus dem Portal entfernen?',
    errors: { bad_code: 'Das ist kein gültiger Code.', unknown_code: 'Code unbekannt oder abgelaufen.', network: 'Keine Verbindung zum Relay.' } as Record<string, string>,
    ago: (m: number) => (m < 1 ? 'gerade eben' : m < 60 ? `vor ${m} Min.` : m < 1440 ? `vor ${Math.round(m / 60)} Std.` : `vor ${Math.round(m / 1440)} T.`),
  },
  en: {
    tagline: 'A portal between your computers.',
    devicesOnline: (n: number, m: number) => (m ? `${n} of ${m} devices online` : 'No second device yet'),
    e2e: 'End-to-end encrypted',
    portal: 'Portal',
    open: 'Open a new portal',
    openHint: 'Makes a code for your other computer.',
    enter: 'Enter a code',
    enterHint: 'You already have a portal on another computer.',
    codeTitle: 'Enter this code on your other computer',
    codeSteps: 'There: open Zack → Enter a code. Works once, expires in',
    cancel: 'Cancel',
    joining: 'Linking…',
    linkedTo: 'Linked with',
    addDevice: 'Add a device',
    thisDevice: 'This computer',
    rename: 'Rename',
    online: 'online',
    lastSeen: 'seen',
    remove: 'Remove',
    removeConfirm: (n: string) => `Remove ${n}? The portal gets a new key and ${n} won't be able to receive anything.`,
    removeNote: 'A removed device loses the key at once: every other device switches to a new one automatically.',
    look: 'Look',
    sound: 'Sound',
    size: 'Size',
    language: 'Language',
    behaviour: 'Behaviour',
    autoCopyText: 'Put text straight on the clipboard',
    autoCopyImages: 'Put images on the clipboard',
    autoOpenLinks: 'Open links in the browser right away',
    summonOnReceive: 'Show the portal when something arrives',
    alwaysOnTop: 'Always on top',
    launchAtLogin: 'Start at login',
    saveDir: 'Received files',
    change: 'Change',
    hotkey: 'Send clipboard',
    off: 'Off',
    security: 'Security',
    securityText:
      'Everything is encrypted on your device with AES-256-GCM before it leaves. The server never sees contents or file names. Files sit encrypted on Cloudflare R2 for at most 24 hours and are deleted the moment they are delivered.',
    relay: 'Relay',
    leave: 'Leave the portal on this computer',
    leaveConfirm: 'Remove this computer from the portal?',
    errors: { bad_code: "That isn't a valid code.", unknown_code: 'Unknown or expired code.', network: "Can't reach the relay." } as Record<string, string>,
    ago: (m: number) => (m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`),
  },
};

let state: PortalState;
let code: PairCode | null = null;
let joinMode = false;
let joinError = '';
let linkedName = '';
let busy = false;
const app = document.getElementById('app')!;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const t = () => T[state.lang];
const mac = () => state.platform === 'mac';

const HOTKEYS = ['CommandOrControl+Alt+Z', 'CommandOrControl+Shift+Y', 'Alt+Shift+Space', ''];
function keyLabel(k: string) {
  if (!k) return t().off;
  if (mac()) return k.replace('CommandOrControl', '⌘').replace('Alt', '⌥').replace('Shift', '⇧').replace('Space', 'Space').replace(/\+/g, '');
  return k.replace('CommandOrControl', state.lang === 'de' ? 'Strg' : 'Ctrl');
}

function platformBadge(p: Device['platform']) {
  return `<span class="os os-${p}">${p === 'mac' ? 'macOS' : p === 'win' ? 'Windows' : 'Linux'}</span>`;
}

// ── skeleton ────────────────────────────────────────────────────────────────

function skeleton() {
  app.innerHTML = `
    <div class="titlebar"></div>
    <header class="top">
      <div class="mark">zack<span>.</span></div>
      <div class="sub" id="sub"></div>
    </header>
    <section id="pair"><h2 data-t="portal"></h2><div id="pairBody"></div></section>
    <section id="look">
      <h2 data-t="look"></h2>
      <div class="themes">${THEMES.map((th) => `<button class="theme" data-theme="${th.id}"><div class="pv"></div><b>${th.name}</b><small data-tag="${th.id}"></small></button>`).join('')}</div>
      <div class="row"><span data-t="sound"></span><label class="switch"><input type="checkbox" data-set="sound"><i></i></label></div>
      <div class="row"><span data-t="size"></span><div class="seg" id="size">${[0.8, 1, 1.25].map((v) => `<button data-scale="${v}">${v === 0.8 ? 'S' : v === 1 ? 'M' : 'L'}</button>`).join('')}</div></div>
      <div class="row"><span data-t="language"></span><div class="seg" id="language"><button data-lang="auto">Auto</button><button data-lang="de">Deutsch</button><button data-lang="en">English</button></div></div>
    </section>
    <section id="behaviour">
      <h2 data-t="behaviour"></h2>
      ${(['autoCopyText', 'autoCopyImages', 'autoOpenLinks', 'summonOnReceive', 'alwaysOnTop', 'launchAtLogin'] as const)
        .map((k) => `<div class="row"><span data-t="${k}"></span><label class="switch"><input type="checkbox" data-set="${k}"><i></i></label></div>`)
        .join('')}
      <div class="row"><span data-t="hotkey"></span><div class="seg keys" id="hotkey"></div></div>
      <div class="row path"><div><span data-t="saveDir"></span><code id="saveDir"></code></div><button class="ghost" id="chooseDir" data-t="change"></button></div>
    </section>
    <section id="security">
      <h2 data-t="security"></h2>
      <p class="note" data-t="securityText"></p>
      <div class="row small"><span data-t="relay"></span><code id="relay"></code></div>
      <button class="danger" id="leave" data-t="leave"></button>
    </section>
    <footer id="foot"></footer>`;

  app.addEventListener('click', onClick);
  app.addEventListener('change', onChange);
  app.addEventListener('input', onInput);
  app.addEventListener('keydown', onKey);
  mountPreviews();
}

const previews: { theme: Theme; loop: Loop }[] = [];

function mountPreviews() {
  app.querySelectorAll<HTMLElement>('.theme').forEach((card) => {
    const pv = card.querySelector('.pv') as HTMLElement;
    const inner = document.createElement('div');
    inner.className = 'pv-inner';
    pv.appendChild(inner);
    const id = card.dataset.theme as ThemeId;
    const theme = createTheme(id);
    // each look has its weight somewhere else: the pipe stands low, the rift drips sparks
    const S = 0.5;
    const center = { singularity: 126, rift: 140, warp: 150, toaster: 140, liquid: 140, monster: 140 }[id];
    inner.style.transform = `translate(-50%, ${Math.round(60 - center * S)}px) scale(${S})`;
    theme.attach(inner, { w: 260, h: 250, cx: 130, cy: 126, R: 82, dpr: Math.min(2, devicePixelRatio) * S });
    const loop = new Loop();
    loop.set(theme);
    previews.push({ theme, loop });
    card.addEventListener('mouseenter', () => theme.setMood('hover'));
    card.addEventListener('mouseleave', () => theme.setMood('idle'));
  });
}

// ── render ──────────────────────────────────────────────────────────────────

function render() {
  const L = t();
  document.documentElement.lang = state.lang;
  document.body.dataset.platform = state.platform;
  app.querySelectorAll<HTMLElement>('[data-t]').forEach((el) => {
    const v = (L as Record<string, unknown>)[el.dataset.t!];
    if (typeof v === 'string') el.textContent = v;
  });
  app.querySelectorAll<HTMLElement>('[data-tag]').forEach((el) => (el.textContent = THEMES.find((x) => x.id === el.dataset.tag)!.tagline[state.lang]));

  const others = state.devices.filter((d) => d.id !== state.self.id);
  const sub = document.getElementById('sub')!;
  sub.innerHTML = state.paired
    ? `<i class="dot ${state.connected ? (others.some((d) => d.online) ? 'on' : 'away') : 'off'}"></i>${esc(L.devicesOnline(others.filter((d) => d.online).length, others.length))} <span class="lock">· ${L.e2e}</span>`
    : esc(L.tagline);

  renderPair();

  const s = state.settings;
  app.querySelectorAll<HTMLButtonElement>('.theme').forEach((b) => b.classList.toggle('on', b.dataset.theme === s.theme));
  app.querySelectorAll<HTMLInputElement>('input[data-set]').forEach((i) => (i.checked = !!s[i.dataset.set as keyof Settings]));
  app.querySelectorAll<HTMLButtonElement>('#size button').forEach((b) => b.classList.toggle('on', Number(b.dataset.scale) === s.scale));
  app.querySelectorAll<HTMLButtonElement>('#language button').forEach((b) => b.classList.toggle('on', b.dataset.lang === (s.language ?? 'auto')));
  document.getElementById('hotkey')!.innerHTML = HOTKEYS.map((k) => `<button data-hotkey="${k}" class="${k === s.hotkey ? 'on' : ''}">${esc(keyLabel(k))}</button>`).join('');
  document.getElementById('saveDir')!.textContent = s.saveDir;
  document.getElementById('relay')!.textContent = state.server.replace(/^https?:\/\//, '');
  (document.getElementById('leave') as HTMLButtonElement).hidden = !state.paired;
  const login = app.querySelector<HTMLElement>('input[data-set="launchAtLogin"]')!.closest('.row') as HTMLElement;
  login.hidden = state.platform === 'linux';
  document.getElementById('foot')!.textContent = `Zack ${state.version} · ${state.self.name}`;
}

function renderPair() {
  const L = t();
  const body = document.getElementById('pairBody')!;

  if (linkedName) {
    body.innerHTML = `<div class="linked"><div class="burst"></div><b>${esc(L.linkedTo)} ${esc(linkedName)}</b></div>`;
    return;
  }

  if (code) {
    const left = Math.max(0, code.expires - Date.now());
    const mm = Math.floor(left / 60000);
    const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, '0');
    body.innerHTML = `
      <div class="code-card">
        <small>${esc(L.codeTitle)}</small>
        <div class="code">${code.code.split('').map((c) => (c === '-' ? '<i></i>' : `<span>${esc(c)}</span>`)).join('')}</div>
        <p>${esc(L.codeSteps)} <b class="mono">${mm}:${ss}</b></p>
        <div class="waiting"><span></span><span></span><span></span></div>
        <button class="ghost" data-act="cancel-code">${esc(L.cancel)}</button>
      </div>`;
    return;
  }

  if (!state.paired || joinMode) {
    body.innerHTML = `
      <div class="choices">
        <button class="choice ${joinMode ? '' : 'primary'}" data-act="create">
          <b>${esc(L.open)}</b><small>${esc(L.openHint)}</small>
        </button>
        <div class="choice join ${joinMode ? 'active' : ''}">
          <b>${esc(L.enter)}</b><small>${esc(L.enterHint)}</small>
          <input id="joinInput" maxlength="9" spellcheck="false" autocomplete="off" placeholder="XXXX-XXXX" ${busy ? 'disabled' : ''} />
          <em class="err">${esc(joinError)}</em>
        </div>
      </div>`;
    return;
  }

  const devices = [...state.devices].sort((a, b) => (a.id === state.self.id ? -1 : b.id === state.self.id ? 1 : 0));
  body.innerHTML = `
    <ul class="devices">
      ${devices
        .map((d) => {
          const self = d.id === state.self.id;
          const mins = Math.round((Date.now() - d.lastSeen) / 60000);
          const status = self ? L.thisDevice : d.online ? L.online : `${L.lastSeen} ${L.ago(mins)}`;
          return `<li>
            <i class="dot ${self || d.online ? 'on' : 'off'}"></i>
            <div class="who"><b ${self ? 'contenteditable="plaintext-only" spellcheck="false" id="selfName"' : ''}>${esc(d.name)}</b><small>${platformBadge(d.platform)} · ${esc(status)}</small></div>
            ${self ? '' : `<button class="ghost small" data-forget="${esc(d.id)}" data-name="${esc(d.name)}">${esc(L.remove)}</button>`}
          </li>`;
        })
        .join('')}
    </ul>
    <button class="add" data-act="create">+ ${esc(L.addDevice)}</button>
    <p class="note">${esc(L.removeNote)}</p>`;
}

// ── interaction ─────────────────────────────────────────────────────────────

async function onClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  const btn = el.closest('button') as HTMLButtonElement | null;
  if (el.closest('.choice.join') && !btn) {
    if (!joinMode) {
      joinMode = true;
      renderPair();
      (document.getElementById('joinInput') as HTMLInputElement)?.focus();
    }
    return;
  }
  if (!btn) return;
  if (btn.dataset.theme) return bridge.setSettings({ theme: btn.dataset.theme as ThemeId });
  if (btn.dataset.scale) return bridge.setSettings({ scale: Number(btn.dataset.scale) });
  if (btn.dataset.lang) return bridge.setSettings({ language: btn.dataset.lang as Settings['language'] });
  if (btn.dataset.hotkey !== undefined) return bridge.setSettings({ hotkey: btn.dataset.hotkey });
  if (btn.dataset.forget) {
    if (confirm(t().removeConfirm(btn.dataset.name ?? ''))) await bridge.forget(btn.dataset.forget);
    return;
  }
  switch (btn.dataset.act ?? btn.id) {
    case 'create':
      joinMode = false;
      code = await bridge.createCode();
      startTicker();
      renderPair();
      return;
    case 'cancel-code':
      code = null;
      await bridge.cancelCode();
      renderPair();
      return;
    case 'chooseDir':
      await bridge.chooseSaveDir();
      return;
    case 'leave':
      if (confirm(t().leaveConfirm)) await bridge.unpair();
      return;
  }
}

function onChange(e: Event) {
  const i = e.target as HTMLInputElement;
  if (i.dataset.set) void bridge.setSettings({ [i.dataset.set]: i.checked } as Partial<Settings>);
}

async function onInput(e: Event) {
  const i = e.target as HTMLInputElement;
  if (i.id !== 'joinInput') return;
  const raw = i.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  i.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
  joinError = '';
  i.parentElement!.querySelector('.err')!.textContent = '';
  if (raw.length === 8) {
    busy = true;
    i.disabled = true;
    const r = await bridge.join(raw);
    busy = false;
    if (!r.ok) {
      joinError = t().errors[r.error] ?? r.error;
      renderPair();
      const again = document.getElementById('joinInput') as HTMLInputElement;
      again.value = i.value;
      again.focus();
      again.select();
    }
  }
}

function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (el.id === 'selfName' && e.key === 'Enter') {
    e.preventDefault();
    el.blur();
  }
}

app.addEventListener('focusout', (e) => {
  const el = e.target as HTMLElement;
  if (el.id === 'selfName') {
    const name = el.textContent?.trim() ?? '';
    if (name && name !== state.self.name) void bridge.rename(name);
    else el.textContent = state.self.name;
  }
});

let ticker: ReturnType<typeof setInterval> | null = null;
function startTicker() {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => {
    if (!code) return void (ticker && clearInterval(ticker));
    if (code.expires < Date.now()) code = null;
    renderPair();
  }, 1000);
}

function onEvent(e: PortalEvent) {
  if (e.type === 'state') {
    state = e.state;
    // don't fight the user while they edit their own name
    if (document.activeElement?.id === 'selfName') return;
    render();
  }
  if (e.type === 'pair-code') {
    code = e.code;
    renderPair();
  }
  if (e.type === 'linked') {
    code = null;
    joinMode = false;
    linkedName = e.device.name;
    previews.forEach((p) => p.theme.ignite());
    renderPair();
    setTimeout(() => {
      linkedName = '';
      renderPair();
    }, 3200);
  }
  if (e.type === 'theme') {
    state.settings.theme = e.theme;
    render();
  }
}

async function start() {
  state = await bridge.getState();
  skeleton();
  render();
  bridge.on(onEvent);
  const jump = (section: string) => document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (location.hash) jump(location.hash.slice(1));
  host?.onSection(jump);
}

void start();
