/**
 * The matcher over the mapping table (spec §5.1 step 3): a reference matches a row by its qualified
 * name, the dialect, the argument shape, the phase and the protocol. Arguments are rendered through
 * `context.text`, so the calls nested in them are converted or turned into TODOs.
 */
import type ts from 'typescript';
import { MAPPINGS, type MappingRow } from './mappings.js';
import type { DialectRef, Matcher } from './roots.js';
import { typescript } from './typescript.js';

/** A matcher over `rows`; the first row whose name, dialect and shape fit answers. */
export function tableMatcher(rows: readonly MappingRow[]): Matcher {
  const byName = new Map<string, MappingRow[]>();
  for (const row of rows) {
    for (const call of row.calls) byName.set(call, [...(byName.get(call) ?? []), row]);
  }
  return (ref, context) => {
    for (const row of byName.get(ref.name) ?? []) {
      if (!row.dialects.includes(context.dialect)) continue;
      if (row.refuse !== undefined) {
        if (ref.call !== undefined) return { refused: row.refuse };
        continue;
      }
      const target = shapeOf(row, ref);
      if (target === undefined) continue;
      if (row.phase !== undefined && row.phase !== context.phase) {
        return row.otherPhase !== undefined ? { refused: row.otherPhase } : undefined;
      }
      const template = row.to[context.protocol];
      if (template === undefined) return undefined;
      const text = template(target.args.map((arg) => context.text(arg)));
      return { node: target.node, text: row.loose === true && !separated(target.node) ? `(${text})` : text };
    }
    return undefined;
  };
}

/** The table's matcher, which the converter uses by default. */
export const matchMappings: Matcher = tableMatcher(MAPPINGS);

/** The node a row replaces and the arguments its template gets, or undefined when the shape differs. */
function shapeOf(row: MappingRow, ref: DialectRef): { node: ts.Node; args: readonly ts.Node[] } | undefined {
  const ts = typescript();
  const shape = row.shape ?? 'call';
  if (shape === 'property') {
    return ref.call === undefined && !written(ref.node) ? { node: ref.node, args: [] } : undefined;
  }
  const call = ref.call;
  if (call === undefined || call.arguments.some((arg) => ts.isSpreadElement(arg))) return undefined;
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
  const args = call.arguments.slice(0, arity);
  if (row.pure === true && !args.every(pure)) return undefined;
  return { node: call, args };
}

/** The initializer of `name: …` in `object`, or undefined. */
function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const ts = typescript();
  for (const property of object.properties) {
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

/** True when `node` is assigned to, incremented, decremented or deleted. */
function written(node: ts.Node): boolean {
  const ts = typescript();
  const parent = node.parent;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    return parent.left === node && op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  return ts.isDeleteExpression(parent);
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
