/**
 * The logic behind the Attachments inspector's two toolbar actions, kept here so the palette
 * commands (`request.addAttachment`, `request.removeAttachment`) and the inspector's buttons
 * can never drift apart — the same shape `explorer-actions.ts` uses for the explorer.
 */

import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';

/**
 * Shows the native Add-attachments picker and attaches everything it returns.
 *
 * The picker is what makes a file outside the project legal for main to read at all (it records
 * the pick), so this is the only way to add a file by path — the renderer never names one.
 *
 * @param requestId - the request to attach to
 * @param copyToCache - copy the bytes into `attachments/<sha256>` (the default) or reference them
 */
export async function addAttachmentsThroughPicker(requestId: string, copyToCache = true): Promise<void> {
  const picked = await ipc().attachments.pickFiles({});
  if (!picked.ok) {
    showToast(picked.error.message);
    return;
  }
  for (const path of picked.value.paths) {
    try {
      await useProjectStore.getState().addAttachment(requestId, path, { copyToCache });
    } catch (error) {
      showToast(error instanceof Error ? error.message : `Could not add "${path}"`);
    }
  }
}

/**
 * Detaches the attachment row selected in this request's inspector, if any.
 *
 * Unlike the inspector's Remove button this never prompts: a palette command is already an
 * explicit, named action, and the cached bytes are left in place either way.
 *
 * @param requestId - the request whose selected attachment to detach
 */
export async function removeSelectedAttachment(requestId: string): Promise<void> {
  const editors = useEditorsStore.getState();
  const attachmentId = editors.selectedAttachmentFor(requestId);
  if (attachmentId === undefined) {
    return;
  }
  editors.setSelectedAttachment(requestId, undefined);
  try {
    await useProjectStore.getState().removeAttachment(requestId, attachmentId);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not remove the attachment');
  }
}
