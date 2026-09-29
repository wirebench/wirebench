/**
 * Turning a webhook item into a send input: the webhook collection's counterpart of `rest-send.ts`.
 *
 * An item is an ordinary REST request, so it goes out through the same send input. What differs is
 * where it goes: the nearest folder's *target* (else the collection's), expanded with the request —
 * or, for an imported callback, the URL its parent operation's last exchange named (spec §6.5,
 * §6.6), which is sent exactly as recorded and never expanded again (ADR-0015).
 */

import {
  createApi,
  effectiveTarget,
  evaluateRuntimeTemplate,
  resolveAuthChain,
  signingAlong,
  signingSecretMissing,
  webhookPath,
  webhookRequests,
  WirebenchError,
} from '@wirebench/engine';
import type {
  Cookie,
  EffectiveSigning,
  GetSecret,
  Preferences,
  Project,
  PropertyScopes,
  ProxyOptions,
  RestRequestDef,
  RestSendInput,
  RuntimeExchange,
  SignatureScheme,
  TlsOptions,
} from '@wirebench/engine';
import { expandedSendInput, withDraft } from './rest-send.js';
import type { RestSendResolution } from './rest-send.js';
import { webhookCollectionId } from './webhook-ids.js';
import type { HistoryEntryWire, RestRequestPatchWire } from '../shared/wire-types.js';

/** A callback's URL, or why the target stands in for it; `detail` is the editor's note either way. */
export type CallbackUrl =
  | { readonly url: string; readonly source: 'callback'; readonly detail: string }
  | { readonly url: undefined; readonly source: 'callback-fallback'; readonly detail: string };

/** Everything {@link resolveWebhookSend} needs. */
export interface ResolveWebhookSendArgs {
  readonly project: Project;
  /** The project's id, which names the collection on the wire (`webhooks:<projectId>`). */
  readonly projectId: string;
  readonly requestId: string;
  readonly scopes: PropertyScopes;
  /** The newest REST history entry of a request, which a callback's URL is read from. */
  readonly newest: (requestId: string) => HistoryEntryWire | undefined;
  /** The editor's unsaved edits, applied on top of the saved item for this send only. */
  readonly draft?: RestRequestPatchWire;
  readonly preferences?: Preferences;
  readonly cookies?: readonly Cookie[];
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
}

const ABSOLUTE_HTTP = /^https?:\/\//i;

function fallback(reason: string): CallbackUrl {
  return { url: undefined, source: 'callback-fallback', detail: `expression unresolved — ${reason}` };
}

/** The exchange a callback expression reads (R4): the parent's recorded request and reply. */
function exchangeOf(entry: HistoryEntryWire, parent: RestRequestDef): RuntimeExchange {
  return {
    url: entry.endpoint,
    method: entry.method ?? parent.method,
    ...(parent.contract !== undefined ? { pathTemplate: parent.contract.path } : {}),
    request: {
      headers: entry.request.headers.map((header) => [header.name, header.value] as const),
      body: entry.request.envelopeXml,
    },
    response:
      entry.response === undefined
        ? undefined
        : {
            status: entry.response.status,
            headers: entry.response.rawHeaders,
            ...(entry.response.envelopeXml !== undefined ? { body: entry.response.envelopeXml } : {}),
          },
  };
}

/** `from your last POST /subscriptions (10:42)`, in the machine's local time. */
function sentNote(entry: HistoryEntryWire, parent: RestRequestDef): string {
  let path = entry.endpoint;
  try {
    path = new URL(entry.endpoint).pathname;
  } catch {
    // A recorded endpoint is absolute; should one not be, the note shows it whole.
  }
  const time = new Date(entry.at).toTimeString().slice(0, 5);
  return `from your last ${entry.method ?? parent.method} ${path} (${time})`;
}

/**
 * The URL a callback item is sent to (spec §6.5): its expression evaluated against the newest
 * exchange of its parent operation — the request in the group's linked API whose contract is the
 * hook's `operation`. Only an absolute `http(s)` URL counts; anything else falls back to the target,
 * and the note says why.
 */
export function callbackUrlFor(
  project: Project,
  request: RestRequestDef,
  newest: (requestId: string) => HistoryEntryWire | undefined,
): CallbackUrl {
  const hook = request.hook;
  if (hook?.kind !== 'callback') {
    return fallback('not a callback');
  }
  const chain = project.webhooks === undefined ? [] : (webhookPath(project.webhooks, request.id)?.chain ?? []);
  const apiId = [...chain].reverse().find((folder) => folder.source !== undefined)?.source?.apiId;
  const api = apiId === undefined ? undefined : project.apis.find((candidate) => candidate.id === apiId);
  if (api === undefined) {
    return fallback('no linked API');
  }
  const parent = webhookRequests(api).find(
    (candidate) =>
      candidate.contract !== undefined &&
      `${candidate.contract.method.toLowerCase()} ${candidate.contract.path}` === hook.operation,
  );
  if (parent === undefined) {
    return fallback('parent request not found');
  }
  const entry = newest(parent.id);
  if (entry === undefined) {
    return fallback('never sent');
  }
  const evaluated = evaluateRuntimeTemplate(hook.expression, exchangeOf(entry, parent));
  if (!evaluated.ok) {
    return fallback(evaluated.reason);
  }
  if (!ABSOLUTE_HTTP.test(evaluated.value) || !URL.canParse(evaluated.value)) {
    return fallback('not an absolute http(s) URL');
  }
  return { url: evaluated.value, source: 'callback', detail: sentNote(entry, parent) };
}

/**
 * Refuses a target that cannot be sent to, once it is expanded: an empty one (unless the item's
 * own URL is absolute) and one that is not `http(s)`. A target still holding a reference nothing
 * resolved is left to the unresolved list, which already refuses the send and names the reference.
 */
function assertTarget(baseUrl: string, url: string, unresolved: boolean): void {
  if (baseUrl.trim() === '') {
    if (!ABSOLUTE_HTTP.test(url)) {
      throw new WirebenchError('webhook-target-missing', 'Set the Webhooks target');
    }
    return;
  }
  if (!ABSOLUTE_HTTP.test(baseUrl) && !(unresolved && baseUrl.includes('${'))) {
    throw new WirebenchError('webhook-target-invalid', 'The Webhooks target must start with http:// or https://');
  }
}

/**
 * Resolves one send of a webhook item. The draft is applied first; a callback's URL, when it
 * resolves, is sent verbatim with no base URL; otherwise the effective target is the base URL,
 * expanded with the rest of the request. Credentials climb item → folders (leaf to root) → the
 * collection. Signing climbs the same way: item → nearest folder → collection. `undefined` when
 * the project's collection holds no such item.
 *
 * @throws WirebenchError `webhook-target-missing` / `webhook-target-invalid` for a target that
 * expands to nothing sendable.
 */
export function resolveWebhookSend(args: ResolveWebhookSendArgs): RestSendResolution | undefined {
  const collection = args.project.webhooks;
  const path = collection === undefined ? undefined : webhookPath(collection, args.requestId);
  if (collection === undefined || path === undefined) {
    return undefined;
  }
  const request = withDraft(path.request, args.draft);
  const callback = request.hook?.kind === 'callback' ? callbackUrlFor(args.project, request, args.newest) : undefined;

  const auth = resolveAuthChain([
    request.auth,
    ...[...path.chain].reverse().map((folder) => folder.auth),
    collection.auth,
  ]);
  const signing = signingAlong(collection, path.chain, request);

  const { input, unresolved } =
    callback?.url !== undefined
      ? expandedSendInput(args, { ...request, url: callback.url }, '', { literalUrl: true })
      : expandedSendInput(args, request, effectiveTarget(collection, path.chain));
  if (callback?.url === undefined) {
    assertTarget(input.baseUrl, input.request.url, unresolved.length > 0);
  }

  return {
    input,
    unresolved,
    api: createApi('Webhooks', { id: webhookCollectionId(args.projectId), baseUrl: input.baseUrl }),
    request,
    baseUrlSource: callback?.source ?? 'target',
    ...(callback !== undefined ? { targetDetail: callback.detail } : {}),
    auth,
    ...(signing.signing.mode === 'sign' ? { webhookSigning: signing } : {}),
  };
}

/**
 * The signing to put on the send input, its secret read through the keychain lookup auth uses
 * (§5.2). Never sends unsigned: signing set with nothing in the keychain refuses the send.
 *
 * Only `secretRef` is read (R7): the desktop has a keychain, and `secretEnv` is for CI, so a node
 * with only a CI name refuses here rather than asking for the CLI's pseudo-ref.
 *
 * @throws WirebenchError `webhook-signing-secret`
 */
export async function webhookSignFor(
  effective: EffectiveSigning | undefined,
  getSecret: GetSecret,
): Promise<RestSendInput['sign']> {
  if (effective === undefined || effective.signing.mode !== 'sign') return undefined;
  const ref = effective.signing.secretRef;
  const secret = ref === undefined || ref === '' ? undefined : await getSecret(ref);
  if (secret === undefined || secret === '') throw signingSecretMissing(effective);
  return { scheme: effective.signing.scheme, secret };
}

/**
 * The headers a scheme signs with, as `signWebhook` writes them: History records these from the
 * exchange as sent, so a resend replays them rather than signing again (R1).
 */
export function signingHeaderNames(scheme: SignatureScheme): readonly string[] {
  return scheme.kind === 'standard' ? ['webhook-id', 'webhook-timestamp', 'webhook-signature'] : [scheme.header];
}

/**
 * The resolution History records for a signed send: its header rows with the signing headers
 * appended as they went out (read from the sent request), replacing any typed row of the same name.
 */
export function withSentSigningHeaders(
  resolved: RestSendResolution,
  scheme: SignatureScheme,
  sent: Readonly<Record<string, string>>,
): RestSendResolution {
  const lowerSent = new Map(Object.entries(sent).map(([name, value]) => [name.toLowerCase(), value]));
  const names = signingHeaderNames(scheme);
  const signed = names.flatMap((name) => {
    const value = lowerSent.get(name.toLowerCase());
    return value === undefined ? [] : [{ name, value, enabled: true }];
  });
  const replaced = new Set(signed.map((header) => header.name.toLowerCase()));
  const request = resolved.input.request;
  return {
    ...resolved,
    input: {
      ...resolved.input,
      request: {
        ...request,
        headers: [...request.headers.filter((header) => !replaced.has(header.name.toLowerCase())), ...signed],
      },
    },
  };
}
