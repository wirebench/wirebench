/**
 * The editor's help with variables (#340), with no Monaco and no DOM in it, so every field and every
 * editor shares one set of rules — and the tests read them without either:
 *
 * - what the text before the caret is in the middle of typing (`${na`, `${#`, `${#Env#na`, `${secret:`,
 *   `${$na`);
 * - what to offer there, and what accepting an item writes;
 * - what one reference resolves to, against the request's `request.variables` list;
 * - which references to mark as unresolved;
 * - the text a variable is referenced by: `${name}` when the chain reaches its scope, else explicit;
 * - the columns of a Runner data file that runs the request (#560): offered after the chain, as the
 *   shorthand reaches them last, and never marked unresolved as `${#Data#…}` while none is known.
 *
 * A masked value is shown only as `••••••`: the list never carries it in the first place.
 */
import {
  DYNAMIC_GENERATORS,
  propertyReferences,
  type DynamicGeneratorInfo,
  type PropertyReference,
} from '@wirebench/engine/rest';
import type { RequestVariablesResponse, RequestVariableWire, VariableEditTargetWire } from '../../shared/wire-base.js';

/**
 * What `request.variables` answered for one request, plus the columns of a Runner data file that runs
 * it, when one is chosen in an open Runner tab (#560).
 */
export type RequestVariables = RequestVariablesResponse & { readonly dataColumns?: readonly string[] };
export type VariableScope = RequestVariableWire['scope'];

/** How a scope reads in the editor. */
export const SCOPE_LABEL: Readonly<Record<VariableScope, string>> = {
  Env: 'Environment',
  Project: 'Project',
  Workspace: 'Workspace',
  Global: 'Globals',
  System: 'System',
};

/** The scopes `${#Scope#` completes to, in chain order. */
const SCOPES: readonly VariableScope[] = ['Env', 'Project', 'Workspace', 'Global', 'System'];

/** The scope of the generated values (#333): `${#Dynamic#name}`, or `${$name}` for short. */
const DYNAMIC = 'Dynamic';

/** The scope of a data-driven run's row (#336): `${#Data#column}`, or `${column}` last in the chain. */
const DATA = 'Data';

/** How a data column reads in a list or a hover. */
const DATA_LABEL = 'Data row';

/** What a data column's value is, since only a run has one. */
const DATA_TEXT = "A column of the Runner's data file: each iteration reads it from its own row.";

/** The mask a secret-backed value is shown as. */
export const MASK = '••••••';

/** What the caret is in the middle of typing; `start` is the offset the typed prefix begins at. */
export type CompletionContext =
  | { readonly kind: 'name'; readonly scope?: VariableScope; readonly prefix: string; readonly start: number }
  | { readonly kind: 'scope'; readonly prefix: string; readonly start: number }
  | { readonly kind: 'secret'; readonly prefix: string; readonly start: number }
  | { readonly kind: 'dynamic'; readonly prefix: string; readonly start: number }
  | { readonly kind: 'data'; readonly prefix: string; readonly start: number };

// Each one anchored at the caret, and never behind the `$${` escape.
const SCOPED_NAME = /(?<!\$)\$\{#([A-Za-z]+)#([^\s{}#$]*)$/;
const SCOPE = /(?<!\$)\$\{#([A-Za-z]*)$/;
const SECRET = /(?<!\$)\$\{secret:([A-Za-z0-9_]*)$/;
const DYNAMIC_NAME = /(?<!\$)\$\{(?:\$|#Dynamic#)([A-Za-z0-9]*)$/;
const NAME = /(?<!\$)\$\{([^\s{}#$:]*)$/;

/** The completion context when `before` (the text up to the caret) ends inside an open reference. */
export function completionContext(before: string): CompletionContext | undefined {
  const dynamic = DYNAMIC_NAME.exec(before);
  if (dynamic !== null) {
    const prefix = dynamic[1]!;
    return { kind: 'dynamic', prefix, start: before.length - prefix.length };
  }
  const scoped = SCOPED_NAME.exec(before);
  if (scoped !== null) {
    const prefix = scoped[2]!;
    if (scoped[1] === DATA) return { kind: 'data', prefix, start: before.length - prefix.length };
    const scope = scoped[1] as VariableScope;
    // An unknown scope has nothing to offer.
    if (!SCOPES.includes(scope)) return undefined;
    return { kind: 'name', scope, prefix, start: before.length - prefix.length };
  }
  const scope = SCOPE.exec(before);
  if (scope !== null) {
    const prefix = scope[1]!;
    return { kind: 'scope', prefix, start: before.length - prefix.length };
  }
  const secret = SECRET.exec(before);
  if (secret !== null) {
    const prefix = secret[1]!;
    return { kind: 'secret', prefix, start: before.length - prefix.length };
  }
  const name = NAME.exec(before);
  if (name !== null) {
    const prefix = name[1]!;
    return { kind: 'name', prefix, start: before.length - prefix.length };
  }
  return undefined;
}

/** One completion item. `insertText` replaces the typed prefix (from the context's `start`). */
export interface VariableCompletionItem {
  readonly label: string;
  readonly insertText: string;
  readonly detail: string;
  readonly documentation: string;
}

/** What a value reads as in a list or a hover: itself, or the mask and what it hides. */
export function displayValue(entry: RequestVariableWire): string {
  if (!entry.masked) return entry.value ?? '';
  if (entry.scope === 'System') return `${MASK}  (environment variable)`;
  return entry.secretName !== undefined ? `${MASK}  (secret ${entry.secretName})` : MASK;
}

/** The items for `context`; `closed` when a `}` already follows the caret. */
export function completionItems(
  context: CompletionContext,
  variables: RequestVariables,
  closed: boolean,
): VariableCompletionItem[] {
  const brace = closed ? '' : '}';
  const prefix = context.prefix.toLowerCase();
  const matches = (label: string): boolean => label.toLowerCase().startsWith(prefix);
  switch (context.kind) {
    case 'scope':
      return [
        ...SCOPES.filter((scope) => matches(scope)).map((scope) => ({
          label: scope,
          insertText: `${scope}#`,
          detail: SCOPE_LABEL[scope],
          documentation: '',
        })),
        ...(matches(DYNAMIC)
          ? [{ label: DYNAMIC, insertText: `${DYNAMIC}#`, detail: 'Generated on each send', documentation: '' }]
          : []),
        ...((variables.dataColumns?.length ?? 0) > 0 && matches(DATA)
          ? [{ label: DATA, insertText: `${DATA}#`, detail: DATA_LABEL, documentation: '' }]
          : []),
      ];
    case 'data':
      return (variables.dataColumns ?? [])
        .filter((column) => matches(column))
        .map((column) => ({
          label: column,
          insertText: `${column}${brace}`,
          detail: DATA_LABEL,
          documentation: DATA_TEXT,
        }));
    case 'dynamic':
      return DYNAMIC_GENERATORS.filter((generator) => matches(generator.name)).map((generator) => ({
        label: generator.name,
        insertText: `${generator.name}${brace}`,
        detail: DYNAMIC,
        documentation: generatorText(generator),
      }));
    case 'secret':
      return variables.secretNames
        .filter((name) => matches(name))
        .map((name) => ({ label: name, insertText: `${name}${brace}`, detail: 'Secret', documentation: MASK }));
    case 'name': {
      const { scope } = context;
      if (scope !== undefined) {
        return variables.entries
          .filter((entry) => entry.scope === scope && matches(entry.name))
          .map((entry) => ({
            label: entry.name,
            insertText: `${entry.name}${brace}`,
            detail: SCOPE_LABEL[entry.scope],
            documentation: displayValue(entry),
          }));
      }
      const names = variables.entries
        .filter((entry) => entry.scope !== 'System' && matches(entry.name))
        .map((entry) => ({
          label: entry.name,
          insertText: `${entry.shadowed ? `#${entry.scope}#` : ''}${entry.name}${brace}`,
          detail: entry.shadowed ? `${SCOPE_LABEL[entry.scope]} (shadowed)` : SCOPE_LABEL[entry.scope],
          documentation: displayValue(entry),
        }));
      const secrets = variables.secretNames
        .filter((name) => matches(`secret:${name}`) || matches(name))
        .map((name) => ({
          label: `secret:${name}`,
          insertText: `secret:${name}${brace}`,
          detail: 'Secret',
          documentation: MASK,
        }));
      // A column comes after the chain: one a chain scope also defines is reached only explicitly.
      const columns = (variables.dataColumns ?? [])
        .filter((column) => matches(column))
        .map((column) => {
          const shadowed = chainEntry(column, variables) !== undefined;
          return {
            label: column,
            insertText: `${shadowed ? `#${DATA}#` : ''}${column}${brace}`,
            detail: shadowed ? `${DATA_LABEL} (shadowed)` : DATA_LABEL,
            documentation: DATA_TEXT,
          };
        });
      return [...names, ...columns, ...secrets];
    }
  }
}

/** What a generator gives, and the arguments it takes. */
function generatorText(generator: DynamicGeneratorInfo): string {
  return generator.usage === undefined
    ? generator.description
    : `${generator.description} Arguments: (${generator.usage}).`;
}

/** The generator `name` (no arguments) names, by its own name or an alias. */
function generatorNamed(name: string): DynamicGeneratorInfo | undefined {
  return DYNAMIC_GENERATORS.find((generator) => generator.name === name || generator.aliases.includes(name));
}

/** What one reference resolves to. `unknown` is never marked: only a send can tell. */
export type ReferenceStatus =
  | { readonly status: 'resolved'; readonly entry: RequestVariableWire }
  | { readonly status: 'dynamic'; readonly generator: DynamicGeneratorInfo }
  | { readonly status: 'secret'; readonly name: string }
  | { readonly status: 'data'; readonly name: string }
  | { readonly status: 'unresolved'; readonly name: string }
  | { readonly status: 'unknown' };

/** The entry the shorthand `${name}` reaches: the nearest chain scope that defines it. */
function chainEntry(name: string, variables: RequestVariables): RequestVariableWire | undefined {
  return variables.entries.find((entry) => entry.scope !== 'System' && entry.name === name);
}

/** Classifies `reference` against `variables`; everything is `unknown` until the list has arrived. */
export function classifyReference(
  reference: PropertyReference,
  variables: RequestVariables | undefined,
): ReferenceStatus {
  if (variables === undefined) return { status: 'unknown' };
  const unresolved = { status: 'unresolved', name: reference.name } as const;
  switch (reference.form) {
    case 'shorthand': {
      const entry = chainEntry(reference.name, variables);
      if (entry !== undefined) return { status: 'resolved', entry };
      return variables.dataColumns?.includes(reference.name) === true
        ? { status: 'data', name: reference.name }
        : unresolved;
    }
    case 'scoped': {
      if (reference.scope === 'Sequence') return { status: 'unknown' };
      if (reference.scope === DATA) {
        // Only a run has a row: without a known column, a send is the only judge.
        return variables.dataColumns?.includes(reference.name) === true
          ? { status: 'data', name: reference.name }
          : { status: 'unknown' };
      }
      const entry = variables.entries.find(
        (candidate) => candidate.scope === reference.scope && candidate.name === reference.name,
      );
      return entry === undefined ? unresolved : { status: 'resolved', entry };
    }
    case 'secret':
      return variables.secretNames.includes(reference.name) ? { status: 'secret', name: reference.name } : unresolved;
    case 'unknown-scope':
    case 'malformed':
      return unresolved;
    case 'dynamic': {
      // Arguments are checked only when the value is generated, at send time.
      const generator = generatorNamed(reference.name);
      return generator === undefined
        ? { status: 'unresolved', name: `$${reference.name}` }
        : { status: 'dynamic', generator };
    }
    case 'nested':
      return { status: 'unknown' };
  }
}

/** The references in `text` that resolve to nothing, to be marked where they are written. */
export function unresolvedReferences(text: string, variables: RequestVariables | undefined): PropertyReference[] {
  if (variables === undefined) return [];
  return propertyReferences(text).filter(
    (reference) => classifyReference(reference, variables).status === 'unresolved',
  );
}

/**
 * The text `name` in `scope` is referenced by: the shorthand when the chain would reach that scope
 * (no nearer scope defines the name), the explicit form otherwise — and always for System.
 */
export function referenceText(name: string, scope: VariableScope, variables: RequestVariables): string {
  if (scope === 'System') return `\${#System#${name}}`;
  const order = SCOPES.indexOf(scope);
  const nearer = variables.entries.some(
    (entry) => entry.name === name && entry.scope !== 'System' && SCOPES.indexOf(entry.scope) < order,
  );
  return nearer ? `\${#${scope}#${name}}` : `\${${name}}`;
}

/** What a hover over one reference says. */
export interface HoverContent {
  readonly title: string;
  readonly scope: string;
  readonly value: string;
  readonly edit?: VariableEditTargetWire;
  readonly unresolved?: true;
}

/** The hover for a classified reference, or nothing for one only a send can resolve. */
export function hoverContent(status: ReferenceStatus, raw: string): HoverContent | undefined {
  switch (status.status) {
    case 'resolved':
      return {
        title: status.entry.name,
        scope: SCOPE_LABEL[status.entry.scope],
        value: displayValue(status.entry),
        ...(status.entry.edit !== undefined ? { edit: status.entry.edit } : {}),
      };
    case 'secret':
      return { title: status.name, scope: 'Secret', value: MASK };
    case 'data':
      return { title: status.name, scope: DATA_LABEL, value: DATA_TEXT };
    case 'dynamic':
      return {
        title: `$${status.generator.name}`,
        scope: DYNAMIC,
        value: `${generatorText(status.generator)} A new value is generated for each send.`,
      };
    case 'unresolved': {
      const title = status.name === '' ? raw : status.name;
      return {
        title,
        scope: 'Unresolved',
        value:
          status.name === ''
            ? 'This reference is not closed with "}".'
            : status.name.startsWith('$')
              ? `No dynamic value is named "${status.name.slice(1)}".`
              : `No variable named "${status.name}" is in scope for this request.`,
        unresolved: true,
      };
    }
    case 'unknown':
      return undefined;
  }
}
