import type { ReactNode } from 'react';
import { useEditorsStore } from '../../../state/editors.js';
import { useHostsStore } from '../hosts-store.js';
import { focusedPaneOf, usePanesStore } from '../panes/pane-actions.js';
import { sessionStatus } from '../session-status.js';
import { showForwarding } from './forward-actions.js';
import { forwardCounts, useForwardsStore } from './forwards-store.js';

/**
 * The SSH area's status bar items: the session in front, then the forwards. Both draw their own separator,
 * and nothing while they have nothing to say.
 */
export function SshStatusItem() {
  return (
    <>
      <SessionItem />
      <ForwardsItem />
    </>
  );
}

/**
 * While a terminal tab is in front: the host of its focused pane with that session's status, and a mark while
 * the session is logged (#414). A local terminal says so.
 */
function SessionItem() {
  const tab = useEditorsStore((s) => (s.displayedSet === 'ssh' ? s.tabs.find((t) => t.id === s.activeId) : undefined));
  // Read so a focus change between panes redraws the item.
  usePanesStore((s) => (tab === undefined ? undefined : s.focused[tab.id]));
  const paneId = tab?.kind === 'ssh-terminal' && tab.panes !== undefined ? focusedPaneOf(tab.id, tab.panes) : undefined;
  const session = useHostsStore((s) => (paneId === undefined ? undefined : s.panes[paneId]));
  const hostName = useHostsStore((s) => s.resolved.find((h) => h.id === session?.hostId)?.name);
  if (tab?.kind === 'local-terminal') return <Item>Local terminal</Item>;
  if (session === undefined) return null;
  const status = sessionStatus(session.state);
  return (
    <Item>
      <span
        role="img"
        aria-label={status.label}
        title={status.label}
        className={`inline-block size-1.5 rounded-full bg-current ${status.color}`}
      />
      <span className="max-w-48 truncate">{hostName ?? session.hostId}</span>
      {session.recording === true && (
        <span data-testid="status-bar-recording" title="This session is being logged" className="text-status-danger">
          ● logging
        </span>
      )}
    </Item>
  );
}

function Item({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <span aria-hidden="true" className="text-fg-faint">
        ·
      </span>
      <span data-testid="status-bar-session" className="flex items-center gap-1">
        {children}
      </span>
    </>
  );
}

/**
 * `⇄ N` while N forwards run, `⇄ N · M failed` (red) while any has failed; it opens the Port forwarding view.
 * Nothing shows while none runs and none failed.
 */
function ForwardsItem() {
  const running = useForwardsStore((s) => forwardCounts(s.byKey).running);
  const failed = useForwardsStore((s) => forwardCounts(s.byKey).failed);
  if (running === 0 && failed === 0) return null;
  const label = `${String(running)} ${running === 1 ? 'forward' : 'forwards'} running${
    failed > 0 ? `, ${String(failed)} failed` : ''
  }. Show port forwarding`;
  return (
    <>
      <span aria-hidden="true" className="text-fg-faint">
        ·
      </span>
      <button
        type="button"
        data-testid="status-bar-forwards"
        data-failed={failed > 0 || undefined}
        title={label}
        aria-label={label}
        className={`rounded-sm px-1 font-mono hover:bg-surface-hover hover:text-fg-default ${
          failed > 0 ? 'text-status-danger' : ''
        }`}
        onClick={() => {
          showForwarding();
        }}
      >
        ⇄ {running}
        {failed > 0 && ` · ${String(failed)} failed`}
      </button>
    </>
  );
}
