/**
 * One send of a project that no window has open (hosted edition spec §18.4): a local agent writes a
 * send bundle to a folder of its own and asks the host to send one item of it, through `sendThroughEngine`,
 * over a {@link ProjectHost} and an engine service of its own.
 *
 * Its dependencies are listed here one by one, never taken from a window's: the host's redactor, its
 * preferences and its protected-environment question, and nothing else of the host's. In particular:
 *
 * - Its secrets are the agent's own: a `${secret:name}` the bundle declares, read from the store under
 *   `agent:<pairingId>:<workspaceId>:<name>` (or from the team-secrets hook). The desktop's project secrets,
 *   secret sources and team secrets are never consulted, whatever project id the bundle names: a paired
 *   server must not be able to send this machine's secrets to a URL it chooses. Any other ref is missing.
 * - Its `${#System#…}` scope is the map the caller passes (`systemValues`), never the process environment:
 *   the agent passes only the names the bundle declares and this machine allows.
 * - Its OAuth2 tokens, issued SAML tokens and cookies are the caller's session (one per pairing).
 * - It writes no History, HTTP Log row or audit event, reads no window's picks or plugins, and keeps no
 *   script value. A failed send's Log row is handed to the caller (`onFailed`), which takes it to the server
 *   the bundle came from.
 */
import { createIssuedTokenSource, parseSecretPseudoRef, WirebenchError } from '@wirebench/engine';
import type { CookieJarHost, EgressPolicy, GetSecret, IssuedTokenSource, PropertyMap } from '@wirebench/engine';
import type { ExchangeSummary } from '@wirebench/wire/kinds/soap/wire';
import type { FailedExchangeWire, ProxyOptionsWire } from '@wirebench/wire/wire-base';
import type { RestExchangeSummary } from '@wirebench/wire/kinds/rest/wire';
import type { EngineService } from '../engine-service.js';
import type { HostState } from '../host/host-state.js';
import type { HandlerTable } from '../ipc/register.js';
import type { RequestChannelProject } from '../ipc/request.js';
import { KIND_ROUTES } from '../kinds/kind-routes.js';
import { kindSend } from '../kinds/kind-send.js';
import { OAuth2Service } from '../oauth2.js';
import type { PreferencesService } from '../preferences.js';
import type { ProjectHost } from '../project-host.js';
import type { ScriptHost } from '../script-host.js';
import type { SendScripts } from '../script-send.js';
import type { DraftOf } from './draft.js';
import { ExchangeRegistry, sendThroughEngine, type SendThroughEngineDeps } from './exchange.js';

/** The kinds a detached send sends: a WebSocket session is not a send, and gRPC and MCP are not yet served. */
export type DetachedSendKind = 'rest' | 'soap';

/**
 * The store label of an agent secret: the pairing, the server workspace and the name. Keyed by pairing, not
 * origin: two accounts on one server that pair the same machine never read each other's values.
 */
export function agentSecretLabel(pairingId: string, workspaceId: string, name: string): string {
  return `agent:${pairingId}:${workspaceId}:${name}`;
}

/**
 * What the team-secrets hook is asked. The workspace id comes from a bundle, which the server named: the
 * implementer must confirm that workspace belongs to `serverOrigin` (the pairing's server) before answering,
 * or server M could name server S's workspace and read S's team secrets.
 */
export interface AgentTeamSecretQuery {
  readonly pairingId: string;
  readonly serverOrigin: string;
  readonly workspaceId: string;
  /** The bundle's project, as its manifest names it: a `${secret:name}` token's value is the project's. */
  readonly projectId: string | undefined;
  readonly name: string;
  /**
   * The bundle's `team-secrets/` subtree, by path inside it (`values/<id>.yaml`), as text. Read only to tell
   * whether this machine's imported value is as new as the server's; never a value to open.
   */
  readonly bundleTeamSecrets: ReadonlyMap<string, string>;
}

/**
 * The token caches one caller's detached sends share (the agent keeps one per pairing), so two pairings
 * never get each other's OAuth2 or SAML tokens, nor a window's.
 */
export interface SendSession {
  readonly oauth2: Pick<OAuth2Service, 'accessToken' | 'clear'>;
  readonly issuedTokens: { readonly source: IssuedTokenSource };
}

/**
 * A fresh {@link SendSession} for `host`. Its OAuth2 grants run without a browser (the client-credentials,
 * password and refresh-token grants), held to `egress`, the host platform's rule (`HostPlatform.network`),
 * which every caller must pass, `undefined` when the platform has none; each token it obtains is recorded
 * in the host's redactor.
 */
export function createSendSession(
  host: { readonly handlers: Pick<HandlerTable, 'redactor'> },
  options: { readonly egress: EgressPolicy | undefined },
): SendSession {
  const { redactor } = host.handlers;
  return {
    oauth2: new OAuth2Service({
      openExternal: () => Promise.reject(new WirebenchError('host-capability-missing', 'No browser here')),
      browserFlows: false,
      ...(options.egress !== undefined ? { egress: options.egress } : {}),
    }),
    issuedTokens: { source: createIssuedTokenSource({ onSecretValue: redactor.recordSecretValue }) },
  };
}

/** What {@link Host.sendFromDirectory} is asked. */
export interface SendFromDirectoryInput {
  /** The send's id: what `signal` cancels it by. */
  readonly sendId: string;
  /** A project folder the caller wrote and owns; the host reads it and writes nothing to it. */
  readonly projectDir: string;
  readonly itemId: string;
  /** The environment id it is sent under; the project's active one when absent. */
  readonly environment?: string;
  readonly kind: DetachedSendKind;
  /** The pairing the send came through, with its server's origin and workspace: they name its secrets. */
  readonly pairingId: string;
  readonly origin: string;
  readonly workspaceId: string;
  /** The `${secret:name}` names the bundle declares; any other ref is missing. */
  readonly secretNames: readonly string[];
  /** The bundle's `team-secrets/` subtree, by path inside it, as text; handed to the team-secrets hook. */
  readonly teamSecrets?: ReadonlyMap<string, string>;
  /**
   * The whole `${#System#…}` scope of this send, already cut to what it may read; every other name resolves
   * empty. Never the process environment by default: a paired server must not read it.
   */
  readonly systemValues: Readonly<Record<string, string>>;
  /**
   * The `${#Workspace#…}` and `${#Global#…}` scopes the bundle carries (the server's, values only). They are
   * the send's whole workspace and global scopes: this machine's own globals are never read.
   */
  readonly scopes?: { readonly workspace: PropertyMap; readonly global: PropertyMap };
  /** The cookie jar this send reads and stores into: the caller's, never a window's. */
  readonly cookies: CookieJarHost;
  /** The caller's token caches. */
  readonly session: SendSession;
  /** Aborts the send, as `request.cancel` does a window's. */
  readonly signal?: AbortSignal;
  /**
   * Hears the HTTP Log's failure row of a send that failed, built and redacted as a window's is (never shown
   * with its secrets), before the send rejects. The host writes no row itself: the caller hands it on.
   */
  readonly onFailed?: (failure: FailedExchangeWire) => void;
}

/** The kind's ordinary send result. */
export type DetachedSendResult = RestExchangeSummary | ExchangeSummary;

/** What the host lends a detached send: each part named, nothing of a window's. */
export interface DetachedSendDeps {
  readonly hostState: DetachedHostState;
  /** The machine's preferences: its CA bundle, proxy and TLS floor. */
  readonly preferences: Pick<PreferencesService, 'get'>;
  /** Asks about a protected environment as the host asks for any send; absent, such a send is refused. */
  readonly confirmProtected?: (environmentNames: readonly string[]) => Promise<boolean>;
  readonly egress?: EgressPolicy;
  /**
   * The proxy a send to `url` goes through: this machine's own Settings, its password read for the proxy
   * alone (the agent sends from this machine's network). Never a getter a bundle's refs reach.
   */
  readonly proxyFor: (url: string) => Promise<ProxyOptionsWire | undefined>;
  /** Reads one value of the host's secret store by its label, for the agent's namespace only. */
  readonly agentSecret: (label: string) => Promise<string | undefined>;
  /**
   * Team secrets of a server workspace (Task 10 plugs it in); absent, none resolve. It must confirm the
   * workspace belongs to `serverOrigin` before it answers (see {@link AgentTeamSecretQuery}).
   */
  readonly teamSecrets?: (query: AgentTeamSecretQuery) => Promise<string | undefined>;
  /** Wraps a getter so the embedder hears what it resolves, by name (`HostOptions.onSecret`). */
  readonly report?: (get: GetSecret, target?: string) => GetSecret;
  /** A fresh engine service whose definition imports read `getSecret`. */
  readonly engine: (getSecret: GetSecret) => EngineService;
  /**
   * A fresh project host over `engine`, with no workspace, globals, current values or picks, on `hostState`:
   * the send's own view of the host's state, whose `${#System#…}` scope is the send's `systemValues`.
   */
  readonly projectHost: (engine: EngineService, getSecret: GetSecret, hostState: DetachedHostState) => ProjectHost;
  /** The host's script host: the one sandbox and checker. */
  readonly scripts?: ScriptHost;
  /** The detached sends in flight; never a window's registry, so a window's cancel cannot reach them. */
  readonly registry: ExchangeRegistry;
}

/**
 * The only secrets a detached send reads: a declared `${secret:name}` from the agent's namespace for the
 * caller's pairing and workspace, else from the team-secrets hook. A plain store ref, an undeclared name and
 * a source-backed one are all missing. Each value it hands out is recorded for masking.
 */
function agentSecrets(
  deps: DetachedSendDeps,
  input: SendFromDirectoryInput,
  projectId: () => string | undefined,
): GetSecret {
  const declared = new Set(input.secretNames);
  const bundleTeamSecrets = input.teamSecrets ?? new Map<string, string>();
  const get: GetSecret = async (ref) => {
    const name = parseSecretPseudoRef(ref);
    if (name === undefined || !declared.has(name)) return undefined;
    const value =
      (await deps.agentSecret(agentSecretLabel(input.pairingId, input.workspaceId, name))) ??
      (await deps.teamSecrets?.({
        pairingId: input.pairingId,
        serverOrigin: input.origin,
        workspaceId: input.workspaceId,
        projectId: projectId(),
        name,
        bundleTeamSecrets,
      }));
    if (value !== undefined) deps.hostState.redactor.recordSecretValue(value);
    return value;
  };
  return deps.report?.(get) ?? get;
}

/** The part of the host's state a detached send and its project host read. */
export type DetachedHostState = Pick<HostState, 'redactor' | 'e2eTrustAnchors' | 'systemValues'>;

/**
 * The host's state as one detached send sees it: the host's redactor and trust anchors, and `systemValues`
 * in place of the host's `${#System#…}` scope, so neither the send path nor the project host falls back to
 * the process environment.
 */
function detachedHostState(
  hostState: DetachedHostState,
  systemValues: Readonly<Record<string, string>>,
): DetachedHostState {
  return {
    redactor: hostState.redactor,
    get e2eTrustAnchors() {
      return hostState.e2eTrustAnchors;
    },
    set e2eTrustAnchors(anchors) {
      hostState.e2eTrustAnchors = anchors;
    },
    systemValues: { ...systemValues },
  };
}

/** A detached send is never shown with its secrets: what it answers leaves the host. */
const NEVER_SHOW = { get: (): boolean => false };

/** Throws what an aborted send throws when `signal` has been aborted. */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new WirebenchError('aborted', 'The request was aborted.');
}

/**
 * The `ProjectRouter` surface a send drives, over one open project: every id is that project's. A
 * change through it is refused, since the folder is the caller's.
 */
export function singleProjectRouter(
  host: ProjectHost,
  proxyFor: (url: string) => Promise<ProxyOptionsWire | undefined> = (url) => host.proxyFor(url),
): RequestChannelProject {
  const router: Record<string, unknown> = {
    projectId: () => host.open?.project.id,
    projectSnapshot: () => host.snapshot(),
    projectMutate: () =>
      Promise.reject(new WirebenchError('project-read-only', 'This project is sent from a bundle and cannot change')),
    scopesFor: (_requestId: string, envId?: string) => host.scopesFor(envId),
    preflight: (...args: Parameters<ProjectHost['preflight']>) => host.preflight(...args),
    tlsFor: (...args: Parameters<ProjectHost['tlsFor']>) => host.tlsFor(...args),
    sendEnvironments: () => host.sendEnvironments(),
    runContextFor: (...args: Parameters<ProjectHost['runContextFor']>) => host.runContextFor(...args),
    proxyFor: (_projectId: string, url: string) => proxyFor(url),
    trustAnchorsFor: () => host.trustAnchors(),
    clientIdentityFor: (_projectId: string, keystoreId: string | undefined) => host.clientIdentityFor(keystoreId),
    keystoreFor: (_projectId: string, keystoreId: string) => host.keystoreFor(keystoreId),
  };
  // Each kind's methods, as `WorkspaceService` installs them: a project-addressed one drops its project id.
  for (const [kind, routes] of Object.entries(KIND_ROUTES) as [
    keyof typeof KIND_ROUTES,
    (typeof KIND_ROUTES)[keyof typeof KIND_ROUTES],
  ][]) {
    for (const [name, route] of Object.entries(routes)) {
      router[name] = (...args: unknown[]): unknown => {
        const kindHost = host.kind(kind) as unknown as Record<string, (...rest: unknown[]) => unknown>;
        return kindHost[route.method]!.apply(kindHost, route.by === 'project' ? args.slice(1) : args);
      };
    }
  }
  return router as unknown as RequestChannelProject;
}

/**
 * `router` with the bundle's workspace and global scopes laid on every run context and scope it answers,
 * in place of the host's (which has none): exactly those, or none at all.
 */
function withBundleScopes(
  router: RequestChannelProject,
  scopes: SendFromDirectoryInput['scopes'],
): RequestChannelProject {
  const workspace = { ...scopes?.workspace };
  const global = { ...scopes?.global };
  return {
    ...router,
    runContextFor: (...args: Parameters<NonNullable<RequestChannelProject['runContextFor']>>) => {
      const located = router.runContextFor?.(...args);
      return located === undefined ? undefined : { ...located, globals: global, workspaceProperties: workspace };
    },
    scopesFor: (...args: Parameters<RequestChannelProject['scopesFor']>) => ({
      ...router.scopesFor(...args),
      workspace,
      global,
    }),
  };
}

/**
 * The scripts of the bundle's project, read from its own model, with no session: a value a script keeps is
 * not kept, and none of a window's is read.
 */
function detachedScripts(scripts: ScriptHost, host: ProjectHost, engine: EngineService): SendScripts {
  return {
    lookup: (requestId) =>
      scripts.lookup(requestId, {
        modelOf: () => host.model(),
        openApiDocumentFor: (apiId) => host.kind('rest').openApiDocumentFor(apiId),
        grpcProtoSetFor: (apiId) => host.kind('grpc').grpcProtoSetFor(apiId),
        soapDefinitionFor: (interfaceId) => (engine.has(interfaceId) ? engine.resultFor(interfaceId) : undefined),
      }),
    get scripting() {
      return scripts.scripting;
    },
    sessionValues: (): PropertyMap => ({}),
    keepValues: () => undefined,
  };
}

/**
 * Sends `input.itemId` of the project in `input.projectDir`. The project and its engine service are closed
 * when the send ends, however it ends; the folder itself is the caller's to remove.
 *
 * @throws WirebenchError `agent-bundle-invalid` when the project has no `kind` request of that id;
 *   `aborted` when `signal` ended it; and whatever the send itself throws (`secret-missing`, …)
 */
export async function sendFromDirectory(
  deps: DetachedSendDeps,
  input: SendFromDirectoryInput,
): Promise<DetachedSendResult> {
  const { signal } = input;
  stopIfAborted(signal);
  // The project host is made below; a secret is only asked for once its project is open.
  const opened: { host?: ProjectHost } = {};
  const getSecret = agentSecrets(deps, input, () => opened.host?.open?.project.id);
  const hostState = detachedHostState(deps.hostState, input.systemValues);
  const engine = deps.engine(getSecret);
  const host = deps.projectHost(engine, getSecret, hostState);
  opened.host = host;
  try {
    await host.openProject(input.projectDir);
    // A SOAP request's default `wsa:Action` and its script types come from the loaded definition.
    await host.whenHydrated();
    const model = host.model();
    const draft: DraftOf = input.kind === 'rest' ? { kind: 'rest' } : { kind: 'soap', override: {} };
    if (model === undefined || kindSend(input.kind).selected(model, input.itemId, draft) === undefined) {
      throw new WirebenchError('agent-bundle-invalid', `The bundle has no ${input.kind} request ${input.itemId}`, {
        details: { itemId: input.itemId },
      });
    }
    stopIfAborted(signal);
    const { oauth2, issuedTokens } = input.session;
    const sendDeps: SendThroughEngineDeps = {
      hostState,
      project: withBundleScopes(singleProjectRouter(host, deps.proxyFor), input.scopes),
      service: engine,
      registry: deps.registry,
      oauth2: {
        accessToken: (config, options) => oauth2.accessToken(config, options),
        clear: (config) => {
          oauth2.clear(config);
        },
      },
      issuedTokens,
      getSecret,
      secretsFor: () => getSecret,
      preferences: () => deps.preferences.get(),
      showSecrets: NEVER_SHOW,
      cookies: () => input.cookies,
      ...(deps.scripts !== undefined ? { scripts: detachedScripts(deps.scripts, host, engine) } : {}),
      ...(deps.confirmProtected !== undefined ? { confirmProtected: deps.confirmProtected } : {}),
      ...(deps.egress !== undefined ? { egress: deps.egress } : {}),
      ...(input.onFailed !== undefined ? { onSendFailed: input.onFailed } : {}),
    };
    // The same abort a window's `request.cancel` reaches: the send's handle in the registry.
    const onAbort = (): void => {
      deps.registry.cancel(input.sendId);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await sendThroughEngine(sendDeps, input.sendId, input.itemId, {
        draft,
        ...(input.environment !== undefined ? { envId: input.environment } : {}),
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    // Never saved: the folder is the caller's, and it is removed after this.
    await host.close({ keepUnsaved: true });
    await engine.disposeRestContractChecker().catch(() => undefined);
  }
}
