import { channels } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import type { ProjectService } from '../project-service.js';
import { registerHandler } from './register.js';

/** What `request.*` needs beyond the engine: the property scopes a send expands against. */
export interface RequestChannelDeps {
  /** Supplies the scopes; `ProjectService.scopesFor` in the app, a stub in tests. */
  readonly project: Pick<ProjectService, 'scopesFor' | 'preflight'>;
}

/**
 * Registers the `request.*` IPC channels against a shared `EngineService` instance.
 *
 * Every send expands properties: the scopes come from the project service, which folds the
 * open project's properties, the active environment's, the user's globals and `process.env`
 * into one chain. `request.preflight` runs the same expansion as a dry run so the UI can list
 * unresolved references before anything leaves the machine.
 */
export function registerRequestChannels(service: EngineService, deps: RequestChannelDeps): void {
  registerHandler(channels.request.generate, (request) => Promise.resolve(service.generate(request)));

  registerHandler(channels.request.send, (request) => service.send(request, { scopes: deps.project.scopesFor() }));

  registerHandler(channels.request.cancel, (request) => Promise.resolve(service.cancel(request.sendId)));

  registerHandler(channels.request.preflight, (request) => Promise.resolve(deps.project.preflight(request.requestId)));
}
