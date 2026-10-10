/**
 * A protocol behind one interface (spec §3, ADR-0017): how its containers are stored, how its
 * requests run, and what a script sees of them. Core code calls a module through the registry and
 * never names a protocol. This file imports no protocol.
 */
import type { z } from 'zod';
import type { Assertion } from '../assert/model.js';
import type { ProtocolMocking } from '../mock/contract.js';
import type { FsLike } from '../project/fs.js';
import type { ProjectProblem } from '../project/load.js';
import type { Project } from '../project/model.js';
import type { RequestFileLocation } from '../project/request-tree.js';
import type { RunContext } from '../run/context.js';
import type { ExchangeHandle, ExchangeOptions } from '../run/exchange.js';
import type { SendHost } from '../run/host.js';
import type { ScriptSession } from '../run/script-support.js';
import type { SecretNeed } from '../secrets/env-names.js';
import type { ScanTarget, SecretRewriter } from '../secrets/scan/support.js';
import type { HeaderPair, RequestScripts, ScriptFailure, ScriptPhase } from '../script/model.js';
import type { RequestScriptTypes } from '../script/request-scripts.js';
import type { SecretPlaceholders } from '../script/send.js';
import type { ApiReferenceSection } from '../script/types/api.js';
import type { FeatureDescriptor } from './features.js';

/**
 * The two top-level directories a project keeps containers in (ADR-0003, ADR-0007).
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export type ContainerDir = 'interfaces' | 'apis';

/**
 * What every container has, whatever its protocol.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface ContainerBase {
  readonly kind: string;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
}

/**
 * What a module's loader is given. Problems that do not stop the load are pushed to `problems`.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface LoadContext {
  readonly fs: FsLike;
  /** The project folder. */
  readonly root: string;
  readonly problems: ProjectProblem[];
}

/**
 * How a protocol's containers are read from and written to a project folder (spec §3.2).
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface ProtocolStorage<C extends ContainerBase = ContainerBase> {
  /** Where its containers live: `interfaces` (SOAP) or `apis` (every other protocol). */
  readonly dir: ContainerDir;
  /**
   * Reads the container directory `<dir>/<slug>/`, given its already-parsed container file.
   * Returns undefined when the container cannot be used and a problem was recorded.
   *
   * @throws ProjectError what the file schemas throw
   */
  load(ctx: LoadContext, slug: string, document: unknown): Promise<C | undefined>;
  /** Every file the container is written as: path relative to the project root, to its text. */
  files(container: C): ReadonlyMap<string, string>;
  /** The files under `<dir>/<slug>/` a save may delete when it no longer writes them. */
  managed(fs: FsLike, root: string, slug: string): Promise<readonly string[]>;
  /** The project's containers of this kind. */
  containers(project: Project): readonly C[];
  /** The project with its containers of this kind replaced. */
  withContainers(project: Project, containers: readonly C[]): Project;
  /**
   * Where the request with `requestId` is written, when `container` holds it. A kind that leaves it
   * out has no request files a host places a sidecar beside.
   */
  requestLocation?(container: C, requestId: string): RequestFileLocation | undefined;
  /**
   * Every entity id in `container`, its own first, for a copy that takes fresh ids
   * (`reidentifyProject`). A kind that leaves it out keeps its ids in a copy.
   */
  entityIds?(container: C): readonly string[];
  /** `container` with every id it holds, and every reference to one, passed through `mapId`. */
  withEntityIds?(container: C, mapId: (id: string) => string): C;
}

/**
 * Where the secret scanner looks in what a protocol stores, and how a move to a secret rewrites it
 * (docs/specs/2026-09-22-secret-scanning-design.md). Each location it yields and rewrites is one of
 * its own `SecretLocation` kinds.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface ProtocolSecrets {
  /** Every stored text of the protocol's in `project` worth scanning, in explorer order. */
  scanTargets(project: Project): Iterable<ScanTarget>;
  /** `project` with each move at one of the protocol's texts applied; `project` itself when none applied. */
  applyMoves(project: Project, rw: SecretRewriter): Project;
}

/**
 * What every selected request has, whatever its protocol.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface SelectedBase {
  readonly kind: string;
  /** The display path, `<group>/<request name>`. */
  readonly path: string;
  readonly group: string;
  readonly request: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly assertions?: readonly Assertion[];
    readonly scripts?: RequestScripts;
  };
}

/**
 * One container's runnable requests, in explorer order.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface RunGroup<S extends SelectedBase = SelectedBase> {
  readonly order: number;
  readonly name: string;
  readonly candidates: readonly {
    readonly item: S;
    /** The request's path on disk, without the `.request.yaml` suffix. */
    readonly diskPath: string;
  }[];
  /** Sent only when a selector names it, and listed after every container (webhook items). */
  readonly explicitOnly?: true;
}

/**
 * What a module is given for one run.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface RunScope {
  readonly context: RunContext;
  /**
   * One value per key for the whole run. A load that rejects is remembered and rejects again.
   * Keys are `<kind>:<container id>:<what>`.
   */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

/**
 * The scripts of one send, when the request has active scripts.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface ScriptedSend {
  readonly session: ScriptSession;
  readonly placeholders: SecretPlaceholders;
}

/**
 * How a protocol's requests run (spec §3.3).
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface ProtocolRun<S extends SelectedBase = SelectedBase> {
  /** The requests a run can send, one group per container (and any `explicitOnly` group). */
  groups(project: Project): readonly RunGroup<S>[];
  /** For a request id found in this protocol's containers but not runnable: why. */
  whyNotRunnable(project: Project, requestId: string): string | undefined;
  /**
   * Opens one send (spec §4): resolve, pre-request script, connect, send. The send's own failure
   * rejects `result`; it throws at once only for a request of another kind.
   */
  open(selected: S, scope: RunScope, host: SendHost, options: ExchangeOptions): ExchangeHandle;
  /** The resolve step alone (spec §3.3): what a send would send, with nothing connected. */
  resolve(selected: S, scope: RunScope, host: SendHost): Promise<unknown>;
  /** The request's script types, from whatever contract the run has cached for it. */
  scriptTypes(selected: S, scope: RunScope): Promise<RequestScriptTypes>;
  /** The secrets this protocol's configuration needs: auth, keystores, signing, WS-Security. */
  secretNeeds(selected: S, project: Project): readonly SecretNeed[];
}

/**
 * What every request snapshot carries.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface RequestSnapshotBase {
  readonly protocol: string;
}

/**
 * What every response snapshot carries.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface ResponseSnapshotBase {
  readonly protocol: string;
}

/**
 * What core's script rules check on a request snapshot (spec §3.4).
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface SnapshotFacts {
  /** Where the request goes. A URL keeps its scheme, host and port; anything else stays identical. */
  readonly destination: string;
  /** Values a script may not change at all. Compared before and after with `JSON.stringify`. */
  readonly fixed: unknown;
  /** Header or metadata pairs: no name or value may hold CR, LF or NUL. */
  readonly pairs: readonly HeaderPair[];
  /** Other single-line values (a URL, a SOAPAction): none may hold CR, LF or NUL. */
  readonly lines: readonly string[];
  /** Every text in which a `${secret:…}` reference would be expanded. */
  readonly texts: readonly string[];
}

/**
 * What a script sees of a protocol's requests and responses (spec §3.4).
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface ProtocolScripting<
  Q extends RequestSnapshotBase = RequestSnapshotBase,
  R extends ResponseSnapshotBase = ResponseSnapshotBase,
> {
  /** The API's ambient declarations for one phase, after the common ones. */
  declarations(phase: ScriptPhase): string;
  /** The docs site's reference sections for this protocol, in order. */
  reference(): readonly ApiReferenceSection[];
  /** Sandbox-side source that defines `request` and `response` from the input snapshot. */
  prelude(phase: ScriptPhase): string;
  /** The shape a pre-request script may hand back. */
  readonly requestSchema: z.ZodType<Q>;
  /** What core's rules check. */
  inspect(snapshot: Q): SnapshotFacts;
  /** Protocol-only rules on a changed request, run after core's. */
  validate?(before: Q, after: Q): ScriptFailure | undefined;
  /** Typed views a script sees that the snapshot does not carry (SOAP's typed `body`). */
  readonly views?: {
    request(snapshot: Q, types: RequestScriptTypes): Q;
    response(snapshot: R, types: RequestScriptTypes): R;
    /** Writes a changed view back into the snapshot, or refuses the script. */
    writeBack(
      before: Q,
      after: Q,
      types: RequestScriptTypes,
    ): { readonly ok: true; readonly request: Q } | { readonly ok: false; readonly error: ScriptFailure };
  };
}

/**
 * One protocol (spec §3).
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface ProtocolModule {
  /** The `kind` written on the container file and on every request file under it. */
  readonly kind: string;
  /** The feature that switches this protocol; its `id` equals `kind`. */
  readonly feature: FeatureDescriptor;
  /** How its containers are read from and written to a project folder. */
  readonly storage: ProtocolStorage;
  /** Absent: the protocol's requests cannot be run. */
  readonly run?: ProtocolRun;
  /** Absent: the protocol's requests cannot have scripts. */
  readonly scripting?: ProtocolScripting;
  /** Absent: the protocol's containers cannot be mocked (mock services spec §The protocol facet). */
  readonly mock?: ProtocolMocking;
  /** Absent: the secret scanner does not look in the protocol's containers. */
  readonly secrets?: ProtocolSecrets;
}

function assertKind(module: string, item: { readonly kind: string }): void {
  if (item.kind !== module) {
    throw new Error(`The "${module}" protocol was handed a "${item.kind}" request`);
  }
}

/**
 * A module as the registry holds it: the facets written against the protocol's own types, with a
 * guard on every call that takes a selected request, so a wrong pairing fails loudly.
 *
 * @throws Error when the feature's id is not the module's kind
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function defineProtocol<S extends SelectedBase>(module: {
  readonly kind: string;
  readonly feature: FeatureDescriptor;
  readonly storage: ProtocolStorage;
  readonly run?: ProtocolRun<S>;
  readonly scripting?: ProtocolScripting;
  readonly mock?: ProtocolMocking;
  readonly secrets?: ProtocolSecrets;
}): ProtocolModule {
  const { run } = module;
  if (module.feature.id !== module.kind) {
    throw new Error(`defineProtocol: the feature of "${module.kind}" must have the same id`);
  }
  return {
    kind: module.kind,
    feature: module.feature,
    storage: module.storage,
    ...(module.scripting !== undefined ? { scripting: module.scripting } : {}),
    ...(module.mock !== undefined ? { mock: module.mock } : {}),
    ...(module.secrets !== undefined ? { secrets: module.secrets } : {}),
    ...(run !== undefined
      ? {
          run: {
            groups: (project) => run.groups(project),
            whyNotRunnable: (project, requestId) => run.whyNotRunnable(project, requestId),
            open: (selected, scope, host, options) => {
              assertKind(module.kind, selected);
              return run.open(selected as S, scope, host, options);
            },
            resolve: (selected, scope, host) => {
              assertKind(module.kind, selected);
              return run.resolve(selected as S, scope, host);
            },
            scriptTypes: (selected, scope) => {
              assertKind(module.kind, selected);
              return run.scriptTypes(selected as S, scope);
            },
            secretNeeds: (selected, project) => {
              assertKind(module.kind, selected);
              return run.secretNeeds(selected as S, project);
            },
          },
        }
      : {}),
  };
}
