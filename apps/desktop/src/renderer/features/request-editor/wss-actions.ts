/**
 * The four WS-Security *editor* actions: adding a username token or a timestamp to the envelope
 * text, applying the request's outgoing configuration to it, and stripping the header again.
 *
 * These are deliberately distinct from `wssOutgoingRef`, which applies a configuration at send
 * time and never touches the saved envelope — SoapUI has both, and they are not interchangeable.
 * Main builds every one of these headers and masks any `wsse:Password` on the way back, so what
 * lands in the editor (and therefore in the project file) never carries a plaintext secret; the
 * real password is only ever substituted on the wire.
 */

import { showToast } from '../../components/toast.js';
import { getActiveRequestPaneHandle } from '../../editor/active-request-editor.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { WssEntryWire } from '../../../shared/wire-types.js';

/** The envelope as it stands on screen: any debounced edit is committed first. */
function currentEnvelope(requestId: string): string | undefined {
  getActiveRequestPaneHandle()?.flush();
  return useProjectStore.getState().requests[requestId]?.envelopeXml;
}

/** Writes `envelopeXml` back into the editor and the project. */
function replaceEnvelope(requestId: string, envelopeXml: string): void {
  useProjectStore.getState().updateRequest(requestId, { envelopeXml });
}

/** Inserts one ad-hoc entry into the envelope text. */
export async function insertWssEntry(requestId: string, entry: WssEntryWire, passwordRef?: string): Promise<void> {
  const envelopeXml = currentEnvelope(requestId);
  if (envelopeXml === undefined) {
    return;
  }
  const result = await ipc().wss.insertEntry({
    requestId,
    envelopeXml,
    entry,
    ...(passwordRef !== undefined ? { passwordRef } : {}),
  });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  replaceEnvelope(requestId, result.value.envelopeXml);
  showToast(entry.kind === 'timestamp' ? 'Added WS-Timestamp' : 'Added WSS Username Token');
}

/** Runs the request's selected outgoing configuration once, writing the result into the editor. */
export async function applyOutgoingWssToEditor(requestId: string): Promise<void> {
  const envelopeXml = currentEnvelope(requestId);
  if (envelopeXml === undefined) {
    return;
  }
  const result = await ipc().wss.previewOutgoing({ requestId, envelopeXml });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  replaceEnvelope(requestId, result.value.envelopeXml);
  showToast('Applied outgoing WS-Security');
}

/** Strips the `wsse:Security` header the request's configuration writes. */
export async function removeOutgoingWssFromEditor(requestId: string): Promise<void> {
  const envelopeXml = currentEnvelope(requestId);
  if (envelopeXml === undefined) {
    return;
  }
  const result = await ipc().wss.removeOutgoing({ requestId, envelopeXml });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  replaceEnvelope(requestId, result.value.envelopeXml);
  showToast('Removed outgoing WS-Security');
}
