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

/**
 * How long the whole scan may run before it gives up and reports `truncated: 'timeout'`.
 *
 * The query is a user-authored regular expression run by V8's backtracking engine, so its cost
 * is not bounded by the corpus size: `(a+)+$` over a few kilobytes can run for the age of the
 * universe. {@link REJECTED_PATTERNS} turns away the textbook shapes, but no static check
 * catches them all — this wall clock is what actually guarantees the channel answers.
 */
const TIME_BUDGET_MS = 200;

/** How often the budget is checked: often enough to be responsive, rarely enough to be free. */
const BUDGET_CHECK_INTERVAL = 64;

/** The longest pattern worth accepting; past this a regex is a denial of service, not a query. */
const MAX_PATTERN_LENGTH = 200;

/**
 * Quantified groups that are themselves quantified — `(a+)+`, `(a*)*`, `(a+)*`, `(\d+)+` — the
 * classic catastrophic-backtracking shape. Rejected with a clear message rather than left to
 * the time budget, so the user learns what is wrong with their pattern.
 */
const REJECTED_PATTERNS = /\([^)]*[+*]\)\s*[+*]/;

/** One searchable text, plus the identity a match in it should carry back to the renderer. */
export interface SearchDocument {
  readonly kind: SearchMatchWire['kind'];
  readonly text: string;
  /** Which project of the open workspace the text came from, and its display name. */
  readonly projectId?: string;
  readonly projectName?: string;
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
  if (request.regex) {
    if (request.query.length > MAX_PATTERN_LENGTH) {
      throw new WirebenchError(
        'invalid-regex',
        `Pattern is too long (${String(request.query.length)} characters; the limit is ${String(MAX_PATTERN_LENGTH)}).`,
        { details: { query: request.query.slice(0, MAX_PATTERN_LENGTH) } },
      );
    }
    if (REJECTED_PATTERNS.test(request.query)) {
      throw new WirebenchError(
        'invalid-regex',
        'Nested quantifiers such as (x+)+ can take unbounded time to match; rewrite the pattern without them.',
        { details: { query: request.query } },
      );
    }
  }
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

/** Where a match sits: 1-based line and column, plus the bounds of the line holding it. */
interface Placement {
  readonly line: number;
  readonly column: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/**
 * A single forward pass over one document that places each match in turn.
 *
 * Matches arrive in increasing offset order, so the line counter only ever moves forward:
 * placing every match in a document costs one scan of it, not one scan per match (which made
 * a many-hit search quadratic in the document's size).
 */
class LineCursor {
  private line = 1;
  private lineStart = 0;
  private scanned = 0;

  constructor(private readonly text: string) {}

  /** Places `offset`. Offsets must not go backwards; the caller walks matches in order. */
  locate(offset: number): Placement {
    for (let i = this.scanned; i < offset; i += 1) {
      if (this.text[i] === '\n') {
        this.line += 1;
        this.lineStart = i + 1;
      }
    }
    this.scanned = Math.max(this.scanned, offset);
    const newline = this.text.indexOf('\n', this.lineStart);
    const lineEnd = newline === -1 ? this.text.length : newline;
    return { line: this.line, column: offset - this.lineStart + 1, lineStart: this.lineStart, lineEnd };
  }
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
 *
 * The scan is bounded by {@link TIME_BUDGET_MS} of wall clock: a user regex can be arbitrarily
 * expensive, and an IPC handler that never answers is worse than an incomplete answer.
 *
 * @param clock - Injectable millisecond clock, so the budget can be asserted on deterministically.
 */
export function searchDocuments(
  documents: readonly SearchDocument[],
  request: SearchQueryRequest,
  clock: () => number = Date.now,
): SearchQueryResponse {
  const now = clock;
  const pattern = compileQuery(request);
  const limit = request.limit ?? DEFAULT_LIMIT;
  const matches: SearchMatchWire[] = [];
  const deadline = now() + TIME_BUDGET_MS;
  let sinceCheck = 0;

  for (const document of documents) {
    pattern.lastIndex = 0;
    const cursor = new LineCursor(document.text);
    let lastLine = -1;
    let found: RegExpExecArray | null;
    // The budget is checked between `exec` calls, so a scan is chunked at match granularity.
    // One `exec` can still overrun it — V8 gives no way to interrupt a match in progress — so
    // REJECTED_PATTERNS turns away the shapes where a single call is the whole problem.
    if (now() >= deadline) {
      return { matches, truncated: true, reason: 'timeout' };
    }
    while ((found = pattern.exec(document.text)) !== null) {
      sinceCheck += 1;
      if (sinceCheck >= BUDGET_CHECK_INTERVAL) {
        sinceCheck = 0;
        if (now() >= deadline) {
          return { matches, truncated: true, reason: 'timeout' };
        }
      }
      // A pattern that can match the empty string (`a*`) would never advance on its own.
      if (found[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      const { line, column, lineStart, lineEnd } = cursor.locate(found.index);
      if (line === lastLine) {
        continue;
      }
      lastLine = line;
      if (matches.length >= limit) {
        return { matches, truncated: true, reason: 'limit' };
      }
      matches.push({
        kind: document.kind,
        ...(document.projectId !== undefined ? { projectId: document.projectId } : {}),
        ...(document.projectName !== undefined ? { projectName: document.projectName } : {}),
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
