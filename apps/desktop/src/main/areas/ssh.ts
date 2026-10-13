import { channels } from '../../shared/ipc.js';
import type { ForwardService } from '../forward-service.js';
import { registerHandler } from '../ipc/register.js';
import type { HostsService } from '../hosts-service.js';
import type { SnippetsService } from '../snippets-service.js';
import type { KnownHostsImportService } from '../known-hosts-import.js';
import type { SshImportService } from '../ssh-import.js';
import type { SshKeysService } from '../ssh-keys.js';
import type { SshSecretsService } from '../ssh-secrets.js';
import type { SshService } from '../ssh-service.js';
import { registerLayoutChannels } from './layout-channels.js';
import { registerForwardChannels } from './forward-channels.js';
import { registerSessionLogChannels } from './session-log-channels.js';
import { registerSftpChannels } from './sftp-channels.js';

export function registerSshChannels(deps: {
  hosts: Pick<HostsService, 'list' | 'save'>;
  secrets: Pick<SshSecretsService, 'names' | 'set'>;
  ssh: Pick<
    SshService,
    | 'connect'
    | 'write'
    | 'writeMany'
    | 'resize'
    | 'close'
    | 'trust'
    | 'knownHosts'
    | 'forgetHostKey'
    | 'hostOs'
    | 'setHostOs'
    | 'runSnippet'
    | 'previewSnippet'
  >;
  importer: Pick<SshImportService, 'preview' | 'apply'>;
  knownHostsImporter: Pick<KnownHostsImportService, 'preview' | 'apply'>;
  keys: Pick<SshKeysService, 'generate' | 'keys' | 'install' | 'attachCertificate'>;
  sftp: Parameters<typeof registerSftpChannels>[0]['sftp'];
  snippets: Pick<SnippetsService, 'list' | 'save'>;
  layouts: Parameters<typeof registerLayoutChannels>[0];
  transfers: Parameters<typeof registerSftpChannels>[0]['transfers'];
  edits: Parameters<typeof registerSftpChannels>[0]['edits'];
  forward: Parameters<typeof registerForwardChannels>[0]['forward'] & Pick<ForwardService, 'hostsChanged'>;
  sessionLogs: Parameters<typeof registerSessionLogChannels>[0];
}): void {
  registerHandler(channels.ssh.listHosts, () => deps.hosts.list());
  registerHandler(channels.ssh.saveHosts, async (request, sender) => {
    const saved = await deps.hosts.save(request.file);
    // A running forward keeps the rule it started with; the window learns which ones the save changed.
    void deps.forward.hostsChanged(sender);
    return saved;
  });
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
  registerHandler(channels.ssh.writeMany, (request, sender) => Promise.resolve(deps.ssh.writeMany(sender, request)));
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
  registerHandler(channels.ssh.knownHostsImportPreview, (request, sender) =>
    deps.knownHostsImporter.preview(sender, request),
  );
  registerHandler(channels.ssh.knownHostsImportApply, (request, sender) =>
    deps.knownHostsImporter.apply(sender, request),
  );
  registerHandler(channels.ssh.generateKey, (request) => deps.keys.generate(request));
  registerHandler(channels.ssh.keys, async (_request, sender) => ({ keys: await deps.keys.keys(sender) }));
  registerHandler(channels.ssh.installKey, (request, sender) => deps.keys.install(sender, request));
  registerHandler(channels.ssh.attachCertificate, (request, sender) => deps.keys.attachCertificate(sender, request));
  registerHandler(channels.ssh.listSnippets, () => deps.snippets.list());
  registerHandler(channels.ssh.saveSnippets, (request) => deps.snippets.save(request.file));
  registerHandler(channels.ssh.runSnippet, async (request, sender) => {
    await deps.ssh.runSnippet(sender, request);
    return {};
  });
  registerHandler(channels.ssh.previewSnippet, (request, sender) => deps.ssh.previewSnippet(sender, request));
  // The Files tab rides with the SSH area: off with it, so its local-path exception (spec R5) goes too.
  registerSftpChannels({ sftp: deps.sftp, transfers: deps.transfers, edits: deps.edits });
  // Saved layouts (panes slice 3) ride with the area too.
  registerLayoutChannels(deps.layouts);
  // Forwards ride with the area too: off with it, no `forward.*` channel exists.
  registerForwardChannels({ forward: deps.forward });
  // Session logs too: off with the area, no `sessionLog.*` channel exists.
  registerSessionLogChannels(deps.sessionLogs);
}
