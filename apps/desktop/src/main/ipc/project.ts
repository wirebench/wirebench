import { channels } from '../../shared/ipc.js';
import type { ProjectHost } from '../project-host.js';
import { registerHandler } from './register.js';

/**
 * Registers the `project.*` IPC channels against the shared {@link ProjectHost}.
 *
 * Only the request/response half lives here: the service raises `project.changed`,
 * `project.changedOnDisk` and `project.hydration` through hooks wired up in `main/index.ts`,
 * because those fire outside any single invocation (autosave, the folder watcher, background
 * hydration) and so have no `sender` to reply to.
 */
export function registerProjectChannels(service: ProjectHost): void {
  registerHandler(channels.project.create, async (request) => ({
    project: await service.create({ dir: request.dir, name: request.name }),
  }));

  registerHandler(channels.project.open, async (request) => ({ project: await service.openProject(request.dir) }));

  registerHandler(channels.project.close, async () => ({ project: await service.close() }));

  registerHandler(channels.project.snapshot, () => Promise.resolve({ project: service.snapshot() }));

  registerHandler(channels.project.mutate, (request) => service.mutate(request.change));

  registerHandler(channels.project.save, () => service.save({ reason: 'manual' }));

  registerHandler(channels.project.recent, async () => ({ recent: await service.recentProjects() }));

  registerHandler(channels.project.addInterface, (request) =>
    service.addInterface({
      source: request.source,
      ...(request.auth !== undefined ? { auth: request.auth } : {}),
      ...(request.useForRequests !== undefined ? { useForRequests: request.useForRequests } : {}),
      ...(request.token !== undefined ? { token: request.token } : {}),
    }),
  );

  registerHandler(channels.project.reload, async () => ({ project: await service.reload() }));
}
