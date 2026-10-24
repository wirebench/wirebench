/**
 * Recent changes on the API Overview: the commits that touched this API's folder, newest first,
 * grouped by local day. Read when shown and again whenever the sync status settles on a new state
 * (a commit, a pull), never while an operation runs. A workspace that is not shared, a share that
 * keeps no per-path history, or a project outside the shared folder shows one line saying so.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ipc } from '../../state/ipc-client.js';
import { useSyncStore } from '../../state/sync.js';
import type { SyncApiHistoryWire, SyncLogEntryWire } from '../../../shared/wire-base.js';

const FIRST_PAGE = 20;
const MAX_LIMIT = 100;

const UNAVAILABLE: Readonly<Record<'no-history' | 'outside-tree', string>> = {
  'no-history': 'No history: this project is not under version control.',
  'outside-tree': 'No history: this project is outside the synced folder.',
};

export interface RecentChangesProps {
  readonly apiId: string;
}

/** Commits grouped by the local calendar day they were made on, in the order given (newest first). */
export function byDay(
  entries: readonly SyncLogEntryWire[],
): { readonly day: string; readonly entries: SyncLogEntryWire[] }[] {
  const days: { day: string; entries: SyncLogEntryWire[] }[] = [];
  for (const entry of entries) {
    const at = new Date(entry.at);
    const day = Number.isNaN(at.getTime())
      ? 'Unknown date'
      : at.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const last = days.at(-1);
    if (last?.day === day) {
      last.entries.push(entry);
    } else {
      days.push({ day, entries: [entry] });
    }
  }
  return days;
}

function timeOf(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Alice <alice@example.com>" reads as "Alice". */
function authorName(author: string): string {
  return author.replace(/\s*<[^>]*>\s*$/, '') || author;
}

type Loaded =
  { readonly kind: 'loading' } | { readonly kind: 'error' } | ({ readonly kind: 'done' } & SyncApiHistoryWire);

export function RecentChanges({ apiId }: RecentChangesProps) {
  const status = useSyncStore((state) => state.status);
  const [open, setOpen] = useState(true);
  const [limit, setLimit] = useState(FIRST_PAGE);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  // Changes when an operation has settled on a new state; undefined while one runs.
  const settled =
    status.state === 'syncing'
      ? undefined
      : `${status.state}|${String(status.ahead)}|${String(status.behind)}|${String(status.uncommitted)}`;

  useEffect(() => {
    if (settled === undefined) return;
    let live = true;
    void ipc()
      .sync.apiHistory({ apiId, limit })
      .then((result) => {
        if (live) setLoaded(result.ok ? { kind: 'done', ...result.value } : { kind: 'error' });
      });
    return () => {
      live = false;
    };
  }, [apiId, limit, settled]);

  return (
    <section aria-label="Recent changes" data-testid="recent-changes" className="border-t border-hairline pt-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex w-full items-center justify-between text-xs font-medium tracking-wider text-fg-subtle uppercase hover:text-fg-muted"
      >
        Recent changes
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {open && (
        <div className="mt-2">
          {loaded.kind === 'loading' ? (
            <p className="text-sm text-fg-subtle">Reading history…</p>
          ) : loaded.kind === 'error' ? (
            <p className="text-sm text-fg-subtle">The history could not be read.</p>
          ) : loaded.status === 'unavailable' ? (
            <p data-testid="recent-changes-unavailable" className="text-sm text-fg-subtle">
              {UNAVAILABLE[loaded.reason]}
            </p>
          ) : loaded.entries.length === 0 ? (
            <p className="text-sm text-fg-subtle">No commits touch this API yet.</p>
          ) : (
            <>
              <ol className="flex flex-col gap-3">
                {byDay(loaded.entries).map((group) => (
                  <li key={group.day}>
                    <h4 className="mb-1 text-sm font-medium text-fg-default">{group.day}</h4>
                    <ol className="flex flex-col gap-1.5 border-l border-hairline pl-3">
                      {group.entries.map((entry) => (
                        <li key={entry.id} data-testid="recent-changes-row" className="min-w-0 text-sm">
                          <div className="flex gap-2 text-xs text-fg-subtle">
                            <span>{timeOf(entry.at)}</span>
                            <span className="truncate">{authorName(entry.author)}</span>
                          </div>
                          <p className="truncate text-fg-default" title={entry.subject}>
                            {entry.subject}
                          </p>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
              {loaded.entries.length >= limit && limit < MAX_LIMIT && (
                <button
                  type="button"
                  data-testid="recent-changes-more"
                  onClick={() => {
                    setLimit(MAX_LIMIT);
                  }}
                  className="mt-2 text-sm text-accent hover:text-accent-hover hover:underline"
                >
                  Show more
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
