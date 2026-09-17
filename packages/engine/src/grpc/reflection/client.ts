/**
 * Discovering a server's services over gRPC server reflection.
 *
 * A user who has the `.proto` files imports them; a user who has only an address asks the server
 * what it serves. The protocol for that is `ServerReflectionInfo`, and although it is declared as a
 * bidirectional stream, the exchange is strictly request/response per message and the client always
 * knows what to ask for before it asks — so the whole discovery resolves as a short sequence of
 * ordinary batch calls through {@link sendGrpc}, with no transport change and with trust, proxy,
 * credentials and deadline behaving exactly as they do for a call the user sends by hand.
 *
 * The rounds are:
 *
 * 1. `list_services` — the service names the server exposes.
 * 2. One `file_containing_symbol` per service. A well-behaved server answers each with the file
 *    declaring the service *and* its transitive dependencies.
 * 3. Whatever dependency is still missing, by `file_by_filename`, until nothing new arrives or the
 *    round cap is reached — so a server that answers a dependency with another dependency cannot
 *    keep the client asking forever.
 */

import { Buffer } from 'node:buffer';
import { GrpcError } from '../../errors.js';
import { decodeMessage, encodeMessage } from '../codec.js';
import type { ProtoSet } from '../proto/load.js';
import { sendGrpc } from '../send.js';
import type { GrpcSendInput } from '../send.js';
import { grpcStatusName } from '../status.js';
import { descriptorHeader, protoSetFromDescriptors } from './descriptors.js';
import type { GrpcReflectionVersion } from './proto.js';
import {
  REFLECTION_METHOD,
  REFLECTION_VERSIONS,
  reflectionPackage,
  reflectionProtoSet,
  reflectionServiceName,
} from './proto.js';

export type { GrpcReflectionVersion } from './proto.js';

/** How many `file_by_filename` rounds to run before giving up on the files still missing. */
const DEFAULT_MAX_ROUNDS = 8;

/** `UNIMPLEMENTED`, which is what a server that does not know a reflection version answers with. */
const UNIMPLEMENTED = 12;

/** Everything {@link reflectServices} needs: the transport half of a call, plus the version to speak. */
export interface GrpcReflectInput extends Omit<GrpcSendInput, 'service' | 'method' | 'messages'> {
  /** Which protocol version to use. Defaults to `auto`: v1 first, v1alpha if the server refuses it. */
  readonly version?: GrpcReflectionVersion;
  /** Cap on the dependency-chasing rounds. Defaults to 8. */
  readonly maxRounds?: number;
}

/** What a server described of itself. */
export interface GrpcReflectionResult {
  /** The version that answered, which is what an `auto` discovery resolved to. */
  readonly version: 'v1' | 'v1alpha';
  /** The services the server exposes, reflection's own services excluded. */
  readonly services: readonly string[];
  /** Every descriptor collected, keyed by the file name its own header carries. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The files declaring the services, which the schema is loaded from. */
  readonly roots: readonly string[];
  /** Files something imports that the server never described, after the rounds ran out. */
  readonly missing: readonly string[];
}

/** Whether a name is one of reflection's own services, which a discovered API has no use for. */
export function isReflectionService(name: string): boolean {
  return REFLECTION_VERSIONS.some((version) => name === reflectionServiceName(version));
}

/** Whether an error says the server does not implement the reflection version that was tried. */
function refusedVersion(error: unknown): boolean {
  return error instanceof GrpcError && error.code === 'grpc-reflection-unsupported';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** The `bytes` of a descriptor field, which the codec hands over as base64 per the JSON mapping. */
function descriptorBytes(value: unknown): Uint8Array[] {
  const list = Array.isArray(value) ? value : [];
  return list
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => new Uint8Array(Buffer.from(entry, 'base64')));
}

/** One round: every request goes out on one stream, and the responses come back in the same order. */
async function exchange(
  input: GrpcReflectInput,
  version: 'v1' | 'v1alpha',
  set: ProtoSet,
  requests: readonly Record<string, unknown>[],
): Promise<unknown[]> {
  const pkg = reflectionPackage(version);
  const exchanged = await sendGrpc({
    ...input,
    service: reflectionServiceName(version),
    method: REFLECTION_METHOD,
    messages: requests.map((request) => encodeMessage(set, `${pkg}.ServerReflectionRequest`, request)),
  });
  if (exchanged.status !== 0) {
    const detail = exchanged.statusMessage === undefined ? '' : `: ${exchanged.statusMessage}`;
    throw new GrpcError(
      exchanged.status === UNIMPLEMENTED ? 'grpc-reflection-unsupported' : 'grpc-reflection-failed',
      exchanged.status === UNIMPLEMENTED
        ? `${input.target} does not serve ${reflectionServiceName(version)}${detail}`
        : `${input.target} answered the reflection call with ${grpcStatusName(exchanged.status)}${detail}`,
      { details: { status: exchanged.status, version, service: reflectionServiceName(version) } },
    );
  }
  return exchanged.messages.map((bytes) => decodeMessage(set, `${pkg}.ServerReflectionResponse`, bytes));
}

/**
 * The `error_response` a server may answer an individual request with, as an error.
 *
 * A reflection error is reported inside the response rather than as the call's status, because one
 * stream carries many requests; `UNIMPLEMENTED` here means the same thing it means in the trailers,
 * so it feeds the version fallback the same way.
 */
function assertNoError(response: Record<string, unknown>, version: 'v1' | 'v1alpha', target: string): void {
  const error = response['error_response'];
  if (error === undefined) {
    return;
  }
  const record = asRecord(error);
  const code = Number(record['error_code'] ?? 2);
  const message = typeof record['error_message'] === 'string' ? record['error_message'] : '';
  throw new GrpcError(
    code === UNIMPLEMENTED ? 'grpc-reflection-unsupported' : 'grpc-reflection-failed',
    `${target} refused a reflection request with ${grpcStatusName(code)}${message === '' ? '' : `: ${message}`}`,
    { details: { status: code, version } },
  );
}

/** Runs every round against one version. */
async function reflectWith(input: GrpcReflectInput, version: 'v1' | 'v1alpha'): Promise<GrpcReflectionResult> {
  const set = reflectionProtoSet(version);
  const [listed] = await exchange(input, version, set, [{ list_services: '' }]);
  if (listed === undefined) {
    throw new GrpcError('grpc-reflection-failed', `${input.target} answered the service list with no response`, {
      details: { version },
    });
  }
  assertNoError(asRecord(listed), version, input.target);
  const entries = asRecord(asRecord(listed)['list_services_response'])['service'];
  const services = (Array.isArray(entries) ? entries : [])
    .map((entry) => asRecord(entry)['name'])
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .filter((name) => !isReflectionService(name));

  const files = new Map<string, Uint8Array>();
  const roots: string[] = [];
  const collect = (response: unknown): Uint8Array[] => {
    const record = asRecord(response);
    assertNoError(record, version, input.target);
    const descriptors = descriptorBytes(asRecord(record['file_descriptor_response'])['file_descriptor_proto']);
    for (const bytes of descriptors) {
      const { name } = descriptorHeader(bytes);
      if (name !== '' && !files.has(name)) {
        files.set(name, bytes);
      }
    }
    return descriptors;
  };

  if (services.length > 0) {
    const responses = await exchange(
      input,
      version,
      set,
      services.map((service) => ({ file_containing_symbol: service })),
    );
    for (const response of responses) {
      // The file declaring the asked-for symbol comes first by convention; the rest are its imports.
      const first = collect(response)[0];
      if (first !== undefined) {
        const { name } = descriptorHeader(first);
        if (name !== '' && !roots.includes(name)) {
          roots.push(name);
        }
      }
    }
  }

  const stillMissing = (): string[] => {
    const wanted = new Set<string>();
    for (const bytes of files.values()) {
      for (const dependency of descriptorHeader(bytes).dependencies) {
        if (!files.has(dependency)) {
          wanted.add(dependency);
        }
      }
    }
    return [...wanted];
  };

  const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let missing = stillMissing();
  for (let round = 0; round < maxRounds && missing.length > 0; round += 1) {
    const before = files.size;
    const responses = await exchange(
      input,
      version,
      set,
      missing.map((name) => ({ file_by_filename: name })),
    );
    for (const response of responses) {
      collect(response);
    }
    if (files.size === before) {
      break;
    }
    missing = stillMissing();
  }

  return { version, services, files, roots: roots.length > 0 ? roots : [...files.keys()], missing };
}

/**
 * Asks a server what it serves.
 *
 * `auto` tries `grpc.reflection.v1` and falls back to `grpc.reflection.v1alpha` when the server
 * refuses it, which is what a server predating the stable package does.
 *
 * @throws HttpError for a connection, DNS, TLS or abort failure; GrpcError
 * `grpc-reflection-unsupported` when the server serves no reflection version this client knows,
 * `grpc-reflection-failed` when it refuses a request; ProtoError `grpc-reflection-descriptor` when
 * a descriptor it sent cannot be read
 */
export async function reflectServices(input: GrpcReflectInput): Promise<GrpcReflectionResult> {
  const versions =
    input.version === undefined || input.version === 'auto' ? REFLECTION_VERSIONS : ([input.version] as const);
  let refusal: unknown;
  for (const version of versions) {
    try {
      return await reflectWith(input, version);
    } catch (error) {
      if (!refusedVersion(error)) {
        throw error;
      }
      refusal = error;
    }
  }
  throw refusal;
}

/** What {@link reflectProtoSet} produced: the loaded schema and the discovery behind it. */
export interface GrpcReflectedProtoSet extends GrpcReflectionResult {
  readonly set: ProtoSet;
}

/**
 * Discovers a server's services and resolves them into a loaded schema, which is the form the rest
 * of the gRPC code — `describeServices`, the codec, `apiFromProtoSet` — already reads.
 *
 * @throws as {@link reflectServices}, plus ProtoError `grpc-reflection-incomplete` when the set the
 * server described does not resolve and files it imports are missing from it, and `proto-unresolved`
 * when it does not resolve for any other reason
 */
export async function reflectProtoSet(input: GrpcReflectInput): Promise<GrpcReflectedProtoSet> {
  const result = await reflectServices(input);
  try {
    return { ...result, set: protoSetFromDescriptors({ files: result.files, roots: result.roots }) };
  } catch (error) {
    if (result.missing.length === 0) {
      throw error;
    }
    throw new GrpcError(
      'grpc-reflection-incomplete',
      `${input.target} did not describe ${result.missing.join(', ')}, which the files it did describe import`,
      { cause: error, details: { missing: [...result.missing], version: result.version } },
    );
  }
}
