/**
 * gRPC's run facet (spec §3.3). A run selects every method kind: a client or bidi stream sends its
 * saved messages in order, then half-closes, and the run timeout bounds every stream (spec §5.2). A
 * host drives a client or bidi stream's request side when it opens one interactive. A send resolves
 * the call and refuses one
 * it cannot make, loads the API's schema (without a schema there is no call, so no token is worth
 * fetching; a schema that does not load is remembered for the run), runs its pre-request script,
 * connects, then calls (spec §3.4).
 */
import type { AssertionSubject } from '../assert/model.js';
import { GrpcError, HttpError, isWirebenchError, WirebenchError } from '../errors.js';
import type { AuthConfig, Project } from '../project/model.js';
import { apiDefinitionDir } from '../project/paths.js';
import type { ProtocolRun, RunGroup, RunScope, ScriptedSend } from '../protocol/module.js';
import { resolveAuthChain } from '../http/auth/apply-auth.js';
import { scopesFor } from '../run/context.js';
import { exchangeController } from '../run/exchange.js';
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

/**
 * What a failed call reports as its `SendFailure.input`: the call as far as it got, and its message
 * text once resolved. It holds live credentials once connected; a host never logs it.
 */
export type GrpcFailedInput = GrpcResolvedInput & { readonly messageText?: string };

/** A call ready for `callGrpc`, which also takes the API's proto set and the message text. */
// The streaming hooks are left out: the send adds the ones a live or interactive call asks for.
export type GrpcResolvedInput = Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;

/** The same chain for a gRPC request: request, its folders inside-out, the API. */
export function grpcEffectiveAuth(selected: GrpcSelected): AuthConfig {
  const { api, chain, request } = selected;
  return resolveAuthChain([request.auth, ...[...chain].reverse().map((folder) => folder.auth), api.auth]);
}

/**
 * The gRPC item for `requestId`, built as a run builds it — and found even when its contract no
 * longer has it (`orphaned`), which a run skips and a person may still send. Undefined when no gRPC
 * request has that id.
 */
export function grpcItemFor(project: Project, requestId: string): GrpcSelected | undefined {
  const candidates: { item: GrpcSelected; diskPath: string }[] = [];
  for (const api of project.grpcApis) {
    walkTree<GrpcFolder, GrpcRequestDef, GrpcSelected>(
      api,
      [],
      api.name,
      `apis/${api.slug}/requests`,
      (request, chain, group) =>
        request.id === requestId
          ? { kind: 'grpc', path: `${group}/${request.name}`, group, api, chain, request }
          : undefined,
      candidates,
    );
  }
  return candidates[0]?.item;
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
    // The user agent, socket timeout and TLS floor the app's own sends take from preferences.
    ...(context.host.preferences !== undefined ? { preferences: context.host.preferences } : {}),
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
 * A call's answer as assertions see it: the gRPC status code (0 = OK), and its response as JSON. A
 * unary or client-streaming call has one message: none, or one that did not decode, leaves nothing a
 * `match` can read. A server-streaming or bidi call has every message, in order, as a JSON array,
 * one that did not decode as `null` so the others keep their index.
 * Exported for its unit test; not part of the run module's public surface.
 */
export function grpcSubject(result: GrpcCallResult): AssertionSubject {
  const first = result.responseMessages[0];
  const streamed = result.methodKind === 'server-streaming' || result.methodKind === 'bidi-streaming';
  const decoded = streamed || (first !== undefined && first.json !== undefined);
  const body = streamed ? result.responseMessages.map((message) => message.json ?? null) : first?.json;
  return {
    protocol: 'grpc',
    status: result.exchange.status,
    durationMs: result.exchange.durationMs,
    bodyText: decoded ? JSON.stringify(body) : '',
    bodyKind: decoded ? 'json' : 'other',
    // Metadata first, then trailers: a header assertion or transfer takes the first value it finds.
    headers: [...Object.entries(result.exchange.headers), ...Object.entries(result.exchange.trailers)],
    statusNames: grpcStatusNames,
  };
}

/** gRPC's `UNAUTHENTICATED`: the server's word for a credential it will not accept. */
const GRPC_UNAUTHENTICATED = 16;

/** gRPC's `DEADLINE_EXCEEDED`. */
const GRPC_DEADLINE_EXCEEDED = 4;

/**
 * True when the deadline cut a stream a run made: the local deadline ended it, or the server said so
 * once the deadline had passed. A unary call keeps `DEADLINE_EXCEEDED` as its status, for assertions.
 */
function deadlineCut(result: GrpcCallResult, timeoutMs: number): boolean {
  const { exchange } = result;
  return (
    result.methodKind !== 'unary' &&
    exchange.status === GRPC_DEADLINE_EXCEEDED &&
    (exchange.statusSource === 'local' || exchange.durationMs >= timeoutMs)
  );
}

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

/**
 * What a failed call was about to put on the wire: an HTTP/2 POST to `/<service>/<method>`, its
 * metadata. A call with no method chosen names its target alone.
 */
function attemptedOf(input: GrpcResolvedInput): AttemptedRequest {
  const path = input.service === '' || input.method === '' ? '' : grpcMethodPath(input.service, input.method);
  return {
    url: `${input.tls ? 'https' : 'http'}://${input.target}${path}`,
    method: 'POST',
    headers: Object.fromEntries(input.metadata.filter((row) => row.enabled).map((row) => [row.name, row.value])),
  };
}

/**
 * An interactive call's request side, between the handle `open` returns at once and the call that
 * opens it later. Pushes go out in the order they were made: once the call is open each is written
 * as it is pushed, and before that they wait in a queue the opening drains. A half-close never
 * drops a push made before it: before the call opens it is held until the queue has drained. A
 * push after the half-close, or one still waiting when the call ends without opening, is refused
 * with `grpc-stream-closed`, as is any push once a call that never opened has ended.
 */
interface GrpcStreamState {
  /** The side the handle drives. */
  readonly streaming: StreamingSide;
  /** Given to `callGrpc` as its `onOpen`. */
  opened(handle: GrpcCallStreamHandle): void;
  /** The call has ended, opened or not. */
  settled(): void;
}

interface WaitingPush {
  readonly text: string;
  readonly resolve: (json: unknown) => void;
  readonly reject: (error: unknown) => void;
}

function streamClosed(halfClosed: boolean, settled: boolean): GrpcError {
  return new GrpcError('grpc-stream-closed', 'The request side of this call is already closed', {
    details: { halfClosed, settled },
  });
}

function grpcStreamState(controller: ExchangeController<GrpcLiveEvent>): GrpcStreamState {
  let side: GrpcCallStreamHandle | undefined;
  let waiting: WaitingPush[] = [];
  let ended = false;
  /** The call has ended; when it never opened, nothing pushed now could be written. */
  let done = false;
  // Async only to turn a throw into a rejection: the body, and so the write, runs at once.
  // eslint-disable-next-line @typescript-eslint/require-await
  const write = async (handle: GrpcCallStreamHandle, text: string): Promise<unknown> => handle.send(text);
  const end = (handle: GrpcCallStreamHandle): void => {
    handle.end();
    controller.queue.push({ protocol: 'grpc', kind: 'closed' });
  };
  // `close` is a half-close too: a gRPC call is aborted by `cancel`, never by its request side.
  const halfClose = (): void => {
    if (ended) return;
    ended = true;
    // Before the call opens, the opening ends it once the pushes made before now are written.
    if (side !== undefined) end(side);
  };
  return {
    streaming: {
      push: (message) => {
        if (!('text' in message)) {
          return Promise.reject(
            new WirebenchError('exchange-not-streaming', 'A gRPC call takes its messages as JSON text, not binary', {
              details: { protocol: 'grpc', reason: 'binary' },
            }),
          );
        }
        if (ended) return Promise.reject(streamClosed(true, false));
        if (side !== undefined) return write(side, message.text);
        if (done) return Promise.reject(streamClosed(false, true));
        return new Promise((resolve, reject) => waiting.push({ text: message.text, resolve, reject }));
      },
      halfClose,
      close: halfClose,
    },
    opened(handle) {
      side = handle;
      controller.queue.push({ protocol: 'grpc', kind: 'open' });
      const queued = waiting;
      waiting = [];
      for (const push of queued) write(handle, push.text).then(push.resolve, push.reject);
      if (ended) end(handle);
    },
    settled() {
      done = true;
      const queued = waiting;
      waiting = [];
      for (const push of queued) push.reject(streamClosed(ended, true));
    },
  };
}

/** How one call is sent: its live events and, for an interactive call, its request side. */
interface GrpcSendMode {
  readonly controller: ExchangeController<GrpcLiveEvent>;
  readonly live: boolean;
  /** A host drives it; otherwise a run, where a stream the deadline cuts fails with `timeout`. */
  readonly interactive: boolean;
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
  const { controller, live, interactive, stream } = mode;
  const startedAt = Date.now();
  // Never masks the send's own error: a row that cannot be built, or a host that throws, is dropped.
  const failed = (
    stage: 'prepare' | 'send',
    error: unknown,
    attempted: GrpcResolvedInput | undefined,
    messageText: string | undefined,
  ): void => {
    try {
      const input: GrpcFailedInput | undefined =
        attempted === undefined ? undefined : { ...attempted, ...(messageText !== undefined ? { messageText } : {}) };
      context.host.events?.onFailed?.(selected, {
        stage,
        error,
        startedAt,
        durationMs: Date.now() - startedAt,
        ...(attempted !== undefined ? { attempted: attemptedOf(attempted), input } : {}),
      });
    } catch {
      // Deliberately ignored — see above.
    }
  };
  try {
    let input: GrpcResolvedInput | undefined;
    let connected: GrpcResolvedInput;
    let messageText: string | undefined;
    let protoSet: ProtoSet;
    let sent: GrpcRequestSnapshot | undefined;
    try {
      const resolved = await resolveGrpc(
        selected,
        scripts !== undefined ? { ...context, secretPlaceholders: scripts.placeholders } : context,
      );
      input = resolved.input;
      messageText = resolved.messageText;
      refuseUnsendable(selected, resolved);
      // Before the send connects: without a schema there is no call, so no token is worth fetching.
      protoSet = await protoSetFor(selected, scope, context);
      if (scripts === undefined) {
        connected = await connectGrpc(selected, context, resolved.input);
      } else {
        const before = grpcRequestSnapshot(resolved.input, resolved.messageText);
        sent = await scripts.session.pre(before);
        const changed = applyGrpcSnapshot(resolved.input, resolved.messageText, before, sent);
        const restored = await scripts.placeholders.restore(
          { metadata: changed.input.metadata, messageText: changed.messageText },
          context.host.getSecret,
        );
        input = { ...changed.input, metadata: restored.metadata };
        messageText = restored.messageText;
        connected = await connectGrpc(selected, context, input);
      }
    } catch (error) {
      failed('prepare', error, input, messageText);
      throw error;
    }
    const sentText = messageText;
    let result: GrpcCallResult;
    try {
      result = await callGrpc({
        ...connected,
        set: protoSet,
        messageText: sentText,
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
      if (!interactive && deadlineCut(result, connected.timeoutMs)) {
        throw new HttpError('timeout', 'The request timed out.', { details: { target: connected.target } });
      }
    } catch (error) {
      failed('send', error, connected, sentText);
      throw error;
    }
    dropRefusedToken(context, connected.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
    return {
      subject: grpcSubject(result),
      raw: result.exchange,
      exchange: { kind: 'grpc', grpc: result, input: connected, messageText: sentText },
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
          request.orphaned === true
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
      interactive: options.interactive,
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
