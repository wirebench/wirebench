/**
 * The Files tabs' edits in the system editor, as main reports them (spec D4): each file this window opened
 * for editing, its last `sftp.edit` state, and per tab a file above 50 MB waiting for "edit anyway?". Main
 * downloads, watches and uploads; this store only shows it and sends the user's answers back.
 */
import { create } from 'zustand';
import { EDIT_ASK_ABOVE_BYTES } from '../../../../shared/sftp-defaults.js';
import type { SftpEditEvent } from '../../../../shared/sftp-wire.js';
import { showToast } from '../../../components/toast.js';
import { useEditorsStore } from '../../../state/editors.js';
import { ipc } from '../../../state/ipc-client.js';
import { settle, tabOfPane, useFilesStore } from './files-store.js';
import { isFolderLike, joinPath } from './format.js';

export interface EditRow {
  readonly editId: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly name: string;
  /** Main's last word, or `kept` once the user chose to keep the host's version (the copy stays). */
  readonly state: SftpEditEvent['state'] | 'kept';
  readonly error?: string | undefined;
}

/** A file above `EDIT_ASK_ABOVE_BYTES`, waiting for the user to say edit it anyway. */
export interface LargeEdit {
  readonly paneId: string;
  readonly name: string;
  readonly size: number;
}

interface EditsState {
  /** By edit id, in the order they were opened. */
  readonly edits: Readonly<Record<string, EditRow>>;
  /** Per tab. */
  readonly large: Readonly<Record<string, LargeEdit | undefined>>;
  /** Opens a remote file of the pane in the system editor; a large one asks first unless `confirmedLarge`. */
  start: (paneId: string, name: string, confirmedLarge?: boolean) => Promise<void>;
  confirmLarge: (tabId: string) => void;
  dismissLarge: (tabId: string) => void;
  onEdit: (event: SftpEditEvent) => void;
  reply: (editId: string, decision: 'overwrite' | 'keep-remote') => void;
  /** Stops watching; main deletes the copy. */
  stop: (editId: string) => void;
  /** A session ended: main has ended its edits already. */
  noteClosed: (sessionId: string) => void;
  /** The tab closed: every edit of it ends. */
  endTab: (tabId: string) => void;
}

/** The edits of one tab, in the order they were opened. */
export function editsOf(state: Pick<EditsState, 'edits'>, tabId: string): EditRow[] {
  return Object.values(state.edits).filter((row) => row.tabId === tabId);
}

const tabOpen = (tabId: string): boolean => useEditorsStore.getState().tabs.some((t) => t.id === tabId);

const endEdit = (editId: string): void => {
  void ipc()
    .sftp.endEdit({ editId })
    .catch(() => undefined);
};

export const useEditsStore = create<EditsState>()((set, get) => {
  const withoutLarge = (tabId: string) => {
    const large = { ...get().large };
    delete large[tabId];
    return large;
  };

  return {
    edits: {},
    large: {},

    start: async (paneId, name, confirmedLarge = false) => {
      const pane = useFilesStore.getState().panes[paneId];
      const entry = pane?.entries.find((e) => e.name === name);
      if (pane?.place.kind !== 'remote' || entry === undefined || isFolderLike(entry)) return;
      const { sessionId } = pane.place;
      if (sessionId === undefined) return;
      const tabId = tabOfPane(paneId);
      if (entry.size > EDIT_ASK_ABOVE_BYTES && !confirmedLarge) {
        set({ large: { ...get().large, [tabId]: { paneId, name, size: entry.size } } });
        return;
      }
      const path = joinPath(pane.path, name);
      const started = await settle(
        () => ipc().sftp.edit({ sessionId, path, ...(confirmedLarge ? { confirmedLarge: true } : {}) }),
        'The file could not be opened',
      );
      if (!started.ok) {
        // The host's file grew past the line since the listing: ask, as for one listed that large.
        const size = started.error.details?.['size'];
        if (started.error.code === 'sftp-edit-large' && typeof size === 'number') {
          set({ large: { ...get().large, [tabId]: { paneId, name, size } } });
        } else {
          showToast(started.error.message);
        }
        return;
      }
      const { editId } = started.value;
      // The tab closed while the file was downloading: the edit ends at once.
      if (!tabOpen(tabId)) {
        endEdit(editId);
        return;
      }
      set({ edits: { ...get().edits, [editId]: { editId, tabId, sessionId, name, state: 'watching' } } });
    },

    confirmLarge: (tabId) => {
      const large = get().large[tabId];
      set({ large: withoutLarge(tabId) });
      if (large !== undefined) void get().start(large.paneId, large.name, true);
    },

    dismissLarge: (tabId) => {
      set({ large: withoutLarge(tabId) });
    },

    onEdit: (event) => {
      const row = get().edits[event.editId];
      if (row === undefined) return;
      set({ edits: { ...get().edits, [event.editId]: { ...row, state: event.state, error: event.error?.message } } });
    },

    reply: (editId, decision) => {
      const row = get().edits[editId];
      if (row?.state !== 'remote-changed') return;
      // Overwriting waits for main's `uploading`; keeping the host's version ends the watching for good.
      const state = decision === 'keep-remote' ? 'kept' : 'watching';
      set({ edits: { ...get().edits, [editId]: { ...row, state } } });
      void ipc()
        .sftp.editReply({ editId, decision })
        .catch(() => undefined);
    },

    stop: (editId) => {
      const edits = { ...get().edits };
      if (edits[editId] === undefined) return;
      delete edits[editId];
      set({ edits });
      endEdit(editId);
    },

    noteClosed: (sessionId) => {
      const edits = Object.fromEntries(Object.entries(get().edits).filter(([, row]) => row.sessionId !== sessionId));
      if (Object.keys(edits).length !== Object.keys(get().edits).length) set({ edits });
    },

    endTab: (tabId) => {
      for (const row of editsOf(get(), tabId)) get().stop(row.editId);
      set({ large: withoutLarge(tabId) });
    },
  };
});
