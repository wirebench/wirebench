/**
 * Property expansion for a WebSocket call: every `${…}` reference in the request URL, its query
 * and header rows, and its subprotocols, resolved against the same scopes a REST or gRPC send
 * uses. Message text is expanded separately (`expandWsMessage`), since a message is sent long
 * after the call's other fields are settled and may be edited and resent several times over one
 * session.
 *
 * Mirrors `grpc/expand.ts`: names as well as values are expanded, an unresolved reference is
 * reported once per place it appears rather than guessed at or deduplicated, and `escape` — JSON
 * string escaping — applies only to a message, never to a header, query row or the URL.
 */

import { expand } from '../project/properties.js';
import type { PropertyScopes, UnresolvedRef } from '../project/properties.js';
import { escapeForLanguage } from '../rest/body.js';
import type { KeyValueEntry } from '../rest/model.js';
import type { WsRequestDef } from './model.js';

/** Input to {@link expandWsInput}: the parts of a saved request an open call needs. */
export interface WsCallInput {
  readonly serverUrl: string;
  readonly request: Pick<WsRequestDef, 'url' | 'query' | 'headers' | 'subprotocols' | 'settings'>;
  readonly apiHeaders: readonly KeyValueEntry[];
}

function runRows(rows: readonly KeyValueEntry[], run: (text: string) => string): KeyValueEntry[] {
  return rows.map((row) => ({ ...row, name: run(row.name), value: run(row.value) }));
}

/**
 * Expands every property reference in a call's URL, query rows, header rows (both the API's and
 * the request's own) and subprotocols.
 */
export function expandWsInput(
  input: WsCallInput,
  scopes: PropertyScopes,
): { readonly input: WsCallInput; readonly unresolved: readonly UnresolvedRef[] } {
  const unresolved: UnresolvedRef[] = [];
  const run = (text: string): string => {
    const result = expand(text, scopes);
    unresolved.push(...result.unresolved);
    return result.text;
  };

  return {
    input: {
      ...input,
      request: {
        ...input.request,
        url: run(input.request.url),
        query: runRows(input.request.query, run),
        headers: runRows(input.request.headers, run),
        subprotocols: input.request.subprotocols.map((protocol) => run(protocol)),
      },
      apiHeaders: runRows(input.apiHeaders, run),
    },
    unresolved,
  };
}

/**
 * Expands every property reference in one message's text. `escape: true` JSON-escapes every
 * substituted value, for a message that is going to be embedded in a larger JSON payload.
 */
export function expandWsMessage(
  text: string,
  scopes: PropertyScopes,
  options: { readonly escape: boolean },
): { readonly text: string; readonly unresolved: readonly UnresolvedRef[] } {
  const unresolved: UnresolvedRef[] = [];
  const plain = expand(text, scopes);
  unresolved.push(...plain.unresolved);
  if (!options.escape) {
    return { text: plain.text, unresolved };
  }
  const escaped = expand(text, escapedScopes(scopes));
  return { text: escaped.text, unresolved };
}

/** The same scopes with every value JSON-escaped, so substitution escapes as it goes. */
function escapedScopes(scopes: PropertyScopes): PropertyScopes {
  const escapeMap = (map: Readonly<Record<string, string | undefined>> | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(map ?? {})) {
      if (value !== undefined) {
        out[name] = escapeForLanguage(value, 'json');
      }
    }
    return out;
  };
  return {
    ...scopes,
    project: escapeMap(scopes.project),
    global: escapeMap(scopes.global),
    system: escapeMap(scopes.system),
    ...(scopes.env !== undefined ? { env: escapeMap(scopes.env) } : {}),
    ...(scopes.workspace !== undefined ? { workspace: escapeMap(scopes.workspace) } : {}),
  };
}
