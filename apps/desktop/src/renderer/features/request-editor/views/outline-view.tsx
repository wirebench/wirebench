import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../../../components/empty-state.js';
import { ipc } from '../../../state/ipc-client.js';
import type { OutlineAttr, OutlineNode, TextRange } from './xml-model.js';
import { parseXmlOutline } from './xml-model.js';

/** One schema description as returned by `xml.describeMany`, keyed by Clark-notation ancestor path. */
interface DescribeResult {
  readonly typeName: string;
  readonly kind: 'element' | 'attribute';
  readonly nillable?: boolean | undefined;
  readonly documentation?: string | undefined;
}

/** The minimal `xml.describeMany` shape this view needs — matches `window.wirebench.xml`. */
export interface DescribeManySource {
  describeMany(request: {
    interfaceId: string;
    paths: readonly (readonly string[])[];
  }): Promise<{ ok: true; value: { results: readonly (DescribeResult | null)[] } } | { ok: false }>;
}

export interface OutlineViewProps {
  readonly xml: string;
  /** Which interface's schema to resolve the Type column against. Omit to leave it blank. */
  readonly interfaceId?: string | undefined;
  /** `xml.describeMany` by default; injectable for tests. */
  readonly describeSource?: DescribeManySource;
  /** Response outlines are read-only: no inline edit affordances render at all. */
  readonly readOnly: boolean;
  /** Fired when an inline edit commits: the exact range in `xml` to replace, and the new value. */
  readonly onEdit?: (range: TextRange, value: string) => void;
  /** Fired when a row is selected, so the XML view can reveal the same range later. */
  readonly onSelectRange?: (range: TextRange) => void;
}

/** One flattened display row: either an element (possibly with editable text) or an `@attr` row. */
interface Row {
  readonly id: string;
  readonly kind: 'element' | 'attribute';
  readonly depth: number;
  readonly label: string;
  readonly value: string | undefined;
  readonly editableRange: TextRange | undefined;
  readonly typePathKey: string | undefined;
  readonly hasChildren: boolean;
}

function clarkPath(ancestors: readonly OutlineNode[]): string[] {
  return ancestors.map((n) => `{${n.namespaceUri ?? ''}}${n.localName}`);
}

/** Flattens the tree into display rows (attribute rows first, then child elements), skipping collapsed subtrees. */
function flatten(
  node: OutlineNode,
  depth: number,
  ancestors: readonly OutlineNode[],
  collapsed: ReadonlySet<string>,
  out: Row[],
): void {
  const hasKids = node.attributes.length > 0 || node.children.length > 0;
  out.push({
    id: node.id,
    kind: 'element',
    depth,
    label: node.name,
    value: node.text?.value,
    editableRange: node.text?.range,
    typePathKey: clarkPath([...ancestors, node]).join('>'),
    hasChildren: hasKids,
  });
  if (collapsed.has(node.id)) {
    return;
  }
  for (const attr of node.attributes) {
    out.push(attrRow(node.id, attr, depth + 1));
  }
  for (const child of node.children) {
    flatten(child, depth + 1, [...ancestors, node], collapsed, out);
  }
}

function attrRow(parentId: string, attr: OutlineAttr, depth: number): Row {
  return {
    id: `${parentId}@${attr.name}`,
    kind: 'attribute',
    depth,
    label: `@${attr.name}`,
    value: attr.value,
    editableRange: attr.valueRange,
    typePathKey: undefined,
    hasChildren: false,
  };
}

/** One editable/read-only value cell: click or Enter/F2 opens an `<input>`; Escape cancels, Enter/blur commits. */
function ValueCell({
  value,
  readOnly,
  onCommit,
}: {
  readonly value: string;
  readonly readOnly: boolean;
  readonly onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
    }
  }, [editing, value]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (readOnly) {
    return <span className="truncate text-fg-default">{value}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="w-full truncate rounded-sm px-1 text-left text-fg-default hover:bg-surface-hover"
        onClick={() => setEditing(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault();
            setEditing(true);
          }
        }}
      >
        {value === '' ? <span className="text-fg-faint italic">(empty)</span> : value}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== value) {
          onCommit(draft);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          setEditing(false);
          if (draft !== value) {
            onCommit(draft);
          }
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      className="w-full rounded-sm bg-surface-base px-1 text-fg-default outline-none ring-1 ring-accent"
    />
  );
}

/**
 * SoapUI-parity Outline: an element/attribute tree with Name, Value (inline-editable) and Type
 * columns. Never adds or removes nodes — every edit calls `onEdit` with the exact range to
 * replace in the underlying XML text, which the caller writes back via `applyValueEdit`.
 */
export function OutlineView({ xml, interfaceId, describeSource, readOnly, onEdit, onSelectRange }: OutlineViewProps) {
  const { root, problems } = useMemo(() => parseXmlOutline(xml), [xml]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [types, setTypes] = useState<ReadonlyMap<string, DescribeResult | null>>(new Map());

  const rows = useMemo(() => {
    if (root === undefined) {
      return [];
    }
    const out: Row[] = [];
    flatten(root, 0, [], collapsed, out);
    return out;
  }, [root, collapsed]);

  // Batches every element's ancestor path into one `xml.describeMany` call per parse, rather
  // than one round trip per row — the outline can hold dozens of visible elements.
  useEffect(() => {
    if (root === undefined || interfaceId === undefined) {
      setTypes(new Map());
      return;
    }
    const source: DescribeManySource = describeSource ?? ipc().xml;
    const keys: string[] = [];
    const paths: string[][] = [];
    const collect = (node: OutlineNode, ancestors: readonly OutlineNode[]): void => {
      const chain = [...ancestors, node];
      const key = clarkPath(chain).join('>');
      keys.push(key);
      paths.push(clarkPath(chain));
      for (const child of node.children) {
        collect(child, chain);
      }
    };
    collect(root, []);
    let cancelled = false;
    void source.describeMany({ interfaceId, paths }).then((result) => {
      if (cancelled || !result.ok) {
        return;
      }
      const next = new Map<string, DescribeResult | null>();
      result.value.results.forEach((item, index) => {
        const key = keys[index];
        if (key !== undefined) {
          next.set(key, item);
        }
      });
      setTypes(next);
    });
    return () => {
      cancelled = true;
    };
  }, [root, interfaceId, describeSource, xml]);

  if (problems.length > 0 && root === undefined) {
    return (
      <EmptyState title="Can't outline this document" description={problems[0] ?? 'The XML could not be parsed.'} />
    );
  }
  if (root === undefined) {
    return <EmptyState title="Nothing to show" description="This request has no XML content yet." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {problems.length > 0 && (
        <p className="shrink-0 border-b border-hairline px-2 py-1 text-xs text-warning" role="status">
          {problems.length} problem(s) parsing this document — showing a best-effort tree.
        </p>
      )}
      <div className="flex shrink-0 border-b border-hairline px-2 py-1 text-xs font-medium text-fg-subtle">
        <span className="flex-[2]">Name</span>
        <span className="flex-[3]">Value</span>
        <span className="flex-[2]">Type</span>
      </div>
      <div
        role="tree"
        aria-label={readOnly ? 'Response outline' : 'Request outline'}
        className="min-h-0 flex-1 overflow-auto"
      >
        {rows.map((row) => {
          const type = row.typePathKey !== undefined ? types.get(row.typePathKey) : undefined;
          const isOpen = !collapsed.has(row.id);
          return (
            <div
              key={row.id}
              role="treeitem"
              data-testid="outline-row"
              data-row-id={row.id}
              aria-selected={row.id === selectedId}
              aria-expanded={row.kind === 'element' && row.hasChildren ? isOpen : undefined}
              tabIndex={-1}
              className={`flex items-center gap-1 px-1 py-0.5 text-sm ${
                row.id === selectedId ? 'bg-accent-muted' : 'hover:bg-surface-raised'
              }`}
              style={{ paddingLeft: row.depth * 16 + 4 }}
              onClick={() => {
                setSelectedId(row.id);
                if (row.editableRange !== undefined) {
                  onSelectRange?.(row.editableRange);
                }
              }}
            >
              {row.kind === 'element' && row.hasChildren ? (
                <button
                  type="button"
                  aria-label={isOpen ? `Collapse ${row.label}` : `Expand ${row.label}`}
                  className="w-3 shrink-0 text-fg-subtle"
                  onClick={(event) => {
                    event.stopPropagation();
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(row.id)) {
                        next.delete(row.id);
                      } else {
                        next.add(row.id);
                      }
                      return next;
                    });
                  }}
                >
                  {isOpen ? '▾' : '▸'}
                </button>
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span className={`flex-[2] truncate ${row.kind === 'attribute' ? 'text-fg-subtle' : 'text-fg-default'}`}>
                {row.label}
              </span>
              <span className="flex-[3] min-w-0">
                {row.editableRange !== undefined ? (
                  <ValueCell
                    value={row.value ?? ''}
                    readOnly={readOnly}
                    onCommit={(next) => onEdit?.(row.editableRange as TextRange, next)}
                  />
                ) : (
                  <span className="text-fg-faint italic">—</span>
                )}
              </span>
              <span className="flex-[2] truncate text-fg-subtle">
                {type?.typeName === '' ? '(anonymous)' : (type?.typeName ?? '')}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
