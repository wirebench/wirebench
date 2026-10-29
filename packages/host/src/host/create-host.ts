/**
 * The composition root as a function: one call builds a host — every service, the per-window scopes
 * and one table holding every channel the platform allows — over `platform`. It has no process-wide
 * side effect, so a process can run several (one per user, later); the Electron entry
 * (`apps/desktop/src/main/index.ts`) keeps what is the process's: the app's name, protocols, single instance,
 * windows and lifecycle.
 */
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { access, mkdir, rename } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, join } from 'node:path';
import {
  connectWebSocket,
  findGit,
  GitCli,
  WirebenchError,
  enabledProperties,
  overlayCurrent,
  parseSecretPseudoRef,
  TEAM_SECRETS_DIR,
  TEAM_SECRETS_VALUES_DIR,
  vaultEntryId,
  type ConnectOptions,
  type ConnectedWebSocket,
  type GetSecret,
  type HttpExchange,
  type HttpRequest,
} from '@wirebench/engine';
import { isExternalUrlAllowed } from '../security.js';
import { createNativeDialogs } from '../native-dialogs.js';
import { createHostState } from './host-state.js';
import { machineEnv } from './machine-env.js';
import { DialogPicks } from '../dialog-picks.js';
import { EngineService } from '../engine-service.js';
import { GlobalProperties } from '../global-properties.js';
import { HistoryService, watchHistoryFile } from '../history-service.js';
import {
  gitLocatorOptions,
  PreferencesService,
  rememberPickedCaBundle,
  rememberPickedGit,
  toPreferencesWire,
} from '../preferences.js';
import { policyFilePath } from '../policy.js';
import { readLeftoverProjectFolders, toFeatureStateWire, WorkspaceService } from '../workspace-service.js';
import { WorkspaceState } from '../workspace-state.js';
import { routeWorkspaces, scoped, WindowScopes } from '../window-scope.js';
import { platformSecretsBackend, SecretStore, ShowSecretsFlag } from '../secrets.js';
import { SecretSourcesService } from '../secret-sources-service.js';
import { projectSecretGetter, reportedSecretGetter, secretNameOf, secretStoreLabel } from '../secret-resolver.js';
import { AppLock, lockedGetter } from '../app-lock.js';
import type { DeviceKeys } from '../device-keys.js';
import { SshKeysService } from '../ssh-keys.js';
import { SshSecretsService } from '../ssh-secrets.js';
import { SecretScanSessions } from '../secret-scan-session.js';
import { TeamSecretsService } from '../team-secrets-service.js';
import { TeamSecretStore, teamSecretGetter } from '../team-secret-store.js';
import { events } from '@wirebench/wire/ipc';
import { emitEvent } from '../ipc/events.js';
import { registerAppChannels, type AppMenu } from '../ipc/app.js';
import type { Caller, HostPlatform } from './platform.js';
import { HandlerTable } from '../ipc/register.js';
import {
  resolveAreas,
  type AreasRun,
  hostsOnFileChange,
  hostsOnWorkspaceChange,
  registerEnabledAreaChannels,
} from '../areas.js';
import { SshImportService } from '../ssh-import.js';
import { KnownHostsImportService } from '../known-hosts-import.js';
import { sshAreaEndsOnSwitch, sshScopeOf, sshSecretsFor } from '../ssh-window.js';
import { sshDefaultsOf, windowHosts, type HostsService } from '../hosts-service.js';
import { windowSnippets, type SnippetsService } from '../snippets-service.js';
import { LAYOUTS_FILE, LayoutStore } from '../layout-store.js';
import { SERIAL_DEVICES_FILE, SerialDeviceStore } from '../serial-devices.js';
import { listSerialPorts, openSerialSession } from '../serial-session.js';
import { MCP_APPROVALS_FILE, McpApprovals, McpApprovalStore } from '../mcp-approvals.js';
import { promptWindowOf } from '../kinds/mcp/ipc.js';
import {
  SESSION_LOGS_DIR,
  SESSION_LOG_SWITCHES_FILE,
  SessionLogStore,
  SessionLogSwitches,
  sessionLogPlanner,
} from '../session-logs.js';
import { SessionLogUploader } from '../session-log-uploader.js';
import { TerminalShareOwner } from '../terminal-share/owner.js';
import { TerminalShareViewer } from '../terminal-share/viewer.js';
import { SshService, forwardResume } from '../ssh-service.js';
import { localShell, localShellCwd, localShellEnv } from '../local-shell.js';
import { LocalTerminalService } from '../local-terminal-service.js';
import { findMoshClient, isExecutable } from '../mosh-client.js';
import { openMoshSession } from '../mosh-session.js';
import { RefusalStore, createSshConnector } from '../ssh-connect.js';
import { SftpEditService, sweepEditCopies } from '../sftp-edit.js';
import { SftpService } from '../sftp-service.js';
import { ForwardService } from '../forward-service.js';
import { createForwardBinds } from '../forward-binds.js';
import { TransferQueue } from '../transfers.js';
import { registerKerberosChannels } from '../kerberos.js';
import { clearAttachmentsTmp } from '../kinds/soap/channels/attachments.js';
import { startupFeatures, type FeaturesRun } from '../features/startup.js';
import { loadDesktopPlugins, type DesktopPlugins } from '../plugins/desktop-plugins.js';
import { registerPluginChannels } from '../ipc/plugins.js';
import { MAIN_KINDS } from '../kinds/kind-main.js';
import { registerKeystoreChannels } from '../ipc/keystores.js';
import { registerCertificateChannels } from '../ipc/certificates.js';
import { registerDialogsChannels } from '../ipc/dialogs.js';
import { registerExchangeChannels } from '../ipc/exchanges.js';
import { registerSendRouteChannels } from '../ipc/send-route.js';
import { RoutePins, routePinsPath } from '../send-route.js';
import { registerLogChannels } from '../ipc/log.js';
import { registerFsChannels } from '../ipc/fs.js';
import { registerGlobalsChannels } from '../ipc/globals.js';
import { CookieStore } from '../cookie-store.js';
import { CurrentValuesStore } from '../current-values.js';
import { registerCookiesChannels } from '../ipc/cookies.js';
import { registerCurrentValuesChannels } from '../ipc/current-values.js';
import { registerHistoryChannels, type HistoryChannelDeps } from '../ipc/history.js';
import { registerPreferencesChannels } from '../ipc/preferences.js';
import { registerApiChannels, type ApiChannelDeps } from '../ipc/api.js';
import { registerProjectChannels } from '../ipc/project.js';
import { registerWorkspaceChannels } from '../ipc/workspace.js';
import { registerMockChannels } from '../ipc/mock.js';
import { registerRunnerChannels } from '../ipc/runner.js';
import { registerSequenceChannels } from '../ipc/sequence.js';
import { MOCK_ALL_INTERFACES_HOST, MOCK_LOOPBACK_HOST, MockRunner } from '../mock-runner.js';
import { RunnerService } from '../runner/runner-service.js';
import { RunnerHistoryStore, RunnerSettingsStore } from '../runner/stores.js';
import { SequenceRunner } from '../sequence-runner.js';
import { ScriptHost } from '../script-host.js';
import { registerScriptChannels } from '../ipc/script.js';
import {
  registerRequestChannels,
  toSendDeps,
  whenRestSendsRecorded,
  whenWsSessionsRecorded,
  type RequestChannelDeps,
} from '../ipc/request.js';
import { registerOAuth2Channels } from '../ipc/oauth2.js';
import { registerIssuedTokenChannels } from '../ipc/issued-tokens.js';
import { IssuedTokensService, type ResolvedIssuedToken } from '../issued-tokens.js';
import { desktopSecrets, stsLogEntry } from '../send/host.js';
import { ExchangeRegistry } from '../send/exchange.js';
import { sendFromDirectory, type DetachedSendResult, type SendFromDirectoryInput } from '../send/detached.js';
import { ProjectHost } from '../project-host.js';
import { OAuth2Service } from '../oauth2.js';
import { registerAccountChannels, toAccountWire } from '../ipc/account.js';
import { registerTeamChannels } from '../ipc/team.js';
import { HooksService } from '../hooks/hooks-service.js';
import { SchedulesService } from '../schedules/schedules-service.js';
import { desktopCaptureSource, linkedServerOf } from '../hooks/capture-source.js';
import { registerCiTokenChannels } from '../ipc/ci-tokens.js';
import { registerLicenseChannels } from '../ipc/license.js';
import { registerProvisioningChannels } from '../ipc/provisioning.js';
import { registerAuditChannels } from '../ipc/audit.js';
import { registerHooksChannels } from '../ipc/hooks.js';
import { registerSchedulesChannels } from '../ipc/schedules.js';
import { AccountService } from '../account-service.js';
import { AuditReporter } from '../audit/reporter.js';
import { normalizeServerUrl, ServerClient } from '../server-client.js';
import { LiveClients } from '../live/live-clients.js';
import { mainHttpOptions, resolveProxy, type MainHttpDeps } from '../network-options.js';
import { OpenApiImportService } from '../openapi-import.js';
import { ProtoImportService } from '../proto-import.js';
import { registerSearchChannels } from '../ipc/search.js';
import { registerSecretsChannels } from '../ipc/secrets.js';
import { registerSecretSourcesChannels } from '../ipc/secret-sources.js';
import { registerTeamSecretsChannels } from '../ipc/team-secrets.js';
import { registerSecretScanChannels } from '../ipc/secret-scan.js';
import { registerSnapshotChannels } from '../ipc/snapshot.js';
import { SnapshotStore } from '../snapshot-store.js';
import { registerAppLockChannels } from '../ipc/app-lock.js';
import { registerSslChannels } from '../ipc/ssl.js';
import { registerGitChannels } from '../ipc/git.js';
import { registerSyncChannels } from '../ipc/sync.js';
import { registerThemeChannels } from '../ipc/theme.js';
import { requireCapability } from './capability.js';
import type { UpdateChannel, UpdateController, UpdateStatus } from '../updater.js';
import type { IpcEvent } from '@wirebench/wire/ipc';
import type { z } from 'zod';
import type { WorkspaceWire } from '@wirebench/wire/wire-base';

/** A host: its channels, and the callers (windows, later connections) it serves. */
export interface Host {
  /**
   * Every channel the platform supports, for a transport to serve (`bindIpc`): the channels that need an
   * optional platform member (`dialogs`, `shell`, `power`) are left out when the platform has none.
   */
  readonly handlers: HandlerTable;
  /** A window (or connection) opened: creates its scope (`createWindowScope`). */
  attach(caller: Caller, options?: AttachOptions): void;
  /** A window is closing: runs its quit path and drops its scope; resolves once it is done. */
  detach(callerId: number): Promise<void>;
  /** What the app's quit does, minus quitting: resolves once every window's quit path ran. */
  shutdown(): Promise<void>;
  /**
   * Sends one item of the project in a folder no window has open, for the local agent's send bundle (spec
   * §18.4): the same send dependencies a window's send gets (the secret getter, the redactor, the
   * preferences), over a project and an engine service of its own, with `input.cookies` as its jar. It
   * writes no History, HTTP Log row or audit event, keeps no script value, and its result is always
   * redacted. Called in process; no channel reaches it.
   */
  sendFromDirectory(input: SendFromDirectoryInput): Promise<DetachedSendResult>;
}

export interface AttachOptions {
  /** Reopen the last workspace, as the launch's first window does; otherwise open at the picker. */
  readonly reopenLast?: boolean;
}

/** What the embedder does with the windows its callers live in. */
export interface HostWindows {
  /** New Window (design D7). */
  open(): void;
  setTitle(caller: Caller, title: string): void;
  /** Restores and focuses the caller's window (design D5: the window holding a workspace comes forward). */
  bringForward(caller: Caller): void;
  /** The caller whose window the user is in, if any. */
  focused(): Caller | undefined;
}

/**
 * What the embedder gives a host besides the platform: the pieces that belong to the process (one
 * updater, one menu, one SSH signer) or to its windows. Each is optional; a host without one goes
 * without (no update check, no menu, no device keys or app lock, no titles).
 */
export interface HostOptions {
  readonly windows?: HostWindows;
  readonly menu?: AppMenu;
  /** Builds the update controller over the host's broadcast and its `updates.channel` preference. */
  readonly updates?: (deps: {
    readonly report: (status: UpdateStatus) => void;
    readonly channel: () => UpdateChannel;
  }) => Pick<UpdateController, 'check' | 'checkOnLaunch'>;
  /** The process's device keys (#428), and whether the app lock can ask through their helper here. */
  readonly deviceKeys?: { readonly keys: DeviceKeys; readonly appLockSupported: boolean };
  /**
   * A host that runs inside a Wirebench Server (hosted edition spec §17.3): its calls to that server go
   * through `send` and its live socket through `connectLive`, in process, rather than over the network.
   * The account for `url` is the embedder's: signed in with whatever `credential()` returns, never stored,
   * and not one the host can sign in to, sign out of or remove. Absent, the host reaches servers over the
   * network.
   */
  readonly server?: {
    /** The server's public URL: the host's one account. */
    readonly url: string;
    readonly send: (request: HttpRequest) => Promise<HttpExchange>;
    readonly connectLive: (wsUrl: string) => ConnectedWebSocket;
    /** The account's device token now, or `undefined` while the embedder has none; read on every use. */
    readonly credential: () => string | undefined;
  };
  /**
   * Told of every value the host stores (`written`: the Secrets page, a cURL import, a refresh token,
   * team secrets, a sign-in) and every ref a send, an import or a call from main resolves (`resolved`,
   * with the request's host name when known), by name and never by value, for the embedder's audit
   * (spec §17.4). The host's own reads of its sign-in tokens are not resolutions. A listener that throws
   * changes nothing.
   */
  readonly onSecret?: (event: SecretEvent) => void;
  /**
   * Where this host's sends go out from (hosted edition spec §18.4): `'server'` on a Wirebench Server's host,
   * which then stamps its History entries and summaries `sentFrom: 'server'` and routes browser sends
   * (`request.route`, `request.bundle`, `request.setRoutePin`, `exchanges.recordAgentSend`). Absent on the
   * desktop, which stamps nothing and always answers `request.route` with `server`.
   */
  readonly sendOrigin?: 'server';
}

/** What {@link HostOptions.onSecret} hears: a secret's name, never its value. */
export interface SecretEvent {
  readonly kind: 'written' | 'resolved';
  readonly name: string;
  /** The host name the send that resolved it goes to; only on `resolved`, and only when known. */
  readonly target?: string;
}

/**
 * Every open window's own services (multi-window design D1): its workspace, picks, cookie jar,
 * current values, secret sources, team secrets, secret scans and audit reporter. See `createWindowScope`.
 */
interface WindowScope {
  /** The window (or connection) the scope serves. */
  readonly caller: Caller;
  /** `caller.id`, the key the scope is kept under. */
  readonly id: number;
  readonly picks: DialogPicks;
  readonly cookies: CookieStore;
  readonly currentValues: CurrentValuesStore;
  readonly secretSources: SecretSourcesService;
  /**
   * Team secrets for the window's open shared workspace. It writes this machine's keys and the team's
   * values into `secretStore` directly; everything the renderer saves goes through `teamSecretStore`,
   * which stores locally and then hands the value to the vault. Sign-in tokens, OAuth refresh tokens
   * and a cURL import stay on `secretStore`: they are this machine's, not the team's.
   */
  readonly teamSecrets: TeamSecretsService;
  readonly teamSecretStore: TeamSecretStore;
  readonly secretScans: SecretScanSessions;
  /** Reports the window's workspace's sends and test runs to its server's audit log (desktop audit events §2.4). */
  readonly audit: AuditReporter;
  readonly workspace: WorkspaceService;
  /** The SSH area's cached `hosts.yaml` of this window's workspace. */
  readonly hosts: HostsService;
  /** The SSH area's cached `snippets.yaml`, beside `hosts.yaml`. */
  readonly snippets: SnippetsService;
  /** The reopen of the last workspace this window started with; resolved at once for one opened at the picker. */
  ready: Promise<void>;
  /** Whether the window's audit server was signed in at the last account change. */
  auditSignedIn: boolean;
  /** The window's own quit path, once started (`closeWindowScope`). */
  closing: Promise<void> | undefined;
  /** Unsubscribes the `caller.onClosed` listener `attach` made; run when the scope is closed. */
  releaseClosed: () => void;
}

/**
 * How long closing WebSocket sessions may hold up a project close or the quit while their History
 * entries are written. A socket that will not finish closing must not be the reason the app cannot
 * quit; past this the entry is the one thing lost, rather than the whole shutdown.
 */
const WS_SESSION_RECORD_TIMEOUT_MS = 2_000;

// Quitting writes nothing to a project. Unsaved changes are kept with the workspace instead
// and come back, still unsaved, the next time it opens (`unsaved-store.ts`): every window runs its
// own quit path (`closeWindowScope`) at once, then the app goes.
const QUIT_DRAFTS_TIMEOUT_MS = 2_000;

/** A server URL by origin, the way accounts are kept; `undefined` for text that is no server URL. */
function sameOrigin(url: string): string | undefined {
  try {
    return normalizeServerUrl(url);
  } catch {
    return undefined;
  }
}

/** The window's account is signed in to the server its workspace reports audit events to. */
function auditSignedInFor(
  scope: WindowScope,
  servers: readonly { readonly url: string; readonly signedOut?: boolean | undefined }[],
): boolean {
  const target = scope.workspace.auditTarget();
  const origin = target === undefined ? undefined : sameOrigin(target.url);
  return (
    origin !== undefined && servers.some((account) => sameOrigin(account.url) === origin && account.signedOut !== true)
  );
}

/** `server`'s transport, refusing any URL whose origin is not `server.url`'s. */
function ownServerOnly(
  server: NonNullable<HostOptions['server']>,
): Pick<NonNullable<HostOptions['server']>, 'send' | 'connectLive'> {
  const origin = normalizeServerUrl(server.url);
  const refuse = (url: string): never => {
    // The origin alone: a path or query is no business of the message.
    throw new WirebenchError(
      'server-url-invalid',
      `This host reaches ${origin} only, not ${sameOrigin(url) ?? 'that address'}`,
    );
  };
  return {
    send: async (request) => {
      if (sameOrigin(request.url) !== origin) refuse(request.url);
      return await server.send(request);
    },
    connectLive: (wsUrl) => {
      if (sameOrigin(wsUrl.replace(/^ws/, 'http')) !== origin) refuse(wsUrl);
      return server.connectLive(wsUrl);
    },
  };
}

/**
 * Builds a host over `platform`, with what `embedder` gives it (see {@link HostOptions}). It reads the
 * preferences before registering (the feature and area switches decide which channels exist), so it
 * resolves once every channel is in `handlers`.
 */
export async function createHost(platform: HostPlatform, embedder: HostOptions = {}): Promise<Host> {
  /** What this host holds in memory: the one `createHostState()` result, handed to the pieces below. */
  const hostState = createHostState(platform.machineValues === false ? { machineValues: false } : {});
  /** The environment overrides are read from: none on a host without machine values. */
  const env = machineEnv(platform);
  /** The platform's egress rule, as an option every connector below spreads in; nothing without one. */
  const egress = platform.network?.egress;
  const egressOption = egress !== undefined ? { egress } : {};
  /** Whether this host keeps workspaces and other files of the machine's own (`files`). */
  const hasFiles = platform.capabilities.has('files');
  /** Whether secret sources (spec D6: commands and files on the machine) resolve here. */
  const hasSecretSources = hasFiles && platform.capabilities.has('secret-sources');
  /**
   * Whether this host may hold a team-secrets machine key (decision 5: the server's never does). Without
   * it no workspace is handed to team secrets, so nothing makes, requests or uses a key, and only the
   * status channel is served.
   */
  const hasTeamSecrets = platform.capabilities.has('team-secrets');
  /** Tells the embedder of a secret by name; its failure is never the caller's. */
  const reportSecret = (event: SecretEvent): void => {
    try {
      embedder.onSecret?.(event);
    } catch (error) {
      console.warn('[secrets] the secret listener failed', error instanceof Error ? error.message : String(error));
    }
  };
  const nativeDialogs = createNativeDialogs(platform);
  /** The platform's shell, asked for at use: a host without one refuses only what needs it. */
  const hostShell = (): NonNullable<HostPlatform['shell']> => requireCapability(platform, 'shell');

  /**
   * The keychain-backed secret store; never exposes values to the renderer (no `secrets.get`). Every value
   * stored in it, by whichever path (the Secrets page, a cURL import, a refresh token, team secrets, a
   * sign-in), is reported to the embedder by name.
   */
  const secretStore = new SecretStore(
    platform.paths.userData(),
    platformSecretsBackend(platform.secrets),
    console.warn,
    embedder.onSecret === undefined
      ? undefined
      : ({ ref, label }) => {
          reportSecret({ kind: 'written', name: secretNameOf(label, ref) });
        },
  );
  /** The name a resolved ref is reported by: its `${secret:name}` name, else its store label, else the ref. */
  const resolvedName = async (ref: string): Promise<string> =>
    parseSecretPseudoRef(ref) ??
    secretNameOf((await secretStore.list()).find((entry) => entry.ref === ref)?.label, ref);
  /** `get`, reporting what it resolves (`HostOptions.onSecret`); `get` itself without a listener. */
  const reporting = (get: GetSecret, target?: string): GetSecret =>
    embedder.onSecret === undefined
      ? get
      : reportedSecretGetter(get, async (ref) => {
          reportSecret({
            kind: 'resolved',
            name: await resolvedName(ref),
            ...(target !== undefined ? { target } : {}),
          });
        });
  /** Session-only "show secrets" toggle, consulted by `redact.ts` via `request.send`. */
  const showSecretsFlag = new ShowSecretsFlag();

  const scopes = new WindowScopes<WindowScope>();

  /** The user's application preferences, shared by every project and every window. */
  const preferencesService = new PreferencesService(platform.paths.userData(), {
    // Managed machines: an administrator's policy file locks the settings it names (see `policy.ts`).
    // A host without machine values looks for no policy file: the process's machine is not the user's.
    ...(platform.machineValues === false
      ? {}
      : { policyFile: policyFilePath({ platform: process.platform, env, isPackaged: platform.app.packaged() }) }),
    // A default User-Agent names the release that sends it.
    appVersion: platform.app.version(),
  });

  /**
   * The secret getter every send resolves through, for one project's `${secret:name}` tokens (or,
   * with no project, for plain refs only). Each value it hands out is recorded in the host's `Redactor`, so it
   * is masked in the HTTP log and History like any `Authorization` header. Team secrets gets a look
   * first: a value the vault holds that this machine cannot open refuses the send with why (waiting,
   * removed or declined) instead of the plain "not on this machine". Secret sources (spec D6) sit in
   * front of both.
   *
   * Team secrets and secret sources are the workspace's, so each ref is resolved through the window
   * whose workspace holds `projectId` (the caller's, for no project). With no such window, only the
   * plain store answers.
   */
  const secretsFor = (projectId: string | undefined, target?: string): GetSecret => {
    const plain = projectSecretGetter(secretStore, projectId, hostState.redactor.recordSecretValue);
    const resolve = async (ref: string): Promise<string | undefined> => {
      const scope =
        projectId === undefined
          ? scopes.callerOrOnly()
          : scopes.find((candidate) => candidate.workspace.projectId(projectId) !== undefined);
      if (scope === undefined) {
        return await plain(ref);
      }
      const team = teamSecretGetter(plain, scope.teamSecrets, projectId);
      // A source runs a command or reads a file on the machine: a host without them never consults one.
      return await (hasSecretSources ? scope.secretSources.wrap(team) : team)(ref);
    };
    return reporting(resolve, target);
  };

  /** The calling window's workspace secrets for the SSH area (`ssh.secretNames`, `ssh.setSecret`). */
  const sshSecrets = new SshSecretsService({
    store: secretStore,
    workspaceId: () => scopes.callerOrOnly()?.workspace.openWorkspaceId(),
    mappedNames: () => scopes.callerOrOnly()?.secretSources.mappedNames() ?? [],
  });

  /** The single in-process engine instance backing every `definition.*`/`request.*` channel. */
  // WSDL reads share the definition fetcher's CA bundle and proxy: a WSDL reachable only through the
  // corporate proxy, or served with a corporate-CA certificate, imports where a send would reach it.
  const engineService = new EngineService(secretsFor(undefined), (url) => mainHttpOptions(url, mainHttpDeps));
  /** The sends in flight through the engine's `openExchange`, which `request.cancel` and a close reach. */
  const exchanges = new ExchangeRegistry();
  /**
   * The picks preferences carry — the CA bundle and git executable chosen in Settings — which apply to
   * every window. Each window's own picks are built over it (`dialog-picks.ts`, design D4).
   */
  const appPicks = new DialogPicks();
  /** The calling window's native-dialog picks; see `dialog-picks.ts`. */
  const dialogPicks = scoped(scopes, (scope) => scope.picks);
  /** The calling window's workspace for workspace-level calls; for entity-addressed ones, the holder's (design D2). */
  const workspaceService = routeWorkspaces(scopes, (scope) => scope.workspace);
  /** Every mock this app is serving, across windows; each one's events go to the window that started it. */
  const mockRunner = new MockRunner();

  /** Opens an external URL, gated the same way for every flow that hands off to a browser. */
  const openExternalChecked = async (url: string): Promise<void> => {
    if (!isExternalUrlAllowed(url)) {
      throw new WirebenchError('external-url-refused', 'That sign-in URL is not an http(s) address');
    }
    await hostShell().openExternal(url);
  };

  /**
   * OAuth2 tokens for the session, and the one loopback listener a browser sign-in answers to.
   *
   * The callback port comes from preferences because some providers insist on an exact redirect URI;
   * with none set the listener takes a random free port, which is what RFC 8252 prefers.
   */
  const oauth2Service = new OAuth2Service({
    openExternal: openExternalChecked,
    // Without a shell there is no browser to send the user to: those grants are refused up front.
    browserFlows: platform.shell !== undefined,
    callbackPort: () => preferencesService.get().rest.oauth2CallbackPort,
    ...egressOption,
  });

  /**
   * Issued SAML tokens (WS-Trust) for the session: one cache every send borrows, never persisted.
   * The panel's lookup reads the entry and the request it is fetched for from the open project, and a
   * Fetch now logs its exchange with the token service as a send's does, with no send to link it to.
   */
  const issuedTokensService: IssuedTokensService = new IssuedTokensService(
    async (locator): Promise<ResolvedIssuedToken> => {
      const resolved = await workspaceService.issuedTokenTarget(
        locator.projectId,
        locator.configId,
        locator.entryIndex,
        locator.requestId,
        // The getter a send of the project reads through: team secrets and `${secret:…}` refs resolve too.
        desktopSecrets({ secretsFor }, locator.projectId),
      );
      return {
        ...resolved,
        // A Fetch now reaches the token service under the host's egress rule, as a send's fetch does.
        target: { ...resolved.target, ...egressOption },
        deps: {
          ...resolved.deps,
          onExchange: (http) => {
            try {
              const entry = stsLogEntry(hostState.redactor, http, {
                show: showSecretsFlag.get(),
                ...(locator.requestId !== undefined ? { requestId: locator.requestId } : {}),
              });
              emitToCaller(events.exchange.logged, { entry });
            } catch {
              // A broadcast that fails never becomes the token's lastError, as a send's STS row.
            }
          },
        },
      };
    },
    hostState.redactor,
  );

  /**
   * The CA bundle and proxy the server client last resolved, per server origin (live-updates R5).
   * `mainHttpOptions` is async, since it reads the bundle and may ask for a PAC answer, while a live
   * socket's `connect` is not. The socket therefore reuses what the HTTP calls resolved.
   * `LiveClient` asks `serverClient.meta` before it connects (§3.4), and every sync fetch refreshes the
   * entry. A server reachable over HTTP is then reachable over the socket, with the same trust and the
   * same proxy.
   */
  const serverConnectOptions = new Map<string, ConnectOptions>();

  /**
   * What a project-free send from main resolves its CA bundle and proxy from: the preferences, the
   * paths picked this session, the keychain and the system's PAC answer. The server client and the
   * definition fetcher share it, so the two never drift apart.
   */
  const mainHttpDeps: MainHttpDeps = {
    preferences: () => preferencesService.get(),
    // Preferences are the app's, so the paths they name are app picks.
    picks: appPicks,
    getSecret: secretsFor(undefined),
    resolveSystemProxy: async (target) => await platform.proxy.resolve(target).catch(() => undefined),
    ...egressOption,
  };

  /**
   * The embedder's in-process transport (`HostOptions.server`), held to its one server: a call or a socket
   * for any other origin is refused here rather than handed to a transport that would answer it as its own.
   */
  const inServer = embedder.server === undefined ? undefined : ownServerOnly(embedder.server);

  /**
   * The Wirebench Server HTTP client, shared by every account and every server it signs into. A host
   * inside a server sends through the embedder's in-process `send` instead (`HostOptions.server`).
   */
  const serverClient = new ServerClient({
    options: async (origin) => {
      const options = await mainHttpOptions(origin, mainHttpDeps);
      serverConnectOptions.set(origin, options);
      return options;
    },
    ...(inServer !== undefined ? { send: inServer.send } : {}),
  });

  /** Who this installation is signed in as, per Wirebench Server (identity spec §3.8, §4.3). */
  const accountService = new AccountService({
    userDataDir: platform.paths.userData(),
    client: serverClient,
    secrets: secretStore,
    openExternal: openExternalChecked,
    defaultDeviceName: hostname,
    ...(embedder.server !== undefined
      ? { embedded: { url: embedder.server.url, credential: embedder.server.credential } }
      : {}),
  });

  /**
   * One live socket per signed-in server with an open workspace on it (live-updates §3.4), closed on
   * quit. It opens with the TLS and proxy `serverClient` last used for that server (R5): the key is the
   * socket URL's `http(s):` origin, which is the stored server origin the HTTP calls went to.
   */
  const liveClients = new LiveClients({
    accounts: accountService,
    client: serverClient,
    connect:
      inServer?.connectLive ??
      ((wsUrl) => {
        const options: ConnectOptions = serverConnectOptions.get(new URL(wsUrl.replace(/^ws/, 'http')).origin) ?? {};
        return connectWebSocket(wsUrl, { ...egressOption, ...options });
      }),
  });

  /**
   * Catch URLs and captures (webhook-capture §4.1): the server calls share `serverClient`'s CA bundle and
   * proxy, and the live nudges ride the same sockets as sync. Captures stay in memory, per open tab.
   */
  const hooksService = new HooksService({
    client: serverClient,
    accounts: accountService,
    live: liveClients,
    emit: {
      changed: (event) => broadcast(events.hooks.changed, event),
      captured: (event) => broadcast(events.hooks.captured, event),
      captures: (event) => broadcast(events.hooks.captures, event),
    },
  });

  /** A shared workspace's schedules (#517): every call goes to the server; `schedule-run` rides the live socket. */
  const schedulesService = new SchedulesService({
    client: serverClient,
    accounts: accountService,
    live: liveClients,
    emit: { changed: (event) => broadcast(events.schedules.changed, event) },
  });

  /** The session's in-flight OpenAPI and AsyncAPI reads: one cancel per token, one fetcher per read. */
  const openApiImports = new OpenApiImportService({
    getSecret: secretsFor(undefined),
    // The preference-level CA bundle and proxy a project-free send uses: an import may target a project
    // that does not exist yet, and a definition has no client identity of its own.
    network: (url) => mainHttpOptions(url, mainHttpDeps),
  });
  const protoImports = new ProtoImportService({
    ...egressOption,
    // Under a rule, a URL read goes through main's own client: the rule, the CA bundle and the proxy.
    network: (url) => mainHttpOptions(url, mainHttpDeps),
    // A discovery from the Import dialog trusts what a send would: the configured CA bundle, plus the
    // user's own "trust this certificate anyway" for a development server.
    grpcTls: ({ trustInvalid }) => workspaceService.grpcDiscoveryTls(trustInvalid),
  });

  /** Sends one event to every window of this host: preferences, globals, accounts and the like are the app's. */
  function broadcast<Payload extends z.ZodType>(event: IpcEvent<Payload>, payload: z.infer<Payload>): void {
    for (const scope of scopes.all()) {
      emitEvent(scope.caller, event, payload);
    }
  }

  /**
   * Sends one event about a send to the window that started it, or to every window when it was not
   * started from one (design D3): one window's HTTP log is not another's.
   */
  function emitToCaller<Payload extends z.ZodType>(event: IpcEvent<Payload>, payload: z.infer<Payload>): void {
    const scope = scopes.callerOrOnly();
    if (scope === undefined) {
      broadcast(event, payload);
    } else {
      emitEvent(scope.caller, event, payload);
    }
  }

  /** Keeps one window's OS title in step with its workspace, as `name — Wirebench`. */
  function applyWindowTitle(caller: Caller, workspace: WorkspaceWire | null): void {
    if (!caller.isClosed()) {
      embedder.windows?.setTitle(caller, workspace === null ? 'Wirebench' : `${workspace.name} — Wirebench`);
    }
  }

  /** The user's `${#Global#name}` scope, shared by every project and every window. */
  const globalProperties = new GlobalProperties(platform.paths.userData());

  /** The calling window's cookie jar (cookie jar spec §2); each window's follows its own workspace. */
  const cookieStore = scoped(scopes, (scope) => scope.cookies);
  /** The calling window's current values (cookie jar spec §5). */
  const currentValues = scoped(scopes, (scope) => scope.currentValues);

  /** Persistent request history — one jsonl file per open project under `userData`, watched for other writers. */
  const historyService = new HistoryService(
    platform.paths.userData(),
    hostState.redactor,
    () => preferencesService.get().ui.historyCap,
    {
      watch: watchHistoryFile,
      onChanged: (projectId) => broadcast(events.history.changed, { projectId }),
      ...(embedder.sendOrigin !== undefined ? { sendOrigin: embedder.sendOrigin } : {}),
    },
  );

  /**
   * Where a deleted workspace (or project folder) goes. `shell.trashItem` in a real run; under
   * e2e, a move into `WIREBENCH_E2E_TRASH_DIR`, because a Playwright run must be able to *assert*
   * on what was trashed and the OS trash is neither readable nor per-profile. Either way nothing
   * is ever removed: there is no `rm` on this path.
   *
   * The override is honoured only in an unpackaged run (every e2e run is one). In a shipped build
   * it would let an environment variable redirect a deletion to a folder of someone else's
   * choosing, so a packaged app always uses the real trash.
   */
  async function trashFolder(target: string): Promise<void> {
    const e2eTrashDir = platform.app.packaged() ? undefined : env['WIREBENCH_E2E_TRASH_DIR'];
    if (e2eTrashDir === undefined) {
      await hostShell().trash(target);
      return;
    }
    await mkdir(e2eTrashDir, { recursive: true });
    await rename(target, join(e2eTrashDir, `${basename(target)}-${String(Date.now())}`));
  }

  // `core.hooksPath` for every `GitCli.run` call points here: an empty, writable directory, so
  // a cloned or joined tree's own `.git/hooks` (or any hook a remote's push tries to install)
  // never runs. Created once below, before any channel registers (and so before any workspace, and
  // any sync, can open).
  const hooksDir = join(platform.paths.userData(), 'git-hooks-empty');

  // e2e cannot install a real git on every runner, so this simulates "git missing"/"git found
  // at this exact path" instead. Honoured only in an unpackaged run, for the same reason every
  // other `WIREBENCH_E2E_*` override is: a packaged build must not let an environment variable
  // redirect which executable main runs. Precedence (see `gitLocatorOptions`): the e2e override,
  // restricted to that path alone (so it can simulate "no git installed" even on a machine or CI
  // runner that has a real one), then a git.path preference main itself picked (`configuredGitPath`
  // — an unmarked or cleared value never counts), then plain discovery.
  const gitLocator = (): ReturnType<typeof findGit> =>
    findGit(
      gitLocatorOptions({
        env,
        isPackaged: platform.app.packaged(),
        preferences: preferencesService.get(),
      }),
    );

  /** The calling window's team secrets, the store over them, and its secret sources and scans. */
  const teamSecrets = scoped(scopes, (scope) => scope.teamSecrets);
  const teamSecretStore = scoped(scopes, (scope) => scope.teamSecretStore);
  const secretSources = scoped(scopes, (scope) => scope.secretSources);
  const secretScans = scoped(scopes, (scope) => scope.secretScans);

  /**
   * This run's area switches (`areas.ts`): the managed policy's `areas` section (#360) over `WIREBENCH_AREAS`.
   * Resolved again below once the policy is read, before any channel registers or window opens; what is
   * built before that (the SSH service) reads the flags through a getter at connect.
   */
  let areas: AreasRun = resolveAreas({ env, capabilities: platform.capabilities });
  /** The device each serial host (#426) opens on this machine, per workspace. */
  const serialDevices = new SerialDeviceStore(join(platform.paths.userData(), SERIAL_DEVICES_FILE));

  /**
   * This run's feature switches (phase 4 spec §4.2): the `features` preference, resolved once the
   * preferences are loaded (below, before any channel or window) and kept for the run. Each
   * workspace hands the registry resolved for it (its team policy laid over, §6.2) to its project hosts,
   * which pass it to every load, save and send, so a project's containers of a kind that is off load as
   * placeholders and are saved untouched. A changed preference applies at the next start.
   */
  /** This run's plugins, loaded below with the preferences (phase 7 §6); none before that. */
  let plugins: DesktopPlugins = loadDesktopPlugins({ userData: platform.paths.userData(), off: true });

  let features: FeaturesRun = startupFeatures({
    preferences: { features: {} },
    env,
    isPackaged: platform.app.packaged(),
  });

  /** The calling window's `hosts.yaml` (each window has its own, for its own workspace; see `createWindowScope`). */
  const hostsService = scoped(scopes, (scope) => scope.hosts);
  /** The calling window's `snippets.yaml`, cached per window like its hosts. */
  const snippetsService = scoped(scopes, (scope) => scope.snippets);

  /** Device keys (#428), the embedder's: they are the process's SSH signer. */
  const deviceKeys = embedder.deviceKeys?.keys;
  /**
   * The app lock (#428): with `secrets.appLock` on, the first SSH secret read after launch, after the idle time,
   * or after the screen locked asks for biometrics or the OS password, through the device keys' helper.
   */
  const appLockSupported = embedder.deviceKeys?.appLockSupported ?? false;
  const appLock = new AppLock({
    enabled: () => preferencesService.get().secrets.appLock,
    idleMinutes: () => preferencesService.get().secrets.appLockIdleMinutes,
    supported: appLockSupported,
    idleSeconds: () => platform.power?.idleSeconds() ?? 0,
    // Never asked without device keys: the lock is then unsupported, so it never engages.
    unlock: async (reason) => {
      if (deviceKeys === undefined) throw new WirebenchError('app-locked', 'This host cannot ask for the device owner');
      await deviceKeys.unlock(reason);
    },
    log: (line) => {
      console.warn(line);
    },
  });
  /** Every SSH secret read waits for the app lock; the keychain's listing reads public halves and does not. */
  const sshSecretsUnlocked = (sender: Caller): GetSecret =>
    sshSecretsFor(secretStore, sshScopeOf(scopes, sender), hostState.redactor.recordSecretValue);

  const sshConnectDeps = {
    hosts: (sender: Caller) => sshScopeOf(scopes, sender).hosts,
    secretsFor: (sender: Caller) => lockedGetter(appLock, sshSecretsUnlocked(sender)),
    knownHostsFile: join(platform.paths.userData(), 'ssh-known-hosts.json'),
    agentSocket: () => (process.platform === 'win32' ? 'pageant' : process.env['SSH_AUTH_SOCK']),
  };
  /** Keys refused to a terminal or a Files tab: one `ssh.trust` prompt serves both. */
  const sshRefusals = new RefusalStore();
  const sshConnector = createSshConnector({ ...sshConnectDeps, refusals: sshRefusals });
  /** Session logs (#414): per-machine switches, and the logs under `userData/session-logs` within the size limit. */
  const sessionLogSwitches = new SessionLogSwitches(join(platform.paths.userData(), SESSION_LOG_SWITCHES_FILE));
  /** Team session logs (#430): what a recording workspace's server should hold, streamed as it is written. */
  const sessionLogUploader = new SessionLogUploader({
    client: serverClient,
    accounts: accountService,
    now: () => new Date(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    log: (message) => {
      console.warn(message);
    },
  });
  const sessionLogs = new SessionLogStore({
    root: join(platform.paths.userData(), SESSION_LOGS_DIR),
    uploader: sessionLogUploader,
    limits: () => {
      const terminal = preferencesService.get().terminal;
      return { maxBytes: terminal.sessionLogMaxMb * 1024 * 1024, raw: terminal.sessionLogRaw };
    },
    log: (message) => {
      console.warn(message);
    },
  });
  /**
   * The SSH sessions, each owned by the window that opened it; hosts and secrets resolve at connect, from
   * that window's workspace.
   */
  const sshService = new SshService({
    redactor: hostState.redactor,
    ...sshConnectDeps,
    telnet: () => areas.telnet,
    serial: () => areas.serial,
    // The serial-port binding is native and loads at the first serial connect, so a machine it does not load on
    // only loses serial consoles.
    openSerial: (options) => openSerialSession(options),
    serialDevice: (sender, hostId) => {
      const workspace = sshScopeOf(scopes, sender).workspace.openWorkspaceId();
      return workspace === undefined ? Promise.resolve(undefined) : serialDevices.get(workspace, hostId);
    },
    // Mosh hosts (#419): mosh-server is started over SSH, then the installed mosh-client runs in a pty.
    openMosh: (options) =>
      openMoshSession(
        {
          findClient: () =>
            findMoshClient({ platform: process.platform, env: process.env, home: homedir(), isExecutable }),
          load: async () => {
            const pty = await import('@lydell/node-pty');
            return pty.spawn;
          },
          lookup: async (address) => (await lookup(address)).address,
          env: () => localShellEnv(process.env),
          home: homedir(),
          platform: process.platform,
        },
        options,
      ),
    hostOsFile: join(platform.paths.userData(), 'ssh-host-os.json'),
    emit: emitEvent,
    snippets: (sender: Caller) => sshScopeOf(scopes, sender).snippets,
    refusals: sshRefusals,
    connector: sshConnector,
    // A host's autoStart forwards start with its first terminal in a window and stop with its last.
    onSessionsChange: (sender, hostId, open) => {
      forwardService.sessionsChanged(sender, hostId, open);
    },
    // Audited under the window's workspace (#355), by the reporter that owns it; it drops the event unless
    // the workspace records. The workspace is read at connect, so a session ending after a switch is credited
    // to the one it ran in.
    auditWorkspace: (sender) => scopes.get(sender.id)?.audit.workspaceId,
    audit: (event, workspaceId) => {
      const scope = scopes.all().find((candidate) => candidate.audit.workspaceId === workspaceId);
      void scope?.audit.enqueue(event, workspaceId);
    },
    sessionLog: sessionLogPlanner({
      store: sessionLogs,
      switches: sessionLogSwitches,
      workspaceOf: (sender) => {
        const workspace = sshScopeOf(scopes, sender).workspace;
        const id = workspace.openWorkspaceId();
        if (id === undefined) return undefined;
        const target = workspace.auditTarget();
        const upload = workspace.sessionLogTarget();
        return {
          id,
          ...(target ? { server: { url: target.url, recording: target.recording } } : {}),
          ...(upload ? { upload } : {}),
        };
      },
      hosts: sshConnectDeps.hosts,
    }),
  });

  /**
   * Shared terminals (#429): the owner's side taps a session's masked output and relays it through the
   * workspace's server; the viewer's side watches a teammate's. Both use `serverClient`'s TLS and proxy.
   */
  const shareConnect = (wsUrl: string): ConnectedWebSocket => {
    const options: ConnectOptions = serverConnectOptions.get(new URL(wsUrl.replace(/^ws/, 'http')).origin) ?? {};
    return connectWebSocket(wsUrl, { ...egressOption, ...options });
  };
  const terminalShareOwner = new TerminalShareOwner({
    client: serverClient,
    accounts: accountService,
    connect: shareConnect,
    target: (sender) => {
      const target = sshScopeOf(scopes, sender).workspace.auditTarget();
      return target ? { url: target.url, workspaceId: target.workspaceId } : undefined;
    },
    ssh: sshService,
    emit: (sender, state) => {
      emitEvent(sender, events.terminalShare.state, state);
    },
  });
  const terminalShareViewer = new TerminalShareViewer({
    client: serverClient,
    accounts: accountService,
    connect: shareConnect,
    emit: {
      data: (sender, event) => {
        emitEvent(sender, events.terminalShare.viewerData, event);
      },
      state: (sender, event) => {
        emitEvent(sender, events.terminalShare.viewerState, event);
      },
    },
  });
  /**
   * The local terminal tabs' shells (#410), owned per window like the SSH terminals. The pty binding is native and
   * loads at the first tab, so a machine it does not load on only loses this tab.
   */
  const localTerminals = new LocalTerminalService({
    load: async () => {
      const pty = await import('@lydell/node-pty');
      return pty.spawn;
    },
    emit: emitEvent,
    shell: () =>
      localShell({
        platform: process.platform,
        env: process.env,
        preference: preferencesService.get().terminal.localShell,
        exists: existsSync,
      }),
    cwd: (sender) => {
      const workspace = sshScopeOf(scopes, sender).workspace;
      const tree = workspace.openWorkspaceId() === undefined ? undefined : workspace.treeDir();
      return localShellCwd({ tree, userData: platform.paths.userData(), home: homedir(), platform: process.platform });
    },
    env: () => localShellEnv(process.env),
  });
  /** The Files tab's SFTP sessions, owned per window like the terminals, dialled through the same connector. */
  const sftpService = new SftpService({ connector: sshConnector, emit: emitEvent });
  /** The Files tab's copies, a queue per window over that window's own SFTP sessions. */
  const sftpTransfers = new TransferQueue({ sftp: sftpService, emit: emitEvent });
  /** Where an edited remote file's copy lives while the system editor has it; swept at start-up. */
  const sftpEditRoot = join(platform.paths.userData(), 'sftp-edit');
  /** The Files tab's edits in the system editor, uploaded on save, owned per window over its own sessions. */
  const sftpEdits = new SftpEditService({
    sftp: sftpService,
    emit: emitEvent,
    root: sftpEditRoot,
    openPath: (path) => hostShell().openPath(path),
    // Copies a crash left behind go before the first edit makes a new one.
    swept: sweepEditCopies(sftpEditRoot),
  });
  /** Port forwards, owned per window, one connection per window and host through the same connector. */
  const forwardService = new ForwardService({
    hosts: sshConnectDeps.hosts,
    connector: sshConnector,
    binds: createForwardBinds(join(platform.paths.userData(), 'ssh-forward-binds.json'), {
      report: (message) => {
        console.warn(`[forward] ${message}`);
      },
    }),
    workspaceIdOf: (sender) => sshScopeOf(scopes, sender).workspace.openWorkspaceId(),
    emit: emitEvent,
  });
  /** The keychain's SSH keys: generated and opened in main, installed over the host's current sign-in. */
  const sshKeys = new SshKeysService({
    secrets: sshSecrets,
    connector: sshConnector,
    secretsFor: sshSecretsUnlocked,
    ...(deviceKeys !== undefined ? { deviceKeys } : {}),
  });

  /** `workspace-state.json`, one queue for every window's workspace service. */
  const workspaceState = new WorkspaceState(platform.paths.userData());

  /**
   * Builds one window's own services (design D1), every callback aimed at that window alone: its
   * workspace's events, cookies, current values, team secrets and title (design D3). `sweepJoining`:
   * only the launch's first window empties `.joining/`.
   */
  function createWindowScope(target: Caller, sweepJoining: boolean): WindowScope {
    const send = <Payload extends z.ZodType>(event: IpcEvent<Payload>, payload: z.infer<Payload>): void => {
      emitEvent(target, event, payload);
    };
    const picks = new DialogPicks(appPicks);
    // Only a switch of this window's workspace (or a close) ends this window's SSH and SFTP sessions and forwards; a
    // rename or reload does not, and another window's sessions are its own workspace's.
    const endSshOnSwitch = sshAreaEndsOnSwitch(
      [sftpTransfers, sftpEdits, sshService, sftpService, forwardService, localTerminals],
      target,
    );
    // `hosts.yaml` in this window's workspace tree; dropped whenever that workspace changes (see the hooks below).
    const hosts = windowHosts(
      () => workspace.treeDir(),
      () => {
        send(events.ssh.hostsChanged, {});
      },
      () => sshDefaultsOf(preferencesService.get().ssh),
    );
    // `snippets.yaml` beside it, dropped on the same workspace switch.
    const snippets = windowSnippets(
      () => workspace.treeDir(),
      () => {
        send(events.ssh.snippetsChanged, {});
      },
    );
    const teamSecrets = new TeamSecretsService({
      store: secretStore,
      onChanged: (workspaceId, status) => {
        send(events.teamSecrets.changed, { workspaceId, status });
      },
      log: (message) => {
        console.warn(message);
      },
    });
    const teamSecretStore = new TeamSecretStore(secretStore, teamSecrets);
    // Saved encrypted with the keychain, or not at all; every change reaches the window as `cookies.changed`.
    const cookies = new CookieStore({
      userDataDir: platform.paths.userData(),
      crypto: platformSecretsBackend(platform.secrets),
      onChanged: (state) => {
        send(events.cookies.changed, state);
      },
      warn: (message) => {
        console.warn(`[cookies] ${message}`);
      },
    });
    // In memory per workspace, never written anywhere.
    const currentValues = new CurrentValuesStore((state) => {
      send(events.currentValues.changed, state);
    });
    currentValues.syncGlobals(globalProperties.get());
    const audit = new AuditReporter({
      client: serverClient,
      accounts: accountService,
      outboxes: hostState.auditOutboxes,
      now: () => new Date(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
    });
    // Both read the workspace service built below, only once something is asked of them.
    const secretSources = new SecretSourcesService({
      snapshot: () => workspace.secretSourcesSnapshot(),
      cacheSeconds: () => preferencesService.get().secrets.sourceCacheSeconds,
      onValue: hostState.redactor.recordSecretValue,
      mask: hostState.redactor.redactSecretText,
    });
    const secretScans: SecretScanSessions = new SecretScanSessions({
      host: (projectId) => workspace.hostFor(projectId),
      store: teamSecretStore,
      holdAutosave: (projectId) => workspace.hostFor(projectId).holdAutosave(),
    });
    const workspace: WorkspaceService = new WorkspaceService({
      hostState,
      userDataDir: platform.paths.userData(),
      dialogs: nativeDialogs,
      state: workspaceState,
      sweepJoining,
      features,
      machineFiles: hasFiles,
      ...egressOption,
      // One workspace, one window (design D5): the window holding it is brought forward instead.
      heldElsewhere: (workspaceId) => {
        const holder = scopes
          .all()
          .find((other) => other.id !== target.id && other.workspace.snapshot()?.id === workspaceId);
        if (holder === undefined) {
          return false;
        }
        if (!holder.caller.isClosed()) {
          embedder.windows?.bringForward(holder.caller);
        }
        return true;
      },
      // Located afresh for each shared workspace that opens, so a git installed (or picked in
      // Settings) since the last open is found without a restart.
      git: async () => {
        const location = await gitLocator();
        return location === undefined ? undefined : new GitCli(location, { hooksDir });
      },
      hooksDir,
      // A server share syncs through the same client and accounts as sign-in and the Team dialog; the
      // accounts' `ready` and `onChange` gate and resume its polling (server-sync §3.4, §5.3), and the
      // live clients turn a teammate's push or an access change into a fetch at once (live-updates §3.4).
      server: { client: serverClient, accounts: accountService, live: liveClients },
      engine: engineService,
      globals: globalProperties,
      // A project's import-time credentials (a definition's password or token ref) are resolutions too.
      secrets: { get: reporting(async (ref) => await secretStore.get(ref)) },
      ...(hasTeamSecrets ? { teamSecrets } : {}),
      preferences: preferencesService,
      picks,
      issuedTokens: issuedTokensService.source,
      history: historyService,
      currentValues,
      // A session's History entry is written by its own pending `request.openWs`, so a project (or a
      // whole workspace) closing has to ask the sockets to close *and* wait for the entries before
      // the history files go with it.
      // Only this window's: another window's sockets and sends are none of this workspace's business.
      closeWsSessions: async (projectId) => {
        const matches =
          projectId === undefined
            ? (id: string) => workspace.projectId(id) !== undefined
            : (id: string) => workspace.projectId(id) === projectId;
        exchanges.endWhere(matches, 'websocket');
        // The whole workspace is going and no other window has one open: the REST checker worker goes
        // with it (the next check starts one).
        if (
          projectId === undefined &&
          !scopes.all().some((other) => other.id !== target.id && other.workspace.snapshot() !== null)
        ) {
          void engineService.disposeRestContractChecker().catch((error: unknown) => {
            console.warn(
              '[rest] ending the contract checker failed',
              error instanceof Error ? error.message : String(error),
            );
          });
        }
        // An event stream open on a REST request is the same kind of thing: stopped here (with any other
        // REST send of the project still in flight), and its History entry — written by its own pending
        // `request.sendRest` — waited for alongside.
        exchanges.endWhere(matches, 'rest');
        // A mock goes with its project; a whole workspace closing takes every mock this window started.
        const owner = target.id;
        const stoppingMocks = mockRunner.stopWhere((entry) =>
          projectId === undefined ? entry.owner === owner : entry.projectId === projectId,
        );
        // Always awaited, never guarded by "did we just close anything": a session already asked to
        // close is not closed again, yet its pending `request.openWs` may not have written the History
        // entry. A session that closed a moment ago is therefore invisible here while its write is
        // still in flight, and skipping the wait would race it against `history.close`.
        // `whenWsSessionsRecorded` returns immediately when nothing matches, so this costs nothing.
        // Every other send through the engine — a resend, a sequence step, a multi-environment child —
        // is waited for the same way.
        await Promise.all([
          whenWsSessionsRecorded(hostState.openCalls, WS_SESSION_RECORD_TIMEOUT_MS, matches),
          whenRestSendsRecorded(hostState.openCalls, WS_SESSION_RECORD_TIMEOUT_MS, matches),
          exchanges.whenRecorded(WS_SESSION_RECORD_TIMEOUT_MS, matches),
          stoppingMocks,
        ]);
      },
      trash: trashFolder,
      // "System proxy" means whatever Chromium's own network stack means by it — including any PAC
      // file or OS setting — rather than a second, subtly different guess of our own.
      resolveSystemProxy: async (url) => await platform.proxy.resolve(url).catch(() => undefined),
      // Read lazily: the scan sessions are built against this very service.
      secretScans: {
        findings: (projectId): number => secretScans.findings(projectId),
        onChange: (listener): (() => void) => secretScans.onChange(listener),
      },
      hooks: {
        onChanged: (snapshot) => {
          send(events.workspace.changed, { workspace: snapshot });
          applyWindowTitle(target, snapshot);
          void cookies.switchTo(snapshot?.id ?? null).catch((error: unknown) => {
            console.warn('[cookies] switching jars failed', error instanceof Error ? error.message : String(error));
          });
          currentValues.syncWorkspace(snapshot);
          secretSources.noteChange();
          // This window's cached hosts.yaml was the workspace it left; only this window re-reads.
          hostsOnWorkspaceChange(areas.enabled, hosts, () => {
            send(events.ssh.hostsChanged, {});
          });
          hostsOnWorkspaceChange(areas.enabled, snippets, () => {
            send(events.ssh.snippetsChanged, {});
          });
          // A session belongs to the workspace it was opened in; its credentials were that workspace's.
          endSshOnSwitch(snapshot?.id);
        },
        onDeleted: (workspaceId) => {
          void cookies.deleteWorkspace(workspaceId).catch(() => undefined);
          currentValues.forgetWorkspace(workspaceId);
        },
        onProjectChanged: (projectId, project) => {
          secretScans.projectChanged(projectId, project);
          // A running mock follows its edits: restarted with the new definition, or stopped when removed.
          let model;
          try {
            model = project === null ? undefined : workspace.hostFor(projectId).model();
          } catch {
            model = undefined;
          }
          void mockRunner.projectChanged(projectId, model);
          currentValues.syncProject(projectId, project);
          send(events.project.changed, { projectId, project });
        },
        onProjectChangedOnDisk: (projectId, paths) => {
          send(events.project.changedOnDisk, { projectId, paths: [...paths] });
        },
        onHydration: (projectId, event) => {
          send(events.project.hydration, { projectId, ...event });
        },
        onProgress: (progress) => {
          send(events.engine.progress, progress);
        },
        onHostsFileChanged: () => {
          hostsOnFileChange(areas.enabled, hosts, () => {
            send(events.ssh.hostsChanged, {});
          });
          // An edit on disk may have changed a running forward's rule.
          void forwardService.hostsChanged(target);
        },
        onSnippetsFileChanged: () => {
          hostsOnFileChange(areas.enabled, snippets, () => {
            send(events.ssh.snippetsChanged, {});
          });
        },
        onWorkspaceChangedOnDisk: (workspaceId, paths, message) => {
          send(events.workspace.changedOnDisk, { workspaceId, paths: [...paths], message });
        },
        onSyncStatus: (workspaceId, status) => {
          send(events.sync.statusChanged, { workspaceId, status });
        },
        onSyncPulled: (event) => {
          send(events.sync.pulled, event);
        },
        onSyncConflict: (workspaceId, conflicts) => {
          send(events.sync.conflict, { workspaceId, conflicts: [...conflicts] });
        },
        onGitIdentityNeeded: (workspaceId) => {
          send(events.git.identityNeeded, { workspaceId });
        },
        onAuditTarget: (auditTarget, fetched) => {
          audit.setTarget(auditTarget);
          // A fetch went through with this account's token: it is signed in, and the queue goes out now,
          // at the pace of any back-off already under way.
          if (auditTarget !== undefined && fetched) {
            void audit.afterFetch();
          }
        },
      },
    });
    return {
      caller: target,
      id: target.id,
      picks,
      cookies,
      currentValues,
      secretSources,
      teamSecrets,
      teamSecretStore,
      secretScans,
      audit,
      workspace,
      hosts,
      snippets,
      ready: Promise.resolve(),
      auditSignedIn: false,
      closing: undefined,
      releaseClosed: () => undefined,
    };
  }

  // The switches come from the preferences file, so it is read before anything registers a kind.
  const startupPreferences = await preferencesService.load();
  // Plugins load once, from the app's own data folder (ADR-0031), before the registry is built.
  plugins = loadDesktopPlugins({
    userData: platform.paths.userData(),
    off: startupPreferences.features['plugins'] === false,
    network: (url) => mainHttpOptions(url, mainHttpDeps),
  });
  features = startupFeatures({
    preferences: startupPreferences,
    env,
    isPackaged: platform.app.packaged(),
    ...(plugins.host !== undefined ? { plugins: plugins.host } : {}),
  });
  // The managed policy (read by the load above) may switch an area off (#360); it beats the environment.
  areas = resolveAreas({ policy: preferencesService.policy().areasOff, env, capabilities: platform.capabilities });

  // A platform with no power events has no resume to forward, no screen lock and no idle time to lock on.
  const power = platform.power;
  const stopResume =
    power === undefined
      ? undefined
      : forwardResume(power, () => {
          broadcast(events.ssh.resumed, {});
        });
  // The app lock locks again when the machine does, and after the idle time (#428).
  const stopLock = power?.onLock(() => {
    appLock.lock();
  });
  const appLockTimer =
    power === undefined
      ? undefined
      : setInterval(() => {
          appLock.tick();
        }, 30_000).unref();

  // Created once, up front, so it exists before any sync operation can start (see `hooksDir`).
  mkdirSync(hooksDir, { recursive: true });

  const updates = embedder.updates?.({
    report: (status) => {
      broadcast(events.app.updateStatus, { status });
    },
    channel: () => preferencesService.get().updates.channel,
  });
  // Every channel's handler goes into this one table; a transport (`bindIpc`) serves it once all are in.
  // A host with a root holds every caller-named path inside it (`path-access.ts`).
  const root = platform.paths.root?.();
  const handlerTable = new HandlerTable(hostState.redactor, root !== undefined ? { root } : {});
  registerKerberosChannels(handlerTable);
  registerAppChannels(
    handlerTable,
    { app: platform.app, ...(embedder.menu !== undefined ? { menu: embedder.menu } : {}) },
    updates === undefined ? undefined : async () => await updates.check({ trigger: 'user' }),
    // New Window (design D7) opens at the picker.
    () => {
      embedder.windows?.open();
    },
    areas.enabled,
    {
      kinds: () => workspaceService.enabledKinds(),
      features: () => workspaceService.enabledFeatures(),
      states: () => workspaceService.featureStates(),
    },
    areas.localTerminal,
    areas.telnet,
    areas.serial,
    () => areas.states.map(toFeatureStateWire),
  );
  // The calling window's open projects' folders: the containment roots a renderer-named import path may sit in.
  const openProjectDirs = (): readonly string[] =>
    workspaceService
      .hosts()
      .map((host) => host.snapshot()?.dir)
      .filter((dir): dir is string => dir !== undefined);
  // Request scripts (#63): one sandbox and one checker for the app, started on first use.
  const scripts = new ScriptHost({
    redactor: hostState.redactor,
    modelOf: (entityId) =>
      workspaceService.projectId(entityId) === undefined ? undefined : workspaceService.hostOfEntity(entityId).model(),
    openApiDocumentFor: async (apiId) =>
      await workspaceService.hostOfEntity(apiId).kind('rest').openApiDocumentFor(apiId),
    grpcProtoSetFor: async (apiId) => await workspaceService.grpcProtoSetFor(apiId),
    soapDefinitionFor: (interfaceId) => engineService.resultFor(interfaceId),
    onValuesChanged: (projectId) => {
      emitToCaller(events.script.valuesChanged, { projectId });
    },
  });
  registerScriptChannels(handlerTable, scripts, (projectId, ownerId) =>
    workspaceService.hostFor(projectId).proposeConversions(ownerId),
  );
  // This machine's MCP stdio approvals (#79); a send with no window of its own asks in the focused one.
  // A host that may not start processes refuses every stdio command before anything is asked (§3.10).
  const mcpApprovals = new McpApprovals({
    store: new McpApprovalStore(join(platform.paths.userData(), MCP_APPROVALS_FILE)),
    ...(platform.capabilities.has('processes') ? {} : { processes: false as const }),
    defaultWindow: () => {
      const focused = embedder.windows?.focused();
      const window =
        (focused !== undefined && scopes.get(focused.id) !== undefined ? focused : undefined) ??
        scopes.all()[0]?.caller;
      return window === undefined ? undefined : promptWindowOf(window);
    },
  });
  const requestDeps: RequestChannelDeps = {
    hostState,
    project: workspaceService,
    extensions: () => workspaceService.extensions(),
    mcpApprovals,
    secretSources: () => workspaceService.secretSourcesSnapshot(),
    adHocScopes: () => {
      const state = globalProperties.get();
      const global = overlayCurrent(
        enabledProperties(state.properties, state.disabled),
        currentValues.overlaysFor(undefined).global,
      );
      return { project: {}, global, system: hostState.systemValues };
    },
    showSecrets: showSecretsFlag,
    cookies: () => cookieStore.host(),
    history: historyService,
    onHistoryAppended: (entry) => {
      emitToCaller(events.history.appended, { entry });
    },
    onSendFailed: (failure) => {
      emitToCaller(events.exchange.failed, { failure });
    },
    onExchange: (entry) => {
      emitToCaller(events.exchange.logged, { entry });
    },
    preferences: preferencesService,
    dialogPicks,
    oauth2: oauth2Service,
    issuedTokens: issuedTokensService,
    getSecret: secretsFor(undefined),
    storeSecret: (value, label) => secretStore.set(value, { label }),
    secretsFor,
    // Names only: the store's labels for this project's `${secret:name}` tokens (#340).
    secretNamesFor: async (projectId) => {
      const prefix = secretStoreLabel(projectId ?? '', '');
      return (await secretStore.list())
        .map((entry) => entry.label)
        .filter((label): label is string => label?.startsWith(prefix) === true)
        .map((label) => label.slice(prefix.length));
    },
    scripts,
    registry: exchanges,
    // Queued to the outbox of the window whose workspace it happened in; that reporter drops it unless
    // the workspace records. A run that ends after its workspace closed is credited to no window.
    audit: (event, workspaceId) => {
      const scope = scopes.all().find((candidate) => candidate.audit.workspaceId === workspaceId);
      void scope?.audit.enqueue(event, workspaceId);
    },
    auditWorkspace: () => scopes.callerOrOnly()?.audit.workspaceId,
    confirmProtected: nativeDialogs.confirmProtected,
    ...egressOption,
    ...(embedder.sendOrigin !== undefined ? { sendOrigin: embedder.sendOrigin } : {}),
  };
  registerRequestChannels(handlerTable, engineService, requestDeps);
  /** The window whose workspace holds `projectId`. */
  const scopeOfProject = (projectId: string): WindowScope | undefined =>
    scopes.find((candidate) => candidate.workspace.projectId(projectId) !== undefined);
  registerSendRouteChannels(
    handlerTable,
    requestDeps,
    embedder.sendOrigin !== 'server'
      ? undefined
      : {
          send: toSendDeps(engineService, requestDeps),
          // The platform's own egress rule decides whether a private target is the server's to send.
          ...egressOption,
          pins: new RoutePins(routePinsPath(platform.paths.userData())),
          secretSourceNames: (projectId) => scopeOfProject(projectId)?.secretSources.mappedNames() ?? [],
          // A team secret is one the workspace's vault holds a value for; the server can open none of them.
          isTeamSecret: async (projectId, name) => {
            const scope = scopeOfProject(projectId);
            if (scope === undefined) return false;
            const id = vaultEntryId({ token: { projectId, name } });
            try {
              await access(join(scope.workspace.treeDir(), `${TEAM_SECRETS_VALUES_DIR}/${id}.yaml`));
              return true;
            } catch {
              return false;
            }
          },
          serverSecretNames: async (projectId) => (await requestDeps.secretNamesFor?.(projectId)) ?? [],
          // The browser knows a workspace by its server id, and pins it by that id.
          workspaceIdOf: (projectId) => scopeOfProject(projectId)?.workspace.serverWorkspaceId(),
          serverWorkspaceId: (projectId) => scopeOfProject(projectId)?.workspace.serverWorkspaceId(),
          teamSecretsDir: (projectId) => {
            const scope = scopeOfProject(projectId);
            return scope === undefined ? undefined : join(scope.workspace.treeDir(), TEAM_SECRETS_DIR);
          },
        },
  );
  registerMockChannels(handlerTable, mockRunner, {
    locate: (mockId) => {
      const projectId = workspaceService.projectId(mockId);
      const saved = workspaceService.hostOfEntity(mockId).savedProject();
      if (projectId === undefined || saved === undefined) {
        throw new WirebenchError('mock-not-found', `No open project has the mock ${mockId}`, { details: { mockId } });
      }
      return { projectId, project: saved.project, dir: saved.dir };
    },
    host: () => (preferencesService.get().mocks.listenOnAllInterfaces ? MOCK_ALL_INTERFACES_HOST : MOCK_LOOPBACK_HOST),
    owns: (mockId) => workspaceService.projectId(mockId) !== undefined,
  });
  // A sequence's steps go through the engine as a single send does, with the same dependencies.
  registerSequenceChannels(
    handlerTable,
    new SequenceRunner(),
    {
      service: engineService,
      requests: requestDeps,
      modelOf: (entityId) => workspaceService.hostOfEntity(entityId).model(),
      emit: (event) => {
        emitToCaller(events.sequence.progress, event);
      },
      emitWaiting: (event) => {
        emitToCaller(events.sequence.waiting, event);
      },
      // Read per run: the workspace, its link and the account can all change between runs.
      captures: () =>
        desktopCaptureSource(
          { client: serverClient, accounts: accountService },
          linkedServerOf(workspaceService.snapshot()),
        ),
    },
    (feature) => workspaceService.requireFeature(feature),
  );
  // The Runner sends as a sequence does; its settings and runs live under user data, not the project.
  registerRunnerChannels(
    handlerTable,
    new RunnerService({
      service: engineService,
      requests: requestDeps,
      modelOf: (entityId) => workspaceService.hostOfEntity(entityId).model(),
      settings: new RunnerSettingsStore(platform.paths.userData()),
      history: new RunnerHistoryStore(platform.paths.userData()),
      emit: (event) => {
        emitToCaller(events.runner.progress, event);
      },
      captures: () =>
        desktopCaptureSource(
          { client: serverClient, accounts: accountService },
          linkedServerOf(workspaceService.snapshot()),
        ),
    }),
    dialogPicks,
    nativeDialogs,
  );
  registerOAuth2Channels(handlerTable, {
    oauth2: oauth2Service,
    project: workspaceService,
    getSecret: secretsFor(undefined),
    // A refresh token replaces the value the configuration's own reference already names; a new
    // reference is never minted here, because the project file would then have to change to match.
    setSecret: async (ref, value) => {
      await secretStore.replace(ref, value);
    },
    showSecrets: showSecretsFlag,
  });
  registerIssuedTokenChannels(handlerTable, { issuedTokens: issuedTokensService, showSecrets: showSecretsFlag });
  registerAccountChannels(handlerTable, { accounts: accountService });
  registerTeamChannels(handlerTable, {
    client: serverClient,
    accounts: accountService,
    requireFeature: (feature) => workspaceService.requireFeature(feature),
  });
  registerCiTokenChannels(handlerTable, { client: serverClient, accounts: accountService });
  registerLicenseChannels(handlerTable, { client: serverClient, accounts: accountService });
  registerProvisioningChannels(handlerTable, { client: serverClient, accounts: accountService });
  registerAuditChannels(handlerTable, {
    client: serverClient,
    accounts: accountService,
    picks: dialogPicks,
    dialogs: nativeDialogs,
  });
  registerHooksChannels(handlerTable, { hooks: hooksService });
  registerSchedulesChannels(handlerTable, {
    schedules: schedulesService,
    modelOf: (entityId) => workspaceService.hostOfEntity(entityId).model(),
    registryOf: (entityId) => workspaceService.hostOfEntity(entityId).runContextFor(entityId)?.registry,
    environmentsOf: (projectId) => workspaceService.hostOfEntity(projectId).sendEnvironments().environments,
  });
  accountService.onChange((servers) => broadcast(events.account.changed, { servers: servers.map(toAccountWire) }));
  // Signing in to a window's workspace's server sends what its audit outbox kept while signed out.
  accountService.onChange((servers) => {
    for (const scope of scopes.all()) {
      const signedIn = auditSignedInFor(scope, servers);
      if (signedIn && !scope.auditSignedIn) {
        void scope.audit.onSignedIn();
      }
      scope.auditSignedIn = signedIn;
    }
  });
  // One `GET /me` per signed-in account at launch, so a token revoked while the app was closed
  // shows as signed out now rather than on the first action; no account, no call (§3.8).
  void accountService
    .load()
    .then(() => accountService.refreshAll())
    // A launch-time failure here (a corrupt accounts file, a keychain error) must not surface as
    // an unhandled rejection; accountService already reports per-account sign-in state via
    // onChange, so there is nothing further to log and never a token to log.
    .catch(() => {});
  // A resend is a send like any other: the request channels' dependencies, scripts and registry.
  const historyDeps: HistoryChannelDeps = {
    project: workspaceService,
    send: toSendDeps(engineService, requestDeps),
    // One window's History is its own workspace's projects (another window may have others open).
    projectIds: () =>
      scopes
        .callerOrOnly()
        ?.workspace.hosts()
        .flatMap((host) => {
          const id = host.snapshot()?.id;
          return id === undefined ? [] : [id];
        }),
  };
  registerHistoryChannels(handlerTable, historyService, historyDeps);
  registerProjectChannels(handlerTable, {
    router: workspaceService,
    addProject: async (name) => await workspaceService.addProject(name),
    removeProject: async (projectId, options) => {
      // A closed project's session values go with it.
      scripts.clearValues(projectId);
      return await workspaceService.removeProject(projectId, options);
    },
    projectDirs: openProjectDirs,
    picks: dialogPicks,
    ensureWorkspaceEnvironments: async (names, projectId) =>
      await workspaceService.ensureEnvironments(names, projectId),
    apiMove: {
      hosts: (apiId, targetProjectId) => {
        const source = workspaceService.hostOfEntity(apiId);
        return {
          sourceProjectId: source.require().project.id,
          source,
          target: workspaceService.hostFor(targetProjectId),
        };
      },
      secrets: secretStore,
    },
  });
  /** A Globals change, told to every window and to every window's current-values overlay. */
  const onGlobalsChanged = (state: ReturnType<GlobalProperties['get']>): void => {
    broadcast(events.globals.changed, state);
    for (const scope of scopes.all()) {
      scope.currentValues.syncGlobals(state);
    }
  };
  const apiDeps: ApiChannelDeps = {
    router: workspaceService,
    importers: () => workspaceService.extensions().importers,
    imports: openApiImports,
    asyncApiImports: openApiImports,
    protoImports,
    addProject: async (name) => await workspaceService.addProject(name),
    removeProject: async (projectId, options) => {
      // A closed project's session values go with it.
      scripts.clearValues(projectId);
      return await workspaceService.removeProject(projectId, options);
    },
    projectDirs: openProjectDirs,
    picks: dialogPicks,
    dialogs: nativeDialogs,
    history: historyService,
    onHistoryChanged: (projectId) => broadcast(events.history.changed, { projectId }),
    // Every read goes to the live workspace, so a second environment of the same name in one
    // import sees the first one and is given a free name.
    variablesPorts: (projectId) => ({
      workspace: {
        environmentNames: () =>
          (workspaceService.snapshot()?.environments ?? []).map((environment) => environment.name),
        addEnvironment: async (name, properties, disabled, color) => {
          const { createdEnvironmentId } = await workspaceService.mutate({ kind: 'add-workspace-environment', name });
          if (createdEnvironmentId === undefined) {
            throw new WirebenchError('import-failed', `Could not add the environment "${name}"`);
          }
          try {
            await workspaceService.mutate({
              kind: 'update-workspace-environment',
              environmentId: createdEnvironmentId,
              patch: { properties, disabled: [...disabled], ...(color !== undefined ? { color } : {}) },
            });
          } catch (error) {
            // Adding is two saves: do not leave the empty environment of the first behind.
            await workspaceService
              .mutate({ kind: 'remove-workspace-environment', environmentId: createdEnvironmentId })
              .catch(() => undefined);
            throw error;
          }
        },
        removeEnvironment: async (name) => {
          const environment = workspaceService.snapshot()?.environments.find((candidate) => candidate.name === name);
          if (environment === undefined) return;
          await workspaceService.mutate({ kind: 'remove-workspace-environment', environmentId: environment.id });
        },
        propertyNames: () => Object.keys(workspaceService.snapshot()?.properties ?? {}),
        mergeProperties: async (properties, disabled) => {
          for (const [name, value] of Object.entries(properties)) {
            await workspaceService.mutate({ kind: 'set-workspace-property', name, value });
          }
          for (const name of disabled) {
            await workspaceService.mutate({ kind: 'set-workspace-property-enabled', name, enabled: false });
          }
        },
      },
      globals: {
        get: () => globalProperties.get(),
        merge: async (properties, disabled) => {
          let state = await globalProperties.replaceAll({ ...globalProperties.get().properties, ...properties });
          for (const name of disabled) {
            state = await globalProperties.setEnabled(name, false);
          }
          onGlobalsChanged(state);
        },
      },
      ...(projectId !== undefined
        ? {
            project: {
              propertyNames: () => Object.keys(workspaceService.hostFor(projectId).model()?.properties ?? {}),
              merge: async (properties, disabled) => {
                await workspaceService.importProperties(projectId, properties, disabled);
              },
            },
          }
        : {}),
      secrets: teamSecretStore,
    }),
  };
  registerApiChannels(handlerTable, apiDeps);
  registerWorkspaceChannels(handlerTable, {
    service: workspaceService,
    suggestions: async () => await readLeftoverProjectFolders(platform.paths.userData()),
    // The calling window's reopen of the last workspace (see `openWindow`).
    ready: () => scopes.callerOrOnly()?.ready ?? Promise.resolve(),
    reveal: (dir) => {
      hostShell().reveal(dir);
    },
  });
  registerGlobalsChannels(handlerTable, globalProperties, onGlobalsChanged);
  registerCurrentValuesChannels(handlerTable, currentValues);
  registerCookiesChannels(handlerTable, cookieStore);
  let sshDefaultsSent = JSON.stringify(preferencesService.get().ssh);
  registerPreferencesChannels(handlerTable, preferencesService, (preferences) => {
    broadcast(events.preferences.changed, { preferences });
    // Preferences → SSH is the hosts' last level (#571): every window's resolved hosts change with it.
    const sshDefaults = JSON.stringify(preferences.ssh);
    if (sshDefaults !== sshDefaultsSent) {
      sshDefaultsSent = sshDefaults;
      broadcast(events.ssh.hostsChanged, {});
    }
    // Turning autosave on mid-session must pick up whatever is already outstanding, rather than
    // waiting for one more edit to arm the timer.
    if (preferences.editor.autosave) {
      for (const scope of scopes.all()) {
        for (const host of scope.workspace.hosts()) {
          host.onAutosaveEnabled();
        }
      }
    }
  });
  registerAppLockChannels(handlerTable, {
    preferences: preferencesService,
    lock: appLock,
    // No reason: the renderer says what the app lock needs, and there is nothing to add to it.
    support: { supported: appLockSupported },
    onChanged: (preferences) => {
      broadcast(events.preferences.changed, { preferences });
    },
  });
  // Settings picks are the app's: preferences apply to every window (design D4).
  registerSslChannels(handlerTable, {
    preferences: preferencesService,
    picks: appPicks,
    platform,
    onChanged: (preferences) => {
      broadcast(events.preferences.changed, { preferences });
    },
  });
  // Git runs on the machine's own files: a host without them has no git.
  if (hasFiles) {
    registerGitChannels(handlerTable, {
      preferences: preferencesService,
      picks: appPicks,
      dialogs: nativeDialogs,
      // `git.detect` uses exactly `gitLocator`'s precedence (e2e override, then a marked
      // `git.path`, then discovery) — no configured-path logic of its own, so a marked preference
      // can never bypass the e2e "no git" override. `git.locate` keeps probing the picked file
      // directly (its own explicit candidate) via the default `findGit`.
      locate: gitLocator,
      onChanged: (preferences) => {
        broadcast(events.preferences.changed, { preferences });
      },
    });
  }
  registerSyncChannels(handlerTable, {
    service: workspaceService,
    reveal: (path) => {
      hostShell().reveal(path);
    },
  });
  registerThemeChannels(
    handlerTable,
    (payload) => {
      broadcast(events.theme.changed, payload);
    },
    platform.app,
  );
  // Channels that do nothing but open a native dialog exist only on a platform that has them.
  if (platform.dialogs !== undefined) {
    registerDialogsChannels(handlerTable, dialogPicks, nativeDialogs);
  }
  registerPluginChannels(handlerTable, { plugins: () => plugins, picks: dialogPicks });
  if (platform.dialogs !== undefined && hasFiles) {
    registerFsChannels(handlerTable, platform);
  }
  // A kind that is off registers no channels: a call to one is refused as an unknown channel.
  for (const kind of MAIN_KINDS.filter((candidate) => features.enabledKinds.includes(candidate.kind))) {
    kind.registerChannels(handlerTable, {
      engine: engineService,
      request: requestDeps,
      api: apiDeps,
      history: historyService,
      historyDeps,
      router: workspaceService,
      picks: dialogPicks,
      projectDirs: openProjectDirs,
      userDataDir: platform.paths.userData(),
      dialogs: nativeDialogs,
      platform,
      // Mirrors `dialogs.saveFile`, including its e2e override: a Playwright run cannot drive a
      // native Save-as panel, so the same env var short-circuits both.
      showSaveHtml: async (options) => {
        const override = nativeDialogs.saveOverride();
        if (override !== undefined) {
          return override;
        }
        const result = await requireCapability(platform, 'dialogs').saveFile(undefined, {
          title: options.title,
          defaultPath: options.defaultPath,
          filters: [{ name: 'HTML', extensions: ['html'] }],
        });
        return result.canceled ? undefined : result.filePath;
      },
    });
  }
  registerSearchChannels(handlerTable, engineService, workspaceService);
  registerSecretsChannels(handlerTable, teamSecretStore, showSecretsFlag);
  // A secret source is a command or a file on the machine (spec D6): only a host with both has them.
  if (hasSecretSources) {
    registerSecretSourcesChannels(handlerTable, workspaceService, secretSources);
  }
  registerTeamSecretsChannels(
    handlerTable,
    teamSecrets,
    (feature) => workspaceService.requireFeature(feature),
    hasTeamSecrets,
  );
  registerSecretScanChannels(handlerTable, secretScans);
  registerSnapshotChannels(
    handlerTable,
    new SnapshotStore((requestId) => {
      const projectId = workspaceService.projectId(requestId);
      if (projectId === undefined) {
        return undefined;
      }
      // `projectId` never throws; a stale index entry (no host for it) reads as unsaved, not an error.
      try {
        return workspaceService.hostFor(projectId).savedProject();
      } catch {
        return undefined;
      }
    }),
  );
  registerExchangeChannels(handlerTable, engineService.exchanges, showSecretsFlag, platform);
  registerLogChannels(handlerTable, {
    showSecrets: showSecretsFlag,
    service: engineService,
    request: requestDeps,
    picks: dialogPicks,
    dialogs: nativeDialogs,
    appVersion: platform.app.version(),
  });
  registerKeystoreChannels(handlerTable, { project: workspaceService, picks: dialogPicks, platform });
  registerCertificateChannels(handlerTable, { project: workspaceService, preferences: preferencesService });
  registerEnabledAreaChannels(handlerTable, areas.enabled, {
    hosts: hostsService,
    secrets: sshSecrets,
    ssh: sshService,
    sftp: sftpService,
    snippets: snippetsService,
    layouts: {
      layouts: new LayoutStore(join(platform.paths.userData(), LAYOUTS_FILE)),
      workspaceId: () => scopes.callerOrOnly()?.workspace.openWorkspaceId(),
    },
    transfers: sftpTransfers,
    edits: sftpEdits,
    forward: forwardService,
    serial: {
      ports: () => listSerialPorts(),
      devices: serialDevices,
      workspaceOf: (sender) => sshScopeOf(scopes, sender).workspace.openWorkspaceId(),
    },
    sessionLogs: {
      logs: sessionLogs,
      switches: sessionLogSwitches,
      workspaceOf: (sender) => sshScopeOf(scopes, sender).workspace.openWorkspaceId(),
      teamRecords: (sender) => sshScopeOf(scopes, sender).workspace.sessionLogTarget() !== undefined,
      team: {
        serverOf: (sender) => {
          const target = sshScopeOf(scopes, sender).workspace.auditTarget();
          return target ? { url: target.url, workspaceId: target.workspaceId } : undefined;
        },
        client: serverClient,
        accounts: accountService,
      },
      reveal: (path) => {
        hostShell().reveal(path);
      },
    },
    terminalShares: { owner: terminalShareOwner, viewer: terminalShareViewer },
    keys: sshKeys,
    localTerminal: areas.localTerminal ? localTerminals : undefined,
    importer: new SshImportService<Caller>({
      home: () => homedir(),
      pick: (sender, options) => nativeDialogs.pickFile(sender, dialogPicks, options),
      hosts: hostsService,
      secrets: sshSecrets,
    }),
    knownHostsImporter: new KnownHostsImportService<Caller>({
      home: () => homedir(),
      pick: (sender) => nativeDialogs.pickFile(sender, dialogPicks, { title: 'Choose a known_hosts file' }),
      hosts: hostsService,
      store: sshService,
    }),
  });
  // Last session's decrypted attachment copies are disposable; sweep them off the disk without
  // making the first window wait on it.
  void clearAttachmentsTmp(platform.paths.userData());
  // A lowered size limit, or logs from before a crash, are brought under the limit; prune never throws.
  void sessionLogs.prune();
  // Logs an earlier run left half sent go on streaming; one cut off by a crash ends as lost.
  void sessionLogUploader.resume(join(platform.paths.userData(), SESSION_LOGS_DIR));
  // Warms the in-memory map so the first send does not have to wait on a disk read, and corrects
  // any early `globals.get` subscriber that raced ahead of the load with the on-disk properties.
  void globalProperties.load().then(
    (state) => {
      broadcast(events.globals.changed, state);
      // The committed globals a global current value needs, once the file has been read.
      for (const scope of scopes.all()) {
        scope.currentValues.syncGlobals(state);
      }
    },
    (error: unknown) => {
      // A globals file this build refuses (one stamped with a newer format version) must not
      // take the app down with it: the store keeps rejecting every read and write, so the file
      // stays untouched, and there is simply no global scope this session.
      console.error('Global properties could not be loaded', error);
    },
  );
  // Same warm-up for preferences: the send path reads them synchronously, and any renderer that
  // asked before the load finished is corrected by the broadcast.
  void preferencesService.load().then((preferences) => {
    // A CA bundle *main itself picked* in an earlier session becomes a read pick again here —
    // and only one carrying the `caBundlePickedByMain` marker, so a hand-edited preferences
    // file cannot smuggle a path into the read-pick set. It has to happen after the load
    // resolves: before it, the in-memory document is still the defaults.
    rememberPickedCaBundle(preferences, appPicks);
    // Same evidence, same reason, for a git executable main itself picked (`git.pathPickedByMain`).
    rememberPickedGit(preferences, appPicks);
    const policy = preferencesService.policy();
    if (policy.error !== undefined) {
      console.error(`Managed-preferences policy ${policy.path} not applied: ${policy.error}`);
    }
    if (policy.ignored.length > 0) {
      console.warn(`Managed-preferences policy ${policy.path} ignores: ${policy.ignored.join(', ')}`);
    }
    broadcast(events.preferences.changed, { preferences: toPreferencesWire(preferences) });
  });

  /** Whether a caller has been attached yet: only the first sweeps `.joining/` and runs the launch's update check. */
  let attachedOne = false;

  /**
   * Gives a caller (a window) its own services (design D1, D6). `reopenLast` reopens the last workspace, as
   * the launch's first window does; New Window opens at the picker. Its scope goes when the caller closes.
   */
  function attach(caller: Caller, attachOptions: AttachOptions = {}): void {
    const first = !attachedOne;
    const scope = createWindowScope(caller, first);
    attachedOne = true;
    scopes.add(scope.id, scope);
    if (attachOptions.reopenLast === true) {
      // It waits for preferences (every host folds them into its send defaults, and a workspace
      // opened before the load would hold the defaults), and a workspace that will not open is not
      // an error the app dies of: the picker shows `lastError()`. `workspace.snapshot`/`list` wait on
      // it, so the renderer's first answer is already the reopened workspace (or the picker with its
      // error), never a flash of both.
      scope.ready = preferencesService.ready().then(async () => {
        await scope.workspace.openLast().catch(() => null);
      });
    }
    applyWindowTitle(caller, null);
    scope.releaseClosed = caller.onClosed(() => {
      if (scopes.get(scope.id) === scope) {
        scopes.remove(scope.id);
      }
    });
    if (first) {
      // Opt-in, and only after the preferences are actually loaded — the default is off, so a
      // check that ran before the load would read "off" for every user who turned it on.
      void scope.ready.then(async () => {
        await updates?.checkOnLaunch(() => preferencesService.get().updates.checkOnLaunch);
      });
    }
  }

  /** Runs a caller's quit path (`closeWindowScope`), then drops its scope; resolves at once for one never attached. */
  async function detach(callerId: number): Promise<void> {
    const scope = scopes.get(callerId);
    if (scope === undefined) {
      return;
    }
    await closeWindowScope(scope);
    if (scopes.get(callerId) === scope) {
      scopes.remove(callerId);
    }
  }

  /**
   * The quit path for one window (design D6): it hands over its staged request edits (briefly — a hung
   * window cannot hold the close), then its workspace closes, recording every open project's unsaved
   * state, and its cookie jar and audit reporter wind down. Runs once per window.
   */
  function closeWindowScope(scope: WindowScope): Promise<void> {
    scope.releaseClosed();
    scope.closing ??= (async () => {
      if (!scope.caller.isClosed()) {
        const stashed = scope.workspace.nextDraftsStash(QUIT_DRAFTS_TIMEOUT_MS);
        emitEvent(scope.caller, events.workspace.flushDrafts, {});
        await stashed.catch(() => undefined);
      }
      // Its timers must not hold up the close; what is queued stays in the outbox for the next open.
      scope.audit.dispose();
      try {
        await scope.workspace.close();
      } finally {
        // Cookies with an expiry still waiting on the debounce are written before the window goes,
        // even when closing the workspace failed.
        await scope.cookies.flush().catch(() => undefined);
        scope.cookies.dispose();
        scope.workspace.dispose();
      }
    })().catch(() => undefined);
    return scope.closing;
  }

  /**
   * The app's quit path, minus the quit itself: every long-lived thing ends without holding it up, then
   * every window runs its own quit path (`closeWindowScope`) at once. Never rejects.
   */
  async function shutdown(): Promise<void> {
    stopResume?.();
    stopLock?.();
    if (appLockTimer !== undefined) {
      clearInterval(appLockTimer);
    }
    // Asked to close here so the sockets are already closing while the drafts are stashed; the
    // *waiting* — for each session's History entry, written by its own pending `request.openWs` —
    // happens inside each workspace's `close()`, which owns the history files. Guarded: a
    // failure to close a socket must never be the reason the app fails to quit.
    try {
      exchanges.endWhere(() => true, 'websocket');
    } catch (error) {
      console.warn('[ws] closeAllWs on quit failed', error instanceof Error ? error.message : String(error));
    }
    // The catch URL views and their subscriptions go first; nothing of them outlives the process.
    hooksService.dispose();
    schedulesService.dispose();
    // SSH sessions end with the app; closing never throws or waits.
    terminalShareOwner.disposeAll();
    terminalShareViewer.disposeAll();
    sshService.disposeAll();
    sftpTransfers.disposeAll();
    // The copies go with their edits; not awaited, and start-up sweeps whatever a quit leaves.
    void sftpEdits.disposeAll();
    sftpService.disposeAll();
    // Forward listeners close with the app; not awaited, so a socket that will not close never holds up the quit.
    void forwardService.disposeAll();
    // A mock's port is released now; not awaited, so a server that will not close never holds up the quit.
    void mockRunner.stopAll().catch((error: unknown) => {
      console.warn('[mock] stopping the mocks on quit failed', error instanceof Error ? error.message : String(error));
    });
    // The live sockets close 1000, so the server drops this device from presence now rather than at
    // its next heartbeat (live-updates §3.4). Not awaited: a socket that will not close must never
    // hold up the quit.
    void liveClients.closeAll().catch((error: unknown) => {
      console.warn(
        '[live] closing the live sockets on quit failed',
        error instanceof Error ? error.message : String(error),
      );
    });
    try {
      exchanges.endWhere(() => true, 'rest');
    } catch (error) {
      console.warn('[rest] aborting streams on quit failed', error instanceof Error ? error.message : String(error));
    }
    // Nor may the script sandbox's and checker's.
    void scripts.dispose().catch((error: unknown) => {
      console.warn(
        '[script] ending the script workers on quit failed',
        error instanceof Error ? error.message : String(error),
      );
    });
    // The REST contract checker's worker thread must not keep the process alive past quit.
    void engineService.disposeRestContractChecker().catch((error: unknown) => {
      console.warn(
        '[rest] ending the contract checker on quit failed',
        error instanceof Error ? error.message : String(error),
      );
    });
    await Promise.all(scopes.all().map(async (scope) => await closeWindowScope(scope))).catch(() => undefined);
  }

  /** The agent's sends in flight: apart from the windows', so neither cancels the other's. */
  const detachedExchanges = new ExchangeRegistry();
  const detachedSend = (input: SendFromDirectoryInput): Promise<DetachedSendResult> =>
    sendFromDirectory(
      {
        hostState,
        preferences: preferencesService,
        confirmProtected: nativeDialogs.confirmProtected,
        ...egressOption,
        // The agent's own namespace of the store, by label; never a project's `${secret:…}` entries.
        agentSecret: async (label) => {
          const ref = await secretStore.findByLabel(label);
          return ref === undefined ? undefined : await secretStore.get(ref);
        },
        report: reporting,
        // This machine's proxy, as its Settings name it. Its password is read for the proxy alone: the ref
        // the preference names, never anything a bundle's `${secret:…}` refs could reach.
        proxyFor: async (url) => {
          const { proxy } = preferencesService.get();
          return await resolveProxy({
            url,
            proxy,
            getSecret: async (ref) => {
              if (ref !== proxy.passwordRef) return undefined;
              const password = await reporting(async (one) => await secretStore.get(one))(ref);
              // An error naming the proxy's URL must not carry its password.
              if (password !== undefined) hostState.redactor.recordSecretValue(password);
              return password;
            },
            resolveSystemProxy: async (target) => await platform.proxy.resolve(target).catch(() => undefined),
          });
        },
        // A send's own engine: a bundle's definitions never replace the ones a window has loaded.
        engine: (getSecret) => new EngineService(getSecret, (url) => mainHttpOptions(url, mainHttpDeps)),
        // No workspace, globals, current values or picks: a bundle carries the values it is sent with.
        // On the send's own view of the host state: its `${#System#…}` scope is the send's, never this process's.
        projectHost: (engine, getSecret, sendState) =>
          new ProjectHost(
            engine,
            {
              hostState: sendState,
              ...egressOption,
              enabledKinds: features.enabledKinds,
              ...(features.registry !== undefined ? { registry: features.registry } : {}),
            },
            undefined,
            undefined,
            { get: getSecret },
            preferencesService,
            undefined,
            async (url) => await platform.proxy.resolve(url).catch(() => undefined),
          ),
        scripts,
        registry: detachedExchanges,
      },
      input,
    );

  return { handlers: handlerTable, attach, detach, shutdown, sendFromDirectory: detachedSend };
}
