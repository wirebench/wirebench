/**
 * A project's Webhooks settings: the collection's target and credentials, or one folder's own
 * target override. Reached from the explorer's *Webhooks settings…* and from a webhook item's
 * *Set the Webhooks target* note (`webhook-url-note.tsx`).
 *
 * The Target field is a {@link PropertyHighlightInput} — the same highlighted field the URL bar
 * uses — rather than a plain text box, so a `${…}` in a webhook target is as visible here as it is
 * in a request's own URL bar.
 *
 * A folder has no Auth block: its *Auth…* item (the same {@link AuthFields} form as everywhere
 * else) already covers it, the way a REST folder's credentials live in `folder-auth-dialog.tsx`
 * rather than here.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AuthFields } from '../../components/auth-fields.js';
import { Button } from '../../components/button.js';
import { PropertyHighlightInput } from '../rest-editor/property-highlight-input.js';
import { folderChainOf, useProjectStore } from '../../state/project.js';
import { useWebhooksStore } from '../../state/webhooks.js';
import { useWebhookItemsDialogs } from './webhook-items-state.js';
import type { AuthConfigWire, RestFolderWire } from '../../../shared/wire-types.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/** The nearest ancestor folder's own target, else the collection's — the engine's `effectiveTarget`. */
function inheritedTargetOf(
  folders: Readonly<Record<string, RestFolderWire>>,
  parentId: string | undefined,
  collectionTarget: string,
): string {
  const chain = folderChainOf(folders, parentId);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const target = chain[index]?.target;
    if (target !== undefined) {
      return target;
    }
  }
  return collectionTarget;
}

export function WebhookSettingsDialog() {
  const settings = useWebhookItemsDialogs((state) => state.settings);
  const close = useWebhookItemsDialogs((state) => state.close);
  const foldersMap = useProjectStore((state) => state.folders);
  const collection = useProjectStore((state) =>
    settings === undefined ? undefined : state.webhooks[settings.projectId],
  );
  const server = useWebhooksStore((state) => state.server);
  const meta = useWebhooksStore((state) => state.meta);
  const hooks = useWebhooksStore((state) => state.hooks);

  const [targetDraft, setTargetDraft] = useState('');
  const [hasOverride, setHasOverride] = useState(false);
  const [auth, setAuth] = useState<AuthConfigWire | undefined>(undefined);
  const [authTouched, setAuthTouched] = useState(false);

  // Filled once per opening, like the catch URL settings dialog: a store update while this is open
  // (another tab editing the same target) must not undo what the user is typing.
  useEffect(() => {
    if (settings === undefined) {
      return;
    }
    const state = useProjectStore.getState();
    const collection = state.webhooks[settings.projectId];
    const openedFolder = settings.folderId === undefined ? undefined : state.folders[settings.folderId];
    setTargetDraft(settings.folderId === undefined ? (collection?.target ?? '') : (openedFolder?.target ?? ''));
    setHasOverride(openedFolder?.target !== undefined);
    setAuth(collection?.auth);
    setAuthTouched(false);
  }, [settings]);

  if (settings === undefined) {
    return null;
  }

  // Narrowed once here: `settings` does not change again for the rest of this render, so every
  // handler below closes over a definite project id (and, for a folder, a definite folder id)
  // rather than re-deriving it from a value TypeScript would otherwise still see as optional.
  const { projectId, folderId } = settings;
  const isFolder = folderId !== undefined;
  const folder = folderId === undefined ? undefined : foldersMap[folderId];
  const inheritedTarget = isFolder
    ? inheritedTargetOf(foldersMap, folder?.parentId, collection?.target ?? '')
    : undefined;

  const showsCatchUrlMenu = !isFolder && server !== undefined && meta?.enabled === true;

  const save = async (): Promise<void> => {
    if (folderId !== undefined) {
      await useProjectStore.getState().setWebhookFolderTarget(projectId, folderId, hasOverride ? targetDraft : null);
    } else {
      const patch: { target?: string; auth?: AuthConfigWire | null } = { target: targetDraft };
      if (authTouched) {
        patch.auth = auth ?? null;
      }
      await useProjectStore.getState().updateWebhooks(projectId, patch);
    }
    close();
  };

  const reset = (): void => {
    if (folderId === undefined) {
      return;
    }
    void useProjectStore.getState().setWebhookFolderTarget(projectId, folderId, null);
    setTargetDraft('');
    setHasOverride(false);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="webhook-settings"
          className="fixed top-1/2 left-1/2 w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">
            {isFolder ? `Target for “${folder?.name ?? ''}”` : 'Webhooks settings'}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            {isFolder
              ? 'Overrides the target for every webhook item in this folder.'
              : 'Where a webhook item sends by default, and the credentials it sends with.'}
          </Dialog.Description>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className="mt-3 block text-sm text-fg-subtle" htmlFor="webhook-settings-target">
              Target
            </label>
            <div className="mt-1 flex items-center gap-2">
              <div className="flex h-row min-w-0 flex-1 items-center overflow-hidden rounded-md border border-hairline-strong bg-surface-raised">
                <PropertyHighlightInput
                  id="webhook-settings-target"
                  ariaLabel="Target"
                  testId="webhook-settings-target"
                  value={targetDraft}
                  placeholder={isFolder ? `inherits: ${inheritedTarget}` : undefined}
                  onChange={(value) => {
                    setTargetDraft(value);
                    if (isFolder) {
                      setHasOverride(true);
                    }
                  }}
                />
              </div>
              {isFolder && (
                <Button data-testid="webhook-settings-reset" onClick={reset}>
                  Reset
                </Button>
              )}
              {showsCatchUrlMenu && (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <Button data-testid="webhook-settings-catch-urls" type="button">
                      Catch URLs ▸
                    </Button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="bottom"
                      align="end"
                      sideOffset={4}
                      className="min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
                    >
                      {hooks.length === 0 ? (
                        <p className="px-2 py-1.5 text-sm text-fg-subtle">No catch URLs yet</p>
                      ) : (
                        hooks.map((hook) => (
                          <DropdownMenu.Item
                            key={hook.id}
                            className={ITEM_CLASS}
                            onSelect={() => {
                              setTargetDraft(hook.url);
                              if (isFolder) {
                                setHasOverride(true);
                              }
                            }}
                          >
                            {hook.name}
                          </DropdownMenu.Item>
                        ))
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </div>

            {!isFolder && (
              <div className="mt-4">
                <AuthFields
                  scope="Webhooks"
                  auth={auth}
                  onChange={(next) => {
                    setAuth(next ?? undefined);
                    setAuthTouched(true);
                  }}
                />
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button data-testid="webhook-settings-cancel">Cancel</Button>
              </Dialog.Close>
              <Button type="submit" data-testid="webhook-settings-save" variant="primary">
                Save
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
