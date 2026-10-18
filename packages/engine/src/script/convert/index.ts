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
import { matchMappings } from './match.js';
import { applyEdits, commentOut, lineEndingAt, wrapCommentedOut, type Edit } from './splice.js';
import { headerComment, NOT_CONVERTED, shadowedReason, todoComment, type ConvertTodo } from './todo.js';
import { typescript } from './typescript.js';

export type { ConvertProtocol, ConvertContext, DialectRef, Matcher, Refusal, Replacement } from './roots.js';
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
  matcher: Matcher = matchMappings,
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

  // First pass: decide each reference. A reference the layer refuses, or one the matcher has no
  // answer for, is left as written. A replacement decides every reference inside its node: the ones
  // inside a node it hands to `context.text` are decided in turn, and the rest are part of what it
  // replaced (`CryptoJS.enc.Base64` in a mapped `CryptoJS.SHA256(a).toString(CryptoJS.enc.Base64)`).
  const decided = new Map<ts.Node, ts.Node>();
  const unconverted = new Map<ts.Node, Unconverted>(imports.map((left) => [left.node, left]));
  const probeSpan = (from: number, to: number): void => {
    let cursor = from;
    for (const ref of refs) {
      const start = ref.node.getStart(source);
      if (start < from || start >= to || start < cursor) continue;
      const refused = unsupportedCall(callForm(ref, source), dialect);
      if (refused !== undefined) {
        unconverted.set(ref.node, { node: ref.node, call: refused.name, kind: 'unsupported', reason: refused.reason });
        continue;
      }
      const handed: ts.Node[] = [];
      const probe: ConvertContext = {
        dialect,
        phase,
        protocol,
        source,
        text: (node) => {
          handed.push(node);
          probeSpan(node.getStart(source), node.end);
          return node.getText(source);
        },
      };
      const replacement = matcher(ref, probe);
      if (replacement === undefined) {
        unconverted.set(ref.node, { node: ref.node, call: ref.name, kind: 'not-mapped', reason: NOT_CONVERTED });
        continue;
      }
      if ('refused' in replacement) {
        const kind = replacement.kind ?? 'unsupported';
        unconverted.set(ref.node, { node: ref.node, call: ref.name, kind, reason: replacement.refused });
        continue;
      }
      checkReplacement(ref, replacement.node, handed, { from: cursor, to }, refs, dialect, source);
      decided.set(ref.node, replacement.node);
      cursor = replacement.node.end;
    }
  };
  probeSpan(0, text.length);

  // The statements to comment out, each with its TODO lines; a statement inside another is dropped.
  const groups = new Map<ts.Statement, Unconverted[]>();
  for (const left of unconverted.values()) {
    const statement = statementOf(left.node);
    const group = groups.get(statement) ?? [];
    if (!group.some((other) => other.call === left.call && other.kind === left.kind)) group.push(left);
    groups.set(statement, group);
  }
  const commented = [...groups.keys()]
    .filter((statement) => !hasAncestorIn(statement, groups))
    .sort((a, b) => a.getStart(source) - b.getStart(source));
  const insideCommented = (node: ts.Node): boolean => hasAncestorIn(node, groups);

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

  // Second pass: render a span with its commented statements and the decided replacements.
  const replaced = new Set<ts.Node>();
  const rendered = new Set<ts.Statement>();
  const render = (from: number, to: number): string => {
    type Item = { readonly start: number; readonly statement?: ts.Statement; readonly ref?: DialectRef };
    const items = [
      ...commented.map((statement): Item => ({ start: statement.getStart(source), statement })),
      ...refs
        .filter((ref) => decided.has(ref.node) && !insideCommented(ref.node))
        .map((ref): Item => ({ start: ref.node.getStart(source), ref })),
    ]
      .filter((item) => item.start >= from && item.start < to)
      .sort((a, b) => a.start - b.start || (a.statement !== undefined ? -1 : 1));
    const edits: Edit[] = [];
    let cursor = from;
    for (const item of items) {
      if (item.start < cursor) continue;
      if (item.statement !== undefined) {
        const statement = item.statement;
        if (statement.end > to) continue;
        const range = { from, to };
        const edit = inStatementList(statement)
          ? commentOut(text, statement.getStart(source), statement.end, range, todoLines(statement))
          : wrapCommentedOut(
              text,
              statement.pos,
              statement.getStart(source),
              statement.end,
              range,
              todoLines(statement),
            );
        edits.push(edit);
        rendered.add(statement);
        cursor = edit.end;
      } else if (item.ref !== undefined) {
        const replacement = matcher(item.ref, context);
        if (replacement === undefined || 'refused' in replacement || replacement.node !== decided.get(item.ref.node)) {
          throw new Error(`convert: the matcher answered ${item.ref.name} differently the second time`);
        }
        edits.push({ start: replacement.node.getStart(source), end: replacement.node.end, text: replacement.text });
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

  // Coverage: every statement commented out has its TODO lines in the file, and every replacement
  // decided is in it. One missing means a replacement copied a span instead of converting it.
  for (const statement of commented) {
    if (!rendered.has(statement)) {
      const calls = (groups.get(statement) ?? []).map((left) => left.call).join(', ');
      throw new Error(`convert: a replacement dropped the statement holding ${calls}; it must pass it to context.text`);
    }
  }
  for (const ref of refs) {
    if (decided.has(ref.node) && !insideCommented(ref.node) && !replaced.has(ref.node)) {
      throw new Error(`convert: a replacement dropped ${ref.name}; it must pass it to context.text`);
    }
  }

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

/**
 * Throws when a replacement breaks the seam's rules: its node holds the reference and stays inside
 * `span`, every node it handed to `context.text` is inside it, and what it replaces without handing
 * on holds no call the layer refuses and no statement (those must reach a TODO).
 */
function checkReplacement(
  ref: DialectRef,
  node: ts.Node,
  handed: readonly ts.Node[],
  span: { readonly from: number; readonly to: number },
  refs: readonly DialectRef[],
  dialect: LayeredApi,
  source: ts.SourceFile,
): void {
  const start = node.getStart(source);
  const within = (inner: ts.Node, outer: { getStart(s: ts.SourceFile): number; end: number }): boolean =>
    inner.getStart(source) >= outer.getStart(source) && inner.end <= outer.end;
  if (!within(ref.node, node)) throw new Error(`convert: the replacement for ${ref.name} does not hold it`);
  if (start < span.from || node.end > span.to) {
    throw new Error(`convert: the replacement for ${ref.name} overlaps another or leaves its span`);
  }
  for (const part of handed) {
    if (!within(part, node)) throw new Error(`convert: the replacement for ${ref.name} converts text outside it`);
  }
  for (const other of refs) {
    if (other === ref || !within(other.node, node) || handed.some((part) => within(other.node, part))) continue;
    const refused = unsupportedCall(callForm(other, source), dialect);
    if (refused !== undefined) {
      throw new Error(`convert: the replacement for ${ref.name} drops ${refused.name}, which must stay a TODO`);
    }
    if (within(statementOf(other.node), node)) {
      throw new Error(`convert: the replacement for ${ref.name} copies ${other.name} without converting it`);
    }
  }
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

/** The innermost statement holding `node` (spec §5.2). */
function statementOf(node: ts.Node): ts.Statement {
  const ts = typescript();
  let at = node;
  while (!ts.isStatement(at)) at = at.parent;
  return at;
}

/** True when `statement` is a member of a statement list (a file, block or case), not a body. */
function inStatementList(statement: ts.Statement): boolean {
  const ts = typescript();
  const parent = statement.parent;
  return (
    ts.isSourceFile(parent) ||
    ts.isBlock(parent) ||
    ts.isModuleBlock(parent) ||
    ts.isCaseClause(parent) ||
    ts.isDefaultClause(parent)
  );
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
