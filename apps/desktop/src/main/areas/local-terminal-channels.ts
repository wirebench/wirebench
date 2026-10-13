import { channels } from '../../shared/ipc.js';
import { registerHandler } from '../ipc/register.js';
import type { LocalTerminalService } from '../local-terminal-service.js';

/**
 * The local terminal tab's channels (#410), registered with the SSH area only, and only while
 * `WIREBENCH_AREAS` leaves `local-terminal` on. A shell belongs to the window that opened it: the sender is
 * the owner on every call.
 */
export function registerLocalTerminalChannels(
  local: Pick<LocalTerminalService, 'open' | 'write' | 'resize' | 'close'>,
): void {
  registerHandler(channels.localTerminal.open, (request, sender) => local.open(sender, request));
  registerHandler(channels.localTerminal.write, (request, sender) => {
    local.write(sender, request);
    return Promise.resolve({});
  });
  registerHandler(channels.localTerminal.resize, (request, sender) => {
    local.resize(sender, request);
    return Promise.resolve({});
  });
  registerHandler(channels.localTerminal.close, (request, sender) => {
    local.close(sender, request);
    return Promise.resolve({});
  });
}
