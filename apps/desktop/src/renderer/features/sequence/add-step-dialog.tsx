/**
 * Add step…: a searchable list of the project's requests, as the command palette's quick-open lists
 * operations. A request a run cannot send (WebSocket, a streaming gRPC call, orphaned) is listed but
 * disabled, with the reason, so the user sees why it is not offered rather than wondering where it went.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import { useMemo } from 'react';
import { useProjectStore } from '../../state/project.js';
import { projectStepRequests } from './step-requests.js';

export interface AddStepDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly onPick: (requestId: string) => void;
}

export function AddStepDialog({ open, onOpenChange, projectId, onPick }: AddStepDialogProps) {
  const requests = useProjectStore((state) => state.requests);
  const restRequests = useProjectStore((state) => state.restRequests);
  const grpcRequests = useProjectStore((state) => state.grpcRequests);
  const wsRequests = useProjectStore((state) => state.wsRequests);
  const entries = useMemo(
    () => (open ? projectStepRequests(useProjectStore.getState(), projectId) : []),
    // The maps are what the list is built from; the store is read whole inside.
    [open, projectId, requests, restRequests, grpcRequests, wsRequests],
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="sequence-add-step-dialog"
          className="fixed top-[18%] left-1/2 z-50 w-[min(560px,90vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-hairline-strong bg-surface-overlay shadow-2xl"
        >
          <Dialog.Title className="sr-only">Add a step</Dialog.Title>
          <Command loop label="Requests">
            <Command.Input
              autoFocus
              data-testid="sequence-add-step-input"
              placeholder="Add a step: pick a request"
              className="h-10 w-full border-b border-hairline bg-transparent px-3 text-md text-fg-default outline-none placeholder:text-fg-faint"
            />
            <Command.List className="max-h-[320px] overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-subtle">
                No matching request in this project.
              </Command.Empty>
              {entries.map((entry) => (
                <Command.Item
                  key={entry.requestId}
                  value={`${entry.path} ${entry.name} ${entry.requestId}`}
                  disabled={entry.unsupported !== undefined}
                  data-testid="sequence-add-step-item"
                  onSelect={() => {
                    onOpenChange(false);
                    onPick(entry.requestId);
                  }}
                  className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-xs text-fg-subtle">{entry.badge}</span>
                    <span className="truncate">{entry.name}</span>
                  </span>
                  <span className="truncate text-xs text-fg-subtle">{entry.unsupported ?? entry.path}</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
