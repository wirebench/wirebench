/** Which host the Delete confirm asks about: apart from the dialog, which loads only once it opens. */
import { create } from 'zustand';

interface HostDeleteState {
  /** The host the confirm asks about, or `null` while it is closed. */
  readonly hostId: string | null;
  readonly ask: (hostId: string) => void;
  readonly cancel: () => void;
}

export const useHostDelete = create<HostDeleteState>((set) => ({
  hostId: null,
  ask: (hostId) => {
    set({ hostId });
  },
  cancel: () => {
    set({ hostId: null });
  },
}));
