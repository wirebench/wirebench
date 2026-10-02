/**
 * Registers the `history.*` IPC channels: list/search, read one entry, clear, and re-send. Every
 * re-send goes through the engine (`sendThroughEngine`), the path `request.*` sends take, so it is
 * itself recorded as a new history entry. `history.resend` replays a SOAP entry's saved request as
 * it is now, or the entry itself once its request is gone. `history.resendGrpc` calls a gRPC entry's
 * saved request with the messages the entry recorded. `history.resendRest` sends a REST entry's
 * method, URL, headers and body through its saved request's auth, TLS and settings.
 */

import { randomUUID } from 'node:crypto';
import { grpcItemFor, joinBase, signatureHeaderNames, splitQuery, WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type {
  GrpcRequestPatchWire,
  HeaderEntryWire,
  HistoryEntryWire,
  KeyValueWire,
  RestBodyWire,
  RestRequestPatchWire,
} from '../../shared/wire-types.js';
import { isTruncatedBody, type HistoryService } from '../history-service.js';
import { containsRedaction } from '../redact.js';
import type { ProjectRouter } from '../project-router.js';
import type { AuthConfig, EffectiveSigning, RestBody, RestRequestDef } from '@wirebench/engine';
import { AD_HOC_ID } from '../send/draft.js';
import { previewRest, sendThroughEngine, type RestPreview, type SendThroughEngineDeps } from '../send/exchange.js';
import { registerHandler } from './register.js';

/** What the `history.*` channels need beyond `EngineService`/`HistoryService`. */
export interface HistoryChannelDeps {
  readonly project: Pick<ProjectRouter, 'projectId'> & Partial<Pick<ProjectRouter, 'endpointFor'>>;
  /**
   * The engine send every re-send goes through: the request channels' own dependencies and their
   * registry, so a re-send runs its scripts, is cancelled and is recorded as any send is. Without
   * it a re-send is refused as `history-resend-unsupported`.
   */
  readonly send?: SendThroughEngineDeps;
}

/** Refuses a re-send when there is no engine send to put it through (a test that registers none). */
function sendDepsOf(deps: HistoryChannelDeps, id: string, kind: string): SendThroughEngineDeps {
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

/** The saved request a REST resend goes out through, resolved as its send resolves it. */
function savedRestOf(preview: RestPreview): SavedRest {
  const { signing } = preview.item;
  return {
    request: preview.item.request,
    auth: preview.auth,
    ...(signing?.signing.mode === 'sign' ? { webhookSigning: signing } : {}),
  };
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
const ENCODED_MARKER = /%3credacted%3e/i;

/** True when `text` holds the redaction marker in its literal or its percent-encoded form. */
function holdsUrlMarker(text: string): boolean {
  return containsRedaction(text) || ENCODED_MARKER.test(text);
}

/**
 * Recorded text made literal for the send path. A resend's draft is property-expanded like a typed
 * request, but what History recorded already went on the wire: a `${secret:name}` there came from a
 * server (a redirect's `Location`, say) or was the literal text a `$${` escape produced, never a
 * reference to fill. The tokenizer reads `$${` as a literal `${`, so this round-trips exactly.
 * Values filled from the saved request are not passed through it: those are typed and must expand.
 */
function literal(text: string): string {
  // A function, not a replacement string: in one, `$$` is itself the escape for a single `$`.
  return text.replaceAll('${', () => '$${');
}

/** Refuses a resend that would put the redaction marker on the wire. */
function refuseRedacted(id: string, where: string): never {
  throw new WirebenchError(
    'history-resend-redacted',
    `This entry's ${where} holds a value History redacted, so it can't be re-sent as recorded; re-send it from the request.`,
    { details: { id, where } },
  );
}

/** The value of the last enabled row whose name `matches`, or `undefined` when there is none. */
function lastEnabled(
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
function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** True when a recorded (encoded) query name is the one a saved row typed as `typed`. */
function sameParam(recorded: string, typed: string): boolean {
  return recorded === typed || decodedName(recorded) === typed;
}

/**
 * The query rows typed inline in a saved request's URL. Not `splitQuery`: the URL is unexpanded, and
 * the `#` of a `${#Env#name}` reference there is not a fragment.
 */
function typedQuery(url: string): KeyValueWire[] {
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
function resendUrl(
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
  const keyName = auth.type === 'api-key' && auth.in === 'query' ? auth.name : undefined;
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
function sameOrigin(endpoint: string, savedOrigin: string | undefined): boolean {
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
function rawLanguageOf(text: string): 'json' | 'xml' | 'text' {
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
function resendBody(text: string, saved: RestBody): RestBodyWire | undefined {
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
 * `proxy-authorization` and `cookie` before following it (`packages/engine/src/http/client.ts`),
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
function carriesSignature(entry: HistoryEntryWire, signing: SavedRest['webhookSigning']): boolean {
  if (signing === undefined || signing.signing.mode !== 'sign') {
    return false;
  }
  const recorded = new Set(entry.request.headers.map((header) => header.name.toLowerCase()));
  return signatureHeaderNames(signing.signing.scheme).every((name) => recorded.has(name.toLowerCase()));
}

/**
 * True when a REST entry was an event stream, or, with no response to say, asked for one with an
 * `Accept` header — the line `log.resend` draws.
 */
function isStreamEntry(entry: HistoryEntryWire): boolean {
  return (
    entry.sse !== undefined ||
    (entry.response === undefined &&
      entry.request.headers.some(
        (header) => header.name.toLowerCase() === 'accept' && header.value.toLowerCase().includes('text/event-stream'),
      ))
  );
}

/**
 * The saved request's resolved origin: the base and path joined as its send resolves them, with a
 * `${secret:…}` token kept as typed. Only a reference left unresolved *in that joined URL itself*
 * makes this `undefined` — a `${secret:…}` (or any other property reference) in a header, the body,
 * or elsewhere on the saved request expands on its own path and must not affect this. Also
 * `undefined` when the joined text doesn't parse as a URL. `restResendDraft` refuses an entry with
 * a response in either case.
 */
function savedOriginOf(saved: Pick<RestPreview, 'input'>): string | undefined {
  const joined = joinBase(saved.input.baseUrl, saved.input.request.url);
  if (joined.includes('${')) {
    return undefined;
  }
  try {
    return new URL(joined).origin;
  } catch {
    return undefined;
  }
}

/** Drops headers the history store redacted (`<redacted>`) before resending — never resent verbatim. */
function liveHeaders(headers: readonly HeaderEntryWire[]): Record<string, string> {
  return Object.fromEntries(headers.filter((header) => header.value !== '<redacted>').map((h) => [h.name, h.value]));
}

/**
 * True when an orphaned entry (its original request no longer exists) carries a redacted
 * secret anywhere a resend would replay: the request envelope, a request header value, or the
 * SOAP fault reason. Such an entry must never be resent — the redaction marker itself would go
 * out as the literal credential.
 */
function isRedacted(entry: HistoryEntryWire): boolean {
  return (
    containsRedaction(entry.request.envelopeXml) ||
    entry.request.headers.some((header) => containsRedaction(header.value)) ||
    (entry.fault?.reason !== undefined && containsRedaction(entry.fault.reason))
  );
}

export function registerHistoryChannels(history: HistoryService, deps: HistoryChannelDeps): void {
  registerHandler(channels.history.list, (request) =>
    Promise.resolve(
      history.list({
        ...(request.query !== undefined ? { query: request.query } : {}),
        limit: request.limit ?? 200,
        ...(request.before !== undefined ? { before: request.before } : {}),
        ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
      }),
    ),
  );

  registerHandler(channels.history.get, (request) => Promise.resolve({ entry: history.get(request.id) }));

  registerHandler(channels.history.clear, async () => ({ cleared: await history.clear() }));

  registerHandler(channels.history.resend, (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', 'This entry is no longer in History.', {
        details: { id: request.id },
      });
    }

    // Only a SOAP send can be replayed here: both paths below build a SOAP send input, so a REST,
    // gRPC or WebSocket entry would go out as a POST of its body wrapped as an envelope — a
    // different request from the one recorded. Refuse it, typed, rather than misfire. (An entry
    // without a kind predates the other protocols and is SOAP.)
    const kind = entry.kind ?? 'soap';
    if (kind !== 'soap') {
      throw new WirebenchError(
        'history-resend-unsupported',
        kind === 'websocket'
          ? 'A WebSocket session is re-sent from its request, not from History.'
          : `This ${kind === 'grpc' ? 'gRPC' : 'REST'} entry can't be re-sent as a SOAP request.`,
        { details: { id: request.id, kind } },
      );
    }

    // Path 1: the original request still exists — replay the LIVE request (current envelope,
    // headers and effective endpoint, its scripts, TLS and auth), exactly like a normal
    // `request.send`. The stored entry was redacted before being written to disk, so it must never
    // be the source of a resend while a live copy is available.
    const { requestId } = entry;
    if (requestId !== undefined && deps.project.projectId(requestId) !== undefined) {
      // No endpoint resolves for it now (an environment that maps none): it goes to the one it went
      // to, still as its project sends it — properties, auth, keychain, WS-Security, proxy, scripts.
      const live = deps.project.endpointFor?.(requestId) !== undefined;
      if (!live && holdsUrlMarker(entry.endpoint)) {
        refuseRedacted(entry.id, 'URL');
      }
      return sendThroughEngine(sendDepsOf(deps, request.id, kind), randomUUID(), requestId, {
        draft: { kind: 'soap', override: live ? {} : { endpoint: entry.endpoint } },
      });
    }
    // Path 2: the original request is gone. An entry that carries a redacted secret can never
    // be resent — the marker itself would go out as the literal credential — so refuse it.
    if (isRedacted(entry)) {
      throw new WirebenchError(
        'history-resend-redacted',
        "This entry holds values History redacted and the request it was sent from no longer exists, so it can't be re-sent.",
        { details: { id: request.id } },
      );
    }
    const input = {
      endpoint: entry.endpoint,
      envelopeXml: entry.request.envelopeXml,
      soapVersion: entry.soapVersion === 'none' ? ('1.1' as const) : entry.soapVersion,
      ...(entry.soapAction !== undefined ? { soapAction: entry.soapAction } : {}),
      headers: liveHeaders(entry.request.headers),
    };
    // Sent as it was recorded, as a synthetic item, back into the History it came from.
    return sendThroughEngine(sendDepsOf(deps, request.id, kind), randomUUID(), AD_HOC_ID, {
      draft: { kind: 'soap', override: {} },
      adHoc: {
        input,
        names: {
          requestName: entry.requestName,
          interfaceName: entry.interfaceName,
          operationName: entry.operationName,
          projectId: entry.projectId,
        },
        ...(requestId !== undefined ? { requestId } : {}),
      },
    });
  });

  registerHandler(channels.history.resendGrpc, (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', 'This entry is no longer in History.', {
        details: { id: request.id },
      });
    }
    const { grpc } = entry;
    if (entry.kind !== 'grpc' || grpc === undefined) {
      throw new WirebenchError(
        'history-resend-unsupported',
        "This entry isn't a gRPC call, so it can't be re-sent as one.",
        { details: { id: request.id, kind: entry.kind ?? 'soap' } },
      );
    }
    // The call goes out through the saved request (its endpoint, metadata, auth and TLS), so an
    // entry whose request is gone has nothing to resend through.
    const { requestId } = entry;
    const send = sendDepsOf(deps, request.id, 'grpc');
    const located = requestId === undefined ? undefined : send.project.runContextFor?.(requestId);
    if (requestId === undefined || located === undefined || grpcItemFor(located.project, requestId) === undefined) {
      throw new WirebenchError(
        'history-resend-orphan',
        "The request this call was sent from no longer exists, so it can't be re-sent.",
        { details: { id: request.id } },
      );
    }
    // No live hook: nothing on screen holds this send id, so its events would be dropped.
    return sendThroughEngine(send, randomUUID(), requestId, {
      draft: { kind: 'grpc', draft: grpcResendDraft({ ...entry, grpc }) },
    });
  });

  registerHandler(channels.history.resendRest, async (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', 'This entry is no longer in History.', {
        details: { id: request.id },
      });
    }
    if (entry.kind !== 'rest') {
      throw new WirebenchError(
        'history-resend-unsupported',
        "This entry isn't a REST request, so it can't be re-sent as one.",
        { details: { id: request.id, kind: entry.kind ?? 'soap' } },
      );
    }
    // A resend has no live pane, so a stream the server never closes would never finish.
    if (isStreamEntry(entry)) {
      throw new WirebenchError('rest-resend-streaming', 'Event streams resend from the editor.', {
        details: { id: request.id },
      });
    }
    // Auth, TLS, proxy and settings come from the saved request, so an entry whose request is gone
    // has nothing to resend through.
    const { requestId } = entry;
    const send = sendDepsOf(deps, request.id, 'rest');
    const saved = requestId === undefined ? undefined : await previewRest(send, requestId, undefined);
    if (requestId === undefined || saved === undefined) {
      throw new WirebenchError(
        'history-resend-orphan',
        "The request this entry was sent from no longer exists, so it can't be re-sent.",
        { details: { id: request.id } },
      );
    }
    return await sendThroughEngine(send, randomUUID(), requestId, {
      draft: { kind: 'rest', draft: restResendDraft(entry, savedRestOf(saved), savedOriginOf(saved)) },
    });
  });
}
