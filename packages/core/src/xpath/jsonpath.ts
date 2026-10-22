/**
 * JSONPath evaluation against a JSON response body, for the response Query view's third language.
 *
 * It lives beside the XPath evaluators, not under `rest/`, for two reasons: JSONPath is a query
 * language for JSON rather than anything REST-specific, and `rest/` carries the browser-safe subpath
 * export (`@wirebench/engine/rest`) that the renderer imports — a Node-only dependency must not be
 * reachable from there, for the same reason `fontoxpath` is not.
 *
 * XPath 3.1 already queries JSON (`xpath/evaluate.ts`'s `evaluateJson`), and it is the more capable
 * of the two. JSONPath is here because it is the syntax REST users already have in their heads and
 * in their notes — `$.items[?(@.status=="open")].id` is what a person pastes in from a README — and
 * asking them to translate it into `?items?*[?status = "open"]?id` before they can check one field
 * is friction with no payoff. Both languages stay available side by side.
 *
 * The result shape is identical to the XPath evaluators' {@link QueryResult}, so the Query view
 * renders all three languages through one code path. JSONPath yields **values**, never nodes — JSON
 * has none — and each item carries the normalised path it was found at, which is what makes a
 * multi-match result readable.
 *
 * Filter and script expressions run under `eval: 'safe'`, which is load-bearing rather than a
 * default worth inheriting silently. `jsonpath-plus` can evaluate `?(...)` and `(...)` with the
 * platform's real `eval`/`Function`, or with a `jsep` expression parser that has no access to the
 * host; `'safe'` selects the parser. So `$..book[?(@.price<10)]` works, and nothing reachable from a
 * *response body* can execute. The expression is the user's own; the data it walks is whatever
 * server answered, and that data never gets to run. (`eval: false` was the first thing tried and is
 * wrong here: it does not harden the filter, it removes it — `?(...)` is refused outright, which
 * takes most of JSONPath's usefulness with it.)
 */

import { JSONPath } from 'jsonpath-plus';
import type { QueryResult, QueryValueItem } from './evaluate.js';

/** Result cap, matching `xpath/evaluate.ts`: a bigger result set is evaluated but reported
 * truncated, so the UI can say so instead of silently hiding the rest. */
const RESULT_CAP = 1_000;

/** One `resultType: 'all'` item, as `jsonpath-plus` returns it. */
interface JsonPathMatch {
  readonly value: unknown;
  /** The normalised path, e.g. `$['store']['book'][0]['title']`. */
  readonly path: string;
}

/** A type label for a JSON value, in JSON's own vocabulary rather than XML Schema's — a JSONPath
 * user is thinking in `object`/`array`/`string`, not `xs:string`. */
function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  const type = typeof value;
  return type === 'object' ? 'object' : type;
}

/** Renders one match as the Query view shows it: a string as itself, anything structural as JSON.
 *
 * Every branch is a JSON value, so the cases are closed: string, number, boolean, null, and the two
 * structural kinds. `undefined` is not a JSON value but `JSONPath` can hand one back for a path that
 * walked off the end of an object, so it gets a branch rather than becoming `"undefined"` by
 * accident. */
function toValueText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify(value);
}

/**
 * Evaluates a JSONPath `expression` against a JSON document.
 *
 * Never throws: a malformed document and a malformed expression are both reported as
 * `{kind: 'error'}`, the same as the XPath evaluators, because a scratchpad query is expected to be
 * wrong sometimes and the caller needs a value to render either way.
 *
 * @param json the response body as text
 * @param expression the JSONPath source, e.g. `$.items[?(@.status=="open")].id`
 */
export function evaluateJsonPath(json: string, expression: string): QueryResult {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  let matches: readonly JsonPathMatch[];
  try {
    // `resultType: 'all'` is what carries each match's normalised path alongside its value; `wrap`
    // keeps the return an array even for a single match, so there is one shape to handle.
    matches = JSONPath({
      path: expression,
      json: document as never,
      resultType: 'all',
      wrap: true,
      eval: 'safe',
    });
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  if (matches.length === 0) {
    return { kind: 'empty' };
  }
  const truncated = matches.length > RESULT_CAP;
  const items: QueryValueItem[] = matches.slice(0, RESULT_CAP).map((match) => ({
    text: toValueText(match.value),
    type: typeOf(match.value),
    path: match.path,
  }));
  return { kind: 'values', items, truncated };
}
