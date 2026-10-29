/**
 * One send of a project that no window has open (hosted edition spec §18.4): a local agent writes a
 * send bundle to a folder of its own and asks the host to send one item of it. The send goes through
 * `sendThroughEngine` with the same dependencies a window's send gets (the host's secret getter and
 * redactor, its preferences, its OAuth2 and issued-token caches), over a {@link ProjectHost} of its own
 * and an engine service of its own, so nothing of the bundle's project reaches a window's projects, the
 * loaded definitions they share, History, the HTTP Log or the audit outbox.
 */
import { WirebenchError } from '@wirebench/engine';
import type { CookieJarHost, PropertyMap } from '@wirebench/engine';
import type { ExchangeSummary } from '@wirebench/wire/kinds/soap/wire';
import type { RestExchangeSummary } from '@wirebench/wire/kinds/rest/wire';
import type { EngineService } from '../engine-service.js';
import { toSendDeps, type RequestChannelDeps, type RequestChannelProject } from '../ipc/request.js';
import { KIND_ROUTES } from '../kinds/kind-routes.js';
import { kindSend } from '../kinds/kind-send.js';
import type { ProjectHost } from '../project-host.js';
import type { ScriptHost } from '../script-host.js';
import type { SendScripts } from '../script-send.js';
import type { DraftOf } from './draft.js';
import { ExchangeRegistry, sendThroughEngine } from './exchange.js';

/** The kinds a detached send sends: a WebSocket session is not a send, and gRPC and MCP are not yet served. */
export type DetachedSendKind = 'rest' | 'soap';

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
  /** The cookie jar this send reads and stores into: the caller's, never a window's. */
  readonly cookies: CookieJarHost;
  /** Aborts the send, as `request.cancel` does a window's. */
  readonly signal?: AbortSignal;
}

/** The kind's ordinary send result. */
export type DetachedSendResult = RestExchangeSummary | ExchangeSummary;

/** What the host lends a detached send. */
export interface DetachedSendDeps {
  /** A window's send dependencies; the window-bound ones (History, the log, the audit, the jar) are left out. */
  readonly request: RequestChannelDeps;
  /** A fresh engine service: the bundle's definitions never replace a window's loaded ones. */
  readonly engine: () => EngineService;
  /** A fresh project host over `engine`, with no workspace, globals, current values or picks. */
  readonly projectHost: (engine: EngineService) => ProjectHost;
  /** The host's script host: the one sandbox and checker. */
  readonly scripts?: ScriptHost;
  /** The detached sends in flight; never a window's registry, so a window's cancel cannot reach them. */
  readonly registry: ExchangeRegistry;
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
export function singleProjectRouter(host: ProjectHost): RequestChannelProject {
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
    proxyFor: (_projectId: string, url: string) => host.proxyFor(url),
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
 * The parts of a window's send dependencies that belong to a window: its History, HTTP Log, audit outbox,
 * jar, cancel registry, script session and its own sends' listeners. A detached send has none of them.
 */
const WINDOW_PARTS = [
  'history',
  'onHistoryAppended',
  'onSendFailed',
  'onExchange',
  'onScriptsRan',
  'audit',
  'auditWorkspace',
  'cookies',
  'registry',
  'scripts',
] as const satisfies readonly (keyof RequestChannelDeps)[];

function withoutWindowParts(request: RequestChannelDeps): RequestChannelDeps {
  const copy: Partial<Record<keyof RequestChannelDeps, unknown>> = { ...request };
  for (const key of WINDOW_PARTS) delete copy[key];
  return copy as RequestChannelDeps;
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
  const engine = deps.engine();
  const host = deps.projectHost(engine);
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
    const sendDeps = toSendDeps(
      engine,
      {
        ...withoutWindowParts(deps.request),
        project: singleProjectRouter(host),
        cookies: () => input.cookies,
        showSecrets: NEVER_SHOW,
        ...(deps.scripts !== undefined ? { scripts: detachedScripts(deps.scripts, host, engine) } : {}),
      },
      deps.registry,
    );
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
