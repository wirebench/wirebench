/**
 * XPath 3.1 / XQuery 3.1 evaluation against a response document, for the response Query
 * scratchpad. Where classic SOAP workbenches limit querying to XPath 2.0 inside assertions,
 * this runs both languages over the actual bytes the server returned, ahead of any assertion.
 */

import fontoxpathModule from 'fontoxpath';
import type { Node as XmldomNode } from '@xmldom/xmldom';
import { getPosition, parseXml } from '../xml/parse.js';
import { serializeXml } from '../xml/serialize.js';
import { LineIndex } from '../xml/positions.js';
import type { LinePosition } from '../xml/positions.js';
import type { TextRange } from '../xsd/locate.js';

// `fontoxpath` ships as CommonJS; its named exports only land on the default import under
// Node's ESM interop, so every entry point this module needs is re-destructured here once.
const { evaluateXPath, Language } = fontoxpathModule;

/** The result of {@link evaluate} is capped at this many items; a query producing more is
 * still evaluated to completion, but only the first `RESULT_CAP` are returned to the caller,
 * with `truncated: true` so the UI can say so instead of silently hiding the rest. */
const RESULT_CAP = 1_000;

/** One node-shaped query result. */
export interface QueryNodeItem {
  /** The node serialised back to text (an element/comment/PI/document), or an attribute's value. */
  readonly text: string;
  readonly nodeKind: 'element' | 'attribute' | 'text' | 'document' | 'comment' | 'pi';
  /** Offsets of this node in the original `xml` text, when they could be recovered. */
  readonly range?: TextRange;
  /**
   * A simple `/a/b[2]`-shaped path to the node from the document root, with a 1-based index
   * among same-named siblings at every step.
   *
   * Only elements have steps of their own. A text, comment or processing-instruction result is
   * reported at the path of the nearest enclosing element — the place to look for it in the
   * document — and an attribute result appends `/@name` to its owning element's path. A result
   * with no element at or above it (the document node itself) is reported as `/`.
   */
  readonly path: string;
}

/** One atomic-value query result (a string, number, boolean, map, or array). */
export interface QueryValueItem {
  readonly text: string;
  /** A type label: `xs:string`, `xs:integer`, `map`, `array`, … */
  readonly type: string;
}

/** The outcome of running one XPath/XQuery expression against a document. */
export type QueryResult =
  | { readonly kind: 'nodes'; readonly items: readonly QueryNodeItem[]; readonly truncated: boolean }
  | { readonly kind: 'values'; readonly items: readonly QueryValueItem[]; readonly truncated: boolean }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly message: string; readonly code?: string; readonly position?: LinePosition };

/** Options accepted by {@link evaluate}. */
export interface EvaluateOptions {
  readonly language: 'xpath' | 'xquery';
  /** Prefix to namespace URI, used to resolve `prefix:local` names in the expression. */
  readonly namespaces?: Readonly<Record<string, string>>;
}

/** Structural view of an xmldom node sufficient to classify and serialise a query result item,
 * without depending on xmldom's concrete `Node` subclasses (fontoxpath returns plain objects
 * shaped like them, including ones it constructs itself for XQuery node constructors). */
interface EvaluatedNode {
  readonly nodeType: number;
  readonly nodeName?: string;
  readonly nodeValue?: string | null;
  readonly parentNode?: EvaluatedNode | null;
  readonly previousSibling?: EvaluatedNode | null;
  readonly firstChild?: EvaluatedNode | null;
  readonly nextSibling?: EvaluatedNode | null;
}

const NODE_TYPE: Record<number, QueryNodeItem['nodeKind']> = {
  1: 'element',
  2: 'attribute',
  3: 'text',
  7: 'pi',
  8: 'comment',
  9: 'document',
};

/** True when `value` looks like a DOM node (has a numeric `nodeType`), as opposed to an atomic
 * XPath value (string, number, boolean, map, array). Fontoxpath's `ALL_RESULTS_TYPE` mixes both
 * shapes in one array, so every item has to be classified individually. */
function isNode(value: unknown): value is EvaluatedNode {
  return typeof value === 'object' && value !== null && typeof (value as EvaluatedNode).nodeType === 'number';
}

/**
 * Builds `/a/b[2]`-shaped paths for the nodes of one result set.
 *
 * Doing this naively — walking `previousSibling` for every ancestor of every result — is
 * quadratic in the number of siblings, and a 1 MB response is typically one element with tens
 * of thousands of children. Both the per-element positional index (filled a whole sibling list
 * at a time) and the finished path string are cached, so the whole result set costs one pass.
 * Together with the shared `LineIndex` below, that took the budgeted 1 MB query from a median
 * of 353 ms to 145 ms, and `…/p:Row` from 333 ms to 123 ms (see the Task 50 report).
 */
class PathIndex {
  private readonly positions = new Map<EvaluatedNode, number>();
  private readonly paths = new Map<EvaluatedNode, string>();

  /** The path of `node`; attributes are addressed as `@name` on their owning element. */
  path(node: EvaluatedNode): string {
    if (node.nodeType === 2) {
      const owner = (node as unknown as { ownerElement?: EvaluatedNode }).ownerElement ?? undefined;
      const ownerPath = owner === undefined ? '/' : this.elementPath(owner);
      return `${ownerPath}/@${node.nodeName ?? ''}`;
    }
    return this.elementPath(node);
  }

  /**
   * The path of an element — or of the nearest element at or above a non-element node.
   *
   * Iterative on purpose: a deeply nested document (an envelope wrapping thousands of levels)
   * would otherwise overflow the call stack on what is only a walk to the root. Ancestors are
   * collected upwards until a cached path (or the root) is reached, then the path is built back
   * down, caching every ancestor on the way so the next result in the same subtree is free.
   */
  private elementPath(node: EvaluatedNode): string {
    // Non-element nodes (text, comment, PI) have no step of their own: they are reported at the
    // path of their owning element, which is what a user needs to locate them in the document.
    let current: EvaluatedNode | null | undefined = node;
    while (current !== null && current !== undefined && current.nodeType !== 1) {
      current = current.parentNode ?? null;
    }
    if (current === null || current === undefined) {
      return '/';
    }

    const pending: EvaluatedNode[] = [];
    let path: string | undefined;
    let walk: EvaluatedNode | null | undefined = current;
    while (walk !== null && walk !== undefined && walk.nodeType === 1) {
      const cached = this.paths.get(walk);
      if (cached !== undefined) {
        path = cached;
        break;
      }
      pending.push(walk);
      walk = walk.parentNode ?? null;
    }

    let prefix = path ?? '';
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const element = pending[i];
      if (element === undefined) {
        continue;
      }
      prefix = `${prefix}/${element.nodeName ?? '*'}[${this.position(element)}]`;
      this.paths.set(element, prefix);
    }
    return prefix === '' ? '/' : prefix;
  }

  /** The 1-based position of `node` among its same-named element siblings. */
  private position(node: EvaluatedNode): number {
    const cached = this.positions.get(node);
    if (cached !== undefined) {
      return cached;
    }
    const parent = node.parentNode ?? undefined;
    if (parent === undefined || parent === null) {
      this.positions.set(node, 1);
      return 1;
    }
    // Index the entire sibling list in one forward pass: the next result node under the same
    // parent — the common case for a query over a list — then costs nothing.
    const counts = new Map<string, number>();
    let child: EvaluatedNode | null | undefined = parent.firstChild ?? null;
    while (child !== null && child !== undefined) {
      if (child.nodeType === 1) {
        const name = child.nodeName ?? '*';
        const next = (counts.get(name) ?? 0) + 1;
        counts.set(name, next);
        this.positions.set(child, next);
      }
      child = child.nextSibling ?? null;
    }
    return this.positions.get(node) ?? 1;
  }
}

/** Best-effort text range for a node: available whenever xmldom recorded a source position for
 * it (i.e. it was parsed, not constructed by an XQuery node constructor). The end offset is
 * approximated from the serialised length, so it can drift on nodes containing entity
 * references or non-canonical whitespace; callers treat it as advisory ("Reveal" selection),
 * not as an exact byte-for-byte span. */
function rangeOf(node: EvaluatedNode, lineIndex: LineIndex, serialized: string): TextRange | undefined {
  const position = getPosition(node as unknown as XmldomNode);
  if (position === undefined) {
    return undefined;
  }
  const start = lineIndex.positionToOffset(position.line, position.column);
  return { start, end: start + serialized.length };
}

/** Renders one node-shaped result item. */
function toNodeItem(node: EvaluatedNode, lineIndex: LineIndex, paths: PathIndex): QueryNodeItem {
  const kind = NODE_TYPE[node.nodeType] ?? 'element';
  if (node.nodeType === 2) {
    const text = node.nodeValue ?? '';
    return { text, nodeKind: 'attribute', path: paths.path(node) };
  }
  if (node.nodeType === 3) {
    const text = node.nodeValue ?? '';
    return { text, nodeKind: 'text', path: paths.path(node), ...withRange(node, lineIndex, text) };
  }
  const text = serializeXml(node as unknown as XmldomNode);
  return { text, nodeKind: kind, path: paths.path(node), ...withRange(node, lineIndex, text) };
}

/** Spreads `{range}` in only when one could be computed, keeping `exactOptionalPropertyTypes` happy. */
function withRange(node: EvaluatedNode, lineIndex: LineIndex, serialized: string): { range?: TextRange } {
  const range = rangeOf(node, lineIndex, serialized);
  return range === undefined ? {} : { range };
}

/** A type label for an atomic XPath 3.1 value: maps and arrays are structural, everything else
 * is reported by its JavaScript runtime type (fontoxpath does not expose the XML Schema type a
 * value was cast from once it has been atomised, so this is a best-effort approximation). */
function typeOf(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'xs:integer' : 'xs:double';
  }
  if (typeof value === 'boolean') {
    return 'xs:boolean';
  }
  if (typeof value === 'string') {
    return 'xs:string';
  }
  if (typeof value === 'object' && value !== null) {
    return 'map';
  }
  /* v8 ignore next -- no fontoxpath item observed to be untyped-atomic under ALL_RESULTS_TYPE */
  return 'xs:untypedAtomic';
}

/** Renders one atomic value as the Query view shows it: JSON for structures, plain text otherwise. */
function toValueText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  /* v8 ignore next 3 -- fontoxpath's own xs:dateTime/xs:date values are not JS `Date` instances */
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Reads the `{line, column}` fontoxpath attaches to a parse/evaluation error, when present. */
function positionOf(error: unknown): LinePosition | undefined {
  const start = (error as { position?: { start?: { line?: number; ga?: number; offset?: number } } }).position?.start;
  if (start === undefined || start.line === undefined) {
    return undefined;
  }
  const column = start.ga ?? (start.offset !== undefined ? start.offset + 1 : undefined);
  return column === undefined ? undefined : { line: start.line, column };
}

/** Extracts the stable error code fontoxpath prefixes onto most of its messages, e.g. `XPST0003`. */
function codeOf(message: string): string | undefined {
  const match = /\b([A-Z]{4}\d{4})\b/.exec(message);
  return match?.[1];
}

/**
 * Evaluates an XPath 3.1 or XQuery 3.1 `expression` against `xml`.
 *
 * Never throws: parse failures, unresolved namespace prefixes, and runtime errors are all
 * reported as `{kind: 'error'}` results instead, since a scratchpad query is expected to be
 * wrong sometimes and the caller (the Query view) needs a value to render either way.
 *
 * @param xml the document to query (typically a response envelope)
 * @param expression the XPath or XQuery source
 * @param options language and namespace bindings
 */
export function evaluate(xml: string, expression: string, options: EvaluateOptions): QueryResult {
  let doc;
  try {
    doc = parseXml(xml);
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }

  const namespaces = options.namespaces ?? {};
  const namespaceResolver = (prefix: string): string | null => {
    if (prefix === '') {
      return namespaces[''] ?? null;
    }
    return namespaces[prefix] ?? null;
  };

  let raw: unknown[];
  try {
    raw = evaluateXPath(expression, doc, null, null, evaluateXPath.ALL_RESULTS_TYPE, {
      language: options.language === 'xquery' ? Language.XQUERY_3_1_LANGUAGE : Language.XPATH_3_1_LANGUAGE,
      namespaceResolver,
    }) as unknown[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = codeOf(message);
    const position = positionOf(error);
    const result: QueryResult = {
      kind: 'error',
      message,
      ...(code !== undefined ? { code } : {}),
      ...(position !== undefined ? { position } : {}),
    };
    return result;
  }

  if (raw.length === 0) {
    return { kind: 'empty' };
  }

  const truncated = raw.length > RESULT_CAP;
  const capped = raw.slice(0, RESULT_CAP);
  const nodeLike = capped.filter(isNode);

  // A query result is treated as "nodes" when every item is node-shaped; a mix (which XPath
  // itself never produces from a single path expression, but a hand-written FLWOR could)
  // falls back to "values" so nothing is silently dropped.
  if (nodeLike.length === capped.length) {
    // One `LineIndex` for the whole result set: `rangeOf` used to re-split the source document
    // per item, which on a 1 MB response cost more than the XPath evaluation itself.
    const lineIndex = new LineIndex(xml);
    const paths = new PathIndex();
    return {
      kind: 'nodes',
      items: capped.map((item) => toNodeItem(item as EvaluatedNode, lineIndex, paths)),
      truncated,
    };
  }

  return {
    kind: 'values',
    items: capped.map((item) => ({ text: toValueText(item), type: typeOf(item) })),
    truncated,
  };
}
