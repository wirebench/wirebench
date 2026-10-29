/**
 * The protected-environment question a browser tab asks (#345, hosted edition spec §18.4). The desktop asks in
 * its own process, with a native dialog. The server host has no dialogs and the agent no one to ask, so they
 * answer `needs-confirmation` (details `environment`), and the tab asks here and sends again confirmed. One
 * question at a time: a second one answers the first "no".
 */
import { create } from 'zustand';
import type { IpcError, IpcResult } from '@shared/ipc.js';

interface ProtectedSendState {
  /** The protected environment being asked about; absent when nothing is asked. */
  readonly environment: string | undefined;
}

export const useProtectedSendStore = create<ProtectedSendState>(() => ({ environment: undefined }));

let pending: ((send: boolean) => void) | undefined;

/** Asks whether to send under the protected environment `environment`; resolves `true` to send. */
export function askProtectedSend(environment: string): Promise<boolean> {
  pending?.(false);
  return new Promise<boolean>((resolve) => {
    pending = resolve;
    useProtectedSendStore.setState({ environment });
  });
}

/** The person's answer: send, or not. */
export function answerProtectedSend(send: boolean): void {
  const resolve = pending;
  pending = undefined;
  useProtectedSendStore.setState({ environment: undefined });
  resolve?.(send);
}

/** The answer of a send the person declined: as the host's own `send-declined`. */
function declined(name: string): IpcError {
  return {
    code: 'send-declined',
    message: `Not sent: "${name}" is protected and the send was not confirmed`,
    details: { environments: [name] },
  };
}

/**
 * Runs `call` once; when the host answers `needs-confirmation`, asks the person and, on "send", runs it once
 * more confirmed. A "no" answers `send-declined`, and nothing more is sent. The desktop never answers
 * `needs-confirmation`, so there it is `call(false)`.
 */
export async function withProtectedConfirmation<T>(
  call: (confirmed: boolean) => Promise<IpcResult<T>>,
): Promise<IpcResult<T>> {
  const first = await call(false);
  if (first.ok || first.error.code !== 'needs-confirmation') return first;
  const environment = (first.error.details as { environment?: unknown } | undefined)?.environment;
  const name = typeof environment === 'string' && environment.length > 0 ? environment : 'This environment';
  if (!(await askProtectedSend(name))) return { ok: false, error: declined(name) };
  return await call(true);
}
