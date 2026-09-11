/**
 * The Interface editor's Schema tab: every namespace of the definition's schema set in the tree
 * on the left (see {@link SchemaTree}), and the selected component's declaration on the right —
 * its source XML, sliced out of that one document's text, which is fetched on demand
 * (`definition.documentText`) rather than shipped with the document list.
 *
 * Go-to-definition from the request editor lands here: `showSchemaDeclaration` selects the
 * component, and the tree scrolls it into view.
 */

import { useEffect } from 'react';
import { Button } from '../../components/button.js';
import type { SchemaComponentWire, SchemaNamespaceWire } from '../../../shared/wire-types.js';
import { useInterfaceEditorStore, type SchemaSelection } from './interface-editor-state.js';
import { componentsOf, SchemaTree } from './schema-tree.js';
import { sourceSnippet } from './source-snippet.js';

export interface SchemaTabProps {
  readonly interfaceId: string;
}

/** Finds the selected component in the index, or `undefined` when the selection is stale. */
export function findComponent(
  namespaces: readonly SchemaNamespaceWire[],
  selection: SchemaSelection | undefined,
): SchemaComponentWire | undefined {
  if (selection === undefined) {
    return undefined;
  }
  const namespace = namespaces.find((candidate) => candidate.uri === selection.namespace);
  return componentsOf(
    namespace ?? { uri: '', elements: [], complexTypes: [], simpleTypes: [], groups: [], attributeGroups: [] },
    selection.kind,
  ).find((component) => component.name === selection.name);
}

const NO_NAMESPACES: readonly SchemaNamespaceWire[] = [];

export function SchemaTab({ interfaceId }: SchemaTabProps) {
  const data = useInterfaceEditorStore((state) => state.data[interfaceId]);
  const selection = useInterfaceEditorStore((state) => state.selections[interfaceId]);
  const selectComponent = useInterfaceEditorStore((state) => state.selectComponent);
  const revealSource = useInterfaceEditorStore((state) => state.revealSource);
  const loadText = useInterfaceEditorStore((state) => state.loadText);

  const namespaces = data?.namespaces ?? NO_NAMESPACES;
  // A local element declaration is not a global component, so it is never in the tree; the
  // selection then carries its own source position and the detail panel renders from that.
  const component =
    findComponent(namespaces, selection) ??
    (selection?.document !== undefined
      ? {
          name: selection.name,
          document: selection.document,
          ...(selection.line !== undefined ? { line: selection.line } : {}),
        }
      : undefined);
  const location = component?.document;
  const documentText = useInterfaceEditorStore((state) =>
    location === undefined ? undefined : state.data[interfaceId]?.texts?.[location],
  );

  // Only the one document the snippet is cut from is fetched.
  useEffect(() => {
    if (location !== undefined) {
      void loadText(interfaceId, location);
    }
  }, [loadText, interfaceId, location]);

  if (data === undefined || data.status === 'loading') {
    return <p className="p-4 text-md text-fg-muted">Loading schema…</p>;
  }
  if (namespaces.length === 0) {
    return (
      <p data-testid="schema-empty" className="p-4 text-md text-fg-muted">
        {data.error ?? 'This definition declares no schema components.'}
      </p>
    );
  }

  return (
    <div data-testid="interface-schema" className="flex h-full min-h-0">
      <SchemaTree
        namespaces={namespaces}
        selection={selection}
        onSelect={(next) => {
          selectComponent(interfaceId, next);
        }}
      />

      <div data-testid="schema-detail" className="flex min-w-0 flex-1 flex-col p-3">
        {component === undefined || selection === undefined ? (
          <p className="text-md text-fg-muted">Select a schema component to see its declaration.</p>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p data-testid="schema-detail-name" className="truncate text-md text-fg-default">
                  {selection.name}
                </p>
                <p className="truncate font-mono text-xs text-fg-faint" title={component.document}>
                  {selection.kind} · {component.document}
                  {component.line !== undefined ? `:${String(component.line)}` : ''}
                </p>
              </div>
              <Button
                data-testid="schema-goto-source"
                onClick={() =>
                  revealSource(interfaceId, {
                    location: component.document,
                    ...(component.line !== undefined ? { line: component.line } : {}),
                  })
                }
              >
                Go to source
              </Button>
            </div>
            {component.typeName !== undefined && (
              <p className="mb-2 font-mono text-xs text-fg-muted">type: {component.typeName}</p>
            )}
            <pre
              data-testid="schema-detail-snippet"
              className="min-h-0 flex-1 overflow-auto rounded-md border border-hairline bg-surface-raised p-2 font-mono text-xs text-fg-default"
            >
              {documentText === undefined ? 'Loading source…' : sourceSnippet(documentText, component.line)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
