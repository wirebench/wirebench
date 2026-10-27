/**
 * The GraphQL editor's language features (#77), answered in main so the renderer loads no GraphQL
 * code: diagnostics for the query and its variables, completion in either, and hover documentation.
 * Positions are Monaco's, 1-based; the language service's are 0-based.
 */
import { getVariableValues, Kind, parse } from 'graphql';
import type { DocumentNode, GraphQLSchema, OperationDefinitionNode, TypeNode } from 'graphql';
import {
  CompletionItemKind,
  DIAGNOSTIC_SEVERITY,
  getAutocompleteSuggestions,
  getDiagnostics,
  getHoverInformation,
  Position,
} from 'graphql-language-service';
import type {
  GraphqlCompletionItemWire,
  GraphqlDiagnosticWire,
  GraphqlRangeWire,
} from '@wirebench/wire/kinds/graphql/wire';

/** Above this, nothing is analysed: an editor holding a megabyte of query gets no help, and no lag. */
const MAX_TEXT = 512 * 1024;

const MAX_ITEMS = 200;

/** A 0-based language-service range as Monaco's 1-based one. */
function toRange(range: {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}): GraphqlRangeWire {
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** The 1-based range of `[start, end)` in `text`. */
function rangeOf(text: string, start: number, end: number): GraphqlRangeWire {
  const at = (offset: number): { line: number; column: number } => {
    const before = text.slice(0, offset).split('\n');
    return { line: before.length, column: before[before.length - 1]!.length + 1 };
  };
  const from = at(start);
  const to = at(Math.max(end, start + 1));
  return { startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column };
}

/** The document's operations, or `undefined` when it does not parse. */
function parsed(query: string): DocumentNode | undefined {
  try {
    return parse(query);
  } catch {
    return undefined;
  }
}

function operationsOf(document: DocumentNode | undefined): OperationDefinitionNode[] {
  return (document?.definitions ?? []).filter(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  );
}

/** The operation a send would run: the named one, or the only one. */
function selectedOperation(
  document: DocumentNode | undefined,
  operationName: string | undefined,
): OperationDefinitionNode | undefined {
  const operations = operationsOf(document);
  if (operationName !== undefined && operationName !== '') {
    return operations.find((operation) => operation.name?.value === operationName);
  }
  return operations.length === 1 ? operations[0] : undefined;
}

/** What {@link graphqlDiagnostics} is asked about. */
export interface GraphqlAssistInput {
  readonly query: string;
  readonly variables?: string | undefined;
  readonly operationName?: string | undefined;
}

/** Where the key `name` sits in a variables text, or the first line when it is not there. */
function keyRange(text: string, name: string): GraphqlRangeWire {
  const found = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`).exec(text);
  if (found !== null) return rangeOf(text, found.index, found.index + name.length + 2);
  const firstLine = text.split('\n')[0] ?? '';
  return { startLine: 1, startColumn: 1, endLine: 1, endColumn: Math.max(2, firstLine.length + 1) };
}

/** The variables checked against the operation's declarations: what is missing, unknown, or the wrong type. */
function variableDiagnostics(
  schema: GraphQLSchema | undefined,
  operation: OperationDefinitionNode | undefined,
  text: string,
): GraphqlDiagnosticWire[] {
  if (text.trim() === '') {
    if (schema === undefined || operation === undefined) return [];
    text = '{}';
  }
  let values: unknown;
  try {
    values = JSON.parse(text) as unknown;
  } catch {
    // A reference in a value position (`${id}`) is JSON only once a send expands it: not an error here.
    if (/\$\{[^}]*\}/.test(text)) return [];
    return [{ severity: 'error', message: 'The variables are not valid JSON', range: keyRange(text, '') }];
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return [{ severity: 'error', message: 'The variables must be a JSON object', range: keyRange(text, '') }];
  }
  if (schema === undefined || operation === undefined) return [];
  const out: GraphqlDiagnosticWire[] = [];
  const declared = new Set((operation.variableDefinitions ?? []).map((d) => d.variable.name.value));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) {
      out.push({
        severity: 'warning',
        message: `The operation declares no variable $${name}`,
        range: keyRange(text, name),
      });
    }
  }
  const result = getVariableValues(schema, operation.variableDefinitions ?? [], values as Record<string, unknown>);
  for (const error of 'errors' in result ? (result.errors ?? []) : []) {
    const name = /Variable "\$([^"]+)"/.exec(error.message)?.[1] ?? '';
    out.push({ severity: 'error', message: error.message, range: keyRange(text, name) });
  }
  return out;
}

/** The query's and the variables' diagnostics, and the names of the document's operations. */
export function graphqlDiagnostics(
  schema: GraphQLSchema | undefined,
  input: GraphqlAssistInput,
): { query: GraphqlDiagnosticWire[]; variables: GraphqlDiagnosticWire[]; operations: string[] } {
  if (input.query.length > MAX_TEXT || (input.variables?.length ?? 0) > MAX_TEXT) {
    return { query: [], variables: [], operations: [] };
  }
  const query = getDiagnostics(input.query, schema).map((diagnostic): GraphqlDiagnosticWire => ({
    severity:
      diagnostic.severity === DIAGNOSTIC_SEVERITY.Error
        ? 'error'
        : diagnostic.severity === DIAGNOSTIC_SEVERITY.Warning
          ? 'warning'
          : 'info',
    message: markdownOf(diagnostic.message),
    range: toRange(diagnostic.range),
  }));
  const document = parsed(input.query);
  const operations = operationsOf(document)
    .map((operation) => operation.name?.value)
    .filter((name): name is string => name !== undefined);
  return {
    query,
    variables: variableDiagnostics(schema, selectedOperation(document, input.operationName), input.variables ?? ''),
    operations,
  };
}

const KIND_NAMES: Readonly<Partial<Record<number, GraphqlCompletionItemWire['kind']>>> = {
  [CompletionItemKind.Field]: 'field',
  [CompletionItemKind.Class]: 'type',
  [CompletionItemKind.Interface]: 'type',
  [CompletionItemKind.Struct]: 'type',
  [CompletionItemKind.TypeParameter]: 'type',
  [CompletionItemKind.Variable]: 'variable',
  [CompletionItemKind.Function]: 'directive',
  [CompletionItemKind.EnumMember]: 'enum',
  [CompletionItemKind.Enum]: 'enum',
  [CompletionItemKind.Keyword]: 'keyword',
  [CompletionItemKind.Snippet]: 'keyword',
  [CompletionItemKind.Reference]: 'fragment',
};

/** Completion in the query at a 1-based line and column. */
export function graphqlQueryCompletion(
  schema: GraphQLSchema | undefined,
  query: string,
  line: number,
  column: number,
): GraphqlCompletionItemWire[] {
  if (schema === undefined || query.length > MAX_TEXT) return [];
  return getAutocompleteSuggestions(schema, query, new Position(line - 1, column - 1))
    .slice(0, MAX_ITEMS)
    .map((item) => ({
      label: item.label,
      kind: (item.kind !== undefined ? KIND_NAMES[item.kind] : undefined) ?? 'other',
      ...(item.detail !== undefined && item.detail !== null ? { detail: String(item.detail) } : {}),
      ...(item.documentation !== undefined && markdownOf(item.documentation) !== ''
        ? { documentation: markdownOf(item.documentation) }
        : {}),
      ...(item.insertText !== undefined && item.insertTextFormat !== 2 ? { insertText: item.insertText } : {}),
    }));
}

/** Completion of the selected operation's variable names, as JSON keys. */
export function graphqlVariableCompletion(input: GraphqlAssistInput): GraphqlCompletionItemWire[] {
  const operation = selectedOperation(parsed(input.query), input.operationName);
  return (operation?.variableDefinitions ?? []).map((definition) => {
    const name = definition.variable.name.value;
    const type = printType(definition.type);
    return { label: name, kind: 'variable' as const, detail: type, insertText: `"${name}": ` };
  });
}

/** A variable's declared type as written, `[ID!]!`. */
function printType(type: TypeNode): string {
  switch (type.kind) {
    case Kind.NON_NULL_TYPE:
      return `${printType(type.type)}!`;
    case Kind.LIST_TYPE:
      return `[${printType(type.type)}]`;
    default:
      return type.name.value;
  }
}

/** A language-service hover's contents as plain Markdown. */
function markdownOf(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(markdownOf).join('\n\n');
  if (contents !== null && typeof contents === 'object' && 'value' in contents) {
    return String((contents as { readonly value: unknown }).value);
  }
  return '';
}

/** Hover documentation at a 1-based line and column, as Markdown; `null` when there is none. */
export function graphqlHover(
  schema: GraphQLSchema | undefined,
  query: string,
  line: number,
  column: number,
): string | null {
  if (schema === undefined || query.length > MAX_TEXT) return null;
  const hover = getHoverInformation(schema, query, new Position(line - 1, column - 1));
  const text = markdownOf(hover);
  return text.trim() === '' ? null : text;
}
