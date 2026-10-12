import { channels } from '../../shared/ipc.js';
import { registerHandler } from '../ipc/register.js';
import { localHome } from '../local-fs.js';
import type { SftpService } from '../sftp-service.js';

/**
 * The Files tab's channels, registered with the SSH area only (`WIREBENCH_AREAS=ssh=off` leaves none). A
 * local place reaches this machine's paths as given (spec R5, the one exception to main's containment);
 * a remote one only the sender's own sessions.
 */
export function registerSftpChannels(deps: {
  sftp: Pick<SftpService, 'open' | 'close' | 'list' | 'mkdir' | 'rename' | 'remove' | 'chmod'>;
}): void {
  const { sftp } = deps;
  // Sessions belong to the window that opened them: the sender is the owner on every call.
  registerHandler(channels.sftp.open, (request, sender) => sftp.open(sender, request));
  registerHandler(channels.sftp.close, (request, sender) => {
    sftp.close(sender, request);
    return Promise.resolve({});
  });
  registerHandler(channels.sftp.list, (request, sender) => sftp.list(sender, request));
  registerHandler(channels.sftp.mkdir, async (request, sender) => {
    await sftp.mkdir(sender, request);
    return {};
  });
  registerHandler(channels.sftp.rename, async (request, sender) => {
    await sftp.rename(sender, request);
    return {};
  });
  registerHandler(channels.sftp.remove, async (request, sender) => {
    await sftp.remove(sender, request);
    return {};
  });
  registerHandler(channels.sftp.chmod, async (request, sender) => {
    await sftp.chmod(sender, request);
    return {};
  });
  registerHandler(channels.sftp.localHome, () => Promise.resolve(localHome()));
}
