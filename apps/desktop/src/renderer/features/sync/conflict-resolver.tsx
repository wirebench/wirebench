import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useSyncStore } from '../../state/sync.js';
import { useUiStore } from '../../state/ui.js';

/**
 * The conflict resolver: every unresolved sync conflict, each with Keep mine / Keep theirs /
 * Open file, plus a Cancel that aborts the whole merge. Mounted once in `app-shell.tsx`, next to
 * the Sync panel, driven by `useUiStore.conflictResolverOpen`. Resolving the last conflict — or
 * cancelling the merge — closes it; `resolve()` itself only updates `status`, so this dialog
 * reloads the conflict list after every row it resolves to notice when none are left.
 */
export function ConflictResolver() {
  const open = useUiStore((state) => state.conflictResolverOpen);
  const setOpen = useUiStore((state) => state.setConflictResolverOpen);
  const conflicts = useSyncStore((state) => state.conflicts);
  const loadConflicts = useSyncStore((state) => state.loadConflicts);
  const resolve = useSyncStore((state) => state.resolve);
  const abortMerge = useSyncStore((state) => state.abortMerge);
  const revealTree = useSyncStore((state) => state.revealTree);

  const [busyPath, setBusyPath] = useState<string | undefined>(undefined);
  const [cancelOpen, setCancelOpen] = useState(false);
  // Whether THIS open's own `loadConflicts()` has settled — an empty `conflicts` array means
  // nothing to show only once it reflects a load this dialog actually started; on a cold start
  // already in `state: 'conflict'` (opened via the `sync.resolveConflicts` command/shortcut) the
  // store's `conflicts` can still be the empty default the instant this mounts, and closing on
  // that stale emptiness would self-close in the same tick it opened.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open) {
      setLoaded(false);
      return;
    }
    setLoaded(false);
    let cancelled = false;
    void loadConflicts().then(() => {
      if (!cancelled) {
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, loadConflicts]);

  // The list this dialog exists to clear went empty (the last row was just resolved, or a
  // fresher conflict event beat it there) — nothing left to show, so it closes itself. Gated on
  // `loaded` so this never fires against a load still in flight.
  useEffect(() => {
    if (open && loaded && conflicts.length === 0) {
      setOpen(false);
    }
  }, [open, loaded, conflicts.length, setOpen]);

  const keep = (path: string, side: 'mine' | 'theirs'): void => {
    setBusyPath(path);
    void resolve(path, side)
      .then(() => loadConflicts())
      .finally(() => {
        setBusyPath(undefined);
      });
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content
            data-testid="conflict-resolver"
            className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[36rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
          >
            <Dialog.Title className="text-md font-medium text-fg-default">Resolve conflicts</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-fg-subtle">
              Keep your version, keep theirs, or open the file to fix it by hand.
            </Dialog.Description>

            <ul data-testid="conflict-resolver-list" className="mt-3 flex flex-col gap-2">
              {conflicts.map((conflict) => (
                <li
                  key={conflict.path}
                  data-testid="conflict-resolver-row"
                  className="flex items-center justify-between gap-2 border-b border-hairline pb-2 text-sm text-fg-default"
                >
                  <span className="min-w-0 flex-1 truncate" title={conflict.path}>
                    {conflict.entity !== undefined ? `${conflict.entity.kind}: ${conflict.entity.name}` : conflict.path}
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      data-testid="conflict-resolver-mine"
                      disabled={busyPath !== undefined}
                      onClick={() => {
                        keep(conflict.path, 'mine');
                      }}
                    >
                      Keep mine
                    </Button>
                    <Button
                      data-testid="conflict-resolver-theirs"
                      disabled={busyPath !== undefined}
                      onClick={() => {
                        keep(conflict.path, 'theirs');
                      }}
                    >
                      Keep theirs
                    </Button>
                    <Button
                      data-testid="conflict-resolver-open"
                      onClick={() => {
                        void revealTree(conflict.path);
                      }}
                    >
                      Open file
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex justify-end">
              <Button
                data-testid="conflict-resolver-cancel"
                onClick={() => {
                  setCancelOpen(true);
                }}
              >
                Cancel
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel the merge?"
        description="Every conflict resolved so far is discarded, along with the pull that started this merge."
        confirmLabel="Cancel merge"
        destructive
        confirmTestId="conflict-resolver-cancel-confirm"
        onConfirm={() => {
          setCancelOpen(false);
          setOpen(false);
          void abortMerge();
        }}
      />
    </>
  );
}
