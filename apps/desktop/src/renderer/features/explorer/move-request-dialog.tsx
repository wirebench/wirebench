import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { useProjectStore } from '../../state/project.js';
import { moveTargets } from './move-targets.js';

/** Which REST request **Move to…** is moving; `undefined` while the dialog is shut. */
export const useMoveRequestStore = create<{
  readonly requestId: string | undefined;
  readonly open: (requestId: string) => void;
  readonly close: () => void;
}>((set) => ({
  requestId: undefined,
  open: (requestId) => set({ requestId }),
  close: () => set({ requestId: undefined }),
}));

/**
 * **Move to…** on a REST request row: picks a folder in the request's own API, or the API's root, and moves the
 * request to the end of it. The same move a drag makes, for when the target is far down a long tree. A request
 * never leaves its API (main refuses that), so only its API's folders are offered.
 */
export function MoveRequestDialog() {
  const requestId = useMoveRequestStore((state) => state.requestId);
  const close = useMoveRequestStore((state) => state.close);
  const request = useProjectStore((state) => (requestId === undefined ? undefined : state.restRequests[requestId]));
  const apiName = useProjectStore((state) => (request === undefined ? undefined : state.apis[request.apiId]?.name));
  const folders = useProjectStore((state) => state.folders);
  const targets = request === undefined ? [] : moveTargets(request.apiId, apiName ?? 'API', folders);
  const here = request?.folderId ?? '';
  const [targetId, setTargetId] = useState<string>('');

  useEffect(() => {
    if (requestId !== undefined) setTargetId(here);
  }, [requestId]);

  const move = (): void => {
    if (request === undefined) return;
    const parentId = targetId === '' ? undefined : targetId;
    const store = useProjectStore.getState();
    // To the end of the target: main clamps the index to the target's length.
    const index = Object.values(store.restRequests).filter(
      (candidate) => candidate.apiId === request.apiId && candidate.folderId === parentId,
    ).length;
    close();
    void store.moveNode(request.id, parentId, index).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Could not move it');
    });
  };

  return (
    <Dialog.Root
      open={request !== undefined}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="move-request-dialog"
          className="fixed top-1/2 left-1/2 w-96 max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Move “{request?.name}”</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            A request moves within its own API, to the end of the folder you pick.
          </Dialog.Description>
          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="move-request-target">
            Move to
          </label>
          <select
            id="move-request-target"
            data-testid="move-request-target"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
          >
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {`${' '.repeat(target.depth)}${target.label}${target.id === here ? ' (current)' : ''}`}
              </option>
            ))}
          </select>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button data-testid="move-request-submit" variant="primary" disabled={targetId === here} onClick={move}>
              Move
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
