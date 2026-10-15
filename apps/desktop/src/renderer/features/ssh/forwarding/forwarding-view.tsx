import { useMemo, useState, type DragEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowLeftRight, FolderPlus, MoreHorizontal, Plus } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';
import type { ForwardStateWire } from '../../../../shared/forward-wire.js';
import type { ForwardGroupWire, ResolvedForwardWire, ResolvedHostWire } from '../../../../shared/ssh-wire.js';
import { flattenGroups, useHostsStore } from '../hosts-store.js';
import { forwardKey, routeOf } from './forward-format.js';
import { CONTENT_CLASS, ForwardRow, ITEM_CLASS } from './forward-row.js';
import {
  FORWARD_DRAG_TYPE,
  createGroup,
  deleteGroup,
  dropRule,
  groupStatus,
  groupStatusText,
  renameGroup,
  saveGroups,
  startGroup,
  stopGroup,
} from './forward-groups.js';
import { GroupNameDialog } from './group-name-dialog.js';
import { isLive, useForwardsStore } from './forwards-store.js';
import { NewRuleDialog } from './new-rule-dialog.js';
import { SshEmptyState, SshNoMatches, SshView, SshViewHeader } from '../ssh-view-frame.js';
import { SSH_VIEWS } from '../ssh-views.js';

/** One row of the view: a resolved rule of a host, with what runs of it in this window. */
export interface ForwardRowData {
  readonly key: string;
  readonly host: Pick<ResolvedHostWire, 'id' | 'name'>;
  readonly ruleId: string;
  readonly forward: ResolvedForwardWire | undefined;
  readonly state: ForwardStateWire | undefined;
}

/**
 * Every resolved rule of every host, in `hosts.yaml` order, then any forward still running whose rule (or
 * host) has gone from the file since it started: it must stay stoppable.
 */
export function forwardRows(
  resolved: readonly ResolvedHostWire[],
  byKey: Readonly<Record<string, ForwardStateWire>>,
): ForwardRowData[] {
  const rows: ForwardRowData[] = resolved.flatMap((host) =>
    host.forwards.map((forward) => {
      const key = forwardKey(host.id, forward.rule.id);
      return { key, host, ruleId: forward.rule.id, forward, state: byKey[key] };
    }),
  );
  const listed = new Set(rows.map((row) => row.key));
  for (const [key, state] of Object.entries(byKey)) {
    if (listed.has(key)) continue;
    const host = resolved.find((h) => h.id === state.hostId) ?? { id: state.hostId, name: state.hostId };
    rows.push({ key, host, ruleId: state.ruleId, forward: undefined, state });
  }
  return rows;
}

/**
 * The rows under each forwarding group, in the group's order, and the rest (Ungrouped). A member whose rule
 * has gone from `hosts.yaml` still gets a row, so it can be taken out of the group.
 */
export function groupSections(
  groups: readonly ForwardGroupWire[],
  rows: readonly ForwardRowData[],
  resolved: readonly ResolvedHostWire[],
  byKey: Readonly<Record<string, ForwardStateWire>>,
): { groups: { group: ForwardGroupWire; rows: ForwardRowData[] }[]; ungrouped: ForwardRowData[] } {
  const byRowKey = new Map(rows.map((row) => [row.key, row]));
  const grouped = new Set<string>();
  const sections = groups.map((group) => ({
    group,
    rows: group.rules.map((member): ForwardRowData => {
      const key = forwardKey(member.host, member.rule);
      grouped.add(key);
      const host = resolved.find((h) => h.id === member.host) ?? { id: member.host, name: member.host };
      return byRowKey.get(key) ?? { key, host, ruleId: member.rule, forward: undefined, state: byKey[key] };
    }),
  }));
  return { groups: sections, ungrouped: rows.filter((row) => !grouped.has(row.key)) };
}

type Chip = 'all' | 'running' | 'failed';

const CHIPS: readonly { readonly id: Chip; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'failed', label: 'Failed' },
];

function useGroupName(): (id: string) => string {
  const file = useHostsStore((s) => s.file);
  return useMemo(() => {
    const groups = flattenGroups(file);
    return (id: string) => groups.find(({ group }) => group.id === id)?.group.name ?? id;
  }, [file]);
}

function matches(row: ForwardRowData, needle: string): boolean {
  if (needle === '') return true;
  const rule = row.forward?.rule;
  const fields = [row.ruleId, row.host.name];
  if (rule !== undefined) fields.push(String(row.state?.port ?? rule.port), routeOf(rule, row.state?.port));
  return fields.some((field) => field.toLowerCase().includes(needle));
}

function RowList({
  rows,
  label,
  showHost,
  groupId,
  onNewGroup,
  onDragChange,
}: {
  rows: readonly ForwardRowData[];
  label: string;
  showHost: boolean;
  /** The forwarding group these rows are listed under, if any. */
  groupId?: string;
  onNewGroup?: (hostId: string, ruleId: string) => void;
  /** Rows can be dragged to another group; told the dragged row's key. */
  onDragChange?: (key: string | undefined) => void;
}) {
  const startErrors = useForwardsStore((s) => s.startErrors);
  const groupName = useGroupName();
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
      {rows.map((row) => (
        <ForwardRow
          key={row.key}
          host={row.host}
          forward={row.forward}
          ruleId={row.ruleId}
          state={row.state}
          startError={startErrors[row.key]}
          groupName={groupName}
          showHost={showHost}
          {...(groupId === undefined ? {} : { forwardGroupId: groupId })}
          {...(onNewGroup === undefined ? {} : { onNewGroup })}
          {...(onDragChange === undefined ? {} : { onDragChange })}
        />
      ))}
    </ul>
  );
}

/**
 * Makes a section a place to drop a dragged rule: on a group to move it there, on Ungrouped (`undefined`) to
 * take it out of its group. `over` is true while a rule is held over it.
 */
function useDropZone(groupId: string | undefined, onDropped: () => void) {
  const [over, setOver] = useState(false);
  const accepts = (event: DragEvent): boolean => event.dataTransfer.types.includes(FORWARD_DRAG_TYPE);
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        // Moving onto a child of the section is not leaving it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        setOver(false);
        onDropped();
        void dropRule(event.dataTransfer.getData(FORWARD_DRAG_TYPE), groupId).then((problem) => {
          if (problem !== undefined) showToast(problem);
        });
      },
    },
  };
}

const zoneClass = (over: boolean): string =>
  `rounded-md outline-offset-4 ${over ? 'outline-2 outline-dashed outline-accent' : ''}`;

/**
 * One forwarding group: its name, how many of its rules run ("2 of 3 running · 1 failed"), Start group or
 * Stop group, and Rename / Delete; then its rules.
 */
function GroupSection({
  group,
  rows,
  filtered,
  onRename,
  onNewGroup,
  onDragChange,
}: {
  group: ForwardGroupWire;
  rows: readonly ForwardRowData[];
  /** A search or chip hides some rows: an empty list then says nothing matched rather than how to fill it. */
  filtered: boolean;
  onRename: () => void;
  onNewGroup: (hostId: string, ruleId: string) => void;
  onDragChange: (key: string | undefined) => void;
}) {
  const drop = useDropZone(group.id, () => {
    onDragChange(undefined);
  });
  const resolved = useHostsStore((s) => s.resolved);
  const byKey = useForwardsStore((s) => s.byKey);
  const startErrors = useForwardsStore((s) => s.startErrors);
  const status = groupStatus(group, resolved, byKey, startErrors);
  const anyHeld = group.rules.some((m) => byKey[forwardKey(m.host, m.rule)] !== undefined);
  const allRunning = status.total > 0 && status.running >= status.total;
  return (
    <section
      aria-label={`Forwarding group ${group.name}`}
      data-testid="forward-group"
      data-group={group.id}
      data-drop-over={drop.over || undefined}
      className={zoneClass(drop.over)}
      {...drop.props}
    >
      <div className="mb-1.5 flex min-w-0 items-center gap-2">
        <h3 className="truncate text-sm font-medium text-fg-default">{group.name}</h3>
        <span
          data-testid="forward-group-status"
          className={`shrink-0 text-xs ${status.failed > 0 ? 'text-status-danger' : 'text-fg-subtle'}`}
        >
          {groupStatusText(status)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {!allRunning && (
            <Button
              variant="primary"
              className="h-6 px-2 text-xs"
              disabled={status.total === 0}
              onClick={() => {
                void startGroup(group.id);
              }}
            >
              Start group
            </Button>
          )}
          {anyHeld && (
            <Button
              className="h-6 px-2 text-xs"
              onClick={() => {
                void stopGroup(group.id);
              }}
            >
              Stop group
            </Button>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label={`More actions for group ${group.name}`}
                className="inline-flex size-6 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" className={CONTENT_CLASS}>
                <DropdownMenu.Item className={ITEM_CLASS} onSelect={onRename}>
                  Rename…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={ITEM_CLASS}
                  onSelect={() => {
                    // Its rules stay in hosts.yaml, under Ungrouped; nothing running is stopped.
                    void saveGroups(deleteGroup(useHostsStore.getState().file, group.id)).then((problem) => {
                      showToast(problem ?? `Group ${group.name} removed; its rules are under Ungrouped`);
                    });
                  }}
                >
                  Delete group
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </span>
      </div>
      {rows.length > 0 ? (
        <RowList
          rows={rows}
          label={`Forwards in ${group.name}`}
          showHost
          groupId={group.id}
          onNewGroup={onNewGroup}
          onDragChange={onDragChange}
        />
      ) : (
        <p className="rounded-md border border-dashed border-hairline px-3 py-2 text-xs text-fg-subtle">
          {filtered
            ? 'No rule of this group matches.'
            : 'No rules yet: drag a rule here, or use Move to group in its ⋯ menu.'}
        </p>
      )}
    </section>
  );
}

/** The rules in no group; while a rule is dragged it shows even when empty, to drop a rule out of its group. */
function UngroupedSection({
  rows,
  dragging,
  onNewGroup,
  onDragChange,
}: {
  rows: readonly ForwardRowData[];
  dragging: boolean;
  onNewGroup: (hostId: string, ruleId: string) => void;
  onDragChange: (key: string | undefined) => void;
}) {
  const drop = useDropZone(undefined, () => {
    onDragChange(undefined);
  });
  if (rows.length === 0 && !dragging) return null;
  return (
    <section
      aria-label="Ungrouped forwards"
      data-testid="forward-group"
      data-group=""
      data-drop-over={drop.over || undefined}
      className={zoneClass(drop.over)}
      {...drop.props}
    >
      <h3 className="mb-1.5 text-sm font-medium text-fg-muted">Ungrouped</h3>
      {rows.length > 0 ? (
        <RowList rows={rows} label="Ungrouped forwards" showHost onNewGroup={onNewGroup} onDragChange={onDragChange} />
      ) : (
        <p className="rounded-md border border-dashed border-hairline px-3 py-2 text-xs text-fg-subtle">
          Drop a rule here to take it out of its group.
        </p>
      )}
    </section>
  );
}

/** Which forwarding-group dialog is open: a new group (holding a rule moved into it), or a rename. */
type Naming =
  | { readonly mode: 'new'; readonly rule?: { readonly hostId: string; readonly ruleId: string } }
  | { readonly mode: 'rename'; readonly id: string; readonly name: string };

/**
 * The SSH home's Port forwarding view: one row per rule of every host, with its state and actions, a filter
 * (rule, host, port, target) and the All / Running / Failed chips.
 */
export function ForwardingPanel() {
  const resolved = useHostsStore((s) => s.resolved);
  const loaded = useHostsStore((s) => s.loaded);
  const forwardGroups = useHostsStore((s) => s.file.forwardGroups);
  const byKey = useForwardsStore((s) => s.byKey);
  const [filter, setFilter] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [adding, setAdding] = useState(false);
  const [naming, setNaming] = useState<Naming>();
  // The row being dragged onto another group, if any.
  const [dragging, setDragging] = useState<string>();
  const rows = useMemo(() => forwardRows(resolved, byKey), [resolved, byKey]);
  const groups = useMemo(() => forwardGroups ?? [], [forwardGroups]);
  const sections = useMemo(() => groupSections(groups, rows, resolved, byKey), [groups, rows, resolved, byKey]);
  const needle = filter.trim().toLowerCase();
  const filtered = needle !== '' || chip !== 'all';
  const visible = (row: ForwardRowData): boolean =>
    matches(row, needle) &&
    (chip === 'all' || (chip === 'running' ? isLive(row.state) : row.state?.status.state === 'failed'));
  const shown = rows.filter(visible);
  const ungrouped = sections.ungrouped.filter(visible);
  const newGroupFor = (hostId: string, ruleId: string): void => {
    setNaming({ mode: 'new', rule: { hostId, ruleId } });
  };

  const newRule = (
    <Button
      variant="primary"
      onClick={() => {
        setAdding(true);
      }}
    >
      <Plus size={13} aria-hidden /> New rule…
    </Button>
  );
  const newGroup = (
    <Button
      onClick={() => {
        setNaming({ mode: 'new' });
      }}
    >
      <FolderPlus size={13} aria-hidden /> New group…
    </Button>
  );

  return (
    <SshView>
      <SshViewHeader
        title={SSH_VIEWS.forwarding.label}
        {...(loaded ? { count: rows.length } : {})}
        search={{
          value: filter,
          onChange: setFilter,
          label: 'Filter forwards',
          placeholder: 'Search by rule, host, port or target…',
        }}
        description="Tunnels through your hosts. They run until stopped, or with the host's terminals when marked auto."
        actions={
          <>
            {rows.length > 0 && newGroup}
            {newRule}
          </>
        }
      />
      {rows.length > 0 && (
        <div role="group" aria-label="Show" className="flex gap-1">
          {CHIPS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={chip === id}
              onClick={() => {
                setChip(id);
              }}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                chip === id
                  ? 'border-accent bg-accent-muted text-fg-default'
                  : 'border-hairline text-fg-subtle hover:bg-surface-raised'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!loaded ? null : rows.length === 0 ? (
        <SshEmptyState
          icon={ArrowLeftRight}
          text="Reach a port behind one of your hosts, a database or a web console, as if it were on this machine."
          testId="forwards-empty"
        >
          {newRule}
        </SshEmptyState>
      ) : shown.length === 0 && (filtered || groups.length === 0) ? (
        <SshNoMatches
          text="No forward matches."
          onClear={() => {
            setFilter('');
            setChip('all');
          }}
        />
      ) : groups.length === 0 ? (
        <RowList rows={shown} label="Forwards" showHost onNewGroup={newGroupFor} />
      ) : (
        <div className="flex flex-col gap-4">
          {sections.groups.map(({ group, rows: groupRows }) => {
            const own = groupRows.filter(visible);
            // A search or chip hides a group with nothing to show; an empty group says how to fill it.
            if (filtered && own.length === 0) return null;
            return (
              <GroupSection
                key={group.id}
                group={group}
                rows={own}
                filtered={filtered}
                onRename={() => {
                  setNaming({ mode: 'rename', id: group.id, name: group.name });
                }}
                onNewGroup={newGroupFor}
                onDragChange={setDragging}
              />
            );
          })}
          <UngroupedSection
            rows={ungrouped}
            dragging={dragging !== undefined}
            onNewGroup={newGroupFor}
            onDragChange={setDragging}
          />
        </div>
      )}
      <NewRuleDialog open={adding} onOpenChange={setAdding} />
      <GroupNameDialog
        open={naming !== undefined}
        title={naming?.mode === 'rename' ? 'Rename forwarding group' : 'New forwarding group'}
        action={naming?.mode === 'rename' ? 'Rename' : 'Create'}
        initial={naming?.mode === 'rename' ? naming.name : ''}
        onOpenChange={(open) => {
          if (!open) setNaming(undefined);
        }}
        onSubmit={async (name) => {
          const current = useHostsStore.getState().file;
          if (naming?.mode === 'rename') return saveGroups(renameGroup(current, naming.id, name));
          return saveGroups(createGroup(current, name, naming?.rule).file);
        }}
      />
    </SshView>
  );
}

/** The host details panel's Port forwarding section: the same rows, for one host. */
export function HostForwards({ hostId }: { readonly hostId: string }) {
  const resolved = useHostsStore((s) => s.resolved);
  const byKey = useForwardsStore((s) => s.byKey);
  const rows = useMemo(
    () => forwardRows(resolved, byKey).filter((row) => row.host.id === hostId),
    [resolved, byKey, hostId],
  );
  if (rows.length === 0) {
    return <p className="py-1 text-sm text-fg-subtle">No rules: add one under Port forwarding when editing.</p>;
  }
  return <RowList rows={rows} label="Host forwards" showHost={false} />;
}
