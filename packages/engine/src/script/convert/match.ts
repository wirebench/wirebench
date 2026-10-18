/**
 * The matcher over the mapping table (spec §5.1 step 3): a reference matches a row by its qualified
 * name, the dialect, the argument shape, the phase and the protocol. Arguments are rendered through
 * `context.text`, so the calls nested in them are converted or turned into TODOs.
 */
import type ts from 'typescript';
import { MAPPINGS, type MappingRow } from './mappings.js';
import type { ConvertContext, DialectRef, Matcher, Refusal, Replacement } from './roots.js';
import { typescript } from './typescript.js';

/**
 * A matcher over `rows`; the first row whose name, dialect and shape fit answers, and its answer is
 * final. A chain row fits on name and dialect, and its chain decides the rest.
 */
export function tableMatcher(rows: readonly MappingRow[]): Matcher {
  const byName = new Map<string, MappingRow[]>();
  for (const row of rows) {
    for (const call of row.calls) byName.set(call, [...(byName.get(call) ?? []), row]);
  }
  return (ref, context) => {
    const rows = (byName.get(ref.name) ?? []).filter((row) => row.dialects.includes(context.dialect));
    if (rows.length === 0) return prefixAnswer(byName, ref, context);
    for (const row of rows) {
      if (row.refuse !== undefined) {
        if (ref.call !== undefined) return { refused: row.refuse };
        continue;
      }
      // A chain row reads its own shape; any other row is passed over when the shape differs.
      const target = row.chain === undefined ? shapeOf(row, ref) : undefined;
      if (row.chain === undefined && target === undefined) continue;
      if (row.phase !== undefined && row.phase !== context.phase) return otherPhaseAnswer(row, context);
      const template = row.to[context.protocol];
      if (template === undefined) return undefined;
      if (row.chain !== undefined) {
        const answer = row.chain(ref, context);
        return answer === undefined || 'refused' in answer
          ? answer
          : { node: answer.node, text: template([answer.text]) };
      }
      if (target === undefined) return undefined;
      const text = template(target.args.map((arg) => context.text(arg)));
      return { node: target.node, text: isLoose(row, context) && !separated(target.node) ? `(${text})` : text };
    }
    return undefined;
  };
}

/** The table's matcher, which the converter uses by default. */
export const matchMappings: Matcher = tableMatcher(MAPPINGS);

/** A row's answer in the phase it does not cover: the layer's reason there, or none ("not converted yet"). */
function otherPhaseAnswer(row: MappingRow, context: ConvertContext): Refusal | undefined {
  const reason = typeof row.otherPhase === 'string' ? row.otherPhase : row.otherPhase?.[context.protocol];
  return reason === undefined ? undefined : { refused: reason };
}

/**
 * A chain read past a `property` row (`res.body.id`): the row's template for the part it names, and
 * the rest of the chain as written. Only the longest such part is asked, and its first row is final.
 */
function prefixAnswer(
  byName: ReadonlyMap<string, readonly MappingRow[]>,
  ref: DialectRef,
  context: ConvertContext,
): Replacement | Refusal | undefined {
  const ts = typescript();
  const names = ref.name.split('.');
  let node: ts.Expression = ref.node;
  for (let length = names.length - 1; length > 1 && ts.isPropertyAccessExpression(node); length--) {
    node = node.expression;
    const [row] = (byName.get(names.slice(0, length).join('.')) ?? []).filter(
      (candidate) =>
        candidate.dialects.includes(context.dialect) &&
        candidate.shape === 'property' &&
        candidate.chain === undefined &&
        candidate.refuse === undefined,
    );
    if (row === undefined) continue;
    if (written(ref.node)) return undefined;
    if (row.phase !== undefined && row.phase !== context.phase) return otherPhaseAnswer(row, context);
    const template = row.to[context.protocol];
    if (template === undefined) return undefined;
    // The rest holds only property names (and `?.`), so it is kept as written.
    const head = isLoose(row, context) ? `(${template([])})` : template([]);
    return { node: ref.node, text: `${head}${context.source.text.slice(node.end, ref.node.end)}` };
  }
  return undefined;
}

/** The node a row replaces and the arguments its template gets, or undefined when the shape differs. */
function shapeOf(row: MappingRow, ref: DialectRef): { node: ts.Node; args: readonly ts.Node[] } | undefined {
  const ts = typescript();
  const shape = row.shape ?? 'call';
  if (shape === 'property') {
    return ref.call === undefined && !written(ref.node) ? { node: ref.node, args: [] } : undefined;
  }
  const call = ref.call;
  if (call === undefined || call.arguments.some((arg) => ts.isSpreadElement(arg))) return undefined;
  if (row.statement === true && !standsAlone(call, row.arrowBody === true)) return undefined;
  if (shape === 'object-key-value') {
    const [only] = call.arguments;
    if (call.arguments.length !== 1 || only === undefined || !ts.isObjectLiteralExpression(only)) return undefined;
    const key = propertyValue(only, 'key');
    const value = propertyValue(only, 'value');
    return key !== undefined && value !== undefined && only.properties.length === 2
      ? { node: call, args: [key, value] }
      : undefined;
  }
  const arity = row.arity ?? 0;
  const count = call.arguments.length;
  if (count < arity || count > arity + (row.ignored ?? 0)) return undefined;
  if (!call.arguments.slice(arity).every(inert)) return undefined;
  const first = call.arguments[0];
  if (shape === 'string-literal' && (first === undefined || !ts.isStringLiteralLike(first))) return undefined;
  if (shape === 'numeric-literal' && (first === undefined || !ts.isNumericLiteral(first))) return undefined;
  const args = call.arguments.slice(0, arity);
  if (row.pure === true && !args.every(pure)) return undefined;
  return { node: call, args };
}

/** The initializer of `name: …` in `object` (the name itself for a shorthand `name`), or undefined. */
function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const ts = typescript();
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.objectAssignmentInitializer === undefined && property.name.text === name) return property.name;
      continue;
    }
    if (!ts.isPropertyAssignment(property)) return undefined;
    if ((ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === name) {
      return property.initializer;
    }
  }
  return undefined;
}

/** True when `node` is a literal, or an object of literals, so dropping it loses no code. */
function inert(node: ts.Expression): boolean {
  const ts = typescript();
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.every(
      (property) =>
        ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && inert(property.initializer),
    )
  );
}

/**
 * True when evaluating `node` twice is the same as once: a literal, a name, or a property or element
 * access over those with a literal or name key.
 */
function pure(node: ts.Expression): boolean {
  const ts = typescript();
  if (ts.isParenthesizedExpression(node)) return pure(node.expression);
  if (ts.isIdentifier(node) || inert(node)) return !ts.isObjectLiteralExpression(node);
  if (ts.isPropertyAccessExpression(node)) return pure(node.expression);
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return pure(node.expression) && (ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key));
  }
  return false;
}

/**
 * True when `call` is a statement of its own, or (with `arrowBody`) the expression body of an arrow,
 * whose value nobody reads either: `test('ok', () => pm.response.to.have.status(200))`.
 */
function standsAlone(call: ts.CallExpression, arrowBody: boolean): boolean {
  const ts = typescript();
  const parent = call.parent;
  return ts.isExpressionStatement(parent) || (arrowBody && ts.isArrowFunction(parent) && parent.body === call);
}

/**
 * True when `node`, or what is read through it (`res.body.id`, `res.body['id']`, `res.body.items[0]`),
 * is assigned to, incremented, decremented or deleted, directly or as a destructuring or for-in/of
 * target. A template that reads afresh (`response.json()`) would lose the write.
 */
function written(node: ts.Node): boolean {
  const ts = typescript();
  let target = node;
  for (let parent = target.parent; ; parent = target.parent) {
    if (
      ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === target) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      target = parent;
    } else break;
  }
  const parent = target.parent;
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  if (ts.isDeleteExpression(parent)) return true;
  return assignedTo(target);
}

/** True when `node` is the target of an assignment or a for-in/of, alone or inside a destructuring pattern. */
function assignedTo(node: ts.Node): boolean {
  const ts = typescript();
  let target = node;
  for (;;) {
    const parent = target.parent;
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      if (parent.left === target && op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        return true;
      }
      // `[a = 1] = list`: the default sits on the right of the element's own `=`.
      return false;
    }
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === target) return true;
    // Climb out of a pattern: an array element, a spread, an object's value or shorthand.
    if (
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === target) ||
      ts.isShorthandPropertyAssignment(parent)
    ) {
      target = parent;
      continue;
    }
    return false;
  }
}

/** True when the row's template binds looser than a member access for the script's protocol. */
function isLoose(row: MappingRow, context: ConvertContext): boolean {
  return row.loose === true || (row.loose !== undefined && row.loose.includes(context.protocol));
}

/** True when `node`'s position already keeps a loose expression apart from what is around it. */
function separated(node: ts.Node): boolean {
  const ts = typescript();
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    return (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.CommaToken ||
      (op === ts.SyntaxKind.EqualsToken && parent.right === node)
    );
  }
  return (
    ts.isExpressionStatement(parent) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isVariableDeclaration(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isReturnStatement(parent) ||
    ts.isThrowStatement(parent) ||
    ts.isIfStatement(parent) ||
    ts.isWhileStatement(parent) ||
    ts.isDoStatement(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isTemplateSpan(parent) ||
    ts.isConditionalExpression(parent) ||
    (ts.isArrowFunction(parent) && parent.body === node) ||
    ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== node)
  );
}
