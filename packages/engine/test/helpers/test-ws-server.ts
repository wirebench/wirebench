/**
 * A WebSocket server small enough to read in one sitting: the upgrade handshake and the five frame
 * kinds a session test needs. No extensions, no fragmentation — undici does not fragment what it
 * sends, and a server that offers no `permessage-deflate` is a legal one.
 *
 * Test-only. Never import this from production code.
 */
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** One recorded upgrade request: the path/query it targeted and the headers it carried. */
export interface TestWsHandshake {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}
/** Options for {@link startTestWsServer}. */
export interface TestWsServerOptions {
  readonly tls?: { readonly cert: string; readonly key: string; readonly ca?: string; readonly requestCert?: boolean };
  /** Subprotocols the server accepts; it picks the first offered one that is listed. */
  readonly subprotocols?: readonly string[];
}
/** A running {@link startTestWsServer}. */
export interface TestWsServer {
  readonly url: string;
  readonly port: number;
  readonly handshakes: readonly TestWsHandshake[];
  /** Every frame the server received, unmasked, in arrival order. */
  readonly received: readonly { readonly opcode: number; readonly payload: Buffer }[];
  readonly close: () => Promise<void>;
}

/** One unmasked, unfragmented frame, as a server sends it. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Takes every complete frame off the front of `state.buffer`, unmasking as it goes. */
function* decodeFrames(state: { buffer: Buffer }): Generator<{ opcode: number; payload: Buffer }> {
  for (;;) {
    const b = state.buffer;
    if (b.length < 2) return;
    const opcode = (b[0] ?? 0) & 0x0f;
    const masked = ((b[1] ?? 0) & 0x80) !== 0;
    let length = (b[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return;
      length = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (b.length < offset + length) return;
    const payload = Buffer.from(b.subarray(offset, offset + length));
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (payload[i] ?? 0) ^ (b[maskOffset + (i & 3)] ?? 0);
      }
    }
    state.buffer = b.subarray(offset + length);
    yield { opcode, payload };
  }
}

function closePayload(code: number, reason: string): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return body;
}

/**
 * Starts a WebSocket test server on an ephemeral port. Paths: `/echo` echoes every text and binary
 * frame; `/refuse` answers `401` with `www-authenticate: Basic realm="ws"` and body `no`; `/ping`
 * sends a ping with payload `hi` right after the upgrade, then behaves as echo; `/close` answers the
 * first message by closing with `4000` `bye`; `/drop` destroys the socket on the first message;
 * `/hang` never answers the upgrade.
 *
 * @param options TLS material for `wss://` and the subprotocols the server accepts
 * @returns the running server, with recorded handshakes/frames and a `close()`
 */
export async function startTestWsServer(options: TestWsServerOptions = {}): Promise<TestWsServer> {
  const handshakes: TestWsHandshake[] = [];
  const received: { opcode: number; payload: Buffer }[] = [];
  const sockets = new Set<Duplex>();
  const server =
    options.tls === undefined
      ? createHttpServer()
      : createHttpsServer({
          cert: options.tls.cert,
          key: options.tls.key,
          ...(options.tls.ca !== undefined ? { ca: options.tls.ca } : {}),
          ...(options.tls.requestCert === true ? { requestCert: true, rejectUnauthorized: true } : {}),
        });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    handshakes.push({ url: req.url ?? '/', headers: req.headers });
    if (path === '/hang') return;
    if (path === '/refuse') {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Basic realm="ws"\r\ncontent-length: 2\r\nconnection: close\r\n\r\nno',
      );
      return;
    }
    const key = req.headers['sec-websocket-key'] ?? '';
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const chosen = offered.find((p) => options.subprotocols?.includes(p) === true);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-accept: ${accept}`,
        ...(chosen !== undefined ? [`sec-websocket-protocol: ${chosen}`] : []),
        '',
        '',
      ].join('\r\n'),
    );
    if (path === '/ping') socket.write(encodeFrame(OP.ping, Buffer.from('hi')));

    const state = { buffer: Buffer.alloc(0) };
    socket.on('data', (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      for (const frame of decodeFrames(state)) {
        received.push(frame);
        if (frame.opcode === OP.close) {
          socket.end(encodeFrame(OP.close, frame.payload));
        } else if (frame.opcode === OP.ping) {
          socket.write(encodeFrame(OP.pong, frame.payload));
        } else if (frame.opcode === OP.text || frame.opcode === OP.binary) {
          if (path === '/close') socket.write(encodeFrame(OP.close, closePayload(4000, 'bye')));
          else if (path === '/drop') socket.destroy();
          else socket.write(encodeFrame(frame.opcode, frame.payload));
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: options.tls === undefined ? `ws://127.0.0.1:${port}` : `wss://localhost:${port}`,
    port,
    handshakes,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
