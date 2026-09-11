/**
 * The Interface editor's Schema tab: every namespace of the definition's schema set on the left
 * (elements, complex/simple types, groups, attribute groups), and the selected component's
 * declaration on the right — its source XML, sliced out of the document text the WSDL Content
 * tab already holds, with a "Go to source" that hands the position to that tab.
 *
 * Go-to-definition from the request editor lands here: `showSchemaDeclaration` selects the
 * component, and this panel scrolls it into view.
 */

import { useEffect, useMemo, useRef } from 'react';
import { Button } from '../../components/button.js';
import type { SchemaComponentKind, SchemaComponentWire, SchemaNamespaceWire } from '../../../shared/wire-types.js';
import { useInterfaceEditorStore, type SchemaSelection } from './interface-editor-state.js';
import { sourceSnippet } from './source-snippet.js';

export interface SchemaTabProps {
  readonly interfaceId: string;
}

/** The five component groups a namespace is shown as, in display order. */
const GROUPS: readonly { readonly kind: SchemaComponentKind; readonly label: string }[] = [
  { kind: 'element', label: 'Elements' },
  { kind: 'complexType', label: 'Complex types' },
  { kind: 'simpleType', label: 'Simple types' },
  { kind: 'group', label: 'Groups' },
  { kind: 'attributeGroup', label: 'Attribute groups' },
];

/** The components of `namespace` for one kind. */
export function componentsOf(
  namespace: SchemaNamespaceWire,
  kind: SchemaComponentKind,
): readonly SchemaComponentWire[] {
  switch (kind) {
    case 'element':
      return namespace.elements;
    case 'complexType':
      return namespace.complexTypes;
    case 'simpleType':
      return namespace.simpleTypes;
    case 'group':
      return namespace.groups;
    case 'attributeGroup':
      return namespace.attributeGroups;
    default:
      return [];
  }
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

function rowId(namespace: string, kind: SchemaComponentKind, name: string): string {
  return `${namespace}|${kind}|${name}`;
}

export function SchemaTab({ interfaceId }: SchemaTabProps) {
  const data = useInterfaceEditorStore((state) => state.data[interfaceId]);
  const selection = useInterfaceEditorStore((state) => state.selections[interfaceId]);
  const selectComponent = useInterfaceEditorStore((state) => state.selectComponent);
  const revealSource = useInterfaceEditorStore((state) => state.revealSource);
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  const namespaces = useMemo(() => data?.namespaces ?? [], [data]);
  const component = findComponent(namespaces, selection);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selection]);

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

  const documentText =
    data.documents?.documents.find((document) => document.location === component?.document)?.text ?? '';

  return (
    <div data-testid="interface-schema" className="flex h-full min-h-0">
      <div data-testid="schema-tree" className="w-80 shrink-0 overflow-auto border-r border-hairline p-1">
        {namespaces.map((namespace) => (
          <section key={namespace.uri} data-testid="schema-namespace" data-uri={namespace.uri} className="mb-2">
            <h3 className="truncate px-1 py-0.5 font-mono text-xs text-fg-subtle" title={namespace.uri}>
              {namespace.uri === '' ? '(no namespace)' : namespace.uri}
            </h3>
            {GROUPS.map(({ kind, label }) => {
              const components = componentsOf(namespace, kind);
              if (components.length === 0) {
                return null;
              }
              return (
                <div key={kind} className="mb-1">
                  <p className="px-2 text-xs tracking-wider text-fg-faint uppercase">{label}</p>
                  <ul aria-label={`${label} in ${namespace.uri}`}>
                    {components.map((entry) => {
                      const selected =
                        selection !== undefined &&
                        rowId(selection.namespace, selection.kind, selection.name) ===
                          rowId(namespace.uri, kind, entry.name);
                      return (
                        <li key={entry.name}>
                          <button
                            type="button"
                            ref={selected ? selectedRef : undefined}
                            data-testid="schema-component"
                            data-kind={kind}
                            data-name={entry.name}
                            aria-pressed={selected}
                            onClick={() =>
                              selectComponent(interfaceId, { namespace: namespace.uri, kind, name: entry.name })
                            }
                            className={`w-full truncate px-3 py-0.5 text-left text-sm ${
                              selected ? 'bg-accent-muted text-fg-default' : 'text-fg-muted hover:bg-surface-raised'
                            }`}
                          >
                            {entry.name}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </section>
        ))}
      </div>

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
              {sourceSnippet(documentText, component.line)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
}
