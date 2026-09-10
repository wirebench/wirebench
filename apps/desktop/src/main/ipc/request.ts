import { channels } from '../../shared/ipc.js';
import type { EngineService } from '../engine-service.js';
import { registerHandler } from './register.js';

/** Registers the `request.*` IPC channels against a shared `EngineService` instance. */
export function registerRequestChannels(service: EngineService): void {
  registerHandler(channels.request.generate, (request) => Promise.resolve(service.generate(request)));

  registerHandler(channels.request.send, (request) => service.send(request));

  registerHandler(channels.request.cancel, (request) => Promise.resolve(service.cancel(request.sendId)));
}
