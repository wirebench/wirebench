/**
 * Registers the `history.*` IPC channels: list/search, read one entry, clear, and re-send.
 * `history.resend` goes through the same `sendAndRecordHistory` path as `request.send`, so a
 * re-send is itself recorded as a new history entry. `history.resendGrpc` calls a gRPC entry's
 * saved request through `request.sendGrpc`'s path, with the messages the entry recorded.
 * `history.resendRest` sends a REST entry's method, URL, headers and body through its saved
 * request's auth, TLS and settings, on `request.sendRest`'s path, which records the new entry.
 */

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { joinBase, splitQuery, WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type {
  FailedExchangeWire,
  GrpcExchangeSummary,
  GrpcRequestPatchWire,
  HeaderEntryWire,
  HistoryEntryWire,
  KeyValueWire,
  RequestSendGrpcRequest,
  RequestSendRestRequest,
  RestBodyWire,
  RestExchangeSummary,
  RestRequestPatchWire,
} from '../../shared/wire-types.js';
import type { EngineService } from '../engine-service.js';
import { isTruncatedBody, type HistoryService } from '../history-service.js';
import { containsRedaction } from '../redact.js';
import type { ProjectRouter } from '../project-router.js';
import type { RestSendResolution } from '../rest-send.js';
import type { GetSecret, PropertyScopes, RestBody } from '@wirebench/engine';
import type { HistorySendProject, SendWithHistoryDeps } from '../send-with-history.js';
import { sendAndRecordHistory } from '../send-with-history.js';
import { registerHandler } from './register.js';

/** What `history.resend` needs beyond `EngineService`/`HistoryService`. */
export interface HistoryChannelDeps {
  readonly project: HistorySendProject &
    Pick<ProjectRouter, 'buildLiveSendInput'> &
    Partial<Pick<ProjectRouter, 'grpcSend' | 'restSend'>>;
  /**
   * The scopes an *ad-hoc* send expands against — one with no saved request behind it, and so
   * no project to resolve a chain from. Omitted in tests, which then expand against nothing.
   */
  readonly adHocScopes?: () => PropertyScopes;
  readonly showSecrets?: { get(): boolean };
  /** Called with the new entry a re-send produced, so main can broadcast `history.appended`. */
  readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
  /** Called with the failure row of a resend that threw, so main can broadcast `exchange.failed`. */
  readonly onSendFailed?: (failure: FailedExchangeWire) => void;
  /** The getter a resend's `${secret:name}` tokens resolve through; see `SendWithHistoryDeps`. */
  readonly secretsFor?: (projectId: string | undefined) => GetSecret;
  /** The OAuth2 token service and keychain reader, for a resend whose owner uses OAuth2. */
  readonly oauth2?: SendWithHistoryDeps['oauth2'];
  readonly getSecret?: SendWithHistoryDeps['getSecret'];
  /** Sends a gRPC call the way `request.sendGrpc` does; `history.resendGrpc` is refused without it. */
  readonly grpc?: {
    send(request: RequestSendGrpcRequest, sender: WebContents): Promise<GrpcExchangeSummary>;
  };
  /** Sends a REST request the way `log.resend` does; `history.resendRest` is refused without it. */
  readonly rest?: {
    send(request: RequestSendRestRequest): Promise<RestExchangeSummary>;
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

/** Refuses a resend that would put the redaction marker on the wire. */
function refuseRedacted(id: string, where: string): never {
  throw new WirebenchError('history-resend-redacted', `The ${where} of this entry holds a value History redacted`, {
    details: { id, where },
  });
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
  saved: Pick<RestSendResolution, 'request' | 'auth'>,
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
      : plus(recorded.value);
    rows.push({ name, value, enabled: true });
  }
  return { url: path, query: rows, pathParams: [] };
}

/**
 * True when the recorded entry URL's origin matches `savedOrigin`, the saved request's resolved
 * origin — so the recorded URL is safe to reuse. `false` when `savedOrigin` is `undefined` or the
 * entry URL can't be parsed. Compared lower-cased on both sides: `URL.origin` already lower-cases
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
      text,
    };
  }
  return text === '' ? undefined : { kind: 'raw', language: rawLanguageOf(text), text };
}

/**
 * The draft a REST entry resends with, applied over its saved request for one send only.
 *
 * The method, URL, headers and body are the entry's: what went on the wire. Auth, TLS, proxy and
 * settings stay the saved request's. A redacted header or query value is filled from the saved
 * request's last enabled row of that name, as typed, so it expands on the normal send path. An
 * entry with no response recorded no sent URL, so the saved URL is kept.
 *
 * The recorded URL is reused only when its origin matches `savedOrigin`, the saved request's own
 * origin once its property references resolve. A redirect that crosses origins — to a CDN, say, or
 * a pre-signed object-store URL — makes the original send drop `authorization`,
 * `proxy-authorization` and `cookie` before following it (`packages/engine/src/http/client.ts`),
 * but the entry records only that last hop's URL. Resending it with the saved auth would hand a
 * credential to an origin the original send never gave one to, so a different origin — or one that
 * is undefined or unparsable — falls back to the saved URL, exactly as an entry with no response
 * recorded does.
 *
 * @throws WirebenchError `history-resend-redacted` when a redacted value has no saved row to fill
 *   it, or the marker is in the URL's path, user info or fragment, or in the body;
 *   `history-resend-truncated` when the body is History's truncated copy.
 */
export function restResendDraft(
  entry: HistoryEntryWire,
  saved: Pick<RestSendResolution, 'request' | 'auth'>,
  savedOrigin: string | undefined,
): RestRequestPatchWire {
  const { request } = saved;
  const url = entry.response !== undefined && sameOrigin(entry.endpoint, savedOrigin) ? resendUrl(entry, saved) : {};
  const headers: KeyValueWire[] = entry.request.headers.map((header) => {
    if (!containsRedaction(header.value)) {
      return { name: header.name, value: header.value, enabled: true };
    }
    const lower = header.name.toLowerCase();
    const value =
      lastEnabled(request.headers, (name) => name.toLowerCase() === lower) ??
      refuseRedacted(entry.id, `header ${header.name}`);
    return { name: header.name, value, enabled: true };
  });
  const text = entry.request.envelopeXml;
  if (containsRedaction(text)) {
    refuseRedacted(entry.id, 'body');
  }
  if (isTruncatedBody(text)) {
    throw new WirebenchError(
      'history-resend-truncated',
      'History kept only the start of this body, so sending it would send a different body',
      { details: { id: entry.id } },
    );
  }
  const body = resendBody(text, request.body);
  return {
    method: entry.method ?? request.method,
    ...url,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
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
 * The saved request's resolved origin, the same synchronous property/environment expansion
 * `deps.project.restSend` runs before `sendRestRequest` fills in `${secret:…}` tokens. `undefined`
 * when a property reference is left unresolved or the expanded base and path don't parse as a
 * URL — `restResendDraft`'s safe fallback for either case is the saved URL.
 */
function savedOriginOf(saved: RestSendResolution): string | undefined {
  if (saved.unresolved.length > 0) {
    return undefined;
  }
  try {
    return new URL(joinBase(saved.input.baseUrl, saved.input.request.url)).origin;
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

export function registerHistoryChannels(
  service: EngineService,
  history: HistoryService,
  deps: HistoryChannelDeps,
): void {
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
      throw new WirebenchError('unknown-history-entry', `No history entry with id "${request.id}"`, {
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
        `A ${kind === 'websocket' ? 'WebSocket session' : `${kind === 'grpc' ? 'gRPC' : 'REST'} call`} is resent from its request, not from History`,
        { details: { id: request.id, kind } },
      );
    }

    // Path 1: the original request still exists — replay the LIVE request (current envelope,
    // headers and effective endpoint), exactly like a normal `request.send`. The stored entry
    // was redacted before being written to disk, so it must never be the source of a resend
    // while a live copy is available.
    const liveInput = entry.requestId !== undefined ? deps.project.buildLiveSendInput(entry.requestId) : undefined;
    if (liveInput === undefined) {
      // Path 2: the original request is gone. An entry that carries a redacted secret can never
      // be resent — the marker itself would go out as the literal credential — so refuse it.
      if (isRedacted(entry)) {
        throw new WirebenchError(
          'history-resend-redacted',
          'This entry contains redacted secrets and its original request no longer exists',
          { details: { id: request.id } },
        );
      }
    }

    const input = liveInput ?? {
      endpoint: entry.endpoint,
      envelopeXml: entry.request.envelopeXml,
      soapVersion: entry.soapVersion === 'none' ? '1.1' : entry.soapVersion,
      ...(entry.soapAction !== undefined ? { soapAction: entry.soapAction } : {}),
      headers: liveHeaders(entry.request.headers),
    };

    return sendAndRecordHistory(
      service,
      {
        project: deps.project,
        ...(deps.adHocScopes !== undefined ? { adHocScopes: deps.adHocScopes } : {}),
        ...(deps.showSecrets !== undefined ? { showSecrets: deps.showSecrets } : {}),
        history,
        ...(deps.onHistoryAppended !== undefined ? { onHistoryAppended: deps.onHistoryAppended } : {}),
        ...(deps.onSendFailed !== undefined ? { onSendFailed: deps.onSendFailed } : {}),
        ...(deps.secretsFor !== undefined ? { secretsFor: deps.secretsFor } : {}),
        ...(deps.oauth2 !== undefined ? { oauth2: deps.oauth2 } : {}),
        ...(deps.getSecret !== undefined ? { getSecret: deps.getSecret } : {}),
      },
      {
        sendId: crypto.randomUUID(),
        ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
        input,
      },
      {
        requestName: entry.requestName,
        interfaceName: entry.interfaceName,
        operationName: entry.operationName,
        projectId: entry.projectId,
      },
    );
  });

  registerHandler(channels.history.resendGrpc, (request, sender) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', `No history entry with id "${request.id}"`, {
        details: { id: request.id },
      });
    }
    const { grpc } = entry;
    if (entry.kind !== 'grpc' || grpc === undefined || deps.grpc === undefined) {
      throw new WirebenchError('history-resend-unsupported', 'Only a gRPC call is resent through this channel', {
        details: { id: request.id, kind: entry.kind ?? 'soap' },
      });
    }
    // The call goes out through the saved request (its endpoint, metadata, auth and TLS), so an
    // entry whose request is gone has nothing to resend through.
    const { requestId } = entry;
    if (requestId === undefined || deps.project.grpcSend?.(requestId) === undefined) {
      throw new WirebenchError('history-resend-orphan', 'The request this call was sent from no longer exists', {
        details: { id: request.id },
      });
    }
    return deps.grpc.send({ sendId: randomUUID(), requestId, draft: grpcResendDraft({ ...entry, grpc }) }, sender);
  });

  registerHandler(channels.history.resendRest, (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', `No history entry with id "${request.id}"`, {
        details: { id: request.id },
      });
    }
    if (entry.kind !== 'rest' || deps.rest === undefined) {
      throw new WirebenchError('history-resend-unsupported', 'Only a REST request is resent through this channel', {
        details: { id: request.id, kind: entry.kind ?? 'soap' },
      });
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
    const saved = requestId === undefined ? undefined : deps.project.restSend?.(requestId);
    if (requestId === undefined || saved === undefined) {
      throw new WirebenchError('history-resend-orphan', 'The request this entry was sent from no longer exists', {
        details: { id: request.id },
      });
    }
    return deps.rest.send({
      sendId: randomUUID(),
      requestId,
      draft: restResendDraft(entry, saved, savedOriginOf(saved)),
    });
  });
}
