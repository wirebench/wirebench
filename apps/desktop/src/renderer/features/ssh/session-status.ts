import type { PaneState } from './files/files-store.js';

/** How a host's or a tab's state is drawn: the dot's colour and its spoken label (host cards, terminal and Files tabs). */
export const SESSION_STATUS = {
  idle: { label: 'not connected', color: 'text-fg-faint' },
  connecting: { label: 'connecting', color: 'text-status-warning' },
  open: { label: 'connected', color: 'text-status-success' },
  closed: { label: 'not connected', color: 'text-fg-faint' },
} as const;

export function sessionStatus(
  state: keyof typeof SESSION_STATUS | undefined,
): (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS] {
  return SESSION_STATUS[state ?? 'idle'];
}

/** A Files tab's dot: connected while its SFTP session is open. */
export function filesSessionStatus(
  pane: Pick<PaneState, 'place' | 'status'> | undefined,
): (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS] {
  if (pane?.place.sessionId !== undefined) return SESSION_STATUS.open;
  return pane?.status === 'connecting' || pane?.status === 'loading' ? SESSION_STATUS.connecting : SESSION_STATUS.idle;
}
