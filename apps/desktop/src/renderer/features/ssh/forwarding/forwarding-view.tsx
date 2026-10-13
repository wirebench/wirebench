import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { ForwardStateWire } from '../../../../shared/forward-wire.js';
import type { ResolvedForwardWire, ResolvedHostWire } from '../../../../shared/ssh-wire.js';
import { flattenGroups, useHostsStore } from '../hosts-store.js';
import { forwardKey, routeOf } from './forward-format.js';
import { ForwardRow } from './forward-row.js';
import { isLive, useForwardsStore } from './forwards-store.js';

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

function RowList({ rows, label, showHost }: { rows: readonly ForwardRowData[]; label: string; showHost: boolean }) {
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
        />
      ))}
    </ul>
  );
}

/**
 * The SSH home's Port forwarding view: one row per rule of every host, with its state and actions, a filter
 * (rule, host, port, target) and the All / Running / Failed chips.
 */
export function ForwardingPanel() {
  const resolved = useHostsStore((s) => s.resolved);
  const loaded = useHostsStore((s) => s.loaded);
  const byKey = useForwardsStore((s) => s.byKey);
  const [filter, setFilter] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const rows = useMemo(() => forwardRows(resolved, byKey), [resolved, byKey]);
  const needle = filter.trim().toLowerCase();
  const shown = rows.filter(
    (row) =>
      matches(row, needle) &&
      (chip === 'all' || (chip === 'running' ? isLive(row.state) : row.state?.status.state === 'failed')),
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-subtle">
        Tunnels through your hosts. Rules are set on a host or a group in its settings; they run until stopped, or with
        the host&apos;s terminals when marked auto.
      </p>
      <div className="flex items-center gap-2">
        <label className="flex flex-1 items-center gap-2 rounded-md border border-hairline-strong bg-surface-base px-2 py-1">
          <Search size={14} aria-hidden="true" className="text-fg-subtle" />
          <input
            aria-label="Filter forwards"
            placeholder="Filter by rule, host, port or target"
            className="w-full bg-transparent text-sm text-fg-default outline-none placeholder:text-fg-faint"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
          />
        </label>
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
      </div>
      {!loaded ? null : rows.length === 0 ? (
        <p data-testid="forwards-empty" className="text-sm text-fg-subtle">
          No host has a forwarding rule yet. Add one in a host&apos;s or group&apos;s settings, under Port forwarding.
        </p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-fg-subtle">No forward matches.</p>
      ) : (
        <RowList rows={shown} label="Forwards" showHost />
      )}
    </div>
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
