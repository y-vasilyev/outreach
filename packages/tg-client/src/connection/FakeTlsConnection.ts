/**
 * GramJS-compatible Connection class that wraps the underlying MTProxy
 * obfuscation 2.0 (`ConnectionTCPMTProxyAbridged`) in a fake-TLS 1.3 outer
 * layer. Used when the user supplies an `ee`-prefixed MTProxy secret with
 * a baked-in SNI host (the format Telegram share-links generate).
 *
 * The flow on connect:
 *   1. TCP open to proxy.ip:proxy.port
 *   2. We send a 517-byte fake ClientHello (HMAC over the message verifies
 *      to the proxy that we know the 16-byte secret).
 *   3. We read the proxy's ServerHello + ChangeCipherSpec + first
 *      ApplicationData record (we don't strictly validate the response —
 *      if the secret is wrong the proxy just drops the connection).
 *   4. We swap `this.socket` for a wrapper that frames every subsequent
 *      `write` into TLS application-data records and unframes every
 *      `readExactly` from them.
 *   5. We delegate to the parent `_initConn`, which performs the regular
 *      MTProxy obfuscation handshake — that traffic now travels inside
 *      the TLS records.
 */

import {
  buildFakeTlsClientHello,
  readTlsRecord,
  wrapTlsApplicationData,
  TLS_TYPE_APPLICATION_DATA,
  TLS_TYPE_CHANGE_CIPHER_SPEC,
  TLS_TYPE_HANDSHAKE,
  type FakeTlsSecret,
} from './fake-tls.js';

interface GramJsSocket {
  connect(port: number, ip: string, testServers?: boolean): Promise<void>;
  readExactly(n: number): Promise<Buffer>;
  write(data: Buffer): void;
  close(): Promise<void> | void;
}

interface GramJsConnectionLike {
  socket: GramJsSocket;
  _ip: string;
  _port: number;
  _proxy: { host?: string; [k: string]: unknown };
  _testServers?: boolean;
  PacketCodecClass: new (conn: unknown) => unknown;
  _codec?: unknown;
  _initConn(): Promise<void>;
}

/**
 * Wraps a GramJS-style socket so reads/writes are TLS application-data
 * framed. Used after the fake-TLS handshake completes.
 */
class TlsFramedSocket implements GramJsSocket {
  private _unread = Buffer.alloc(0);

  constructor(private inner: GramJsSocket) {}

  async connect(): Promise<void> {
    // Already connected by the time we wrap.
  }

  write(data: Buffer): void {
    this.inner.write(wrapTlsApplicationData(data));
  }

  async readExactly(n: number): Promise<Buffer> {
    while (this._unread.length < n) {
      const rec = await readTlsRecord(this.inner);
      // Ignore non-application-data records that may arrive (e.g. duplicate
      // ChangeCipherSpec or alerts) — they don't contain MTProto bytes.
      if (rec.type !== TLS_TYPE_APPLICATION_DATA) continue;
      this._unread = Buffer.concat([this._unread, rec.payload]);
    }
    const out = this._unread.subarray(0, n);
    this._unread = this._unread.subarray(n);
    return out;
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

/**
 * Performs the fake-TLS client side of the handshake against an upstream
 * MTProxy. Throws if the upstream closes the connection mid-handshake or
 * sends something we can't parse.
 */
async function performFakeTlsHandshake(
  socket: GramJsSocket,
  secret: FakeTlsSecret,
): Promise<void> {
  const clientHello = buildFakeTlsClientHello(secret);
  socket.write(clientHello);

  // Server response: ServerHello (handshake record) + ChangeCipherSpec record
  // + zero or more "noise" ApplicationData records before the first real one.
  // We need to drain everything up to and including the first
  // ChangeCipherSpec record so subsequent reads see ApplicationData only.
  let sawChangeCipher = false;
  while (!sawChangeCipher) {
    const rec = await readTlsRecord(socket);
    if (rec.type === TLS_TYPE_CHANGE_CIPHER_SPEC) {
      sawChangeCipher = true;
      continue;
    }
    if (rec.type === TLS_TYPE_HANDSHAKE) continue;
    if (rec.type === TLS_TYPE_APPLICATION_DATA) {
      // Some proxies send AppData before ChangeCipherSpec; that's fine,
      // those bytes are server "noise" we should skip too. Keep looping.
      continue;
    }
    throw new Error(`fake-tls: unexpected TLS record type 0x${rec.type.toString(16)}`);
  }

  // After ChangeCipherSpec, mtg sends one more "noise" AppData record before
  // the actual MTProxy bytes start. We don't strictly need to consume it —
  // the TlsFramedSocket below will treat the very next AppData record as the
  // start of MTProxy traffic, which is correct because mtg's server-side
  // generates exactly one noise AppData immediately after CCS as part of the
  // handshake response, and that record is "consumed" here:
  const noise = await readTlsRecord(socket);
  if (noise.type !== TLS_TYPE_APPLICATION_DATA) {
    throw new Error(
      `fake-tls: expected ApplicationData after ChangeCipherSpec, got 0x${noise.type.toString(16)}`,
    );
  }
}

/**
 * Build a GramJS Connection class (i.e. a class compatible with the
 * `connection` constructor option of `TelegramClient`) that wraps the
 * legacy MTProxy obfuscation 2.0 handshake in a fake-TLS layer.
 *
 * The base class is loaded dynamically so we can extend the JS prototype
 * GramJS exports — TypeScript can't see it at compile time.
 */
export async function loadFakeTlsConnectionClass(): Promise<unknown> {
  const mod = (await import('telegram/network/connection/TCPMTProxy.js')) as unknown as {
    ConnectionTCPMTProxyAbridged: new (...args: unknown[]) => GramJsConnectionLike;
  };
  const Base = mod.ConnectionTCPMTProxyAbridged;

  class FakeTlsConnection extends (Base as unknown as new (...args: unknown[]) => GramJsConnectionLike) {
    async _connect(): Promise<void> {
      // Replicate the parent's TCP-open path, but inject our handshake
      // before the obfuscation handshake.
      const self = this as unknown as GramJsConnectionLike & {
        _connect: () => Promise<void>;
      };
      self._codec = new self.PacketCodecClass(self);
      await self.socket.connect(self._port, self._ip, self._testServers);

      const host = (self._proxy.host as string | undefined) ?? '';
      if (!host) {
        throw new Error('fake-tls: no SNI host on proxy config (use ee-prefixed secret)');
      }
      // GramJS' TCPMTProxy constructor stores the parsed secret on `this._secret`.
      const keyBuf = (this as unknown as { _secret: Buffer })._secret;
      if (!keyBuf || keyBuf.length !== 16) {
        throw new Error(
          `fake-tls: expected 16-byte secret on connection, got ${keyBuf?.length ?? 'none'}`,
        );
      }

      await performFakeTlsHandshake(self.socket, { key: keyBuf, host });

      // Patch in TLS framing for everything that follows.
      self.socket = new TlsFramedSocket(self.socket);

      await self._initConn();
    }
  }

  return FakeTlsConnection;
}
