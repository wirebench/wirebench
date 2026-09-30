/**
 * Turns one saved request into a send input, for a host with no editor: no draft to apply, no
 * user preferences to fold in, no renderer to keep credentials from. It composes the same engine
 * functions the app's main process does, in the same order, so a request runs in a pipeline the
 * way it runs when its author presses Send.
 *
 * What the app reads from the user's preferences — a global client keystore, a CA bundle, a
 * proxy, global properties — has no counterpart here: a run is described by the project, the
 * workspace it sits inside (if any) and its command line. Trust anchors beyond Node's own come from
 * `NODE_EXTRA_CA_CERTS`.
 */
import { readFile } from 'node:fs/promises';
import { expandGrpcInput } from '../grpc/expand.js';
import type { GrpcSendInput } from '../grpc/send.js';
import { readAttachment } from '../project/attachments-cache.js';
import type { AttachmentSource } from '../project/model.js';
import { expandRestSendInput } from '../rest/expand.js';
import type { RestSendInput } from '../rest/send.js';
import { toGrpcSendInput, toRestSendInput } from '../send-options.js';
import { signingSecretMissing, signingSecretRef } from '../webhooks/model.js';
import { grpcEffectiveAuth, restEffectiveAuth } from './effective-auth.js';
import { prepareSoap } from '../soap/run.js';
import type { PreparedSoap } from '../soap/run.js';
import type { SelectedRequest } from './select.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import { authFor, baseUrlFor, insideProject, tlsFor, unresolvedError, withSecrets } from './send-helpers.js';

export { authFor } from './send-helpers.js';
export { scopesFor } from './context.js';
export type { RunContext, RunWorkspace } from './context.js';

/**
 * One request, ready for `sendSoapRequest` (with `scopes`), `sendRest`, or `callGrpc` (with the
 * API's proto set, which the caller loads: preparing a call needs no schema). It carries resolved
 * secret values (auth, `scopes.secrets`) but no list of them: the host masks what its `GetSecret`
 * handed out (see `GetSecret`).
 */
export type PreparedSend =
  | PreparedSoap
  | { readonly kind: 'rest'; readonly input: RestSendInput }
  | {
      readonly kind: 'grpc';
      // The streaming hooks are left out: a run makes unary calls, and wants only the result.
      readonly input: Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;
      readonly messageText: string;
    };

type RestSelected = Extract<SelectedRequest, { kind: 'rest' }>;
type GrpcSelected = Extract<SelectedRequest, { kind: 'grpc' }>;

/** A REST multipart file part or binary body, read from inside the project folder. */
function restFileResolver(context: RunContext): (source: AttachmentSource) => Promise<Uint8Array> {
  return async (source) =>
    source.kind === 'cache'
      ? readAttachment(context.projectDir, source.sha256)
      : new Uint8Array(
          await readFile(await insideProject(context, source.path, 'rest-file-outside-project', source.path)),
        );
}

/**
 * A webhook item's signing with its secret, or `undefined` when it signs nothing. The secret is
 * read through the run's `GetSecret` (the CLI: `WIREBENCH_SECRET_<secretEnv>`), so it is masked
 * like every other secret the run hands out.
 *
 * @throws WirebenchError `webhook-signing-secret` when signing is set and the secret is not given
 */
async function signFor(selected: RestSelected, context: RunContext): Promise<RestSendInput['sign']> {
  const effective = selected.signing;
  if (effective === undefined || effective.signing.mode !== 'sign') return undefined;
  const ref = signingSecretRef(effective.signing);
  const secret = ref === undefined ? undefined : await context.getSecret(ref);
  if (secret === undefined || secret === '') throw signingSecretMissing(effective, ref);
  return { scheme: effective.signing.scheme, secret };
}

async function prepareRest(selected: RestSelected, context: RunContext): Promise<PreparedSend> {
  const { api, request } = selected;
  const scopes = scopesFor(context);
  const tls = await tlsFor(context, request.settings.sslKeystoreRef, request.settings.trustInvalid === true);
  const auth = await authFor(restEffectiveAuth(selected), selected.path, context, tls);
  const baseUrl = baseUrlFor(context, api);
  const unexpanded = toRestSendInput({
    request: {
      method: request.method,
      url: request.url,
      pathParams: request.pathParams,
      query: request.query,
      headers: request.headers,
      body: request.body,
      settings: request.settings,
    },
    baseUrl,
    projectSettings: context.project.settings,
    ...(auth !== undefined ? { auth } : {}),
    ...(tls !== undefined ? { tls } : {}),
    resolveFile: restFileResolver(context),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  const withTokens = await withSecrets(unexpanded, scopes, context.getSecret, context.secretPlaceholders);
  const { input, unresolved } = expandRestSendInput(unexpanded, withTokens, {
    escape: request.settings.escapeProperties === true,
  });
  if (unresolved.length > 0) {
    throw unresolvedError(selected.path, unresolved);
  }
  const sign = await signFor(selected, context);
  // As the app does: the proxy is chosen for the base URL, or the request's own when it has none.
  const proxy = context.proxyFor?.(input.baseUrl === '' ? input.request.url : input.baseUrl);
  return {
    kind: 'rest',
    input: {
      ...input,
      ...(proxy !== undefined ? { proxy } : {}),
      ...(sign !== undefined ? { sign } : {}),
      ...(context.timeoutMs !== undefined ? { settings: { ...input.settings, timeoutMs: context.timeoutMs } } : {}),
    },
  };
}

/**
 * The app's `resolveGrpcSend` plus what its send handler adds: the target through the
 * environment's override for the API (the slot a REST base URL uses), the settings ladder, one
 * expansion pass over target, metadata and message, then the request's own TLS identity and trust
 * decision and the chain's credentials. There is no proxy: the app sends gRPC direct as well.
 */
async function prepareGrpc(selected: GrpcSelected, context: RunContext): Promise<PreparedSend> {
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
 * @throws WirebenchError `unresolved-properties` | `endpoint-unresolved` | `secret-missing` |
 * `auth-grant-unsupported` | `wss-config-missing` | `keystore-missing` | `webhook-signing-secret`
 */
export function prepareSend(selected: SelectedRequest, context: RunContext): Promise<PreparedSend> {
  switch (selected.kind) {
    case 'soap':
      return prepareSoap(selected, context);
    case 'rest':
      return prepareRest(selected, context);
    case 'grpc':
      return prepareGrpc(selected, context);
  }
}
