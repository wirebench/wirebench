/**
 * The rewrites that cover more than a reference's own call (spec §6.4, §6.7): an expectation with
 * its whole chain, `tc.test` by the kind of value it is given, and a CryptoJS hash or HMAC with its
 * `.toString(…)`. A row in `mappings.ts` names the calls and dialects and points at one of these.
 *
 * Each one reads the shape from the syntax first and renders only once the shape fits, so a chain
 * left as a TODO hands nothing to `context.text`. Every operand kept (the subject, the matcher's
 * arguments, a test's name and callback, a hash's input) is rendered through `context.text`.
 */
import type ts from 'typescript';
import type { ConvertContext, DialectRef, Refusal, Replacement } from './roots.js';
import { typescript } from './typescript.js';

/** A rewrite of the expression around a reference: its replacement, a refusal, or undefined (a TODO). */
export type Chain = (ref: DialectRef, context: ConvertContext) => Replacement | Refusal | undefined;

/** One `.name` or `.name(args)` after a call, and the node it ends at. */
interface Step {
  readonly name: string;
  /** The arguments when the step is called. */
  readonly args?: readonly ts.Expression[];
  readonly node: ts.Expression;
}

/**
 * The steps read outwards from `call`, and whether the last one ends the expression (`closed`):
 * false when it is indexed, called, tagged or optionally chained, which no table reads.
 */
function stepsAfter(call: ts.CallExpression): { readonly steps: readonly Step[]; readonly closed: boolean } {
  const ts = typescript();
  const steps: Step[] = [];
  let node: ts.Expression = call;
  for (;;) {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (parent.questionDotToken !== undefined || !ts.isIdentifier(parent.name)) return { steps, closed: false };
      const outer = parent.parent;
      if (ts.isCallExpression(outer) && outer.expression === parent) {
        if (outer.questionDotToken !== undefined || outer.arguments.some((arg) => ts.isSpreadElement(arg))) {
          return { steps, closed: false };
        }
        steps.push({ name: parent.name.text, args: outer.arguments, node: outer });
        node = outer;
      } else {
        steps.push({ name: parent.name.text, node: parent });
        node = parent;
      }
      continue;
    }
    const used =
      (ts.isElementAccessExpression(parent) && parent.expression === node) ||
      (ts.isCallExpression(parent) && parent.expression === node) ||
      (ts.isTaggedTemplateExpression(parent) && parent.tag === node);
    return { steps, closed: !used };
  }
}

/** The call's arguments when there are exactly `count` and none is spread. */
function argumentsOf(call: ts.CallExpression | undefined, count: number): readonly ts.Expression[] | undefined {
  const ts = typescript();
  if (call === undefined || call.questionDotToken !== undefined || call.arguments.length !== count) return undefined;
  return call.arguments.some((arg) => ts.isSpreadElement(arg)) ? undefined : call.arguments;
}

/**
 * `text` ready to stand after `typeof` or before `/`: as it is when it parses as a name, a member
 * access, a call, a literal or a parenthesised expression; in parentheses otherwise.
 */
function operand(text: string): string {
  const ts = typescript();
  const source = ts.createSourceFile('operand.js', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const [only] = source.statements;
  if (source.statements.length !== 1 || only === undefined || !ts.isExpressionStatement(only)) return `(${text})`;
  const node = only.expression;
  const tight =
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isTemplateExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.ThisKeyword;
  return tight ? text : `(${text})`;
}

// --- expectations ---------------------------------------------------------------------------------

/** Which matchers an expectation's root has (spec §6.4). */
export interface ExpectStyle {
  /** The chai chains: `pm.expect`, `hopp.expect`, Bruno's and Thunder Client's. */
  readonly chai: boolean;
  /** The Jest-style matchers: `pw.expect`, `hopp.expect`. */
  readonly jest: boolean;
  /** Bruno's `.jsonSchema`, which becomes a TODO pointing at the request's assertion. */
  readonly jsonSchema?: true;
}

/** The reason on Bruno's `.jsonSchema` TODO. */
export const JSON_SCHEMA_REASON = "the typed API has no JSON Schema check; use the request's JSON Schema assertion";

/** The chai words that only read better (spec §6.4); a chain may hold any number of them. */
const FILLER = new Set(['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'does']);

/** The chai calls with one argument and the typed matcher each becomes. */
const CHAI_CALLS: Readonly<Record<string, string>> = {
  equal: 'toBe',
  equals: 'toBe',
  eq: 'toBe',
  eql: 'toEqual',
  eqls: 'toEqual',
  include: 'toContain',
  includes: 'toContain',
  contain: 'toContain',
  contains: 'toContain',
  lengthOf: 'toHaveLength',
  length: 'toHaveLength',
  match: 'toMatch',
  above: 'toBeGreaterThan',
  gt: 'toBeGreaterThan',
  greaterThan: 'toBeGreaterThan',
  below: 'toBeLessThan',
  lt: 'toBeLessThan',
  lessThan: 'toBeLessThan',
};

/** The chai calls `.deep` may come before: their typed form is `toEqual`. */
const DEEP_CALLS = new Set(['equal', 'equals', 'eq', 'eql', 'eqls']);

/** The chai assertions read as properties, and the typed matcher call each becomes. */
const CHAI_WORDS: Readonly<Record<string, string>> = {
  true: 'toBe(true)',
  false: 'toBe(false)',
  null: 'toBeNull()',
  undefined: 'toBeUndefined()',
  ok: 'toBeTruthy()',
};

/** The types `.a(t)` maps: those `typeof` answers the same as chai's type name. */
const TYPEOF_NAMES = new Set(['string', 'number', 'boolean', 'undefined', 'function']);

/** The Jest-style matchers with one argument that keep their meaning under another name. */
const JEST_CALLS: Readonly<Record<string, string>> = {
  toBe: 'toBe',
  toHaveLength: 'toHaveLength',
  toInclude: 'toContain',
};

/** `.toBeLevel2xx()` to `.toBeLevel5xx()` and the hundreds digit each checks. */
const JEST_LEVELS: Readonly<Record<string, number>> = {
  toBeLevel2xx: 2,
  toBeLevel3xx: 3,
  toBeLevel4xx: 4,
  toBeLevel5xx: 5,
};

/** The typed expectation, given a renderer for the nodes it keeps; `not` is `.not` or nothing. */
type Assertion = (subject: ts.Expression, not: string, text: (node: ts.Node) => string) => string;

/** The typed form of chai's final step, or undefined when the tables do not hold it. */
function chaiAssertion(step: Step, deep: boolean): Assertion | undefined {
  const ts = typescript();
  const args = step.args;
  if (args === undefined) {
    const matcher = deep ? undefined : CHAI_WORDS[step.name];
    return matcher === undefined ? undefined : (subject, not, text) => `expect(${text(subject)})${not}.${matcher}`;
  }
  if (deep && !DEEP_CALLS.has(step.name)) return undefined;
  if (step.name === 'property') {
    const [name, value] = args;
    if (name === undefined || args.length > 2) return undefined;
    // Chai reads 'a.b' as one key and the typed toHaveProperty splits on dots; the array form keeps one key.
    const plain = ts.isStringLiteralLike(name) && !name.text.includes('.');
    return (subject, not, text) => {
      const key = plain ? text(name) : `[${text(name)}]`;
      return `expect(${text(subject)})${not}.toHaveProperty(${key}${value === undefined ? '' : `, ${text(value)}`})`;
    };
  }
  const [only] = args;
  if (only === undefined || args.length !== 1) return undefined;
  if (step.name === 'a' || step.name === 'an') {
    if (!ts.isStringLiteralLike(only) || !TYPEOF_NAMES.has(only.text)) return undefined;
    return (subject, not, text) => `expect(typeof ${operand(text(subject))})${not}.toBe(${text(only)})`;
  }
  const matcher = deep ? 'toEqual' : CHAI_CALLS[step.name];
  if (matcher === undefined) return undefined;
  return (subject, not, text) => `expect(${text(subject)})${not}.${matcher}(${text(only)})`;
}

/** The typed form of a Jest-style matcher, or undefined when the table does not hold it. */
function jestAssertion(step: Step): Assertion | undefined {
  const args = step.args;
  if (args === undefined) return undefined;
  const level = JEST_LEVELS[step.name];
  if (level !== undefined) {
    return args.length === 0
      ? (subject, not, text) => `expect(Math.floor(${operand(text(subject))} / 100))${not}.toBe(${String(level)})`
      : undefined;
  }
  const [only] = args;
  if (only === undefined || args.length !== 1) return undefined;
  if (step.name === 'toBeType') {
    return (subject, not, text) => `expect(typeof ${operand(text(subject))})${not}.toBe(${text(only)})`;
  }
  const matcher = JEST_CALLS[step.name];
  return matcher === undefined
    ? undefined
    : (subject, not, text) => `expect(${text(subject)})${not}.${matcher}(${text(only)})`;
}

/**
 * `expect(x)` and the chain after it, read outwards: `.not` and (for chai) the filler words and
 * `.deep`, then one assertion that ends the expression. Anything else leaves it a TODO.
 */
export function expectChain(style: ExpectStyle): Chain {
  return (ref, context) => {
    const args = argumentsOf(ref.call, 1);
    if (ref.call === undefined || args === undefined) return undefined;
    const { steps, closed } = stepsAfter(ref.call);
    if (style.jsonSchema === true && steps.some((step) => step.name === 'jsonSchema')) {
      return { refused: JSON_SCHEMA_REASON, kind: 'not-mapped' };
    }
    const last = steps.at(-1);
    if (!closed || last === undefined) return undefined;
    let not = false;
    let deep = false;
    // hopp.expect's Jest matchers sit on the expectation and its .not, not on what a chai word returns.
    let jest = style.jest;
    for (const step of steps.slice(0, -1)) {
      if (step.args !== undefined) return undefined;
      if (step.name === 'not') not = !not;
      else if (style.chai && FILLER.has(step.name)) jest = false;
      else if (style.chai && step.name === 'deep') [deep, jest] = [true, false];
      else return undefined;
    }
    const assertion = (style.chai ? chaiAssertion(last, deep) : undefined) ?? (jest ? jestAssertion(last) : undefined);
    const [subject] = args;
    if (assertion === undefined || subject === undefined) return undefined;
    return { node: last.node, text: assertion(subject, not ? '.not' : '', (node) => context.text(node)) };
  };
}

// --- tc.test --------------------------------------------------------------------------------------

/**
 * `tc.test(n, v)`: a function (a literal, or a name or member that holds one) is called and passes
 * unless it returns false; any other value passes when it is true (spec §6.4).
 */
export const tcTest: Chain = (ref, context) => {
  const ts = typescript();
  const args = argumentsOf(ref.call, 2);
  if (ref.call === undefined || args === undefined) return undefined;
  const [name, value] = args;
  if (name === undefined || value === undefined) return undefined;
  let inner: ts.Expression = value;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  const callable =
    ts.isArrowFunction(inner) ||
    ts.isFunctionExpression(inner) ||
    ts.isIdentifier(inner) ||
    ts.isPropertyAccessExpression(inner) ||
    ts.isElementAccessExpression(inner);
  const n = context.text(name);
  const v = context.text(value);
  return {
    node: ref.call,
    text: callable ? `test(${n}, () => expect((${v})()).not.toBe(false))` : `test(${n}, () => expect(${v}).toBe(true))`,
  };
};

// --- CryptoJS -------------------------------------------------------------------------------------

/** True when `node` is `CryptoJS.enc.<name>`. */
function isEncoder(node: ts.Expression, name: string): boolean {
  const ts = typescript();
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === name &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'enc' &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'CryptoJS'
  );
}

/**
 * A CryptoJS digest called with `arity` arguments and turned into text at once by `.toString()`,
 * `.toString(CryptoJS.enc.Hex)` or `.toString(CryptoJS.enc.Base64)`. A word array kept for later is a
 * TODO. `write` gets the arguments rendered and the encoding argument (`''` or `, 'base64'`).
 */
function digest(arity: number, write: (args: readonly string[], encoding: string) => string): Chain {
  return (ref, context) => {
    const args = argumentsOf(ref.call, arity);
    if (ref.call === undefined || args === undefined) return undefined;
    const [toString] = stepsAfter(ref.call).steps;
    if (toString?.name !== 'toString' || toString.args === undefined || toString.args.length > 1) return undefined;
    const [encoder] = toString.args;
    let encoding = '';
    if (encoder !== undefined && isEncoder(encoder, 'Base64')) encoding = ", 'base64'";
    else if (encoder !== undefined && !isEncoder(encoder, 'Hex')) return undefined;
    return {
      node: toString.node,
      text: write(
        args.map((arg) => context.text(arg)),
        encoding,
      ),
    };
  };
}

/** `CryptoJS.MD5(x).toString(…)` and the other hashes: `crypto.hash(algorithm, x[, 'base64'])`. */
export const cryptoHash = (algorithm: string): Chain =>
  digest(1, ([data], encoding) => `crypto.hash('${algorithm}', ${String(data)}${encoding})`);

/**
 * `CryptoJS.HmacSHA256(data, key).toString(…)`: `crypto.hmac(algorithm, key, data[, 'base64'])`.
 * CryptoJS takes the data first and the typed API the key first, so the two swap.
 */
export const cryptoHmac = (algorithm: string): Chain =>
  digest(2, ([data, key], encoding) => `crypto.hmac('${algorithm}', ${String(key)}, ${String(data)}${encoding})`);
