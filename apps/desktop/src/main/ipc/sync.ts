/**
 * The `sync.*` IPC channels: everything the status-bar badge, the Sync panel (Task 10) and the
 * conflict resolver (Task 11) need to drive the open workspace's `SyncService`.
 *
 * Every handler but `sync.status` routes to `WorkspaceService.sync()` or throws
 * `sync-not-supported` for a local (unshared) workspace — `sync.status` answers with a
 * synthetic `kind: 'local'` status instead (`WorkspaceService.syncStatus()`), so the badge never
 * needs a special case. `sync.revealTree`'s `path`, when present, is tree-relative and produced
 * by main itself (a conflict entry, echoed back by the renderer) — never a filesystem path the
 * renderer made up. It is joined against the tree root and containment-checked here before
 * `shell.showItemInFolder` ever sees it: a channel carrying an absolute or escaping path is a
 * defect, not a user error.
 */

import { join } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { SyncStatusWire } from '../../shared/wire-types.js';
import { isInsideReal, realpathOfPrefix } from '../path-containment.js';
import type { SyncService } from '../sync/sync-service.js';
import type { WorkspaceService } from '../workspace-service.js';
import { registerHandler } from './register.js';

/** The `WorkspaceService` surface the `sync.*` channels drive. */
export type SyncChannelService = Pick<WorkspaceService, 'sync' | 'syncStatus' | 'treeDir' | 'updateSyncSettings'>;

/** What `sync.*` needs beyond the service itself. */
export interface SyncChannelDeps {
  readonly service: SyncChannelService;
  /** Shows a folder (or file) in the OS file manager (`shell.showItemInFolder` in production). */
  readonly reveal?: (path: string) => void;
}

/** The running `SyncService`, or a `sync-not-supported` refusal for a local workspace. */
function requireSync(service: SyncChannelService): SyncService {
  const sync = service.sync();
  if (sync === undefined) {
    throw new WirebenchError('sync-not-supported', 'This workspace is not shared.');
  }
  return sync;
}

/** Registers the `sync.*` IPC channels. */
export function registerSyncChannels(deps: SyncChannelDeps): void {
  const { service } = deps;

  registerHandler(channels.sync.status, (): Promise<SyncStatusWire> => Promise.resolve(service.syncStatus()));

  registerHandler(channels.sync.fetch, async () => await requireSync(service).fetch());

  registerHandler(channels.sync.pull, async () => await requireSync(service).pull());

  registerHandler(channels.sync.push, async () => await requireSync(service).push());

  registerHandler(channels.sync.commit, async (request) => await requireSync(service).commit(request.message));

  registerHandler(channels.sync.conflicts, async () => ({ conflicts: await requireSync(service).conflicts() }));

  registerHandler(
    channels.sync.resolve,
    async (request) => await requireSync(service).resolve(request.path, request.side),
  );

  registerHandler(channels.sync.abortMerge, async () => await requireSync(service).abortMerge());

  registerHandler(channels.sync.log, async (request) => ({ entries: await requireSync(service).log(request.limit) }));

  registerHandler(channels.sync.updateSettings, async (request) => await service.updateSyncSettings(request));

  registerHandler(channels.sync.setIdentity, async (request) => {
    await requireSync(service).setIdentity(request.name, request.email);
    return {};
  });

  registerHandler(channels.sync.revealTree, async (request) => {
    const tree = service.treeDir();
    const target = request.path === undefined || request.path.length === 0 ? tree : join(tree, request.path);
    const [treeReal, targetReal] = await Promise.all([realpathOfPrefix(tree), realpathOfPrefix(target)]);
    if (!isInsideReal(treeReal, targetReal)) {
      throw new WirebenchError('workspace-path-invalid', 'That path is outside the shared workspace.', {
        details: { path: request.path },
      });
    }
    deps.reveal?.(target);
    return {};
  });
}
