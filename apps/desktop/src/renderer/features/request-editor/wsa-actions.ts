/**
 * The two WS-Addressing *editor* actions: baking the request's effective `wsa:*` headers into
 * the envelope text, and stripping them again.
 *
 * Deliberately distinct from the request's saved WS-A configuration, which is applied on the
 * way to the wire and never touches the stored envelope. The two exist side by side and are
 * not interchangeable. A MessageID baked in here is fixed in the project file from then on; the
 * send path is what mints a fresh one per send.
 */

import { showToast } from '../../components/toast.js';
import { getActiveRequestPaneHandle } from '../../editor/active-request-editor.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';

/** The envelope as it stands on screen: any debounced edit is committed first. */
function currentEnvelope(requestId: string): string | undefined {
  getActiveRequestPaneHandle()?.flush();
  return useProjectStore.getState().requests[requestId]?.envelopeXml;
}

/** Writes the request's effective WS-Addressing headers into the editor text. */
export async function addWsaHeadersToEditor(requestId: string): Promise<void> {
  const envelopeXml = currentEnvelope(requestId);
  if (envelopeXml === undefined) {
    return;
  }
  const result = await ipc().wsa.insertHeaders({ requestId, envelopeXml });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  useProjectStore.getState().editRequest(requestId, { envelopeXml: result.value.envelopeXml });
  showToast('Added WS-A headers');
}

/** Strips every `wsa:*` header, of either version, from the editor text. */
export async function removeWsaHeadersFromEditor(requestId: string): Promise<void> {
  const envelopeXml = currentEnvelope(requestId);
  if (envelopeXml === undefined) {
    return;
  }
  const result = await ipc().wsa.removeHeaders({ requestId, envelopeXml });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  useProjectStore.getState().editRequest(requestId, { envelopeXml: result.value.envelopeXml });
  showToast('Removed WS-A headers');
}
