import { useEffect } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ArrowLeftRight, FolderPlus, Lock, PencilLine, SquareTerminal, Trash2 } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { IconButton } from '../../../components/icon-button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { setCloseGuard, useEditorsStore } from '../../../state/editors.js';
import { ConflictDialog } from './conflict-dialog.js';
import { EditBanner } from './edit-banner.js';
import { fileActions } from './file-actions.js';
import { useEditsStore } from './edits-store.js';
import { FilePane } from './file-pane.js';
import { formatSize } from './format.js';
import { localPaneId, useFilesStore } from './files-store.js';
import { openTerminal } from './open-files.js';
import { TransfersStrip } from './transfers-strip.js';
import { listenToTransfers, useTransfersStore } from './transfers-store.js';
import type { SftpEditEvent } from '../../../../shared/sftp-wire.js';

const SEPARATOR = 'w-px bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/**
 * The tab's toolbar: what the right-click menu offers for the pane in use (the host's until the other is
 * used), as icon buttons, each disabled when that pane's selection does not allow it.
 */
function FilesToolbar({ tabId }: { readonly tabId: string }) {
  const paneId = useFilesStore((s) => {
    const id = s.activePanes[tabId] ?? tabId;
    return s.panes[id] === undefined ? tabId : id;
  });
  const pane = useFilesStore((s) => s.panes[paneId]);
  const ready = pane !== undefined && pane.status !== 'connecting' && pane.status !== 'error' && pane.path !== '';
  const count = pane?.selected.length ?? 0;
  const local = pane?.place.kind === 'local';
  return (
    <div role="toolbar" aria-label="Files" data-testid="files-toolbar" className="flex items-center gap-0.5">
      <IconButton
        label="New folder"
        disabled={!ready}
        onClick={() => {
          fileActions.newFolder(paneId);
        }}
      >
        <FolderPlus size={14} aria-hidden="true" />
      </IconButton>
      <IconButton
        label="Rename"
        disabled={!ready || count !== 1}
        onClick={() => {
          fileActions.rename(paneId);
        }}
      >
        <PencilLine size={14} aria-hidden="true" />
      </IconButton>
      <IconButton
        label="Delete…"
        disabled={!ready || count === 0}
        onClick={() => {
          fileActions.remove(paneId);
        }}
      >
        <Trash2 size={14} aria-hidden="true" />
      </IconButton>
      {/* Permissions are changed on a host only, so this machine's pane has no button for them. */}
      {!local && (
        <IconButton
          label="Permissions…"
          disabled={!ready || count !== 1}
          onClick={() => {
            fileActions.permissions(paneId);
          }}
        >
          <Lock size={14} aria-hidden="true" />
        </IconButton>
      )}
      <IconButton
        label="Copy to other pane"
        disabled={!ready || count === 0}
        onClick={() => {
          fileActions.copyToOtherPane(paneId);
        }}
      >
        <ArrowLeftRight size={14} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

/**
 * A host's Files tab: this machine on the left, the host on the right through the tab's own SFTP session
 * (separate from the terminal's), opened when the tab mounts and closed when the tab goes. Either pane's place
 * picker moves it to this machine or another host, each host pane with its own session; the transfers strip
 * under both, and the conflict question over them. The tab stays mounted behind other tabs, like a terminal,
 * so switching away keeps the folders, the session and the copies. Closing it with copies running asks first.
 * Files open in the system editor are listed in the editing banner over the panes; closing the tab ends them.
 */
export function FilesTab({ tabId, hostId }: { readonly tabId: string; readonly hostId: string }) {
  const conflict = useTransfersStore((s) => s.conflicts[tabId]?.[0] ?? null);
  const closing = useTransfersStore((s) => s.closing[tabId] === true);
  const large = useEditsStore((s) => s.large[tabId]);

  useEffect(() => {
    const files = useFilesStore.getState();
    if (files.panes[tabId] === undefined) void files.connect(tabId, hostId);
    void files.openLocal(localPaneId(tabId));
    const off = window.wirebench.on('sftp.closed', ((event: { sessionId: string }) => {
      useFilesStore.getState().noteClosed(event.sessionId);
      useEditsStore.getState().noteClosed(event.sessionId);
    }) as (payload: unknown) => void);
    const offEdit = window.wirebench.on('sftp.edit', ((event: SftpEditEvent) => {
      useEditsStore.getState().onEdit(event);
    }) as (payload: unknown) => void);
    const stopListening = listenToTransfers();
    setCloseGuard(tabId, () => useTransfersStore.getState().holdClose(tabId));
    return () => {
      off();
      offEdit();
      stopListening();
      setCloseGuard(tabId, undefined);
      // A remount of the same tab (StrictMode, an area toggle) keeps the session; a closed tab ends it.
      if (!useEditorsStore.getState().tabs.some((t) => t.id === tabId)) {
        useFilesStore.getState().close(tabId);
        useTransfersStore.getState().forgetTab(tabId);
        useEditsStore.getState().endTab(tabId);
      }
    };
  }, [tabId, hostId]);

  return (
    <div className="flex h-full flex-col" data-testid="ssh-files">
      <div className="flex items-center gap-2 border-b border-hairline px-2 py-1">
        <FilesToolbar tabId={tabId} />
        <span className="min-w-0 flex-1" />
        <Button
          variant="ghost"
          onClick={() => {
            openTerminal(hostId);
          }}
        >
          <SquareTerminal size={14} aria-hidden="true" /> Open terminal
        </Button>
      </div>
      <EditBanner tabId={tabId} />
      <Group orientation="horizontal" className="flex min-h-0 flex-1">
        <Panel id="files-local-pane" defaultSize="50%" minSize="20%">
          <FilePane paneId={localPaneId(tabId)} />
        </Panel>
        <Separator aria-label="Resize" className={SEPARATOR} />
        <Panel id="files-remote-pane" minSize="20%">
          <FilePane paneId={tabId} />
        </Panel>
      </Group>
      <TransfersStrip tabId={tabId} />
      <ConflictDialog
        conflict={conflict}
        onAnswer={(decision, applyToRest) => {
          useTransfersStore.getState().answer(tabId, decision, applyToRest);
        }}
      />
      <ConfirmDialog
        open={closing}
        onOpenChange={(open) => {
          if (!open) useTransfersStore.getState().dismissClose(tabId);
        }}
        title="Cancel the copies?"
        description="Files are still being copied in this tab. Closing it cancels them; files not finished are not kept."
        confirmLabel="Cancel copies and close"
        destructive
        onConfirm={() => {
          useTransfersStore.getState().confirmClose(tabId);
        }}
        testId="files-close-confirm"
        confirmTestId="files-close-confirm-ok"
      />
      <ConfirmDialog
        open={large !== undefined}
        onOpenChange={(open) => {
          if (!open) useEditsStore.getState().dismissLarge(tabId);
        }}
        title="Edit a large file?"
        description={
          large === undefined
            ? ''
            : `${large.name} is ${formatSize(large.size)}. It is downloaded in full, and each save uploads all of it.`
        }
        confirmLabel="Edit"
        onConfirm={() => {
          useEditsStore.getState().confirmLarge(tabId);
        }}
        testId="files-edit-large"
        confirmTestId="files-edit-large-ok"
      />
    </div>
  );
}
