/**
 * The protected-environment question a browser tab asks before an agent send (#345, hosted edition spec
 * §18.4). The desktop and the server host ask in their own process; an agent send is asked here, in the tab,
 * because the agent has no one to ask. One question at a time: a second one answers the first "no".
 */
import { create } from 'zustand';

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
