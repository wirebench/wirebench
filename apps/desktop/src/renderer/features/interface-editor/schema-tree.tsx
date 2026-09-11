/**
 * The Schema tab's left-hand tree: every namespace of the definition's schema set, its five
 * component groups, and the global components themselves.
 *
 * Flat ARIA tree (`role="tree"` over `role="treeitem"` rows carrying `aria-level`) rather than
 * nested lists: the rows are already a flat, virtualisable sequence, and a screen reader gets
 * the same structure from the levels. Keyboard model per the APG — Up/Down move, Right expands
 * or steps into the first child, Left collapses or steps out to the parent, Enter selects —
 * with a roving tabindex so the tree is a single tab stop, like the attachments grid.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SchemaComponentKind, SchemaComponentWire, SchemaNamespaceWire } from '../../../shared/wire-types.js';
import type { SchemaSelection } from './interface-editor-state.js';

/** The five component groups a namespace is shown as, in display order. */
export const GROUPS: readonly { readonly kind: SchemaComponentKind; readonly label: string }[] = [
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

/** One visible row of the tree, flattened out of the namespaces and the expansion state. */
export interface SchemaTreeRow {
  readonly id: string;
  /** 1 for a namespace, 2 for a component group, 3 for a component. */
  readonly level: 1 | 2 | 3;
  readonly label: string;
  /** Absent on a component row, which is a leaf. */
  readonly expandable: boolean;
  readonly namespace: string;
  readonly kind?: SchemaComponentKind;
  readonly name?: string;
}

/** Stable id of one component row — also the selection's identity. */
export function componentRowId(namespace: string, kind: SchemaComponentKind, name: string): string {
  return `${namespace}|${kind}|${name}`;
}

/**
 * The rows a tree over `namespaces` shows. Expansion is tracked as the set of *collapsed*
 * nodes: a definition usually declares one or two namespaces, and an all-collapsed tree would
 * hide the components the tab exists to show — so everything starts open, including the
 * namespaces of a schema index that has not arrived yet.
 */
export function visibleRows(
  namespaces: readonly SchemaNamespaceWire[],
  collapsed: ReadonlySet<string>,
): readonly SchemaTreeRow[] {
  const rows: SchemaTreeRow[] = [];
  for (const namespace of namespaces) {
    const namespaceId = `ns|${namespace.uri}`;
    rows.push({
      id: namespaceId,
      level: 1,
      label: namespace.uri === '' ? '(no namespace)' : namespace.uri,
      expandable: true,
      namespace: namespace.uri,
    });
    if (collapsed.has(namespaceId)) {
      continue;
    }
    for (const { kind, label } of GROUPS) {
      const components = componentsOf(namespace, kind);
      if (components.length === 0) {
        continue;
      }
      const groupId = `grp|${namespace.uri}|${kind}`;
      rows.push({ id: groupId, level: 2, label, expandable: true, namespace: namespace.uri, kind });
      if (collapsed.has(groupId)) {
        continue;
      }
      for (const component of components) {
        rows.push({
          id: componentRowId(namespace.uri, kind, component.name),
          level: 3,
          label: component.name,
          expandable: false,
          namespace: namespace.uri,
          kind,
          name: component.name,
        });
      }
    }
  }
  return rows;
}

/** The id of the row that owns `row` — a group for a component, a namespace for a group. */
function parentIdOf(row: SchemaTreeRow): string | undefined {
  if (row.level === 3 && row.kind !== undefined) {
    return `grp|${row.namespace}|${row.kind}`;
  }
  if (row.level === 2) {
    return `ns|${row.namespace}`;
  }
  return undefined;
}

/** Every node that has to be open for `selection`'s row to be visible. */
function ancestorsOf(selection: SchemaSelection): readonly string[] {
  return [`ns|${selection.namespace}`, `grp|${selection.namespace}|${selection.kind}`];
}

export interface SchemaTreeProps {
  readonly namespaces: readonly SchemaNamespaceWire[];
  readonly selection: SchemaSelection | undefined;
  readonly onSelect: (selection: Pick<SchemaSelection, 'namespace' | 'kind' | 'name'>) => void;
}

export function SchemaTree({ namespaces, selection, onSelect }: SchemaTreeProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const focusedRef = useRef<HTMLDivElement | null>(null);
  const shouldFocus = useRef(false);

  const selectedId =
    selection === undefined ? undefined : componentRowId(selection.namespace, selection.kind, selection.name);

  // A selection made elsewhere (go-to-definition) opens whatever hides its row.
  useEffect(() => {
    if (selection === undefined) {
      return;
    }
    setCollapsed((current) => {
      const hiding = ancestorsOf(selection).filter((id) => current.has(id));
      return hiding.length === 0 ? current : new Set([...current].filter((id) => !hiding.includes(id)));
    });
  }, [selection]);

  const rows = useMemo(() => visibleRows(namespaces, collapsed), [namespaces, collapsed]);
  const activeId = rows.some((row) => row.id === focusedId)
    ? focusedId
    : selectedId !== undefined && rows.some((row) => row.id === selectedId)
      ? selectedId
      : rows[0]?.id;

  useEffect(() => {
    focusedRef.current?.scrollIntoView({ block: 'nearest' });
    if (shouldFocus.current) {
      shouldFocus.current = false;
      focusedRef.current?.focus();
    }
  }, [activeId]);

  const isExpanded = useCallback((id: string) => !collapsed.has(id), [collapsed]);

  const toggle = useCallback((id: string, open: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (open) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const move = (row: SchemaTreeRow | undefined): void => {
    if (row === undefined) {
      return;
    }
    shouldFocus.current = true;
    setFocusedId(row.id);
  };

  const activate = (row: SchemaTreeRow): void => {
    if (row.expandable) {
      toggle(row.id, !isExpanded(row.id));
      return;
    }
    if (row.kind !== undefined && row.name !== undefined) {
      onSelect({ namespace: row.namespace, kind: row.kind, name: row.name });
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = rows.findIndex((row) => row.id === activeId);
    const row = rows[index];
    if (row === undefined) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(rows[index + 1]);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(rows[index - 1]);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (row.expandable && !isExpanded(row.id)) {
        toggle(row.id, true);
      } else {
        move(rows[index + 1]);
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (row.expandable && isExpanded(row.id)) {
        toggle(row.id, false);
        return;
      }
      const parentId = parentIdOf(row);
      move(rows.find((candidate) => candidate.id === parentId));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(row);
    }
  };

  return (
    <div
      role="tree"
      aria-label="Schema components"
      data-testid="schema-tree"
      className="w-80 shrink-0 overflow-auto border-r border-hairline p-1"
      onKeyDown={onKeyDown}
    >
      {rows.map((row) => {
        const selected = row.id === selectedId;
        return (
          <div
            key={row.id}
            role="treeitem"
            ref={row.id === activeId ? focusedRef : undefined}
            tabIndex={row.id === activeId ? 0 : -1}
            aria-level={row.level}
            aria-selected={selected}
            {...(row.expandable ? { 'aria-expanded': isExpanded(row.id) } : {})}
            data-testid={row.level === 3 ? 'schema-component' : row.level === 1 ? 'schema-namespace' : 'schema-group'}
            {...(row.level === 1 ? { 'data-uri': row.namespace } : {})}
            data-namespace={row.namespace}
            {...(row.kind !== undefined ? { 'data-kind': row.kind } : {})}
            {...(row.name !== undefined ? { 'data-name': row.name } : {})}
            onClick={() => {
              setFocusedId(row.id);
              activate(row);
            }}
            style={{ paddingLeft: `${String(row.level * 8)}px` }}
            className={`flex cursor-default items-center gap-1 truncate py-0.5 pr-2 text-left outline-none focus:ring-1 focus:ring-accent ${
              row.level === 1 ? 'font-mono text-xs' : 'text-sm'
            } ${selected ? 'bg-accent-muted text-fg-default' : 'text-fg-muted hover:bg-surface-raised'}`}
            title={row.level === 1 ? row.namespace : row.label}
          >
            {row.expandable && (
              <span aria-hidden="true" className="w-3 shrink-0 text-fg-subtle">
                {isExpanded(row.id) ? '▾' : '▸'}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
          </div>
        );
      })}
    </div>
  );
}
