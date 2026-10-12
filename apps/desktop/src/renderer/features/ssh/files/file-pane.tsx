import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowUp, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { IconButton } from '../../../components/icon-button.js';
import { FileList } from './file-list.js';
import { useFilesStore } from './files-store.js';
import { isFolderLike, joinRemote, visibleEntries } from './format.js';
import { PathBar } from './path-bar.js';

/**
 * One pane of a Files tab: Back, Up, Refresh and the hidden-entries toggle, the path bar, a refusal under it
 * when a folder could not be listed (the listing stays), and the list.
 */
export function FilePane({ tabId }: { readonly tabId: string }) {
  const pane = useFilesStore((s) => s.panes[tabId]);
  const showHidden = useFilesStore((s) => s.showHidden);
  const pathEdit = useFilesStore((s) => s.pathEditRequests[tabId] ?? 0);
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
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="files-pane"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
          e.preventDefault();
          store().requestPathEdit(tabId);
        }
      }}
    >
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
      />
    </div>
  );
}
