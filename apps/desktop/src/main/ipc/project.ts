import { readLegacySoapProject, WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { ReadPicks } from '../dialog-picks.js';
import { checkedImportSource } from '../path-access.js';
import type { ProjectRouter } from '../project-router.js';
import { registerHandler } from './register.js';

/**
 * The `WorkspaceService` surface the `project.*` channels drive. `addInterface` with a
 * `newProjectName` target needs `addProject` too, which is not part of {@link ProjectRouter}
 * (it changes the *workspace*), so it is picked in alongside it.
 */
export interface ProjectChannelDeps {
  readonly router: Pick<
    ProjectRouter,
    'projectSnapshot' | 'projectMutate' | 'save' | 'addInterface' | 'importLegacyProject' | 'reload'
  >;
  /** Creates a project inside the open workspace; used only by an `addInterface` that asks for one. */
  readonly addProject: (name: string) => Promise<{ readonly projectId: string }>;
  /**
   * Takes back a project `addInterface` created for a `newProjectName` target whose import then
   * failed, so a failed import never leaves an empty project behind.
   */
  readonly removeProject: (projectId: string, options: { deleteFiles: boolean }) => Promise<unknown>;
  /**
   * The folders of every project open in the workspace. An `addInterface { kind: 'file' }` path
   * is allowed when it is inside one of them — the same rule `definition.import` applies.
   */
  readonly projectDirs: () => readonly string[];
  /** The session's dialog memory: proof a `file` source was picked by the user, not named. */
  readonly picks: ReadPicks;
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
    // A `file` source is a read at a renderer-named path; it answers the containment/dialog-pick
    // question (`checkedImportSource`, as `definition.import` does) before any project is
    // created, so a refusal changes nothing.
    const source = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
    const options = {
      source,
      ...(request.auth !== undefined ? { auth: request.auth } : {}),
      ...(request.useForRequests !== undefined ? { useForRequests: request.useForRequests } : {}),
      ...(request.token !== undefined ? { token: request.token } : {}),
    };
    if ('projectId' in request.target) {
      const added = await router.addInterface(request.target.projectId, options);
      return { ...added, projectId: request.target.projectId };
    }
    // A `newProjectName` target creates the project first, so importing into an empty
    // workspace is one gesture rather than "make a project, then import into it". The project
    // exists only for this import: if the import fails it goes again (to the trash — it is an
    // internal project nobody has seen), and the import's own error is what the caller hears.
    const { projectId } = await deps.addProject(request.target.newProjectName);
    try {
      const added = await router.addInterface(projectId, options);
      return { ...added, projectId };
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  registerHandler(channels.project.importLegacy, async (request) => {
    // The file is read and parsed before any project is created, so a path that is refused or a
    // file that is not a legacy project changes nothing.
    const source = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
    if (source.kind !== 'file') {
      throw new WirebenchError('invalid-argument', 'Expected a file source');
    }
    const project = await readLegacySoapProject({ kind: 'file', path: source.path });
    const options = { project, ...(request.token !== undefined ? { token: request.token } : {}) };
    if ('projectId' in request.target) {
      const imported = await router.importLegacyProject(request.target.projectId, options);
      return { ...imported, projectId: request.target.projectId };
    }
    const name = request.target.newProjectName.trim() === '' ? project.name : request.target.newProjectName;
    const { projectId } = await deps.addProject(name);
    try {
      const imported = await router.importLegacyProject(projectId, options);
      return { ...imported, projectId };
    } catch (error) {
      await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
      throw error;
    }
  });

  registerHandler(channels.project.reload, async (request) => ({ project: await router.reload(request.projectId) }));
}
