/**
 * A folder's credentials, in a dialog.
 *
 * A folder has no editor tab of its own — it is a place in the tree, not a thing you send — so the
 * one field it owns beyond its name gets a dialog rather than a page. The form is the same
 * {@link AuthFields} every other level uses, so a folder is not a second, lesser place to configure a
 * token.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { AuthFields } from '../../components/auth-fields.js';
import { Button } from '../../components/button.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { OAuth2StatusPanel } from '../rest-editor/oauth2-status.js';
import type { AuthConfigWire } from '../../../shared/wire-types.js';

/** The dialog, mounted once by the shell and driven by the UI store's `folderAuthId`. */
export function FolderAuthDialog() {
  const folderId = useUiStore((state) => state.folderAuthId);
  const setFolderAuthId = useUiStore((state) => state.setFolderAuthId);
  const folder = useProjectStore((state) => (folderId === undefined ? undefined : state.folders[folderId]));
  const updateFolder = useProjectStore((state) => state.updateFolder);

  const open = folderId !== undefined && folder !== undefined;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFolderAuthId(undefined);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="folder-auth-dialog"
          className="fixed top-1/2 left-1/2 max-h-[85vh] w-[30rem] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-md font-medium text-fg-default">
              {folder === undefined ? 'Folder credentials' : `Credentials for “${folder.name}”`}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="text-fg-subtle hover:text-fg-default">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <p className="mt-2 text-xs text-fg-subtle">
            Used by every request in this folder that configures none of its own.
          </p>

          {folder !== undefined && folderId !== undefined && (
            <div className="mt-3">
              <AuthFields
                scope="Folder"
                inheritable
                auth={folder.auth === undefined || folder.auth.type === 'inherit' ? undefined : folder.auth}
                onChange={(auth: AuthConfigWire | null) => {
                  void updateFolder(folderId, { auth: auth ?? { type: 'inherit' } });
                }}
                oauth2Status={
                  folder.auth?.type === 'oauth2' ? (
                    <OAuth2StatusPanel ownerId={folderId} grant={folder.auth.grant} />
                  ) : undefined
                }
              />
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <Button variant="primary" data-testid="folder-auth-done">
                Done
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
