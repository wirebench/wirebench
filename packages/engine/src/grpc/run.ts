/**
 * gRPC's run facet (spec §3.3): unary calls only, since a stream needs an assertion model a run does
 * not have yet. A send resolves the call and refuses one it cannot make, loads the API's schema
 * (without a schema there is no call, so no token is worth fetching; a schema that does not load is
 * remembered for the run), runs its pre-request script, connects, then calls (spec §3.4).
 */
import type { AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import type { AuthConfig } from '../project/model.js';
import { apiDefinitionDir } from '../project/paths.js';
import type { ProtocolRun, RunGroup, RunScope, ScriptedSend } from '../protocol/module.js';
import { resolveAuthChain } from '../http/auth/apply-auth.js';
import { scopesFor } from '../run/context.js';
import { exchangeController } from '../run/exchange.js';
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
import { grpcMessageTypes, grpcScriptTypes } from './script-types.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import { toGrpcSendInput } from './send-input.js';
import { readGrpcDefinitionCache } from './cache.js';
import { callGrpc } from './call.js';
import type { GrpcCallResult } from './call.js';
import { expandGrpcInput } from './expand.js';
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

/** The API's schema, read once per run; a failed load is remembered. */
function protoSetFor(api: GrpcApi, scope: RunScope): Promise<ProtoSet> {
  return scope.memo(`grpc:${api.id}:proto-set`, () => loadProtoSetFor(scope.context.projectDir, api));
}

const STREAMING_STEP_REASON = 'A streaming gRPC call cannot be a sequence step; only unary calls can';

/**
 * One gRPC request as a run sends it (spec §3.4): resolve, run its pre-request script when
 * `scripts` is given, connect, call, then its post-response script.
 */
async function sendGrpcItem(
  selected: GrpcSelected,
  scope: RunScope,
  context: RunContext,
  scripts: ScriptedSend | undefined,
): Promise<SentRequest> {
  if (scripts === undefined) {
    const resolved = await resolveGrpc(selected, context);
    refuseUnsendable(selected, resolved);
    // Before the send connects: without a schema there is no call, so no token is worth fetching.
    const protoSet = await protoSetFor(selected.api, scope);
    const connected = await connectGrpc(selected, context, resolved.input);
    const result = await callGrpc({ ...connected, set: protoSet, messageText: resolved.messageText });
    dropRefusedToken(context, connected.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
    return { subject: grpcSubject(result), raw: result.exchange, origin: connected.target };
  }

  const resolved = await resolveGrpc(selected, { ...context, secretPlaceholders: scripts.placeholders });
  refuseUnsendable(selected, resolved);
  const protoSet = await protoSetFor(selected.api, scope);
  const before = grpcRequestSnapshot(resolved.input, resolved.messageText);
  const sent = await scripts.session.pre(before);
  const changed = applyGrpcSnapshot(resolved.input, resolved.messageText, before, sent);
  const restored = await scripts.placeholders.restore(
    { metadata: changed.input.metadata, messageText: changed.messageText },
    context.host.getSecret,
  );
  const connected = await connectGrpc(selected, context, { ...changed.input, metadata: restored.metadata });
  const result = await callGrpc({ ...connected, set: protoSet, messageText: restored.messageText });
  dropRefusedToken(context, connected.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
  return {
    subject: grpcSubject(result),
    raw: result.exchange,
    origin: connected.target,
    script: await scripts.session.post(sent, grpcResponseSnapshot(result)),
  };
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
    const controller = exchangeController('grpc', options);
    const context: RunContext = { ...scope.context, host, signal: controller.signal };
    return controller.handle(() => sendGrpcItem(selected, scope, context, options.scripts));
  },

  resolve(selected, scope, host) {
    return resolveGrpc(selected, { ...scope.context, host });
  },

  async scriptTypes(selected, scope) {
    // A schema that does not load leaves the messages untyped; the send reports the missing schema.
    const protoSet = await protoSetFor(selected.api, scope).catch(() => undefined);
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
