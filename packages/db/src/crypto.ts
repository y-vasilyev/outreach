import sodium from 'libsodium-wrappers';

let ready: Promise<void> | null = null;
async function ensure() {
  if (!ready) ready = sodium.ready;
  await ready;
}

function getKey(): Uint8Array {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENCRYPTION_KEY env is required (32 bytes base64, with optional "base64:" prefix)');
  }
  const b64 = raw.replace(/^base64:/, '');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}. Generate via: openssl rand -base64 32`,
    );
  }
  return new Uint8Array(buf);
}

/** Encrypt a UTF-8 string using XChaCha20-Poly1305-IETF. Returns base64(nonce||ciphertext). */
export async function encryptString(plaintext: string): Promise<string> {
  await ensure();
  const key = getKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    sodium.from_string(plaintext),
    null,
    null,
    nonce,
    key,
  );
  const combined = new Uint8Array(nonce.length + ct.length);
  combined.set(nonce, 0);
  combined.set(ct, nonce.length);
  return Buffer.from(combined).toString('base64');
}

export async function decryptString(payload: string): Promise<string> {
  await ensure();
  const key = getKey();
  const buf = new Uint8Array(Buffer.from(payload, 'base64'));
  const nonceLen = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const nonce = buf.slice(0, nonceLen);
  const ct = buf.slice(nonceLen);
  const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    ct,
    null,
    nonce,
    key,
  );
  return sodium.to_string(plain);
}

export async function encryptJson(obj: unknown): Promise<string> {
  return encryptString(JSON.stringify(obj));
}

export async function decryptJson<T = unknown>(payload: string): Promise<T> {
  const s = await decryptString(payload);
  return JSON.parse(s) as T;
}
