/**
 * The red "Trust invalid" badge.
 *
 * Turning off certificate verification for an endpoint is a debugging shortcut that tends to
 * outlive the debugging. So it is never silent: the same badge appears on the endpoint's row in
 * the Endpoints dialog, in the request toolbar next to the endpoint being sent to, and in the
 * status bar — permanently, for as long as the flag is set, in the one colour the rest of the
 * UI reserves for errors.
 */

import { ShieldAlert } from 'lucide-react';

/** The tooltip every placement of the badge shares. */
export const TRUST_INVALID_HINT =
  'Certificate verification is off for this endpoint. Anyone on the network path can read or alter these messages.';

export interface TrustInvalidBadgeProps {
  /** `compact` drops the text and keeps the icon, for the tight status-bar and toolbar rows. */
  readonly compact?: boolean;
  readonly testId?: string;
}

/** Renders the badge. Callers render it only when the endpoint actually has `trustInvalid`. */
export function TrustInvalidBadge({ compact = false, testId = 'trust-invalid-badge' }: TrustInvalidBadgeProps) {
  return (
    <span
      data-testid={testId}
      title={TRUST_INVALID_HINT}
      aria-label={TRUST_INVALID_HINT}
      className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-status-danger px-1 text-xs font-medium text-status-danger"
    >
      <ShieldAlert size={12} aria-hidden="true" />
      {compact ? <span className="sr-only">Trust invalid certificates</span> : <span>Trust invalid</span>}
    </span>
  );
}
