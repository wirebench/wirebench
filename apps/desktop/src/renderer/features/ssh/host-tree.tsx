import { useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { ChevronDown, ChevronRight, Circle } from 'lucide-react';
import type { GroupEntryWire, HostEntryWire, HostsFileWire, ResolvedHostWire } from '../../../shared/ssh-wire.js';
import { connectToHost, DEFAULT_TERMINAL_SIZE } from './connect.js';
import {
  ancestorsOf,
  findHost,
  flattenGroups,
  freeId,
  moveHost,
  removeGroup,
  removeHost,
  upsertHost,
  useHostsStore,
} from './hosts-store.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

const STATUS = {
  idle: { label: 'not connected', color: 'text-fg-faint' },
  connecting: { label: 'connecting', color: 'text-status-warning' },
  open: { label: 'connected', color: 'text-status-success' },
  closed: { label: 'not connected', color: 'text-fg-faint' },
} as const;

/** A row for a host of the file; `resolved` adds the badge and is missing when the resolver could not place the host. */
function allHostIds(file: HostsFileWire): string[] {
  const out = file.hosts.map((h) => h.id);
  for (const { group } of flattenGroups(file)) out.push(...group.hosts.map((h) => h.id));
  return out;
}

function HostRow({
  host,
  resolved,
  depth,
}: {
  readonly host: HostEntryWire;
  readonly resolved: ResolvedHostWire | undefined;
  readonly depth: number;
}) {
  const { file, save, openDialog } = useHostsStore();
  const session = useHostsStore((s) => s.sessions[host.id]);
  const parent = ancestorsOf(file, 'host', host.id).at(-1);
  const targets = flattenGroups(file).filter(({ group }) => group.id !== parent?.id);
  const edit = (): void => {
    openDialog({ mode: 'edit-host', id: host.id });
  };
  const connect = (): void => {
    void connectToHost(host.id, DEFAULT_TERMINAL_SIZE);
  };
  const duplicate = (): void => {
    const entry = findHost(file, host.id);
    if (entry === undefined) return;
    void save(
      upsertHost(file, { ...entry, id: freeId(file, `${entry.id}-copy`), name: `${entry.name} copy` }, parent?.id),
    );
  };
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <li
          role="treeitem"
          aria-selected={false}
          tabIndex={0}
          data-testid={`host-row-${host.id}`}
          style={{ paddingLeft: `${String(depth * 12 + 8)}px` }}
          className="flex cursor-default items-center gap-2 rounded py-1 pr-2 text-sm hover:bg-surface-raised focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          onDoubleClick={connect}
          onKeyDown={(e) => {
            if (e.key === 'Enter') connect();
          }}
        >
          <Circle
            size={8}
            aria-label={STATUS[session?.state ?? 'idle'].label}
            className={`shrink-0 fill-current ${STATUS[session?.state ?? 'idle'].color}`}
          />
          <span className="truncate text-fg-default">{host.name}</span>
          <span className="truncate text-xs text-fg-subtle">{host.address}</span>
          {resolved === undefined ? (
            <span className="ml-auto shrink-0 rounded-full border border-status-warning px-1.5 text-xs text-status-warning">
              unresolved
            </span>
          ) : (
            resolved.incomplete !== undefined && (
              <span className="ml-auto shrink-0 rounded-full border border-status-warning px-1.5 text-xs text-status-warning">
                {`needs ${resolved.incomplete.field}`}
              </span>
            )
          )}
        </li>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg">
          <ContextMenu.Item className={ITEM_CLASS} onSelect={connect}>
            Connect
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={edit}>
            Edit…
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={duplicate}>
            Duplicate
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={ITEM_CLASS}>Move to…</ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg">
                {parent !== undefined && (
                  <ContextMenu.Item
                    className={ITEM_CLASS}
                    onSelect={() => {
                      void save(moveHost(file, host.id, undefined));
                    }}
                  >
                    (top level)
                  </ContextMenu.Item>
                )}
                {targets.map(({ group, depth: d }) => (
                  <ContextMenu.Item
                    key={group.id}
                    className={ITEM_CLASS}
                    style={{ paddingLeft: `${String(d * 12 + 8)}px` }}
                    onSelect={() => {
                      void save(moveHost(file, host.id, group.id));
                    }}
                  >
                    {group.name}
                  </ContextMenu.Item>
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void navigator.clipboard.writeText(host.address);
            }}
          >
            Copy address
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-hairline" />
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void save(removeHost(file, host.id));
            }}
          >
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function GroupNode(props: {
  readonly group: GroupEntryWire;
  readonly depth: number;
  readonly hostsById: ReadonlyMap<string, ResolvedHostWire>;
  readonly visible: ReadonlySet<string>;
  readonly narrowed: boolean;
  readonly collapsed: ReadonlySet<string>;
  readonly toggle: (id: string) => void;
}) {
  const { group, depth, hostsById, visible, narrowed, collapsed, toggle } = props;
  const { file, save, openDialog } = useHostsStore();
  const hasVisible = (g: GroupEntryWire): boolean =>
    g.hosts.some((h) => visible.has(h.id)) || g.groups.some(hasVisible);
  if (narrowed && !hasVisible(group)) return null;
  const isCollapsed = collapsed.has(group.id);
  const Chevron = isCollapsed ? ChevronRight : ChevronDown;
  const remove = (): void => {
    try {
      void save(removeGroup(file, group.id));
    } catch {
      // A non-empty group is refused by the helper; the menu says why through its disabled state.
    }
  };
  const empty = group.groups.length === 0 && group.hosts.length === 0;
  return (
    <li role="none">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            role="treeitem"
            aria-expanded={!isCollapsed}
            aria-selected={false}
            tabIndex={0}
            style={{ paddingLeft: `${String(depth * 12 + 4)}px` }}
            className="flex cursor-default items-center gap-1 rounded py-1 pr-2 text-sm font-medium text-fg-default hover:bg-surface-raised focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
            onClick={() => {
              toggle(group.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') toggle(group.id);
            }}
          >
            <Chevron size={13} aria-hidden className="shrink-0 text-fg-subtle" />
            <span className="truncate">{group.name}</span>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg">
            <ContextMenu.Item
              className={ITEM_CLASS}
              onSelect={() => {
                openDialog({ mode: 'edit-group', id: group.id });
              }}
            >
              Edit group…
            </ContextMenu.Item>
            <ContextMenu.Item
              className={ITEM_CLASS}
              onSelect={() => {
                openDialog({ mode: 'new-host', parent: group.id });
              }}
            >
              New host here…
            </ContextMenu.Item>
            <ContextMenu.Item
              className={ITEM_CLASS}
              onSelect={() => {
                openDialog({ mode: 'new-group', parent: group.id });
              }}
            >
              New subgroup…
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-hairline" />
            <ContextMenu.Item className={ITEM_CLASS} disabled={!empty} onSelect={remove}>
              Delete group
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {!isCollapsed && (
        <ul role="group">
          {group.groups.map((g) => (
            <GroupNode key={g.id} {...props} group={g} depth={depth + 1} />
          ))}
          {group.hosts.map((h) => {
            return visible.has(h.id) ? (
              <HostRow key={h.id} host={h} resolved={hostsById.get(h.id)} depth={depth + 1} />
            ) : null;
          })}
        </ul>
      )}
    </li>
  );
}

/** The groups and hosts of `hosts.yaml` as a collapsible tree; a filter or tag narrows it to what matches. */
export function HostTree() {
  const file = useHostsStore((s) => s.file);
  const resolved = useHostsStore((s) => s.resolved);
  const filter = useHostsStore((s) => s.filter);
  const selectedTags = useHostsStore((s) => s.selectedTags);
  const visibleHosts = useHostsStore((s) => s.visibleHosts);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const narrowed = filter.trim() !== '' || selectedTags.length > 0;
  const hostsById = new Map(resolved.map((h) => [h.id, h] as const));
  // A host the resolver did not place still shows (degraded) unless a filter is active: it has nothing to match on.
  const visible = new Set(visibleHosts().map((h) => h.id));
  if (!narrowed) for (const id of allHostIds(file)) visible.add(id);
  const toggle = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (file.groups.length === 0 && file.hosts.length === 0) {
    return <p className="p-3 text-sm text-fg-subtle">No hosts yet. Add one with New host.</p>;
  }
  return (
    <ul role="tree" aria-label="Hosts" className="flex flex-col">
      {file.groups.map((g) => (
        <GroupNode
          key={g.id}
          group={g}
          depth={0}
          hostsById={hostsById}
          visible={visible}
          narrowed={narrowed}
          collapsed={collapsed}
          toggle={toggle}
        />
      ))}
      {file.hosts.map((h) => {
        return visible.has(h.id) ? <HostRow key={h.id} host={h} resolved={hostsById.get(h.id)} depth={0} /> : null;
      })}
    </ul>
  );
}
