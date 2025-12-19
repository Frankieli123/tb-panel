import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

function b64(buf: Buffer): string {
  return buf.toString('base64');
}

function fromB64(input: string): Buffer {
  return Buffer.from(input, 'base64');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt$${b64(salt)}$${b64(key)}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  if (parts[0] !== 'scrypt') return false;

  const salt = fromB64(parts[1]);
  const key = fromB64(parts[2]);
  const derived = scryptSync(password, salt, key.length);
  return timingSafeEqual(key, derived);
}
