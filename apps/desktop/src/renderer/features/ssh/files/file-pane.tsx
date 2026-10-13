import { useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { ArrowLeft, ArrowUp, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { IconButton } from '../../../components/icon-button.js';
import { useHostsStore } from '../hosts-store.js';
import { DeleteDialog } from './delete-dialog.js';
import { useEditsStore } from './edits-store.js';
import { fileActions } from './file-actions.js';
import { FileList } from './file-list.js';
import { FileMenu } from './file-menu.js';
import { otherPaneId, useFilesStore } from './files-store.js';
import { isFolderLike, joinPath, parentOf, visibleEntries } from './format.js';
import { PathBar } from './path-bar.js';
import { PermissionsDialog } from './permissions-dialog.js';
import { PlacePicker } from './place-picker.js';
import { RenameField } from './rename-field.js';
import { useTransfersStore } from './transfers-store.js';

/** The drag type of entries dragged out of a pane; its value is the pane's id. */
const DRAG_TYPE = 'application/x-wirebench-files';

/** What is being dragged out of a pane of this window right now. */
let dragging: { readonly paneId: string; readonly names: readonly string[] } | undefined;

/**
 * One pane of a Files tab, this machine's or a host's, with its place picker to switch it to another: Back, Up, Refresh and the hidden-entries toggle,
 * the path bar, a refusal under it when a folder could not be listed (the listing stays), and the list with
 * its menu: copy to the other pane, rename in place (F2), delete with confirmation (Delete), new folder,
 * permissions (on a host), copy path and refresh. Enter or a double click on a host's file edits it in the
 * system editor. Entries dragged onto the other pane, or onto a folder in
 * it, are copied there; files dropped from the OS onto a host's pane are uploaded. Tab moves to the other
 * pane.
 */
export function FilePane({ paneId }: { readonly paneId: string }) {
  const pane = useFilesStore((s) => s.panes[paneId]);
  const showHidden = useFilesStore((s) => s.showHidden);
  const pathEdit = useFilesStore((s) => s.pathEditRequests[paneId] ?? 0);
  const dialog = useFilesStore((s) => s.dialogs[paneId]);
  const renaming = useFilesStore((s) => s.renaming[paneId]);
  const focusRequest = useFilesStore((s) => s.focusRequests[paneId] ?? 0);
  // Re-reads the host's name when the hosts file changes.
  useHostsStore((s) => s.file);
  const store = useFilesStore.getState;
  const [focusList, setFocusList] = useState(0);
  const [dropping, setDropping] = useState(false);
  const entries = useMemo(
    () => (pane === undefined ? [] : visibleEntries(pane.entries, showHidden, pane.sort)),
    [pane, showHidden],
  );

  if (pane === undefined) return null;
  const { place } = pane;
  const local = place.kind === 'local';
  const ready = place.kind === 'local' || place.sessionId !== undefined;
  const header = (
    <div className="flex items-center gap-1.5 border-b border-hairline px-3 py-1 text-xs text-fg-subtle">
      <PlacePicker
        place={place}
        onPick={(choice) => {
          void store().switchPlace(paneId, choice);
        }}
      />
    </div>
  );

  if (pane.status === 'connecting' || pane.status === 'error') {
    return (
      <div className="flex h-full flex-col" data-testid="files-pane" data-place={place.kind}>
        {header}
        {pane.status === 'connecting' ? (
          <p className="p-4 text-sm text-fg-subtle">Connecting…</p>
        ) : (
          <div className="flex items-center gap-3 p-4 text-sm text-fg-default" role="alert">
            <span className="min-w-0 flex-1">{pane.error?.message ?? 'Could not connect.'}</span>
            <Button
              onClick={() => {
                if (place.kind === 'remote') void store().connect(paneId, place.hostId);
                else void store().openLocal(paneId);
              }}
            >
              {place.kind === 'remote' ? 'Connect again' : 'Try again'}
            </Button>
          </div>
        )}
      </div>
    );
  }

  const navigate = async (path: string): Promise<boolean> => {
    const ok = await store().navigate(paneId, path, { push: true });
    if (ok) setFocusList((n) => n + 1);
    return ok;
  };

  /** A drag from the other pane of this window, or files from the OS onto a host's pane: a copy. */
  const accepts = (event: DragEvent): boolean => {
    const types = Array.from(event.dataTransfer.types);
    if (types.includes(DRAG_TYPE)) return dragging !== undefined && dragging.paneId !== paneId;
    return types.includes('Files') && !local;
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDropping(false);
    if (!accepts(event)) return;
    event.preventDefault();
    // Onto a folder row: into that folder; anywhere else: into the folder shown.
    const folder = (event.target as HTMLElement).closest('[data-folder="true"]')?.getAttribute('data-name');
    const toDir = folder === null || folder === undefined ? undefined : joinPath(pane.path, folder);
    const transfers = useTransfersStore.getState();
    const from = dragging;
    if (from !== undefined && Array.from(event.dataTransfer.types).includes(DRAG_TYPE)) {
      dragging = undefined;
      void transfers.copy(from.paneId, from.names, paneId, toDir);
      return;
    }
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => window.wirebench.pathForFile(file))
      .filter((path) => path !== '');
    void transfers.upload(paths, paneId, toDir);
  };

  return (
    <div
      className={`flex h-full min-h-0 flex-col ${dropping ? 'ring-1 ring-accent ring-inset' : ''}`}
      data-testid="files-pane"
      data-place={place.kind}
      onFocusCapture={() => {
        store().setActivePane(paneId);
      }}
      onMouseDownCapture={() => {
        store().setActivePane(paneId);
      }}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
      onDragEnd={() => {
        dragging = undefined;
      }}
    >
      {header}
      <div className="flex items-center gap-1 border-b border-hairline px-2 py-1">
        <IconButton
          label="Back"
          disabled={pane.history.length === 0}
          onClick={() => {
            void store().back(paneId);
          }}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Up"
          disabled={pane.path === '' || parentOf(pane.path) === pane.path || !ready}
          onClick={() => {
            void store().up(paneId);
          }}
        >
          <ArrowUp size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Refresh"
          onClick={() => {
            void store().refresh(paneId);
          }}
        >
          <RefreshCw size={14} aria-hidden="true" className={pane.status === 'loading' ? 'animate-spin' : ''} />
        </IconButton>
        <PathBar path={pane.path} home={pane.home} onNavigate={navigate} editRequest={pathEdit} />
        <IconButton
          label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
          active={showHidden}
          onClick={() => {
            store().setShowHidden(!showHidden);
          }}
        >
          {showHidden ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
        </IconButton>
      </div>
      {pane.error !== undefined && (
        <p
          role="alert"
          data-testid="files-path-error"
          className="border-b border-hairline px-3 py-1 text-sm text-status-danger"
        >
          {pane.error.message}
        </p>
      )}
      <FileMenu
        actions={{
          count: pane.selected.length,
          folder: pane.entries.some((e) => pane.selected.includes(e.name) && isFolderLike(e)),
          local,
          open: () => {
            fileActions.open(paneId);
          },
          copyToOtherPane: () => {
            fileActions.copyToOtherPane(paneId);
          },
          rename: () => {
            fileActions.rename(paneId);
          },
          remove: () => {
            fileActions.remove(paneId);
          },
          permissions: () => {
            fileActions.permissions(paneId);
          },
          newFolder: () => {
            fileActions.newFolder(paneId);
          },
          copyPath: () => {
            fileActions.copyPath(paneId);
          },
          refresh: () => {
            fileActions.refresh(paneId);
          },
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <FileList
            listKey={pane.path}
            entries={entries}
            selected={pane.selected}
            sort={pane.sort}
            focusRequest={focusList + focusRequest}
            onSort={(sort) => {
              store().setSort(paneId, sort);
            }}
            onSelect={(names) => {
              store().select(paneId, names);
            }}
            onOpen={(entry) => {
              if (isFolderLike(entry)) void navigate(joinPath(pane.path, entry.name));
              else if (!local) void useEditsStore.getState().start(paneId, entry.name);
            }}
            onUp={() => {
              void store().up(paneId);
            }}
            onRowContextMenu={(entry) => {
              if (!pane.selected.includes(entry.name)) store().select(paneId, [entry.name]);
            }}
            onRowDragStart={(entry, event) => {
              const names = pane.selected.includes(entry.name) ? pane.selected : [entry.name];
              if (names !== pane.selected) store().select(paneId, names);
              dragging = { paneId, names };
              event.dataTransfer.setData(DRAG_TYPE, paneId);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onKey={(event) => {
              if (event.key === 'F2') fileActions.rename(paneId);
              else if (event.key === 'Delete' || ((event.metaKey || event.ctrlKey) && event.key === 'Backspace')) {
                fileActions.remove(paneId);
              } else if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey) {
                store().focusPane(otherPaneId(paneId));
              } else return false;
              event.preventDefault();
              return true;
            }}
            renderName={(entry) =>
              entry.name === renaming ? (
                <RenameField
                  name={entry.name}
                  onCommit={(to) => {
                    store().setRenaming(paneId, undefined);
                    void store().rename(paneId, entry.name, to);
                    setFocusList((n) => n + 1);
                  }}
                  onCancel={() => {
                    store().setRenaming(paneId, undefined);
                  }}
                />
              ) : undefined
            }
          />
        </div>
      </FileMenu>
      <DeleteDialog
        target={dialog?.kind === 'delete' ? dialog : null}
        onCancel={() => {
          store().setDialog(paneId, undefined);
        }}
        onConfirm={() => {
          if (dialog?.kind !== 'delete') return;
          store().setDialog(paneId, undefined);
          void store().remove(paneId, dialog.names);
        }}
      />
      <PermissionsDialog
        target={dialog?.kind === 'permissions' ? dialog : null}
        onCancel={() => {
          store().setDialog(paneId, undefined);
        }}
        onApply={(mode) => {
          if (dialog?.kind !== 'permissions') return;
          store().setDialog(paneId, undefined);
          void store().chmod(paneId, dialog.name, mode);
        }}
      />
    </div>
  );
}
