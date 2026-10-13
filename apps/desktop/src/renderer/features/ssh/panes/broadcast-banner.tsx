import { Radio } from 'lucide-react';
import { useHostsStore } from '../hosts-store.js';
import { stopBroadcast, useTabBroadcast } from './broadcast.js';

/**
 * The red bar across a broadcasting tab: how many panes receive, how many of those are not connected, and
 * whether the last keystroke missed one. The live region is always mounted, so turning broadcast on is
 * announced.
 */
export function BroadcastBanner({ tabId, paneIds }: { readonly tabId: string; readonly paneIds: readonly string[] }) {
  const broadcast = useTabBroadcast(tabId);
  const sessions = useHostsStore((s) => s.panes);
  const ticked = paneIds.filter((id) => broadcast.ticked.has(id));
  const notConnected = ticked.filter((id) => sessions[id]?.state !== 'open').length;
  const parts = [`Broadcasting to ${String(ticked.length)} of ${String(paneIds.length)} panes`];
  if (notConnected > 0) parts.push(`${String(notConnected)} not connected`);
  if (broadcast.missed > 0) {
    parts.push(`${String(broadcast.missed)} ${broadcast.missed === 1 ? 'pane' : 'panes'} missed input`);
  }
  return (
    <div aria-live="polite">
      {broadcast.on && (
        <div
          className="flex items-center gap-2 border-b-2 border-status-danger bg-status-danger/15 px-3 py-1 text-sm text-fg-default"
          data-testid="ssh-broadcast-banner"
        >
          <Radio size={13} aria-hidden="true" className="text-status-danger" />
          <span className="min-w-0 flex-1 truncate">{parts.join(' · ')}</span>
          <button
            type="button"
            className="rounded border border-status-danger px-2 py-0.5 text-sm hover:bg-status-danger/25"
            onClick={() => {
              stopBroadcast(tabId);
            }}
          >
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
