import { useEffect } from 'react';
import { Button } from '../../components/button.js';
import { EmptyState } from '../../components/empty-state.js';
import { useGridNavigation } from '../../lib/grid-navigation.js';
import { actionLabel, actorLabel, targetLabel } from '../../state/audit-format.js';
import { useAuditStore } from '../../state/audit.js';
import { AuditDetail } from './audit-detail.js';
import { AuditFilterBar } from './audit-filter-bar.js';

/**
 * The Audit tab (audit-log spec §3.6), for server admins: filters, a keyboard grid of events, a detail
 * pane, *Load more* and *Export…*. Without the Enterprise feature the server answers
 * `licensing-feature-required` and only a notice is shown.
 */
export function AuditTab({
  url,
  workspaces,
}: {
  readonly url: string;
  readonly workspaces: readonly { id: string; name: string }[];
}) {
  const store = useAuditStore();
  useEffect(() => {
    void useAuditStore.getState().load(url);
    return () => {
      useAuditStore.getState().reset();
    };
  }, [url]);
  const nav = useGridNavigation(store.events.length, { onActiveRowChange: (i) => store.select(store.events[i]?.id) });
  const selected = store.events.find((e) => e.id === store.selectedId);

  const workspaceName = (id: string | null): string =>
    id === null ? '—' : (workspaces.find((w) => w.id === id)?.name ?? id);

  if (store.errorCode === 'licensing-feature-required' && store.events.length === 0) {
    return (
      <div data-testid="audit-tab" className="flex flex-col gap-3 text-sm">
        <p data-testid="audit-gated" role="status">
          The audit log is an Enterprise feature. Events are being recorded; install an Enterprise license to read them.
        </p>
      </div>
    );
  }
  return (
    <div data-testid="audit-tab" className="flex h-full min-h-0 flex-col gap-3 text-sm">
      <AuditFilterBar url={url} workspaces={workspaces} />
      {store.error !== undefined && (
        <p data-testid="audit-error" role="alert" className="text-xs text-status-danger">
          {store.error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {store.loaded && store.events.length === 0 ? (
            <EmptyState title="No events in this range" description="Widen the range or pick another kind." />
          ) : (
            <table
              role="grid"
              aria-label="Audit events"
              aria-rowcount={store.events.length}
              className="w-full border-collapse text-left"
              {...nav.gridProps}
            >
              <thead>
                <tr role="row" className="text-xs tracking-wider text-fg-subtle uppercase">
                  <th role="columnheader" className="pb-1 font-medium">
                    When
                  </th>
                  <th role="columnheader" className="pb-1 font-medium">
                    Who
                  </th>
                  <th role="columnheader" className="pb-1 font-medium">
                    What
                  </th>
                  <th role="columnheader" className="pb-1 font-medium">
                    Target
                  </th>
                  <th role="columnheader" className="pb-1 font-medium">
                    Workspace
                  </th>
                </tr>
              </thead>
              <tbody>
                {store.events.map((e, i) => (
                  <tr
                    key={e.id}
                    role="row"
                    aria-rowindex={i + 1}
                    aria-selected={e.id === store.selectedId}
                    data-testid="audit-row"
                    className={`cursor-pointer border-t border-hairline hover:bg-surface-hover ${e.id === store.selectedId ? 'bg-surface-selected' : ''}`}
                    onClick={() => {
                      store.select(e.id);
                      nav.setActiveRow(i);
                    }}
                    {...nav.rowProps(i)}
                  >
                    <td role="gridcell" className="py-1 pr-2">
                      {new Date(e.at).toLocaleString()}
                    </td>
                    <td role="gridcell" className="pr-2">
                      {actorLabel(e.actor)}
                    </td>
                    <td role="gridcell" className="pr-2">
                      {actionLabel(e.action)}
                    </td>
                    <td role="gridcell" className="pr-2">
                      {targetLabel(e)}
                    </td>
                    <td role="gridcell">{workspaceName(e.workspaceId)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {store.next !== undefined && (
            <div className="p-2">
              <Button
                data-testid="audit-load-more"
                disabled={store.loadingMore}
                onClick={() => void store.loadMore(url)}
              >
                {store.loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </div>
        {selected !== undefined && (
          <div className="w-72 shrink-0 overflow-y-auto border-l border-hairline pl-3">
            <AuditDetail event={selected} onClose={() => store.select(undefined)} />
          </div>
        )}
      </div>
    </div>
  );
}
