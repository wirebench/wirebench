/**
 * What a script sees of a gRPC call and its answer (spec §3.4): the snapshots, the converters
 * between a prepared call and a snapshot, the API's declarations, its sandbox-side source, and what
 * the script rules check.
 */
import { z } from 'zod';
import type { ProtocolScripting, SnapshotFacts } from '../protocol/module.js';
import { headerPairSchema } from '../script/apply.js';
import type { HeaderPair, ScriptFailure } from '../script/model.js';
import { entriesOf, pairsOf, recordPairs } from '../script/send.js';
import type { GrpcCallResult } from './call.js';
import type { GrpcSendInput } from './send.js';

export interface GrpcRequestSnapshot {
  readonly protocol: 'grpc';
  readonly target: string;
  /** `package.Service/Method`; a script cannot change it. */
  readonly method: string;
  readonly metadata: readonly HeaderPair[];
  /** The request message in its JSON form. */
  readonly message: unknown;
}

export interface GrpcResponseSnapshot {
  readonly protocol: 'grpc';
  readonly status: { readonly code: number; readonly name: string; readonly message: string };
  readonly metadata: readonly HeaderPair[];
  readonly trailers: readonly HeaderPair[];
  /** The response message in its JSON form, when there was one. */
  readonly message: unknown;
  readonly durationMs: number;
}

type PreparedGrpc = Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;

export function grpcRequestSnapshot(input: PreparedGrpc, messageText: string): GrpcRequestSnapshot {
  let message: unknown;
  try {
    message = JSON.parse(messageText);
  } catch {
    message = messageText;
  }
  return {
    protocol: 'grpc',
    target: input.target,
    method: `${input.service}/${input.method}`,
    metadata: pairsOf(input.metadata),
    message,
  };
}

export function applyGrpcSnapshot(
  input: PreparedGrpc,
  messageText: string,
  before: GrpcRequestSnapshot,
  after: GrpcRequestSnapshot,
): { input: PreparedGrpc; messageText: string } {
  const changed = JSON.stringify(after.message) !== JSON.stringify(before.message);
  return {
    input: { ...input, metadata: entriesOf(after.metadata) },
    messageText: changed ? JSON.stringify(after.message, null, 2) : messageText,
  };
}

export function grpcResponseSnapshot(result: GrpcCallResult): GrpcResponseSnapshot {
  const first = result.responseMessages[0];
  return {
    protocol: 'grpc',
    status: {
      code: result.exchange.status,
      name: result.exchange.statusName,
      message: result.exchange.statusMessage ?? '',
    },
    metadata: recordPairs(result.exchange.headers),
    trailers: recordPairs(result.exchange.trailers),
    message: first?.json,
    durationMs: result.exchange.durationMs,
  };
}

const GRPC_PRE = `
declare const request: {
  readonly target: string;
  readonly method: string;
  readonly metadata: WbWritablePairs;
  message: WbRequestMessage;
};
`;

const GRPC_POST = `
declare const request: {
  readonly target: string;
  readonly method: string;
  readonly metadata: WbPairs;
  readonly message: WbRequestMessage;
};
declare const response: {
  readonly status: { readonly code: number; readonly name: string; readonly message: string };
  readonly metadata: WbPairs;
  readonly trailers: WbPairs;
  readonly message: WbResponseMessage | undefined;
  readonly durationMs: number;
};
`;

const GRPC = String.raw`
const grpcRequest = (snapshot, writable) => {
  const data = {
    target: snapshot.target,
    method: snapshot.method,
    metadata: snapshot.metadata.map(([n, v]) => [n, v]),
    message: JSON.parse(JSON.stringify(snapshot.message === undefined ? null : snapshot.message)),
  };
  const refuse = (what) => () => { throw new TypeError('The ' + what + ' of a sent request cannot be changed'); };
  const request = Object.freeze({
    get target() { return data.target; },
    get method() { return data.method; },
    metadata: pairsApi(data.metadata, writable, 'metadata'),
    get message() { return writable ? data.message : deepFreeze(data.message); },
    set message(value) {
      if (!writable) refuse('message')();
      const text = JSON.stringify(value);
      if (text === undefined) throw new TypeError('request.message must be a JSON value');
      data.message = JSON.parse(text);
    },
  });
  const snapshotOf = () => ({ protocol: 'grpc', target: data.target, method: data.method, metadata: data.metadata, message: data.message });
  return { request, snapshotOf };
};

const grpcResponse = (snapshot) => deepFreeze({
  status: snapshot.status,
  metadata: pairsApi(snapshot.metadata.map(([n, v]) => [n, v]), false, 'metadata'),
  trailers: pairsApi(snapshot.trailers.map(([n, v]) => [n, v]), false, 'metadata'),
  message: snapshot.message,
  durationMs: snapshot.durationMs,
});

if (input.phase === 'pre') {
  const built = grpcRequest(input.request, true);
  define('request', built.request);
  state.request = built.snapshotOf;
} else {
  define('request', grpcRequest(input.request, false).request);
  define('response', grpcResponse(input.response));
}
`;

const requestSchema: z.ZodType<GrpcRequestSnapshot> = z.object({
  protocol: z.literal('grpc'),
  target: z.string(),
  method: z.string(),
  metadata: z.array(headerPairSchema),
  message: z.unknown(),
});

/** gRPC's scripting facet. */
export const grpcScripting: ProtocolScripting<GrpcRequestSnapshot, GrpcResponseSnapshot> = {
  declarations: (phase) => (phase === 'pre' ? GRPC_PRE : GRPC_POST),
  reference: () => [
    { title: 'gRPC: pre-request', declarations: GRPC_PRE },
    { title: 'gRPC: post-response', declarations: GRPC_POST },
  ],
  prelude: () => GRPC,
  requestSchema,
  inspect(snapshot): SnapshotFacts {
    return {
      destination: snapshot.target,
      fixed: snapshot.method,
      pairs: snapshot.metadata,
      lines: [],
      texts: [snapshot.target, ...snapshot.metadata.flat(), JSON.stringify(snapshot.message) ?? ''],
    };
  },
  /**
   * A target never changes at all. Core's destination rule already holds a `host:port` target to
   * that; one written as a URL (`grpcs://host:443`) would be allowed another path, so it is held
   * here.
   */
  validate(before, after): ScriptFailure | undefined {
    return after.target === before.target
      ? undefined
      : { code: 'script-origin-change', message: 'A script cannot change the target of a gRPC call' };
  },
};
