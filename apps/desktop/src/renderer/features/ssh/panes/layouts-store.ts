import { create } from 'zustand';
import type { IpcError } from '@shared/ipc.js';
import type { LayoutNodeWire, LayoutWire } from '@shared/layout-wire.js';
import { ipc } from '../../../state/ipc-client.js';

type Answer<T> = { ok: true; value: T } | { ok: false; error: IpcError };

interface LayoutsState {
  /** The open workspace's saved layouts on this machine, in the order they were made. */
  layouts: readonly LayoutWire[];
  loaded: boolean;
  refresh: () => Promise<void>;
  /** No `id` creates; a refusal (`ssh-layout-name-taken`, …) is answered for the dialog to show. */
  save: (input: { id?: string; name: string; root: LayoutNodeWire }) => Promise<Answer<LayoutWire>>;
  rename: (id: string, name: string) => Promise<Answer<undefined>>;
  remove: (id: string) => Promise<Answer<undefined>>;
  /** The terminal tab whose Save layout… dialog is open, if any (the toolbar and the command both open it). */
  savingTabId: string | undefined;
  setSavingTabId: (tabId: string | undefined) => void;
  /** Forgets the open workspace's layouts (a workspace switch). */
  reset: () => void;
}

/** The SSH area's saved layouts, read from main (`layout.*`); main keeps them per machine and workspace. */
export const useLayoutsStore = create<LayoutsState>()((set, get) => ({
  layouts: [],
  loaded: false,
  savingTabId: undefined,
  setSavingTabId: (savingTabId) => {
    set({ savingTabId });
  },
  async refresh() {
    const result = await ipc().layout.list({});
    if (result.ok) set({ layouts: result.value.layouts, loaded: true });
  },
  async save(input) {
    const result = await ipc().layout.save(input);
    if (!result.ok) return result;
    await get().refresh();
    return { ok: true, value: result.value.layout };
  },
  async rename(id, name) {
    const result = await ipc().layout.rename({ id, name });
    if (!result.ok) return result;
    await get().refresh();
    return { ok: true, value: undefined };
  },
  async remove(id) {
    const result = await ipc().layout.delete({ id });
    if (!result.ok) return result;
    await get().refresh();
    return { ok: true, value: undefined };
  },
  reset: () => {
    set({ layouts: [], loaded: false, savingTabId: undefined });
  },
}));

/** Reads the layouts again without waiting; a failure leaves the list as it was. */
export function refreshLayouts(): void {
  useLayoutsStore
    .getState()
    .refresh()
    .catch(() => undefined);
}
