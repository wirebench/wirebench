/**
 * gRPC's run facet (spec §3.3). A run selects unary calls only, since a stream needs an assertion
 * model a run does not have yet; a host opens any method kind, and drives a client or bidi stream's
 * request side when it opens one interactive (spec §5.2). A send resolves the call and refuses one it cannot make, loads the API's schema
 * (without a schema there is no call, so no token is worth fetching; a schema that does not load is
 * remembered for the run), runs its pre-request script, connects, then calls (spec §3.4).
 */
import type { AssertionSubject } from '../assert/model.js';
import { GrpcError, isWirebenchError, WirebenchError } from '../errors.js';
import type { AuthConfig } from '../project/model.js';
import { apiDefinitionDir } from '../project/paths.js';
import type { ProtocolRun, RunGroup, RunScope, ScriptedSend } from '../protocol/module.js';
import { resolveAuthChain } from '../http/auth/apply-auth.js';
import { scopesFor } from '../run/context.js';
import { exchangeController, notStreaming } from '../run/exchange.js';
import type { ExchangeController, StreamingSide } from '../run/exchange.js';
import type { AttemptedRequest } from '../run/host.js';
import type { SentRequest } from '../run/run.js';
import type { RunContext } from '../run/context.js';
import {
  authFor,
  baseUrlFor,
  dropRefusedToken,
  keystoreNeeds,
  tlsFor,
  unresolvedError,
  withSecrets,
} from '../run/send-helpers.js';
import type { Resolved } from '../run/send-helpers.js';
import { ORPHANED_STEP_REASON, findInTree, walkTree } from '../run/tree.js';
import { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from './scripting.js';
import type { GrpcRequestSnapshot } from './scripting.js';
import { grpcMessageTypes, grpcScriptTypes } from './script-types.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import { toGrpcSendInput } from './send-input.js';
import { readGrpcDefinitionCache } from './cache.js';
import { callGrpc } from './call.js';
import type { GrpcCallResult, GrpcCallStreamHandle, GrpcResponseMessage } from './call.js';
import type { GrpcLiveEvent } from './events.js';
import { expandGrpcInput } from './expand.js';
import { clientStreams, grpcMethodPath } from './model.js';
import type { GrpcApi, GrpcFolder, GrpcRequestDef } from './model.js';
import { loadProtoSet } from './proto/load.js';
import type { ProtoSet } from './proto/load.js';
import { protoSetFromDescriptorSet } from './reflection/descriptors.js';
import type { GrpcSendInput } from './send.js';
import { grpcStatusNames } from './status.js';

/** One saved gRPC request selected for a run. */
export interface GrpcSelected {
  readonly kind: 'grpc';
  readonly path: string;
  readonly group: string;
  readonly api: GrpcApi;
  readonly chain: readonly GrpcFolder[];
  readonly request: GrpcRequestDef;
}

/** A unary call ready for `callGrpc`, which also takes the API's proto set and the message. */
// The streaming hooks are left out: a run makes unary calls, and wants only the result.
export type GrpcResolvedInput = Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;

/** The same chain for a gRPC request: request, its folders inside-out, the API. */
export function grpcEffectiveAuth(selected: GrpcSelected): AuthConfig {
  const { api, chain, request } = selected;
  return resolveAuthChain([request.auth, ...[...chain].reverse().map((folder) => folder.auth), api.auth]);
}

/**
 * The app's `resolveGrpcSend` plus what its send handler adds (spec §3.4): the target through the
 * environment's override for the API (the slot a REST base URL uses), the settings ladder, and one
 * expansion pass over target, metadata and message, nothing connected. A reference nothing
 * resolves is reported in `unresolved`, not thrown, and so is a call with no method chosen: the
 * send refuses both (`refuseUnsendable`), a preview shows them.
 *
 * @throws WirebenchError `secret-missing`
 */
export async function resolveGrpc(
  selected: GrpcSelected,
  context: RunContext,
): Promise<Resolved<GrpcResolvedInput> & { readonly messageText: string }> {
  const { api, request } = selected;
  const scopes = scopesFor(context);
  const target = baseUrlFor(context, { slug: api.slug, baseUrl: api.target });
  const unexpanded = toGrpcSendInput({
    request: {
      service: request.service,
      method: request.method,
      methodKind: request.methodKind,
      metadata: request.metadata,
      settings: request.settings,
    },
    target,
    tls: api.tls,
    apiMetadata: api.metadata,
    projectSettings: context.project.settings,
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  const withMessage = { ...unexpanded, messageText: request.message };
  const withTokens = await withSecrets(withMessage, scopes, context.host.getSecret, context.secretPlaceholders);
  const { input, unresolved } = expandGrpcInput(withMessage, withTokens, {
    escape: request.settings.escapeProperties === true,
  });
  const { messageText, ...transport } = input;
  return {
    input: { ...transport, ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}) },
    messageText,
    unresolved,
  };
}

/**
 * Refuses a resolved call the send cannot make, in the app's order: a reference nothing resolves,
 * then no service or method chosen. Both come before the schema is loaded.
 *
 * @throws WirebenchError `grpc-unresolved-properties` | `grpc-method-unset`
 */
function refuseUnsendable(selected: GrpcSelected, resolved: Resolved<GrpcResolvedInput>): void {
  if (resolved.unresolved.length > 0) {
    throw unresolvedError('grpc-unresolved-properties', selected.path, resolved.unresolved);
  }
  if (selected.request.service === '' || selected.request.method === '') {
    throw new WirebenchError('grpc-method-unset', 'Choose the service and method this request calls first.', {
      details: { path: selected.path },
    });
  }
}

/**
 * The request's own TLS identity and trust decision and the chain's credentials (an OAuth2 token
 * included), over a resolved call: what a send does after its pre-request script, so the script
 * never sees a credential (spec §7). There is no proxy: the app sends gRPC direct as well.
 *
 * @throws WirebenchError `secret-missing` | `auth-grant-unsupported` | `keystore-missing`
 */
export async function connectGrpc(
  selected: GrpcSelected,
  context: RunContext,
  input: GrpcResolvedInput,
): Promise<GrpcResolvedInput> {
  const { request } = selected;
  const tls = await tlsFor(context, request.settings.sslKeystoreRef, request.settings.trustInvalid === true);
  const auth = await authFor(grpcEffectiveAuth(selected), selected.path, context, tls);
  return {
    ...input,
    ...(auth !== undefined ? { auth } : {}),
    ...(tls !== undefined ? { tlsOptions: { ...input.tlsOptions, ...tls } } : {}),
  };
}

/**
 * Reads a gRPC API's schema from `apis/<slug>/definition/`, as the app's `grpcProtoSetFor` does:
 * the `.proto` sources an import cached, or the descriptor set reflection cached. A run never
 * reflects against a server, so an API with no cache has no schema and none of its calls can run.
 *
 * @throws WirebenchError `grpc-definition-missing` when there is no cache; whatever the loaders
 * throw for one that does not load
 */
async function loadProtoSetFor(projectDir: string, api: GrpcSelected['api']): Promise<ProtoSet> {
  let cache: Awaited<ReturnType<typeof readGrpcDefinitionCache>>;
  try {
    cache = await readGrpcDefinitionCache(apiDefinitionDir(projectDir, api.slug));
  } catch (error) {
    if (isWirebenchError(error) && error.code === 'definition-cache-missing') {
      throw new WirebenchError(
        'grpc-definition-missing',
        `The gRPC API "${api.name}" has no cached definition; import its .proto files or discover it in the app first.`,
        { details: { api: api.name }, cause: error },
      );
    }
    throw error;
  }
  return cache.kind === 'proto'
    ? loadProtoSet(cache.sources, { roots: cache.manifest.roots })
    : protoSetFromDescriptorSet(cache.descriptors, { roots: cache.manifest.roots });
}

/**
 * A unary call's answer as assertions see it: the gRPC status code (0 = OK), and the one response
 * message as JSON. No message, or one that did not decode, leaves nothing a `match` can read.
 * Exported for its unit test; not part of the run module's public surface.
 */
export function grpcSubject(result: GrpcCallResult): AssertionSubject {
  const first = result.responseMessages[0];
  const decoded = first !== undefined && first.json !== undefined;
  return {
    protocol: 'grpc',
    status: result.exchange.status,
    durationMs: result.exchange.durationMs,
    bodyText: decoded ? JSON.stringify(first.json) : '',
    bodyKind: decoded ? 'json' : 'other',
    // Metadata first, then trailers: a header assertion or transfer takes the first value it finds.
    headers: [...Object.entries(result.exchange.headers), ...Object.entries(result.exchange.trailers)],
    statusNames: grpcStatusNames,
  };
}

/** gRPC's `UNAUTHENTICATED`: the server's word for a credential it will not accept. */
const GRPC_UNAUTHENTICATED = 16;

/**
 * The API's schema: the host's when it lends one, otherwise read from the definition cache once per
 * run, a failed load remembered.
 */
async function protoSetFor(selected: GrpcSelected, scope: RunScope, context: RunContext): Promise<ProtoSet> {
  const lent = context.host.protoSetFor;
  if (lent !== undefined) return (await lent(selected)) as ProtoSet;
  const { api } = selected;
  return scope.memo(`grpc:${api.id}:proto-set`, () => loadProtoSetFor(scope.context.projectDir, api));
}

const STREAMING_STEP_REASON = 'A streaming gRPC call cannot be a sequence step; only unary calls can';

/** What a failed call was about to put on the wire: an HTTP/2 POST to `/<service>/<method>`, its metadata. */
function attemptedOf(input: GrpcResolvedInput): AttemptedRequest {
  return {
    url: `${input.tls ? 'https' : 'http'}://${input.target}${grpcMethodPath(input.service, input.method)}`,
    method: 'POST',
    headers: Object.fromEntries(input.metadata.filter((row) => row.enabled).map((row) => [row.name, row.value])),
  };
}

/**
 * An interactive call's request side, between the handle `open` returns at once and the call that
 * opens it later: a push before the call opens waits for it, a half-close before it opens ends it as
 * it opens, and a call that ends without opening refuses the pushes still waiting.
 */
interface GrpcStreamState {
  /** The side the handle drives. */
  readonly streaming: StreamingSide;
  /** Given to `callGrpc` as its `onOpen`. */
  opened(handle: GrpcCallStreamHandle): void;
  /** The call has ended, opened or not. */
  settled(): void;
}

function grpcStreamState(controller: ExchangeController<GrpcLiveEvent>): GrpcStreamState {
  let side: GrpcCallStreamHandle | undefined;
  let ended = false;
  let resolve: (handle: GrpcCallStreamHandle) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const stream = new Promise<GrpcCallStreamHandle>((onOpen, onClosed) => {
    resolve = onOpen;
    reject = onClosed;
  });
  // Observed here, so a call that never opens and has no push waiting reports nothing unhandled.
  stream.catch(() => undefined);
  const end = (): void => {
    ended = true;
    side?.end();
  };
  return {
    streaming: {
      push: async (message) => {
        if (!('text' in message)) throw notStreaming('grpc');
        return (await stream).send(message.text);
      },
      halfClose: () => {
        if (ended) return;
        end();
        controller.queue.push({ protocol: 'grpc', kind: 'closed' });
      },
      close: end,
    },
    opened(handle) {
      side = handle;
      if (ended) handle.end();
      resolve(handle);
      controller.queue.push({ protocol: 'grpc', kind: 'open' });
    },
    settled() {
      if (side !== undefined) return;
      reject(
        new GrpcError('grpc-stream-closed', 'The request side of this call is already closed', {
          details: { halfClosed: ended, settled: true },
        }),
      );
    },
  };
}

/** How one call is sent: its live events and, for an interactive call, its request side. */
interface GrpcSendMode {
  readonly controller: ExchangeController<GrpcLiveEvent>;
  readonly live: boolean;
  readonly stream?: GrpcStreamState;
}

/**
 * One gRPC request as a run or a host sends it (spec §3.4): resolve, run its pre-request script when
 * `scripts` is given, connect, call, then its post-response script. A failure is told to the host
 * with its stage and what was attempted: a reference nothing resolves in the prepare stage.
 */
async function sendGrpcItem(
  selected: GrpcSelected,
  scope: RunScope,
  context: RunContext,
  scripts: ScriptedSend | undefined,
  mode: GrpcSendMode,
): Promise<SentRequest> {
  const { controller, live, stream } = mode;
  const startedAt = Date.now();
  // Never masks the send's own error: a row that cannot be built, or a host that throws, is dropped.
  const failed = (stage: 'prepare' | 'send', error: unknown, attempted: GrpcResolvedInput | undefined): void => {
    try {
      context.host.events?.onFailed?.(selected, {
        stage,
        error,
        startedAt,
        durationMs: Date.now() - startedAt,
        ...(attempted !== undefined ? { attempted: attemptedOf(attempted), input: attempted } : {}),
      });
    } catch {
      // Deliberately ignored — see above.
    }
  };
  try {
    let input: GrpcResolvedInput | undefined;
    let connected: GrpcResolvedInput;
    let messageText: string;
    let protoSet: ProtoSet;
    let sent: GrpcRequestSnapshot | undefined;
    try {
      const resolved = await resolveGrpc(
        selected,
        scripts !== undefined ? { ...context, secretPlaceholders: scripts.placeholders } : context,
      );
      input = resolved.input;
      refuseUnsendable(selected, resolved);
      // Before the send connects: without a schema there is no call, so no token is worth fetching.
      protoSet = await protoSetFor(selected, scope, context);
      if (scripts === undefined) {
        connected = await connectGrpc(selected, context, resolved.input);
        messageText = resolved.messageText;
      } else {
        const before = grpcRequestSnapshot(resolved.input, resolved.messageText);
        sent = await scripts.session.pre(before);
        const changed = applyGrpcSnapshot(resolved.input, resolved.messageText, before, sent);
        const restored = await scripts.placeholders.restore(
          { metadata: changed.input.metadata, messageText: changed.messageText },
          context.host.getSecret,
        );
        input = { ...changed.input, metadata: restored.metadata };
        connected = await connectGrpc(selected, context, input);
        messageText = restored.messageText;
      }
    } catch (error) {
      failed('prepare', error, input);
      throw error;
    }
    let result: GrpcCallResult;
    try {
      result = await callGrpc({
        ...connected,
        set: protoSet,
        messageText,
        signal: controller.signal,
        // Only a live send decodes each message as it arrives; any other has them all in the result.
        ...(live
          ? {
              onHeaders: (headers: Readonly<Record<string, string>>, httpStatus: number) =>
                controller.queue.push({ protocol: 'grpc', kind: 'headers', httpStatus, headers }),
              onMessage: (message: GrpcResponseMessage, index: number) =>
                controller.queue.push({ protocol: 'grpc', kind: 'message', index, message }),
            }
          : {}),
        ...(stream !== undefined ? { onOpen: (handle: GrpcCallStreamHandle) => stream.opened(handle) } : {}),
      });
    } catch (error) {
      failed('send', error, connected);
      throw error;
    }
    dropRefusedToken(context, connected.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
    return {
      subject: grpcSubject(result),
      raw: result.exchange,
      exchange: { kind: 'grpc', grpc: result },
      origin: connected.target,
      ...(scripts !== undefined
        ? { script: await scripts.session.post(sent as GrpcRequestSnapshot, grpcResponseSnapshot(result)) }
        : {}),
    };
  } finally {
    stream?.settled();
  }
}

/** gRPC's run facet. */
export const grpcRun: ProtocolRun<GrpcSelected> = {
  groups(project) {
    return project.grpcApis.map((api) => {
      const candidates: RunGroup<GrpcSelected>['candidates'][number][] = [];
      walkTree<GrpcFolder, GrpcRequestDef, GrpcSelected>(
        api,
        [],
        api.name,
        `apis/${api.slug}/requests`,
        (request, chain, group) =>
          request.orphaned === true || request.methodKind !== 'unary'
            ? undefined
            : { kind: 'grpc', path: `${group}/${request.name}`, group, api, chain, request },
        candidates,
      );
      return { order: api.order, name: api.name, candidates };
    });
  },

  whyNotRunnable(project, requestId) {
    for (const api of project.grpcApis) {
      const request = findInTree(api, requestId);
      if (request !== undefined) {
        if (request.methodKind !== 'unary') {
          return STREAMING_STEP_REASON;
        }
        return request.orphaned === true ? ORPHANED_STEP_REASON : undefined;
      }
    }
    return undefined;
  },

  open(selected, scope, host, options) {
    const controller = exchangeController<GrpcLiveEvent>('grpc', options);
    const context: RunContext = { ...scope.context, host, signal: controller.signal };
    // Only a client or bidi stream has a request side to drive; any other call refuses a push.
    const stream =
      options.interactive && clientStreams(selected.request.methodKind) ? grpcStreamState(controller) : undefined;
    const mode: GrpcSendMode = {
      controller,
      live: options.live === true,
      ...(stream !== undefined ? { stream } : {}),
    };
    return controller.handle(() => sendGrpcItem(selected, scope, context, options.scripts, mode), stream?.streaming);
  },

  resolve(selected, scope, host) {
    return resolveGrpc(selected, { ...scope.context, host });
  },

  async scriptTypes(selected, scope) {
    // A schema that does not load leaves the messages untyped; the send reports the missing schema.
    const protoSet = await protoSetFor(selected, scope, scope.context).catch(() => undefined);
    const types = grpcMessageTypes(protoSet, selected.request.service, selected.request.method);
    return {
      generated: grpcScriptTypes(types === undefined ? undefined : protoSet, types?.input ?? '', types?.output ?? ''),
    };
  },

  secretNeeds(selected, project) {
    return [
      ...secretNeedsOfAuth(grpcEffectiveAuth(selected)),
      ...keystoreNeeds(project, selected.request.settings.sslKeystoreRef),
    ];
  },
};
