/**
 * Whether **New MCP server…** is open, and for which project (#79). Apart from the dialog so the
 * explorer's actions can open it without loading the form.
 */
import { create } from 'zustand';

interface NewMcpServerDialogState {
  /** The project the server is made in, while the dialog is open. */
  readonly projectId: string | undefined;
  /** The name the form starts with: the next free `MCP server N`. */
  readonly suggestedName: string;
  readonly open: (projectId: string, suggestedName: string) => void;
  readonly close: () => void;
}

export const useNewMcpServerDialog = create<NewMcpServerDialogState>((set) => ({
  projectId: undefined,
  suggestedName: '',
  open: (projectId, suggestedName) => {
    set({ projectId, suggestedName });
  },
  close: () => {
    set({ projectId: undefined });
  },
}));
