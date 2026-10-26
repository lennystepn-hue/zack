// Everything that leaves a device is sealed here first.
//
// pairing:  code ──scrypt──▶ slot id (what the relay sees)
//           code ──scrypt──▶ envelope key (never leaves either screen)
// names:    room key ──hkdf──▶ key for device names (the relay stores them sealed)
// drops:    room key ──hkdf(drop id)──▶ per-drop AES-256-GCM key
//           meta under a fixed IV, chunk i under IV = 0000‖u64(i)

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt } from 'node:crypto';

// memory-hard, so the 60-bit code can't be ground through on GPUs:
// 32 MiB and ~80 ms per guess, for the relay operator as much as anyone
const scryptAsync = (pw: string, salt: string, len: number) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, len, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));

export const CHUNK_SIZE = 4 * 1024 * 1024;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const META_IV = Buffer.from('ffffffff0000000000000000', 'hex');

export function b64url(buf: Uint8Array) {
  return Buffer.from(buf).toString('base64url');
}

export function newId() {
  return b64url(randomBytes(16));
}

export function newRoomKey() {
  return randomBytes(32).toString('base64');
}

export const CODE_LENGTH = 12;

/** 12 Crockford characters, 60 bits */
export function newCode() {
  const bytes = randomBytes(8);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out;
}

/** Accepts what people actually type: lowercase, dashes, O for 0, I/L for 1 */
export function normalizeCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!CROCKFORD.includes(c)) return null;
  return s;
}

export function formatCode(code: string) {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

export async function pairSecrets(code: string) {
  const [slot, key] = await Promise.all([
    scryptAsync(code, 'zack/pair-slot/v2', 18),
    scryptAsync(code, 'zack/pair-key/v2', 32),
  ]);
  return { slot: b64url(slot), key };
}

export function seal(key: Buffer, iv: Buffer, plain: Uint8Array, aad: string) {
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

export function open(key: Buffer, iv: Buffer, sealed: Uint8Array, aad: string) {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
}

export function sealEnvelope(key: Buffer, value: unknown) {
  const iv = randomBytes(12);
  return Buffer.concat([iv, seal(key, iv, Buffer.from(JSON.stringify(value)), 'zack/envelope')]).toString('base64');
}

export function openEnvelope<T>(key: Buffer, envelope: string): T {
  const raw = Buffer.from(envelope, 'base64');
  return JSON.parse(open(key, raw.subarray(0, 12), raw.subarray(12), 'zack/envelope').toString('utf8'));
}

export function dropKey(roomKey: string, dropId: string) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(roomKey, 'base64'), Buffer.from(dropId), 'zack/drop/v1', 32));
}

function chunkIv(index: number) {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(index), 4);
  return iv;
}

export function sealMeta(key: Buffer, dropId: string, meta: unknown) {
  return seal(key, META_IV, Buffer.from(JSON.stringify(meta)), `${dropId}:meta`).toString('base64');
}

export function openMeta<T>(key: Buffer, dropId: string, env: string): T {
  return JSON.parse(open(key, META_IV, Buffer.from(env, 'base64'), `${dropId}:meta`).toString('utf8'));
}

export function sealChunk(key: Buffer, dropId: string, index: number, plain: Uint8Array) {
  return seal(key, chunkIv(index), plain, `${dropId}:${index}`);
}

export function openChunk(key: Buffer, dropId: string, index: number, sealed: Uint8Array) {
  return open(key, chunkIv(index), sealed, `${dropId}:${index}`);
}

export function newSecret() {
  return b64url(randomBytes(24));
}

function nameKey(roomKey: string) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(roomKey, 'base64'), Buffer.from('names'), 'zack/name/v1', 32));
}

/** A device name as the relay keeps it: sealed, base64url. */
export function sealName(roomKey: string, name: string) {
  const iv = randomBytes(12);
  return 's1.' + b64url(Buffer.concat([iv, seal(nameKey(roomKey), iv, Buffer.from(name), 'zack/name')]));
}

/** Names from older clients are plain; sealed ones that don't open are shown as unknown. */
export function openName(roomKey: string, stored: string) {
  if (!stored.startsWith('s1.')) return stored;
  try {
    const raw = Buffer.from(stored.slice(3), 'base64url');
    return open(nameKey(roomKey), raw.subarray(0, 12), raw.subarray(12), 'zack/name').toString('utf8').slice(0, 48);
  } catch {
    return '?';
  }
}
