// Attacks from the security review, each of which must fail.
//   node scripts/e2e-security.ts [relay]
import { createRoom, PortalClient } from '../src/core/client.ts';
import { newId, newSecret } from '../src/core/crypto.ts';

const server = process.argv[2] ?? 'http://127.0.0.1:8787';
const ok = (s: string) => console.log(`  ✓ ${s}`);
const fail = (s: string): never => (console.error(`  ✗ ${s}`), process.exit(1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A raw socket, to try what the real client would never send. Resolves with what happened. */
function raw(room: { roomId: string; token: string }, id: string, secret: string | null, opts: { name?: string; onOpen?: (ws: WebSocket) => void } = {}) {
  const url = new URL(`/v1/rooms/${room.roomId}/ws`, server);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('d', id);
  url.searchParams.set('n', opts.name ?? 'x');
  url.searchParams.set('p', 'linux');
  const protos = ['zack.v1', `auth.${room.token}`, ...(secret ? [`dev.${secret}`] : [])];
  return new Promise<{ opened: boolean; closeCode?: number; messages: any[] }>((resolve) => {
    const ws = new WebSocket(url, protos);
    const messages: any[] = [];
    let opened = false;
    ws.addEventListener('open', () => {
      opened = true;
      opts.onOpen?.(ws);
    });
    ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
    ws.addEventListener('close', (e) => resolve({ opened, closeCode: e.code, messages }));
    ws.addEventListener('error', () => {});
    setTimeout(() => {
      ws.close();
      resolve({ opened, messages });
    }, 2500);
  });
}

const room = await createRoom(server);
const mac = new PortalClient(room, { id: newId(), name: 'Studio Mac', platform: 'mac', secret: newSecret() });
const pc = new PortalClient(room, { id: newId(), name: 'Gaming PC', platform: 'win', secret: newSecret() });
mac.start();
pc.start();
await sleep(1500);
if (!mac.online || !pc.online) fail('devices did not come online');

// 1. names reach the relay sealed
const peek = await raw(room, newId(), newSecret());
const listed = peek.messages.find((m) => m.t === 'welcome')?.devices ?? [];
if (!listed.length || listed.some((d: any) => d.name.includes('Studio') || d.name.includes('Gaming'))) fail('device names readable on the relay');
if (!mac.devices.some((d) => d.name === 'Gaming PC')) fail('peers can no longer read the names');
ok('device names are sealed on the relay, readable to the portal');

// 2. posing as another device with the wrong secret
const fake = await raw(room, pc.self.id, newSecret());
if (fake.opened) fail('connected as the PC without its secret');
await sleep(300);
if (!pc.online) fail('the impostor kicked the real PC out');
ok('posing as another device is refused, the real one stays connected');

// 3. uploading or fetching chunks that were never announced
const put = await fetch(new URL(`/v1/rooms/${room.roomId}/blobs/${newId()}/0`, server), {
  method: 'PUT',
  headers: { authorization: `Bearer ${room.token}` },
  body: new Uint8Array(1024),
});
if (put.status !== 409) fail(`unannounced upload answered ${put.status}`);
const get = await fetch(new URL(`/v1/rooms/${room.roomId}/blobs/${newId()}/0`, server), { headers: { authorization: `Bearer ${room.token}` } });
if (get.status !== 404) fail(`unannounced download answered ${get.status}`);
ok('chunks of unannounced drops can be neither stored nor fetched');

// 4. flooding the relay with messages
const flood = await raw(room, newId(), newSecret(), {
  onOpen: (ws) => {
    for (let i = 0; i < 260; i++) ws.send(JSON.stringify({ t: 'progress', id: newId(), p: 0.5 }));
  },
});
if (flood.closeCode !== 4008) fail(`a flooding socket was not cut off (close ${flood.closeCode})`);
ok('a socket that floods the relay is cut off');

// 5. after a removal, the old portal takes nobody new, and the removed one stays out
const victimSecret = newSecret();
const victim = new PortalClient(room, { id: newId(), name: 'Old laptop', platform: 'linux', secret: victimSecret });
victim.start();
await sleep(1500);
mac.forget(victim.self.id);
await sleep(800);
if (victim.online) fail('removed device still connected');
const back = await raw(room, victim.self.id, victimSecret);
if (back.opened) fail('removed device got back in with its own secret');
const newcomer = await raw(room, newId(), newSecret());
if (newcomer.opened) fail('a new device joined a portal that had a removal');
ok('removed devices stay out; the portal is locked for newcomers');

for (const c of [mac, pc, victim]) c.stop();
console.log('all good');
process.exit(0);
