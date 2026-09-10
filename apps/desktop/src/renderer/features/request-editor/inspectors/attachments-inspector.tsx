import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useState } from 'react';
import { showToast } from '../../../components/toast.js';
import { ipc } from '../../../state/ipc-client.js';
import { useEditorsStore } from '../../../state/editors.js';
import { usePreferencesStore } from '../../../state/preferences.js';
import { useProjectStore } from '../../../state/project.js';
import { useUiStore } from '../../../state/ui.js';
import type { AttachmentPatchWire, MimePartWire } from '../../../../shared/wire-types.js';
import { AttachmentsTable } from './attachments-table.js';

/** Per-file cap of `attachments.addDropped`, mirrored here only to word the toast. */
const MAX_DROP_BYTES = 32 * 1024 * 1024;

/** Base64 for a dropped file's bytes, chunked so a multi-MB file cannot blow the argument list. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

export interface AttachmentsInspectorProps {
  readonly requestId: string;
}

/**
 * The request pane's Attachments inspector: the files this request sends alongside its envelope,
 * as MTOM/XOP parts or SwA parts depending on the request's MTOM flags.
 *
 * No file ever passes through this component. Adding goes through the native picker
 * (`attachments.pickFiles`, which is also what makes a path outside the project legal for main
 * to read); dropping sends the browser's own bytes to `attachments.addDropped`, because a
 * dropped path is evidence of nothing on the main side.
 */
export function AttachmentsInspector({ requestId }: AttachmentsInspectorProps) {
  const request = useProjectStore((state) => state.requests[requestId]);
  const summary = useProjectStore((state) =>
    request === undefined ? undefined : state.interfaces[request.interfaceId],
  );
  const addAttachment = useProjectStore((state) => state.addAttachment);
  const updateAttachment = useProjectStore((state) => state.updateAttachment);
  const removeAttachment = useProjectStore((state) => state.removeAttachment);
  const confirmOnDelete = usePreferencesStore((state) => state.preferences.ui.confirmOnDelete);
  const selectedId = useEditorsStore((state) => state.selectedAttachmentFor(requestId));
  const setSelectedAttachment = useEditorsStore((state) => state.setSelectedAttachment);

  const [copyToCache, setCopyToCache] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | undefined>(undefined);
  const [outsideProjectIds, setOutsideProjectIds] = useState<ReadonlySet<string>>(new Set());

  if (request === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const attachments = request.attachments;
  const mimeParts: readonly MimePartWire[] =
    summary?.operations.find(
      (operation) => operation.binding === request.bindingName && operation.name === request.operationName,
    )?.inputMimeParts ?? [];

  const add = async (): Promise<void> => {
    const picked = await ipc().attachments.pickFiles({});
    if (!picked.ok) {
      showToast(picked.error.message);
      return;
    }
    for (const path of picked.value.paths) {
      try {
        await addAttachment(requestId, path, { copyToCache });
      } catch (error) {
        showToast(error instanceof Error ? error.message : `Could not add "${path}"`);
      }
    }
  };

  const remove = (attachmentId: string): void => {
    setSelectedAttachment(requestId, undefined);
    setPendingRemoveId(undefined);
    void removeAttachment(requestId, attachmentId).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Could not remove the attachment');
    });
  };

  const requestRemove = (): void => {
    if (selectedId === undefined) return;
    if (confirmOnDelete) {
      setPendingRemoveId(selectedId);
      return;
    }
    remove(selectedId);
  };

  const open = async (attachmentId: string): Promise<void> => {
    const result = await ipc().attachments.openRequest({ requestId, attachmentId });
    if (result.ok) {
      return;
    }
    // Main refused the path: an attachment referenced (not copied) in an earlier session has no
    // standing evidence that the user ever picked it, so the row is flagged from here on.
    if (result.error.code === 'attachment-outside-project') {
      setOutsideProjectIds((current) => new Set(current).add(attachmentId));
    }
    showToast(result.error.message);
  };

  const drop = async (files: readonly File[]): Promise<void> => {
    const payload: { name: string; contentType: string; bytesBase64: string }[] = [];
    for (const file of files) {
      if (file.size > MAX_DROP_BYTES) {
        showToast(`"${file.name}" is larger than the 32 MiB drop limit`);
        continue;
      }
      payload.push({
        name: file.name,
        contentType: file.type,
        bytesBase64: toBase64(new Uint8Array(await file.arrayBuffer())),
      });
    }
    if (payload.length === 0) return;
    const result = await ipc().attachments.addDropped({ requestId, files: payload });
    if (!result.ok) {
      showToast(result.error.message);
    }
  };

  const patch = (attachmentId: string, next: AttachmentPatchWire): void => {
    updateAttachment(requestId, attachmentId, next);
  };

  const mtomOff = !request.properties.enableMtom && !request.properties.enableInlineFiles;

  return (
    <div
      className={`flex flex-col gap-2 p-2 ${dragging ? 'bg-accent-muted ring-1 ring-accent ring-inset' : ''}`}
      data-testid="attachments-dropzone"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => {
        setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void drop([...event.dataTransfer.files]);
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="attachments-add"
          onClick={() => {
            void add();
          }}
          className="h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-3 text-xs text-fg-default hover:bg-surface-hover"
        >
          Add…
        </button>
        <button
          type="button"
          data-testid="attachments-remove"
          disabled={selectedId === undefined}
          onClick={requestRemove}
          className="h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-3 text-xs text-fg-default hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          Remove
        </button>
        <label className="flex items-center gap-1 text-xs text-fg-muted">
          <input
            type="checkbox"
            data-testid="attachments-copy"
            checked={copyToCache}
            onChange={(event) => {
              setCopyToCache(event.target.checked);
            }}
          />
          Copy to project
        </label>
        <span className="ml-auto text-xs text-fg-faint">
          {attachments.length} {attachments.length === 1 ? 'attachment' : 'attachments'}
        </span>
      </div>

      {mtomOff && attachments.length > 0 && (
        <p className="text-xs text-fg-subtle">
          MTOM is off — attachments are sent as SwA parts{' '}
          <button
            type="button"
            className="underline hover:text-fg-default"
            onClick={() => {
              useUiStore.getState().showDetails('selection');
            }}
          >
            Request properties
          </button>
        </p>
      )}

      {attachments.length === 0 ? (
        <p className="text-sm text-fg-subtle">
          No attachments. Add files or drop them here. Reference one from the envelope as{' '}
          <code className="font-mono">cid:&lt;Content-ID&gt;</code>.
        </p>
      ) : (
        <AttachmentsTable
          attachments={attachments}
          mimeParts={mimeParts}
          selectedId={selectedId}
          outsideProjectIds={outsideProjectIds}
          onSelect={(attachmentId) => {
            setSelectedAttachment(requestId, attachmentId);
          }}
          onPatch={patch}
          onOpen={(attachmentId) => {
            void open(attachmentId);
          }}
          onRemoveSelected={requestRemove}
        />
      )}

      <AlertDialog.Root
        open={pendingRemoveId !== undefined}
        onOpenChange={(next) => !next && setPendingRemoveId(undefined)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg">
            <AlertDialog.Title className="text-md font-medium text-fg-default">Remove attachment?</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
              It is detached from this request. A copy already in the project cache is left in place.
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button type="button" className="rounded px-3 py-1.5 text-sm text-fg-default hover:bg-surface-base">
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="rounded bg-danger px-3 py-1.5 text-sm text-fg-onAccent"
                  onClick={() => {
                    if (pendingRemoveId !== undefined) remove(pendingRemoveId);
                  }}
                >
                  Remove
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
