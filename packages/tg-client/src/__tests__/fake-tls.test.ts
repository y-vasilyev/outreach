import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildFakeTlsClientHello,
  parseFakeTlsSecret,
  wrapTlsApplicationData,
  TLS_TYPE_APPLICATION_DATA,
} from '../connection/fake-tls.js';

// Snapshot captured by 9seconds/mtg v2.2.4 from a real Telegram client.
// Secret comes from the mtg test suite — see client_side_snapshot_test.go.
const MTG_SECRET_HEX =
  'ee367a189aee18fa31c190054efd4a8e9573746f726167652e676f6f676c65617069732e636f6d';

interface Snapshot {
  time: number;
  random: string;
  sessionId: string;
  host: string;
  cipherSuite: number;
  full: string;
}

function loadSnapshot(): Snapshot {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, 'fake-tls-snapshot.json'), 'utf8');
  return JSON.parse(raw) as Snapshot;
}

describe('parseFakeTlsSecret', () => {
  it('decodes ee-prefixed secret into 16-byte key + UTF-8 host', () => {
    const parsed = parseFakeTlsSecret(MTG_SECRET_HEX);
    expect(parsed).not.toBeNull();
    expect(parsed!.key.length).toBe(16);
    expect(parsed!.host).toBe('storage.googleapis.com');
  });

  it('rejects non-ee secrets', () => {
    expect(parseFakeTlsSecret('deadbeef'.repeat(4))).toBeNull(); // raw 32 hex
    expect(parseFakeTlsSecret('dd' + 'aa'.repeat(16))).toBeNull(); // dd-prefixed
    expect(parseFakeTlsSecret('not-hex')).toBeNull();
  });
});

describe('buildFakeTlsClientHello', () => {
  it('produces exactly 517 bytes', () => {
    const secret = parseFakeTlsSecret(MTG_SECRET_HEX)!;
    const hello = buildFakeTlsClientHello(secret);
    expect(hello.length).toBe(517);
    // Record header + handshake header are deterministic
    expect(hello.subarray(0, 11).toString('hex')).toBe('1603010200010001fc0303');
  });

  it('reproduces the captured ClientHello byte-for-byte given fixed inputs', () => {
    const snap = loadSnapshot();
    const secret = parseFakeTlsSecret(MTG_SECRET_HEX)!;
    const fullExpected = Buffer.from(snap.full, 'base64');
    const sessionId = Buffer.from(snap.sessionId, 'base64');
    // The 32-byte X25519 key share lives at offset 187 in the message body for
    // the canonical template (right after the `0033 0026 0024 001d 0020`
    // key_share header — that's at extension offset 187 once you account for
    // the bytes that come before it).
    const keyShareOffset = findKeyShareOffset(fullExpected);
    const keyShare = fullExpected.subarray(keyShareOffset, keyShareOffset + 32);

    const hello = buildFakeTlsClientHello(secret, {
      sessionId,
      keyShare,
      timestampUnix: snap.time,
    });
    expect(hello.length).toBe(517);

    // The HMAC-derived random must match exactly.
    const expectedRandom = Buffer.from(snap.random, 'base64');
    expect(hello.subarray(11, 43).toString('hex')).toBe(expectedRandom.toString('hex'));

    // Whole message should match if our template is byte-identical to mtg's.
    expect(hello.toString('hex')).toBe(fullExpected.toString('hex'));
  });
});

describe('wrapTlsApplicationData', () => {
  it('emits a single 17 03 03 record for sub-16K payloads', () => {
    const wrapped = wrapTlsApplicationData(Buffer.from([1, 2, 3, 4]));
    expect(wrapped.length).toBe(5 + 4);
    expect(wrapped[0]).toBe(TLS_TYPE_APPLICATION_DATA);
    expect(wrapped[1]).toBe(0x03);
    expect(wrapped[2]).toBe(0x03);
    expect(wrapped.readUInt16BE(3)).toBe(4);
  });

  it('chunks payloads larger than 16379 bytes into multiple records', () => {
    const big = Buffer.alloc(16379 * 2 + 7);
    const wrapped = wrapTlsApplicationData(big);
    // 3 records: 16379 + 16379 + 7
    expect(wrapped.length).toBe(5 * 3 + big.length);
  });
});

function findKeyShareOffset(buf: Buffer): number {
  // Look for the 0x0033 0x0026 0x0024 0x001d 0x0020 prefix and return the
  // offset where the 32-byte ECDHE share begins.
  const prefix = Buffer.from('003300260024001d0020', 'hex');
  const idx = buf.indexOf(prefix);
  if (idx < 0) throw new Error('key_share extension not found in snapshot');
  return idx + prefix.length;
}
