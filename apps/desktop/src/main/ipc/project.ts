import { channels } from '../../shared/ipc.js';
import type { ProjectRouter } from '../project-router.js';
import { registerHandler } from './register.js';

/**
 * The `WorkspaceService` surface the `project.*` channels drive. `addInterface` with a
 * `newProjectName` target needs `addProject` too, which is not part of {@link ProjectRouter}
 * (it changes the *workspace*), so it is picked in alongside it.
 */
export interface ProjectChannelDeps {
  readonly router: Pick<ProjectRouter, 'projectSnapshot' | 'projectMutate' | 'save' | 'addInterface' | 'reload'>;
  /** Creates a project inside the open workspace; used only by an `addInterface` that asks for one. */
  readonly addProject: (name: string) => Promise<{ readonly projectId: string }>;
}

/**
 * Registers the `project.*` IPC channels, routing each call to the host of the project it
 * names. Every request carries a `projectId` because a workspace has no single "open project".
 *
 * Only the request/response half lives here: `project.changed`, `project.changedOnDisk` and
 * `project.hydration` are raised through `WorkspaceHooks` wired up in `main/index.ts`, because
 * those fire outside any single invocation (autosave, the folder watcher, background
 * hydration) and so have no `sender` to reply to.
 */
export function registerProjectChannels(deps: ProjectChannelDeps): void {
  const { router } = deps;

  registerHandler(channels.project.snapshot, (request) =>
    Promise.resolve({ project: router.projectSnapshot(request.projectId) }),
  );

  registerHandler(channels.project.mutate, (request) => router.projectMutate(request.projectId, request.change));

  registerHandler(channels.project.save, (request) => router.save(request.projectId, { reason: 'manual' }));

  registerHandler(channels.project.addInterface, async (request) => {
    // A `newProjectName` target creates the project first, so importing into an empty
    // workspace is one gesture rather than "make a project, then import into it".
    const projectId =
      'projectId' in request.target ? request.target.projectId : (await deps.addProject(request.target.newProjectName)).projectId;
    const added = await router.addInterface(projectId, {
      source: request.source,
      ...(request.auth !== undefined ? { auth: request.auth } : {}),
      ...(request.useForRequests !== undefined ? { useForRequests: request.useForRequests } : {}),
      ...(request.token !== undefined ? { token: request.token } : {}),
    });
    return { ...added, projectId };
  });

  registerHandler(channels.project.reload, async (request) => ({ project: await router.reload(request.projectId) }));
}
