import { create } from 'zustand';
import { useEditorsStore } from '../../state/editors.js';

/**
 * One local terminal tab's shell (#410): opening, running, or ended (with its exit code, or why it never
 * started). Keyed by tab: a tab holds one shell, and Restart replaces it.
 */
export interface LocalSession {
  readonly state: 'connecting' | 'open' | 'closed';
  readonly sessionId?: string;
  /** The shell's short name (`zsh`, `pwsh`), once main has started it. */
  readonly shell?: string;
  /** The code the shell exited with; `null` when it ended on a signal. */
  readonly code?: number | null;
  /** Why the shell did not start. */
  readonly error?: string;
}

interface LocalTerminalsState {
  readonly sessions: Readonly<Record<string, LocalSession>>;
  setSession(tabId: string, session: LocalSession | undefined): void;
}

export const useLocalTerminalsStore = create<LocalTerminalsState>((set) => ({
  sessions: {},
  setSession: (tabId, session) => {
    set((state) => {
      const sessions = { ...state.sessions };
      if (session === undefined) delete sessions[tabId];
      else sessions[tabId] = session;
      return { sessions };
    });
  },
}));

/** Opens a new local terminal tab (`local-terminal:<uuid>`), which starts its shell when it mounts; returns its id. */
export function openLocalTerminal(): string {
  const id = `local-terminal:${crypto.randomUUID()}`;
  useEditorsStore.getState().open({ id, kind: 'local-terminal', title: 'Local' });
  return id;
}

/** The tab's name: `Local · zsh` once the shell is known. */
export function localTerminalLabel(session: LocalSession | undefined): string {
  return session?.shell === undefined ? 'Local' : `Local · ${session.shell}`;
}
