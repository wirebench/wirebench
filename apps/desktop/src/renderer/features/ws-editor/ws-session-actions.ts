/**
 * What the WebSocket commands and the editor both do, in one place so the palette, the shortcut
 * and the buttons cannot drift apart: which saved message is selected in each tab, connecting or
 * sending it, and sending one message with its failure answered rather than only stored.
 */
import { create } from 'zustand';
import { showToast } from '../../components/toast.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore, wsDraftPatch } from '../../state/project.js';
import type { WsComposedMessage } from './composer.js';

interface WsSelectionState {
  /** The saved message selected in each WebSocket request's Messages tab, by request id. */
  readonly selected: Readonly<Record<string, string>>;
  readonly select: (requestId: string, messageId: string | undefined) => void;
}

/** Which saved message each tab has selected; read by `ws.sendMessage` and the `Mod+Enter` chord. */
export const useWsSelectionStore = create<WsSelectionState>()((set) => ({
  selected: {},
  select: (requestId, messageId) => {
    set((state) => {
      const next = { ...state.selected };
      if (messageId === undefined) {
        delete next[requestId];
      } else {
        next[requestId] = messageId;
      }
      return { selected: next };
    });
  },
}));

/** Sends one message on the request's open session; answers the error, or `undefined` when it went. */
export async function sendWsComposed(requestId: string, message: WsComposedMessage): Promise<string | undefined> {
  const before = useExchangesStore.getState().wsByRequest[requestId]?.error;
  await useExchangesStore.getState().sendWsMessage(requestId, message);
  const after = useExchangesStore.getState().wsByRequest[requestId]?.error;
  return after !== undefined && after !== before ? `${after.code}: ${after.message}` : undefined;
}

/** Sends the selected saved message (the first when none is selected) on the open session. */
export async function sendSelectedWsMessage(requestId: string): Promise<string | undefined> {
  const request = useProjectStore.getState().wsRequests[requestId];
  if (request === undefined || request.messages.length === 0) {
    return undefined;
  }
  const selectedId = useWsSelectionStore.getState().selected[requestId];
  const message = request.messages.find((candidate) => candidate.id === selectedId) ?? request.messages[0]!;
  return sendWsComposed(requestId, {
    format: message.format,
    content: message.content,
    expand: message.format === 'text',
  });
}

/**
 * {@link sendSelectedWsMessage} for the shortcut, the palette and a per-message Send: none of
 * them has an inline place to show a failure, so it goes to the app's toast.
 */
export async function sendSelectedWsMessageReporting(requestId: string): Promise<void> {
  const failure = await sendSelectedWsMessage(requestId);
  if (failure !== undefined) showToast(failure);
}

/** {@link sendWsComposed}, its failure shown as a toast — for a Send with no inline error line. */
export async function sendWsReporting(requestId: string, message: WsComposedMessage): Promise<void> {
  const failure = await sendWsComposed(requestId, message);
  if (failure !== undefined) showToast(failure);
}

/** `Mod+Enter` outside the composer: connect a closed session, send the selected message on an open one. */
export function connectOrSendWs(requestId: string): void {
  const status = useExchangesStore.getState().wsByRequest[requestId]?.status;
  if (status === 'open') {
    void sendSelectedWsMessageReporting(requestId);
    return;
  }
  if (status === 'connecting' || status === 'closing') {
    return;
  }
  void useExchangesStore.getState().connectWs(requestId);
}

/** Copies the command-line equivalent of the request, its unsaved edits included, to the clipboard. */
export async function copyWsCommand(requestId: string, shell: 'posix' | 'powershell'): Promise<void> {
  const wsDraft = wsDraftPatch(requestId);
  const result = await ipc().request.curl({ requestId, shell, ...(wsDraft !== undefined ? { wsDraft } : {}) });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  try {
    await navigator.clipboard.writeText(result.value.command);
    showToast('Copied as command');
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : 'Could not copy to the clipboard');
  }
}
