import type { HostSession } from './hosts-store.js';

/** How a host's session state is drawn: the dot's colour and its spoken label (tree rows, terminal tabs). */
export const SESSION_STATUS = {
  idle: { label: 'not connected', color: 'text-fg-faint' },
  connecting: { label: 'connecting', color: 'text-status-warning' },
  open: { label: 'connected', color: 'text-status-success' },
  closed: { label: 'not connected', color: 'text-fg-faint' },
} as const;

export function sessionStatus(session: HostSession | undefined): (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS] {
  return SESSION_STATUS[session?.state ?? 'idle'];
}
