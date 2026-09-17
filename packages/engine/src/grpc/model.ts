/**
 * The gRPC third of the project model: a *gRPC API* — a target, a set of `.proto` files, and a
 * tree of folders and requests, one request per method call the user wants to keep.
 *
 * A gRPC API is the third sibling container beside a SOAP interface and a REST API (ADR-0007). It
 * lives in the same `apis/<slug>/` directory a REST API does and identifies itself with
 * `kind: grpc` at the top of every file it writes, so a file says what it is without anyone having
 * to know which directory implies which protocol. In memory it is kept in its own list on the
 * project so the compiler points at every surface that needs a third branch rather than letting a
 * gRPC API fall through a REST-shaped `if`.
 *
 * The same rules as the other two models apply: every field is `readonly`, ids are ULIDs so an
 * entity survives a rename, `slug` is the file-system name derived from `name`, and nothing here
 * ever holds a secret — credentials are `secretRef`s resolved from the OS keychain at send time.
 */

import type { AuthConfig, CreateOptions, IdGenerator } from '../project/model.js';
import { generateId } from '../project/model.js';
import { slugify } from '../project/paths.js';
import type { KeyValueEntry } from '../rest/model.js';

/**
 * The four shapes a gRPC method can take, as the `.proto` declares them with the `stream` keyword.
 * Recorded on the request so the editor knows how many messages to expect on each side even when
 * the definition is not to hand.
 */
export type GrpcMethodKind = 'unary' | 'server-streaming' | 'client-streaming' | 'bidi-streaming';

/**
 * Per-request transport settings. Every field is optional and an absent one means *inherit*, not
 * *off*: the send resolves request → API → project → preference, exactly as a REST request does.
 */
export interface GrpcRequestSettings {
  /** The call deadline, sent as `grpc-timeout` and enforced locally. */
  readonly timeoutMs?: number;
  /** Send even when the server's certificate does not verify; badged in red wherever it appears. */
  readonly trustInvalid?: boolean;
  /** Id of a `wss/keystores.yaml` entry: the client identity this request's TLS handshake presents. */
  readonly sslKeystoreRef?: string;
  readonly bindAddress?: string;
  /** Stop reading the response once this many message bytes have arrived. */
  readonly maxSizeBytes?: number;
  /** JSON-escape every property value substituted into the message text. Off by default. */
  readonly escapeProperties?: boolean;
}

/** A saved gRPC request: everything but the message text lives in `<slug>.request.yaml`. */
export interface GrpcRequestDef {
  readonly kind: 'grpc';
  readonly id: string;
  readonly name: string;
  /** File-system name (without the `.request.yaml` suffix). */
  readonly slug: string;
  readonly order: number;
  /** Markdown, shown in the Details inspector; imported from the method's leading comment. */
  readonly description?: string;
  /** The fully qualified service name, e.g. `helloworld.Greeter`. */
  readonly service: string;
  /** The method's own name, e.g. `SayHello`. */
  readonly method: string;
  readonly methodKind: GrpcMethodKind;
  /** Metadata sent with the call, one row per key. Names are lower-cased on the wire. */
  readonly metadata: readonly KeyValueEntry[];
  /**
   * The request message as JSON text, exactly as edited, stored in the sibling `<slug>.body.json`.
   * One object for a unary or server-streaming call; a JSON array of objects for a client- or
   * bidirectional-streaming call, sent in order before the stream is closed.
   */
  readonly message: string;
  /** `inherit` by default: the folder chain, then the API, decides. */
  readonly auth: AuthConfig;
  readonly settings: GrpcRequestSettings;
  /**
   * True when the method this request was made from is no longer in the API's definition. Nothing
   * is deleted on a re-import; the request survives badged, as a SOAP request does.
   */
  readonly orphaned?: boolean;
}

/** A named node in a gRPC API's tree. An import makes one per service. */
export interface GrpcFolder {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  /** Default credentials for everything inside, unless a child says otherwise. */
  readonly auth?: AuthConfig;
  readonly folders: readonly GrpcFolder[];
  readonly requests: readonly GrpcRequestDef[];
}

/**
 * Which reflection protocol version to ask a server with. `auto` tries `grpc.reflection.v1` and
 * falls back to `grpc.reflection.v1alpha`, which is what a server predating the stable package
 * serves; pinning one is for a server that answers both and answers one of them badly.
 */
export type GrpcReflectionVersion = 'auto' | 'v1' | 'v1alpha';

/** The versions a user can pick, in the order the selector offers them. */
export const GRPC_REFLECTION_VERSIONS: readonly GrpcReflectionVersion[] = ['auto', 'v1', 'v1alpha'];

/**
 * Where an API's schema came from, cached under `apis/<slug>/definition/`.
 *
 * `proto` is an import of `.proto` files, cached byte-exact at their import paths. `reflection` is a
 * server that described itself, cached as the descriptor set it sent. A project written before
 * reflection existed has no `kind`, and reads as `proto`.
 */
export interface GrpcDefinitionRef {
  /** How the definition was obtained. */
  readonly kind: 'proto' | 'reflection';
  /** Where it came from: a target for reflection, a URL or a path as the user gave it for an import. */
  readonly source: string;
  readonly cache: boolean;
  /**
   * For an import, the import paths of the files it started from. For reflection, the names of the
   * descriptor files declaring the services.
   */
  readonly roots: readonly string[];
  /** For a reflection definition, the version to ask with when it is refreshed. Absent means `auto`. */
  readonly reflectionVersion?: GrpcReflectionVersion;
  /**
   * For a reflection definition, ask again even when the server's certificate does not verify —
   * remembered from the discovery so a refresh reaches the same development server it did.
   */
  readonly trustInvalid?: boolean;
}

/** A gRPC API: a `host:port` target, whether to speak TLS to it, and a tree of folders and requests. */
export interface GrpcApi {
  readonly kind: 'grpc';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** Position among the project's interfaces, REST APIs and gRPC APIs, which share one ordering space. */
  readonly order: number;
  readonly description?: string;
  /**
   * The server to call, as `host:port` (or a `grpc://` / `grpcs://` / `http(s)://` URL, whose scheme
   * decides TLS). May contain `${…}` properties; an environment can override it per environment
   * under the same key a REST base URL uses.
   */
  readonly target: string;
  /** Speak TLS to the target. Off means plaintext HTTP/2 (`h2c`), what a local development server speaks. */
  readonly tls: boolean;
  /** Metadata every request under this API sends unless it sets the same key itself. */
  readonly metadata: readonly KeyValueEntry[];
  readonly auth?: AuthConfig;
  readonly definition?: GrpcDefinitionRef;
  readonly folders: readonly GrpcFolder[];
  readonly requests: readonly GrpcRequestDef[];
}

function idOf(options: CreateOptions | undefined): string {
  return options?.id ?? (options?.newId ?? generateId)();
}

/** Input to {@link createGrpcApi} beyond the name. */
export interface CreateGrpcApiInput extends CreateOptions {
  readonly target?: string;
  readonly tls?: boolean;
  readonly slug?: string;
  readonly description?: string;
  readonly metadata?: readonly KeyValueEntry[];
  readonly auth?: AuthConfig;
  readonly definition?: GrpcDefinitionRef;
  readonly folders?: readonly GrpcFolder[];
  readonly requests?: readonly GrpcRequestDef[];
}

/**
 * Creates an empty gRPC API. TLS defaults from the target: on for a `grpcs://`/`https://` URL or a
 * `:443` port, otherwise off, since a bare `localhost:50051` is what a development server offers.
 */
export function createGrpcApi(name: string, input: CreateGrpcApiInput = {}): GrpcApi {
  const target = input.target ?? '';
  return {
    kind: 'grpc',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    target,
    tls: input.tls ?? defaultTlsFor(target),
    metadata: input.metadata ?? [],
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    ...(input.definition !== undefined ? { definition: input.definition } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

/** Whether a target's spelling says it expects TLS. */
export function defaultTlsFor(target: string): boolean {
  const trimmed = target.trim().toLowerCase();
  if (trimmed.startsWith('grpcs://') || trimmed.startsWith('https://')) {
    return true;
  }
  if (trimmed.startsWith('grpc://') || trimmed.startsWith('http://')) {
    return false;
  }
  return /:443$/.test(trimmed);
}

/** Input to {@link createGrpcFolder} beyond the name. */
export interface CreateGrpcFolderInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly folders?: readonly GrpcFolder[];
  readonly requests?: readonly GrpcRequestDef[];
}

/** Creates an empty folder. */
export function createGrpcFolder(name: string, input: CreateGrpcFolderInput = {}): GrpcFolder {
  return {
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

/** Input to {@link createGrpcRequest} beyond the name. */
export interface CreateGrpcRequestInput extends CreateOptions {
  readonly service?: string;
  readonly method?: string;
  readonly methodKind?: GrpcMethodKind;
  readonly slug?: string;
  readonly description?: string;
  readonly metadata?: readonly KeyValueEntry[];
  readonly message?: string;
  readonly auth?: AuthConfig;
  readonly settings?: GrpcRequestSettings;
}

/** Creates a unary request with an empty message and inherited credentials. */
export function createGrpcRequest(name: string, input: CreateGrpcRequestInput = {}): GrpcRequestDef {
  return {
    kind: 'grpc',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    service: input.service ?? '',
    method: input.method ?? '',
    methodKind: input.methodKind ?? 'unary',
    metadata: input.metadata ?? [],
    message: input.message ?? '{}',
    auth: input.auth ?? { type: 'inherit' },
    settings: input.settings ?? {},
  };
}

export type { IdGenerator };

/** Every request in `folder` and, depth-first, in the folders below it. */
export function grpcFolderRequests(folder: Pick<GrpcFolder, 'folders' | 'requests'>): GrpcRequestDef[] {
  return [...folder.requests, ...folder.folders.flatMap((child) => grpcFolderRequests(child))];
}

/** Every request in `api`, its root requests first and then each folder depth-first. */
export function grpcApiRequests(api: GrpcApi): GrpcRequestDef[] {
  return grpcFolderRequests(api);
}

/** Every folder in `api`, depth-first. */
export function grpcApiFolders(api: GrpcApi): GrpcFolder[] {
  const walk = (folders: readonly GrpcFolder[]): GrpcFolder[] =>
    folders.flatMap((folder) => [folder, ...walk(folder.folders)]);
  return walk(api.folders);
}

/** The HTTP/2 `:path` of a method call: `/<service>/<method>`. */
export function grpcMethodPath(service: string, method: string): string {
  return `/${service}/${method}`;
}

/** Whether the client side of a method sends a stream, so the message text is an array. */
export function clientStreams(kind: GrpcMethodKind): boolean {
  return kind === 'client-streaming' || kind === 'bidi-streaming';
}

/** Whether the server side of a method answers with a stream. */
export function serverStreams(kind: GrpcMethodKind): boolean {
  return kind === 'server-streaming' || kind === 'bidi-streaming';
}
