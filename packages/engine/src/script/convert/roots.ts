/**
 * A dialect's global roots (spec §5.1 step 2), the references a script makes to them, and the seam
 * the mapping table plugs into: for each reference the converter asks a {@link Matcher} for a
 * replacement, and a reference with none becomes a TODO.
 */
import type ts from 'typescript';
import type { LayeredApi, ScriptPhase } from '../model.js';
import { typescript } from './typescript.js';

/** The protocol module a converted script runs under; a mapping's template can differ per protocol. */
export type ConvertProtocol = 'rest' | 'soap' | 'grpc' | 'mcp';

/** The globals each dialect's scripts reach its API through. */
export const DIALECT_ROOTS: Readonly<Record<LayeredApi, readonly string[]>> = Object.freeze({
  postman: ['pm', 'postman', 'CryptoJS', 'btoa', 'atob'],
  insomnia: ['insomnia', '$'],
  bruno: ['bru', 'req', 'res', 'test', 'expect'],
  hoppscotch: ['pw', 'hopp', 'pm'],
  'thunder-client': ['tc', 'test', 'expect'],
});

/** One reference to a root: the root, the property chain read from it, and the call made on it. */
export interface DialectRef {
  readonly root: string;
  /** The chain dotted, as the layer names it: `pm.response.json` for `pm.response.json().id`. */
  readonly name: string;
  /** The root identifier, or the outermost property access of the chain. */
  readonly node: ts.Expression;
  /** The call whose callee is `node`, when the chain is called. */
  readonly call?: ts.CallExpression;
}

/** What a matcher knows besides the reference. */
export interface ConvertContext {
  readonly dialect: LayeredApi;
  readonly phase: ScriptPhase;
  readonly protocol: ConvertProtocol;
  readonly source: ts.SourceFile;
  /**
   * A node's text as converted: the references inside it replaced or turned into TODOs. A
   * replacement builds its arguments with it, so `pm.environment.set('a', pm.response.json().id)`
   * converts both calls.
   */
  text(node: ts.Node): string;
}

/** The text that replaces a node's span; the node holds the reference it answers. */
export interface Replacement {
  readonly node: ts.Node;
  readonly text: string;
}

/**
 * The mapping table's answer that a call stays a TODO with the layer's reason, although the layer
 * runs it elsewhere: `skipRequest` in a post-response script.
 */
export interface Refusal {
  readonly refused: string;
}

/**
 * The mapping table's answer for one reference: a replacement, a refusal, or undefined when it has
 * none ("not converted yet").
 */
export type Matcher = (ref: DialectRef, context: ConvertContext) => Replacement | Refusal | undefined;

/** The names the script declares anywhere: a root among them is the script's own, not the global. */
export function declaredNames(source: ts.SourceFile): Set<string> {
  const ts = typescript();
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isDeclarationName(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function isDeclarationName(id: ts.Identifier): boolean {
  const ts = typescript();
  const parent = id.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent)) &&
    parent.name === id
  );
}

/**
 * The reference `id` starts, or undefined when `id` is not read as a value there: a property name
 * (`a.pm`, `{ pm: 1 }`), a declared name or a label.
 */
export function referenceAt(id: ts.Identifier): DialectRef | undefined {
  const ts = typescript();
  const parent = id.parent;
  if (!ts.isShorthandPropertyAssignment(parent) && 'name' in parent && parent.name === id) return undefined;
  if (
    (ts.isBindingElement(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) &&
    parent.propertyName === id
  )
    return undefined;
  if (
    (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
    parent.label === id
  )
    return undefined;
  let node: ts.Expression = id;
  const names = [id.text];
  for (let up = node.parent; ts.isPropertyAccessExpression(up) && ts.isIdentifier(up.name); up = node.parent) {
    names.push(up.name.text);
    node = up;
  }
  const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : undefined;
  return { root: id.text, name: names.join('.'), node, ...(call !== undefined ? { call } : {}) };
}
