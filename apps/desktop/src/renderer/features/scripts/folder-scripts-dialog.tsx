/**
 * A folder's scripts, in a dialog (#334).
 *
 * A folder has no editor tab of its own, so its scripts get a dialog, as its credentials do. The
 * editor is the same {@link ScriptsTab} a request, an API and an interface use; the folder's scripts
 * run around every request inside it, after its API's and any outer folder's.
 */
import { Suspense, lazy } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';

// Split out: the shell mounts this dialog at startup, and the scripts editor is Monaco, which only
// ever loads with an editor.
const ScriptsTab = lazy(async () => {
  const module = await import('./scripts-tab.js');
  return { default: module.ScriptsTab };
});

/** The dialog, mounted once by the shell and driven by the UI store's `folderScriptsId`. */
export function FolderScriptsDialog() {
  const folderId = useUiStore((state) => state.folderScriptsId);
  const setFolderScriptsId = useUiStore((state) => state.setFolderScriptsId);
  const folder = useProjectStore((state) => (folderId === undefined ? undefined : state.folders[folderId]));

  const open = folderId !== undefined && folder !== undefined;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFolderScriptsId(undefined);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="folder-scripts-dialog"
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 flex h-[80vh] w-[48rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised shadow-lg"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-hairline px-4 py-3">
            <Dialog.Title className="text-md font-medium text-fg-default">
              {folder === undefined ? 'Folder scripts' : `Scripts for “${folder.name}”`}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="text-fg-subtle hover:text-fg-default">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {folder !== undefined && folderId !== undefined && (
              <Suspense fallback={null}>
                <ScriptsTab requestId={folderId} scripts={folder.scripts} level="folder" />
              </Suspense>
            )}
          </div>

          <div className="flex shrink-0 justify-end border-t border-hairline px-4 py-3">
            <Dialog.Close asChild>
              <Button variant="primary" data-testid="folder-scripts-done">
                Done
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
