import { channels } from '../../shared/ipc.js';
import { registerHandler } from '../ipc/register.js';
import type { HostsService } from '../hosts-service.js';
import type { SshService } from '../ssh-service.js';

export function registerSshChannels(deps: { hosts: Pick<HostsService, 'list' | 'save'>; ssh: SshService }): void {
  registerHandler(channels.ssh.listHosts, () => deps.hosts.list());
  registerHandler(channels.ssh.saveHosts, (request) => deps.hosts.save(request.file));
}
