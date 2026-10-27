/**
 * The GraphQL editor's language features (#77): completion, hover and diagnostics for the query, and
 * completion and checks for its variables, all answered by main against the API's schema.
 *
 * The renderer loads no GraphQL code: Monaco only tokenises (`monaco-core.ts` registers the grammar),
 * and the providers here ask main over IPC, as the request scripts' do. They are registered once per
 * language and consult a registry keyed by model URI, so a GraphQL body's two editors are answered and
 * every other JSON model is left alone.
 */
import type * as Monaco from 'monaco-editor';
import { ipc } from '../../state/ipc-client.js';
import type { GraphqlCompletionItemWire, GraphqlDiagnosticWire } from '@shared/kinds/graphql/wire.js';

/** The Monaco language id of a GraphQL query. */
export const GRAPHQL_LANGUAGE_ID = 'graphql';

/** The owner Monaco files a GraphQL body's markers under. */
export const GRAPHQL_MARKER_OWNER = 'wirebench-graphql';

/** What the editors of one GraphQL body hold now, unsaved, and the API whose schema answers. */
export interface GraphqlEditorContext {
  readonly apiId?: string | undefined;
  readonly query: string;
  readonly variables: string;
  readonly operationName?: string | undefined;
}

/** Which of a body's two editors a model is, and how to read the body as it stands. */
interface GraphqlModelEntry {
  readonly role: 'query' | 'variables';
  readonly context: () => GraphqlEditorContext;
}

const entries = new Map<string, GraphqlModelEntry>();

/** The model paths of a request's GraphQL editors: one query model and one variables model per request. */
export function graphqlModelPaths(requestId: string): { readonly query: string; readonly variables: string } {
  const base = `wirebench-graphql/${encodeURIComponent(requestId)}`;
  return { query: `${base}/query.graphql`, variables: `${base}/variables.json` };
}

/** Points the providers at `context` for the model at `modelUri`. */
export function setGraphqlModel(
  modelUri: string,
  role: 'query' | 'variables',
  context: () => GraphqlEditorContext,
): void {
  entries.set(modelUri, { role, context });
}

/** Forgets the model at `modelUri`. */
export function clearGraphqlModel(modelUri: string): void {
  entries.delete(modelUri);
}

/** The assist request for `context`, without the fields that are blank. */
function assistRequest(context: GraphqlEditorContext) {
  return {
    query: context.query,
    variables: context.variables,
    ...(context.apiId !== undefined ? { apiId: context.apiId } : {}),
    ...(context.operationName !== undefined && context.operationName !== ''
      ? { operationName: context.operationName }
      : {}),
  };
}

/** Monaco's kind for a GraphQL completion kind. */
export function graphqlCompletionKindOf(
  kinds: typeof Monaco.languages.CompletionItemKind,
  kind: GraphqlCompletionItemWire['kind'],
): number {
  switch (kind) {
    case 'field':
      return kinds.Field;
    case 'type':
      return kinds.Class;
    case 'argument':
    case 'variable':
      return kinds.Variable;
    case 'fragment':
      return kinds.Module;
    case 'directive':
      return kinds.Function;
    case 'enum':
      return kinds.EnumMember;
    case 'keyword':
      return kinds.Keyword;
    default:
      return kinds.Text;
  }
}

/** A GraphQL diagnostic as a Monaco marker. */
export function toGraphqlMarker(
  severities: typeof Monaco.MarkerSeverity,
  diagnostic: GraphqlDiagnosticWire,
): Monaco.editor.IMarkerData {
  const { range } = diagnostic;
  return {
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: Math.max(range.endColumn, range.startLine === range.endLine ? range.startColumn + 1 : 1),
    message: diagnostic.message,
    source: 'graphql',
    severity:
      diagnostic.severity === 'error'
        ? severities.Error
        : diagnostic.severity === 'warning'
          ? severities.Warning
          : severities.Info,
  };
}

/**
 * Asks main to check the body in `context`, puts the answer on the two models as markers, and
 * returns the document's named operations (for the operation picker). `undefined` when the answer
 * did not come, or came for text a model no longer holds: a later check is already on its way.
 */
export async function refreshGraphqlDiagnostics(
  monacoNS: typeof Monaco | undefined,
  models: { readonly query?: Monaco.editor.ITextModel | null; readonly variables?: Monaco.editor.ITextModel | null },
  context: GraphqlEditorContext,
): Promise<readonly string[] | undefined> {
  const versions = {
    query: models.query?.getVersionId(),
    variables: models.variables?.getVersionId(),
  };
  const result = await ipc().request.graphqlDiagnostics(assistRequest(context));
  if (!result.ok) {
    return undefined;
  }
  const stale = (['query', 'variables'] as const).some((role) => {
    const model = models[role];
    return model != null && (model.isDisposed() || model.getVersionId() !== versions[role]);
  });
  if (stale) {
    return undefined;
  }
  // The jsdom test double for Monaco carries no `editor` namespace; there is nothing to mark then.
  if (monacoNS !== undefined && typeof (monacoNS as Partial<typeof Monaco>).editor?.setModelMarkers === 'function') {
    for (const role of ['query', 'variables'] as const) {
      const model = models[role];
      if (model != null) {
        monacoNS.editor.setModelMarkers(
          model,
          GRAPHQL_MARKER_OWNER,
          result.value[role].map((diagnostic) => toGraphqlMarker(monacoNS.MarkerSeverity, diagnostic)),
        );
      }
    }
  }
  return result.value.operations;
}

let registered = false;

/**
 * Registers the providers once per renderer process: completion and hover for GraphQL models, and
 * completion for the JSON models that hold a GraphQL body's variables. Monaco's providers are
 * process-global, so a second registration would answer everything twice.
 */
export function registerGraphqlLanguageOnce(monacoNS: typeof Monaco): void {
  if (registered) {
    return;
  }
  registered = true;
  const complete = async (
    model: Monaco.editor.ITextModel,
    position: Monaco.Position,
    role: 'query' | 'variables',
  ): Promise<Monaco.languages.CompletionList> => {
    const entry = entries.get(model.uri.toString());
    if (entry?.role !== role) {
      return { suggestions: [] };
    }
    const result = await ipc().request.graphqlComplete({
      ...assistRequest(entry.context()),
      target: role,
      line: position.lineNumber,
      column: position.column,
    });
    if (!result.ok) {
      return { suggestions: [] };
    }
    const word = model.getWordUntilPosition(position);
    const range = {
      startLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endLineNumber: position.lineNumber,
      endColumn: word.endColumn,
    };
    // A variable's key is offered with its quotes; after a quote already typed, the item brings only
    // the rest.
    const quoted = role === 'variables' && model.getLineContent(position.lineNumber)[word.startColumn - 2] === '"';
    const insertOf = (item: GraphqlCompletionItemWire): string => {
      const text = item.insertText ?? item.label;
      return quoted && text.startsWith('"') ? text.slice(1) : text;
    };
    return {
      suggestions: result.value.items.map((item) => ({
        label: item.label,
        kind: graphqlCompletionKindOf(monacoNS.languages.CompletionItemKind, item.kind),
        insertText: insertOf(item),
        range,
        ...(item.detail !== undefined ? { detail: item.detail } : {}),
        ...(item.documentation !== undefined ? { documentation: { value: item.documentation } } : {}),
      })),
    };
  };
  monacoNS.languages.registerCompletionItemProvider(GRAPHQL_LANGUAGE_ID, {
    triggerCharacters: ['{', '(', ':', '$', '@', ' '],
    provideCompletionItems: (model, position) => complete(model, position, 'query'),
  });
  monacoNS.languages.registerCompletionItemProvider('json', {
    triggerCharacters: ['"', '{', ','],
    provideCompletionItems: (model, position) => complete(model, position, 'variables'),
  });
  monacoNS.languages.registerHoverProvider(GRAPHQL_LANGUAGE_ID, {
    async provideHover(model, position) {
      const entry = entries.get(model.uri.toString());
      if (entry?.role !== 'query') {
        return null;
      }
      const result = await ipc().request.graphqlHover({
        ...assistRequest(entry.context()),
        line: position.lineNumber,
        column: position.column,
      });
      const markdown = result.ok ? result.value.markdown : null;
      return markdown === null || markdown === '' ? null : { contents: [{ value: markdown }] };
    },
  });
}
