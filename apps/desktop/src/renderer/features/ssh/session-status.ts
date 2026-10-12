/** How a host's or a tab's state is drawn: the dot's colour and its spoken label (host cards, terminal tabs). */
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
