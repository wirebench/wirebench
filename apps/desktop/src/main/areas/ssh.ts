import { channels } from '../../shared/ipc.js';
import { registerHandler } from '../ipc/register.js';
import type { HostsService } from '../hosts-service.js';
import type { SshSecretsService } from '../ssh-secrets.js';
import type { SshService } from '../ssh-service.js';

export function registerSshChannels(deps: {
  hosts: Pick<HostsService, 'list' | 'save'>;
  secrets: Pick<SshSecretsService, 'names' | 'set'>;
  ssh: Pick<SshService, 'connect' | 'write' | 'resize' | 'close' | 'trust'>;
}): void {
  registerHandler(channels.ssh.listHosts, () => deps.hosts.list());
  registerHandler(channels.ssh.saveHosts, (request) => deps.hosts.save(request.file));
  registerHandler(channels.ssh.secretNames, async () => ({ names: await deps.secrets.names() }));
  registerHandler(channels.ssh.setSecret, async (request) => {
    await deps.secrets.set(request.name, request.value);
    return {};
  });
  // Sessions belong to the window that opened them: the sender is the owner on every call.
  registerHandler(channels.ssh.connect, (request, sender) => deps.ssh.connect(sender, request));
  registerHandler(channels.ssh.write, (request, sender) => {
    deps.ssh.write(sender, request);
    return Promise.resolve({});
  });
  registerHandler(channels.ssh.resize, (request, sender) => {
    deps.ssh.resize(sender, request);
    return Promise.resolve({});
  });
  registerHandler(channels.ssh.close, (request, sender) => {
    deps.ssh.close(sender, request);
    return Promise.resolve({});
  });
  registerHandler(channels.ssh.trustHostKey, async (request) => {
    await deps.ssh.trust(request);
    return {};
  });
}
