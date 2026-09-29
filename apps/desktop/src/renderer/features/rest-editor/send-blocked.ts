/**
 * Why a REST tab's Send is disabled right now, per request id — today only a webhook item whose
 * target is missing. The editor computes it from its preflight and records it here, so the
 * `rest.send` shortcut (registered outside React) refuses the same send the disabled button does.
 */
const blocked = new Map<string, string>();

/** Records (or, with `undefined`, clears) the reason `requestId`'s Send is disabled. */
export function setRestSendBlocked(requestId: string, reason: string | undefined): void {
  if (reason === undefined) {
    blocked.delete(requestId);
  } else {
    blocked.set(requestId, reason);
  }
}

/** The reason `requestId`'s Send is disabled, or `undefined` when it may send. */
export function restSendBlocked(requestId: string): string | undefined {
  return blocked.get(requestId);
}
