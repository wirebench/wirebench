/**
 * Project-wide find, the engine behind the activity bar's Search view.
 *
 * It runs in main on purpose: cached definition documents can be megabytes, and they already
 * live here. Only the matching line — trimmed and capped — ever crosses the bridge, so
 * searching a definition never ships the definition.
 *
 * Pure over an explicit corpus, so the matching rules can be asserted on without a project.
 */

import { WirebenchError } from '@wirebench/engine';
import type { SearchMatchWire, SearchQueryRequest, SearchQueryResponse } from '../shared/wire-types.js';

/** How much of a matching line is worth sending; longer lines are cut with an ellipsis. */
const MAX_SNIPPET = 200;

/** The default cap on returned matches, when the caller names none. */
const DEFAULT_LIMIT = 200;

/** One searchable text, plus the identity a match in it should carry back to the renderer. */
export interface SearchDocument {
  readonly kind: SearchMatchWire['kind'];
  readonly text: string;
  readonly requestId?: string;
  readonly requestName?: string;
  readonly interfaceId?: string;
  readonly interfaceName?: string;
  readonly location?: string;
}

/** Escapes every regex metacharacter, so a literal query matches itself and nothing else. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiles the query into a global `RegExp`.
 *
 * @throws WirebenchError `invalid-regex` when `regex` is on and the pattern does not compile —
 * a half-typed pattern is normal while the user types, so the view reports it rather than the
 * search failing silently.
 */
export function compileQuery(request: Pick<SearchQueryRequest, 'query' | 'regex' | 'caseSensitive'>): RegExp {
  const source = request.regex ? request.query : escapeRegExp(request.query);
  const flags = request.caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new WirebenchError('invalid-regex', error instanceof Error ? error.message : 'Invalid regular expression', {
      details: { query: request.query },
    });
  }
}

/** The 1-based line and column of `offset`, and that line's bounds. */
function locate(text: string, offset: number): { line: number; column: number; lineStart: number; lineEnd: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  const newline = text.indexOf('\n', lineStart);
  const lineEnd = newline === -1 ? text.length : newline;
  return { line, column: offset - lineStart + 1, lineStart, lineEnd };
}

function snippetOf(text: string, lineStart: number, lineEnd: number): string {
  const line = text.slice(lineStart, lineEnd).trim();
  return line.length > MAX_SNIPPET ? `${line.slice(0, MAX_SNIPPET)}…` : line;
}

/**
 * Every match of `request` across `documents`, in the order the documents were given, capped at
 * `request.limit`.
 *
 * At most one match per line is reported: the Search view's rows are lines, and five hits on one
 * line would be five identical-looking rows that all reveal the same place.
 */
export function searchDocuments(
  documents: readonly SearchDocument[],
  request: SearchQueryRequest,
): SearchQueryResponse {
  const pattern = compileQuery(request);
  const limit = request.limit ?? DEFAULT_LIMIT;
  const matches: SearchMatchWire[] = [];

  for (const document of documents) {
    pattern.lastIndex = 0;
    let lastLine = -1;
    let found: RegExpExecArray | null;
    while ((found = pattern.exec(document.text)) !== null) {
      // A pattern that can match the empty string (`a*`) would never advance on its own.
      if (found[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const { line, column, lineStart, lineEnd } = locate(document.text, found.index);
      if (line === lastLine) {
        continue;
      }
      lastLine = line;
      if (matches.length >= limit) {
        return { matches, truncated: true };
      }
      matches.push({
        kind: document.kind,
        ...(document.requestId !== undefined ? { requestId: document.requestId } : {}),
        ...(document.requestName !== undefined ? { requestName: document.requestName } : {}),
        ...(document.interfaceId !== undefined ? { interfaceId: document.interfaceId } : {}),
        ...(document.interfaceName !== undefined ? { interfaceName: document.interfaceName } : {}),
        ...(document.location !== undefined ? { location: document.location } : {}),
        line,
        column,
        start: found.index,
        end: found.index + found[0].length,
        snippet: snippetOf(document.text, lineStart, lineEnd),
      });
    }
  }

  return { matches, truncated: false };
}
