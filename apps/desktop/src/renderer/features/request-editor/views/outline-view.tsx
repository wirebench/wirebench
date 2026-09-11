import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
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
  /** Path passed to `xml.describeMany` — the owning element's ancestor chain, `@name`-suffixed for an attribute. */
  readonly typePath: readonly string[] | undefined;
  readonly hasChildren: boolean;
  /** Id of the row one level up — the parent element, or (for an attribute) the element that owns it. */
  readonly parentRowId: string | undefined;
  readonly level: number;
  readonly setSize: number;
  readonly posInSet: number;
}

const ROW_HEIGHT = 24;

function clarkPath(ancestors: readonly OutlineNode[]): string[] {
  return ancestors.map((n) => `{${n.namespaceUri ?? ''}}${n.localName}`);
}

/** Flattens the tree into display rows (attribute rows first, then child elements), skipping collapsed subtrees. */
function flatten(
  node: OutlineNode,
  depth: number,
  ancestors: readonly OutlineNode[],
  parentRowId: string | undefined,
  posInSet: number,
  setSize: number,
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
    typePath: clarkPath([...ancestors, node]),
    hasChildren: hasKids,
    parentRowId,
    level: depth + 1,
    setSize,
    posInSet,
  });
  if (collapsed.has(node.id)) {
    return;
  }
  const siblingCount = node.attributes.length + node.children.length;
  let index = 0;
  for (const attr of node.attributes) {
    index += 1;
    out.push(attrRow(node.id, node, attr, depth + 1, index, siblingCount));
  }
  for (const child of node.children) {
    index += 1;
    flatten(child, depth + 1, [...ancestors, node], node.id, index, siblingCount, collapsed, out);
  }
}

function attrRow(
  parentId: string,
  parent: OutlineNode,
  attr: OutlineAttr,
  depth: number,
  posInSet: number,
  setSize: number,
): Row {
  return {
    id: `${parentId}@${attr.name}`,
    kind: 'attribute',
    depth,
    label: `@${attr.name}`,
    value: attr.value,
    editableRange: attr.valueRange,
    typePath: [...clarkPath([parent]), `@${attr.name}`],
    hasChildren: false,
    parentRowId: parentId,
    level: depth + 1,
    setSize,
    posInSet,
  };
}

/** One editable/read-only value cell: controlled by the parent row so keyboard nav can drive it into edit mode. */
function ValueCell({
  value,
  readOnly,
  editing,
  onRequestEdit,
  onCommit,
  onCancel,
  inputRef,
}: {
  readonly value: string;
  readonly readOnly: boolean;
  readonly editing: boolean;
  readonly onRequestEdit: () => void;
  readonly onCommit: (next: string) => void;
  readonly onCancel: () => void;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState(value);

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
  }, [editing, inputRef]);

  if (readOnly) {
    return <span className="truncate text-fg-default">{value}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        tabIndex={-1}
        className="w-full truncate rounded-sm px-1 text-left text-fg-default hover:bg-surface-hover"
        onClick={() => onRequestEdit()}
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
        if (draft !== value) {
          onCommit(draft);
        } else {
          onCancel();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (draft !== value) {
            onCommit(draft);
          } else {
            onCancel();
          }
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setDraft(value);
          onCancel();
        }
      }}
      className="w-full rounded-sm bg-surface-base px-1 text-fg-default outline-none ring-1 ring-accent"
    />
  );
}

// A tiny per-interface LRU of resolved `xml.describeMany` results, keyed by the joined
// `typePath`. Editing a value re-parses the whole document into a fresh tree on every
// keystroke, but the ancestor paths of unchanged nodes are unchanged too — without this cache
// every edit would re-fetch the type of every visible row from main over IPC. Capped so a
// session spent skimming many large envelopes can't grow this without bound.
const MAX_CACHE_INTERFACES = 8;
const describeCache = new Map<string, Map<string, DescribeResult | null>>();

function cacheFor(interfaceId: string): Map<string, DescribeResult | null> {
  let entry = describeCache.get(interfaceId);
  if (entry === undefined) {
    entry = new Map();
    describeCache.set(interfaceId, entry);
    if (describeCache.size > MAX_CACHE_INTERFACES) {
      const oldest = describeCache.keys().next().value;
      if (oldest !== undefined) {
        describeCache.delete(oldest);
      }
    }
  } else {
    // Re-touch: keep it fresh in insertion order so eviction drops the least-recently-used.
    describeCache.delete(interfaceId);
    describeCache.set(interfaceId, entry);
  }
  return entry;
}

/**
 * Outline: an element/attribute tree with Name, Value (inline-editable) and Type
 * columns. Never adds or removes nodes — every edit calls `onEdit` with the exact range to
 * replace in the underlying XML text, which the caller writes back via `applyValueEdit`.
 *
 * Rows are virtualised (fixed-height, `@tanstack/react-virtual`) so a large envelope only ever
 * mounts the rows near the viewport, and the tree supports full roving-tabindex keyboard
 * navigation (arrow keys, Home/End, Enter/F2 to edit, Escape to cancel) per WAI-ARIA treeview
 * conventions.
 */
export function OutlineView({ xml, interfaceId, describeSource, readOnly, onEdit, onSelectRange }: OutlineViewProps) {
  const { root, problems } = useMemo(() => parseXmlOutline(xml), [xml]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [types, setTypes] = useState<ReadonlyMap<string, DescribeResult | null>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const rowNodes = useRef<Map<string, HTMLDivElement>>(new Map());

  const rows = useMemo(() => {
    if (root === undefined) {
      return [];
    }
    const out: Row[] = [];
    flatten(root, 0, [], undefined, 1, 1, collapsed, out);
    return out;
  }, [root, collapsed]);

  const clampedActiveIndex = rows.length === 0 ? 0 : Math.min(activeIndex, rows.length - 1);
  const rowById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // Before the real `ResizeObserver` measurement lands (and always, in `jsdom`, which never
    // reports a real size), fall back to a reasonable viewport height rather than 0 — otherwise
    // the very first paint (and every render in a layout-less test environment) would mount
    // only a single row.
    initialRect: { width: 0, height: 600 },
  });

  // Batches every uncached path into one `xml.describeMany` call per parse, rather than one
  // round trip per row — and skips the call entirely once every visible path is already cached
  // for this interface (e.g. re-parsing after an edit to a sibling value).
  useEffect(() => {
    if (root === undefined || interfaceId === undefined) {
      setTypes(new Map());
      return;
    }
    const cache = cacheFor(interfaceId);
    const wanted = new Map<string, readonly string[]>();
    for (const row of rows) {
      if (row.typePath !== undefined) {
        wanted.set(row.typePath.join('>'), row.typePath);
      }
    }
    const missingKeys: string[] = [];
    const missingPaths: (readonly string[])[] = [];
    for (const [key, path] of wanted) {
      if (!cache.has(key)) {
        missingKeys.push(key);
        missingPaths.push(path);
      }
    }
    // Publish whatever is already cached immediately, so switching back to an already-seen
    // interface/path set doesn't flash a blank Type column while nothing new is even fetched.
    const fromCache = new Map<string, DescribeResult | null>();
    for (const key of wanted.keys()) {
      if (cache.has(key)) {
        fromCache.set(key, cache.get(key) ?? null);
      }
    }
    setTypes(fromCache);
    if (missingPaths.length === 0) {
      return;
    }
    const source: DescribeManySource = describeSource ?? ipc().xml;
    let cancelled = false;
    void source.describeMany({ interfaceId, paths: missingPaths }).then((result) => {
      if (cancelled || !result.ok) {
        return;
      }
      result.value.results.forEach((item, index) => {
        const key = missingKeys[index];
        if (key !== undefined) {
          cache.set(key, item);
        }
      });
      const next = new Map<string, DescribeResult | null>();
      for (const key of wanted.keys()) {
        next.set(key, cache.get(key) ?? null);
      }
      setTypes(next);
    });
    return () => {
      cancelled = true;
    };
  }, [rows, root, interfaceId, describeSource]);

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectRow = useCallback(
    (row: Row) => {
      setSelectedId(row.id);
      const index = rowById.get(row.id);
      if (index !== undefined) {
        setActiveIndex(index);
      }
      if (row.editableRange !== undefined) {
        onSelectRange?.(row.editableRange);
      }
    },
    [rowById, onSelectRange],
  );

  const moveTo = useCallback(
    (index: number) => {
      if (rows.length === 0) {
        return;
      }
      const clamped = Math.max(0, Math.min(index, rows.length - 1));
      setActiveIndex(clamped);
      virtualizer.scrollToIndex(clamped, { align: 'auto' });
      const target = rows[clamped];
      if (target !== undefined) {
        setSelectedId(target.id);
      }
    },
    [rows, virtualizer],
  );

  // Roving tabindex needs real DOM focus to follow the active row when it moves by keyboard.
  // Virtualization means the target row's node may not exist the instant `activeIndex` changes
  // (it can be scrolled out of the mounted window), so this keeps retrying on every render until
  // the node shows up — but only while focus is already inside the tree, so it never steals
  // focus away from a value cell's `<input>` mid-edit or from unrelated UI.
  useEffect(() => {
    if (editingId !== undefined) {
      return;
    }
    if (treeRef.current === null || !treeRef.current.contains(document.activeElement)) {
      return;
    }
    const target = rows[clampedActiveIndex];
    if (target === undefined) {
      return;
    }
    const node = rowNodes.current.get(target.id);
    if (node !== undefined && document.activeElement !== node) {
      node.focus();
    }
  });

  const beginEdit = useCallback(
    (row: Row) => {
      if (readOnly || row.editableRange === undefined) {
        return;
      }
      setEditingId(row.id);
    },
    [readOnly],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (editingId !== undefined) {
      return;
    }
    const row = rows[clampedActiveIndex];
    if (row === undefined) {
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveTo(clampedActiveIndex + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(clampedActiveIndex - 1);
        return;
      case 'Home':
        event.preventDefault();
        moveTo(0);
        return;
      case 'End':
        event.preventDefault();
        moveTo(rows.length - 1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (row.kind === 'element' && row.hasChildren) {
          if (collapsed.has(row.id)) {
            toggleCollapsed(row.id);
          } else {
            moveTo(clampedActiveIndex + 1);
          }
        }
        return;
      case 'ArrowLeft':
        event.preventDefault();
        if (row.kind === 'element' && row.hasChildren && !collapsed.has(row.id)) {
          toggleCollapsed(row.id);
          return;
        }
        if (row.parentRowId !== undefined) {
          const parentIndex = rowById.get(row.parentRowId);
          if (parentIndex !== undefined) {
            moveTo(parentIndex);
          }
        }
        return;
      case 'Enter':
      case 'F2':
        event.preventDefault();
        beginEdit(row);
        return;
      default:
        return;
    }
  };

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
        <p className="shrink-0 border-b border-hairline px-2 py-1 text-xs text-status-warning" role="status">
          {problems.length} problem(s) parsing this document — showing a best-effort tree.
        </p>
      )}
      <div className="flex shrink-0 border-b border-hairline px-2 py-1 text-xs font-medium text-fg-subtle">
        <span className="flex-[2]">Name</span>
        <span className="flex-[3]">Value</span>
        <span className="flex-[2]">Type</span>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <div
          ref={treeRef}
          role="tree"
          aria-label={readOnly ? 'Response outline' : 'Request outline'}
          onKeyDown={onKeyDown}
          style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) {
              return null;
            }
            const type = row.typePath !== undefined ? types.get(row.typePath.join('>')) : undefined;
            const isOpen = !collapsed.has(row.id);
            const isActive = item.index === clampedActiveIndex;
            const isEditing = editingId === row.id;
            return (
              <div
                key={row.id}
                ref={(node) => {
                  if (node === null) {
                    rowNodes.current.delete(row.id);
                  } else {
                    rowNodes.current.set(row.id, node);
                  }
                }}
                role="treeitem"
                data-testid="outline-row"
                data-row-id={row.id}
                aria-selected={row.id === selectedId}
                aria-expanded={row.kind === 'element' && row.hasChildren ? isOpen : undefined}
                aria-level={row.level}
                aria-setsize={row.setSize}
                aria-posinset={row.posInSet}
                tabIndex={isActive ? 0 : -1}
                className={`flex items-center gap-1 px-1 py-0.5 text-sm ${
                  row.id === selectedId ? 'bg-accent-muted' : 'hover:bg-surface-raised'
                }`}
                style={{
                  position: 'absolute',
                  top: item.start,
                  left: 0,
                  right: 0,
                  height: item.size,
                  paddingLeft: row.depth * 16 + 4,
                }}
                onClick={() => selectRow(row)}
              >
                {row.kind === 'element' && row.hasChildren ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={isOpen ? `Collapse ${row.label}` : `Expand ${row.label}`}
                    className="w-3 shrink-0 text-fg-subtle"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleCollapsed(row.id);
                    }}
                  >
                    {isOpen ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span
                  className={`flex-[2] truncate ${row.kind === 'attribute' ? 'text-fg-subtle' : 'text-fg-default'}`}
                >
                  {row.label}
                </span>
                <span className="flex-[3] min-w-0">
                  {row.editableRange !== undefined ? (
                    <ValueCell
                      value={row.value ?? ''}
                      readOnly={readOnly}
                      editing={isEditing}
                      onRequestEdit={() => beginEdit(row)}
                      onCancel={() => setEditingId(undefined)}
                      onCommit={(next) => {
                        setEditingId(undefined);
                        onEdit?.(row.editableRange as TextRange, next);
                      }}
                      inputRef={editInputRef}
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
    </div>
  );
}
