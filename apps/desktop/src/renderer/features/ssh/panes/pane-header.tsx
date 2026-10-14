import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { openFiles } from '../files/open-files.js';
import { AgentForwardingMark, agentForwardingOf } from '../agent-forwarding.js';
import { findHost, useHostsStore } from '../hosts-store.js';
import { sessionStatus } from '../session-status.js';
import { setTicked, useTabBroadcast } from './broadcast.js';
import { closePane, requestSplit } from './pane-actions.js';
import type { PaneLeaf } from './pane-tree.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/** A host's name to show, falling back to its id. */
export function useHostName(hostId: string): string {
  return useHostsStore(
    (s) => s.resolved.find((h) => h.id === hostId)?.name ?? findHost(s.file, hostId)?.name ?? hostId,
  );
}

/**
 * The slim bar over a pane of a split tab: its session's dot, its host, while broadcasting whether it
 * receives, and the menu that splits, opens Files on or closes this pane.
 */
export function PaneHeader({
  tabId,
  pane,
  focused,
}: {
  readonly tabId: string;
  readonly pane: PaneLeaf;
  readonly focused: boolean;
}) {
  const { paneId, hostId } = pane;
  const name = useHostName(hostId);
  const status = sessionStatus(useHostsStore((s) => s.panes[paneId]?.state));
  const forwarding = useHostsStore((s) => agentForwardingOf(s.panes, [paneId]));
  const broadcast = useTabBroadcast(tabId);
  return (
    <div
      className={`flex h-6 shrink-0 items-center gap-1.5 border-b border-hairline px-2 text-xs ${
        focused ? 'bg-surface-raised text-fg-default' : 'text-fg-muted'
      }`}
      data-testid="ssh-pane-header"
    >
      <span className={status.color} aria-label={status.label} role="img">
        ●
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {forwarding !== undefined && <AgentForwardingMark state={forwarding} />}
      {broadcast.on && (
        <input
          type="checkbox"
          className="accent-status-danger"
          aria-label={`Receive broadcast in ${name}`}
          checked={broadcast.ticked.has(paneId)}
          onChange={(event) => {
            setTicked(tabId, paneId, event.target.checked);
          }}
        />
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="rounded p-0.5 text-fg-muted hover:bg-surface-hover hover:text-fg-default"
          aria-label={`Pane menu for ${name}`}
        >
          <MoreHorizontal size={13} aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="z-dropdown min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
          >
            <DropdownMenu.Item
              className={ITEM_CLASS}
              onSelect={() => {
                requestSplit(tabId, 'row', paneId);
              }}
            >
              Split right
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={ITEM_CLASS}
              onSelect={() => {
                requestSplit(tabId, 'column', paneId);
              }}
            >
              Split down
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={ITEM_CLASS}
              onSelect={() => {
                openFiles(hostId);
              }}
            >
              Files
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
            <DropdownMenu.Item
              className={ITEM_CLASS}
              onSelect={() => {
                closePane(tabId, paneId);
              }}
            >
              Close pane
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
