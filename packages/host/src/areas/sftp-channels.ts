import { channels } from '@wirebench/wire/ipc';
import { registerHandler, type HandlerTable } from '../ipc/register.js';
import { localHome } from '../local-fs.js';
import type { SftpEditService } from '../sftp-edit.js';
import type { SftpService } from '../sftp-service.js';
import type { TransferQueue } from '../transfers.js';

/**
 * The Files tab's channels, registered with the SSH area only (`WIREBENCH_AREAS=ssh=off` leaves none). A
 * local place reaches this machine's paths as given (spec R5, the one exception to main's containment);
 * a remote one only the sender's own sessions.
 */
export function registerSftpChannels(
  table: HandlerTable,
  deps: {
    sftp: Pick<SftpService, 'open' | 'close' | 'list' | 'mkdir' | 'rename' | 'remove' | 'chmod'>;
    transfers: Pick<TransferQueue, 'copy' | 'resolve' | 'cancel' | 'retry'>;
    edits: Pick<SftpEditService, 'edit' | 'reply' | 'end'>;
  },
): void {
  const { sftp, transfers, edits } = deps;
  // Sessions belong to the window that opened them: the sender is the owner on every call.
  registerHandler(table, channels.sftp.open, (request, sender) => sftp.open(sender, request));
  registerHandler(table, channels.sftp.close, (request, sender) => {
    sftp.close(sender, request);
    return Promise.resolve({});
  });
  registerHandler(table, channels.sftp.list, (request, sender) => sftp.list(sender, request));
  registerHandler(table, channels.sftp.mkdir, async (request, sender) => {
    await sftp.mkdir(sender, request);
    return {};
  });
  registerHandler(table, channels.sftp.rename, async (request, sender) => {
    await sftp.rename(sender, request);
    return {};
  });
  registerHandler(table, channels.sftp.remove, async (request, sender) => {
    await sftp.remove(sender, request);
    return {};
  });
  registerHandler(table, channels.sftp.chmod, async (request, sender) => {
    await sftp.chmod(sender, request);
    return {};
  });
  registerHandler(table, channels.sftp.localHome, () => Promise.resolve(localHome()));
  // Copies are the window's own too: only it can answer, cancel or retry them.
  registerHandler(table, channels.sftp.copy, (request, sender) => transfers.copy(sender, request));
  registerHandler(table, channels.sftp.resolve, (request, sender) => {
    transfers.resolve(sender, request);
    return Promise.resolve({});
  });
  registerHandler(table, channels.sftp.cancel, (request, sender) => {
    transfers.cancel(sender, request);
    return Promise.resolve({});
  });
  registerHandler(table, channels.sftp.retry, (request, sender) => {
    transfers.retry(sender, request);
    return Promise.resolve({});
  });
  // Edits are the window's own too: only it can answer or end them.
  registerHandler(table, channels.sftp.edit, (request, sender) => edits.edit(sender, request));
  registerHandler(table, channels.sftp.editReply, async (request, sender) => {
    await edits.reply(sender, request);
    return {};
  });
  registerHandler(table, channels.sftp.endEdit, async (request, sender) => {
    await edits.end(sender, request);
    return {};
  });
}
