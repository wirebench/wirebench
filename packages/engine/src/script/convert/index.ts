/**
 * Converts a level's imported scripts to `wirebench` scripts (spec §5). Each script is parsed as
 * JavaScript; every reference to one of its dialect's roots is answered by the mapping table (the
 * {@link Matcher}) and spliced in place. A reference with no answer, or one the layer refuses, leaves
 * its innermost statement commented out under a TODO. Nothing else in the file changes.
 */
import type ts from 'typescript';
import { unsupportedCall, UNSUPPORTED_CALLS } from '../../import/scripts.js';
import type { LayeredApi, ScriptPhase } from '../model.js';
import {
  declaredNames,
  DIALECT_ROOTS,
  referenceAt,
  type ConvertContext,
  type ConvertProtocol,
  type DialectRef,
  type Matcher,
} from './roots.js';
import { applyEdits, commentOut, lineEndingAt, type Edit } from './splice.js';
import { headerComment, NOT_CONVERTED, shadowedReason, todoComment, type ConvertTodo } from './todo.js';
import { typescript } from './typescript.js';

export type { ConvertProtocol, ConvertContext, DialectRef, Matcher, Replacement } from './roots.js';
export type { ConvertTodo } from './todo.js';

export type ConvertedLevel =
  | {
      readonly ok: true;
      readonly pre?: string;
      readonly post?: string;
      readonly todos: readonly ConvertTodo[];
      /** How many replacements the converted scripts hold. */
      readonly mapped: number;
    }
  | { readonly ok: false; readonly phase: ScriptPhase; readonly line: number; readonly message: string };

/** One script converted, or the syntax error that stops it. */
export type ConvertedScript =
  | { readonly ok: true; readonly text: string; readonly todos: readonly ConvertTodo[]; readonly mapped: number }
  | { readonly ok: false; readonly line: number; readonly message: string };

/** The mapping table before it has rows: nothing is replaced. */
const matchNothing: Matcher = () => undefined;

/** A level's pre and post scripts converted; a phase with no script has no file. */
export function convertLevelScripts(input: {
  readonly dialect: LayeredApi;
  readonly protocol: ConvertProtocol;
  readonly pre?: string;
  readonly post?: string;
  /** The backup path per phase, for the header line (spec §5.3). */
  readonly backups: { readonly pre?: string; readonly post?: string };
}): ConvertedLevel {
  const out: { pre?: string; post?: string } = {};
  const todos: ConvertTodo[] = [];
  let mapped = 0;
  for (const phase of ['pre', 'post'] as const) {
    const text = input[phase];
    if (text === undefined) continue;
    const backup = input.backups[phase];
    const result = convertScript({
      dialect: input.dialect,
      protocol: input.protocol,
      phase,
      text,
      ...(backup !== undefined ? { backup } : {}),
    });
    if (!result.ok) return { ok: false, phase, line: result.line, message: result.message };
    out[phase] = result.text;
    todos.push(...result.todos);
    mapped += result.mapped;
  }
  return { ok: true, ...out, todos, mapped };
}

/** A call left as written: what the TODO says and the node whose statement is commented out. */
interface Unconverted {
  readonly node: ts.Node;
  readonly call: string;
  readonly kind: 'unsupported' | 'not-mapped';
  readonly reason: string;
}

/** One script converted with `matcher` answering each reference. */
export function convertScript(
  input: {
    readonly dialect: LayeredApi;
    readonly protocol: ConvertProtocol;
    readonly phase: ScriptPhase;
    readonly text: string;
    readonly backup?: string;
  },
  matcher: Matcher = matchNothing,
): ConvertedScript {
  const ts = typescript();
  const { dialect, protocol, phase, text } = input;
  const source = ts.createSourceFile(`script.${phase}.js`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  // The parser's own diagnostics: what createSourceFile found, before any program or type check.
  const syntax = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
    .parseDiagnostics?.[0];
  if (syntax !== undefined) {
    return {
      ok: false,
      line: source.getLineAndCharacterOfPosition(syntax.start).line + 1,
      message: ts.flattenDiagnosticMessageText(syntax.messageText, '\n'),
    };
  }

  const declared = declaredNames(source);
  const shadowed = DIALECT_ROOTS[dialect].filter((root) => declared.has(root));
  const heads = new Set(
    [...DIALECT_ROOTS[dialect], ...unsupportedHeads(dialect)].filter((name) => !declared.has(name)),
  );

  // Every reference, outermost first, and every top-level import the layer refuses.
  const refs: DialectRef[] = [];
  const imports: Unconverted[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && heads.has(node.text)) {
      const ref = referenceAt(node);
      if (ref !== undefined) refs.push(ref);
    } else if (ts.isImportDeclaration(node)) {
      const refused = unsupportedCall(node.getText(source), dialect);
      if (refused !== undefined)
        imports.push({ node, call: refused.name, kind: 'unsupported', reason: refused.reason });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // First pass: which references are left as written. The matcher is asked with the original text
  // of any node it builds from; the second pass asks again with the converted text.
  const probe: ConvertContext = { dialect, phase, protocol, source, text: (node) => node.getText(source) };
  const unconverted: Unconverted[] = [...imports];
  for (const ref of refs) {
    const left = leftAsWritten(ref, dialect, probe, matcher);
    if (left !== undefined) unconverted.push(left);
  }

  // The statements to comment out, each with its TODO lines; a statement inside another is dropped.
  const groups = new Map<ts.Statement, Unconverted[]>();
  for (const left of unconverted) {
    const statement = statementOf(left.node);
    const group = groups.get(statement) ?? [];
    if (!group.some((other) => other.call === left.call && other.kind === left.kind)) group.push(left);
    groups.set(statement, group);
  }
  const commented = [...groups.keys()]
    .filter((statement) => !hasAncestorIn(statement, groups))
    .sort((a, b) => a.getStart(source) - b.getStart(source));
  const insideCommented = (node: ts.Node): boolean => hasAncestorIn(node, groups) || groups.has(node as ts.Statement);

  // Each TODO line carries a marker until the end, where its line number is read and it is removed.
  const marker = markerFor(text);
  const todos: Omit<ConvertTodo, 'line'>[] = [];
  const todoLines = (statement: ts.Statement): string[] =>
    (groups.get(statement) ?? [])
      .sort((a, b) => a.node.getStart(source) - b.node.getStart(source))
      .map(({ call, kind, reason }) => {
        todos.push({ phase, call, kind, reason });
        return `${marker(todos.length - 1)}${todoComment(call, reason)}`;
      });

  // Second pass: render a span with its commented statements and its replacements.
  const replaced = new Set<ts.Node>();
  const render = (from: number, to: number): string => {
    type Item = { readonly start: number; readonly statement?: ts.Statement; readonly ref?: DialectRef };
    const items = [
      ...commented.map((statement): Item => ({ start: statement.getStart(source), statement })),
      ...refs
        .filter((ref) => !insideCommented(ref.node))
        .map((ref): Item => ({ start: ref.node.getStart(source), ref })),
    ]
      .filter((item) => item.start >= from && item.start < to)
      .sort((a, b) => a.start - b.start || (a.statement !== undefined ? -1 : 1));
    const edits: Edit[] = [];
    let cursor = from;
    for (const item of items) {
      if (item.start < cursor) continue;
      if (item.statement !== undefined) {
        if (item.statement.end > to) continue;
        const range = { from, to };
        const edit = commentOut(
          text,
          item.statement.getStart(source),
          item.statement.end,
          range,
          todoLines(item.statement),
        );
        edits.push(edit);
        cursor = edit.end;
      } else if (item.ref !== undefined) {
        const replacement = matcher(item.ref, context);
        if (replacement === undefined) continue;
        const start = replacement.node.getStart(source);
        if (start < cursor || replacement.node.end > to) continue;
        edits.push({ start, end: replacement.node.end, text: replacement.text });
        replaced.add(item.ref.node);
        cursor = replacement.node.end;
      }
    }
    return applyEdits(
      text.slice(from, to),
      edits.map((edit) => ({ ...edit, start: edit.start - from, end: edit.end - from })),
    );
  };
  const context: ConvertContext = {
    dialect,
    phase,
    protocol,
    source,
    text: (node) => render(node.getStart(source), node.end),
  };
  const body = render(0, text.length);

  // The header, then one TODO per shadowed root, then the script.
  const eol = lineEndingAt(text, 0);
  const top = [
    headerComment(dialect, input.backup),
    ...shadowed.map((root) => {
      todos.push({ phase, call: root, kind: 'shadowed', reason: shadowedReason(root) });
      return `${marker(todos.length - 1)}${todoComment(root, shadowedReason(root))}`;
    }),
  ];
  const converted = top.map((line) => line + eol).join('') + body;

  const lines = new Map<number, number>();
  let line = 1;
  const pattern = new RegExp(`${marker.prefix}(\\d+)${marker.suffix}|\\r\\n|\\n|\\r`, 'g');
  const clean = converted.replace(pattern, (found, index: string | undefined) => {
    if (index === undefined) {
      line += 1;
      return found;
    }
    lines.set(Number(index), line);
    return '';
  });
  return {
    ok: true,
    text: clean,
    todos: todos
      .map((todo, index) => ({ ...todo, line: lines.get(index) ?? 0 }))
      .filter((todo) => todo.line > 0)
      .sort((a, b) => a.line - b.line),
    mapped: replaced.size,
  };
}

/** Why `ref` is left as written, or undefined when the matcher replaces it. */
function leftAsWritten(
  ref: DialectRef,
  dialect: LayeredApi,
  context: ConvertContext,
  matcher: Matcher,
): Unconverted | undefined {
  const refused = unsupportedCall(callForm(ref, context.source), dialect);
  if (refused !== undefined) return { node: ref.node, call: refused.name, kind: 'unsupported', reason: refused.reason };
  if (matcher(ref, context) !== undefined) return undefined;
  return { node: ref.node, call: ref.name, kind: 'not-mapped', reason: NOT_CONVERTED };
}

/**
 * The reference written out alone for the unsupported list's patterns: the chain, and for a call
 * its first argument when that is a string (`require('thunder-tests/a')`) or `x` for any other.
 */
function callForm(ref: DialectRef, source: ts.SourceFile): string {
  const ts = typescript();
  if (ref.call === undefined) return ref.name;
  const first = ref.call.arguments[0];
  if (first === undefined) return `${ref.name}()`;
  return ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)
    ? `${ref.name}(${first.getText(source)})`
    : `${ref.name}(x)`;
}

/** The globals besides the roots that the unsupported list names, such as `require` and `assert`. */
function unsupportedHeads(dialect: LayeredApi): string[] {
  return UNSUPPORTED_CALLS[dialect].flatMap(([, name]) => /^[A-Za-z_$][\w$]*/.exec(name)?.[0] ?? []);
}

/** The innermost statement holding `node` that sits in a statement list (a file, block or case). */
function statementOf(node: ts.Node): ts.Statement {
  const ts = typescript();
  let at = node;
  while (
    !ts.isSourceFile(at.parent) &&
    !ts.isBlock(at.parent) &&
    !ts.isModuleBlock(at.parent) &&
    !ts.isCaseClause(at.parent) &&
    !ts.isDefaultClause(at.parent)
  ) {
    at = at.parent;
  }
  return at as ts.Statement;
}

function hasAncestorIn(node: ts.Node, statements: ReadonlyMap<ts.Statement, unknown>): boolean {
  for (let up = node.parent as ts.Node | undefined; up !== undefined; up = up.parent) {
    if (statements.has(up as ts.Statement)) return true;
  }
  return false;
}

/** A marker that cannot occur in `text`: a private-use character, an index, and the character again. */
function markerFor(text: string): ((index: number) => string) & { prefix: string; suffix: string } {
  let code = 0xe000;
  while (text.includes(String.fromCharCode(code))) code += 1;
  const char = String.fromCharCode(code);
  return Object.assign((index: number) => `${char}${String(index)}${char}`, { prefix: char, suffix: char });
}
