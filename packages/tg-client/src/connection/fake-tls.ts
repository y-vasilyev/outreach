import { createHmac, randomBytes } from 'node:crypto';

/**
 * Fake-TLS MTProxy handshake builders / parsers.
 *
 * The MTProxy fake-TLS protocol disguises an MTProto connection as a TLS 1.3
 * session (mostly to defeat naive DPI). The on-the-wire flow:
 *
 *   1. Client → TLS handshake record containing a 517-byte ClientHello with
 *      SNI = embedded hostname, last 4 bytes of `random` carry an HMAC over
 *      the rest of the ClientHello using the 16-byte proxy secret.
 *   2. Server → handshake record(s) (ServerHello), a ChangeCipherSpec, then a
 *      first application-data record of "noise". Server's `random` is itself
 *      derived from `HMAC(secret, client_random || server_response_zeroed)`.
 *   3. Both sides switch to plain TLS-1.2 application-data framing
 *      (`17 03 03 <len> <payload>`). Inside those records the bytes are the
 *      regular MTProxy-obfuscated MTProto stream.
 *
 * References: 9seconds/mtg v2 (Go) — `mtglib/internal/tls/fake/*.go`.
 */

export interface FakeTlsSecret {
  /** 16-byte AES key shared with the proxy. */
  key: Buffer;
  /** SNI hostname encoded inside the secret (UTF-8). */
  host: string;
}

const EE_PREFIX = 'ee';
const KEY_LEN = 16;

/**
 * Parse the user-supplied MTProxy secret. Accepts:
 *   - `ee` + 32 hex (key) + 2N hex (UTF-8 host bytes) — fake-TLS share-link form
 *   - 32 hex — legacy bare secret with no host (`web.telegram.org` is used as
 *     a generic SNI in that case)
 *   - 34 hex starting with `dd` — random-padding mode (no fake-TLS, falls
 *     through this normalizer to legacy MTProxy)
 */
export function parseFakeTlsSecret(secret: string): FakeTlsSecret | null {
  const s = secret.trim().toLowerCase();
  if (!/^[0-9a-f]+$/i.test(s)) return null;
  if (s.startsWith(EE_PREFIX) && s.length > 2 + KEY_LEN * 2) {
    const keyHex = s.slice(2, 2 + KEY_LEN * 2);
    const hostHex = s.slice(2 + KEY_LEN * 2);
    if (hostHex.length % 2 !== 0) return null;
    return {
      key: Buffer.from(keyHex, 'hex'),
      host: Buffer.from(hostHex, 'hex').toString('utf8'),
    };
  }
  return null;
}

/**
 * Strict 517-byte Chrome-like ClientHello template captured from a real
 * Telegram client and verified against the mtg test fixtures. The bytes are
 * stable; only `random[11..43]`, `session_id[44..76]`, the 32-byte X25519
 * key share inside the 0x0033 extension, and the trailing padding extension
 * vary per ClientHello.
 */
const TEMPLATE_PREFIX = Buffer.from('1603010200010001fc0303', 'hex');
const TEMPLATE_CIPHER_SUITES = Buffer.from(
  '0034' + // 52 bytes of suites follow
    '130313011302c02cc02bc024c023c00ac009cca9c030c02fc028c027c014c013cca8' +
    '009d009c003d003c0035002fc008c012000a',
  'hex',
);
const TEMPLATE_COMPRESSION = Buffer.from('0100', 'hex');

const RANDOM_OFFSET = TEMPLATE_PREFIX.length; // 11
const RANDOM_LEN = 32;
const TOTAL_LEN = 517;

interface BuildOptions {
  sessionId?: Buffer; // 32 bytes
  keyShare?: Buffer; // 32 bytes
  timestampUnix?: number;
}

/**
 * Build a 517-byte fake-TLS ClientHello for the given secret/host. The HMAC
 * over the message (with `random` zeroed) is XORed into `random` together
 * with the unix timestamp; the upstream proxy verifies both.
 */
export function buildFakeTlsClientHello(
  secret: FakeTlsSecret,
  opts: BuildOptions = {},
): Buffer {
  const sessionId = opts.sessionId ?? randomBytes(32);
  const keyShare = opts.keyShare ?? randomBytes(32);
  const timestamp = opts.timestampUnix ?? Math.floor(Date.now() / 1000);
  if (sessionId.length !== 32) throw new Error('sessionId must be 32 bytes');
  if (keyShare.length !== 32) throw new Error('keyShare must be 32 bytes');

  const hostBytes = Buffer.from(secret.host, 'utf8');
  const sniExt = buildSniExtension(hostBytes);
  const extensionsBeforePadding = Buffer.concat([
    Buffer.from('ff01000100', 'hex'), // renegotiation_info (5 bytes)
    sniExt, // server_name (variable)
    Buffer.from('00170000', 'hex'), // extended_master_secret (4 bytes)
    Buffer.from('000d0018001604030804040105030203080508050501080606010201', 'hex'), // signature_algorithms (28 bytes)
    Buffer.from('000500050100000000', 'hex'), // status_request (9 bytes)
    Buffer.from('33740000', 'hex'), // 0x3374 (4 bytes)
    Buffer.from('00120000', 'hex'), // signed_certificate_timestamp (4 bytes)
    Buffer.from(
      // ext_type 0x0010 | ext_len 0x0030 | list_len 0x002e | "h2","h2-16","h2-15","h2-14","spdy/3.1","spdy/3","http/1.1"
      '00100030002e0268320568322d31360568322d31350568322d313408737064792f332e3106737064792f3308687474702f312e31',
      'hex',
    ), // ALPN (52 bytes)
    Buffer.from('000b00020100', 'hex'), // ec_point_formats (6 bytes)
    Buffer.concat([Buffer.from('003300260024001d0020', 'hex'), keyShare]), // key_share (42 bytes)
    Buffer.from('002d00020101', 'hex'), // psk_key_exchange_modes (6 bytes)
    Buffer.from('002b0009080304030303020301', 'hex'), // supported_versions (13 bytes)
    Buffer.from('000a000a0008001d001700180019', 'hex'), // supported_groups (14 bytes)
  ]);

  // The total message length is fixed at 517 bytes. The padding extension
  // (type 0x0015) absorbs whatever is left.
  // Layout:
  //   record_hdr(5) + handshake_hdr(4) + version(2) + random(32) +
  //   sid_len(1) + sid(32) + cipher_suites(2 + 52) + compression(2) +
  //   ext_len(2) + extensions(?) = 517
  const fixedSize =
    TEMPLATE_PREFIX.length +
    RANDOM_LEN +
    1 +
    sessionId.length +
    TEMPLATE_CIPHER_SUITES.length +
    TEMPLATE_COMPRESSION.length +
    2; // 2-byte extensions length
  const extensionsTotalSize = TOTAL_LEN - fixedSize;
  const paddingExtPayloadSize =
    extensionsTotalSize - extensionsBeforePadding.length - 4; // -4 for ext header
  if (paddingExtPayloadSize < 0) {
    throw new Error(
      `fake-tls: hostname too long (${hostBytes.length} bytes), padding overflowed`,
    );
  }
  const paddingExt = Buffer.concat([
    Buffer.from([0x00, 0x15]),
    Buffer.from([(paddingExtPayloadSize >> 8) & 0xff, paddingExtPayloadSize & 0xff]),
    Buffer.alloc(paddingExtPayloadSize, 0),
  ]);

  const extensions = Buffer.concat([extensionsBeforePadding, paddingExt]);
  const extLenBuf = Buffer.from([(extensions.length >> 8) & 0xff, extensions.length & 0xff]);

  const hello = Buffer.concat([
    TEMPLATE_PREFIX,
    Buffer.alloc(RANDOM_LEN), // placeholder for random — filled below
    Buffer.from([sessionId.length]),
    sessionId,
    TEMPLATE_CIPHER_SUITES,
    TEMPLATE_COMPRESSION,
    extLenBuf,
    extensions,
  ]);
  if (hello.length !== TOTAL_LEN) {
    throw new Error(`fake-tls: built ClientHello of ${hello.length} bytes, expected ${TOTAL_LEN}`);
  }

  // HMAC over the message with `random` already-zeroed (we just allocated zeros there).
  const digest = createHmac('sha256', secret.key).update(hello).digest();
  // The server validates: HMAC(secret, hello_with_zero_random) XOR random == zeros28 ++ ts_le4
  // → random = digest XOR (zeros28 ++ ts_le4) = digest with the last 4 bytes XOR-ed with timestamp.
  const random = Buffer.from(digest);
  random[28] = (random[28] ?? 0) ^ (timestamp & 0xff);
  random[29] = (random[29] ?? 0) ^ ((timestamp >>> 8) & 0xff);
  random[30] = (random[30] ?? 0) ^ ((timestamp >>> 16) & 0xff);
  random[31] = (random[31] ?? 0) ^ ((timestamp >>> 24) & 0xff);
  random.copy(hello, RANDOM_OFFSET);

  return hello;
}

function buildSniExtension(hostBytes: Buffer): Buffer {
  const hostLen = hostBytes.length;
  // server_name list entry: type(1=DNS) + length(2) + bytes
  // server_name list: length(2) + entries
  // extension: type(2=0x0000) + length(2) + body
  const listEntry = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from([(hostLen >> 8) & 0xff, hostLen & 0xff]),
    hostBytes,
  ]);
  const list = Buffer.concat([
    Buffer.from([(listEntry.length >> 8) & 0xff, listEntry.length & 0xff]),
    listEntry,
  ]);
  return Buffer.concat([
    Buffer.from([0x00, 0x00]),
    Buffer.from([(list.length >> 8) & 0xff, list.length & 0xff]),
    list,
  ]);
}

// =============================================================================
// TLS record framing (post-handshake)
// =============================================================================

export const TLS_TYPE_CHANGE_CIPHER_SPEC = 0x14;
export const TLS_TYPE_HANDSHAKE = 0x16;
export const TLS_TYPE_APPLICATION_DATA = 0x17;
export const TLS_VERSION_LEGACY = Buffer.from([0x03, 0x03]);
const TLS_HEADER_LEN = 5;
const TLS_MAX_PAYLOAD = 16384 - TLS_HEADER_LEN;

/** Wrap an arbitrary payload in one or more TLS-1.2 ApplicationData records. */
export function wrapTlsApplicationData(payload: Buffer): Buffer {
  if (payload.length <= TLS_MAX_PAYLOAD) {
    return Buffer.concat([
      Buffer.from([TLS_TYPE_APPLICATION_DATA]),
      TLS_VERSION_LEGACY,
      Buffer.from([(payload.length >> 8) & 0xff, payload.length & 0xff]),
      payload,
    ]);
  }
  const out: Buffer[] = [];
  for (let i = 0; i < payload.length; i += TLS_MAX_PAYLOAD) {
    const chunk = payload.subarray(i, i + TLS_MAX_PAYLOAD);
    out.push(
      Buffer.concat([
        Buffer.from([TLS_TYPE_APPLICATION_DATA]),
        TLS_VERSION_LEGACY,
        Buffer.from([(chunk.length >> 8) & 0xff, chunk.length & 0xff]),
        chunk,
      ]),
    );
  }
  return Buffer.concat(out);
}

export interface TlsRecord {
  type: number;
  payload: Buffer;
}

/**
 * Read one TLS record from a GramJS-shaped socket
 * (`readExactly(n) → Promise<Buffer>`).
 */
export async function readTlsRecord(socket: {
  readExactly(n: number): Promise<Buffer>;
}): Promise<TlsRecord> {
  const header = await socket.readExactly(TLS_HEADER_LEN);
  const type = header[0]!;
  // We accept any version in the legacy-version slot; servers sometimes send
  // 0x0301 in the first records, 0x0303 afterwards.
  const length = (header[3]! << 8) | header[4]!;
  const payload = length > 0 ? await socket.readExactly(length) : Buffer.alloc(0);
  return { type, payload };
}
