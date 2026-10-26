// Two simulated devices pair through the relay and push a text, a 9 MB file
// (three chunks) and an offline drop through it. Run with:
//   node scripts/e2e-core.ts [server]
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoom, publishPairing, redeemPairing, PortalClient, type Announce } from '../src/core/client.ts';
import { formatCode, newId, newSecret } from '../src/core/crypto.ts';

const server = process.argv[2] ?? 'http://127.0.0.1:8787';
const dir = await mkdtemp(join(tmpdir(), 'zack-e2e-'));
const ok = (label: string) => console.log(`  ✓ ${label}`);
const fail = (label: string): never => {
  console.error(`  ✗ ${label}`);
  process.exit(1);
};
const until = <T>(emitter: PortalClient, event: string, pred: (...a: any[]) => T | undefined, ms = 15000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const h = (...a: any[]) => {
      const v = pred(...a);
      if (v !== undefined) {
        clearTimeout(t);
        emitter.off(event as any, h);
        resolve(v);
      }
    };
    emitter.on(event as any, h);
  });

console.log(`relay ${server}`);
const room = await createRoom(server);
ok(`room ${room.roomId.slice(0, 6)}…`);

const mac = new PortalClient(room, { id: newId(), name: 'Studio Mac', platform: 'mac', secret: newSecret() });
mac.start();
await until(mac, 'connection', (v) => (v ? true : undefined));
ok('mac online');

const { code } = await publishPairing(room, { name: 'Studio Mac', platform: 'mac' });
ok(`pairing code ${formatCode(code)}`);
const payload = await redeemPairing(server, code.toLowerCase().replace(/^(.{4})/, '$1-'));
if (payload.room.key !== room.key) fail('room key mismatch after pairing');
ok('code redeemed, room key matches');
try {
  await redeemPairing(server, code);
  fail('code should be one-shot');
} catch (e: any) {
  if (e.code !== 'unknown_code') throw e;
  ok('code is one-shot');
}

const winId = newId();
const winSecret = newSecret();
const joined = until(mac, 'joined', (d) => d);
const win = new PortalClient(payload.room, { id: winId, name: 'Gaming PC', platform: 'win', secret: winSecret });
win.start();
const joinedDev = await joined;
if (joinedDev.id !== winId) fail('joined event for wrong device');
ok(`mac saw "${joinedDev.name}" join`);
await until(mac, 'presence', (devs) => (devs.some((d: any) => d.id === winId && d.online) ? true : undefined));
ok('presence shows pc online');

// text
const gotText = until<Announce>(win, 'announce', (a) => a);
const sentText = await mac.sendText('hallo von drüben 👋', 'text', null);
const a1 = await gotText;
if (a1.meta.text !== 'hallo von drüben 👋' || a1.chunks !== 0) fail('text mismatch');
ok(`text arrived (${sentText.online}/${sentText.recipients} online)`);
const delivered = until(mac, 'delivered', (id) => (id === a1.id ? true : undefined));
win.ack(a1.id);
await delivered;
ok('sender got delivered receipt');

// file
const src = join(dir, 'clip.bin');
const payloadBytes = randomBytes(9 * 1024 * 1024 + 1234);
await writeFile(src, payloadBytes);
const gotFile = until<Announce>(win, 'announce', (a) => (a.meta.kind === 'file' ? a : undefined));
const ready = new Set<string>();
win.on('ready', (id) => ready.add(id));
let remoteMax = 0;
win.on('remote-progress', (_id, p) => (remoteMax = Math.max(remoteMax, p)));
const sending = mac.sendFile(src, { kind: 'file', name: 'clip.bin', mime: 'application/octet-stream' }, null, () => {});
const a2 = await gotFile;
ok(`announce before upload finished (${a2.chunks} chunks, ready=${a2.ready})`);
await sending;
for (let i = 0; i < 50 && !ready.has(a2.id); i++) await new Promise((r) => setTimeout(r, 100));
if (!ready.has(a2.id)) fail('no ready event');
ok(`ready event, receiver saw progress up to ${Math.round(remoteMax * 100)}%`);
const tmp = await win.download(a2, dir, () => {});
const back = await readFile(tmp);
const h = (b: Buffer) => createHash('sha256').update(b).digest('hex');
if (h(back) !== h(payloadBytes)) fail('file hash mismatch');
ok('file decrypted, sha256 matches');
win.ack(a2.id);

// offline delivery
win.stop();
await until(mac, 'presence', (devs) => (devs.some((d: any) => d.id === winId && !d.online) ? true : undefined));
ok('pc went offline');
const offline = await mac.sendText('https://example.com/while-you-were-away', 'link', null);
if (offline.online !== 0 || offline.recipients !== 1) fail('expected 0 online / 1 recipient');
const win2 = new PortalClient(payload.room, { id: winId, name: 'Gaming PC', platform: 'win', secret: winSecret });
const backlog = until<Announce>(win2, 'announce', (a) => (a.id === offline.id ? a : undefined));
win2.start();
const a3 = await backlog;
ok(`backlog delivered on reconnect: ${a3.meta.text}`);
win2.ack(a3.id);

// wrong key can't read
const evil = new PortalClient({ ...room, key: randomBytes(32).toString('base64') }, { id: newId(), name: 'x', platform: 'linux', secret: newSecret() });
let evilSaw = false;
evil.on('announce', () => (evilSaw = true));
evil.start();
await until(evil, 'connection', (v) => (v ? true : undefined));
await mac.sendText('secret', 'text', null);
await new Promise((r) => setTimeout(r, 800));
if (evilSaw) fail('device with wrong key decrypted a drop');
ok('device with the wrong key sees nothing');

// unauthorized
const res = await fetch(new URL(`/v1/rooms/${room.roomId}/blobs/${newId()}/0`, server), { headers: { authorization: 'Bearer nope' } });
if (res.status !== 401) fail(`expected 401, got ${res.status}`);
ok('bad token rejected');

mac.forget(evil.self.id);
for (const c of [mac, win2, evil]) c.stop();
console.log('all good');
process.exit(0);
