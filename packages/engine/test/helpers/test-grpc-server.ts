/**
 * An in-process gRPC server for the gRPC tests, speaking the `greeter` fixture's service over
 * Node's `http2` module with the engine's own framing and codec — so a test proves the client
 * against an independent reading of the same bytes, not against itself.
 *
 * Hermetic like the REST fixture and shared with the desktop app's e2e suite through
 * `@wirebench/engine/test-helpers`. Every streaming shape is here, plus a method that fails with
 * whatever status a test asks for, a slow one for deadlines, and gzip on request.
 */

import { Buffer } from 'node:buffer';
import http2, {
  type Http2Server,
  type Http2SecureServer,
  type ServerHttp2Stream,
  type IncomingHttpHeaders,
} from 'node:http2';
import { gzipSync } from 'node:zlib';
import { decodeMessage, encodeMessage } from '../../src/grpc/codec.js';
import { encodeGrpcFrame, GrpcFrameParser } from '../../src/grpc/framing.js';
import { loadProtoSet, type ProtoSet } from '../../src/grpc/proto/load.js';
import { encodeGrpcMessage } from '../../src/grpc/status.js';
import { readProtoFixture } from './proto-fixtures.js';

/** One call the server recorded, for assertions the response cannot carry. */
export interface RecordedGrpcCall {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The request messages, decoded to JSON. */
  readonly messages: readonly unknown[];
}

/** TLS options, for the certificate tests. */
export interface TestGrpcServerTls {
  readonly cert: string;
  readonly key: string;
  readonly ca?: string | readonly string[];
  readonly requestCert?: boolean;
}

/** Options for {@link startTestGrpcServer}. */
export interface TestGrpcServerOptions {
  readonly tls?: TestGrpcServerTls;
  /** Compress every response message with gzip and say so in `grpc-encoding`. */
  readonly gzip?: boolean;
}

/** A running test server. */
export interface TestGrpcServer {
  /** `host:port`. */
  readonly target: string;
  readonly tls: boolean;
  readonly calls: RecordedGrpcCall[];
  readonly set: ProtoSet;
  close(): Promise<void>;
}

const SERVICE = 'wirebench.greet.Greeter';

interface Method {
  readonly requestType: string;
  readonly responseType: string;
  readonly clientStreams: boolean;
}

const METHODS: Readonly<Record<string, Method>> = {
  SayHello: {
    requestType: 'wirebench.greet.HelloRequest',
    responseType: 'wirebench.greet.HelloReply',
    clientStreams: false,
  },
  LotsOfReplies: {
    requestType: 'wirebench.greet.StreamRequest',
    responseType: 'wirebench.greet.HelloReply',
    clientStreams: false,
  },
  LotsOfGreetings: {
    requestType: 'wirebench.greet.HelloRequest',
    responseType: 'wirebench.greet.HelloReply',
    clientStreams: true,
  },
  Chat: {
    requestType: 'wirebench.greet.HelloRequest',
    responseType: 'wirebench.greet.HelloReply',
    clientStreams: true,
  },
  Fail: { requestType: 'wirebench.greet.FailRequest', responseType: 'google.protobuf.Empty', clientStreams: false },
  Slow: {
    requestType: 'wirebench.greet.StreamRequest',
    responseType: 'wirebench.greet.HelloReply',
    clientStreams: false,
  },
};

function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts the server on a free loopback port. */
export async function startTestGrpcServer(options: TestGrpcServerOptions = {}): Promise<TestGrpcServer> {
  const set = loadProtoSet(readProtoFixture('greeter'), { roots: ['greeter.proto'] });
  const calls: RecordedGrpcCall[] = [];
  const compress = options.gzip === true;

  const respond = (stream: ServerHttp2Stream, type: string, json: unknown): void => {
    const bytes = encodeMessage(set, type, json);
    stream.write(Buffer.from(compress ? encodeGrpcFrame(gzipSync(bytes), true) : encodeGrpcFrame(bytes)));
  };
  // Node sends trailers only from a `wantTrailers` handler on a stream that responded with
  // `waitForTrailers`, so the status is parked here until the stream asks for it.
  const pendingTrailers = new WeakMap<ServerHttp2Stream, Record<string, string>>();
  const finishWithStatus = (stream: ServerHttp2Stream, status: number, message?: string): void => {
    if (stream.closed || stream.destroyed) return;
    pendingTrailers.set(stream, {
      'grpc-status': String(status),
      ...(message !== undefined ? { 'grpc-message': encodeGrpcMessage(message) } : {}),
    });
    stream.end();
  };

  const handle = async (stream: ServerHttp2Stream, headers: IncomingHttpHeaders): Promise<void> => {
    const path = String(headers[':path'] ?? '');
    const flat = flatten(headers);
    const [, service, methodName] = /^\/([^/]+)\/([^/]+)$/.exec(path) ?? [];
    const method = service === SERVICE && methodName !== undefined ? METHODS[methodName] : undefined;
    const contentType = String(headers['content-type'] ?? '');
    if (!contentType.startsWith('application/grpc')) {
      stream.respond({ ':status': 415, 'content-type': 'text/plain' });
      stream.end('not grpc');
      return;
    }
    if (method === undefined) {
      stream.respond(
        {
          ':status': 200,
          'content-type': 'application/grpc',
          'grpc-status': '12',
          'grpc-message': encodeGrpcMessage(`unknown method ${path}`),
        },
        { endStream: true },
      );
      calls.push({ path, headers: flat, messages: [] });
      return;
    }
    // Read every request message first; the streaming methods below answer after the client half-closes,
    // except Chat, which answers as messages arrive.
    const parser = new GrpcFrameParser();
    const messages: unknown[] = [];
    let responded = false;
    const respondHeaders = (): void => {
      if (responded) return;
      responded = true;
      stream.respond(
        {
          ':status': 200,
          'content-type': 'application/grpc+proto',
          'x-served-by': 'test-grpc-server',
          ...(compress ? { 'grpc-encoding': 'gzip' } : {}),
        },
        { waitForTrailers: true },
      );
      stream.on('wantTrailers', () => {
        stream.sendTrailers(
          pendingTrailers.get(stream) ?? { 'grpc-status': '13', 'grpc-message': 'no status was set' },
        );
      });
    };
    const xMetadata = Object.fromEntries(
      Object.entries(flat).filter(([name]) => name.startsWith('x-') && name !== 'x-served-by'),
    );
    let sequence = 0;
    await new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => {
        for (const frame of parser.push(new Uint8Array(chunk))) {
          const json = decodeMessage(set, method.requestType, frame.payload);
          messages.push(json);
          if (methodName === 'Chat') {
            respondHeaders();
            sequence += 1;
            const name = (json as { name?: string }).name ?? '';
            respond(stream, method.responseType, { message: `Hello, ${name}`, sequence, metadata: xMetadata });
          }
        }
      });
      stream.on('end', resolve);
      stream.on('error', resolve);
    });
    calls.push({ path, headers: flat, messages });
    const first = messages[0] as Record<string, unknown> | undefined;
    switch (methodName) {
      case 'SayHello': {
        respondHeaders();
        respond(stream, method.responseType, {
          message: `Hello, ${typeof first?.['name'] === 'string' ? first['name'] : ''}`,
          echo: first ?? {},
          metadata: xMetadata,
        });
        finishWithStatus(stream, 0);
        return;
      }
      case 'LotsOfReplies': {
        respondHeaders();
        const count = Number(first?.['count'] ?? 0);
        const delay = Number(first?.['delay_ms'] ?? 0);
        for (let index = 1; index <= count; index += 1) {
          if (delay > 0) await sleep(delay);
          if (stream.closed || stream.destroyed) return;
          respond(stream, method.responseType, { message: `Hello #${String(index)}`, sequence: index });
        }
        finishWithStatus(stream, 0);
        return;
      }
      case 'LotsOfGreetings': {
        respondHeaders();
        respond(stream, method.responseType, {
          message: `Received ${String(messages.length)} greetings`,
          sequence: messages.length,
        });
        finishWithStatus(stream, 0);
        return;
      }
      case 'Chat': {
        respondHeaders();
        finishWithStatus(stream, 0);
        return;
      }
      case 'Fail': {
        const code = Number(first?.['code'] ?? 2);
        const message = typeof first?.['message'] === 'string' ? first['message'] : undefined;
        if (first?.['trailers_only'] === true) {
          stream.respond(
            {
              ':status': 200,
              'content-type': 'application/grpc',
              'grpc-status': String(code),
              ...(message !== undefined ? { 'grpc-message': encodeGrpcMessage(message) } : {}),
            },
            { endStream: true },
          );
          return;
        }
        respondHeaders();
        finishWithStatus(stream, code, message);
        return;
      }
      case 'Slow': {
        await sleep(Number(first?.['delay_ms'] ?? 0));
        if (stream.closed || stream.destroyed) return;
        respondHeaders();
        respond(stream, method.responseType, { message: 'finally' });
        finishWithStatus(stream, 0);
        return;
      }
      default:
        respondHeaders();
        finishWithStatus(stream, 12, 'unimplemented');
    }
  };

  const server: Http2Server | Http2SecureServer =
    options.tls !== undefined
      ? http2.createSecureServer({
          cert: options.tls.cert,
          key: options.tls.key,
          ...(options.tls.ca !== undefined ? { ca: options.tls.ca as string | string[] } : {}),
          ...(options.tls.requestCert === true ? { requestCert: true, rejectUnauthorized: true } : {}),
        })
      : http2.createServer();
  server.on('stream', (stream, headers) => {
    handle(stream, headers).catch(() => {
      if (!stream.closed) stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    });
  });
  const sessions = new Set<import('node:http2').ServerHttp2Session>();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('error', () => undefined);
    session.on('close', () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    target: `127.0.0.1:${String(port)}`,
    tls: options.tls !== undefined,
    calls,
    set,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Idle sessions keep `close` waiting; there is nothing in them a test still wants.
        for (const session of sessions) session.destroy();
      }),
  };
}
