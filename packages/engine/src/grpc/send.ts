/**
 * Sending one gRPC call over HTTP/2 with Node's `http2` module.
 *
 * gRPC is HTTP/2 with a fixed shape: a `POST` to `/<service>/<method>`, `content-type:
 * application/grpc`, `te: trailers`, each message length-prefixed in the body, and the outcome in
 * `grpc-status`/`grpc-message` trailers (or in the headers, for a "trailers-only" response). The
 * REST transport's HTTP client hides trailers and buffers bodies, which is exactly what a server
 * stream must not have, so this module speaks HTTP/2 directly. It knows nothing about protobuf:
 * messages arrive and leave as bytes, and `call.ts` is where the codec meets the wire.
 *
 * A non-`OK` status is a result, not an error — the user asked what the server would say, and it
 * said `NOT_FOUND`. Only a failure to get an answer at all (connection, TLS, an abort, a malformed
 * stream) throws.
 */

import { Buffer } from 'node:buffer';
import http2 from 'node:http2';
import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http2';
import { gunzipSync, inflateSync } from 'node:zlib';
import { GrpcError } from '../errors.js';
import { toHttpError } from '../http/errors.js';
import { captureSslInfo } from '../http/tls.js';
import type { SslInfo, TlsSocketLike } from '../http/tls.js';
import type { Timings, TlsOptions } from '../http/types.js';
import type { KeyValueEntry } from '../rest/model.js';
import type { SendAuth } from '../types.js';
import { encodeGrpcFrame, GrpcFrameParser } from './framing.js';
import { grpcMethodPath } from './model.js';
import { decodeGrpcMessage, formatGrpcTimeout, grpcStatusName } from './status.js';
import { parseGrpcTarget } from './target.js';
import type { GrpcTarget } from './target.js';

export { parseGrpcTarget } from './target.js';
export type { GrpcTarget } from './target.js';

/** Everything {@link sendGrpc} needs, with every property already expanded and every secret resolved. */
export interface GrpcSendInput {
  readonly target: string;
  readonly tls: boolean;
  readonly service: string;
  readonly method: string;
  /** The request messages, already encoded; one for a unary or server-streaming call. */
  readonly messages: readonly Uint8Array[];
  /** Metadata rows: the API's defaults first, then the request's own, a later row winning a repeated key. */
  readonly metadata: readonly KeyValueEntry[];
  /** Metadata the host adds on the call's behalf (`user-agent`), which a typed row overrides. */
  readonly defaultMetadata?: Readonly<Record<string, string>>;
  /** Credentials, already resolved to values. Basic, Bearer, OAuth2 and header API keys become `authorization` or a header. */
  readonly auth?: SendAuth;
  /** The deadline, sent as `grpc-timeout` and enforced locally. */
  readonly timeoutMs: number;
  /** Stop reading once this many response message bytes have arrived. */
  readonly maxSizeBytes?: number;
  readonly localAddress?: string;
  readonly tlsOptions?: TlsOptions;
  readonly signal?: AbortSignal;
  /** Clock for timings; tests inject one. */
  readonly now?: () => number;
  /**
   * Called once with the initial metadata, the moment the server's headers arrive rather than when
   * the call ends. A server stream can run for minutes before its first message, and the headers
   * are the first sign it was accepted at all.
   */
  readonly onHeaders?: (headers: Readonly<Record<string, string>>, httpStatus: number) => void;
  /**
   * Called for each response message as it is parsed, already decompressed, in arrival order. The
   * same messages are still collected into {@link GrpcExchange.messages}, so a caller that only
   * wants the end result ignores this and sees no difference.
   */
  readonly onMessage?: (message: Uint8Array, index: number) => void;
  /**
   * Opts into *interactive* mode: the request side stays open after {@link GrpcSendInput.messages}
   * are written, and the handle pushes further messages or half-closes. Without it — every batch
   * caller — `sendGrpc` writes every message and half-closes immediately, as it always has.
   *
   * The call still ends the way it always did: when the server ends the stream, the deadline
   * passes, or the signal aborts. Half-closing is not required to finish, since a server may
   * answer and end while the client still holds its side open.
   */
  readonly onOpen?: (handle: GrpcStreamHandle) => void;
}

/** The client's side of a call left open by {@link GrpcSendInput.onOpen}. */
export interface GrpcStreamHandle {
  /**
   * Frames and writes one more request message.
   *
   * @throws GrpcError `grpc-stream-closed` once the request side is half-closed or the call is over
   */
  readonly write: (message: Uint8Array) => void;
  /** Half-closes the request side. Idempotent, and a no-op once the call has ended. */
  readonly end: () => void;
  /** False once {@link end} has been called or the call has ended. */
  readonly isOpen: () => boolean;
}

/** Where a call's status came from, which the response pane says when it is not the trailers. */
export type GrpcStatusSource = 'trailers' | 'headers' | 'http' | 'local';

/** The full record of one gRPC call. */
export interface GrpcExchange {
  readonly request: {
    readonly authority: string;
    readonly path: string;
    /** The headers as sent, pseudo-headers included, lower-cased. */
    readonly headers: Readonly<Record<string, string>>;
    readonly messages: readonly Uint8Array[];
  };
  /** The HTTP status, 200 for every answer a gRPC server gives itself. */
  readonly httpStatus: number;
  /** Response headers (initial metadata), lower-cased, pseudo-headers removed. */
  readonly headers: Readonly<Record<string, string>>;
  readonly trailers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly statusName: string;
  readonly statusMessage?: string;
  readonly statusSource: GrpcStatusSource;
  /** Response messages in arrival order, decompressed. */
  readonly messages: readonly Uint8Array[];
  /** The `grpc-encoding` the server used, when it compressed. */
  readonly encoding?: string;
  /** True when reading stopped at `maxSizeBytes` before the stream ended. */
  readonly truncated: boolean;
  readonly timings: Timings;
  readonly tls?: SslInfo;
  /** Request pseudo-headers and headers as text, then the framed messages, as they went on the wire. */
  readonly rawRequest: Uint8Array;
  /** Response headers as text, the framed messages, then the trailers as text. */
  readonly rawResponse: Uint8Array;
  readonly durationMs: number;
}

/** Headers no metadata row may set: the protocol owns them. */
const RESERVED_HEADERS = new Set(['te', 'content-type', 'grpc-timeout', 'grpc-encoding', 'grpc-accept-encoding']);

/** The `authorization` or custom header credentials become, as the HTTP transport spells them. */
function authHeaders(auth: SendAuth | undefined): Record<string, string> {
  if (auth === undefined) {
    return {};
  }
  switch (auth.type) {
    case 'bearer':
      return { authorization: `${auth.scheme ?? 'Bearer'} ${auth.token}` };
    case 'oauth2':
      return { authorization: `Bearer ${auth.accessToken}` };
    case 'api-key':
      return { [auth.name.toLowerCase()]: auth.value };
    case 'basic':
      return { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}` };
    default:
      throw new GrpcError(
        'grpc-auth-unsupported',
        'NTLM cannot authenticate a gRPC call; it is an HTTP/1.1 connection handshake.',
        {
          details: { type: auth.type },
        },
      );
  }
}

/** Builds the request headers: protocol first, then host defaults, credentials, and the user's rows last. */
export function buildGrpcHeaders(input: GrpcSendInput, target: GrpcTarget): Record<string, string> {
  const headers: Record<string, string> = {
    ':method': 'POST',
    ':scheme': target.tls ? 'https' : 'http',
    ':authority': target.authority,
    ':path': grpcMethodPath(input.service, input.method),
    'content-type': 'application/grpc+proto',
    te: 'trailers',
    'grpc-accept-encoding': 'identity,gzip,deflate',
    'grpc-timeout': formatGrpcTimeout(input.timeoutMs),
  };
  for (const [name, value] of Object.entries(input.defaultMetadata ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  for (const [name, value] of Object.entries(authHeaders(input.auth))) {
    headers[name] = value;
  }
  for (const row of input.metadata) {
    if (!row.enabled || row.name.trim() === '') {
      continue;
    }
    const name = row.name.trim().toLowerCase();
    if (name.startsWith(':') || RESERVED_HEADERS.has(name)) {
      continue;
    }
    headers[name] = row.value;
  }
  return headers;
}

function headerText(headers: Readonly<Record<string, string>>): string {
  return `${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')}\r\n\r\n`;
}

/** Flattens Node's incoming headers to one string per name, dropping pseudo-headers. */
function flatten(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':') || value === undefined) {
      continue;
    }
    out[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** The gRPC status the specification says an HTTP status without a `grpc-status` maps to. */
function statusFromHttp(httpStatus: number): number {
  switch (httpStatus) {
    case 400:
      return 13;
    case 401:
      return 16;
    case 403:
      return 7;
    case 404:
      return 12;
    case 429:
    case 502:
    case 503:
    case 504:
      return 14;
    default:
      return 2;
  }
}

function decompress(payload: Uint8Array, encoding: string | undefined): Uint8Array {
  switch ((encoding ?? 'identity').toLowerCase()) {
    case 'identity':
      return payload;
    case 'gzip':
      return new Uint8Array(gunzipSync(payload));
    case 'deflate':
      return new Uint8Array(inflateSync(payload));
    default:
      throw new GrpcError(
        'grpc-encoding-unsupported',
        `The server compressed the response with "${encoding ?? ''}", which this client cannot read`,
        {
          details: { encoding },
        },
      );
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function connectOptions(input: GrpcSendInput, target: GrpcTarget): http2.SecureClientSessionOptions {
  const tls = input.tlsOptions;
  return {
    ...(input.localAddress !== undefined ? { localAddress: input.localAddress } : {}),
    ...(target.tls
      ? {
          ...(tls?.rejectUnauthorized !== undefined ? { rejectUnauthorized: tls.rejectUnauthorized } : {}),
          ...(tls?.ca !== undefined ? { ca: [...tls.ca] } : {}),
          ...(tls?.cert !== undefined ? { cert: tls.cert } : {}),
          ...(tls?.key !== undefined ? { key: tls.key } : {}),
          ...(tls?.passphrase !== undefined ? { passphrase: tls.passphrase } : {}),
          ...(tls?.minVersion !== undefined ? { minVersion: tls.minVersion } : {}),
          servername: tls?.servername ?? (/^[\d.]+$|:/.test(target.host) ? '' : target.host),
          ALPNProtocols: ['h2'],
        }
      : {}),
  };
}

/**
 * Sends one gRPC call and collects every response message and the final status.
 *
 * Client-streaming and bidirectional methods are sent in "batch" form: every request message is
 * written, the request side is closed, and the responses are read until the server ends the stream.
 * {@link GrpcSendInput.onOpen} turns that into an interactive call instead, where the caller keeps
 * pushing messages until it half-closes.
 *
 * {@link GrpcSendInput.onHeaders} and {@link GrpcSendInput.onMessage} report the initial metadata
 * and each response message as they arrive, for a caller that shows a stream while it runs.
 *
 * @throws HttpError for a connection, DNS, TLS or abort failure, with the HTTP transport's codes;
 * GrpcError `grpc-target-invalid`, `grpc-auth-unsupported`, `grpc-stream-malformed`,
 * `grpc-encoding-unsupported`, `grpc-message-too-large`, `grpc-stream-closed`
 */
export async function sendGrpc(input: GrpcSendInput): Promise<GrpcExchange> {
  const target = parseGrpcTarget(input.target, input.tls);
  const now = input.now ?? (() => performance.now());
  const startedAtMs = now();
  const startedAt = new Date().toISOString();
  const requestHeaders = buildGrpcHeaders(input, target);
  // What was actually sent, which in interactive mode grows after the call opens; the exchange
  // reports these rather than `input.messages` so its record and its raw bytes stay the same thing.
  const sent: Uint8Array[] = [...input.messages];
  const sentFrames: Uint8Array[] = sent.map((message) => encodeGrpcFrame(message));

  const origin = `${target.tls ? 'https' : 'http'}://${target.authority}`;
  const session: ClientHttp2Session = http2.connect(origin, connectOptions(input, target));

  let connectMs: number | undefined;
  let tlsInfo: SslInfo | undefined;
  session.once('connect', () => {
    connectMs = now() - startedAtMs;
    // `session.socket` is a Proxy that answers property reads but not the `in` operator.
    const socket = session.socket as unknown as Partial<TlsSocketLike> | undefined;
    if (target.tls && typeof socket?.getPeerCertificate === 'function') {
      tlsInfo = captureSslInfo(socket as TlsSocketLike);
    }
  });

  return new Promise<GrpcExchange>((resolve, reject) => {
    let settled = false;
    let stream: ClientHttp2Stream | undefined;
    let deadlineHit = false;
    let userAborted = false;
    let headersAt: number | undefined;
    let responseHeaders: Record<string, string> = {};
    let httpStatus = 0;
    let trailers: Record<string, string> = {};
    const parser = new GrpcFrameParser();
    let sessionError: unknown;
    const rawFrames: Uint8Array[] = [];
    const messages: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    let encoding: string | undefined;

    const cleanup = (): void => {
      clearTimeout(deadline);
      input.signal?.removeEventListener('abort', onAbort);
      session.close();
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error instanceof GrpcError) {
        reject(error);
        return;
      }
      reject(toHttpError(error, { userAborted, deadlineHit: false, host: target.authority }));
    };

    const finish = (local?: { readonly status: number; readonly message: string }): void => {
      if (settled) return;
      settled = true;
      const endMs = now();
      cleanup();
      let status: number;
      let statusMessage: string | undefined;
      let statusSource: GrpcStatusSource;
      const trailerStatus = trailers['grpc-status'];
      const headerStatus = responseHeaders['grpc-status'];
      if (local !== undefined) {
        status = local.status;
        statusMessage = local.message;
        statusSource = 'local';
      } else if (trailerStatus !== undefined) {
        status = Number(trailerStatus);
        statusMessage = trailers['grpc-message'];
        statusSource = 'trailers';
      } else if (headerStatus !== undefined) {
        status = Number(headerStatus);
        statusMessage = responseHeaders['grpc-message'];
        statusSource = 'headers';
      } else if (httpStatus !== 200) {
        status = statusFromHttp(httpStatus);
        statusMessage = `HTTP status ${String(httpStatus)} without a grpc-status`;
        statusSource = 'http';
      } else {
        status = 2;
        statusMessage = 'The server ended the stream without a grpc-status';
        statusSource = 'http';
      }
      if (Number.isNaN(status)) {
        status = 2;
        statusMessage = `Unreadable grpc-status "${trailerStatus ?? headerStatus ?? ''}"`;
      }
      const decodedMessage = statusMessage === undefined ? undefined : decodeGrpcMessage(statusMessage);
      const responseText = `HTTP/2 ${String(httpStatus)}\r\n${headerText(responseHeaders)}`;
      const trailerText = Object.keys(trailers).length > 0 ? `\r\n${headerText(trailers)}` : '';
      const totalMs = endMs - startedAtMs;
      resolve({
        request: {
          authority: target.authority,
          path: requestHeaders[':path'] ?? '',
          headers: requestHeaders,
          messages: sent,
        },
        httpStatus,
        headers: responseHeaders,
        trailers,
        status,
        statusName: grpcStatusName(status),
        ...(decodedMessage !== undefined && decodedMessage !== '' ? { statusMessage: decodedMessage } : {}),
        statusSource,
        messages,
        ...(encoding !== undefined && encoding !== 'identity' ? { encoding } : {}),
        truncated,
        timings: {
          startedAt,
          totalMs,
          ...(connectMs !== undefined ? { connectMs } : {}),
          ...(headersAt !== undefined ? { ttfbMs: headersAt - startedAtMs, downloadMs: endMs - headersAt } : {}),
        },
        ...(tlsInfo !== undefined ? { tls: tlsInfo } : {}),
        rawRequest: concat([new TextEncoder().encode(headerText(requestHeaders)), ...sentFrames]),
        rawResponse: concat([
          new TextEncoder().encode(responseText),
          ...rawFrames,
          new TextEncoder().encode(trailerText),
        ]),
        durationMs: totalMs,
      });
    };

    const onAbort = (): void => {
      userAborted = true;
      stream?.close(http2.constants.NGHTTP2_CANCEL);
      fail(new Error('aborted'));
    };
    const deadline = setTimeout(() => {
      deadlineHit = true;
      stream?.close(http2.constants.NGHTTP2_CANCEL);
      finish({
        status: 4,
        message: `Deadline of ${formatGrpcTimeout(input.timeoutMs)} exceeded before the server answered`,
      });
    }, input.timeoutMs);
    if (input.signal?.aborted === true) {
      onAbort();
      return;
    }
    input.signal?.addEventListener('abort', onAbort, { once: true });

    session.on('error', (error) => {
      sessionError = error;
      fail(error);
    });
    session.on('close', () => {
      if (!settled && !deadlineHit) {
        fail(
          new GrpcError('grpc-stream-malformed', 'The connection closed before the call completed', {
            details: { httpStatus },
          }),
        );
      }
    });

    const outgoing: OutgoingHttpHeaders = { ...requestHeaders };
    try {
      stream = session.request(outgoing);
    } catch (error) {
      fail(error);
      return;
    }
    // A refused connection or a failed handshake reaches the stream as "the pending stream has been
    // cancelled" as well as the session as the real cause; wait a tick so the cause wins.
    stream.on('error', (error) => {
      setImmediate(() => fail(sessionError ?? error));
    });
    stream.on('response', (headers) => {
      headersAt = now();
      httpStatus = Number(headers[':status'] ?? 0);
      responseHeaders = flatten(headers);
      encoding = responseHeaders['grpc-encoding'];
      const contentType = responseHeaders['content-type'] ?? '';
      if (httpStatus === 200 && !contentType.toLowerCase().startsWith('application/grpc')) {
        fail(
          new GrpcError(
            'grpc-stream-malformed',
            `The server answered with "${contentType}" rather than application/grpc; is ${target.authority} a gRPC server?`,
            {
              details: { contentType, httpStatus },
            },
          ),
        );
        return;
      }
      input.onHeaders?.(responseHeaders, httpStatus);
    });
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      rawFrames.push(new Uint8Array(chunk));
      try {
        for (const frame of parser.push(new Uint8Array(chunk))) {
          received += frame.payload.byteLength;
          if (input.maxSizeBytes !== undefined && received > input.maxSizeBytes) {
            truncated = true;
            break;
          }
          const message = frame.compressed ? decompress(frame.payload, encoding) : frame.payload;
          messages.push(message);
          input.onMessage?.(message, messages.length - 1);
        }
      } catch (error) {
        fail(error);
        return;
      }
      if (truncated) {
        stream?.close(http2.constants.NGHTTP2_CANCEL);
        finish();
      }
    });
    stream.on('trailers', (headers: IncomingHttpHeaders) => {
      trailers = flatten(headers);
    });
    stream.on('end', () => {
      if (parser.pending > 0 && !truncated) {
        fail(
          new GrpcError(
            'grpc-stream-malformed',
            `The stream ended in the middle of a message (${String(parser.pending)} bytes left over)`,
            {
              details: { pending: parser.pending },
            },
          ),
        );
        return;
      }
      finish();
    });
    for (const frame of sentFrames) {
      stream.write(Buffer.from(frame));
    }
    if (input.onOpen === undefined) {
      stream.end();
      return;
    }
    // Interactive: the request side stays open until the caller half-closes, the deadline passes or
    // the signal aborts. `settled` covers all three, so a handle held past the end is inert rather
    // than writing to a dead stream.
    let halfClosed = false;
    const open = stream;
    try {
      input.onOpen({
        write: (message: Uint8Array): void => {
          if (settled || halfClosed) {
            throw new GrpcError('grpc-stream-closed', 'The request side of this call is already closed', {
              details: { halfClosed, settled },
            });
          }
          sent.push(message);
          const frame = encodeGrpcFrame(message);
          sentFrames.push(frame);
          open.write(Buffer.from(frame));
        },
        end: (): void => {
          if (halfClosed) return;
          halfClosed = true;
          if (!settled) {
            open.end();
          }
        },
        isOpen: (): boolean => !settled && !halfClosed,
      });
    } catch (error) {
      fail(error);
    }
  });
}
