import { WorkspaceError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { WorkspaceService } from '../workspace-service.js';
import { registerHandler } from './register.js';

/**
 * The `WorkspaceService` surface the `workspace.*` channels drive; a stub stands in for it in
 * tests, exactly as `request.*` and `definition.*` do.
 */
export type WorkspaceChannelService = Pick<
  WorkspaceService,
  | 'list'
  | 'create'
  | 'open'
  | 'close'
  | 'snapshot'
  | 'rename'
  | 'delete'
  | 'addProject'
  | 'removeProject'
  | 'linkProject'
  | 'importProjectFolder'
  | 'importKnownProjectFolder'
  | 'exportProject'
  | 'locateProject'
  | 'setActiveEnvironment'
  | 'mutate'
  | 'lastError'
  | 'stashDrafts'
  | 'takeRestored'
  | 'share'
  | 'shareToFolder'
  | 'join'
  | 'joinFromFolder'
  | 'stopSharing'
  | 'moveProjectToWorkspace'
>;

/** What `workspace.*` needs beyond the service itself. */
export interface WorkspaceChannelDeps {
  readonly service: WorkspaceChannelService;
  /**
   * Folders named by a pre-workspace `recent-projects.json`, offered on the picker so an
   * upgrading user's existing project folders are not silently stranded. Reading the file is
   * the caller's business, so the picker never learns a path the app did not already hold.
   */
  readonly suggestions?: () => Promise<readonly string[]>;
  /**
   * Settles once the launch-time reopen of the last workspace has finished (either way).
   * `workspace.snapshot` and `workspace.list` wait for it, so the renderer's first answer is the
   * final one: no picker flashing up before the reopened workspace replaces it, and no error
   * banner missing because the list was read before the reopen failed.
   */
  readonly ready?: () => Promise<unknown>;
  /** Shows a folder in the OS file manager (`shell.showItemInFolder` in production). */
  readonly reveal?: (dir: string) => void;
}

/**
 * Registers the `workspace.*` IPC channels.
 *
 * None of these takes a filesystem path. `linkProject`, `importProjectFolder`, `exportProject`
 * and `locateProject` run their own native dialog inside `WorkspaceService` and record the
 * pick, so the only folders the app touches outside the workspace are ones the user chose in
 * person — a renderer-supplied path would be a hole in exactly that rule.
 *
 * `workspace.changed` is raised through `WorkspaceHooks` in `main/index.ts` rather than from
 * here: it also fires outside any invocation (a project finishing its open, a save on quit).
 */
export function registerWorkspaceChannels(deps: WorkspaceChannelDeps): void {
  const { service } = deps;
  const ready = async (): Promise<void> => {
    await deps.ready?.().catch(() => undefined);
  };

  registerHandler(channels.workspace.list, async () => {
    await ready();
    const workspaces = await service.list();
    const suggestions = (await deps.suggestions?.()) ?? [];
    const lastError = service.lastError();
    return {
      workspaces,
      ...(suggestions.length > 0 ? { suggestions: [...suggestions] } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
    };
  });

  registerHandler(channels.workspace.importSuggestion, async (request) => {
    // Resolved against a fresh read of the same list the picker was shown, so the only folders
    // this can reach are ones the app itself recorded.
    const folder = ((await deps.suggestions?.()) ?? [])[request.index];
    if (folder === undefined) {
      throw new WorkspaceError('project-folder-missing', 'That project folder is no longer suggested.', {
        details: { index: request.index },
      });
    }
    return { workspace: await service.importKnownProjectFolder(folder), dir: folder };
  });

  registerHandler(channels.workspace.reveal, async (request) => {
    // Only a workspace the list knows about: the id is looked up, never turned into a path.
    const row = (await service.list()).find((candidate) => candidate.id === request.workspaceId);
    if (row === undefined) {
      throw new WorkspaceError('workspace-not-found', `No workspace "${request.workspaceId}".`, {
        details: { workspaceId: request.workspaceId },
      });
    }
    deps.reveal?.(row.dir);
    return {};
  });

  registerHandler(channels.workspace.revealProject, (request) => {
    // Same rule as `reveal`: the id is looked up in the open workspace's own snapshot, so the
    // renderer names a project, never a folder.
    const project = service.snapshot()?.projects.find((candidate) => candidate.id === request.projectId);
    if (project === undefined) {
      throw new WorkspaceError('project-not-in-workspace', `No project "${request.projectId}" in this workspace.`, {
        details: { projectId: request.projectId },
      });
    }
    deps.reveal?.(project.dir);
    return Promise.resolve({});
  });

  registerHandler(channels.workspace.create, async (request) => ({ workspace: await service.create(request.name) }));

  registerHandler(channels.workspace.open, async (request) => ({ workspace: await service.open(request.workspaceId) }));

  registerHandler(channels.workspace.close, async () => ({ workspace: await service.close() }));

  registerHandler(channels.workspace.stashDrafts, async (request) => {
    await service.stashDrafts(request.workspaceId, request.requests, request.restRequests ?? {});
    return {};
  });

  registerHandler(channels.workspace.takeRestored, async () => {
    await ready();
    return service.takeRestored();
  });

  registerHandler(channels.workspace.snapshot, async () => {
    await ready();
    return { workspace: service.snapshot() };
  });

  registerHandler(channels.workspace.rename, async (request) => ({
    workspaces: await service.rename(request.workspaceId, request.name),
  }));

  registerHandler(channels.workspace.delete, async (request) => ({
    workspaces: await service.delete(request.workspaceId),
  }));

  registerHandler(channels.workspace.addProject, async (request) => await service.addProject(request.name));

  registerHandler(channels.workspace.removeProject, async (request) => ({
    workspace: await service.removeProject(request.projectId, { deleteFiles: request.deleteFiles }),
  }));

  registerHandler(channels.workspace.linkProject, async (_request, sender) => ({
    workspace: await service.linkProject(sender),
  }));

  registerHandler(channels.workspace.importProjectFolder, async (_request, sender) => ({
    workspace: await service.importProjectFolder(sender),
  }));

  registerHandler(channels.workspace.exportProject, async (request, sender) => {
    const exported = await service.exportProject(request.projectId, sender);
    return { dir: exported?.dir ?? null };
  });

  registerHandler(channels.workspace.locateProject, async (request, sender) => ({
    workspace: await service.locateProject(request.projectId, sender),
  }));

  registerHandler(channels.workspace.setActiveEnvironment, async (request) => ({
    workspace: await service.setActiveEnvironment(request.environmentId),
  }));

  registerHandler(channels.workspace.mutate, async (request) => await service.mutate(request.change));

  registerHandler(channels.workspace.share, async (request) => ({
    workspace: await service.share({
      ...(request.remote !== undefined ? { remote: request.remote } : {}),
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
    }),
  }));

  registerHandler(channels.workspace.shareToFolder, async (_request, sender) => ({
    workspace: await service.shareToFolder(sender),
  }));

  registerHandler(channels.workspace.join, async (request) => ({
    workspace: await service.join({
      remote: request.remote,
      ...(request.branch !== undefined ? { branch: request.branch } : {}),
    }),
  }));

  registerHandler(channels.workspace.joinFromFolder, async (_request, sender) => ({
    workspace: await service.joinFromFolder(sender),
  }));

  registerHandler(channels.workspace.stopSharing, async () => ({ workspace: await service.stopSharing() }));

  registerHandler(channels.project.moveToWorkspace, async (request) => ({
    workspace: await service.moveProjectToWorkspace(request.projectId, request.workspaceId),
  }));
}
