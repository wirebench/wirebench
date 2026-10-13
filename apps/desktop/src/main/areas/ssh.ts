import { channels } from '../../shared/ipc.js';
import { registerHandler } from '../ipc/register.js';
import type { HostsService } from '../hosts-service.js';
import type { SnippetsService } from '../snippets-service.js';
import type { SshImportService } from '../ssh-import.js';
import type { SshKeysService } from '../ssh-keys.js';
import type { SshSecretsService } from '../ssh-secrets.js';
import type { SshService } from '../ssh-service.js';
import { registerLayoutChannels } from './layout-channels.js';
import { registerSftpChannels } from './sftp-channels.js';

export function registerSshChannels(deps: {
  hosts: Pick<HostsService, 'list' | 'save'>;
  secrets: Pick<SshSecretsService, 'names' | 'set'>;
  ssh: Pick<
    SshService,
    'connect' | 'write' | 'resize' | 'close' | 'trust' | 'knownHosts' | 'forgetHostKey' | 'hostOs' | 'setHostOs'
  >;
  importer: Pick<SshImportService, 'preview' | 'apply'>;
  keys: Pick<SshKeysService, 'generate' | 'keys' | 'install'>;
  sftp: Parameters<typeof registerSftpChannels>[0]['sftp'];
  snippets: Pick<SnippetsService, 'list' | 'save'>;
  layouts: Parameters<typeof registerLayoutChannels>[0];
  transfers: Parameters<typeof registerSftpChannels>[0]['transfers'];
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
  registerHandler(channels.ssh.trustHostKey, async (request, sender) => {
    await deps.ssh.trust(sender, request);
    return {};
  });
  registerHandler(channels.ssh.knownHosts, async () => ({ entries: [...(await deps.ssh.knownHosts())] }));
  registerHandler(channels.ssh.forgetHostKey, async (request) => {
    await deps.ssh.forgetHostKey(request);
    return {};
  });
  registerHandler(channels.ssh.hostOs, async () => ({ entries: await deps.ssh.hostOs() }));
  registerHandler(channels.ssh.setHostOs, async (request, sender) => {
    await deps.ssh.setHostOs(sender, request);
    return {};
  });
  // A preview belongs to the window that asked for it; only that window can apply it.
  registerHandler(channels.ssh.importPreview, (request, sender) => deps.importer.preview(sender, request));
  registerHandler(channels.ssh.importApply, (request, sender) => deps.importer.apply(sender, request));
  registerHandler(channels.ssh.generateKey, (request) => deps.keys.generate(request));
  registerHandler(channels.ssh.keys, async (_request, sender) => ({ keys: await deps.keys.keys(sender) }));
  registerHandler(channels.ssh.installKey, (request, sender) => deps.keys.install(sender, request));
  registerHandler(channels.ssh.listSnippets, () => deps.snippets.list());
  registerHandler(channels.ssh.saveSnippets, (request) => deps.snippets.save(request.file));
  // The Files tab rides with the SSH area: off with it, so its local-path exception (spec R5) goes too.
  registerSftpChannels({ sftp: deps.sftp, transfers: deps.transfers });
  // Saved layouts (panes slice 3) ride with the area too.
  registerLayoutChannels(deps.layouts);
}
