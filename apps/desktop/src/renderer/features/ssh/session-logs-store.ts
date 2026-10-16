/** Whether the Session Logs dialog is open: apart from the dialog, which loads only once it opens. */
import { create } from 'zustand';

interface SessionLogsDialogState {
  open: boolean;
}

export const useSessionLogsDialogStore = create<SessionLogsDialogState>()(() => ({ open: false }));

/** Opens the list of every host's session logs (the `ssh.sessionLogs` command). */
export function showSessionLogs(): void {
  useSessionLogsDialogStore.setState({ open: true });
}

export function hideSessionLogs(): void {
  useSessionLogsDialogStore.setState({ open: false });
}
