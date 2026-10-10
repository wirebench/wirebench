/**
 * A webhook item's URL and its signing headers on the desktop: where a callback item goes — the URL
 * its parent operation's last exchange named (spec §6.5, §6.6), sent exactly as recorded and never
 * expanded again (ADR-0015) — and the signing headers History keeps for a signed send.
 */

import {
  evaluateRuntimeTemplate,
  restApisOf,
  signatureHeaderNames,
  webhookPath,
  webhookRequests,
} from '@wirebench/engine';
import type { Project, RestRequestDef, RestSendInput, RuntimeExchange, SignatureScheme } from '@wirebench/engine';
import type { HistoryEntryWire } from '../shared/wire-types.js';

/** Where a webhook item's URL came from: its target, its callback URL, or the target standing in. */
export type WebhookUrlSource = 'target' | 'callback' | 'callback-fallback';

/** A callback's URL, or why the target stands in for it; `detail` is the editor's note either way. */
export type CallbackUrl =
  | { readonly url: string; readonly source: 'callback'; readonly detail: string }
  | { readonly url: undefined; readonly source: 'callback-fallback'; readonly detail: string };

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
  const api = apiId === undefined ? undefined : restApisOf(project).find((candidate) => candidate.id === apiId);
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
 * The input History records for a signed send: its header rows with the signing headers appended
 * as they went out (read from the sent request), replacing any typed row of the same name.
 */
export function withSentSigningHeaders(
  input: RestSendInput,
  scheme: SignatureScheme,
  sent: Readonly<Record<string, string>>,
): RestSendInput {
  const lowerSent = new Map(Object.entries(sent).map(([name, value]) => [name.toLowerCase(), value]));
  const names = signatureHeaderNames(scheme);
  const signed = names.flatMap((name) => {
    const value = lowerSent.get(name.toLowerCase());
    return value === undefined ? [] : [{ name, value, enabled: true }];
  });
  const replaced = new Set(signed.map((header) => header.name.toLowerCase()));
  const request = input.request;
  return {
    ...input,
    request: {
      ...request,
      headers: [...request.headers.filter((header) => !replaced.has(header.name.toLowerCase())), ...signed],
    },
  };
}
