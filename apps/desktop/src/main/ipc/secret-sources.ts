/**
 * Secret sources over IPC (secret sources spec D6). No reply carries a secret value (ADR-0004): `test`
 * answers with a length or an error. Writes are one entry each and validated in main (A6).
 */

import { channels } from '../../shared/ipc.js';
import type { SecretSourcesService } from '../secret-sources-service.js';
import type { WorkspaceService } from '../workspace-service.js';
import { registerHandler } from './register.js';

export function registerSecretSourcesChannels(
  workspace: Pick<
    WorkspaceService,
    'secretSourcesState' | 'setSharedSecretSources' | 'setLocalSecretSources' | 'approveSecretSources'
  >,
  sources: Pick<SecretSourcesService, 'test' | 'clear' | 'noteChange'>,
): void {
  registerHandler(channels.secretSources.get, () => Promise.resolve(workspace.secretSourcesState()));
  // The workspace methods fire `onChanged`, which notes the change too; noting it here as well keeps the
  // cache right whatever hooks are wired, and costs nothing when the key is unchanged.
  registerHandler(channels.secretSources.setShared, async (request) => {
    const result = await workspace.setSharedSecretSources(request);
    sources.noteChange();
    return result;
  });
  registerHandler(channels.secretSources.setLocal, async (request) => {
    const result = await workspace.setLocalSecretSources(request);
    sources.noteChange();
    return result;
  });
  registerHandler(channels.secretSources.approve, async (request) => {
    const state = await workspace.approveSecretSources(request.hash);
    sources.noteChange();
    return state;
  });
  registerHandler(channels.secretSources.test, (request) => sources.test(request.name));
  registerHandler(channels.secretSources.clearCache, () => {
    sources.clear();
    return Promise.resolve(undefined);
  });
}
