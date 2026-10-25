// Everything that leaves a device is sealed here first.
//
// pairing:  code ──pbkdf2──▶ slot id (what the relay sees)
//           code ──pbkdf2──▶ envelope key (never leaves either screen)
// drops:    room key ──hkdf(drop id)──▶ per-drop AES-256-GCM key
//           meta under a fixed IV, chunk i under IV = 0000‖u64(i)

import { createCipheriv, createDecipheriv, hkdfSync, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

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

/** 8 Crockford characters, 40 bits */
export function newCode() {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 8; i++) {
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
  if (s.length !== 8) return null;
  for (const c of s) if (!CROCKFORD.includes(c)) return null;
  return s;
}

export function formatCode(code: string) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function pairSecrets(code: string) {
  const [slot, key] = await Promise.all([
    pbkdf2Async(code, 'zack/pair-slot/v1', 150_000, 18, 'sha256'),
    pbkdf2Async(code, 'zack/pair-key/v1', 150_000, 32, 'sha256'),
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
