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

interface TeamSessionLogsDialogState {
  open: boolean;
  /** The host the dialog opened on, as its first filter; any host when unset. */
  hostId: string | undefined;
}

export const useTeamSessionLogsDialogStore = create<TeamSessionLogsDialogState>()(() => ({
  open: false,
  hostId: undefined,
}));

/** Opens the workspace server's session logs, every member's (#430; the `ssh.teamSessionLogs` command). */
export function showTeamSessionLogs(hostId?: string): void {
  useTeamSessionLogsDialogStore.setState({ open: true, hostId });
}

export function hideTeamSessionLogs(): void {
  useTeamSessionLogsDialogStore.setState({ open: false, hostId: undefined });
}
