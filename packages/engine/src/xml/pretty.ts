/**
 * A token-based XML pretty printer. Unlike a DOM round trip, this tolerates
 * slightly malformed input (it never throws) and preserves everything a DOM
 * serializer would normally lose: comments, CDATA sections, processing
 * instructions, the XML declaration, DOCTYPE, attribute order/quoting and
 * entity references.
 */

import { localNameOf, normalizeLineEndings, tokenizeXml, type XmlToken } from './tolerant-tree.js';

/** Options for {@link formatXml}. */
export interface FormatXmlOptions {
  /** Indentation unit per nesting level. Defaults to three spaces. */
  readonly indent?: string;
  /**
   * Element names (local name or `prefix:local`) whose inner content is
   * reproduced verbatim instead of being reformatted — for elements that
   * carry significant whitespace (e.g. `xs:documentation`-like free text).
   */
  readonly preserveWhitespaceIn?: readonly string[];
}

/** Result of {@link formatXml}. */
export interface FormatXmlResult {
  /** The formatted text, or the (line-ending normalised) input unchanged when `problem` is set. */
  readonly text: string;
  /** Whether `text` differs from the (line-ending normalised) input. */
  readonly changed: boolean;
  /** Set, and `text` left unchanged, when the input could not be safely reformatted (e.g. unbalanced tags). */
  readonly problem?: string;
}

type Token = XmlToken;

type TreeNode =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'comment' | 'cdata' | 'pi' | 'doctype'; readonly raw: string }
  | {
      readonly type: 'element';
      readonly name: string;
      readonly rawAttrs: string;
      readonly selfClosing: boolean;
      readonly children: readonly TreeNode[];
      /** Original text between the end of the open tag and the start of the close tag. */
      readonly rawInner: string;
    };

interface OpenFrame {
  readonly name: string;
  readonly rawAttrs: string;
  readonly children: TreeNode[];
  readonly openEnd: number;
}

/** Builds a tree from tokens; returns a `problem` message instead of throwing on unbalanced tags. */
function buildTree(tokens: readonly Token[], text: string): { roots: TreeNode[] } | { problem: string } {
  const roots: TreeNode[] = [];
  const stack: OpenFrame[] = [];
  const currentChildren = (): TreeNode[] => stack[stack.length - 1]?.children ?? roots;

  for (const tok of tokens) {
    switch (tok.kind) {
      case 'text':
        currentChildren().push({ type: 'text', value: tok.raw });
        break;
      case 'comment':
      case 'cdata':
      case 'pi':
      case 'doctype':
        currentChildren().push({ type: tok.kind, raw: tok.raw });
        break;
      case 'open':
        if (tok.selfClosing) {
          currentChildren().push({
            type: 'element',
            name: tok.name as string,
            rawAttrs: tok.rawAttrs ?? '',
            selfClosing: true,
            children: [],
            rawInner: '',
          });
        } else {
          stack.push({ name: tok.name as string, rawAttrs: tok.rawAttrs ?? '', children: [], openEnd: tok.end });
        }
        break;
      case 'close': {
        const top = stack.pop();
        if (top === undefined || top.name !== tok.name) {
          return { problem: `Mismatched closing tag </${tok.name}>` };
        }
        const rawInner = text.slice(top.openEnd, tok.start);
        const node: TreeNode = {
          type: 'element',
          name: top.name,
          rawAttrs: top.rawAttrs,
          selfClosing: false,
          children: top.children,
          rawInner,
        };
        (stack.length > 0 ? (stack[stack.length - 1] as OpenFrame).children : roots).push(node);
        break;
      }
      default:
        break;
    }
  }
  if (stack.length > 0) {
    return { problem: `Unclosed tag <${(stack[stack.length - 1] as OpenFrame).name}>` };
  }
  return { roots };
}

function renderNodes(
  nodes: readonly TreeNode[],
  depth: number,
  indent: string,
  preserve: ReadonlySet<string>,
  out: string[],
): void {
  for (const n of nodes) {
    if (n.type === 'text') {
      if (n.value.trim() === '') {
        continue;
      }
      out.push(indent.repeat(depth) + n.value.trim());
      continue;
    }
    if (n.type === 'element') {
      renderElement(n, depth, indent, preserve, out);
      continue;
    }
    out.push(indent.repeat(depth) + n.raw);
  }
}

function renderElement(
  n: Extract<TreeNode, { type: 'element' }>,
  depth: number,
  indent: string,
  preserve: ReadonlySet<string>,
  out: string[],
): void {
  const pad = indent.repeat(depth);
  const openTag = `<${n.name}${n.rawAttrs !== '' ? ` ${n.rawAttrs}` : ''}`;
  if (n.selfClosing) {
    out.push(`${pad}${openTag}/>`);
    return;
  }
  if (preserve.has(n.name) || preserve.has(localNameOf(n.name))) {
    out.push(`${pad}${openTag}>${n.rawInner}</${n.name}>`);
    return;
  }
  const hasNonWsText = n.children.some((c) => c.type === 'text' && c.value.trim() !== '');
  const hasElementLike = n.children.some((c) => c.type !== 'text');
  if (hasNonWsText && hasElementLike) {
    // Mixed content: leave untouched.
    out.push(`${pad}${openTag}>${n.rawInner}</${n.name}>`);
    return;
  }
  if (!hasElementLike) {
    const text = n.children
      .map((c) => (c.type === 'text' ? c.value : ''))
      .join('')
      .trim();
    out.push(`${pad}${openTag}>${text}</${n.name}>`);
    return;
  }
  out.push(`${pad}${openTag}>`);
  renderNodes(n.children, depth + 1, indent, preserve, out);
  out.push(`${pad}</${n.name}>`);
}

/**
 * Pretty-prints XML text without a DOM round trip. Preserves comments, CDATA,
 * processing instructions, the XML declaration, DOCTYPE, attribute
 * order/quoting and entity references. Collapses whitespace-only text
 * between elements; leaves mixed content (non-whitespace text next to a
 * child element) untouched inside that element; keeps a text-only element on
 * one line. Never throws — on unbalanced tags, returns the input unchanged
 * with `problem` set. Line endings are normalised to `\n`.
 */
export function formatXml(text: string, options?: FormatXmlOptions): FormatXmlResult {
  const indent = options?.indent ?? '   ';
  const preserve = new Set(options?.preserveWhitespaceIn ?? []);
  const normalized = normalizeLineEndings(text);

  const tokens = tokenizeXml(normalized);
  if (tokens === undefined) {
    return { text: normalized, changed: false, problem: 'Malformed markup: could not tokenize' };
  }
  const built = buildTree(tokens, normalized);
  if ('problem' in built) {
    return { text: normalized, changed: false, problem: built.problem };
  }
  const out: string[] = [];
  renderNodes(built.roots, 0, indent, preserve, out);
  const resultText = out.join('\n');
  return { text: resultText, changed: resultText !== normalized };
}
