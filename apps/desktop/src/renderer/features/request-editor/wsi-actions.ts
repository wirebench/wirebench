/**
 * The request-side WS-I action: run the message catalogue over the request's last exchange.
 *
 * Shared by the `request.checkWsi` command and the request pane's context menu, so the palette
 * and the menu can never drift.
 */

import { showToast } from '../../components/toast.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { useWsiStore } from '../../state/wsi.js';

/**
 * The id of the last completed send for `requestId`, or `undefined` when the request has never
 * been sent (or its send failed before an exchange existed).
 */
export function lastSendId(requestId: string): string | undefined {
  const state = useExchangesStore.getState().byRequest[requestId];
  return state?.exchange === undefined ? undefined : state.sendId;
}

/**
 * Runs the WS-I message assertions over the request's last exchange, filing the report in the
 * console's WS-I Report tab. Toasts instead when there is nothing to check.
 */
export async function checkWsiForRequest(requestId: string): Promise<void> {
  const sendId = lastSendId(requestId);
  if (sendId === undefined) {
    showToast('Send this request first — the WS-I message checks run over its last exchange.');
    return;
  }
  await useWsiStore.getState().checkExchange(sendId);
}
