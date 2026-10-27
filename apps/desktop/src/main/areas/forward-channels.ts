import { channels } from '../../shared/ipc.js';
import type { ForwardService } from '../forward-service.js';
import { registerHandler, type HandlerTable } from '../ipc/register.js';

/**
 * Port forwarding's channels, registered with the SSH area only (`WIREBENCH_AREAS=ssh=off` leaves none).
 * Forwards belong to the window that started them: the sender is the owner on every call.
 */
export function registerForwardChannels(
  table: HandlerTable,
  deps: {
    forward: Pick<ForwardService, 'list' | 'start' | 'stop' | 'stopAll' | 'freePort'>;
  },
): void {
  const { forward } = deps;
  registerHandler(table, channels.forward.list, (_request, sender) =>
    Promise.resolve({ forwards: forward.list(sender) }),
  );
  registerHandler(table, channels.forward.start, async (request, sender) => {
    await forward.start(sender, request);
    return {};
  });
  registerHandler(table, channels.forward.stop, async (request, sender) => {
    await forward.stop(sender, request.hostId, request.ruleId);
    return {};
  });
  registerHandler(table, channels.forward.stopAll, async (_request, sender) => {
    await forward.stopAll(sender);
    return {};
  });
  registerHandler(table, channels.forward.freePort, async (request) => ({
    port: await forward.freePort(request.near),
  }));
}
