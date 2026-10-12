import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowUp, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { IconButton } from '../../../components/icon-button.js';
import { DeleteDialog } from './delete-dialog.js';
import { fileActions } from './file-actions.js';
import { FileList } from './file-list.js';
import { FileMenu } from './file-menu.js';
import { useFilesStore } from './files-store.js';
import { isFolderLike, joinRemote, visibleEntries } from './format.js';
import { PathBar } from './path-bar.js';
import { PermissionsDialog } from './permissions-dialog.js';
import { RenameField } from './rename-field.js';

/**
 * One pane of a Files tab: Back, Up, Refresh and the hidden-entries toggle, the path bar, a refusal under it
 * when a folder could not be listed (the listing stays), and the list with its menu: rename in place (F2),
 * delete with confirmation (Delete), new folder, permissions, copy path and refresh.
 */
export function FilePane({ tabId }: { readonly tabId: string }) {
  const pane = useFilesStore((s) => s.panes[tabId]);
  const showHidden = useFilesStore((s) => s.showHidden);
  const pathEdit = useFilesStore((s) => s.pathEditRequests[tabId] ?? 0);
  const dialog = useFilesStore((s) => s.dialogs[tabId]);
  const renaming = useFilesStore((s) => s.renaming[tabId]);
  const store = useFilesStore.getState;
  const [focusList, setFocusList] = useState(0);
  const entries = useMemo(
    () => (pane === undefined ? [] : visibleEntries(pane.entries, showHidden, pane.sort)),
    [pane, showHidden],
  );

  if (pane === undefined) return null;
  const connected = pane.place.sessionId !== undefined;

  if (pane.status === 'connecting') {
    return <p className="p-4 text-sm text-fg-subtle">Connecting…</p>;
  }
  if (pane.status === 'error') {
    return (
      <div className="flex items-center gap-3 p-4 text-sm text-fg-default" role="alert">
        <span className="min-w-0 flex-1">{pane.error?.message ?? 'Could not connect.'}</span>
        <Button
          onClick={() => {
            void store().connect(tabId, pane.place.hostId);
          }}
        >
          Connect again
        </Button>
      </div>
    );
  }

  const navigate = async (path: string): Promise<boolean> => {
    const ok = await store().navigate(tabId, path, { push: true });
    if (ok) setFocusList((n) => n + 1);
    return ok;
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="files-pane">
      <div className="flex items-center gap-1 border-b border-hairline px-2 py-1">
        <IconButton
          label="Back"
          disabled={pane.history.length === 0}
          onClick={() => {
            void store().back(tabId);
          }}
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Up"
          disabled={pane.path === '/' || !connected}
          onClick={() => {
            void store().up(tabId);
          }}
        >
          <ArrowUp size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Refresh"
          onClick={() => {
            void store().refresh(tabId);
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
          open: () => {
            fileActions.open(tabId);
          },
          rename: () => {
            fileActions.rename(tabId);
          },
          remove: () => {
            fileActions.remove(tabId);
          },
          permissions: () => {
            fileActions.permissions(tabId);
          },
          newFolder: () => {
            fileActions.newFolder(tabId);
          },
          copyPath: () => {
            fileActions.copyPath(tabId);
          },
          refresh: () => {
            fileActions.refresh(tabId);
          },
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <FileList
            listKey={pane.path}
            entries={entries}
            selected={pane.selected}
            sort={pane.sort}
            focusRequest={focusList}
            onSort={(sort) => {
              store().setSort(tabId, sort);
            }}
            onSelect={(names) => {
              store().select(tabId, names);
            }}
            onOpen={(entry) => {
              if (isFolderLike(entry)) void navigate(joinRemote(pane.path, entry.name));
            }}
            onUp={() => {
              void store().up(tabId);
            }}
            onRowContextMenu={(entry) => {
              if (!pane.selected.includes(entry.name)) store().select(tabId, [entry.name]);
            }}
            onKey={(event) => {
              if (event.key === 'F2') fileActions.rename(tabId);
              else if (event.key === 'Delete' || ((event.metaKey || event.ctrlKey) && event.key === 'Backspace')) {
                fileActions.remove(tabId);
              } else return false;
              event.preventDefault();
              return true;
            }}
            renderName={(entry) =>
              entry.name === renaming ? (
                <RenameField
                  name={entry.name}
                  onCommit={(to) => {
                    store().setRenaming(tabId, undefined);
                    void store().rename(tabId, entry.name, to);
                    setFocusList((n) => n + 1);
                  }}
                  onCancel={() => {
                    store().setRenaming(tabId, undefined);
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
          store().setDialog(tabId, undefined);
        }}
        onConfirm={() => {
          if (dialog?.kind !== 'delete') return;
          store().setDialog(tabId, undefined);
          void store().remove(tabId, dialog.names);
        }}
      />
      <PermissionsDialog
        target={dialog?.kind === 'permissions' ? dialog : null}
        onCancel={() => {
          store().setDialog(tabId, undefined);
        }}
        onApply={(mode) => {
          if (dialog?.kind !== 'permissions') return;
          store().setDialog(tabId, undefined);
          void store().chmod(tabId, dialog.name, mode);
        }}
      />
    </div>
  );
}
