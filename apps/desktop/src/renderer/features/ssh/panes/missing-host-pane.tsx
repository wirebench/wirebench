import { closePane } from './pane-actions.js';
import type { PaneLeaf } from './pane-tree.js';

/**
 * A pane whose host is no longer in `hosts.yaml` (a layout saved before the host was deleted): it says so and
 * offers to remove itself; it never connects. Saving the layout again leaves it out.
 */
export function MissingHostPane({ tabId, pane }: { readonly tabId: string; readonly pane: PaneLeaf }) {
  return (
    <div
      data-testid="ssh-pane-missing"
      role="status"
      className="flex h-full items-center justify-center gap-2 bg-surface-sunken p-4 text-sm text-fg-muted"
    >
      <span>
        Host <span className="font-mono text-fg-default">{pane.hostId}</span> is no longer in hosts.yaml
      </span>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        className="rounded border border-hairline px-2 py-0.5 text-sm text-fg-default hover:bg-surface-raised"
        onClick={() => {
          closePane(tabId, pane.paneId);
        }}
      >
        Remove pane
      </button>
    </div>
  );
}
