// Removing a device rotates the portal: the others get a new room sealed under
// the old key, the removed one gets nothing.   node scripts/e2e-rekey.ts [server]
import { createRoom, PortalClient, type Announce } from '../src/core/client.ts';
import { newId } from '../src/core/crypto.ts';

const server = process.argv[2] ?? 'http://127.0.0.1:8787';
const ok = (s: string) => console.log(`  ✓ ${s}`);
const fail = (s: string): never => (console.error(`  ✗ ${s}`), process.exit(1));
const online = (c: PortalClient) => new Promise<void>((r) => (c.online ? r() : c.once('connection', () => r())));

const room = await createRoom(server);
const mac = new PortalClient(room, { id: newId(), name: 'Mac', platform: 'mac' });
const pc = new PortalClient(room, { id: newId(), name: 'PC', platform: 'win' });
const old = new PortalClient(room, { id: newId(), name: 'Old laptop', platform: 'linux' });
for (const c of [mac, pc, old]) c.start();
await Promise.all([mac, pc, old].map(online));
await new Promise((r) => setTimeout(r, 600));
ok('three devices in one portal');

let oldSaw = 0;
old.on('announce', () => oldSaw++);
let forgotten = false;
old.on('forgotten', () => (forgotten = true));
const pcGot = new Promise<Announce>((r) => pc.on('announce', (a) => a.meta.control && r(a)));

mac.forget(old.self.id);
const fresh = await createRoom(server);
const sent = await mac.sendRekey(fresh, [pc.self.id]);
if (sent.recipients !== 1) fail(`rekey should reach exactly one device, reached ${sent.recipients}`);
const a = await pcGot;
if (a.meta.control?.room.roomId !== fresh.roomId || a.meta.control.room.key !== fresh.key) fail('pc got the wrong room');
ok('remaining device received the new room and key');
await new Promise((r) => setTimeout(r, 800));
if (!forgotten) fail('removed device was not told');
if (oldSaw) fail('removed device saw the rekey');
ok('removed device was kicked and saw nothing');

// the removed device comes back to the old room: nothing waiting for it there
const back = new PortalClient(room, { id: old.self.id, name: 'Old laptop', platform: 'linux' });
let backSaw = 0;
back.on('announce', () => backSaw++);
back.start();
await online(back);
await new Promise((r) => setTimeout(r, 1200));
if (backSaw) fail('removed device received something after reconnecting');
ok('reconnecting to the old room yields nothing');

for (const c of [mac, pc, old, back]) c.stop();
console.log('all good');
process.exit(0);
