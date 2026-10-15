/**
 * The Hosts tab's "Recent" strip: the hosts connected to lately on this machine, newest first, each with
 * when and how its last connect went and a Connect; Clear forgets the list. Deleted hosts are left out and
 * renamed ones show by their current name. With only a few hosts it would repeat the cards, so it hides.
 */
import { useMemo } from 'react';
import { History, Plug } from 'lucide-react';
import { Button } from '../../components/button.js';
import { formatRelative } from '../sync/relative-time.js';
import { openTerminalFor } from './connect.js';
import { osKeyOf, useHostsStore } from './hosts-store.js';
import { OsIcon, osOf } from './os-icon.js';
import { useRecentConnections, useRecentStore } from './recent-connections.js';

/** How many entries the strip shows; with this many hosts or fewer the cards show them all, and it hides. */
const SHOWN = 6;

export function RecentSection() {
  const entries = useRecentConnections();
  const resolved = useHostsStore((s) => s.resolved);
  const osByHost = useHostsStore((s) => s.osByHost);
  const clear = useRecentStore((s) => s.clear);
  const rows = useMemo(() => {
    const byId = new Map(resolved.map((host) => [host.id, host] as const));
    return entries
      .flatMap((entry) => {
        const host = byId.get(entry.hostId);
        return host === undefined ? [] : [{ entry, host }];
      })
      .slice(0, SHOWN);
  }, [entries, resolved]);
  if (rows.length === 0 || resolved.length <= SHOWN) return null;
  const now = new Date();

  return (
    <section aria-label="Recent connections" className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h3 className="flex items-center gap-1.5 text-xs tracking-wider text-fg-faint uppercase">
          <History size={12} aria-hidden="true" /> Recent
        </h3>
        <button
          type="button"
          aria-label="Clear recent connections"
          onClick={clear}
          className="ml-auto rounded px-1 text-xs text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
        >
          Clear
        </button>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
        {rows.map(({ entry, host }) => (
          <li
            key={entry.hostId}
            data-host-id={entry.hostId}
            className="flex items-center gap-2 rounded-md border border-hairline px-2 py-1.5"
          >
            <span className="shrink-0 text-fg-subtle">
              <OsIcon os={osOf(osByHost[osKeyOf(host)])} size={14} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-fg-default">{host.name}</span>
              <span className="truncate text-xs text-fg-subtle">
                {entry.outcome === 'failed' && <span className="text-status-danger">Failed · </span>}
                {formatRelative(new Date(entry.at).toISOString(), now)}
              </span>
            </span>
            <Button
              variant="ghost"
              aria-label={`Connect to ${host.name}`}
              title="Connect"
              className="px-2"
              onClick={() => {
                openTerminalFor(host.id);
              }}
            >
              <Plug size={13} aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
