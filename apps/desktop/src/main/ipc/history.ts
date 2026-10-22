/**
 * Registers the `history.*` IPC channels: list/search, read one entry, remove one, clear, and re-send. Every
 * re-send goes through the engine (`sendThroughEngine`), the path `request.*` sends take, so it is
 * itself recorded as a new history entry. `history.resend` replays a SOAP entry's saved request as
 * it is now, or the entry itself once its request is gone. `history.resendGrpc` calls a gRPC entry's
 * saved request with the messages the entry recorded. `history.resendRest` sends a REST entry's
 * method, URL, headers and body through its saved request's auth, TLS and settings.
 */

import { signatureHeaderNames, splitQuery, WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { HistoryEntryWire } from '../../shared/wire-types.js';
import type { GrpcRequestPatchWire } from '../../shared/kinds/grpc/wire.js';
import type { RestBodyWire, RestRequestPatchWire } from '../../shared/kinds/rest/wire.js';
import type { KeyValueWire } from '../../shared/wire-base.js';
import { isTruncatedBody, type HistoryService } from '../history-service.js';
import { containsRedaction } from '../redact.js';
import type { ProjectRouter } from '../project-router.js';
import type { AuthConfig, EffectiveSigning, RestBody, RestRequestDef } from '@wirebench/engine';
import { type SendThroughEngineDeps } from '../send/exchange.js';
import { registerHandler } from './register.js';
import { namedCredential } from '../kinds/key-masks.js';

/** What the `history.*` channels need beyond `EngineService`/`HistoryService`. */
export interface HistoryChannelDeps {
  readonly project: Pick<ProjectRouter, 'projectId' | 'endpointFor'>;
  /**
   * The engine send every re-send goes through: the request channels' own dependencies and their
   * registry, so a re-send runs its scripts, is cancelled and is recorded as any send is. Without
   * it a re-send is refused as `history-resend-unsupported`.
   */
  readonly send?: SendThroughEngineDeps;
  /**
   * The caller's window's open projects: a list or clear that names no project covers these only, so
   * one window's History never shows or empties another's. Absent (or answering `undefined`), every
   * open file.
   */
  readonly projectIds?: () => readonly string[] | undefined;
}

/** Refuses a re-send when there is no engine send to put it through (a test that registers none). */
export function sendDepsOf(deps: HistoryChannelDeps, id: string, kind: string): SendThroughEngineDeps {
  if (deps.send === undefined) {
    throw new WirebenchError('history-resend-unsupported', "This entry can't be re-sent here.", {
      details: { id, kind },
    });
  }
  return deps.send;
}

/** What a REST resend takes from the saved request: its request as saved, its credentials and its signing. */
export interface SavedRest {
  readonly request: RestRequestDef;
  readonly auth: AuthConfig;
  /** A webhook item's signing, when it signs. */
  readonly webhookSigning?: EffectiveSigning;
}

/**
 * The draft a gRPC entry resends with: its method and the messages it recorded. A streaming
 * client's messages go back as one JSON array, which is what the editor's message field holds
 * for such a call; a unary or server-streaming call sent exactly one. An entry with no messages
 * (the send failed before any went out) falls back to the request text it recorded.
 */
export function grpcResendDraft(
  entry: HistoryEntryWire & { grpc: NonNullable<HistoryEntryWire['grpc']> },
): GrpcRequestPatchWire {
  const { service, method, methodKind, requestMessages } = entry.grpc;
  const streamsIn = methodKind === 'client-streaming' || methodKind === 'bidi-streaming';
  const message =
    requestMessages.length === 0
      ? entry.request.envelopeXml
      : streamsIn
        ? JSON.stringify(
            requestMessages.map((text) => JSON.parse(text) as unknown),
            null,
            2,
          )
        : requestMessages[0]!;
  return { service, method, methodKind, message };
}

/**
 * The redaction marker as `URLSearchParams` writes it. `redactUrl` masks a query parameter by
 * setting it through `URLSearchParams`, so a masked value is recorded percent-encoded.
 */
export const ENCODED_MARKER = /%3credacted%3e/i;

/** True when `text` holds the redaction marker in its literal or its percent-encoded form. */
export function holdsUrlMarker(text: string): boolean {
  return containsRedaction(text) || ENCODED_MARKER.test(text);
}

/**
 * Recorded text made literal for the send path. A resend's draft is property-expanded like a typed
 * request, but what History recorded already went on the wire: a `${secret:name}` there came from a
 * server (a redirect's `Location`, say) or was the literal text a `$${` escape produced, never a
 * reference to fill. The tokenizer reads `$${` as a literal `${`, so this round-trips exactly.
 * Values filled from the saved request are not passed through it: those are typed and must expand.
 */
export function literal(text: string): string {
  // A function, not a replacement string: in one, `$$` is itself the escape for a single `$`.
  return text.replaceAll('${', () => '$${');
}

/** Refuses a resend that would put the redaction marker on the wire. */
export function refuseRedacted(id: string, where: string): never {
  throw new WirebenchError(
    'history-resend-redacted',
    `This entry's ${where} holds a value History redacted, so it can't be re-sent as recorded; re-send it from the request.`,
    { details: { id, where } },
  );
}

/** The value of the last enabled row whose name `matches`, or `undefined` when there is none. */
export function lastEnabled(
  rows: readonly { readonly name: string; readonly value: string; readonly enabled: boolean }[],
  matches: (name: string) => boolean,
): string | undefined {
  let value: string | undefined;
  for (const row of rows) {
    if (row.enabled && matches(row.name)) {
      value = row.value;
    }
  }
  return value;
}

/** A recorded query name percent-decoded, or as it is when it is not a valid escape sequence. */
export function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** True when a recorded (encoded) query name is the one a saved row typed as `typed`. */
export function sameParam(recorded: string, typed: string): boolean {
  return recorded === typed || decodedName(recorded) === typed;
}

/**
 * The query rows typed inline in a saved request's URL. Not `splitQuery`: the URL is unexpanded, and
 * the `#` of a `${#Env#name}` reference there is not a fragment.
 */
export function typedQuery(url: string): KeyValueWire[] {
  const mark = url.indexOf('?');
  if (mark === -1) {
    return [];
  }
  return url
    .slice(mark + 1)
    .split('&')
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const equals = pair.indexOf('=');
      return {
        name: equals === -1 ? pair : pair.slice(0, equals),
        value: equals === -1 ? '' : pair.slice(equals + 1),
        enabled: true,
      };
    });
}

/**
 * The URL fields of a REST resend: the recorded URL split into its part before `?` and its query
 * rows, with every redacted query value filled from the saved request and a query API key left for
 * auth to add once. `pathParams` is empty, because the recorded path is already filled.
 */
export function resendUrl(
  entry: HistoryEntryWire,
  saved: Pick<SavedRest, 'request' | 'auth'>,
): Pick<RestRequestPatchWire, 'url' | 'query' | 'pathParams'> {
  const { path, query } = splitQuery(entry.endpoint);
  if (holdsUrlMarker(path)) {
    refuseRedacted(entry.id, 'URL');
  }
  // `URLSearchParams` rewrote the whole query when it masked a parameter, in form encoding, where
  // a `+` is a space. The literal marker comes from masking a secret value, which rewrites nothing.
  const formEncoded = query.some((row) => ENCODED_MARKER.test(row.name) || ENCODED_MARKER.test(row.value));
  const plus = (text: string): string => (formEncoded ? text.replaceAll('+', '%20') : text);
  const { auth, request } = saved;
  const named = namedCredential(auth);
  const keyName = named?.in === 'query' ? named.name : undefined;
  const savedQuery = [...typedQuery(request.url), ...request.query];
  const rows: KeyValueWire[] = [];
  for (const recorded of query) {
    const name = plus(recorded.name);
    if (keyName !== undefined && sameParam(name, keyName)) {
      continue; // `applyAuth` appends the key again.
    }
    if (holdsUrlMarker(name)) {
      refuseRedacted(entry.id, 'URL');
    }
    const value = holdsUrlMarker(recorded.value)
      ? (lastEnabled(savedQuery, (typed) => sameParam(name, typed)) ??
        refuseRedacted(entry.id, `query parameter ${decodedName(name)}`))
      : literal(plus(recorded.value));
    rows.push({ name: literal(name), value, enabled: true });
  }
  return { url: literal(path), query: rows, pathParams: [] };
}

/**
 * True when the recorded entry URL's origin matches `savedOrigin`, the saved request's resolved
 * origin — so the recorded URL is safe to reuse. `false` when `savedOrigin` is `undefined` or the
 * entry URL can't be parsed, which `restResendDraft` refuses. Compared lower-cased on both sides: `URL.origin` already lower-cases
 * the host it parses, but `savedOrigin` is handed in as a plain string that may not have gone
 * through `URL` at all.
 */
export function sameOrigin(endpoint: string, savedOrigin: string | undefined): boolean {
  if (savedOrigin === undefined) {
    return false;
  }
  try {
    return new URL(endpoint).origin.toLowerCase() === savedOrigin.toLowerCase();
  } catch {
    return false;
  }
}

/** The language a recorded body is sent as when the saved request has no raw body to lend one. */
export function rawLanguageOf(text: string): 'json' | 'xml' | 'text' {
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return text.trimStart().startsWith('<') ? 'xml' : 'text';
  }
}

/**
 * The body a REST resend sends: the recorded text in the saved raw body's language and content
 * type, or `undefined` — send the saved body as it is — when the entry kept no text for a body that
 * has none (form, multipart, binary or none).
 */
export function resendBody(text: string, saved: RestBody): RestBodyWire | undefined {
  if (saved.kind === 'raw') {
    return {
      kind: 'raw',
      language: saved.language,
      ...(saved.contentType !== undefined ? { contentType: saved.contentType } : {}),
      text: literal(text),
    };
  }
  return text === '' ? undefined : { kind: 'raw', language: rawLanguageOf(text), text: literal(text) };
}

/**
 * The draft a REST entry resends with, applied over its saved request for one send only.
 *
 * The method, URL, headers and body are the entry's: what went on the wire, sent literally — a
 * `${…}` in recorded text is escaped, not expanded (see `literal`). Auth, TLS, proxy and settings
 * stay the saved request's. A redacted header or query value is filled from the saved request's
 * last enabled row of that name, as typed, so it expands on the normal send path. An entry with no
 * response recorded no sent URL, so the saved URL is kept.
 *
 * The recorded URL is reused only when its origin matches `savedOrigin`, the saved request's own
 * origin once its property references resolve. A redirect that crosses origins — to a CDN, say, or
 * a pre-signed object-store URL — makes the original send drop `authorization`,
 * `proxy-authorization` and `cookie` before following it (`packages/core/src/http/client.ts`),
 * but the entry records only that last hop's URL. Resending it with the saved auth would hand a
 * credential to an origin the original send never gave one to, and sending the saved URL instead
 * would not be the request History shows. So a different origin — or one that is undefined or
 * unparsable — is refused, and the request is re-sent from its editor.
 *
 * @throws WirebenchError `history-resend-origin` when the entry has a response and its URL is not on
 *   the saved request's current origin;
 *   `history-resend-redacted` when a redacted value has no saved row to fill
 *   it, or the marker is in the URL's path, user info or fragment, or in the body;
 *   `history-resend-truncated` when the body is History's truncated copy.
 *
 * A webhook item that signs is resent with signing off when the entry holds its signing headers
 * (webhook-signatures R1): they are replayed as recorded, never signed again. An entry without them
 * is signed fresh, so a resend never goes out unsigned.
 */
export function restResendDraft(
  entry: HistoryEntryWire,
  saved: SavedRest,
  savedOrigin: string | undefined,
): RestRequestPatchWire {
  const { request } = saved;
  if (entry.response !== undefined && !sameOrigin(entry.endpoint, savedOrigin)) {
    throw new WirebenchError(
      'history-resend-origin',
      'This entry was sent to another host (a redirect or another environment); re-send it from the request.',
      { details: { id: entry.id } },
    );
  }
  const url = entry.response !== undefined ? resendUrl(entry, saved) : {};
  const headers: KeyValueWire[] = entry.request.headers.map((header) => {
    if (!containsRedaction(header.value)) {
      return { name: literal(header.name), value: literal(header.value), enabled: true };
    }
    const lower = header.name.toLowerCase();
    const value =
      lastEnabled(request.headers, (name) => name.toLowerCase() === lower) ??
      refuseRedacted(entry.id, `header ${header.name}`);
    return { name: literal(header.name), value, enabled: true };
  });
  const text = entry.request.envelopeXml;
  if (containsRedaction(text)) {
    refuseRedacted(entry.id, 'body');
  }
  if (isTruncatedBody(text)) {
    throw new WirebenchError(
      'history-resend-truncated',
      "History kept only the start of this entry's body, so re-sending it would send a different body; re-send it from the request.",
      { details: { id: entry.id } },
    );
  }
  const body = resendBody(text, request.body);
  return {
    method: entry.method ?? request.method,
    ...url,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(carriesSignature(entry, saved.webhookSigning) ? { signing: { mode: 'none' as const } } : {}),
  };
}

/** Whether `entry` recorded every header the item's signing scheme writes (names case-insensitive). */
export function carriesSignature(entry: HistoryEntryWire, signing: SavedRest['webhookSigning']): boolean {
  if (signing === undefined || signing.signing.mode !== 'sign') {
    return false;
  }
  const recorded = new Set(entry.request.headers.map((header) => header.name.toLowerCase()));
  return signatureHeaderNames(signing.signing.scheme).every((name) => recorded.has(name.toLowerCase()));
}

export function registerHistoryChannels(history: HistoryService, deps: HistoryChannelDeps): void {
  registerHandler(channels.history.list, (request) => {
    const projectIds = request.projectId === undefined ? deps.projectIds?.() : undefined;
    return Promise.resolve(
      history.list({
        ...(request.query !== undefined ? { query: request.query } : {}),
        limit: request.limit ?? 200,
        ...(request.before !== undefined ? { before: request.before } : {}),
        ...(request.projectId !== undefined
          ? { projectId: request.projectId }
          : projectIds !== undefined
            ? { projectIds }
            : {}),
      }),
    );
  });

  registerHandler(channels.history.get, (request) => Promise.resolve({ entry: history.get(request.id) }));

  registerHandler(channels.history.clear, async () => ({ cleared: await history.clear(deps.projectIds?.()) }));

  registerHandler(channels.history.remove, async (request) => ({ removed: await history.remove(request.id) }));
}
