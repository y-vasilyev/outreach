import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // standard for GCM
const TAG_LEN = 16;

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY env is required (32 bytes base64, with optional "base64:" prefix)',
    );
  }
  const b64 = raw.replace(/^base64:/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}. Generate via: openssl rand -base64 32`,
    );
  }
  return buf;
}

/**
 * Encrypt a UTF-8 string using AES-256-GCM. Returns base64(iv || ciphertext || tag).
 */
export async function encryptString(plaintext: string): Promise<string> {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

export async function decryptString(payload: string): Promise<string> {
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error('encrypted payload too short');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

export async function encryptJson(obj: unknown): Promise<string> {
  return encryptString(JSON.stringify(obj));
}

export async function decryptJson<T = unknown>(payload: string): Promise<T> {
  const s = await decryptString(payload);
  return JSON.parse(s) as T;
}
