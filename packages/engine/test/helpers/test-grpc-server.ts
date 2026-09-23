/**
 * An in-process gRPC server for the gRPC tests, speaking the `greeter` fixture's service over
 * Node's `http2` module with the engine's own framing and codec — so a test proves the client
 * against an independent reading of the same bytes, not against itself.
 *
 * Hermetic like the REST fixture and shared with the desktop app's e2e suite through
 * `@wirebench/engine/test-helpers`. Every streaming shape is here, plus a method that fails with
 * whatever status a test asks for, a slow one for deadlines, and gzip on request.
 *
 * Dispatch is keyed by service so a second service can share the port: on request the server also
 * hosts gRPC server reflection, in either protocol version or both, answering from the same
 * `greeter` set read back out as descriptors.
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
import {
  REFLECTION_METHOD,
  reflectionPackage,
  reflectionProtoSet,
  reflectionServiceName,
} from '../../src/grpc/reflection/proto.js';
import { encodeGrpcMessage } from '../../src/grpc/status.js';
import { readProtoFixture } from './proto-fixtures.js';
import { reflectionCatalog, withDependencies } from './test-grpc-reflection.js';

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
  /**
   * The reflection protocol versions to serve. Empty by default, which is a server that refuses
   * reflection altogether; `['v1alpha']` is a server that predates the stable package.
   */
  readonly reflection?: readonly ('v1' | 'v1alpha')[];
  /**
   * Answer `file_containing_symbol` with the file alone rather than its imports as well, as a
   * server that leaves the client to chase dependencies by name does.
   */
  readonly reflectionOmitsDependencies?: boolean;
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

/** The canonical JSON mapping spells a `bytes` field as base64, which is what the codec encodes. */
function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts the server on a free loopback port. */
export async function startTestGrpcServer(options: TestGrpcServerOptions = {}): Promise<TestGrpcServer> {
  const set = loadProtoSet(readProtoFixture('greeter'), { roots: ['greeter.proto'] });
  const calls: RecordedGrpcCall[] = [];
  const compress = options.gzip === true;

  const writeMessage = (stream: ServerHttp2Stream, messageSet: ProtoSet, type: string, json: unknown): void => {
    const bytes = encodeMessage(messageSet, type, json);
    stream.write(Buffer.from(compress ? encodeGrpcFrame(gzipSync(bytes), true) : encodeGrpcFrame(bytes)));
  };
  const respond = (stream: ServerHttp2Stream, type: string, json: unknown): void => {
    writeMessage(stream, set, type, json);
  };
  // Node sends trailers only from a `wantTrailers` handler on a stream that responded with
  // `waitForTrailers`, so the status is parked here until the stream asks for it.
  const pendingTrailers = new WeakMap<ServerHttp2Stream, Record<string, string>>();
  /**
   * The response headers, sent once per stream however many messages follow. `echo`, the request's
   * `x-echo` metadata, comes back as initial metadata of the same name.
   */
  const responder = (stream: ServerHttp2Stream, echo?: string): (() => void) => {
    let responded = false;
    return () => {
      if (responded) return;
      responded = true;
      stream.respond(
        {
          ':status': 200,
          'content-type': 'application/grpc+proto',
          'x-served-by': 'test-grpc-server',
          ...(echo !== undefined ? { 'x-echo': echo } : {}),
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
  };
  const finishWithStatus = (stream: ServerHttp2Stream, status: number, message?: string): void => {
    if (stream.closed || stream.destroyed) return;
    pendingTrailers.set(stream, {
      'grpc-status': String(status),
      ...(message !== undefined ? { 'grpc-message': encodeGrpcMessage(message) } : {}),
    });
    stream.end();
  };

  const reflectionVersions = options.reflection ?? [];
  const catalog = reflectionCatalog(set);
  /** What `list_services` answers: the fixture's own services and reflection itself, as a server does. */
  const listedServices = [...catalog.services, ...reflectionVersions.map((version) => reflectionServiceName(version))];

  /** One `ServerReflectionResponse` for one request, in the JSON shape the codec encodes. */
  const reflectionResponse = (request: Record<string, unknown>): Record<string, unknown> => {
    const base = { valid_host: '', original_request: request };
    if (typeof request['list_services'] === 'string') {
      return { ...base, list_services_response: { service: listedServices.map((name) => ({ name })) } };
    }
    const symbol = request['file_containing_symbol'];
    if (typeof symbol === 'string') {
      const file = catalog.symbols.get(symbol);
      if (file === undefined) {
        return { ...base, error_response: { error_code: 5, error_message: `symbol not found: ${symbol}` } };
      }
      const files =
        options.reflectionOmitsDependencies === true
          ? [catalog.files.get(file)!.bytes]
          : withDependencies(catalog, file);
      return { ...base, file_descriptor_response: { file_descriptor_proto: files.map(base64) } };
    }
    const filename = request['file_by_filename'];
    if (typeof filename === 'string') {
      const file = catalog.files.get(filename);
      if (file === undefined) {
        return { ...base, error_response: { error_code: 5, error_message: `file not found: ${filename}` } };
      }
      return { ...base, file_descriptor_response: { file_descriptor_proto: [base64(file.bytes)] } };
    }
    return { ...base, error_response: { error_code: 12, error_message: 'unsupported reflection request' } };
  };

  /**
   * `ServerReflectionInfo`: a bidirectional stream answered message by message as the requests
   * arrive, which is what the specification's own servers do and what lets a client that sends
   * several requests on one stream read the answers back in order.
   */
  const handleReflection = async (
    stream: ServerHttp2Stream,
    flat: Readonly<Record<string, string>>,
    path: string,
    version: 'v1' | 'v1alpha',
  ): Promise<void> => {
    const reflectionSet = reflectionProtoSet(version);
    const pkg = reflectionPackage(version);
    const parser = new GrpcFrameParser();
    const messages: unknown[] = [];
    const respondHeaders = responder(stream);
    await new Promise<void>((resolve) => {
      stream.on('data', (chunk: Buffer) => {
        for (const frame of parser.push(new Uint8Array(chunk))) {
          const request = decodeMessage(reflectionSet, `${pkg}.ServerReflectionRequest`, frame.payload) as Record<
            string,
            unknown
          >;
          messages.push(request);
          respondHeaders();
          writeMessage(stream, reflectionSet, `${pkg}.ServerReflectionResponse`, reflectionResponse(request));
        }
      });
      stream.on('end', resolve);
      stream.on('error', resolve);
    });
    calls.push({ path, headers: flat, messages });
    respondHeaders();
    finishWithStatus(stream, 0);
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
    const reflecting = reflectionVersions.find(
      (version) => service === reflectionServiceName(version) && methodName === REFLECTION_METHOD,
    );
    if (reflecting !== undefined) {
      await handleReflection(stream, flat, path, reflecting);
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
    const respondHeaders = responder(stream, flat['x-echo']);
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
