/**
 * REST's run facet (spec §3.3): the requests of every API, and the project's webhook items as a
 * group a run sends only when a selector names it. A send resolves the request (its properties and
 * secret tokens), runs its pre-request script, connects (its TLS identity, a webhook item's signing
 * secret, its credentials with an OAuth2 token, the proxy), then goes on the wire (spec §3.4). A
 * send that is not live reads an event stream to its end or the timeout (spec §5.2).
 */
import { readFile } from 'node:fs/promises';
import type { AssertionSubject } from '../assert/model.js';
import { readAttachment } from '../project/attachments-cache.js';
import type { AttachmentSource, AuthConfig, Project } from '../project/model.js';
import { REQUESTS_DIR, WEBHOOKS_DIR } from '../project/paths.js';
import type { ProtocolRun, RunGroup, ScriptedSend } from '../protocol/module.js';
import type { ExchangeController } from '../run/exchange.js';
import type { AttemptedRequest } from '../run/host.js';
import { scopesFor } from '../run/context.js';
import { exchangeController } from '../run/exchange.js';
import type { SentRequest } from '../run/run.js';
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
import type { Resolved } from '../run/send-helpers.js';
import { ORPHANED_STEP_REASON, byOrder, findInTree, walkTree } from '../run/tree.js';
import { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from './scripting.js';
import type { RestRequestSnapshot } from './scripting.js';
import { createSseParser, isEventStream } from './sse.js';
import type { SseRow } from './sse.js';
import { loadOpenApiDocument, restOperationFor, restScriptTypes } from './script-types.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { toRestSendInput } from './send-input.js';
import {
  assertWebhookTarget,
  effectiveSigning,
  effectiveTarget,
  signingSecretMissing,
  signingSecretRef,
  signingSourceLabel,
} from '../webhooks/model.js';
import type { EffectiveSigning, WebhookCollection, WebhookFolder } from '../webhooks/model.js';
import { resolveAuthChain } from '../http/auth/apply-auth.js';
import { expandRestSendInput } from './expand.js';
import type { RestLiveEvent } from './events.js';
import { createApi } from './model.js';
import type { RestApi, RestFolder, RestRequestDef } from './model.js';
import { sendRest } from './send.js';
import { joinBase } from './url.js';
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
  const secret = ref === undefined ? undefined : await context.host.getSecret(ref);
  if (secret === undefined || secret === '') throw signingSecretMissing(effective, ref);
  return { scheme: effective.signing.scheme, secret };
}

/**
 * One REST request resolved (spec §3.4): its properties and secret tokens expanded (the secrets
 * behind `context.secretPlaceholders` when given), nothing connected and the credentials still as
 * configured, so the input holds no `auth`. A reference nothing resolves is reported in
 * `unresolved`, not thrown: the send refuses it, a preview shows it.
 *
 * A webhook item goes to its callback URL when the host names one: that URL is the whole
 * destination, taken literally (ADR-0015), with no base. Otherwise it goes to its target, which
 * must expand to an `http(s)` URL.
 *
 * @throws WirebenchError `secret-missing` | `rest-file-outside-project` | `webhook-target-missing` |
 * `webhook-target-invalid`
 */
export async function resolveRest(selected: RestSelected, context: RunContext): Promise<Resolved<RestSendInput>> {
  const { api, request } = selected;
  const scopes = scopesFor(context);
  const callbackUrl = isWebhookItem(selected) ? await context.host.callbackUrlFor?.(selected) : undefined;
  const cookies = request.settings.sendCookies === true ? context.host.cookies?.cookiesFor(selected) : undefined;
  const unexpanded = toRestSendInput({
    request: {
      method: request.method,
      url: callbackUrl ?? request.url,
      pathParams: request.pathParams,
      query: request.query,
      headers: request.headers,
      body: request.body,
      settings: request.settings,
    },
    baseUrl: callbackUrl !== undefined ? '' : baseUrlFor(context, api),
    projectSettings: context.project.settings,
    ...(context.host.preferences !== undefined ? { preferences: context.host.preferences } : {}),
    ...(cookies !== undefined ? { cookies } : {}),
    resolveFile: restFileResolver(context),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  const withTokens = await withSecrets(unexpanded, scopes, context.host.getSecret, context.secretPlaceholders);
  const { input, unresolved } = expandRestSendInput(unexpanded, withTokens, {
    escape: request.settings.escapeProperties === true,
    ...(callbackUrl !== undefined ? { literalUrl: true } : {}),
  });
  // A target holding a secret still behind its placeholder is checked by nothing: its value is not in.
  if (
    isWebhookItem(selected) &&
    callbackUrl === undefined &&
    context.secretPlaceholders?.holds(input.baseUrl) !== true
  ) {
    assertWebhookTarget(input.baseUrl, input.request.url, unresolved.length > 0);
  }
  return {
    input: {
      ...input,
      ...(context.timeoutMs !== undefined ? { settings: { ...input.settings, timeoutMs: context.timeoutMs } } : {}),
    },
    unresolved,
  };
}

/**
 * TLS, signing, credentials (an OAuth2 token included) and the proxy, over a resolved input: what
 * a send does after its pre-request script, so the script never sees a credential (spec §7).
 *
 * @throws WirebenchError `secret-missing` | `auth-grant-unsupported` | `keystore-missing` |
 * `webhook-signing-secret`
 */
export async function connectRest(
  selected: RestSelected,
  context: RunContext,
  input: RestSendInput,
): Promise<RestSendInput> {
  const { request } = selected;
  const tls = await tlsFor(context, request.settings.sslKeystoreRef, request.settings.trustInvalid === true);
  // As the app does: a webhook item's signing secret is read before any OAuth2 token is fetched.
  const sign = await signFor(selected, context);
  const auth = await authFor(restEffectiveAuth(selected), selected.path, context, tls);
  // As the app does: the proxy is chosen for the base URL, or the request's own URL when there is none.
  const proxy = await context.host.proxyFor?.(input.baseUrl === '' ? input.request.url : input.baseUrl);
  return {
    ...input,
    ...(auth !== undefined ? { auth } : {}),
    ...(tls !== undefined ? { tls: { ...input.tls, ...tls } } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(sign !== undefined ? { sign } : {}),
  };
}

/**
 * The data of every event in a buffered event stream, in order: what a run read of the stream, to
 * its end or the timeout. Undefined for any other response, and for one a live send streamed.
 */
function bufferedEvents(exchange: RestExchange): string[] | undefined {
  if (exchange.stream !== undefined || !isEventStream(exchange.headers['content-type'])) return undefined;
  const events: string[] = [];
  const parser = createSseParser((row) => {
    if (row.kind === 'event') events.push(row.data);
  });
  parser.push(exchange.body, 0);
  parser.end();
  return events;
}

/**
 * A REST response as assertions and sequence transfers see it. A buffered event stream is the data
 * of its events, in order, as a JSON array (spec §5.2).
 */
export function restSubject(exchange: RestExchange): AssertionSubject {
  const events = bufferedEvents(exchange);
  return {
    protocol: 'rest',
    status: exchange.status,
    durationMs: exchange.durationMs,
    bodyText: events !== undefined ? JSON.stringify(events) : exchange.text,
    bodyKind:
      events !== undefined || exchange.language === 'json' ? 'json' : exchange.language === 'xml' ? 'xml' : 'other',
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

/**
 * An API's requests in explorer order, without the ones its contract no longer has unless
 * `orphaned` asks for them too.
 */
function apiCandidates(api: RestApi, orphaned = false): RestCandidate[] {
  const out: RestCandidate[] = [];
  walkTree<RestFolder, RestRequestDef, RestSelected>(
    api,
    [],
    api.name,
    `apis/${api.slug}/requests`,
    (request, chain, group) =>
      request.orphaned === true && !orphaned
        ? undefined
        : { kind: 'rest', path: `${group}/${request.name}`, group, api, chain, request },
    out,
  );
  return out;
}

/** True for a webhook item, which `webhookCandidates` builds against the synthetic `webhooks` API. */
function isWebhookItem(selected: RestSelected): boolean {
  return selected.api.id === 'webhooks';
}

/**
 * The project's webhook items, as REST items against a synthetic API whose base URL is each item's
 * effective target. A run has no history, so a callback uses the target.
 */
function webhookCandidates(collection: WebhookCollection, orphaned = false): RestCandidate[] {
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
      if (request.orphaned === true && !orphaned) continue;
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

/**
 * The REST item for `requestId`, an API request or a webhook item, built as a run builds it — and
 * found even when its contract no longer has it (`orphaned`), which a run skips and a person may
 * still send. Undefined when no REST request has that id.
 */
export function restItemFor(project: Project, requestId: string): RestSelected | undefined {
  const candidates = [
    ...project.apis.flatMap((api) => apiCandidates(api, true)),
    ...(project.webhooks !== undefined ? webhookCandidates(project.webhooks, true) : []),
  ];
  return candidates.find((candidate) => candidate.item.request.id === requestId)?.item;
}

/** What a failed send was about to put on the wire: the resolved URL, the method, the enabled headers. */
function attemptedOf(input: RestSendInput): AttemptedRequest {
  return {
    url: joinBase(input.baseUrl, input.request.url),
    method: input.request.method,
    headers: Object.fromEntries(
      input.request.headers.filter((header) => header.enabled).map((header) => [header.name, header.value]),
    ),
  };
}

/**
 * Resolves, connects and sends one request, telling the host when either stage fails, then hands
 * the response's cookies and its contract result to the host. A reference nothing resolves is
 * refused in the prepare stage, with what would have been sent; a failure before resolve has an
 * input is reported with nothing attempted.
 */
async function connectAndSend(
  selected: RestSelected,
  context: RunContext,
  resolve: () => Promise<Resolved<RestSendInput>>,
  controller: ExchangeController<RestLiveEvent>,
  live: boolean,
  /** The pre-request script's step, inside the prepare stage so its failure is reported with it. */
  script?: (input: RestSendInput) => Promise<RestSendInput>,
): Promise<{ readonly connected: RestSendInput; readonly sent: SentRequest }> {
  let startedAt = Date.now();
  // Never masks the send's own error: a row that cannot be built, or a host that throws, is dropped.
  const failed = (stage: 'prepare' | 'send', error: unknown, attempted: RestSendInput | undefined): void => {
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
  let input: RestSendInput | undefined;
  let connected: RestSendInput;
  try {
    const resolved = await resolve();
    input = resolved.input;
    if (resolved.unresolved.length > 0) {
      throw unresolvedError('rest-unresolved-properties', selected.path, resolved.unresolved);
    }
    connected = await connectRest(selected, context, script !== undefined ? await script(input) : input);
  } catch (error) {
    failed('prepare', error, input);
    throw error;
  }
  // The send stage's own clock: a send-stage failure never counts resolve, the script, the token or the proxy.
  startedAt = Date.now();
  let exchange: RestExchange;
  try {
    exchange = await sendRest({
      ...connected,
      signal: controller.signal,
      // Only a live send parses an event stream; any other keeps the buffered body.
      ...(live
        ? {
            onStream: {
              onOpen: (status: number, headers: Readonly<Record<string, string>>) =>
                controller.queue.push({ protocol: 'rest', kind: 'open', status, headers }),
              onRow: (row: SseRow) => controller.queue.push({ protocol: 'rest', kind: 'row', row }),
            },
          }
        : {}),
    });
  } catch (error) {
    failed('send', error, connected);
    throw error;
  }
  dropRefusedToken(context, connected.auth, exchange.status === 401);
  // As the app does after every send: what the response set replaces what was stored, and none forgets it.
  context.host.cookies?.remember(selected, exchange.cookies);
  // The request has gone out: a contract check that rejects checked nothing, and fails nothing.
  const contract = await context.host.contractFor?.(selected, exchange, connected).catch(() => undefined);
  return {
    connected,
    sent: {
      subject: restSubject(exchange),
      raw: exchange,
      exchange: { kind: 'rest', rest: exchange, input: connected, ...(contract !== undefined ? { contract } : {}) },
      ...originOf(exchange.request.url),
    },
  };
}

/**
 * One REST request as a run sends it (spec §3.4): resolve, run its pre-request script when
 * `scripts` is given, connect, send, then its post-response script.
 */
async function sendRestItem(
  selected: RestSelected,
  context: RunContext,
  scripts: ScriptedSend | undefined,
  controller: ExchangeController<RestLiveEvent>,
  live: boolean,
): Promise<SentRequest> {
  if (scripts === undefined) {
    return (await connectAndSend(selected, context, () => resolveRest(selected, context), controller, live)).sent;
  }

  // Resolved with its secrets behind placeholders; the URL is rebuilt only when the script changed it.
  const resolve = () => resolveRest(selected, { ...context, secretPlaceholders: scripts.placeholders });
  let sent: RestRequestSnapshot | undefined;
  const result = await connectAndSend(selected, context, resolve, controller, live, async (input) => {
    const before = restRequestSnapshot(input);
    sent = await scripts.session.pre(before);
    const changed = applyRestSnapshot(input, before, sent);
    const restored = await scripts.placeholders.restore(
      { baseUrl: changed.baseUrl, request: changed.request },
      context.host.getSecret,
    );
    return { ...changed, ...restored };
  });
  const exchange = result.sent.raw as RestExchange;
  return {
    ...result.sent,
    script: await scripts.session.post(sent as RestRequestSnapshot, restResponseSnapshot(exchange)),
  };
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

  open(selected, scope, host, options) {
    const controller = exchangeController<RestLiveEvent>('rest', options);
    const context: RunContext = { ...scope.context, host, signal: controller.signal };
    return controller.handle(() => sendRestItem(selected, context, options.scripts, controller, options.live === true));
  },

  resolve(selected, scope, host) {
    return resolveRest(selected, { ...scope.context, host });
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
