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
  | 'exportProject'
  | 'locateProject'
  | 'setActiveEnvironment'
  | 'mutate'
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

  registerHandler(channels.workspace.list, async () => {
    const workspaces = await service.list();
    const suggestions = (await deps.suggestions?.()) ?? [];
    return { workspaces, ...(suggestions.length > 0 ? { suggestions: [...suggestions] } : {}) };
  });

  registerHandler(channels.workspace.create, async (request) => ({ workspace: await service.create(request.name) }));

  registerHandler(channels.workspace.open, async (request) => ({ workspace: await service.open(request.workspaceId) }));

  registerHandler(channels.workspace.close, async () => ({ workspace: await service.close() }));

  registerHandler(channels.workspace.snapshot, () => Promise.resolve({ workspace: service.snapshot() }));

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
}
