/**
 * REST's run facet (spec §3.3): the requests of every API, and the project's webhook items as a
 * group a run sends only when a selector names it. The steps of a send are in the order they have
 * always been: the request's TLS identity, its credentials (an OAuth2 token included), its secret
 * tokens, a webhook item's signing secret, then the wire.
 */
import { readFile } from 'node:fs/promises';
import type { AssertionSubject } from '../assert/model.js';
import { readAttachment } from '../project/attachments-cache.js';
import type { AttachmentSource, AuthConfig } from '../project/model.js';
import { REQUESTS_DIR, WEBHOOKS_DIR } from '../project/paths.js';
import type { ProtocolRun, RunGroup } from '../protocol/module.js';
import { scopesFor } from '../run/context.js';
import type { RunContext } from '../run/context.js';
import {
  authFor,
  baseUrlFor,
  dropRefusedToken,
  insideProject,
  keystoreNeeds,
  originOf,
  tlsFor,
  unresolvedError,
  withSecrets,
} from '../run/send-helpers.js';
import { ORPHANED_STEP_REASON, byOrder, findInTree, walkTree } from '../run/tree.js';
import { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from './scripting.js';
import { loadOpenApiDocument, restOperationFor, restScriptTypes } from './script-types.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { toRestSendInput } from '../send-options.js';
import {
  effectiveSigning,
  effectiveTarget,
  signingSecretMissing,
  signingSecretRef,
  signingSourceLabel,
} from '../webhooks/model.js';
import type { EffectiveSigning, WebhookCollection, WebhookFolder } from '../webhooks/model.js';
import { resolveAuthChain } from './auth.js';
import { expandRestSendInput } from './expand.js';
import { createApi } from './model.js';
import type { RestApi, RestFolder, RestRequestDef } from './model.js';
import { sendRest } from './send.js';
import type { RestExchange, RestSendInput } from './send.js';

/** One saved REST request, or one webhook item, selected for a run. */
export interface RestSelected {
  readonly kind: 'rest';
  readonly path: string;
  readonly group: string;
  readonly api: RestApi;
  readonly chain: readonly RestFolder[];
  readonly request: RestRequestDef;
  /** A webhook item's effective signing (webhook-signatures §5.2); absent for an API request. */
  readonly signing?: EffectiveSigning;
}

/** A REST request ready for `sendRest`. */
export interface PreparedRest {
  readonly kind: 'rest';
  readonly input: RestSendInput;
}

/** Innermost first, as the app's `authChainFor` builds it: request, its folders inside-out, the API. */
export function restEffectiveAuth(selected: RestSelected): AuthConfig {
  const { api, chain, request } = selected;
  return resolveAuthChain([request.auth, ...[...chain].reverse().map((folder) => folder.auth), api.auth]);
}

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

/**
 * One REST request as a send input, with its secrets resolved (or behind `context.secretPlaceholders`).
 * Exported for this module's tests and for `prepareSend`; not part of the run facet.
 *
 * @throws WirebenchError `unresolved-properties` | `secret-missing` | `auth-grant-unsupported` |
 * `keystore-missing` | `webhook-signing-secret`
 */
export async function prepareRest(selected: RestSelected, context: RunContext): Promise<PreparedRest> {
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

/** A REST response as assertions and sequence transfers see it. */
export function restSubject(exchange: RestExchange): AssertionSubject {
  return {
    protocol: 'rest',
    status: exchange.status,
    durationMs: exchange.durationMs,
    bodyText: exchange.text,
    bodyKind: exchange.language === 'json' ? 'json' : exchange.language === 'xml' ? 'xml' : 'other',
    headers: exchange.rawHeaders,
  };
}

/** A webhook item's signing secret, read from `WIREBENCH_SECRET_<secretEnv>` (§5.2). */
function signingNeeds(selected: RestSelected): SecretNeed[] {
  const effective = selected.signing;
  if (effective === undefined || effective.signing.mode !== 'sign') return [];
  const ref = signingSecretRef(effective.signing);
  if (ref === undefined) return [];
  return [
    {
      ref,
      ...(effective.signing.secretEnv !== undefined ? { envName: effective.signing.secretEnv } : {}),
      purpose: `webhook signing secret (${signingSourceLabel(effective)})`,
    },
  ];
}

type RestCandidate = RunGroup<RestSelected>['candidates'][number];

/** An API's requests in explorer order, without the ones its contract no longer has. */
function apiCandidates(api: RestApi): RestCandidate[] {
  const out: RestCandidate[] = [];
  walkTree<RestFolder, RestRequestDef, RestSelected>(
    api,
    [],
    api.name,
    `apis/${api.slug}/requests`,
    (request, chain, group) =>
      request.orphaned === true
        ? undefined
        : { kind: 'rest', path: `${group}/${request.name}`, group, api, chain, request },
    out,
  );
  return out;
}

/**
 * The project's webhook items, as REST items against a synthetic API whose base URL is each item's
 * effective target. A run has no history, so a callback uses the target.
 */
function webhookCandidates(collection: WebhookCollection): RestCandidate[] {
  const out: RestCandidate[] = [];
  const visit = (
    folders: readonly WebhookFolder[],
    requests: readonly RestRequestDef[],
    chain: readonly WebhookFolder[],
  ): void => {
    const group = ['Webhooks', ...chain.map((folder) => folder.name)].join('/');
    const dir = [WEBHOOKS_DIR, REQUESTS_DIR, ...chain.map((folder) => folder.slug)].join('/');
    const api = createApi('Webhooks', {
      id: 'webhooks',
      slug: 'webhooks',
      baseUrl: effectiveTarget(collection, chain),
      ...(collection.auth !== undefined ? { auth: collection.auth } : {}),
    });
    for (const request of [...requests].sort(byOrder)) {
      if (request.orphaned === true) continue;
      out.push({
        item: {
          kind: 'rest',
          path: `${group}/${request.name}`,
          group,
          api,
          chain,
          request,
          signing: effectiveSigning(collection, request.id),
        },
        diskPath: `${dir}/${request.slug}`,
      });
    }
    for (const folder of [...folders].sort(byOrder)) visit(folder.folders, folder.requests, [...chain, folder]);
  };
  visit(collection.folders, collection.requests, []);
  return out;
}

/** REST's run facet. */
export const restRun: ProtocolRun<RestSelected> = {
  groups(project) {
    const apis: RunGroup<RestSelected>[] = project.apis.map((api) => ({
      order: api.order,
      name: api.name,
      candidates: apiCandidates(api),
    }));
    // Webhook items deliver to a receiver rather than test an API: sent only when a selector names one.
    return project.webhooks === undefined
      ? apis
      : [...apis, { order: 0, name: 'Webhooks', candidates: webhookCandidates(project.webhooks), explicitOnly: true }];
  },

  whyNotRunnable(project, requestId) {
    if (project.webhooks !== undefined && findInTree(project.webhooks, requestId) !== undefined) {
      return 'A webhook cannot be a sequence step';
    }
    for (const api of project.apis) {
      const request = findInTree(api, requestId);
      if (request !== undefined) {
        return request.orphaned === true ? ORPHANED_STEP_REASON : undefined;
      }
    }
    return undefined;
  },

  async send(selected, scope, scripts) {
    const { context } = scope;
    if (scripts === undefined) {
      const prepared = await prepareRest(selected, context);
      const exchange = await sendRest(prepared.input);
      dropRefusedToken(context, prepared.input.auth, exchange.status === 401);
      return {
        subject: restSubject(exchange),
        raw: exchange,
        exchange: { kind: 'rest', rest: exchange },
        ...originOf(exchange.request.url),
      };
    }

    // Prepared with its secrets behind placeholders; the URL is rebuilt only when the script changed it.
    const prepared = await prepareRest(selected, { ...context, secretPlaceholders: scripts.placeholders });
    const before = restRequestSnapshot(prepared.input);
    const sent = await scripts.session.pre(before);
    const changed = applyRestSnapshot(prepared.input, before, sent);
    const restored = await scripts.placeholders.restore(
      { baseUrl: changed.baseUrl, request: changed.request },
      context.getSecret,
    );
    const exchange = await sendRest({ ...changed, ...restored });
    dropRefusedToken(context, prepared.input.auth, exchange.status === 401);
    return {
      subject: restSubject(exchange),
      raw: exchange,
      exchange: { kind: 'rest', rest: exchange },
      ...originOf(exchange.request.url),
      script: await scripts.session.post(sent, restResponseSnapshot(exchange)),
    };
  },

  async scriptTypes(selected, scope) {
    const { api } = selected;
    const openApi = await scope.memo(`rest:${api.id}:openapi`, () =>
      loadOpenApiDocument(scope.context.projectDir, api.slug),
    );
    return { generated: restScriptTypes(restOperationFor(openApi, selected.request.contract)) };
  },

  secretNeeds(selected, project) {
    return [
      ...secretNeedsOfAuth(restEffectiveAuth(selected)),
      ...keystoreNeeds(project, selected.request.settings.sslKeystoreRef),
      ...signingNeeds(selected),
    ];
  },
};
