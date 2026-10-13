/**
 * A GraphQL body (#77): the query, its variables, the operation to run, and the API's schema that the
 * editors check against.
 *
 * The schema toolbar fetches the schema through the request itself (main sends the introspection
 * query with the request's URL, headers and auth), imports it from a file, or clears it. The project
 * snapshot that follows carries the new schema reference, and the editors check again.
 */
import { useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { CodeEditor } from '../../editor/code-editor.js';
import {
  clearGraphqlModel,
  graphqlModelPaths,
  refreshGraphqlDiagnostics,
  registerGraphqlLanguageOnce,
  setGraphqlModel,
  type GraphqlEditorContext,
} from '../../editor/graphql-language.js';
import { SAVE_KEYBINDING, SEND_KEYBINDING } from '../../editor/monaco.js';
import { useDraftsStore } from '../../state/drafts.js';
import { ipc } from '../../state/ipc-client.js';
import type { GraphqlSchemaRefWire, RestBodyWire } from '../../../shared/kinds/rest/wire.js';

type GraphqlBodyWire = Extract<RestBodyWire, { kind: 'graphql' }>;

/** How long typing must pause before the editors are checked again. */
const DIAGNOSTICS_DEBOUNCE_MS = 300;

interface ModelRefs {
  query?: Monaco.editor.ITextModel | null;
  variables?: Monaco.editor.ITextModel | null;
}

export interface GraphqlBodyProps {
  readonly requestId: string;
  /** The API whose schema the editors use; absent for a webhook item, which is checked for syntax only. */
  readonly apiId?: string | undefined;
  /** The API's schema, as the project last recorded it. */
  readonly schema?: GraphqlSchemaRefWire | undefined;
  readonly body: GraphqlBodyWire;
  readonly onSet: (body: RestBodyWire) => void;
  readonly onSend?: (() => void) | undefined;
  readonly onSave?: (() => void) | undefined;
  /** Variable help in the editors (#340). */
  readonly attachVariables: (editor: Monaco.editor.IStandaloneCodeEditor, monacoNS: typeof Monaco) => void;
}

/** "Schema from <source>, <date>", or "No schema". */
export function schemaLabel(schema: GraphqlSchemaRefWire | undefined): string {
  if (schema === undefined) {
    return 'No schema';
  }
  const fetched = new Date(schema.fetchedAt);
  const when = Number.isNaN(fetched.getTime()) ? '' : `, ${fetched.toLocaleDateString()}`;
  return `Schema from ${schema.source}${when}`;
}

/** The GraphQL body editor. */
export function GraphqlBody({
  requestId,
  apiId,
  schema,
  body,
  onSet,
  onSend,
  onSave,
  attachVariables,
}: GraphqlBodyProps) {
  const paths = graphqlModelPaths(requestId);
  const [operations, setOperations] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const monacoRef = useRef<typeof Monaco | undefined>(undefined);
  const models = useRef<ModelRefs>({});
  // What the providers read: always the body as it stands now, not as it stood at mount.
  const context = useRef<GraphqlEditorContext>({ query: body.query, variables: body.variables });
  context.current = { apiId, query: body.query, variables: body.variables, operationName: body.operationName };

  // The providers stop answering for these models once the editor goes.
  useEffect(
    () => () => {
      for (const model of [models.current.query, models.current.variables]) {
        if (model != null) clearGraphqlModel(model.uri.toString());
      }
    },
    [],
  );

  // Checked as typed, once typing pauses, and again when the schema changes.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void refreshGraphqlDiagnostics(monacoRef.current, models.current, context.current).then((found) => {
        if (!cancelled && found !== undefined) setOperations(found);
      });
    }, DIAGNOSTICS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [apiId, schema?.fetchedAt, body.query, body.variables, body.operationName]);

  const run = async (
    action: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: { readonly message: string } }>,
    done: string,
  ): Promise<void> => {
    setBusy(true);
    try {
      const result = await action();
      showToast(result.ok ? done : result.error.message);
    } catch (failure: unknown) {
      showToast(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const fetchSchema = (): void => {
    if (apiId === undefined) return;
    const draft = useDraftsStore.getState().peekRestRequest(requestId);
    void run(
      () => ipc().request.graphqlIntrospect({ requestId, apiId, ...(draft !== undefined ? { draft } : {}) }),
      'Schema fetched',
    );
  };

  const importSchema = async (): Promise<void> => {
    if (apiId === undefined) return;
    const picked = await ipc().dialogs.openFile({
      title: 'Import GraphQL schema',
      filters: [{ name: 'GraphQL schema', extensions: ['graphql', 'graphqls', 'gql', 'json'] }],
    });
    if (!picked.ok || picked.value.path === undefined) return;
    const { path } = picked.value;
    await run(() => ipc().api.importGraphqlSchema({ apiId, path }), 'Schema imported');
  };

  const clearSchema = (): void => {
    if (apiId === undefined) return;
    void run(() => ipc().api.clearGraphqlSchema({ apiId }), 'Schema cleared');
  };

  const mount =
    (role: 'query' | 'variables') =>
    (editor: Monaco.editor.IStandaloneCodeEditor, monacoNS: typeof Monaco): void => {
      monacoRef.current = monacoNS;
      registerGraphqlLanguageOnce(monacoNS);
      const model = editor.getModel();
      models.current[role] = model;
      if (model !== null) {
        setGraphqlModel(model.uri.toString(), role, () => context.current);
      }
      editor.addCommand(SEND_KEYBINDING, () => {
        onSend?.();
      });
      editor.addCommand(SAVE_KEYBINDING, () => {
        onSave?.();
      });
      attachVariables(editor, monacoNS);
    };

  return (
    <div data-testid="rest-graphql" className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span data-testid="rest-graphql-schema" className="min-w-0 truncate text-xs text-fg-subtle">
          {apiId === undefined ? 'Syntax only' : schemaLabel(schema)}
        </span>
        {apiId !== undefined && (
          <>
            <Button variant="secondary" data-testid="rest-graphql-fetch" disabled={busy} onClick={fetchSchema}>
              Fetch schema
            </Button>
            <Button
              variant="secondary"
              data-testid="rest-graphql-import"
              disabled={busy}
              onClick={() => {
                void importSchema();
              }}
            >
              Import schema…
            </Button>
            {schema !== undefined && (
              <Button variant="secondary" data-testid="rest-graphql-clear" disabled={busy} onClick={clearSchema}>
                Clear
              </Button>
            )}
          </>
        )}
        {operations.length > 1 && (
          <select
            aria-label="Operation"
            data-testid="rest-graphql-operation"
            value={body.operationName ?? ''}
            className="h-row rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
            onChange={(event) => {
              const operationName = event.target.value;
              const next: GraphqlBodyWire = { kind: 'graphql', query: body.query, variables: body.variables };
              onSet(operationName === '' ? next : { ...next, operationName });
            }}
          >
            <option value="">Operation…</option>
            {operations.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div data-testid="rest-graphql-query" className="min-h-0 flex-[2]">
        <CodeEditor
          value={body.query}
          language="graphql"
          path={paths.query}
          ariaLabel="GraphQL query"
          onChange={(query) => {
            onSet({ ...body, query });
          }}
          onMount={mount('query')}
        />
      </div>
      <h3 className="shrink-0 text-xs font-medium tracking-wider text-fg-subtle uppercase">Variables</h3>
      <div data-testid="rest-graphql-variables" className="min-h-0 flex-1">
        <CodeEditor
          value={body.variables}
          language="json"
          path={paths.variables}
          ariaLabel="GraphQL variables"
          onChange={(variables) => {
            onSet({ ...body, variables });
          }}
          onMount={mount('variables')}
        />
      </div>
    </div>
  );
}
