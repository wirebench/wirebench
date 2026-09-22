/**
 * Which REST API's Update Definition dialog is open, if any. A store rather than component state
 * because the explorer menu and the command palette open it from outside the API tab, before the
 * tab may even exist; the tab mounts the dialog when it sees its own id here.
 */
import { create } from 'zustand';

export interface RestUpdateStore {
  readonly apiId: string | undefined;
  readonly open: (apiId: string) => void;
  readonly close: () => void;
}

export const useRestUpdateStore = create<RestUpdateStore>((set) => ({
  apiId: undefined,
  open: (apiId) => set({ apiId }),
  close: () => set({ apiId: undefined }),
}));
