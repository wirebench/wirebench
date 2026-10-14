/**
 * Whether **New request from tool…** is open, and on which MCP server (#79). Apart from the dialog
 * so the explorer's actions can open it without loading the list.
 */
import { create } from 'zustand';

interface McpToolPickerState {
  /** The server whose catalogued tools are offered, while the picker is open. */
  readonly apiId: string | undefined;
  readonly open: (apiId: string) => void;
  readonly close: () => void;
}

export const useMcpToolPicker = create<McpToolPickerState>((set) => ({
  apiId: undefined,
  open: (apiId) => {
    set({ apiId });
  },
  close: () => {
    set({ apiId: undefined });
  },
}));
