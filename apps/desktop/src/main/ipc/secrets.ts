import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import { isMachineOnlyLabel, type SecretStore } from '../secrets.js';
import { registerHandler } from './register.js';

/**
 * Registers the `secrets.*` IPC channels against the shared {@link SecretStore}.
 *
 * Deliberately NO `secrets.get` handler: the renderer can create (`set`), rotate (`replace`),
 * check (`exists`) and remove (`delete`) refs, and list metadata (`list`), but can never read a
 * value back over IPC — resolution happens only in main, at import/send time
 * (`secret-resolver.ts`). `setShowSecrets` toggles the session-only (never persisted) flag that
 * `redact.ts` consults; `getShowSecrets` reads it back. Team secrets' machine-only entries (a machine's
 * private keys, a replaced value) are not secret values: `list` leaves them out, and `replace` and
 * `delete` refuse them.
 */
export function registerSecretsChannels(
  secrets: SecretStore,
  showSecrets: { get(): boolean; set(show: boolean): void },
): void {
  registerHandler(channels.secrets.set, async (request) => {
    if (isMachineOnlyLabel(request.label)) {
      throw new WirebenchError('secret-machine-only', 'That entry belongs to team secrets and cannot be changed here.');
    }
    const ref = await secrets.set(request.value, request.label !== undefined ? { label: request.label } : undefined);
    return { ref };
  });

  const refuseMachineOnly = async (ref: string): Promise<void> => {
    if (await secrets.isMachineOnly(ref)) {
      throw new WirebenchError('secret-machine-only', 'That entry belongs to team secrets and cannot be changed here.');
    }
  };

  registerHandler(channels.secrets.replace, async (request) => {
    await refuseMachineOnly(request.ref);
    const ref = await secrets.replace(request.ref, request.value);
    return { ref };
  });

  registerHandler(channels.secrets.exists, async (request) => {
    return { exists: await secrets.exists(request.ref) };
  });

  registerHandler(channels.secrets.delete, async (request) => {
    await refuseMachineOnly(request.ref);
    return { deleted: await secrets.delete(request.ref) };
  });

  registerHandler(channels.secrets.list, async () => {
    return { entries: (await secrets.list()).filter((entry) => !isMachineOnlyLabel(entry.label)) };
  });

  registerHandler(channels.secrets.setShowSecrets, (request) => {
    showSecrets.set(request.show);
    return Promise.resolve({ show: showSecrets.get() });
  });

  registerHandler(channels.secrets.getShowSecrets, () => Promise.resolve({ show: showSecrets.get() }));
}
