import { channels } from '@wirebench/wire/ipc';
import { registerHandler, type HandlerTable } from '../ipc/register.js';
import type { LocalTerminalService } from '../local-terminal-service.js';

/**
 * The local terminal tab's channels (#410), registered with the SSH area only, and only while
 * `WIREBENCH_AREAS` leaves `local-terminal` on. A shell belongs to the window that opened it: the sender is
 * the owner on every call.
 */
export function registerLocalTerminalChannels(
  table: HandlerTable,
  local: Pick<LocalTerminalService, 'open' | 'write' | 'resize' | 'close'>,
): void {
  registerHandler(table, channels.localTerminal.open, (request, sender) => local.open(sender, request));
  registerHandler(table, channels.localTerminal.write, (request, sender) => {
    local.write(sender, request);
    return Promise.resolve({});
  });
  registerHandler(table, channels.localTerminal.resize, (request, sender) => {
    local.resize(sender, request);
    return Promise.resolve({});
  });
  registerHandler(table, channels.localTerminal.close, (request, sender) => {
    local.close(sender, request);
    return Promise.resolve({});
  });
}
