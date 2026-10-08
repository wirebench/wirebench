import { channels } from '../../shared/ipc.js';
import { registerHandler } from '../ipc/register.js';
import type { HostsService } from '../hosts-service.js';
import type { SshSecretsService } from '../ssh-secrets.js';
import type { SshService } from '../ssh-service.js';

export function registerSshChannels(deps: {
  hosts: Pick<HostsService, 'list' | 'save'>;
  secrets: Pick<SshSecretsService, 'names' | 'set'>;
  ssh: SshService;
}): void {
  registerHandler(channels.ssh.listHosts, () => deps.hosts.list());
  registerHandler(channels.ssh.saveHosts, (request) => deps.hosts.save(request.file));
  registerHandler(channels.ssh.secretNames, async () => ({ names: await deps.secrets.names() }));
  registerHandler(channels.ssh.setSecret, async (request) => {
    await deps.secrets.set(request.name, request.value);
    return {};
  });
}
