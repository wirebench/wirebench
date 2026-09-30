/**
 * gRPC's run facet (spec §3.3): unary calls only, since a stream needs an assertion model a run does
 * not have yet. The API's schema is loaded before the call is prepared: without a schema there is no
 * call, so no token is worth fetching. A schema that does not load is remembered for the run.
 */
import type { AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import type { AuthConfig } from '../project/model.js';
import { apiDefinitionDir } from '../project/paths.js';
import type { ProtocolRun, RunGroup, RunScope } from '../protocol/module.js';
import { resolveAuthChain } from '../rest/auth.js';
import { scopesFor } from '../run/context.js';
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
import { ORPHANED_STEP_REASON, findInTree, walkTree } from '../run/tree.js';
import { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from './scripting.js';
import { grpcMessageTypes, grpcScriptTypes } from './script-types.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import { toGrpcSendInput } from '../send-options.js';
import { readGrpcDefinitionCache } from './cache.js';
import { callGrpc } from './call.js';
import type { GrpcCallResult } from './call.js';
import { expandGrpcInput } from './expand.js';
import type { GrpcApi, GrpcFolder, GrpcRequestDef } from './model.js';
import { loadProtoSet } from './proto/load.js';
import type { ProtoSet } from './proto/load.js';
import { protoSetFromDescriptorSet } from './reflection/descriptors.js';
import type { GrpcSendInput } from './send.js';

/** One saved gRPC request selected for a run. */
export interface GrpcSelected {
  readonly kind: 'grpc';
  readonly path: string;
  readonly group: string;
  readonly api: GrpcApi;
  readonly chain: readonly GrpcFolder[];
  readonly request: GrpcRequestDef;
}

/** A unary call ready for `callGrpc`, which also takes the API's proto set. */
export interface PreparedGrpc {
  readonly kind: 'grpc';
  // The streaming hooks are left out: a run makes unary calls, and wants only the result.
  readonly input: Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;
  readonly messageText: string;
}

/** The same chain for a gRPC request: request, its folders inside-out, the API. */
export function grpcEffectiveAuth(selected: GrpcSelected): AuthConfig {
  const { api, chain, request } = selected;
  return resolveAuthChain([request.auth, ...[...chain].reverse().map((folder) => folder.auth), api.auth]);
}

/**
 * The app's `resolveGrpcSend` plus what its send handler adds: the target through the
 * environment's override for the API (the slot a REST base URL uses), the settings ladder, one
 * expansion pass over target, metadata and message, then the request's own TLS identity and trust
 * decision and the chain's credentials. There is no proxy: the app sends gRPC direct as well.
 *
 * Exported for this module's tests and for `prepareSend`; not part of the run facet.
 *
 * @throws WirebenchError `unresolved-properties` | `secret-missing` | `auth-grant-unsupported` |
 * `keystore-missing`
 */
export async function prepareGrpc(selected: GrpcSelected, context: RunContext): Promise<PreparedGrpc> {
  const { api, request } = selected;
  const scopes = scopesFor(context);
  const tls = await tlsFor(context, request.settings.sslKeystoreRef, request.settings.trustInvalid === true);
  const auth = await authFor(grpcEffectiveAuth(selected), selected.path, context, tls);
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
    ...(auth !== undefined ? { auth } : {}),
    ...(tls !== undefined ? { tlsOptions: tls } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  const withMessage = { ...unexpanded, messageText: request.message };
  const withTokens = await withSecrets(withMessage, scopes, context.getSecret, context.secretPlaceholders);
  const { input, unresolved } = expandGrpcInput(withMessage, withTokens, {
    escape: request.settings.escapeProperties === true,
  });
  if (unresolved.length > 0) {
    throw unresolvedError(selected.path, unresolved);
  }
  const { messageText, ...transport } = input;
  return {
    kind: 'grpc',
    input: { ...transport, ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}) },
    messageText,
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
  };
}

/** gRPC's `UNAUTHENTICATED`: the server's word for a credential it will not accept. */
const GRPC_UNAUTHENTICATED = 16;

/** The API's schema, read once per run; a failed load is remembered. */
function protoSetFor(api: GrpcApi, scope: RunScope): Promise<ProtoSet> {
  return scope.memo(`grpc:${api.id}:proto-set`, () => loadProtoSetFor(scope.context.projectDir, api));
}

const STREAMING_STEP_REASON = 'A streaming gRPC call cannot be a sequence step; only unary calls can';

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

  async send(selected, scope, scripts) {
    // Before the send is prepared: without a schema there is no call, so no token is worth fetching.
    const protoSet = await protoSetFor(selected.api, scope);
    const { context } = scope;
    if (scripts === undefined) {
      const prepared = await prepareGrpc(selected, context);
      const result = await callGrpc({ ...prepared.input, set: protoSet, messageText: prepared.messageText });
      dropRefusedToken(context, prepared.input.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
      return { subject: grpcSubject(result), raw: result.exchange, origin: prepared.input.target };
    }

    const prepared = await prepareGrpc(selected, { ...context, secretPlaceholders: scripts.placeholders });
    const before = grpcRequestSnapshot(prepared.input, prepared.messageText);
    const sent = await scripts.session.pre(before);
    const changed = applyGrpcSnapshot(prepared.input, prepared.messageText, before, sent);
    const restored = await scripts.placeholders.restore(
      { metadata: changed.input.metadata, messageText: changed.messageText },
      context.getSecret,
    );
    const result = await callGrpc({
      ...changed.input,
      metadata: restored.metadata,
      set: protoSet,
      messageText: restored.messageText,
    });
    dropRefusedToken(context, prepared.input.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
    return {
      subject: grpcSubject(result),
      raw: result.exchange,
      origin: prepared.input.target,
      script: await scripts.session.post(sent, grpcResponseSnapshot(result)),
    };
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
