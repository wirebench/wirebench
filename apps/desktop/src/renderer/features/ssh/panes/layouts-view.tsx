import { useEffect, useState } from 'react';
import { LayoutPanelLeft, Server } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { showToast } from '../../../components/toast.js';
import type { LayoutWire } from '@shared/layout-wire.js';
import { useHostsStore } from '../hosts-store.js';
import { useLayoutsStore } from './layouts-store.js';
import { layoutHosts, layoutPaneCount, openLayout } from './open-layout.js';
import { LayoutNameDialog } from './save-layout-dialog.js';
import { SshEmptyState, SshNoMatches, SshView, SshViewHeader } from '../ssh-view-frame.js';
import { SSH_VIEWS } from '../ssh-views.js';

/**
 * The SSH home's Layouts view: the open workspace's layouts saved on this machine, each with its hosts and pane
 * count, to open in one tab, rename or delete.
 */
export function LayoutsPanel() {
  const layouts = useLayoutsStore((s) => s.layouts);
  const loaded = useLayoutsStore((s) => s.loaded);
  const resolved = useHostsStore((s) => s.resolved);
  const [renaming, setRenaming] = useState<LayoutWire>();
  const [deleting, setDeleting] = useState<LayoutWire>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');

  useEffect(() => {
    useLayoutsStore
      .getState()
      .refresh()
      .catch(() => undefined);
  }, []);

  const nameOf = (hostId: string): string => resolved.find((host) => host.id === hostId)?.name ?? hostId;

  const needle = filter.trim().toLowerCase();
  const shown = layouts.filter(
    (layout) =>
      needle === '' ||
      [layout.name, ...layoutHosts(layout.root).map(nameOf)].some((field) => field.toLowerCase().includes(needle)),
  );

  return (
    <SshView>
      <SshViewHeader
        title={SSH_VIEWS.layouts.label}
        {...(loaded ? { count: layouts.length } : {})}
        search={{ value: filter, onChange: setFilter, label: 'Filter layouts', placeholder: 'Search layouts…' }}
        description="Terminal tabs saved with their panes, on this machine. Opening one connects every pane in a new tab."
      />
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
      {!loaded ? null : layouts.length === 0 ? (
        <SshEmptyState
          icon={LayoutPanelLeft}
          text="Open a host, split its terminal tab into panes, then choose Save layout… to reopen them all in one go."
          testId="layouts-empty"
        >
          <Button
            variant="primary"
            onClick={() => {
              useHostsStore.getState().setHomeView('hosts');
            }}
          >
            <Server size={13} aria-hidden /> Open a host
          </Button>
        </SshEmptyState>
      ) : shown.length === 0 ? (
        <SshNoMatches
          text="No layout matches the search."
          onClear={() => {
            setFilter('');
          }}
        />
      ) : (
        <ul aria-label="Layouts" className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
          {shown.map((layout) => {
            const count = layoutPaneCount(layout.root);
            return (
              <li key={layout.id} data-testid="layout-row" className="flex items-center gap-3 px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-fg-default">{layout.name}</span>
                  <span className="truncate text-xs text-fg-subtle">
                    {layoutHosts(layout.root).map(nameOf).join(', ')} · {count} {count === 1 ? 'pane' : 'panes'}
                  </span>
                </span>
                <Button
                  variant="primary"
                  onClick={() => {
                    openLayout(layout);
                  }}
                >
                  Open
                </Button>
                <Button
                  onClick={() => {
                    setRenaming(layout);
                  }}
                >
                  Rename
                </Button>
                <Button
                  onClick={() => {
                    setDeleting(layout);
                  }}
                >
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <LayoutNameDialog
        open={renaming !== undefined}
        title="Rename layout"
        action="Rename"
        initial={renaming?.name ?? ''}
        onOpenChange={(open) => {
          if (!open) setRenaming(undefined);
        }}
        onSubmit={async (name) => {
          if (renaming === undefined) return undefined;
          const result = await useLayoutsStore.getState().rename(renaming.id, name);
          return result.ok ? undefined : result.error.message;
        }}
      />
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title="Delete this layout?"
        description={
          deleting === undefined ? '' : `“${deleting.name}” is removed from this machine. Open tabs stay as they are.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          const layout = deleting;
          setDeleting(undefined);
          if (layout === undefined) return;
          useLayoutsStore
            .getState()
            .remove(layout.id)
            .then((result) => {
              setError(result.ok ? undefined : result.error.message);
              if (!result.ok) return;
              // Saving it again under its name brings it back, last in the list (#594).
              showToast(`Deleted layout “${layout.name}”`, {
                label: 'Undo',
                onClick: () => {
                  void useLayoutsStore
                    .getState()
                    .save({ name: layout.name, root: layout.root })
                    .then((saved) => {
                      setError(saved.ok ? undefined : saved.error.message);
                    });
                },
              });
            })
            .catch(() => {
              setError('The layout could not be deleted');
            });
        }}
      />
    </SshView>
  );
}
