import { channels, events } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import { emitEvent } from './events.js';
import { registerHandler } from './register.js';

/** Registers the `definition.*` IPC channels against a shared `EngineService` instance. */
export function registerDefinitionChannels(service: EngineService): void {
  registerHandler(channels.definition.import, (request, sender) =>
    service.importDefinition(request, {
      onProgress: (progress) => {
        emitEvent(sender, events.engine.progress, progress);
      },
    }),
  );

  registerHandler(channels.definition.close, (request) => Promise.resolve(service.close(request.interfaceId)));

  registerHandler(channels.definition.cancelImport, (request) => Promise.resolve(service.cancelImport(request.token)));
}
