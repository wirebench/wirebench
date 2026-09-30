/**
 * A protocol behind one interface (spec §3, ADR-0017): how its containers are stored, how its
 * requests run, and what a script sees of them. Core code calls a module through the registry and
 * never names a protocol. This file imports no protocol.
 */
import type { z } from 'zod';
import type { Assertion } from '../assert/model.js';
import type { FsLike } from '../project/fs.js';
import type { ProjectProblem } from '../project/load.js';
import type { Project } from '../project/model.js';
import type { RunContext } from '../run/context.js';
import type { SentRequest } from '../run/run.js';
import type { ScriptSession } from '../run/script-support.js';
import type { SecretNeed } from '../secrets/env-names.js';
import type { HeaderPair, RequestScripts, ScriptFailure, ScriptPhase } from '../script/model.js';
import type { RequestScriptTypes } from '../script/request-scripts.js';
import type { SecretPlaceholders } from '../script/send.js';
import type { ApiReferenceSection } from '../script/types/api.js';
import type { FeatureDescriptor } from './features.js';

/** The two top-level directories a project keeps containers in (ADR-0003, ADR-0007). */
export type ContainerDir = 'interfaces' | 'apis';

/** What every container has, whatever its protocol. */
export interface ContainerBase {
  readonly kind: string;
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
}

/** What a module's loader is given. Problems that do not stop the load are pushed to `problems`. */
export interface LoadContext {
  readonly fs: FsLike;
  /** The project folder. */
  readonly root: string;
  readonly problems: ProjectProblem[];
}

/** How a protocol's containers are read from and written to a project folder (spec §3.2). */
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
}

/** What every selected request has, whatever its protocol. */
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

/** One container's runnable requests, in explorer order. */
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

/** What a module is given for one run. */
export interface RunScope {
  readonly context: RunContext;
  /**
   * One value per key for the whole run. A load that rejects is remembered and rejects again.
   * Keys are `<kind>:<container id>:<what>`.
   */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

/** The scripts of one send, when the request has active scripts. */
export interface ScriptedSend {
  readonly session: ScriptSession;
  readonly placeholders: SecretPlaceholders;
}

/** How a protocol's requests run (spec §3.3). */
export interface ProtocolRun<S extends SelectedBase = SelectedBase> {
  /** The requests a run can send, one group per container (and any `explicitOnly` group). */
  groups(project: Project): readonly RunGroup<S>[];
  /** For a request id found in this protocol's containers but not runnable: why. */
  whyNotRunnable(project: Project, requestId: string): string | undefined;
  /**
   * Sends one request as a run does: prepare, run its scripts when `scripts` is given, send.
   *
   * @throws WirebenchError what preparing, the pre-request script or the send throws
   */
  send(selected: S, scope: RunScope, scripts?: ScriptedSend): Promise<SentRequest>;
  /** The request's script types, from whatever contract the run has cached for it. */
  scriptTypes(selected: S, scope: RunScope): Promise<RequestScriptTypes>;
  /** The secrets this protocol's configuration needs: auth, keystores, signing, WS-Security. */
  secretNeeds(selected: S, project: Project): readonly SecretNeed[];
}

/** What every request snapshot carries. */
export interface RequestSnapshotBase {
  readonly protocol: string;
}

/** What every response snapshot carries. */
export interface ResponseSnapshotBase {
  readonly protocol: string;
}

/** What core's script rules check on a request snapshot (spec §3.4). */
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

/** What a script sees of a protocol's requests and responses (spec §3.4). */
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

/** One protocol (spec §3). */
export interface ProtocolModule {
  /** The `kind` written on the container file and on every request file under it. */
  readonly kind: string;
  /** The feature that switches this protocol; its `id` equals `kind`. */
  readonly feature: FeatureDescriptor;
  /** Optional until slice 3 of the plan lands; every built-in module has one after it. */
  readonly storage?: ProtocolStorage;
  /** Absent: the protocol's requests cannot be run. */
  readonly run?: ProtocolRun;
  /** Absent: the protocol's requests cannot have scripts. */
  readonly scripting?: ProtocolScripting;
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
 */
export function defineProtocol<S extends SelectedBase>(module: {
  readonly kind: string;
  readonly feature: FeatureDescriptor;
  readonly storage?: ProtocolStorage;
  readonly run?: ProtocolRun<S>;
  readonly scripting?: ProtocolScripting;
}): ProtocolModule {
  const { run } = module;
  if (module.feature.id !== module.kind) {
    throw new Error(`defineProtocol: the feature of "${module.kind}" must have the same id`);
  }
  return {
    kind: module.kind,
    feature: module.feature,
    ...(module.storage !== undefined ? { storage: module.storage } : {}),
    ...(module.scripting !== undefined ? { scripting: module.scripting } : {}),
    ...(run !== undefined
      ? {
          run: {
            groups: (project) => run.groups(project),
            whyNotRunnable: (project, requestId) => run.whyNotRunnable(project, requestId),
            send: (selected, scope, scripts) => {
              assertKind(module.kind, selected);
              return run.send(selected as S, scope, scripts);
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
