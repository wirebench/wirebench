/**
 * Which host channels a browser socket may call (hosted edition spec §3.10, §17.3): the served-channel
 * table as channel-name groups (the part before the first `.`), with the channels of a served group
 * that are still refused listed one by one, each with its reason. A channel in neither list is refused,
 * so a channel added to the registry is never served by accident; `allowlist.test.ts` fails until it
 * is classified here.
 *
 * The host refuses most of the refused channels by itself as well (no `dialogs`, `shell`, `files`,
 * `ssh` or `pty` capability). This list is the server's own say, kept even where the host would agree.
 */

/**
 * Groups served on the server host:
 * - pure functions over the user's checkout and `state/`, and every protocol kind's editors;
 * - the server's own services, called in process as the user (`sync`, `account`, `team`, ...);
 * - `secrets`, sealed under the user's key (never shown: values do not leave the server);
 * - `oauth2`, the importers (`api`) and `certificates`, every connection under the egress rule.
 */
export const SERVED_GROUPS: ReadonlySet<string> = new Set([
  'project',
  'workspace',
  'request',
  'sequence',
  'runner',
  'script',
  'search',
  'snapshot',
  'globals',
  'currentValues',
  'history',
  'exchanges',
  'cookies',
  'preferences',
  'theme',
  'log',
  // Protocol kinds' editors: SOAP definitions, validation, XML and XPath helpers, WS-Addressing,
  // WS-I and WS-Security.
  'definition',
  'validate',
  'xml',
  'xpath',
  'wsa',
  'wsi',
  'wss',
  // Served in process.
  'sync',
  'account',
  'team',
  // `teamSecrets.status` only; every channel that makes or uses a machine key is refused below.
  'teamSecrets',
  'license',
  'audit',
  'hooks',
  'schedules',
  'ciTokens',
  'issuedTokens',
  'provisioning',
  // Sealed secrets.
  'secrets',
  // The save-time secret scan (controller ruling, Task 10 review): every channel takes an open project's
  // id and works on that project's model in memory, which the host read from the open workspace's working
  // copy under the platform root. None names a path, so none can scan a folder of its own choosing:
  // - `secretScan.hold` / `release`: pause and resume autosave while the review before a save is open;
  // - `secretScan.scan`: the findings, as masked previews;
  // - `secretScan.keep`: findings left in place for this session;
  // - `secretScan.move`: values moved into the user's sealed secrets, `${secret:name}` left behind;
  // - `secretScan.tokens`: the project's secret names and whether each has a value (names only);
  // - `secretScan.setValue`: one typed value, sealed; no response carries it.
  'secretScan',
  // Under the egress rule.
  'oauth2',
  'api',
  'certificates',
  // `app.version`, `app.areas`, `app.features`, `app.kinds`; the rest of `app` is refused below.
  'app',
]);

/** Groups never served: they need the user's machine, run its processes or open its ports and devices. */
export const REFUSED_GROUPS: ReadonlySet<string> = new Set([
  // Files, folders and dialogs of a machine.
  'fs',
  'dialogs',
  'git',
  'keystores',
  'ssl',
  'secretSources',
  'attachments',
  // Kerberos reads the machine's credentials cache.
  'auth',
  // A listener on a port, and third-party code.
  'mock',
  'plugins',
  // The machine's own terminal, SSH, SFTP, port forwards, their layouts, shares and recordings.
  'localTerminal',
  'ssh',
  'sftp',
  'forward',
  'layout',
  'terminalShare',
  'sessionLog',
  // A lock over the desktop's window.
  'appLock',
  // The local agent's own channels (§18.1): a paired agent on the person's machine serves them.
  'agent',
  // The desktop app's control of its own agent (pairing, the allowlist): served by its main process only.
  'machineAgent',
]);

/** Channels of a served group the server host refuses anyway, each with its reason. */
export const REFUSED_CHANNELS: Readonly<Record<string, string>> = {
  // Signing in is the server's own page (`/sign-in`); the host's account is the browser session.
  'account.signInLocal': 'signs in to a server; the browser session is the account',
  'account.startOidc': 'starts a desktop loopback sign-in',
  'account.startSaml': 'starts a desktop loopback sign-in',
  'account.cancelSignIn': 'cancels a desktop loopback sign-in',
  'account.lookupInvitation': 'part of accepting an invitation, which the server page does',
  'account.acceptInvitation': 'signs in through an invitation, which the server page does',
  // A desktop's process, windows and menu.
  'app.checkForUpdates': 'updates are the desktop app’s',
  'app.newWindow': 'opens a desktop window',
  'app.registerMenu': 'builds the desktop menu',
  // Approving an MCP server that runs as a process on the machine.
  'app.mcpApprovals': 'MCP servers that run as local processes',
  'app.mcpApprove': 'MCP servers that run as local processes',
  'app.mcpRevokeApproval': 'MCP servers that run as local processes',
  // Plugins are third-party code.
  'api.importPlugin': 'runs a plugin',
  'api.detectPluginImport': 'runs a plugin',
  // Writes a file the user picks on the machine.
  'api.exportDefinition': 'writes to a folder picked on the machine',
  'api.exportDocs': 'writes to a file picked on the machine',
  'audit.export': 'writes to a file picked on the machine',
  'definition.export': 'writes to a folder picked on the machine',
  'definition.generateDocs': 'writes to a file picked on the machine',
  'exchanges.saveRestBody': 'writes to a file picked on the machine',
  'log.exportHar': 'writes to a file picked on the machine',
  'runner.data.choose': 'reads a file picked on the machine',
  'workspace.exportCollection': 'writes to a folder picked on the machine',
  'workspace.exportProject': 'writes to a folder picked on the machine',
  'wsi.exportHtml': 'writes to a file picked on the machine',
  // Local and git workspaces: the server host opens server workspaces only.
  'workspace.create': 'creates a local workspace',
  'workspace.share': 'shares through git',
  'workspace.join': 'joins through git',
  'workspace.shareToFolder': 'shares to a folder on the machine',
  'workspace.joinFromFolder': 'joins from a folder on the machine',
  'workspace.stopSharing': 'turns a shared workspace into a local one',
  'workspace.linkProject': 'links a folder on the machine',
  'workspace.importProjectFolder': 'reads a folder on the machine',
  'workspace.locateProject': 'picks a folder on the machine',
  // The machine's file manager.
  'workspace.reveal': 'shows a folder in the machine’s file manager',
  'workspace.revealProject': 'shows a folder in the machine’s file manager',
  'sync.revealTree': 'shows a folder in the machine’s file manager',
  // Team-secret keys are an approved machine's (decision 5): the server host holds none, so it neither
  // makes one, asks for access with one, nor opens or seals the vault with one.
  'teamSecrets.turnOn': 'team-secret keys live on approved machines only (decision 5)',
  'teamSecrets.requestAccess': 'team-secret keys live on approved machines only (decision 5)',
  'teamSecrets.approve': 'team-secret keys live on approved machines only (decision 5)',
  'teamSecrets.decline': 'team-secret keys live on approved machines only (decision 5)',
  'teamSecrets.remove': 'team-secret keys live on approved machines only (decision 5)',
  'teamSecrets.grantAdmin': 'team-secret keys live on approved machines only (decision 5)',
  'teamSecrets.revokeAdmin': 'team-secret keys live on approved machines only (decision 5)',
  'teamSecrets.restoreMine': 'team-secret keys live on approved machines only (decision 5)',
  'teamSecrets.dismissReplaced': 'team-secret keys live on approved machines only (decision 5)',
  // "Show secrets" would put values in the socket's frames, and the flag is the host's, shared by every tab.
  'secrets.setShowSecrets': 'values never leave the server (ADR-0004)',
};

/** The group a channel belongs to: `workspace` for `workspace.open`. */
export function channelGroup(channel: string): string {
  const dot = channel.indexOf('.');
  return dot === -1 ? channel : channel.slice(0, dot);
}

/** `served`, `refused`, or `undefined` for a channel this table does not know (which is refused too). */
export function classifyChannel(channel: string): 'served' | 'refused' | undefined {
  if (Object.hasOwn(REFUSED_CHANNELS, channel)) return 'refused';
  const group = channelGroup(channel);
  if (SERVED_GROUPS.has(group)) return 'served';
  if (REFUSED_GROUPS.has(group)) return 'refused';
  return undefined;
}

/** Whether a browser socket may call `channel`: the `allowed` the host's `serveCall` takes. */
export function isServedChannel(channel: string): boolean {
  return classifyChannel(channel) === 'served';
}
