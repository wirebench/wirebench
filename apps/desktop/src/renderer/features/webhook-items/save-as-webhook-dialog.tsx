/**
 * *Save as webhook…* (Task 15): pick the project and folder a captured request lands in, then
 * create it there and open its editor. Reached from the capture viewer's own button
 * (`capture-viewer.tsx`, wired up in `catch-url-tab.tsx`).
 *
 * The dialog only ever gets a capture id through `webhook-items-state.ts`'s `saveAs` slot; the
 * capture itself is read back from `save-as-webhook.ts`'s `captureFor`, which the catch-URL tab
 * fills whenever it loads one. If that capture is no longer there — the tab closed, or moved on —
 * there is nothing to save, and the dialog says so instead of trying to refetch it.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { openRestRequestTab } from '../rest-editor/rest-actions.js';
import { INPUT_CLASS } from '../team/roles.js';
import { folderChainOf, useProjectStore } from '../../state/project.js';
import { captureFor, saveAsWebhookDraft } from './save-as-webhook.js';
import { useWebhookItemsDialogs } from './webhook-items-state.js';

const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';
/** Not a real folder id: the `<select>` value for the webhook collection's own root. */
const ROOT_VALUE = '';

export function SaveAsWebhookDialog() {
  const saveAs = useWebhookItemsDialogs((state) => state.saveAs);
  const close = useWebhookItemsDialogs((state) => state.close);
  const projects = useProjectStore((state) => state.projects);
  const folders = useProjectStore((state) => state.folders);

  const projectList = Object.values(projects);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [folderId, setFolderId] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const capture = saveAs === undefined ? undefined : captureFor(saveAs.captureId);
  const result = capture === undefined ? undefined : saveAsWebhookDraft(capture);

  // Filled once per opening: a store update while this is open must not undo what the user picked.
  useEffect(() => {
    if (saveAs === undefined) {
      return;
    }
    setProjectId(Object.values(useProjectStore.getState().projects)[0]?.id);
    setFolderId(undefined);
    setBusy(false);
    const opened = captureFor(saveAs.captureId);
    if (opened === undefined) {
      setError('This capture is no longer available.');
      setName('');
      return;
    }
    const fresh = saveAsWebhookDraft(opened);
    setError(fresh.ok ? undefined : fresh.message);
    setName(fresh.ok ? fresh.name : '');
  }, [saveAs]);

  if (saveAs === undefined) {
    return null;
  }

  const webhookFolders = Object.values(folders).filter((folder) => folder.apiId === `webhooks:${projectId ?? ''}`);
  const folderPath = (id: string): string =>
    folderChainOf(folders, id)
      .map((folder) => folder.name)
      .join(' / ');

  const save = async (): Promise<void> => {
    if (projectId === undefined || result === undefined || !result.ok) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const requestId = await useProjectStore
        .getState()
        .addWebhookRequest(projectId, folderId, name === '' ? undefined : name, result.draft);
      close();
      showToast('Saved as webhook');
      openRestRequestTab(requestId, name === '' ? undefined : name);
    } catch (failure: unknown) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : 'The webhook could not be saved.');
    }
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
          data-testid="save-as-webhook-dialog"
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Save as webhook…</Dialog.Title>

          {error !== undefined && (
            <p role="alert" data-testid="save-as-webhook-error" className="mt-3 text-xs text-status-danger">
              {error}
            </p>
          )}

          {result?.ok === true && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label className={LABEL_CLASS} htmlFor="save-as-webhook-project">
                Project
              </label>
              <select
                id="save-as-webhook-project"
                data-testid="save-as-webhook-project"
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setFolderId(undefined);
                }}
                className={INPUT_CLASS}
              >
                {projectList.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>

              <label className={LABEL_CLASS} htmlFor="save-as-webhook-folder">
                Folder
              </label>
              <select
                id="save-as-webhook-folder"
                data-testid="save-as-webhook-folder"
                value={folderId ?? ROOT_VALUE}
                onChange={(event) => setFolderId(event.target.value === ROOT_VALUE ? undefined : event.target.value)}
                className={INPUT_CLASS}
              >
                <option value={ROOT_VALUE}>Webhooks</option>
                {webhookFolders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folderPath(folder.id)}
                  </option>
                ))}
              </select>

              <label className={LABEL_CLASS} htmlFor="save-as-webhook-name">
                Name
              </label>
              <input
                id="save-as-webhook-name"
                data-testid="save-as-webhook-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={INPUT_CLASS}
              />

              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button data-testid="save-as-webhook-cancel">Cancel</Button>
                </Dialog.Close>
                <Button
                  type="submit"
                  data-testid="save-as-webhook-save"
                  variant="primary"
                  disabled={busy || projectId === undefined || name === ''}
                >
                  Save
                </Button>
              </div>
            </form>
          )}

          {result?.ok !== true && (
            <div className="mt-4 flex justify-end">
              <Dialog.Close asChild>
                <Button data-testid="save-as-webhook-close">Close</Button>
              </Dialog.Close>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
