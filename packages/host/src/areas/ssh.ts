import type { Caller } from '../host/platform.js';
import { userInfo } from 'node:os';
import { WirebenchError } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { ForwardService } from '../forward-service.js';
import { registerHandler, type HandlerTable } from '../ipc/register.js';
import type { HostsService } from '../hosts-service.js';
import type { SnippetsService } from '../snippets-service.js';
import type { KnownHostsImportService } from '../known-hosts-import.js';
import type { SshImportService } from '../ssh-import.js';
import type { SshKeysService } from '../ssh-keys.js';
import type { SshSecretsService } from '../ssh-secrets.js';
import type { SerialDeviceStore } from '../serial-devices.js';
import type { SerialPortEntry } from '../serial-session.js';
import type { SshService } from '../ssh-service.js';
import { registerLayoutChannels } from './layout-channels.js';
import { registerForwardChannels } from './forward-channels.js';
import { registerSessionLogChannels } from './session-log-channels.js';
import { registerTerminalShareChannels } from './terminal-share-channels.js';
import { registerSftpChannels } from './sftp-channels.js';

export function registerSshChannels(
  table: HandlerTable,
  deps: {
    hosts: Pick<HostsService, 'list' | 'save'>;
    secrets: Pick<SshSecretsService, 'names' | 'set' | 'delete'>;
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
    keys: Pick<
      SshKeysService,
      'generate' | 'keys' | 'install' | 'attachCertificate' | 'deviceKeyStatus' | 'defaultKeyComment'
    >;
    sftp: Parameters<typeof registerSftpChannels>[1]['sftp'];
    snippets: Pick<SnippetsService, 'list' | 'save'>;
    layouts: Parameters<typeof registerLayoutChannels>[1];
    transfers: Parameters<typeof registerSftpChannels>[1]['transfers'];
    edits: Parameters<typeof registerSftpChannels>[1]['edits'];
    forward: Parameters<typeof registerForwardChannels>[1]['forward'] & Pick<ForwardService, 'hostsChanged'>;
    sessionLogs: Parameters<typeof registerSessionLogChannels>[1];
    terminalShares: Parameters<typeof registerTerminalShareChannels>[1];
    /** Serial consoles (#426): this machine's ports, and the device it opens for each serial host. */
    serial: {
      ports: () => Promise<readonly SerialPortEntry[]>;
      devices: Pick<SerialDeviceStore, 'get' | 'set'>;
      /** The calling window's open workspace: a device is remembered per workspace and host. */
      workspaceOf: (sender: Caller) => string | undefined;
    };
  },
): void {
  registerHandler(table, channels.ssh.listHosts, () => deps.hosts.list());
  registerHandler(table, channels.ssh.saveHosts, async (request, sender) => {
    const saved = await deps.hosts.save(request.file);
    // A running forward keeps the rule it started with; the window learns which ones the save changed.
    void deps.forward.hostsChanged(sender);
    return saved;
  });
  registerHandler(table, channels.ssh.secretNames, async () => ({ names: await deps.secrets.names() }));
  registerHandler(table, channels.ssh.localUser, () => {
    // `userInfo` throws for a uid with no passwd entry (some containers): the field then starts empty.
    try {
      return Promise.resolve({ name: userInfo().username });
    } catch {
      return Promise.resolve({ name: '' });
    }
  });
  registerHandler(table, channels.ssh.setSecret, async (request) => {
    await deps.secrets.set(request.name, request.value);
    return {};
  });
  registerHandler(table, channels.ssh.deleteSecret, async (request) => {
    await deps.secrets.delete(request.name);
    return {};
  });
  // Sessions belong to the window that opened them: the sender is the owner on every call.
  registerHandler(table, channels.ssh.connect, (request, sender) => deps.ssh.connect(sender, request));
  registerHandler(table, channels.ssh.write, (request, sender) => {
    deps.ssh.write(sender, request);
    return Promise.resolve({});
  });
  registerHandler(table, channels.ssh.writeMany, (request, sender) =>
    Promise.resolve(deps.ssh.writeMany(sender, request)),
  );
  registerHandler(table, channels.ssh.resize, (request, sender) => {
    deps.ssh.resize(sender, request);
    return Promise.resolve({});
  });
  registerHandler(table, channels.ssh.close, (request, sender) => {
    deps.ssh.close(sender, request);
    return Promise.resolve({});
  });
  registerHandler(table, channels.ssh.trustHostKey, async (request, sender) => {
    await deps.ssh.trust(sender, request);
    return {};
  });
  registerHandler(table, channels.ssh.knownHosts, async () => ({ entries: [...(await deps.ssh.knownHosts())] }));
  registerHandler(table, channels.ssh.forgetHostKey, async (request) => {
    await deps.ssh.forgetHostKey(request);
    return {};
  });
  registerHandler(table, channels.ssh.hostOs, async () => ({ entries: await deps.ssh.hostOs() }));
  registerHandler(table, channels.ssh.setHostOs, async (request, sender) => {
    await deps.ssh.setHostOs(sender, request);
    return {};
  });
  const serialWorkspace = (sender: Caller): string => {
    const id = deps.serial.workspaceOf(sender);
    if (id === undefined) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    return id;
  };
  registerHandler(table, channels.ssh.serialPorts, async () => ({ ports: [...(await deps.serial.ports())] }));
  registerHandler(table, channels.ssh.serialDevice, async (request, sender) => {
    const device = await deps.serial.devices.get(serialWorkspace(sender), request.hostId);
    return device === undefined ? {} : { device };
  });
  registerHandler(table, channels.ssh.setSerialDevice, async (request, sender) => {
    await deps.serial.devices.set(serialWorkspace(sender), request.hostId, request.device);
    return {};
  });
  // A preview belongs to the window that asked for it; only that window can apply it.
  registerHandler(table, channels.ssh.importPreview, (request, sender) => deps.importer.preview(sender, request));
  registerHandler(table, channels.ssh.importApply, (request, sender) => deps.importer.apply(sender, request));
  registerHandler(table, channels.ssh.knownHostsImportPreview, (request, sender) =>
    deps.knownHostsImporter.preview(sender, request),
  );
  registerHandler(table, channels.ssh.knownHostsImportApply, (request, sender) =>
    deps.knownHostsImporter.apply(sender, request),
  );
  registerHandler(table, channels.ssh.generateKey, (request) => deps.keys.generate(request));
  registerHandler(table, channels.ssh.keys, async (_request, sender) => ({ keys: await deps.keys.keys(sender) }));
  registerHandler(table, channels.ssh.deviceKeyStatus, () => deps.keys.deviceKeyStatus());
  registerHandler(table, channels.ssh.defaultKeyComment, () =>
    Promise.resolve({ comment: deps.keys.defaultKeyComment() }),
  );
  registerHandler(table, channels.ssh.installKey, (request, sender) => deps.keys.install(sender, request));
  registerHandler(table, channels.ssh.attachCertificate, (request, sender) =>
    deps.keys.attachCertificate(sender, request),
  );
  registerHandler(table, channels.ssh.listSnippets, () => deps.snippets.list());
  registerHandler(table, channels.ssh.saveSnippets, (request) => deps.snippets.save(request.file));
  registerHandler(table, channels.ssh.runSnippet, async (request, sender) => {
    await deps.ssh.runSnippet(sender, request);
    return {};
  });
  registerHandler(table, channels.ssh.previewSnippet, (request, sender) => deps.ssh.previewSnippet(sender, request));
  // The Files tab rides with the SSH area: off with it, so its local-path exception (spec R5) goes too.
  registerSftpChannels(table, { sftp: deps.sftp, transfers: deps.transfers, edits: deps.edits });
  // Saved layouts (panes slice 3) ride with the area too.
  registerLayoutChannels(table, deps.layouts);
  // Forwards ride with the area too: off with it, no `forward.*` channel exists.
  registerForwardChannels(table, { forward: deps.forward });
  // Session logs too: off with the area, no `sessionLog.*` channel exists.
  registerSessionLogChannels(table, deps.sessionLogs);
  // Shared terminals too (#429).
  registerTerminalShareChannels(table, deps.terminalShares);
}
