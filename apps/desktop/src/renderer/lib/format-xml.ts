/**
 * A deliberately small XML pretty-printer: it re-indents markup and changes nothing else.
 *
 * The engine gains a real, schema-aware formatter in Task 25; until then the response pane
 * needs something that can make a server's single-line envelope readable without ever
 * corrupting it. So this is a tokenizer plus a shallow tree, not a parser: it never rewrites
 * text, entities, attributes, CDATA, or processing instructions, and it bails out (returning
 * the input verbatim) the moment the tag nesting does not balance.
 */

const DEFAULT_INDENT = 3;

/** Options for {@link formatXml}. */
export interface FormatXmlOptions {
  /** Spaces per nesting level. Defaults to 3, matching the request editor's `tabSize`. */
  readonly indent?: number;
}

type TokenKind = 'open' | 'close' | 'selfClose' | 'comment' | 'cdata' | 'meta' | 'text';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

/** One element with its children, or a single leaf token. Internal and mutable while building. */
interface Node {
  readonly token: Token;
  /** Present only for `open` tokens: the children and the matching `</…>`. */
  readonly children?: Node[];
  closeText?: string;
}

/** Matches one markup construct: CDATA, comment, PI/declaration/doctype, or an element tag. */
const TOKEN_PATTERN = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[!?][\s\S]*?>|<\/?[^<>]*>/g;

function classify(markup: string): TokenKind {
  if (markup.startsWith('<![CDATA[')) {
    return 'cdata';
  }
  if (markup.startsWith('<!--')) {
    return 'comment';
  }
  if (markup.startsWith('<!') || markup.startsWith('<?')) {
    return 'meta';
  }
  if (markup.startsWith('</')) {
    return 'close';
  }
  return markup.endsWith('/>') ? 'selfClose' : 'open';
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  TOKEN_PATTERN.lastIndex = 0;

  let match = TOKEN_PATTERN.exec(xml);
  while (match !== null) {
    const markup = match[0];
    if (match.index > cursor) {
      tokens.push({ kind: 'text', text: xml.slice(cursor, match.index) });
    }
    tokens.push({ kind: classify(markup), text: markup });
    cursor = match.index + markup.length;
    match = TOKEN_PATTERN.exec(xml);
  }

  if (cursor < xml.length) {
    tokens.push({ kind: 'text', text: xml.slice(cursor) });
  }
  return tokens;
}

/** Builds the node tree, or `undefined` when an `open`/`close` pair does not balance. */
function buildTree(tokens: readonly Token[]): Node[] | undefined {
  const root: Node[] = [];
  const stack: Node[] = [];

  const currentChildren = (): Node[] => stack.at(-1)?.children ?? root;

  for (const token of tokens) {
    if (token.kind === 'open') {
      const node: Node = { token, children: [], closeText: '' };
      currentChildren().push(node);
      stack.push(node);
      continue;
    }
    if (token.kind === 'close') {
      const open = stack.pop();
      if (open === undefined) {
        return undefined;
      }
      open.closeText = token.text;
      continue;
    }
    currentChildren().push({ token });
  }

  return stack.length === 0 ? root : undefined;
}

/** The original source of a node and everything under it, byte for byte. */
function flatten(node: Node): string {
  if (node.children === undefined) {
    return node.token.text;
  }
  return `${node.token.text}${node.children.map(flatten).join('')}${node.closeText ?? ''}`;
}

/**
 * True when an element carries character content directly (text or CDATA). Such an element is
 * mixed or text content, and breaking it across lines would change what the document says.
 */
function hasCharacterContent(node: Node): boolean {
  return (node.children ?? []).some(
    (child) => child.token.kind === 'cdata' || (child.token.kind === 'text' && child.token.text.trim().length > 0),
  );
}

function render(nodes: readonly Node[], depth: number, width: number, out: string[]): void {
  const pad = ' '.repeat(depth * width);

  for (const node of nodes) {
    if (node.token.kind === 'text' && node.token.text.trim().length === 0) {
      // Whitespace between tags is layout, not content: drop it and re-derive indentation.
      continue;
    }
    if (node.children === undefined || hasCharacterContent(node)) {
      out.push(`${pad}${flatten(node)}`);
      continue;
    }
    if (node.children.length === 0) {
      out.push(`${pad}${node.token.text}${node.closeText ?? ''}`);
      continue;
    }
    out.push(`${pad}${node.token.text}`);
    render(node.children, depth + 1, width, out);
    out.push(`${pad}${node.closeText ?? ''}`);
  }
}

/**
 * Re-indents `xml`, preserving every character of its text, attributes, and CDATA.
 * Returns the input unchanged when it contains no markup or its tags do not balance.
 */
export function formatXml(xml: string, options: FormatXmlOptions = {}): string {
  const tokens = tokenize(xml);
  if (!tokens.some((token) => token.kind !== 'text')) {
    return xml;
  }
  const tree = buildTree(tokens);
  if (tree === undefined) {
    return xml;
  }

  const lines: string[] = [];
  render(tree, 0, options.indent ?? DEFAULT_INDENT, lines);
  return lines.join('\n');
}
