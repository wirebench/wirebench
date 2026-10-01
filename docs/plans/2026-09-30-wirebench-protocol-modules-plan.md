# Wirebench Protocol Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every protocol in the engine (SOAP, REST, gRPC, WebSocket) sits behind one `ProtocolModule` interface held in a registry with feature switches, so the run loop, the loader, the writer and the script host no longer branch on `kind`, a container of an unknown or disabled kind survives a load and a save, no protocol folder imports another, and the SOAP-era public names are gone for v3.0.0.

**Architecture:**

- **`protocol/`** (new, core). `features.ts` is the feature set, `module.ts` the interface and its three facets, `registry.ts` the registry. It imports no protocol.
- **One module per protocol.** `soap/module.ts`, `rest/module.ts`, `grpc/module.ts`, `ws/module.ts`, each assembled from facet files in the same folder (`run.ts`, `scripting.ts`, `storage.ts`, `files.ts`). Existing functions move into them; their order of operations does not change.
- **`protocols.ts`** (composition file). The only core file that imports every module. It exports `BUILTIN_PROTOCOLS`, `createBuiltinRegistry`, the lazy `defaultRegistry()` every entry point falls back to, and the built-in union types.
- **Core dispatch.** `run/select.ts`, `run/run.ts`, `run/secret-needs.ts`, `project/load.ts`, `project/serialize.ts`, `project/save.ts`, `script/apply.ts`, `script/run.ts`, `script/api/prelude.ts` and `script/types/api.ts` call the registry where they branched.
- **Placeholders.** `Project.unsupported` lists containers whose kind has no enabled module; save treats their directories as live and unmanaged.
- **Proof.** A test-only fifth protocol, `echo`, in `packages/engine/test/helpers/echo-protocol.ts`, goes through load, select, run with scripts, secret needs and save without any core file knowing it. Pinning tests written against today's code guard the order of operations in each send and each script rule.

**Tech Stack:** TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node 24, zod 4, vitest 5, ESLint flat config, pnpm workspaces. No new dependency.

**Spec:** `docs/specs/2026-09-30-wirebench-protocol-modules-design.md` (binding), including its "Revisions after planning". Section numbers below are the spec's.

## Global Constraints

- Branch `feat/protocol-registry`, worktree `git-worktrees/protocol-registry`. Work there only.
- Commit as Mohammed Naami <m.naami@outlook.com>. NO `Co-Authored-By` and NO `Claude-Session` trailers.
- One commit per task, after `WIREBENCH_SKIP_PERF=1 nice pnpm check` is green. First run `pnpm exec prettier --write <touched files>` (`pnpm lint` runs `prettier --check .`). Add `NODE_OPTIONS=--max-old-space-size=8192` if the type check runs out of memory.
- Run `nice pnpm test:perf` unskipped before every push.
- Never name a product or company that inspired a feature, in code, tests or docs (`pnpm check:banned-terms`).
- Fixture secrets and tokens are neutral: `abc123def456ghi789`. Never a provider-shaped value.
- No local Electron windows, no e2e, no Playwright. Headless checks run under `nice`.
- Never bare `git stash` (the stash stack is shared across worktrees). Use a WIP commit.
- **Behaviour-preserving.** An existing test may change only its imports, a renamed export, or the wording of a script refusal message this plan lists. If an existing test's expected value would have to change for any other reason, stop: the move changed behaviour.
- **Moves are moves.** A function that moves keeps its body. Use `git mv` for whole files. Do not reformat, rename locals or "improve" moved code.
- **The engine stays free of Electron, React and CLI concerns** (existing lint).
- **Slices 1 to 4 keep every public export of `packages/engine/src/index.ts` working**, with the one exception the spec's revisions name (`RequestScriptTypes.soap` becomes `binding` in slice 2, with the desktop's call sites). Renames and removals are slice 5.
- **Every entry point's registry parameter is optional** and falls back to `defaultRegistry()` from `packages/engine/src/protocols.ts`. No existing caller or test is edited to pass one.
- Feature ids: `soap`, `rest`, `grpc`, `websocket`, `scripts`. Module kinds: `soap`, `rest`, `grpc`, `websocket`.
- New error codes, exact: `feature-disabled` (`WirebenchError`), `container-slug-conflict` (`ProjectError`), and the load problem code `container-unsupported`.
- `RunScope.memo` keys are `<kind>:<container id>:<what>`, for example `soap:01J…:definition`, `grpc:01J…:proto-set`, `rest:01J…:openapi`.
- Lint rules that bite here: `@typescript-eslint/require-await`, `no-floating-promises` (prefix `void`), `restrict-template-expressions` (wrap numbers in `String()`), `no-non-null-assertion`, `consistent-type-imports`.
- Every export carries JSDoc; every model object is `readonly`; every I/O entry point takes an `AbortSignal` where it did before.
- Single test runs, from the worktree root:
  - engine: `nice pnpm vitest run --project engine-unit <path>` / `--project engine-integration <path>`
  - CLI: `nice pnpm vitest run --project cli-unit <path>`
  - desktop: `nice pnpm vitest run --project desktop <path>`
- Type check alone: `nice pnpm exec tsc -b`.

## Rulings (where the spec is silent)

- **Method syntax, no casts.** The facet interfaces declare their members with method syntax, so `ProtocolRun<SoapSelected>` is assignable to `ProtocolRun` without a cast. `defineProtocol` (in `protocol/module.ts`) wraps `run.send`, `run.scriptTypes` and `run.secretNeeds` with a check that the item's `kind` is the module's, and throws a plain `Error` otherwise.
- **`storage` is optional until slice 3.** `ProtocolModule.storage` is declared `storage?:` in Task 1.1 and made required in the last task of slice 3. Nothing else about the interface changes between slices.
- **`Project.unsupported` and `Project.extraContainers` are optional fields.** Absent means none. Read them through `unsupportedOf(project)` and `extraContainersOf(project, kind)` from `project/model.ts`. No existing `Project` literal is edited.
- **A kind with no list of its own** (the test's `echo`, a later GraphQL) keeps its containers in `Project.extraContainers[kind]`. The four built-ins keep their lists.
- **`defaultRegistry()` is lazy and memoized.** It is called inside functions, never at module scope, so the import cycle between `protocols.ts` and the modules is never evaluated eagerly.
- **`whyDisabled` for an id with no descriptor** returns `{ by: 'unknown' }`.
- **Programming errors are plain `Error`s** (duplicate feature id, `requires` cycle, two modules for one kind, a module whose `feature.id` is not its `kind`, an item handed to the wrong module). Everything a user can cause is a `WirebenchError` with a code.
- **`run/prepare.ts` stays as a thin file through slice 4**: `prepareSend` dispatches to each module's exported `prepare…` function, so the public export keeps working. Slice 5 deletes it.
- **WebSocket's run facet offers nothing to run.** Its `groups` returns no group and its `whyNotRunnable` answers `'A WebSocket request cannot be a sequence step'`; `send`, `scriptTypes` and `secretNeeds` throw a plain `Error` because no candidate reaches them (spec revision R1).
- **`findStepRequest` asks every module's `whyNotRunnable` first**, then looks among the candidates, else answers `missing`. A request of a disabled protocol is `missing`.
- **The script session is opened lazily.** Core hands `send` a session that reads the script's listed secrets on the first `pre`, so the order of `getSecret` calls stays what it is today (`send-order.test.ts` pins it).
- **A save never deletes what its registry cannot write.** The live container directories are every container the project holds in memory (the four lists and every `extraContainers` entry) plus every placeholder, whatever the registry. A container whose kind has no enabled module in the save's registry is treated like a placeholder: nothing under its directory is written, managed or removed (spec revision R6).
- **Milestones** (owner, 2026-09-30): 2.3 becomes 3.0, 2.4 becomes 3.1, 2.5 becomes 3.2, and "3.0 — Contracts, mocks and testing" becomes 4.0. 2.2 and "Later" keep their names.
- **Editing `eslint.config.js`** may be blocked by a config-protection hook. Task 4.9 stops there and asks the owner to allow that one edit; it is never worked around.
- **Existing tests that change more than an import.** These and no others:
  - `packages/engine/test/unit/project/rest-format.test.ts` (the unknown-kind case): it expected `project-kind-not-supported`; spec §6 makes it a placeholder (Task 3.4).
  - `packages/engine/test/unit/script/apply.test.ts`: two local adapters for the new `applyRequestChanges` signature; every expectation unchanged (Task 2.2b).
  - `packages/engine/test/unit/script/types-xsd.test.ts`: `soap:` becomes `binding:` (Task 2.2b).
  - `packages/engine/test/unit/assert/status.test.ts` and `packages/engine/test/unit/run/grpc-subject.test.ts`: the gRPC subject gains `statusNames` (Task 2.3).
- **Refusal messages that change wording** are the five rows of Task 2.1's table. No existing test pins them.
- **Three accepted behaviour changes at the edges** (spec revisions R4, R5, R12): a gRPC request with active scripts and no cached definition now fails with the script host's error before the schema's; a forged script result that breaks two REST rules at once may report a different one of the two; on an HTTP subject, a status assertion naming an all-capitals word that is no status name errors where it failed (a request file cannot hold one).
- **Task numbering** is `<slice>.<task>`; slice 2 has `2.2a` and `2.2b`.

## File Structure

State of `packages/engine/src/` when the plan is done. "new" is a new file; "from" names where the content comes from.

```
protocol/
  features.ts          new  FeatureDescriptor, WhyDisabled, FeatureSet, createFeatureSet
  module.ts            new  ProtocolModule, ProtocolStorage, ProtocolRun, ProtocolScripting,
                            ContainerBase, ContainerDir, LoadContext, SelectedBase, RunGroup,
                            RunScope, ScriptedSend, SnapshotFacts, RequestSnapshotBase,
                            ResponseSnapshotBase, defineProtocol
  registry.ts          new  ProtocolRegistry, ProtocolRegistryOptions, createProtocolRegistry,
                            featureDisabled
  index.ts             new  re-exports the three files
protocols.ts           new  BUILTIN_PROTOCOLS, SCRIPTS_FEATURE, createBuiltinRegistry,
                            defaultRegistry, SelectedRequest, SentExchange, RequestSnapshot,
                            ResponseSnapshot
run/
  context.ts           from run/prepare.ts   RunContext (+ registry?), RunWorkspace, scopesFor
  send-helpers.ts      from run/prepare.ts, run/run.ts, run/secret-needs.ts
                            withSecrets, unresolvedError, insideProject, loadKeystoreById,
                            clientIdentityFor, tlsFor, tokenSourceOf, authFor, baseUrlFor,
                            dropRefusedToken, originOf, keystoreNeeds
  scope.ts             new  createRunScope
  select.ts            generic: groups from the registry; SelectedRequest re-exported from protocols.ts
  run.ts               generic: createRunSender, checkRunScripts, runRequests
  secret-needs.ts      generic: tokenNeeds + module.run.secretNeeds
  script-support.ts    SentScripts, scriptSession, scriptAssertions, mergeScriptValues, listedSecrets
  prepare.ts           thin dispatch through slice 4; deleted in slice 5
  effective-auth.ts    deleted in slice 1; its three functions move into the modules' run.ts
soap/
  module.ts            new  soapProtocol
  run.ts               new  SoapSelected, soapRun (groups, whyNotRunnable, send, scriptTypes,
                            secretNeeds), prepareSoap, soapEffectiveAuth, soapResponseSubject
  scripting.ts         new  soapScripting; SoapRequestSnapshot, SoapResponseSnapshot and their
                            converters, declarations, prelude, generated types, typed body views
  storage.ts           new  soapStorage: load, files, managed, containers, withContainers
  files.ts             from project/schema.ts   interface and SOAP request file schemas
  import.ts, send.ts, generate.ts, operations.ts, types.ts, send-input.ts
                       from the root import.ts, send.ts, generate.ts, operations.ts, types.ts and
                            the SOAP third of send-options.ts (slice 4)
rest/
  module.ts, run.ts (RestSelected, restRun, prepareRest, restEffectiveAuth, restSubject),
  scripting.ts, storage.ts, files.ts, send-input.ts
grpc/
  module.ts, run.ts (GrpcSelected, grpcRun, prepareGrpc, grpcEffectiveAuth, grpcSubject),
  scripting.ts, storage.ts, files.ts, send-input.ts
ws/
  module.ts, storage.ts, files.ts
script/
  apply.ts             generic rules over SnapshotFacts
  run.ts               generic; typed views through ProtocolScripting.views
  send.ts              SecretPlaceholders only; the converters moved to the modules
  model.ts             protocol-neutral types; the snapshot unions moved to protocols.ts
  api/prelude.ts       common prelude + the module's prelude
  types/api.ts         common declarations + the module's declarations; apiReference from the registry
project/
  model.ts             + UnsupportedContainer, Project.unsupported?, Project.extraContainers?,
                            unsupportedOf, extraContainersOf
  load.ts              dispatch per container through the registry; core loads environments,
                            sequences, keystores, WS-Security refs and webhooks
  serialize.ts, save.ts   dispatch through the registry; placeholders stay live
  schema.ts            core file schemas only (manifest, environment, keystores, webhooks)
http/                  + entries.ts, escape.ts, auth/apply.ts, auth/send-auth.ts, cookies.ts,
                            charset.ts, media-type.ts, transcript-cap.ts, fetch-document.ts (slice 4)
keystore/              from wss/keystore/ (slice 4)
json/schema/           from the shared part of rest/openapi/ (slice 4)
```

Files the slices add beyond the tree above; each slice's own "Files" lists are authoritative:

- Slice 1: `run/tree.ts` (`byOrder`, `walkTree`, `findInTree`, `ORPHANED_STEP_REASON`), and `scopeWith` in `run/scope.ts`.
- Slice 2: `script/lookup.ts` (`scriptingOf`, `requireScripting`), `soap/script-types.ts`, `rest/script-types.ts`, `grpc/script-types.ts`.
- Slice 3: `project/schema-parts.ts`, `project/load-helpers.ts`, `project/serialize-helpers.ts`, `project/managed-files.ts`; `takenContainerSlugs` in `project/model.ts`.
- Slice 4: `http/auth/apply-auth.ts` (not `auth/apply.ts`, which exists), `http/auth/oauth2.ts`, `http/webhook-signature.ts`, `http/ref-policy.ts`, `project/cache-naming.ts`, `project/inherit.ts`, `xml/decode.ts`, `xml/qname.ts`, `xml/locate.ts`, `xml/entitize.ts`, `xml/prefixes.ts`, `assert/status-names.ts`, `wss/configs.ts`, `soap/curl.ts`, `soap/expand.ts`, `scripts/engine-import-graph.mjs`.

Test files added: `packages/engine/test/unit/protocol/features.test.ts`, `registry.test.ts`, `module.test.ts`; `packages/engine/test/unit/run/send-order.test.ts`; `packages/engine/test/unit/script/rules-per-protocol.test.ts`; `packages/engine/test/unit/project/placeholders.test.ts`; `packages/engine/test/helpers/echo-protocol.ts`; `packages/engine/test/integration/echo-protocol.test.ts`; `scripts/engine-layers.test.ts` (the lint fixture).

## Contract code

Task 1.1 creates these three files with exactly this content. Every later task is written against them.

### `packages/engine/src/protocol/features.ts`

```ts
/**
 * Features: what a host can switch off (spec §4.1). Every protocol is one; `scripts` is the first
 * that is not. A feature set is immutable: a host that changes a switch creates a new set.
 */

/** One switchable feature. */
export interface FeatureDescriptor {
  readonly id: string;
  readonly title: string;
  /** Whether the feature is on when no switch names it. */
  readonly default: boolean;
  readonly stage: 'stable' | 'experimental';
  /** Features that must be on for this one to be on. */
  readonly requires: readonly string[];
}

/** Why a feature is off. */
export type WhyDisabled =
  | { readonly by: 'switch' }
  | { readonly by: 'requires'; readonly feature: string }
  | { readonly by: 'unknown' };

/** The features of one host, with its switches applied. */
export interface FeatureSet {
  readonly descriptors: readonly FeatureDescriptor[];
  isEnabled(id: string): boolean;
  /** Undefined when the feature is on. */
  whyDisabled(id: string): WhyDisabled | undefined;
}

function assertNoCycle(byId: ReadonlyMap<string, FeatureDescriptor>): void {
  const done = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (path.includes(id)) {
      throw new Error(`createFeatureSet: "requires" cycle: ${[...path, id].join(' -> ')}`);
    }
    if (done.has(id)) return;
    for (const required of byId.get(id)?.requires ?? []) {
      visit(required, [...path, id]);
    }
    done.add(id);
  };
  for (const id of byId.keys()) visit(id, []);
}

/**
 * Builds a feature set. A feature is on when its switch says so (its `default` when no switch
 * names it) and every feature it requires is on. A switch for an id with no descriptor is ignored:
 * it may belong to a module this build does not have.
 *
 * @throws Error for a duplicate id or a `requires` cycle; both are programming errors
 */
export function createFeatureSet(
  descriptors: readonly FeatureDescriptor[],
  switches: Readonly<Record<string, boolean>> = {},
): FeatureSet {
  const byId = new Map<string, FeatureDescriptor>();
  for (const descriptor of descriptors) {
    if (byId.has(descriptor.id)) {
      throw new Error(`createFeatureSet: duplicate feature "${descriptor.id}"`);
    }
    byId.set(descriptor.id, descriptor);
  }
  assertNoCycle(byId);

  const why = new Map<string, WhyDisabled | undefined>();
  const resolve = (id: string): WhyDisabled | undefined => {
    if (why.has(id)) return why.get(id);
    const descriptor = byId.get(id);
    let result: WhyDisabled | undefined;
    if (descriptor === undefined) {
      result = { by: 'unknown' };
    } else if (!(switches[id] ?? descriptor.default)) {
      result = { by: 'switch' };
    } else {
      const blocked = descriptor.requires.find((required) => resolve(required) !== undefined);
      result = blocked !== undefined ? { by: 'requires', feature: blocked } : undefined;
    }
    why.set(id, result);
    return result;
  };
  for (const id of byId.keys()) resolve(id);

  return {
    descriptors: [...byId.values()],
    isEnabled: (id) => resolve(id) === undefined,
    whyDisabled: (id) => resolve(id),
  };
}
```

### `packages/engine/src/protocol/module.ts`

```ts
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
```

### `packages/engine/src/protocol/registry.ts`

```ts
/** The modules a host composed, with its feature set (spec §4.2). */
import { ProjectError, WirebenchError } from '../errors.js';
import { createFeatureSet } from './features.js';
import type { FeatureDescriptor, FeatureSet } from './features.js';
import type { ProtocolModule } from './module.js';

/** The modules of one host. */
export interface ProtocolRegistry {
  readonly features: FeatureSet;
  /** The enabled modules, in registration order. */
  readonly modules: readonly ProtocolModule[];
  status(kind: string): 'enabled' | 'disabled' | 'unknown';
  /** The enabled module for `kind`, or undefined. */
  find(kind: string): ProtocolModule | undefined;
  /** @throws WirebenchError `feature-disabled` | ProjectError `project-kind-not-supported` */
  require(kind: string): ProtocolModule;
}

/** What a registry is built with besides its modules. */
export interface ProtocolRegistryOptions {
  /** Descriptors for features that are not protocols (`scripts`). */
  readonly features?: readonly FeatureDescriptor[];
  readonly switches?: Readonly<Record<string, boolean>>;
}

/**
 * The error for using a feature that is off: a WirebenchError `feature-disabled` with
 * `details.feature`, and `details.requires` when a required feature is what is off.
 */
export function featureDisabled(features: FeatureSet, id: string): WirebenchError {
  const why = features.whyDisabled(id);
  const title = features.descriptors.find((descriptor) => descriptor.id === id)?.title ?? id;
  return new WirebenchError(
    'feature-disabled',
    why?.by === 'requires' ? `${title} is off because "${why.feature}" is off` : `${title} is switched off`,
    { details: { feature: id, ...(why?.by === 'requires' ? { requires: why.feature } : {}) } },
  );
}

/**
 * Builds a registry from `modules`. Its feature set is the modules' descriptors plus
 * `options.features`, with `options.switches` applied.
 *
 * @throws Error for two modules of one kind; what `createFeatureSet` throws
 */
export function createProtocolRegistry(
  modules: readonly ProtocolModule[],
  options: ProtocolRegistryOptions = {},
): ProtocolRegistry {
  const byKind = new Map<string, ProtocolModule>();
  for (const module of modules) {
    if (byKind.has(module.kind)) {
      throw new Error(`createProtocolRegistry: two modules for "${module.kind}"`);
    }
    byKind.set(module.kind, module);
  }
  const features = createFeatureSet(
    [...modules.map((module) => module.feature), ...(options.features ?? [])],
    options.switches,
  );
  const status = (kind: string): 'enabled' | 'disabled' | 'unknown' =>
    !byKind.has(kind) ? 'unknown' : features.isEnabled(kind) ? 'enabled' : 'disabled';
  const find = (kind: string): ProtocolModule | undefined =>
    status(kind) === 'enabled' ? byKind.get(kind) : undefined;
  return {
    features,
    modules: modules.filter((module) => features.isEnabled(module.kind)),
    status,
    find,
    require(kind) {
      const found = find(kind);
      if (found !== undefined) return found;
      if (status(kind) === 'disabled') throw featureDisabled(features, kind);
      throw new ProjectError('project-kind-not-supported', `This build has no "${kind}" protocol`, {
        details: { kind, supported: [...byKind.keys()] },
      });
    },
  };
}
```

### Additions to `packages/engine/src/project/model.ts` (Task 1.1)

```ts
/** A container whose kind has no enabled module: kept on disk exactly as it is (spec §6). */
export interface UnsupportedContainer {
  readonly dir: 'interfaces' | 'apis';
  readonly slug: string;
  /** As written in the container file. */
  readonly kind: string;
  readonly reason: 'unknown-kind' | 'feature-disabled';
  /** Read from the container file when present, for a placeholder row. */
  readonly name?: string;
  readonly order?: number;
}

// In `interface Project`, after `wsApis`:
  /**
   * Containers of a kind that has no list of its own above, keyed by kind. Absent means none.
   * Read with {@link extraContainersOf}.
   */
  readonly extraContainers?: Readonly<Record<string, readonly ContainerBase[]>>;
  /** Containers this build could not load and left untouched on disk. Absent means none. */
  readonly unsupported?: readonly UnsupportedContainer[];

/** The project's placeholders; empty when it has none. */
export function unsupportedOf(project: Project): readonly UnsupportedContainer[] {
  return project.unsupported ?? [];
}

/** The project's containers of `kind` kept in {@link Project.extraContainers}. */
export function extraContainersOf(project: Project, kind: string): readonly ContainerBase[] {
  return project.extraContainers?.[kind] ?? [];
}
```

`ContainerBase` is imported type-only from `../protocol/module.js`.

---

## Slice 1 — Registry, features and the run facet

After this slice the engine has the protocol module interface, the registry and the feature set, and the run path (`selectRequests`, `findStepRequest`, `createRunSender`, `checkRunScripts`, `secretNeedsOf`) asks the registry instead of branching on `kind`. Each built-in protocol's run code is in its own `run.ts`. Nothing a user can see changes, except the two edge cases written down in Task 1.7.

How to read the tasks of this slice:

- **Line numbers are those of the files at the start of the slice** (commit `f9c0411b`). Tasks 1.1 to 1.6 cut pieces out of the same four files one after another, so by the second task the numbers have shifted: the *name* of the function is what identifies it, the number says where it was.
- **A move is a cut and a paste.** The moved text is not printed again. A move table names each piece, where it is, and the only change allowed on the way (most often: it gains `export`). Anything not listed as a change stays byte for byte, comments included.
- After a move the source file's import block is printed in full. That block is the truth; ESLint's unused-import error is the check that nothing was left behind.
- All commands run from the repository root.
- **The safety net** for every task from 1.3 on is the existing tests, which must pass unchanged: `packages/engine/test/unit/run/{prepare,select,secret-needs,webhook-signing,grpc-subject,oauth2-token}.test.ts` (6 files, 75 tests), `packages/engine/test/unit/sequence/` (5 files, 39 tests), `packages/engine/test/integration/run/` (6 files, 34 tests), and from Task 1.2 on `packages/engine/test/unit/run/send-order.test.ts` (15 tests). No task of this slice edits one of them.

The tasks: 1.1 interface, registry, features, model additions, `run/context.ts` · 1.2 pinning test for the order of a send · 1.3 `run/tree.ts`, `run/scope.ts`, `run/send-helpers.ts` · 1.4 SOAP run module · 1.5 REST run module · 1.6 gRPC run module and the WebSocket module · 1.7 `protocols.ts` and core dispatch · 1.8 the `echo` test protocol, run half.

One file beyond the preamble's list appears in Task 1.3: `run/tree.ts`. The tree walk (`walkTree`, `findInTree`, `byOrder`) is used by the REST, gRPC and WebSocket modules and by `run/select.ts`; it cannot stay in `select.ts`, because `select.ts` imports `protocols.ts` from Task 1.7 on and a module that imported `select.ts` would close an import cycle.

---

### Task 1.1: The protocol interface, the registry, the feature set

**Files:**
- Create: `packages/engine/src/protocol/features.ts`, `packages/engine/src/protocol/module.ts`, `packages/engine/src/protocol/registry.ts`, `packages/engine/src/protocol/index.ts`
- Create: `packages/engine/src/run/context.ts` (`RunWorkspace`, `RunContext`, `scopesFor` moved out of `run/prepare.ts`)
- Modify: `packages/engine/src/project/model.ts` (one import, `UnsupportedContainer`, two `Project` fields, two readers)
- Modify: `packages/engine/src/run/prepare.ts` (loses the three moved pieces, re-exports them)
- Test: `packages/engine/test/unit/protocol/features.test.ts`, `registry.test.ts`, `module.test.ts` (new)

**Interfaces:**
- Consumes: the contract code of the preamble (`features.ts`, `module.ts`, `registry.ts`), `WirebenchError`, `createProject`.
- Produces:
  - everything the preamble's contract code exports, and `protocol/index.ts` re-exporting it
  - `interface UnsupportedContainer`, `Project.extraContainers?`, `Project.unsupported?`, `unsupportedOf(project)`, `extraContainersOf(project, kind)`
  - `run/context.ts`: `RunWorkspace`, `RunContext` (with the new `readonly registry?: ProtocolRegistry`), `scopesFor(context)`; `run/prepare.ts` still exports all three

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/unit/protocol/features.test.ts`, the file in full:

```ts
import { describe, expect, it } from 'vitest';
import { createFeatureSet } from '../../../src/protocol/features.js';
import type { FeatureDescriptor } from '../../../src/protocol/features.js';

function feature(id: string, extra: Partial<FeatureDescriptor> = {}): FeatureDescriptor {
  return { id, title: id.toUpperCase(), default: true, stage: 'stable', requires: [], ...extra };
}

describe('createFeatureSet', () => {
  it('turns a feature on or off by its default when no switch names it', () => {
    const set = createFeatureSet([feature('rest'), feature('beta', { default: false, stage: 'experimental' })]);
    expect(set.isEnabled('rest')).toBe(true);
    expect(set.whyDisabled('rest')).toBeUndefined();
    expect(set.isEnabled('beta')).toBe(false);
    expect(set.whyDisabled('beta')).toEqual({ by: 'switch' });
  });

  it('lets a switch override the default, both ways', () => {
    const set = createFeatureSet([feature('rest'), feature('beta', { default: false })], { rest: false, beta: true });
    expect(set.isEnabled('rest')).toBe(false);
    expect(set.whyDisabled('rest')).toEqual({ by: 'switch' });
    expect(set.isEnabled('beta')).toBe(true);
  });

  it('keeps a feature on while everything it requires is on', () => {
    const set = createFeatureSet([feature('rest'), feature('mocks', { requires: ['rest'] })]);
    expect(set.isEnabled('mocks')).toBe(true);
  });

  it('turns a feature off when one it requires is off, and names it', () => {
    const set = createFeatureSet(
      [feature('rest'), feature('mocks', { requires: ['rest'] }), feature('replay', { requires: ['mocks'] })],
      { rest: false },
    );
    expect(set.whyDisabled('mocks')).toEqual({ by: 'requires', feature: 'rest' });
    expect(set.whyDisabled('replay')).toEqual({ by: 'requires', feature: 'mocks' });
    expect(set.isEnabled('replay')).toBe(false);
  });

  it('says a switch before a requirement when both turn a feature off', () => {
    const set = createFeatureSet([feature('rest'), feature('mocks', { requires: ['rest'] })], {
      rest: false,
      mocks: false,
    });
    expect(set.whyDisabled('mocks')).toEqual({ by: 'switch' });
  });

  it('treats an id with no descriptor as off, and a feature requiring one as off too', () => {
    const set = createFeatureSet([feature('mocks', { requires: ['graphql'] })]);
    expect(set.isEnabled('graphql')).toBe(false);
    expect(set.whyDisabled('graphql')).toEqual({ by: 'unknown' });
    expect(set.whyDisabled('mocks')).toEqual({ by: 'requires', feature: 'graphql' });
  });

  it('ignores a switch for an id with no descriptor', () => {
    const set = createFeatureSet([feature('rest')], { graphql: true });
    expect(set.isEnabled('graphql')).toBe(false);
    expect(set.descriptors.map((descriptor) => descriptor.id)).toEqual(['rest']);
  });

  it('throws for a duplicate id', () => {
    expect(() => createFeatureSet([feature('rest'), feature('rest')])).toThrow(
      'createFeatureSet: duplicate feature "rest"',
    );
  });

  it('throws for a requires cycle, naming the path', () => {
    expect(() =>
      createFeatureSet([
        feature('a', { requires: ['b'] }),
        feature('b', { requires: ['c'] }),
        feature('c', { requires: ['a'] }),
      ]),
    ).toThrow('createFeatureSet: "requires" cycle: a -> b -> c -> a');
    expect(() => createFeatureSet([feature('self', { requires: ['self'] })])).toThrow('self -> self');
  });

  it('keeps the descriptors in the order given', () => {
    const set = createFeatureSet([feature('soap'), feature('rest'), feature('scripts')]);
    expect(set.descriptors.map((descriptor) => descriptor.id)).toEqual(['soap', 'rest', 'scripts']);
  });
});
```

`packages/engine/test/unit/protocol/registry.test.ts`, the file in full:

```ts
import { describe, expect, it } from 'vitest';
import { ProjectError, WirebenchError } from '../../../src/errors.js';
import type { FeatureDescriptor } from '../../../src/protocol/features.js';
import type { ProtocolModule } from '../../../src/protocol/module.js';
import { createProtocolRegistry, featureDisabled } from '../../../src/protocol/registry.js';

function module(kind: string, feature: Partial<FeatureDescriptor> = {}): ProtocolModule {
  return {
    kind,
    feature: { id: kind, title: kind.toUpperCase(), default: true, stage: 'stable', requires: [], ...feature },
  };
}

const SCRIPTS: FeatureDescriptor = { id: 'scripts', title: 'Scripts', default: true, stage: 'stable', requires: [] };

/** The error `run` throws, for assertions on its class, code and details. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('Nothing was thrown');
}

describe('createProtocolRegistry', () => {
  it('holds the enabled modules in registration order', () => {
    const registry = createProtocolRegistry([module('soap'), module('rest'), module('grpc')], {
      switches: { rest: false },
    });
    expect(registry.modules.map((m) => m.kind)).toEqual(['soap', 'grpc']);
  });

  it('builds its feature set from the modules and the extra features', () => {
    const registry = createProtocolRegistry([module('soap'), module('rest')], { features: [SCRIPTS] });
    expect(registry.features.descriptors.map((descriptor) => descriptor.id)).toEqual(['soap', 'rest', 'scripts']);
    expect(registry.features.isEnabled('scripts')).toBe(true);
  });

  it('answers status, find and require for an enabled kind', () => {
    const soap = module('soap');
    const registry = createProtocolRegistry([soap]);
    expect(registry.status('soap')).toBe('enabled');
    expect(registry.find('soap')).toBe(soap);
    expect(registry.require('soap')).toBe(soap);
  });

  it('answers disabled for a kind switched off, and require throws feature-disabled', () => {
    const registry = createProtocolRegistry([module('soap'), module('grpc')], { switches: { grpc: false } });
    expect(registry.status('grpc')).toBe('disabled');
    expect(registry.find('grpc')).toBeUndefined();
    const error = thrownBy(() => registry.require('grpc'));
    expect(error).toBeInstanceOf(WirebenchError);
    expect(error).toMatchObject({
      code: 'feature-disabled',
      message: 'GRPC is switched off',
      details: { feature: 'grpc' },
    });
  });

  it('names the required feature when that is what is off', () => {
    const registry = createProtocolRegistry([module('rest'), module('graphql', { requires: ['rest'] })], {
      switches: { rest: false },
    });
    expect(registry.status('graphql')).toBe('disabled');
    expect(thrownBy(() => registry.require('graphql'))).toMatchObject({
      code: 'feature-disabled',
      message: 'GRAPHQL is off because "rest" is off',
      details: { feature: 'graphql', requires: 'rest' },
    });
  });

  it('answers unknown for a kind with no module, and require throws project-kind-not-supported', () => {
    const registry = createProtocolRegistry([module('soap'), module('rest')]);
    expect(registry.status('graphql')).toBe('unknown');
    expect(registry.find('graphql')).toBeUndefined();
    const error = thrownBy(() => registry.require('graphql'));
    expect(error).toBeInstanceOf(ProjectError);
    expect(error).toMatchObject({
      code: 'project-kind-not-supported',
      message: 'This build has no "graphql" protocol',
      details: { kind: 'graphql', supported: ['soap', 'rest'] },
    });
  });

  it('does not take a feature that is not a protocol for a kind', () => {
    const registry = createProtocolRegistry([module('soap')], { features: [SCRIPTS] });
    expect(registry.status('scripts')).toBe('unknown');
  });

  it('throws for two modules of one kind', () => {
    expect(() => createProtocolRegistry([module('rest'), module('rest')])).toThrow(
      'createProtocolRegistry: two modules for "rest"',
    );
  });

  it('throws what the feature set throws', () => {
    expect(() => createProtocolRegistry([module('rest')], { features: [{ ...SCRIPTS, id: 'rest' }] })).toThrow(
      'createFeatureSet: duplicate feature "rest"',
    );
  });
});

describe('featureDisabled', () => {
  it('falls back to the id for a feature with no descriptor', () => {
    const registry = createProtocolRegistry([module('soap')]);
    expect(featureDisabled(registry.features, 'scripts')).toMatchObject({
      code: 'feature-disabled',
      message: 'scripts is switched off',
      details: { feature: 'scripts' },
    });
  });
});
```

`packages/engine/test/unit/protocol/module.test.ts`, the file in full:

```ts
import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { FeatureDescriptor } from '../../../src/protocol/features.js';
import { defineProtocol } from '../../../src/protocol/module.js';
import type { ProtocolRun, RunScope, SelectedBase } from '../../../src/protocol/module.js';
import type { SentRequest } from '../../../src/run/run.js';

interface PingSelected extends SelectedBase {
  readonly kind: 'ping';
}

const FEATURE: FeatureDescriptor = { id: 'ping', title: 'Ping', default: true, stage: 'stable', requires: [] };

const SENT: SentRequest = {
  subject: { protocol: 'rest', status: 200, durationMs: 0, bodyText: '', bodyKind: 'other' },
  raw: { rawRequest: new Uint8Array(), rawResponse: new Uint8Array() },
};

function selected(kind: string): SelectedBase {
  return { kind, path: 'Group/One', group: 'Group', request: { id: 'r1', name: 'One', slug: 'one' } };
}

const ping = selected('ping') as PingSelected;

const run: ProtocolRun<PingSelected> = {
  groups: () => [{ order: 0, name: 'Group', candidates: [{ item: ping, diskPath: 'apis/group/requests/one' }] }],
  whyNotRunnable: (_project, requestId) => (requestId === 'gone' ? 'gone' : undefined),
  send: () => Promise.resolve(SENT),
  scriptTypes: () => Promise.resolve({ generated: '' }),
  secretNeeds: () => [{ ref: 'ref-1', purpose: 'ping secret' }],
};

const project = createProject('P', { id: 'p1' });
const scope = { context: { project, projectDir: '/nowhere', overrides: {} } } as RunScope;

describe('defineProtocol', () => {
  it('throws when the feature id is not the kind', () => {
    expect(() => defineProtocol({ kind: 'ping', feature: { ...FEATURE, id: 'pong' } })).toThrow(
      'defineProtocol: the feature of "ping" must have the same id',
    );
  });

  it('leaves out the facets a module does not have', () => {
    const module = defineProtocol({ kind: 'ping', feature: FEATURE });
    expect(module).toEqual({ kind: 'ping', feature: FEATURE });
    expect('run' in module).toBe(false);
  });

  it('passes every call through for a request of its own kind', async () => {
    const module = defineProtocol({ kind: 'ping', feature: FEATURE, run });
    expect(module.run?.groups(project)[0]?.candidates[0]?.item).toBe(ping);
    expect(module.run?.whyNotRunnable(project, 'gone')).toBe('gone');
    expect(await module.run?.send(ping, scope)).toBe(SENT);
    expect(await module.run?.scriptTypes(ping, scope)).toEqual({ generated: '' });
    expect(module.run?.secretNeeds(ping, project)).toEqual([{ ref: 'ref-1', purpose: 'ping secret' }]);
  });

  it('throws when handed a request of another kind', () => {
    const module = defineProtocol({ kind: 'ping', feature: FEATURE, run });
    const other = selected('rest');
    const message = 'The "ping" protocol was handed a "rest" request';
    expect(() => module.run?.send(other, scope)).toThrow(message);
    expect(() => module.run?.scriptTypes(other, scope)).toThrow(message);
    expect(() => module.run?.secretNeeds(other, project)).toThrow(message);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/protocol`
Expected: FAIL, all three files: `src/protocol/features.js`, `registry.js` and `module.js` cannot be resolved.

- [ ] **Step 3: Create the three contract files**

Create `packages/engine/src/protocol/features.ts`, `module.ts` and `registry.ts` with exactly the code of the preamble's section *Contract code*, one block per file. Nothing is added and nothing is left out.

`module.ts` imports `RunContext` from `../run/context.js`, which Step 5 creates.

- [ ] **Step 4: Create `packages/engine/src/protocol/index.ts`**

The file in full:

```ts
/** Protocol modules, their registry and the feature set (spec §3, §4). */
export { createFeatureSet } from './features.js';
export type { FeatureDescriptor, FeatureSet, WhyDisabled } from './features.js';
export { defineProtocol } from './module.js';
export type {
  ContainerBase,
  ContainerDir,
  LoadContext,
  ProtocolModule,
  ProtocolRun,
  ProtocolScripting,
  ProtocolStorage,
  RequestSnapshotBase,
  ResponseSnapshotBase,
  RunGroup,
  RunScope,
  ScriptedSend,
  SelectedBase,
  SnapshotFacts,
} from './module.js';
export { createProtocolRegistry, featureDisabled } from './registry.js';
export type { ProtocolRegistry, ProtocolRegistryOptions } from './registry.js';
```

- [ ] **Step 5: Create `packages/engine/src/run/context.ts`**

The file starts with this header and these imports:

```ts
/**
 * What a run supplies around the saved requests it sends, and the property scopes they expand
 * against. Apart from the run's own files so a protocol module can take a `RunContext` without
 * importing the run loop.
 */
import type { HttpExchange, HttpRequest, ProxyOptions } from '../http/types.js';
import { resolveScopes } from '../project/environments.js';
import type { Project, PropertyMap } from '../project/model.js';
import type { PropertyScopes } from '../project/properties.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import type { RequestScripting } from '../script/request-scripts.js';
import type { SecretPlaceholders } from '../script/send.js';
import type { GetSecret } from '../secrets/resolve.js';
import { resolveWorkspaceScopes, withActiveEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import type { RunTokenSource } from './oauth2-token.js';
import type { SelectedRequest } from './select.js';
```

Then, in this order, cut from `packages/engine/src/run/prepare.ts` and paste:

| Piece | In `run/prepare.ts` | Change |
|---|---|---|
| `RunWorkspace` with its JSDoc | lines 63–70 | none |
| `RunContext` with its JSDoc | lines 72–124 | one new last field, below |
| `scopesFor` with its JSDoc | lines 146–164 | none |

`RunContext` gains this as its last field, after `containsKnownSecret`:

```ts
  /**
   * The protocol modules this run dispatches through, with their feature switches. Absent: the
   * built-in four with every feature on (`defaultRegistry()`).
   */
  readonly registry?: ProtocolRegistry;
```

- [ ] **Step 6: Make `run/prepare.ts` re-export what moved**

With the three pieces cut out, `prepare.ts` no longer uses `HttpExchange`, `HttpRequest`, `ProxyOptions`, `resolveScopes`, `PropertyMap`, `resolveWorkspaceScopes`, `Workspace` or `RequestScripting`. It gains two imports and two re-exports from `./context.js`. Its import block, from the first `import` to the line before the JSDoc of `PreparedSend`, is then exactly:

```ts
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { WirebenchError } from '../errors.js';
import { isInsideRealDir } from '../fs.js';
import { expandGrpcInput } from '../grpc/expand.js';
import type { GrpcSendInput } from '../grpc/send.js';
import type { TlsOptions } from '../http/types.js';
import { createFileAttachmentResolver, readAttachment } from '../project/attachments-cache.js';
import { resolveApiBaseUrl, resolveEndpoint } from '../project/environments.js';
import type { BaseUrlSource, EndpointSource } from '../project/environments.js';
import { toKeystoreDef } from '../project/keystores.js';
import type {
  Attachment,
  AttachmentSource,
  AuthConfig,
  Endpoint,
  Interface,
  Project,
  RequestDef,
} from '../project/model.js';
import type { PropertyScopes, UnresolvedRef } from '../project/properties.js';
import { expandSendInput } from '../project/properties.js';
import { toWssIncomingConfig, toWssOutgoingConfig } from '../project/wss-configs.js';
import { expandRestSendInput } from '../rest/expand.js';
import type { RestSendInput } from '../rest/send.js';
import { resolveAuthConfig, resolveSecretTokens, resolveSoapAuth } from '../secrets/resolve.js';
import type { GetSecret } from '../secrets/resolve.js';
import { toGrpcSendInput, toRestSendInput, toSendInput } from '../send-options.js';
import type { AttachmentResolvers } from '../send-options.js';
import type { SoapSendInput, SoapSendWss } from '../types.js';
import {
  resolveWorkspaceApiBaseUrl,
  resolveWorkspaceEndpoint,
  withActiveEnvironment,
} from '../workspace/environments.js';
import { signingSecretMissing, signingSecretRef } from '../webhooks/model.js';
import { effectiveWsa } from '../wsa/model.js';
import { loadKeystore, toTlsClientIdentity } from '../wss/keystore/index.js';
import type { Keystore } from '../wss/keystore/index.js';
import { createWssContext } from '../wss/model.js';
import { grpcEffectiveAuth, restEffectiveAuth, soapEffectiveAuth } from './effective-auth.js';
import { createRunTokenSource, requiredSecret } from './oauth2-token.js';
import type { RunTokenSource } from './oauth2-token.js';
import { secretNamesInValue } from './secret-needs.js';
import type { SecretPlaceholders } from '../script/send.js';
import type { SelectedRequest } from './select.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';

export { scopesFor } from './context.js';
export type { RunContext, RunWorkspace } from './context.js';
```

- [ ] **Step 7: Add to `packages/engine/src/project/model.ts`**

Four edits. After the import of `RequestScripts` (line 25):

```ts
import type { ContainerBase } from '../protocol/module.js';
```

Before the JSDoc of `interface Project` (line 408, `/** A whole Wirebench project, …`):

```ts
/** A container whose kind has no enabled module: kept on disk exactly as it is (spec §6). */
export interface UnsupportedContainer {
  readonly dir: 'interfaces' | 'apis';
  readonly slug: string;
  /** As written in the container file. */
  readonly kind: string;
  readonly reason: 'unknown-kind' | 'feature-disabled';
  /** Read from the container file when present, for a placeholder row. */
  readonly name?: string;
  readonly order?: number;
}
```

In `interface Project`, after the `wsApis` field and before the JSDoc of `sequences`:

```ts
  /**
   * Containers of a kind that has no list of its own above, keyed by kind. Absent means none.
   * Read with {@link extraContainersOf}.
   */
  readonly extraContainers?: Readonly<Record<string, readonly ContainerBase[]>>;
  /** Containers this build could not load and left untouched on disk. Absent means none. */
  readonly unsupported?: readonly UnsupportedContainer[];
```

After the closing brace of `interface Project`, before the JSDoc of `IdGenerator`:

```ts
/** The project's placeholders; empty when it has none. */
export function unsupportedOf(project: Project): readonly UnsupportedContainer[] {
  return project.unsupported ?? [];
}

/** The project's containers of `kind` kept in {@link Project.extraContainers}. */
export function extraContainersOf(project: Project, kind: string): readonly ContainerBase[] {
  return project.extraContainers?.[kind] ?? [];
}
```

`createProject` is not changed: both fields are optional and absent means none.

- [ ] **Step 8: Run the tests**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/protocol`
Expected: PASS, 3 files, 24 tests (`features` 10, `registry` 10, `module` 4).

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run packages/engine/test/unit/sequence`
Expected: PASS, 11 files, 114 tests, none of them edited.

- [ ] **Step 9: Format, check, commit**

```bash
pnpm exec prettier --write packages/engine/src/protocol packages/engine/src/run/context.ts packages/engine/src/run/prepare.ts packages/engine/src/project/model.ts packages/engine/test/unit/protocol
```

Prettier joins the three lines of `WhyDisabled` in `features.ts` into one. That is the only difference from the preamble's text and it is expected.

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/protocol packages/engine/src/run/context.ts packages/engine/src/run/prepare.ts packages/engine/src/project/model.ts packages/engine/test/unit/protocol
git commit -m "feat(engine): protocol module interface, registry and feature set (#184)"
```

Expected: `pnpm check` green.

---

### Task 1.2: Pin the order of operations in a send

This test is written against the code as it is, before anything about a send moves. It passes at once; that is the point. It records, per protocol, the order in which a send asks for a secret, fetches an OAuth2 token, loads the contract, runs a script and reaches the wire, and what a refused token does. Tasks 1.3 to 1.7 must leave it passing without an edit.

**Files:**
- Test: `packages/engine/test/unit/run/send-order.test.ts` (new)

**Interfaces:**
- Consumes: `createRunSender`, `runRequests`, `selectRequests`, `RunContext` as they are exported today; `vi.mock` of `src/send.js`, `src/rest/send.js`, `src/grpc/call.js` and the definition loaders, so no socket is opened.
- Produces: nothing a later task imports.

- [ ] **Step 1: Write the test**

`packages/engine/test/unit/run/send-order.test.ts`, the file in full:

```ts
/**
 * Pins the order of operations inside one send, per protocol: which secret is asked for when, when
 * the OAuth2 token is fetched, when the contract is loaded, when the scripts run, and what a refused
 * token does to the run's token source. Written against the run module before the protocols became
 * modules, and unchanged by that move.
 *
 * Nothing here reaches the network: the three senders and the three contract loaders are replaced by
 * recorders, so the only thing under test is the order of the calls.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import type { HttpExchange } from '../../../src/http/types.js';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Interface, OAuth2Auth, Project, SoapRequestDef } from '../../../src/project/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import { createApi, createRestRequest, entry } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { createRunSender } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import type { SelectedRequest } from '../../../src/run/select.js';
import type { RequestScripts, ScriptOutcome } from '../../../src/script/model.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import type { ScriptSandbox } from '../../../src/script/sandbox/host.js';
import { createWebhookCollection } from '../../../src/webhooks/model.js';
import { normalizeWsa } from '../../../src/wsa/model.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const { events, wire } = vi.hoisted(() => ({
  events: [] as string[],
  /** What the recorded senders answer with. */
  wire: { httpStatus: 200, grpcStatus: 0 },
}));

vi.mock('../../../src/wsdl/cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/wsdl/cache.js')>()),
  readDefinitionCache: () => {
    events.push('load definition');
    return Promise.reject(new Error('this test has no definition cache'));
  },
}));

vi.mock('../../../src/grpc/cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/grpc/cache.js')>();
  return {
    ...actual,
    readGrpcDefinitionCache: (...args: Parameters<typeof actual.readGrpcDefinitionCache>) => {
      events.push('load proto set');
      return actual.readGrpcDefinitionCache(...args);
    },
  };
});

vi.mock('../../../src/script/contracts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/script/contracts.js')>()),
  loadOpenApiDocument: () => {
    events.push('load openapi');
    return Promise.resolve(undefined);
  },
}));

vi.mock('../../../src/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/send.js')>()),
  sendSoapRequest: () => {
    events.push('send');
    return Promise.resolve({
      http: {
        request: { url: 'https://soap.example.test/billing', method: 'POST', headers: {} },
        status: wire.httpStatus,
        statusText: '',
        headers: {},
        rawHeaders: [],
        body: new Uint8Array(),
        rawRequest: new Uint8Array(),
        rawResponse: new Uint8Array(),
      },
      durationMs: 1,
      problems: [],
    });
  },
}));

vi.mock('../../../src/rest/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/rest/send.js')>()),
  sendRest: () => {
    events.push('send');
    return Promise.resolve({
      request: { url: 'https://api.example.test/invoices', method: 'GET', headers: {} },
      status: wire.httpStatus,
      statusText: '',
      headers: {},
      rawHeaders: [],
      body: new Uint8Array(),
      rawRequest: new Uint8Array(),
      rawResponse: new Uint8Array(),
      text: '{}',
      language: 'json',
      cookies: [],
      methodChanged: false,
      durationMs: 1,
    });
  },
}));

vi.mock('../../../src/grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/grpc/call.js')>()),
  callGrpc: () => {
    events.push('send');
    return Promise.resolve({
      exchange: {
        status: wire.grpcStatus,
        statusName: '',
        headers: {},
        trailers: {},
        rawRequest: new Uint8Array(),
        rawResponse: new Uint8Array(),
        durationMs: 1,
      },
      methodKind: 'unary',
      requestType: '',
      responseType: '',
      requestMessages: [],
      responseMessages: [{ json: { message: 'Hello' } }],
    });
  },
}));

const AUTH: OAuth2Auth = {
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: 'https://auth.example.test/token',
  clientId: 'client',
  clientSecretRef: 'ref-client',
  scopes: [],
  clientAuth: 'basic',
  pkce: false,
};

const SECRETS: Readonly<Record<string, string>> = {
  'ref-client': 'abc123def456ghi789',
  'ref-hooks': 'abc123def456ghi789',
  'secret:tenant': 'abc123def456ghi789',
  'secret:signing': 'abc123def456ghi789',
};

/** Both scripts, and one secret the scripts list for `secrets.get`. */
const SCRIPTS: RequestScripts = {
  api: 'wirebench',
  enabled: true,
  secrets: ['signing'],
  pre: { text: '' },
  post: { text: '' },
};

const NOTHING = { tests: [], values: [], log: { lines: [], truncated: false } } as const;

/** A script host that records when it is asked to check and to run, and runs nothing. */
class RecordingScripting extends RequestScripting {
  constructor() {
    super({ sandbox: {} as ScriptSandbox });
  }

  override check(): Promise<void> {
    events.push('check');
    return Promise.resolve();
  }

  override pre(): Promise<Extract<ScriptOutcome, { ok: true }>> {
    events.push('pre');
    return Promise.resolve({ ok: true, ...NOTHING });
  }

  override post(): Promise<ScriptOutcome> {
    events.push('post');
    return Promise.resolve({ ok: true, ...NOTHING });
  }
}

/** One request per protocol, each behind the same OAuth2 configuration and holding one secret token. */
function project(scripts?: RequestScripts): Project {
  const withScripts = scripts !== undefined ? { scripts } : {};
  const soapRequest: SoapRequestDef = {
    kind: 'soap',
    id: 'req-soap',
    name: 'Get',
    slug: 'get',
    order: 0,
    soapVersion: '1.1',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: '<Envelope>${secret:tenant}</Envelope>',
    endpointId: 'ep-1',
    auth: AUTH,
    ...withScripts,
  };
  const iface: Interface = {
    kind: 'soap',
    id: 'iface-billing',
    name: 'Billing',
    slug: 'Billing',
    order: 0,
    definitionUrl: 'http://example.test/def.wsdl',
    cacheDefinition: true,
    endpoints: [{ id: 'ep-1', name: 'default', url: 'https://soap.example.test/billing', authMode: 'override' }],
    wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
    operations: [{ name: 'Op', bindingName: '{urn:t}B', slug: 'op', order: 0, requests: [soapRequest] }],
  };
  const api = createApi('Invoices', {
    id: 'api-invoices',
    slug: 'invoices',
    order: 1,
    baseUrl: 'https://api.example.test',
    auth: AUTH,
    requests: [
      {
        ...createRestRequest('List', {
          id: 'req-rest',
          url: '/invoices',
          headers: [entry('X-Tenant', '${secret:tenant}')],
        }),
        ...withScripts,
      },
    ],
  });
  const grpcApi = (name: string, slug: string, order: number) =>
    createGrpcApi(name, {
      id: `api-${slug}`,
      slug,
      order,
      target: 'localhost:50051',
      tls: false,
      auth: AUTH,
      requests: [
        {
          ...createGrpcRequest('Hello', {
            id: `req-${slug}`,
            service: 'wirebench.greet.Greeter',
            method: 'SayHello',
            message: '{"name":"${secret:tenant}"}',
          }),
          ...withScripts,
        },
      ],
    });
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-order',
    name: 'Order',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [iface],
    apis: [api],
    grpcApis: [grpcApi('Greeter', 'greeter', 2), grpcApi('Uncached', 'uncached', 3)],
    wsApis: [],
    sequences: [],
    webhooks: createWebhookCollection({
      target: 'https://receiver.example.test/hooks',
      signing: {
        mode: 'sign',
        scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
        secretRef: 'ref-hooks',
      },
      requests: [
        createRestRequest('Ping', {
          id: 'req-hook',
          slug: 'ping',
          method: 'POST',
          url: '/ping',
          headers: [entry('X-Tenant', '${secret:tenant}')],
        }),
      ],
    }),
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}

let dir: string;
let issued = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-send-order-'));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  events.length = 0;
  issued = 0;
  wire.httpStatus = 200;
  wire.grpcStatus = 0;
});

/** A token endpoint that hands out `tok-1`, `tok-2`, … and records each request. */
const fetchToken: NonNullable<RunContext['fetchToken']> = (request) => {
  events.push('fetch token');
  issued += 1;
  const body = new TextEncoder().encode(
    JSON.stringify({ access_token: `tok-${String(issued)}`, token_type: 'Bearer', expires_in: 3600 }),
  );
  return Promise.resolve({
    request: { url: request.url, method: 'POST', headers: {} },
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body,
    rawBody: body,
  } as unknown as HttpExchange);
};

function contextFor(p: Project, scripting: boolean): RunContext {
  return {
    project: p,
    projectDir: dir,
    overrides: {},
    getSecret: (ref) => {
      events.push(`secret ${ref}`);
      return Promise.resolve(SECRETS[ref]);
    },
    fetchToken,
    ...(scripting ? { scripting: new RecordingScripting() } : {}),
  };
}

function pick(p: Project, path: string): SelectedRequest {
  const [item] = selectRequests(p, [path]).selected;
  if (item === undefined) {
    throw new Error(`No request at ${path}`);
  }
  return item;
}

/** What one send of the request at `path` did, in order. */
async function orderOf(path: string, scripts?: RequestScripts): Promise<readonly string[]> {
  const p = project(scripts);
  await createRunSender(contextFor(p, scripts !== undefined))(pick(p, path));
  return [...events];
}

/** Sends the request at `path` twice through one sender, the first answered as `refuse` sets it. */
async function tokensFetched(path: string, refuse: () => void): Promise<number> {
  const p = project();
  const send = createRunSender(contextFor(p, false));
  refuse();
  await send(pick(p, path));
  wire.httpStatus = 200;
  wire.grpcStatus = 0;
  await send(pick(p, path));
  return events.filter((event) => event === 'fetch token').length;
}

const PLAIN = ['secret ref-client', 'fetch token', 'secret secret:tenant', 'send'];
const SCRIPTED = [
  'check',
  'secret ref-client',
  'fetch token',
  'secret secret:signing',
  'pre',
  'secret secret:tenant',
  'send',
  'post',
];

describe('the order of operations in a SOAP send', () => {
  it('loads the definition, fetches the token, resolves the secret tokens, then sends', async () => {
    expect(await orderOf('Billing/Op/Get')).toEqual(['load definition', ...PLAIN]);
  });

  it('checks the scripts before anything is asked for, and puts the secrets back after the pre-request script', async () => {
    expect(await orderOf('Billing/Op/Get', SCRIPTS)).toEqual(['load definition', ...SCRIPTED]);
  });

  it('drops the token after a 401, and keeps it after a 403', async () => {
    expect(await tokensFetched('Billing/Op/Get', () => (wire.httpStatus = 401))).toBe(2);
    events.length = 0;
    expect(await tokensFetched('Billing/Op/Get', () => (wire.httpStatus = 403))).toBe(1);
  });
});

describe('the order of operations in a REST send', () => {
  it('fetches the token, resolves the secret tokens, then sends, and loads no contract', async () => {
    expect(await orderOf('Invoices/List')).toEqual(PLAIN);
  });

  it('loads the OpenAPI document only for a request with scripts, before the check', async () => {
    expect(await orderOf('Invoices/List', SCRIPTS)).toEqual(['load openapi', ...SCRIPTED]);
  });

  it('reads a webhook item’s signing secret after its secret tokens', async () => {
    expect(await orderOf('Webhooks/Ping')).toEqual(['secret secret:tenant', 'secret ref-hooks', 'send']);
  });

  it('sends a request whose scripts are switched off as one without scripts, and says so', async () => {
    const p = project({ ...SCRIPTS, enabled: false });
    const sent = await createRunSender(contextFor(p, true))(pick(p, 'Invoices/List'));
    expect(sent.scriptsOff).toBe(true);
    expect(sent.script).toBeUndefined();
    expect(events).toEqual(PLAIN);
  });

  it('drops the token after a 401, and keeps it after a 403', async () => {
    expect(await tokensFetched('Invoices/List', () => (wire.httpStatus = 401))).toBe(2);
    events.length = 0;
    expect(await tokensFetched('Invoices/List', () => (wire.httpStatus = 403))).toBe(1);
  });
});

describe('the order of operations in a gRPC send', () => {
  it('loads the schema before it fetches the token', async () => {
    expect(await orderOf('Greeter/Hello')).toEqual(['load proto set', ...PLAIN]);
  });

  it('loads the schema once for the check and the send', async () => {
    expect(await orderOf('Greeter/Hello', SCRIPTS)).toEqual(['load proto set', ...SCRIPTED]);
  });

  it('remembers a schema that did not load, and asks for nothing', async () => {
    const p = project();
    const send = createRunSender(contextFor(p, false));
    await expect(send(pick(p, 'Uncached/Hello'))).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    await expect(send(pick(p, 'Uncached/Hello'))).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    expect(events).toEqual(['load proto set']);
  });

  it('drops the token after UNAUTHENTICATED, and keeps it after PERMISSION_DENIED', async () => {
    expect(await tokensFetched('Greeter/Hello', () => (wire.grpcStatus = 16))).toBe(2);
    events.length = 0;
    expect(await tokensFetched('Greeter/Hello', () => (wire.grpcStatus = 7))).toBe(1);
  });
});

describe('a request with scripts in a run that cannot run them', () => {
  it.each(['Billing/Op/Get', 'Invoices/List', 'Greeter/Hello'])(
    'refuses %s before any secret, token or send',
    async (path) => {
      const p = project(SCRIPTS);
      await expect(createRunSender(contextFor(p, false))(pick(p, path))).rejects.toMatchObject({
        code: 'script-unavailable',
      });
      expect(events.filter((event) => !event.startsWith('load '))).toEqual([]);
    },
  );
});
```

- [ ] **Step 2: Run it**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run/send-order.test.ts`
Expected: PASS, 15 tests.

If a test fails here, the code is the truth and the expectation is wrong: correct the expected list in the test until it describes what the code does, and only then go on. Nothing in `src/` is changed in this task.

- [ ] **Step 3: Format, check, commit**

```bash
pnpm exec prettier --write packages/engine/test/unit/run/send-order.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/test/unit/run/send-order.test.ts
git commit -m "test(engine): pin the order of operations in a send, per protocol (#184)"
```

Expected: `pnpm check` green.

---

### Task 1.3: The run's shared helpers, tree walk and scope

Pure moves, plus `createRunScope`. After this task `run/prepare.ts`, `run/run.ts`, `run/secret-needs.ts` and `run/select.ts` still hold every protocol branch; they only import their helpers from three new files a protocol module can import too.

**Files:**
- Create: `packages/engine/src/run/scope.ts`, `packages/engine/src/run/tree.ts`, `packages/engine/src/run/send-helpers.ts`
- Modify: `packages/engine/src/run/prepare.ts`, `packages/engine/src/run/run.ts`, `packages/engine/src/run/secret-needs.ts`, `packages/engine/src/run/select.ts`
- Test: `packages/engine/test/unit/run/scope.test.ts` (new)

**Interfaces:**
- Consumes: `RunScope` (`protocol/module.ts`), `RunContext`, `scopesFor` (`run/context.ts`).
- Produces:
  - `run/scope.ts`: `createRunScope(context: RunContext): RunScope`, `scopeWith(scope: RunScope, context: RunContext): RunScope`
  - `run/tree.ts`: `byOrder`, `ORPHANED_STEP_REASON`, `TreeRequest`, `TreeFolder<F, R>`, `walkTree<F, R, S>(node, chain, group, diskDir, make, out)`, `RequestTree<R>`, `findInTree<R>(tree, id)`
  - `run/send-helpers.ts`: `secretNamesInValue`, `withSecrets`, `unresolvedError`, `insideProject`, `loadKeystoreById`, `clientIdentityFor`, `tlsFor`, `tokenSourceOf`, `authFor`, `baseUrlFor`, `dropRefusedToken`, `originOf`, `present`, `keystoreNeeds`
  - `run/prepare.ts` still exports `authFor`; `run/secret-needs.ts` still exports `secretNamesInValue`

- [ ] **Step 1: Write the failing test for the scope**

`packages/engine/test/unit/run/scope.test.ts`, the file in full:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunScope, scopeWith } from '../../../src/run/scope.js';

const context: RunContext = {
  project: createProject('P', { id: 'p1' }),
  projectDir: '/nowhere',
  overrides: {},
  getSecret: () => Promise.resolve(undefined),
};

describe('createRunScope', () => {
  it('carries the context it was given', () => {
    expect(createRunScope(context).context).toBe(context);
  });

  it('loads a key once and hands every caller the same value', async () => {
    const scope = createRunScope(context);
    const load = vi.fn(() => Promise.resolve({ loaded: true }));
    const first = await scope.memo('soap:i1:definition', load);
    const second = await scope.memo('soap:i1:definition', load);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps each key apart', async () => {
    const scope = createRunScope(context);
    expect(await scope.memo('rest:a1:openapi', () => Promise.resolve('a'))).toBe('a');
    expect(await scope.memo('rest:a2:openapi', () => Promise.resolve('b'))).toBe('b');
  });

  it('remembers a load that rejected, and rejects again without loading', async () => {
    const scope = createRunScope(context);
    const load = vi.fn(() => Promise.reject(new Error('no cache')));
    await expect(scope.memo('grpc:a1:proto-set', load)).rejects.toThrow('no cache');
    await expect(scope.memo('grpc:a1:proto-set', load)).rejects.toThrow('no cache');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not share its cache with another scope', async () => {
    const load = vi.fn(() => Promise.resolve(1));
    await createRunScope(context).memo('k', load);
    await createRunScope(context).memo('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('scopeWith', () => {
  it('swaps the context and keeps the cache', async () => {
    const scope = createRunScope(context);
    const other: RunContext = { ...context, timeoutMs: 5 };
    const derived = scopeWith(scope, other);
    const load = vi.fn(() => Promise.resolve('once'));
    await scope.memo('k', load);
    expect(await derived.memo('k', load)).toBe('once');
    expect(load).toHaveBeenCalledTimes(1);
    expect(derived.context).toBe(other);
    expect(scope.context).toBe(context);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run/scope.test.ts`
Expected: FAIL: `src/run/scope.js` cannot be resolved.

- [ ] **Step 3: Create `packages/engine/src/run/scope.ts`**

The file in full:

```ts
/** What a protocol module is given for one run: the run's context and its one cache (spec §3.3). */
import type { RunScope } from '../protocol/module.js';
import type { RunContext } from './context.js';

/**
 * A scope for one run. `memo` keeps one value per key for the scope's lifetime: a compiled WSDL, a
 * proto set, an OpenAPI document. A load that rejects is remembered too, since nothing in a run can
 * fix a cache, and every later request behind the key reports the same error.
 */
export function createRunScope(context: RunContext): RunScope {
  const loads = new Map<string, Promise<unknown>>();
  return {
    context,
    memo<T>(key: string, load: () => Promise<T>): Promise<T> {
      const known = loads.get(key) as Promise<T> | undefined;
      if (known !== undefined) {
        return known;
      }
      const loading = load();
      // Observed here so a rejection nobody awaits yet is never reported as unhandled.
      loading.catch(() => undefined);
      loads.set(key, loading);
      return loading;
    },
  };
}

/** `scope` with another context and the same cache: what one request of the run is sent with. */
export function scopeWith(scope: RunScope, context: RunContext): RunScope {
  return { context, memo: (key, load) => scope.memo(key, load) };
}
```

`scopeWith` wraps `memo` in an arrow function instead of passing `scope.memo` along, so the method is never detached from its object (`@typescript-eslint/unbound-method`).

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run/scope.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 4: Create `packages/engine/src/run/tree.ts` and take the walk out of `run/select.ts`**

`tree.ts` is made of five pieces of `run/select.ts`: `byOrder` (lines 50–51), `TreeRequest`, `TreeFolder` and `TreeChild` (53–70), `walkTree` (72–115), `RequestTree` (257–260) and `findInTree` (262–277). They change on the way: everything but `TreeChild` is exported, `walkTree` gains a third type parameter `S` for what `make` returns, its `out` is typed by shape instead of by `select.ts`'s `Candidate`, and `ORPHANED_STEP_REASON` is new (the string `findStepRequest` uses inline today; the modules need it from Task 1.4 on). Because of those changes the file is printed in full:

```ts
/**
 * Walking a container's tree of folders and requests, as the REST, gRPC and WebSocket modules all
 * keep one. Core code: it names no protocol.
 */

/** Explorer order: by `order`, then by name. */
export const byOrder = <T extends { readonly order: number; readonly name: string }>(a: T, b: T): number =>
  a.order - b.order || a.name.localeCompare(b.name);

/** Why a request its contract no longer has cannot be a sequence step. */
export const ORPHANED_STEP_REASON = 'The request is no longer in its contract (orphaned)';

/** What a tree's request has, as far as the walk cares. */
export interface TreeRequest {
  readonly order: number;
  readonly name: string;
  readonly slug: string;
}

/** What a tree's folder has, as far as the walk cares. */
export interface TreeFolder<F, R> {
  readonly order: number;
  readonly name: string;
  readonly slug: string;
  readonly folders: readonly F[];
  readonly requests: readonly R[];
}

/** A folder's request or sub-folder child, tagged so the sort below need not narrow a union. */
type TreeChild<F, R> =
  | { readonly tag: 'request'; readonly order: number; readonly name: string; readonly request: R }
  | { readonly tag: 'folder'; readonly order: number; readonly name: string; readonly folder: F };

/**
 * Walks a request tree in explorer order. `make` turns a request the protocol can run into its
 * selection, or answers `undefined` for one it skips (orphaned, streaming). Each selection is pushed
 * to `out` with the request's path on disk, without the `.request.yaml` suffix.
 */
export function walkTree<F extends TreeFolder<F, R>, R extends TreeRequest, S>(
  node: { readonly folders: readonly F[]; readonly requests: readonly R[] },
  chain: readonly F[],
  group: string,
  diskDir: string,
  make: (request: R, chain: readonly F[], group: string) => S | undefined,
  out: { item: S; diskPath: string }[],
): void {
  const children: TreeChild<F, R>[] = [
    ...node.requests.map((request): TreeChild<F, R> => ({
      tag: 'request',
      order: request.order,
      name: request.name,
      request,
    })),
    ...node.folders.map((folder): TreeChild<F, R> => ({
      tag: 'folder',
      order: folder.order,
      name: folder.name,
      folder,
    })),
  ].sort(byOrder);
  for (const child of children) {
    if (child.tag === 'request') {
      const item = make(child.request, chain, group);
      if (item !== undefined) {
        out.push({ item, diskPath: `${diskDir}/${child.request.slug}` });
      }
    } else {
      walkTree(
        child.folder,
        [...chain, child.folder],
        `${group}/${child.folder.name}`,
        `${diskDir}/${child.folder.slug}`,
        make,
        out,
      );
    }
  }
}

/** A tree of folders and requests, as far as a lookup by id cares. */
export interface RequestTree {
  readonly folders: readonly RequestTree[];
  readonly requests: readonly { readonly id: string }[];
}

/** The request with `id` anywhere in `tree`, depth-first. */
export function findInTree<R extends { readonly id: string }>(
  tree: { readonly folders: readonly RequestTree[]; readonly requests: readonly R[] },
  id: string,
): R | undefined {
  const own = tree.requests.find((request) => request.id === id);
  if (own !== undefined) {
    return own;
  }
  for (const folder of tree.folders) {
    const found = findInTree(folder as typeof tree, id);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}
```

In `run/select.ts`: delete lines 50–115 and 257–277, and add one import after the last existing one. The import block is then exactly:

```ts
import type { GrpcApi, GrpcFolder, GrpcRequestDef } from '../grpc/model.js';
import type { Interface, OperationDef, Project, SoapRequestDef } from '../project/model.js';
import { WEBHOOKS_DIR, REQUESTS_DIR } from '../project/paths.js';
import type { RestApi, RestFolder, RestRequestDef } from '../rest/model.js';
import { createApi } from '../rest/model.js';
import type { EffectiveSigning, WebhookCollection, WebhookFolder } from '../webhooks/model.js';
import { effectiveSigning, effectiveTarget } from '../webhooks/model.js';
import { byOrder, findInTree, walkTree } from './tree.js';
```

The two calls of `walkTree` name the new type parameter. In `walkRest`:

```ts
  walkTree<RestFolder, RestRequestDef, SelectedRequest>(
```

In `walkGrpc`:

```ts
  walkTree<GrpcFolder, GrpcRequestDef, SelectedRequest>(
```

`Candidate` (lines 42–48) stays in `select.ts`; it has the shape `walkTree`'s `out` asks for.

- [ ] **Step 5: Create `packages/engine/src/run/send-helpers.ts`**

The file starts with this header and these imports:

```ts
/**
 * What the protocol modules share when they prepare and send a request in a run: secret tokens,
 * the project-folder boundary, keystores and TLS, OAuth2 tokens, the base URL an environment
 * overrides, and the secret a keystore needs. Core code: it names no protocol.
 */
import { readFile, stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { WirebenchError } from '../errors.js';
import { isInsideRealDir } from '../fs.js';
import type { TlsOptions } from '../http/types.js';
import { resolveApiBaseUrl } from '../project/environments.js';
import type { BaseUrlSource } from '../project/environments.js';
import { toKeystoreDef } from '../project/keystores.js';
import type { AuthConfig, Project } from '../project/model.js';
import { secretNamesIn } from '../project/properties.js';
import type { PropertyScopes, UnresolvedRef } from '../project/properties.js';
import { urlOrigin } from '../project/sequence-guards.js';
import type { SecretPlaceholders } from '../script/send.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { resolveAuthConfig, resolveSecretTokens } from '../secrets/resolve.js';
import type { GetSecret } from '../secrets/resolve.js';
import type { SendAuth } from '../types.js';
import { resolveWorkspaceApiBaseUrl, withActiveEnvironment } from '../workspace/environments.js';
import { loadKeystore, toTlsClientIdentity } from '../wss/keystore/index.js';
import type { Keystore } from '../wss/keystore/index.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import { createRunTokenSource, requiredSecret } from './oauth2-token.js';
import type { RunTokenSource } from './oauth2-token.js';

```

Then, in this order, cut and paste. Each piece comes with the JSDoc that is directly above it today.

| Piece | From (lines at the start of the slice) | Change |
|---|---|---|
| `secretNamesInValue` | `run/secret-needs.ts` 24–45 | none (already exported) |
| `withSecrets` | `run/prepare.ts` 199–215 | gains `export` |
| `unresolvedError` | `run/prepare.ts` 217–224 | gains `export` and the JSDoc below |
| `insideProject` | `run/prepare.ts` 226–237 | gains `export` |
| `loadKeystoreById` | `run/prepare.ts` 239–258 | gains `export` |
| `clientIdentityFor` | `run/prepare.ts` 260–274 | gains `export` (prettier then breaks its signature over four lines) |
| `tlsFor` | `run/prepare.ts` 276–288 | gains `export` |
| `tokenSourceOf` | `run/prepare.ts` 442–452 | gains `export` |
| `authFor` | `run/prepare.ts` 454–486 | none (already exported) |
| `baseUrlFor` | `run/prepare.ts` 184–197 | gains `export` |
| `dropRefusedToken` | `run/run.ts` 327–336 | gains `export` |
| `originOf` | `run/run.ts` 588–591 | gains `export` and the JSDoc below |
| `present` | `run/secret-needs.ts` 53 | gains `export` and the JSDoc below |
| `keystoreNeeds` | `run/secret-needs.ts` 55–79 | gains `export` |

The three that had no JSDoc get one, directly above them:

```ts
/** The refusal for a request whose text holds property references nothing resolves. */
```

```ts
/** The origin a request went to, as a sent request reports it; nothing for a URL without one. */
```

```ts
/** True for a reference that is set: neither absent nor empty. */
```

`secretNamesInValue` and `present` are here, and not in `run/secret-needs.ts`, for the same reason the tree walk has its own file: from Task 1.7 on `secret-needs.ts` imports `protocols.ts`, and the modules need both.

- [ ] **Step 6: Fix the three source files' imports**

`run/prepare.ts`: lines 184–288 and 442–486 are gone. It imports seven of the helpers and re-exports `authFor`, which it has always exported. Its import block is then exactly:

```ts
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { WirebenchError } from '../errors.js';
import { expandGrpcInput } from '../grpc/expand.js';
import type { GrpcSendInput } from '../grpc/send.js';
import { createFileAttachmentResolver, readAttachment } from '../project/attachments-cache.js';
import { resolveEndpoint } from '../project/environments.js';
import type { EndpointSource } from '../project/environments.js';
import type { Attachment, AttachmentSource, Endpoint, Interface, Project, RequestDef } from '../project/model.js';
import type { PropertyScopes } from '../project/properties.js';
import { expandSendInput } from '../project/properties.js';
import { toWssIncomingConfig, toWssOutgoingConfig } from '../project/wss-configs.js';
import { expandRestSendInput } from '../rest/expand.js';
import type { RestSendInput } from '../rest/send.js';
import { resolveSoapAuth } from '../secrets/resolve.js';
import { toGrpcSendInput, toRestSendInput, toSendInput } from '../send-options.js';
import type { AttachmentResolvers } from '../send-options.js';
import type { SoapSendInput, SoapSendWss } from '../types.js';
import { resolveWorkspaceEndpoint, withActiveEnvironment } from '../workspace/environments.js';
import { signingSecretMissing, signingSecretRef } from '../webhooks/model.js';
import { effectiveWsa } from '../wsa/model.js';
import { createWssContext } from '../wss/model.js';
import { grpcEffectiveAuth, restEffectiveAuth, soapEffectiveAuth } from './effective-auth.js';
import { requiredSecret } from './oauth2-token.js';
import type { SelectedRequest } from './select.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import {
  authFor,
  baseUrlFor,
  insideProject,
  loadKeystoreById,
  tlsFor,
  unresolvedError,
  withSecrets,
} from './send-helpers.js';

export { authFor } from './send-helpers.js';
export { scopesFor } from './context.js';
export type { RunContext, RunWorkspace } from './context.js';
```

`run/run.ts`: lines 327–336 and 588–591 are gone. It loses `SendAuth` from its `../types.js` import and the import of `urlOrigin`, and gains one line. Its import block is then exactly:

```ts
import { isCallbackAssertion, sendAwaitingCallbacks } from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import { evaluateAssertions } from '../assert/index.js';
import type { Assertion, AssertionResult, AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import { readGrpcDefinitionCache } from '../grpc/cache.js';
import { callGrpc } from '../grpc/call.js';
import type { GrpcCallResult } from '../grpc/call.js';
import { loadProtoSet } from '../grpc/proto/load.js';
import type { ProtoSet } from '../grpc/proto/load.js';
import { protoSetFromDescriptorSet } from '../grpc/reflection/descriptors.js';
import { apiDefinitionDir, definitionCacheDir } from '../project/paths.js';
import { sendRest } from '../rest/send.js';
import type { RestExchange } from '../rest/send.js';
import { sendSoapRequest } from '../send.js';
import type { SoapExchange } from '../types.js';
import { bindingContextFor, validateMessage } from '../validate/index.js';
import { summarizeWsa } from '../wsa/policy-detect.js';
import { parseWsdlBundle } from '../wsdl/merge.js';
import type { WsdlDefinition } from '../wsdl/model.js';
import { readDefinitionCache } from '../wsdl/cache.js';
import type { DefinitionBundle } from '../wsdl/resolver.js';
import { buildSchemaSet } from '../xsd/schema-set.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import { createRunTokenSource } from './oauth2-token.js';
import { prepareSend, scopesFor } from './prepare.js';
import { dropRefusedToken, originOf } from './send-helpers.js';
import type { RunContext } from './prepare.js';
import type { SelectedRequest } from './select.js';
import type { TransferResult } from '../sequence/run.js';
import { expandSendInput } from '../project/properties.js';
import type { OpenApiDocument } from '../rest/openapi/model.js';
import { loadOpenApiDocument } from '../script/contracts.js';
import { scriptProperties } from '../script/props.js';
import {
  activeScripts,
  type RequestScripting,
  type ScriptedRequest,
  type ScriptRunValues,
} from '../script/request-scripts.js';
import {
  SecretPlaceholders,
  applyGrpcSnapshot,
  applyRestSnapshot,
  applySoapSnapshot,
  grpcRequestSnapshot,
  grpcResponseSnapshot,
  restRequestSnapshot,
  restResponseSnapshot,
  soapRequestSnapshot,
  soapResponseSnapshot,
} from '../script/send.js';
import {
  listedSecrets,
  mergeScriptValues,
  scriptAssertions,
  scriptSession,
  scriptTypesFor,
  type SentScripts,
} from './script-support.js';
```

`run/secret-needs.ts`: lines 24–45 and 53–79 are gone. It loses the imports of `toKeystoreDef` and `secretNamesIn`, gains one import, and re-exports `secretNamesInValue`, which `run/index.ts` exports from here. Its import block is then exactly:

```ts
import { resolveScopes } from '../project/environments.js';
import type { PropertyScopes } from '../project/properties.js';
import type { Project, PropertyMap } from '../project/model.js';
import { toWssIncomingConfig, toWssOutgoingConfig } from '../project/wss-configs.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { secretEnvName, secretPseudoRef } from '../secrets/secret-token.js';
import { activeScripts } from '../script/request-scripts.js';
import { resolveWorkspaceScopes, withActiveEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import { signingSecretRef, signingSourceLabel } from '../webhooks/model.js';
import type { WssIncomingConfig, WssOutgoingConfig } from '../wss/model.js';
import { grpcEffectiveAuth, restEffectiveAuth, soapEffectiveAuth } from './effective-auth.js';
import type { SelectedRequest } from './select.js';
import { keystoreNeeds, present, secretNamesInValue } from './send-helpers.js';

export { secretNamesInValue } from './send-helpers.js';
```

- [ ] **Step 7: Run the tests**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run packages/engine/test/unit/sequence`
Expected: PASS, 13 files, 135 tests (`test/unit/run`: 8 files, 96 tests).

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run`
Expected: PASS, 6 files, 34 tests.

- [ ] **Step 8: Format, check, commit**

```bash
pnpm exec prettier --write packages/engine/src/run packages/engine/test/unit/run/scope.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/run packages/engine/test/unit/run/scope.test.ts
git commit -m "refactor(engine): the run's shared send helpers, tree walk and scope get their own files (#184)"
```

Expected: `pnpm check` green.

---

### Task 1.4: SOAP's run facet as a module

`soap/run.ts` takes SOAP's third of `prepare.ts`, `run.ts`, `secret-needs.ts` and `effective-auth.ts`, and adds `soapRun`, the object that implements `ProtocolRun`. Core does not dispatch through `soapRun` yet (Task 1.7 does): `createRunSender` keeps its SOAP branch and calls the moved functions where they now are. Only `needsOf` already delegates its SOAP arm, because the functions it called are private to the module from here on.

**Files:**
- Create: `packages/engine/src/soap/run.ts`, `packages/engine/src/soap/module.ts`
- Modify: `packages/engine/src/run/prepare.ts`, `packages/engine/src/run/run.ts`, `packages/engine/src/run/secret-needs.ts`, `packages/engine/src/run/effective-auth.ts`
- Test: `packages/engine/test/unit/soap/run-module.test.ts` (new)

**Interfaces:**
- Consumes: `ProtocolRun`, `RunScope`, `defineProtocol`; `run/context.ts`; `run/send-helpers.ts`; `run/tree.ts` (`byOrder`, `ORPHANED_STEP_REASON`).
- Produces:
  - `interface SoapSelected { kind: 'soap'; path; group; iface: Interface; operation: OperationDef; request: SoapRequestDef }`
  - `interface PreparedSoap { kind: 'soap'; input: SoapSendInput; scopes: PropertyScopes }`
  - `soapEffectiveAuth(selected: SoapSelected): SoapOwnerAuth | undefined`
  - `prepareSoap(selected: SoapSelected, context: RunContext): Promise<PreparedSoap>`
  - `soapResponseSubject(exchange: SoapExchange): AssertionSubject`
  - `soapRun: ProtocolRun<SoapSelected>`; memo key `soap:<interface id>:definition`
  - `soapProtocol` (`soap/module.ts`)
  - until Task 1.7 only: `LoadedDefinition`, `loadDefinition`, `soapSubject` are exported, because `run/run.ts` still calls them

- [ ] **Step 1: Write the failing test**

`packages/engine/test/unit/soap/run-module.test.ts`, the file in full:

```ts
/** SOAP's run facet on its own: what it offers a run, why a request cannot run, its needs, one send. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Interface, Project, SoapRequestDef } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import { soapProtocol } from '../../../src/soap/module.js';
import { soapRun } from '../../../src/soap/run.js';
import { normalizeWsa } from '../../../src/wsa/model.js';

const { events } = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../../../src/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/send.js')>()),
  sendSoapRequest: (input: { readonly endpoint: string }) => {
    events.push(`send ${input.endpoint}`);
    return Promise.resolve({
      http: {
        request: { url: input.endpoint, method: 'POST', headers: {} },
        status: 200,
        statusText: '',
        headers: {},
        rawHeaders: [],
        body: new Uint8Array(),
        rawRequest: new Uint8Array(),
        rawResponse: new Uint8Array(),
      },
      durationMs: 1,
      problems: [],
    });
  },
}));

function request(name: string, order: number, extra: Partial<SoapRequestDef> = {}): SoapRequestDef {
  return {
    kind: 'soap',
    id: `req-${name}`,
    name,
    slug: name.toLowerCase(),
    order,
    soapVersion: '1.1',
    headers: [],
    attachments: [],
    properties: DEFAULT_REQUEST_PROPERTIES,
    assertions: [],
    envelopeXml: '<Envelope>${secret:tenant}</Envelope>',
    endpointId: 'ep-1',
    ...extra,
  };
}

function iface(name: string, order: number, requests: readonly SoapRequestDef[]): Interface {
  return {
    kind: 'soap',
    id: `iface-${name}`,
    name,
    slug: name,
    order,
    definitionUrl: 'http://example.test/def.wsdl',
    cacheDefinition: false,
    endpoints: [{ id: 'ep-1', name: 'default', url: 'https://soap.example.test/billing', authMode: 'override' }],
    wsa: normalizeWsa({ enabled: false, version: '2005/08' }),
    auth: { type: 'basic', username: 'svc', passwordRef: 'ref-iface', passwordEnv: 'BILLING_PASSWORD' },
    operations: [
      { name: 'Second', bindingName: '{urn:t}B', slug: 'second', order: 1, requests: [] },
      { name: 'First', bindingName: '{urn:t}B', slug: 'first', order: 0, requests },
    ],
  };
}

const project: Project = {
  formatVersion: FORMAT_VERSION,
  id: 'proj-soap',
  name: 'SOAP module',
  settings: DEFAULT_PROJECT_SETTINGS,
  properties: {},
  disabledProperties: [],
  interfaces: [
    iface('Billing', 2, [request('Later', 1), request('Get', 0), request('Ghost', 2, { orphaned: true })]),
    iface('Accounts', 0, [request('List', 0)]),
  ],
  apis: [createApi('Api', { id: 'api-1', order: 1, requests: [createRestRequest('Ping', { id: 'req-ping' })] })],
  grpcApis: [],
  wsApis: [],
  sequences: [],
  environments: [],
  wss: { outgoing: [], incoming: [], keystores: [] },
};

const items = () => soapRun.groups(project).flatMap((group) => group.candidates.map((candidate) => candidate.item));

beforeEach(() => {
  events.length = 0;
});

describe('soapRun.groups', () => {
  it('offers one group per interface, in the project’s list order, with its own order and name', () => {
    expect(soapRun.groups(project).map((group) => [group.order, group.name, group.explicitOnly])).toEqual([
      [2, 'Billing', undefined],
      [0, 'Accounts', undefined],
    ]);
  });

  it('orders operations, then requests, and leaves orphans out', () => {
    expect(items().map((item) => item.path)).toEqual([
      'Billing/First/Get',
      'Billing/First/Later',
      'Accounts/First/List',
    ]);
  });

  it('offers exactly what a run selects of SOAP, under the same disk paths', () => {
    const selected = selectRequests(project, []).selected.filter((item) => item.kind === 'soap');
    expect(selected.map((item) => item.path)).toEqual([
      'Accounts/First/List',
      'Billing/First/Get',
      'Billing/First/Later',
    ]);
    expect(selected).toEqual(expect.arrayContaining(items()));
    const [first] = soapRun.groups(project)[0]?.candidates ?? [];
    expect(first?.diskPath).toBe('interfaces/Billing/operations/first/get');
    expect(selectRequests(project, [first?.diskPath ?? '']).selected).toEqual([first?.item]);
  });
});

describe('soapRun.whyNotRunnable', () => {
  it('says why an orphaned request cannot run, and nothing for a runnable or a foreign one', () => {
    expect(soapRun.whyNotRunnable(project, 'req-Ghost')).toBe('The request is no longer in its contract (orphaned)');
    expect(soapRun.whyNotRunnable(project, 'req-Get')).toBeUndefined();
    expect(soapRun.whyNotRunnable(project, 'req-ping')).toBeUndefined();
  });
});

describe('soapRun.secretNeeds', () => {
  it('lists what the request’s configuration needs, and not its secret tokens', () => {
    const [get] = items();
    expect(get && soapRun.secretNeeds(get, project)).toEqual([
      { ref: 'ref-iface', envName: 'BILLING_PASSWORD', purpose: 'basic password for "svc"' },
    ]);
  });
});

describe('soapRun.send', () => {
  it('prepares, sends once, and reports a SOAP subject with its exchange and origin', async () => {
    const context: RunContext = {
      project,
      projectDir: '/nowhere',
      overrides: {},
      getSecret: (ref) => {
        events.push(`secret ${ref}`);
        return Promise.resolve('abc123def456ghi789');
      },
    };
    const [get] = items();
    const sent = get && (await soapRun.send(get, createRunScope(context)));
    expect(events).toEqual(['secret ref-iface', 'secret secret:tenant', 'send https://soap.example.test/billing']);
    expect(sent?.subject).toMatchObject({ protocol: 'soap', status: 200 });
    expect(sent?.exchange?.kind).toBe('soap');
    expect(sent?.origin).toBe('https://soap.example.test');
    expect(sent?.scriptsOff).toBeUndefined();
  });
});

describe('soapProtocol', () => {
  it('is the soap kind behind the soap feature, with a run facet', () => {
    expect(soapProtocol.kind).toBe('soap');
    expect(soapProtocol.feature).toEqual({ id: 'soap', title: 'SOAP', default: true, stage: 'stable', requires: [] });
    expect(soapProtocol.run?.groups(project)).toHaveLength(2);
  });

  it('refuses a request of another kind', () => {
    const [rest] = selectRequests(project, ['Api/Ping']).selected;
    expect(() => rest && soapProtocol.run?.secretNeeds(rest, project)).toThrow(
      'The "soap" protocol was handed a "rest" request',
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/soap/run-module.test.ts`
Expected: FAIL: `src/soap/run.js` cannot be resolved.

- [ ] **Step 3: Create `packages/engine/src/soap/run.ts`**

The file is built top to bottom from the eight parts below. Parts marked *new* are printed; parts marked *moved* are cut from where the table says.

**(a) new.** Header and imports:

```ts
/**
 * SOAP's run facet (spec §3.3): which saved requests a run can send, how one is prepared and sent
 * with and without scripts, its script types, and the secrets its configuration needs. The steps of
 * a send are in the order they have always been: the definition, the request's TLS identity, its
 * credentials (an OAuth2 token included), its secret tokens, then the wire.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { AssertionSubject } from '../assert/model.js';
import { WirebenchError } from '../errors.js';
import { createFileAttachmentResolver } from '../project/attachments-cache.js';
import { effectiveAuth } from '../project/endpoints.js';
import { resolveAuthEndpoint, resolveEndpoint } from '../project/environments.js';
import type { EndpointSource } from '../project/environments.js';
import type {
  Attachment,
  Endpoint,
  Interface,
  OperationDef,
  Project,
  RequestDef,
  SoapOwnerAuth,
  SoapRequestDef,
} from '../project/model.js';
import { definitionCacheDir } from '../project/paths.js';
import { expandSendInput } from '../project/properties.js';
import type { PropertyScopes } from '../project/properties.js';
import { toWssIncomingConfig, toWssOutgoingConfig } from '../project/wss-configs.js';
import type { ProtocolRun, RunScope } from '../protocol/module.js';
import { scopesFor } from '../run/context.js';
import type { RunContext } from '../run/context.js';
import { requiredSecret } from '../run/oauth2-token.js';
import {
  authFor,
  dropRefusedToken,
  insideProject,
  keystoreNeeds,
  loadKeystoreById,
  originOf,
  present,
  tlsFor,
  unresolvedError,
  withSecrets,
} from '../run/send-helpers.js';
import { ORPHANED_STEP_REASON, byOrder } from '../run/tree.js';
import { soapOperationElements } from '../script/contracts.js';
import { applySoapSnapshot, soapRequestSnapshot, soapResponseSnapshot } from '../script/send.js';
import { soapScriptTypes } from '../script/types/xsd.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { resolveSoapAuth } from '../secrets/resolve.js';
import { toSendInput } from '../send-options.js';
import type { AttachmentResolvers } from '../send-options.js';
import { sendSoapRequest } from '../send.js';
import type { SoapExchange, SoapSendInput, SoapSendWss } from '../types.js';
import { bindingContextFor, validateMessage } from '../validate/index.js';
import { resolveWorkspaceEndpoint, withActiveEnvironment } from '../workspace/environments.js';
import { effectiveWsa } from '../wsa/model.js';
import { summarizeWsa } from '../wsa/policy-detect.js';
import { readDefinitionCache } from '../wsdl/cache.js';
import { parseWsdlBundle } from '../wsdl/merge.js';
import type { WsdlDefinition } from '../wsdl/model.js';
import type { DefinitionBundle } from '../wsdl/resolver.js';
import { createWssContext } from '../wss/model.js';
import type { WssIncomingConfig, WssOutgoingConfig } from '../wss/model.js';
import { buildSchemaSet } from '../xsd/schema-set.js';
import type { SchemaSet } from '../xsd/schema-set.js';
```

**(b) new.** The selection and the prepared send. `SoapSelected` is the SOAP arm of `SelectedRequest` (`run/select.ts` lines 15–22) written as its own interface; `PreparedSoap` is the SOAP arm of `PreparedSend`:

```ts
/** One saved SOAP request selected for a run, with enough context to send and report it. */
export interface SoapSelected {
  readonly kind: 'soap';
  readonly path: string;
  readonly group: string;
  readonly iface: Interface;
  readonly operation: OperationDef;
  readonly request: SoapRequestDef;
}

/** A SOAP request ready for `sendSoapRequest`, with the scopes its text expands against. */
export interface PreparedSoap {
  readonly kind: 'soap';
  readonly input: SoapSendInput;
  readonly scopes: PropertyScopes;
}
```

**(c) to (g) moved**, in this order:

| Part | Piece | From (lines at the start of the slice) | Change |
|---|---|---|---|
| c | `soapEffectiveAuth` | `run/effective-auth.ts` 12–17 | parameter type `Extract<SelectedRequest, { kind: 'soap' }>` becomes `SoapSelected` |
| d | `endpointFor` | `run/prepare.ts` 166–182 | none |
| d | `wsaFor` | `run/prepare.ts` 290–298 | none |
| d | `wssFor` | `run/prepare.ts` 300–341 | none |
| d | `attachmentResolvers` | `run/prepare.ts` 343–376 | none |
| e | `prepareSoap` | `run/prepare.ts` 388–440 | new JSDoc and signature, below; the body is untouched |
| f | `LoadedDefinition` | `run/run.ts` 149–155 | gains `export` (until Task 1.7) |
| f | `parseClark` | `run/run.ts` 181–186 | none |
| f | `loadDefinition` | `run/run.ts` 188–209 | gains `export` (until Task 1.7) |
| f | `soapResponseSubject` | `run/run.ts` 211–230 | none (already exported) |
| f | `soapSubject` | `run/run.ts` 232–264 | gains `export` (until Task 1.7) and the JSDoc below |
| g | `findConfig` | `run/secret-needs.ts` 81–99 | none |
| g | `outgoingNeeds` | `run/secret-needs.ts` 101–120 | none |
| g | `incomingNeeds` | `run/secret-needs.ts` 122–130 | none |

`prepareSoap`'s first line, `async function prepareSoap(selected: SoapSelected, context: RunContext): Promise<PreparedSend> {`, is replaced by:

```ts
/**
 * One SOAP request as a send input, with its secrets resolved (or behind `context.secretPlaceholders`).
 * Exported for this module's tests and for `prepareSend`; not part of the run facet.
 *
 * @throws WirebenchError `unresolved-properties` | `endpoint-unresolved` | `secret-missing` |
 * `auth-grant-unsupported` | `wss-config-missing` | `keystore-missing`
 */
export async function prepareSoap(selected: SoapSelected, context: RunContext): Promise<PreparedSoap> {
```

`soapSubject` gets this line directly above it:

```ts
/** A SOAP response as assertions see it, validated against the contract when the run has the definition. */
```

**(h) new.** The memoised definition and the run facet. `send` is the SOAP branch of today's `createRunSender` and of `sendScripted` (`run/run.ts`), with the definition read through `scope.memo` instead of the sender's own `Map`; `groups` is the SOAP loop of `candidates` (`run/select.ts` 196–206) and `whyNotRunnable` the SOAP loop of `findStepRequest` (294–300); `scriptTypes` is the SOAP arm of `scriptTypesFor` (`run/script-support.ts`), which stays where it is; `secretNeeds` is the SOAP tail of `needsOf` (`run/secret-needs.ts` 178–187) without `tokenNeeds`, which is core's:

```ts
/** The interface's definition, read once per run. */
function definitionFor(iface: Interface, scope: RunScope): Promise<LoadedDefinition | undefined> {
  return scope.memo(`soap:${iface.id}:definition`, () => loadDefinition(scope.context.projectDir, iface));
}

/** SOAP's run facet. */
export const soapRun: ProtocolRun<SoapSelected> = {
  groups(project) {
    return project.interfaces.map((iface) => ({
      order: iface.order,
      name: iface.name,
      candidates: [...iface.operations].sort(byOrder).flatMap((operation) => {
        const group = `${iface.name}/${operation.name}`;
        return [...operation.requests]
          .sort(byOrder)
          .filter((request) => request.orphaned !== true)
          .map((request) => ({
            item: { kind: 'soap' as const, path: `${group}/${request.name}`, group, iface, operation, request },
            diskPath: `interfaces/${iface.slug}/operations/${operation.slug}/${request.slug}`,
          }));
      }),
    }));
  },

  whyNotRunnable(project, requestId) {
    for (const iface of project.interfaces) {
      for (const operation of iface.operations) {
        const request = operation.requests.find((candidate) => candidate.id === requestId);
        if (request !== undefined) {
          return request.orphaned === true ? ORPHANED_STEP_REASON : undefined;
        }
      }
    }
    return undefined;
  },

  async send(selected, scope, scripts) {
    const loaded = await definitionFor(selected.iface, scope);
    // The WSDL's default `wsa:Action`, when the run has the definition; else the host's, if any.
    const context: RunContext = {
      ...scope.context,
      ...(loaded !== undefined
        ? {
            defaultWsaActionFor: (s: SoapSelected) =>
              loaded.defaultActionByOperation[`${s.operation.bindingName}|${s.operation.name}`] ?? '',
          }
        : {}),
    };
    if (scripts === undefined) {
      const prepared = await prepareSoap(selected, context);
      const exchange = await sendSoapRequest(prepared.input, { scopes: prepared.scopes });
      dropRefusedToken(context, prepared.input.auth, exchange.http.status === 401);
      return {
        subject: soapSubject(exchange, loaded, selected),
        raw: exchange.http,
        exchange: { kind: 'soap', soap: exchange },
        ...originOf(exchange.http.request.url),
      };
    }

    // Prepared with its secrets behind placeholders; the pre-request script runs on the expanded
    // request, the secrets are put back, and the post-response script sees what the script left.
    const prepared = await prepareSoap(selected, { ...context, secretPlaceholders: scripts.placeholders });
    const expanded = expandSendInput(prepared.input, prepared.scopes, {
      entitize: prepared.input.entitize ?? false,
    }).input;
    const before = soapRequestSnapshot(expanded);
    const sent = await scripts.session.pre(before);
    const changed = applySoapSnapshot(expanded, sent);
    const restored = await scripts.placeholders.restore(
      {
        endpoint: changed.endpoint,
        headers: changed.headers ?? {},
        envelopeXml: changed.envelopeXml,
        ...(changed.soapAction !== undefined ? { soapAction: changed.soapAction } : {}),
      },
      context.getSecret,
    );
    // Already expanded: sent without scopes, so nothing the script wrote is expanded again.
    const exchange = await sendSoapRequest({ ...changed, ...restored });
    dropRefusedToken(context, prepared.input.auth, exchange.http.status === 401);
    return {
      subject: soapSubject(exchange, loaded, selected),
      raw: exchange.http,
      exchange: { kind: 'soap', soap: exchange },
      ...originOf(exchange.http.request.url),
      script: await scripts.session.post(sent, soapResponseSnapshot(exchange)),
    };
  },

  async scriptTypes(selected, scope) {
    const loaded = await definitionFor(selected.iface, scope);
    if (loaded === undefined) {
      return { generated: soapScriptTypes(undefined) };
    }
    const elements = soapOperationElements(loaded.definition, selected.operation.bindingName, selected.operation.name);
    return {
      generated: soapScriptTypes(loaded.schemaSet, elements.input, elements.output),
      soap: {
        schemas: loaded.schemaSet,
        ...(elements.input !== undefined ? { input: elements.input } : {}),
        ...(elements.output !== undefined ? { output: elements.output } : {}),
      },
    };
  },

  secretNeeds(selected, project) {
    const { request } = selected;
    const outgoing = findConfig(project.wss.outgoing, request.wssOutgoingRef, toWssOutgoingConfig);
    const incoming = findConfig(project.wss.incoming, request.wssIncomingRef, toWssIncomingConfig);
    return [
      ...secretNeedsOfAuth(soapEffectiveAuth(selected)),
      ...keystoreNeeds(project, request.properties.sslKeystoreRef),
      ...(outgoing !== undefined ? outgoingNeeds(project, outgoing) : []),
      ...(incoming !== undefined ? incomingNeeds(project, incoming) : []),
    ];
  },
};
```

- [ ] **Step 4: Create `packages/engine/src/soap/module.ts`**

The file in full:

```ts
/** SOAP as a protocol module (spec §3). */
import { defineProtocol } from '../protocol/module.js';
import { soapRun } from './run.js';

/** The SOAP protocol: WSDL interfaces, their operations and their saved requests. */
export const soapProtocol = defineProtocol({
  kind: 'soap',
  feature: { id: 'soap', title: 'SOAP', default: true, stage: 'stable', requires: [] },
  run: soapRun,
});
```

- [ ] **Step 5: Fix the four source files**

`run/prepare.ts`: the alias `type SoapSelected = …` (line 142) and the pieces of parts d and e are gone. The SOAP arm of `PreparedSend` becomes `PreparedSoap`:

```ts
export type PreparedSend =
  | PreparedSoap
  | { readonly kind: 'rest'; readonly input: RestSendInput }
  | {
      readonly kind: 'grpc';
      // The streaming hooks are left out: a run makes unary calls, and wants only the result.
      readonly input: Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;
      readonly messageText: string;
    };
```

Its import block is then exactly:

```ts
import { readFile } from 'node:fs/promises';
import { expandGrpcInput } from '../grpc/expand.js';
import type { GrpcSendInput } from '../grpc/send.js';
import { readAttachment } from '../project/attachments-cache.js';
import type { AttachmentSource } from '../project/model.js';
import { expandRestSendInput } from '../rest/expand.js';
import type { RestSendInput } from '../rest/send.js';
import { toGrpcSendInput, toRestSendInput } from '../send-options.js';
import { signingSecretMissing, signingSecretRef } from '../webhooks/model.js';
import { grpcEffectiveAuth, restEffectiveAuth } from './effective-auth.js';
import { prepareSoap } from '../soap/run.js';
import type { PreparedSoap } from '../soap/run.js';
import type { SelectedRequest } from './select.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import { authFor, baseUrlFor, insideProject, tlsFor, unresolvedError, withSecrets } from './send-helpers.js';

export { authFor } from './send-helpers.js';
export { scopesFor } from './context.js';
export type { RunContext, RunWorkspace } from './context.js';
```

`run/run.ts`: the pieces of part f are gone; `createRunSender` and `sendScripted` are not edited, they now call the imported `loadDefinition` and `soapSubject`. `soapResponseSubject` is re-exported, because `run/index.ts` exports it from here: the line `export { soapResponseSubject } from '../soap/run.js';` goes after the imports, before `export type RequestOutcome`. Imports and re-export are then exactly:

```ts
import { isCallbackAssertion, sendAwaitingCallbacks } from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import { evaluateAssertions } from '../assert/index.js';
import type { Assertion, AssertionResult, AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import { readGrpcDefinitionCache } from '../grpc/cache.js';
import { callGrpc } from '../grpc/call.js';
import type { GrpcCallResult } from '../grpc/call.js';
import { loadProtoSet } from '../grpc/proto/load.js';
import type { ProtoSet } from '../grpc/proto/load.js';
import { protoSetFromDescriptorSet } from '../grpc/reflection/descriptors.js';
import { apiDefinitionDir } from '../project/paths.js';
import { sendRest } from '../rest/send.js';
import type { RestExchange } from '../rest/send.js';
import { sendSoapRequest } from '../send.js';
import { loadDefinition, soapSubject } from '../soap/run.js';
import type { LoadedDefinition } from '../soap/run.js';
import type { SoapExchange } from '../types.js';
import { createRunTokenSource } from './oauth2-token.js';
import { prepareSend, scopesFor } from './prepare.js';
import { dropRefusedToken, originOf } from './send-helpers.js';
import type { RunContext } from './prepare.js';
import type { SelectedRequest } from './select.js';
import type { TransferResult } from '../sequence/run.js';
import { expandSendInput } from '../project/properties.js';
import type { OpenApiDocument } from '../rest/openapi/model.js';
import { loadOpenApiDocument } from '../script/contracts.js';
import { scriptProperties } from '../script/props.js';
import {
  activeScripts,
  type RequestScripting,
  type ScriptedRequest,
  type ScriptRunValues,
} from '../script/request-scripts.js';
import {
  SecretPlaceholders,
  applyGrpcSnapshot,
  applyRestSnapshot,
  applySoapSnapshot,
  grpcRequestSnapshot,
  grpcResponseSnapshot,
  restRequestSnapshot,
  restResponseSnapshot,
  soapRequestSnapshot,
  soapResponseSnapshot,
} from '../script/send.js';
import {
  listedSecrets,
  mergeScriptValues,
  scriptAssertions,
  scriptSession,
  scriptTypesFor,
  type SentScripts,
} from './script-support.js';

export { soapResponseSubject } from '../soap/run.js';
```

`run/secret-needs.ts`: the pieces of part g are gone, and the SOAP tail of `needsOf` (from `const { request } = selected;` to the end of the function) becomes one line. `needsOf` is then:

```ts
function needsOf(selected: SelectedRequest, project: Project, scopeSets: readonly PropertyScopes[]): SecretNeed[] {
  if (selected.kind === 'rest') {
    return [
      ...tokenNeeds(selected, scopeSets),
      ...secretNeedsOfAuth(restEffectiveAuth(selected)),
      ...keystoreNeeds(project, selected.request.settings.sslKeystoreRef),
      ...signingNeeds(selected),
    ];
  }
  if (selected.kind === 'grpc') {
    return [
      ...tokenNeeds(selected, scopeSets),
      ...secretNeedsOfAuth(grpcEffectiveAuth(selected)),
      ...keystoreNeeds(project, selected.request.settings.sslKeystoreRef),
    ];
  }
  return [...tokenNeeds(selected, scopeSets), ...soapRun.secretNeeds(selected, project)];
}
```

Its import block is then exactly:

```ts
import { resolveScopes } from '../project/environments.js';
import type { PropertyScopes } from '../project/properties.js';
import type { Project, PropertyMap } from '../project/model.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { secretEnvName, secretPseudoRef } from '../secrets/secret-token.js';
import { activeScripts } from '../script/request-scripts.js';
import { soapRun } from '../soap/run.js';
import { resolveWorkspaceScopes, withActiveEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import { signingSecretRef, signingSourceLabel } from '../webhooks/model.js';
import { grpcEffectiveAuth, restEffectiveAuth } from './effective-auth.js';
import type { SelectedRequest } from './select.js';
import { keystoreNeeds, secretNamesInValue } from './send-helpers.js';

export { secretNamesInValue } from './send-helpers.js';
```

`run/effective-auth.ts`: `soapEffectiveAuth` is gone. Its import block is then exactly:

```ts
import type { AuthConfig } from '../project/model.js';
import { resolveAuthChain } from '../rest/auth.js';
import type { SelectedRequest } from './select.js';
```

- [ ] **Step 6: Run the tests**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/soap/run-module.test.ts`
Expected: PASS, 8 tests.

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run packages/engine/test/unit/sequence`
Expected: PASS, 13 files, 135 tests, `send-order.test.ts` among them and not edited.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run`
Expected: PASS, 6 files, 34 tests.

- [ ] **Step 7: Format, check, commit**

```bash
pnpm exec prettier --write packages/engine/src/soap/run.ts packages/engine/src/soap/module.ts packages/engine/src/run packages/engine/test/unit/soap/run-module.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/soap/run.ts packages/engine/src/soap/module.ts packages/engine/src/run packages/engine/test/unit/soap/run-module.test.ts
git commit -m "refactor(engine): SOAP's run facet as a module (#184)"
```

Expected: `pnpm check` green.

---

### Task 1.5: REST's run facet as a module, webhook items included

The same cut for REST. The project's webhook items are REST requests against a synthetic API; they become one more group of `restRun.groups`, marked `explicitOnly`, so a run of everything leaves them out and a selector that names one reaches it. `run/select.ts` keeps its own `walkRest` and `walkWebhooks` until Task 1.7 replaces the whole file; `test/unit/run/select.test.ts` and the new module test hold the two to the same answer meanwhile.

**Files:**
- Create: `packages/engine/src/rest/run.ts`, `packages/engine/src/rest/module.ts`
- Modify: `packages/engine/src/run/prepare.ts`, `packages/engine/src/run/run.ts`, `packages/engine/src/run/secret-needs.ts`, `packages/engine/src/run/effective-auth.ts`
- Test: `packages/engine/test/unit/rest/run-module.test.ts` (new)

**Interfaces:**
- Consumes: `ProtocolRun`, `RunGroup`, `defineProtocol`; `run/context.ts`; `run/send-helpers.ts`; `run/tree.ts` (`byOrder`, `findInTree`, `walkTree`, `ORPHANED_STEP_REASON`); `webhooks/model.ts`.
- Produces:
  - `interface RestSelected { kind: 'rest'; path; group; api: RestApi; chain: readonly RestFolder[]; request: RestRequestDef; signing?: EffectiveSigning }`
  - `interface PreparedRest { kind: 'rest'; input: RestSendInput }`
  - `restEffectiveAuth(selected: RestSelected): AuthConfig`
  - `prepareRest(selected: RestSelected, context: RunContext): Promise<PreparedRest>`
  - `restSubject(exchange: RestExchange): AssertionSubject`
  - `restRun: ProtocolRun<RestSelected>`; memo key `rest:<api id>:openapi`; the webhook group is `{ order: 0, name: 'Webhooks', candidates, explicitOnly: true }`; `whyNotRunnable` answers `'A webhook cannot be a sequence step'` for a webhook item
  - `restProtocol` (`rest/module.ts`)

- [ ] **Step 1: Write the failing test**

`packages/engine/test/unit/rest/run-module.test.ts`, the file in full:

```ts
/** REST's run facet on its own: APIs and webhook items, why a request cannot run, its needs, one send. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { createApi, createFolder, createRestRequest, entry } from '../../../src/rest/model.js';
import { restProtocol } from '../../../src/rest/module.js';
import { restRun } from '../../../src/rest/run.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import { createWebhookCollection, createWebhookFolder } from '../../../src/webhooks/model.js';

const { events } = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../../../src/rest/send.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/rest/send.js')>()),
  sendRest: (input: { readonly baseUrl: string; readonly request: { readonly url: string } }) => {
    events.push(`send ${input.baseUrl}${input.request.url}`);
    return Promise.resolve({
      request: { url: `${input.baseUrl}${input.request.url}`, method: 'GET', headers: {} },
      status: 200,
      statusText: '',
      headers: {},
      rawHeaders: [],
      body: new Uint8Array(),
      rawRequest: new Uint8Array(),
      rawResponse: new Uint8Array(),
      text: '{}',
      language: 'json',
      cookies: [],
      methodChanged: false,
      durationMs: 1,
    });
  },
}));

const project: Project = {
  ...createProject('REST module', { id: 'proj-rest' }),
  apis: [
    createApi('Billing', {
      id: 'api-billing',
      slug: 'billing',
      order: 1,
      baseUrl: 'https://api.example.test',
      auth: { type: 'bearer', tokenRef: 'ref-token', tokenEnv: 'BILLING_TOKEN' },
      requests: [
        createRestRequest('Zed', { id: 'req-zed', slug: 'zed', order: 1, url: '/zed' }),
        { ...createRestRequest('Gone', { id: 'req-gone', order: 2 }), orphaned: true },
      ],
      folders: [
        createFolder('Invoices', {
          id: 'folder-invoices',
          slug: 'invoices',
          order: 0,
          requests: [
            createRestRequest('List', {
              id: 'req-list',
              slug: 'list',
              url: '/invoices',
              headers: [entry('X-Tenant', '${secret:tenant}')],
            }),
          ],
        }),
      ],
    }),
    createApi('Empty', { id: 'api-empty', slug: 'empty', order: 0 }),
  ],
  webhooks: createWebhookCollection({
    target: 'https://receiver.example.test/hooks',
    signing: {
      mode: 'sign',
      scheme: { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' },
      secretRef: 'ref-hooks',
      secretEnv: 'HOOKS_SIGNING',
    },
    requests: [createRestRequest('Ping', { id: 'hook-ping', slug: 'ping', method: 'POST', url: '/ping' })],
    folders: [
      createWebhookFolder('Orders', {
        id: 'hook-folder',
        slug: 'orders',
        target: 'https://orders.example.test',
        requests: [createRestRequest('Paid', { id: 'hook-paid', slug: 'paid', method: 'POST', url: '/paid' })],
      }),
    ],
  }),
};

const itemAt = (path: string) =>
  restRun
    .groups(project)
    .flatMap((group) => group.candidates)
    .find((candidate) => candidate.item.path === path)?.item;

beforeEach(() => {
  events.length = 0;
});

describe('restRun.groups', () => {
  it('offers one group per API, then the webhook items as a group only a selector reaches', () => {
    expect(restRun.groups(project).map((group) => [group.order, group.name, group.explicitOnly])).toEqual([
      [1, 'Billing', undefined],
      [0, 'Empty', undefined],
      [0, 'Webhooks', true],
    ]);
    expect(restRun.groups({ ...project, apis: [] }).map((group) => group.name)).toEqual(['Webhooks']);
    expect(restRun.groups(createProject('None', { id: 'p0' }))).toEqual([]);
  });

  it('walks an API in explorer order and leaves orphans out', () => {
    const [billing] = restRun.groups(project);
    expect(billing?.candidates.map((candidate) => [candidate.item.path, candidate.diskPath])).toEqual([
      ['Billing/Invoices/List', 'apis/billing/requests/invoices/list'],
      ['Billing/Zed', 'apis/billing/requests/zed'],
    ]);
  });

  it('offers each webhook item against a synthetic API at its effective target, with its signing', () => {
    const hooks = restRun.groups(project)[2]?.candidates ?? [];
    expect(
      hooks.map((candidate) => [
        candidate.item.path,
        candidate.diskPath,
        candidate.item.api.id,
        candidate.item.api.baseUrl,
        candidate.item.signing?.from,
      ]),
    ).toEqual([
      ['Webhooks/Ping', 'webhooks/requests/ping', 'webhooks', 'https://receiver.example.test/hooks', 'collection'],
      [
        'Webhooks/Orders/Paid',
        'webhooks/requests/orders/paid',
        'webhooks',
        'https://orders.example.test',
        'collection',
      ],
    ]);
  });

  it('offers exactly what a run selects of REST', () => {
    expect(restRun.groups(project)[0]?.candidates.map((candidate) => candidate.item)).toEqual(
      selectRequests(project, []).selected,
    );
    expect(restRun.groups(project)[2]?.candidates.map((candidate) => candidate.item)).toEqual(
      selectRequests(project, ['Webhooks']).selected,
    );
  });
});

describe('restRun.whyNotRunnable', () => {
  it('refuses a webhook item, says why an orphan cannot run, and nothing otherwise', () => {
    expect(restRun.whyNotRunnable(project, 'hook-paid')).toBe('A webhook cannot be a sequence step');
    expect(restRun.whyNotRunnable(project, 'req-gone')).toBe('The request is no longer in its contract (orphaned)');
    expect(restRun.whyNotRunnable(project, 'req-list')).toBeUndefined();
    expect(restRun.whyNotRunnable(project, 'nowhere')).toBeUndefined();
  });
});

describe('restRun.secretNeeds', () => {
  it('lists the effective auth of an API request, and not its secret tokens', () => {
    const list = itemAt('Billing/Invoices/List');
    expect(list && restRun.secretNeeds(list, project)).toEqual([
      { ref: 'ref-token', envName: 'BILLING_TOKEN', purpose: 'bearer token' },
    ]);
  });

  it('lists a webhook item’s signing secret', () => {
    const ping = itemAt('Webhooks/Ping');
    expect(ping && restRun.secretNeeds(ping, project)).toEqual([
      { ref: 'ref-hooks', envName: 'HOOKS_SIGNING', purpose: 'webhook signing secret (the Webhooks collection)' },
    ]);
  });
});

describe('restRun.send', () => {
  it('prepares, sends once, and reports a REST subject with its exchange and origin', async () => {
    const context: RunContext = {
      project,
      projectDir: '/nowhere',
      overrides: {},
      getSecret: (ref) => {
        events.push(`secret ${ref}`);
        return Promise.resolve('abc123def456ghi789');
      },
    };
    const list = itemAt('Billing/Invoices/List');
    const sent = list && (await restRun.send(list, createRunScope(context)));
    expect(events).toEqual(['secret ref-token', 'secret secret:tenant', 'send https://api.example.test/invoices']);
    expect(sent?.subject).toMatchObject({ protocol: 'rest', status: 200, bodyKind: 'json' });
    expect(sent?.exchange?.kind).toBe('rest');
    expect(sent?.origin).toBe('https://api.example.test');
  });
});

describe('restProtocol', () => {
  it('is the rest kind behind the rest feature, with a run facet', () => {
    expect(restProtocol.kind).toBe('rest');
    expect(restProtocol.feature).toEqual({ id: 'rest', title: 'REST', default: true, stage: 'stable', requires: [] });
    expect(restProtocol.run?.groups(project)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/rest/run-module.test.ts`
Expected: FAIL: `src/rest/run.js` cannot be resolved.

- [ ] **Step 3: Create `packages/engine/src/rest/run.ts`**

Top to bottom:

**(a) new.** Header and imports:

```ts
/**
 * REST's run facet (spec §3.3): the requests of every API, and the project's webhook items as a
 * group a run sends only when a selector names it. The steps of a send are in the order they have
 * always been: the request's TLS identity, its credentials (an OAuth2 token included), its secret
 * tokens, a webhook item's signing secret, then the wire.
 */
import { readFile } from 'node:fs/promises';
import type { AssertionSubject } from '../assert/model.js';
import { readAttachment } from '../project/attachments-cache.js';
import type { AttachmentSource, AuthConfig } from '../project/model.js';
import { REQUESTS_DIR, WEBHOOKS_DIR } from '../project/paths.js';
import type { ProtocolRun, RunGroup } from '../protocol/module.js';
import { scopesFor } from '../run/context.js';
import type { RunContext } from '../run/context.js';
import {
  authFor,
  baseUrlFor,
  dropRefusedToken,
  insideProject,
  keystoreNeeds,
  originOf,
  tlsFor,
  unresolvedError,
  withSecrets,
} from '../run/send-helpers.js';
import { ORPHANED_STEP_REASON, byOrder, findInTree, walkTree } from '../run/tree.js';
import { loadOpenApiDocument, restOperationFor } from '../script/contracts.js';
import { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from '../script/send.js';
import { restScriptTypes } from '../script/types/rest.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { toRestSendInput } from '../send-options.js';
import {
  effectiveSigning,
  effectiveTarget,
  signingSecretMissing,
  signingSecretRef,
  signingSourceLabel,
} from '../webhooks/model.js';
import type { EffectiveSigning, WebhookCollection, WebhookFolder } from '../webhooks/model.js';
import { resolveAuthChain } from './auth.js';
import { expandRestSendInput } from './expand.js';
import { createApi } from './model.js';
import type { RestApi, RestFolder, RestRequestDef } from './model.js';
import { sendRest } from './send.js';
import type { RestExchange, RestSendInput } from './send.js';
```

**(b) new.** The selection and the prepared send. `RestSelected` is the REST arm of `SelectedRequest` (`run/select.ts` lines 23–32) as its own interface:

```ts
/** One saved REST request, or one webhook item, selected for a run. */
export interface RestSelected {
  readonly kind: 'rest';
  readonly path: string;
  readonly group: string;
  readonly api: RestApi;
  readonly chain: readonly RestFolder[];
  readonly request: RestRequestDef;
  /** A webhook item's effective signing (webhook-signatures §5.2); absent for an API request. */
  readonly signing?: EffectiveSigning;
}

/** A REST request ready for `sendRest`. */
export interface PreparedRest {
  readonly kind: 'rest';
  readonly input: RestSendInput;
}
```

**(c) to (f) moved**, in this order:

| Part | Piece | From (lines at the start of the slice) | Change |
|---|---|---|---|
| c | `restEffectiveAuth` | `run/effective-auth.ts` 19–23 | parameter type `Extract<SelectedRequest, { kind: 'rest' }>` becomes `RestSelected` |
| d | `restFileResolver` | `run/prepare.ts` 378–386 | none |
| d | `signFor` | `run/prepare.ts` 488–502 | none |
| d | `prepareRest` | `run/prepare.ts` 504–546 | new JSDoc and signature, below; the body is untouched |
| e | `restSubject` | `run/run.ts` 266–276 | none (already exported) |
| f | `signingNeeds` | `run/secret-needs.ts` 147–160 | parameter type `Extract<SelectedRequest, { kind: 'rest' }>` becomes `RestSelected` |

`prepareRest`'s first line, `async function prepareRest(selected: RestSelected, context: RunContext): Promise<PreparedSend> {`, is replaced by:

```ts
/**
 * One REST request as a send input, with its secrets resolved (or behind `context.secretPlaceholders`).
 * Exported for this module's tests and for `prepareSend`; not part of the run facet.
 *
 * @throws WirebenchError `unresolved-properties` | `secret-missing` | `auth-grant-unsupported` |
 * `keystore-missing` | `webhook-signing-secret`
 */
export async function prepareRest(selected: RestSelected, context: RunContext): Promise<PreparedRest> {
```

**(g) new.** The candidates and the run facet. `apiCandidates` is `walkRest` (`run/select.ts` 117–129) and `webhookCandidates` is `walkWebhooks` (146–183), both typed by the module's own selection; `send` is the REST branch of `createRunSender` and of `sendScripted` (`run/run.ts`); `scriptTypes` is the REST arm of `scriptTypesFor`, with the OpenAPI document read through `scope.memo`; `secretNeeds` is the REST arm of `needsOf` (`run/secret-needs.ts` 163–170) without `tokenNeeds`:

```ts
type RestCandidate = RunGroup<RestSelected>['candidates'][number];

/** An API's requests in explorer order, without the ones its contract no longer has. */
function apiCandidates(api: RestApi): RestCandidate[] {
  const out: RestCandidate[] = [];
  walkTree<RestFolder, RestRequestDef, RestSelected>(
    api,
    [],
    api.name,
    `apis/${api.slug}/requests`,
    (request, chain, group) =>
      request.orphaned === true
        ? undefined
        : { kind: 'rest', path: `${group}/${request.name}`, group, api, chain, request },
    out,
  );
  return out;
}

/**
 * The project's webhook items, as REST items against a synthetic API whose base URL is each item's
 * effective target. A run has no history, so a callback uses the target.
 */
function webhookCandidates(collection: WebhookCollection): RestCandidate[] {
  const out: RestCandidate[] = [];
  const visit = (
    folders: readonly WebhookFolder[],
    requests: readonly RestRequestDef[],
    chain: readonly WebhookFolder[],
  ): void => {
    const group = ['Webhooks', ...chain.map((folder) => folder.name)].join('/');
    const dir = [WEBHOOKS_DIR, REQUESTS_DIR, ...chain.map((folder) => folder.slug)].join('/');
    const api = createApi('Webhooks', {
      id: 'webhooks',
      slug: 'webhooks',
      baseUrl: effectiveTarget(collection, chain),
      ...(collection.auth !== undefined ? { auth: collection.auth } : {}),
    });
    for (const request of [...requests].sort(byOrder)) {
      if (request.orphaned === true) continue;
      out.push({
        item: {
          kind: 'rest',
          path: `${group}/${request.name}`,
          group,
          api,
          chain,
          request,
          signing: effectiveSigning(collection, request.id),
        },
        diskPath: `${dir}/${request.slug}`,
      });
    }
    for (const folder of [...folders].sort(byOrder)) visit(folder.folders, folder.requests, [...chain, folder]);
  };
  visit(collection.folders, collection.requests, []);
  return out;
}

/** REST's run facet. */
export const restRun: ProtocolRun<RestSelected> = {
  groups(project) {
    const apis: RunGroup<RestSelected>[] = project.apis.map((api) => ({
      order: api.order,
      name: api.name,
      candidates: apiCandidates(api),
    }));
    // Webhook items deliver to a receiver rather than test an API: sent only when a selector names one.
    return project.webhooks === undefined
      ? apis
      : [...apis, { order: 0, name: 'Webhooks', candidates: webhookCandidates(project.webhooks), explicitOnly: true }];
  },

  whyNotRunnable(project, requestId) {
    if (project.webhooks !== undefined && findInTree(project.webhooks, requestId) !== undefined) {
      return 'A webhook cannot be a sequence step';
    }
    for (const api of project.apis) {
      const request = findInTree(api, requestId);
      if (request !== undefined) {
        return request.orphaned === true ? ORPHANED_STEP_REASON : undefined;
      }
    }
    return undefined;
  },

  async send(selected, scope, scripts) {
    const { context } = scope;
    if (scripts === undefined) {
      const prepared = await prepareRest(selected, context);
      const exchange = await sendRest(prepared.input);
      dropRefusedToken(context, prepared.input.auth, exchange.status === 401);
      return {
        subject: restSubject(exchange),
        raw: exchange,
        exchange: { kind: 'rest', rest: exchange },
        ...originOf(exchange.request.url),
      };
    }

    // Prepared with its secrets behind placeholders; the URL is rebuilt only when the script changed it.
    const prepared = await prepareRest(selected, { ...context, secretPlaceholders: scripts.placeholders });
    const before = restRequestSnapshot(prepared.input);
    const sent = await scripts.session.pre(before);
    const changed = applyRestSnapshot(prepared.input, before, sent);
    const restored = await scripts.placeholders.restore(
      { baseUrl: changed.baseUrl, request: changed.request },
      context.getSecret,
    );
    const exchange = await sendRest({ ...changed, ...restored });
    dropRefusedToken(context, prepared.input.auth, exchange.status === 401);
    return {
      subject: restSubject(exchange),
      raw: exchange,
      exchange: { kind: 'rest', rest: exchange },
      ...originOf(exchange.request.url),
      script: await scripts.session.post(sent, restResponseSnapshot(exchange)),
    };
  },

  async scriptTypes(selected, scope) {
    const { api } = selected;
    const openApi = await scope.memo(`rest:${api.id}:openapi`, () =>
      loadOpenApiDocument(scope.context.projectDir, api.slug),
    );
    return { generated: restScriptTypes(restOperationFor(openApi, selected.request.contract)) };
  },

  secretNeeds(selected, project) {
    return [
      ...secretNeedsOfAuth(restEffectiveAuth(selected)),
      ...keystoreNeeds(project, selected.request.settings.sslKeystoreRef),
      ...signingNeeds(selected),
    ];
  },
};
```

In `webhookCandidates` the item's `chain` is the `WebhookFolder[]` itself. `run/select.ts` writes `chain as unknown as readonly RestFolder[]` there today; with the module's own type the cast is unnecessary and `@typescript-eslint/no-unnecessary-type-assertion` rejects it.

- [ ] **Step 4: Create `packages/engine/src/rest/module.ts`**

The file in full:

```ts
/** REST as a protocol module (spec §3). */
import { defineProtocol } from '../protocol/module.js';
import { restRun } from './run.js';

/** The REST protocol: APIs, their folders and requests, and the project's webhook items. */
export const restProtocol = defineProtocol({
  kind: 'rest',
  feature: { id: 'rest', title: 'REST', default: true, stage: 'stable', requires: [] },
  run: restRun,
});
```

- [ ] **Step 5: Fix the four source files**

`run/prepare.ts`: the alias `type RestSelected = …` (line 143) and the pieces of part d are gone. `PreparedSend` is then:

```ts
export type PreparedSend =
  | PreparedSoap
  | PreparedRest
  | {
      readonly kind: 'grpc';
      // The streaming hooks are left out: a run makes unary calls, and wants only the result.
      readonly input: Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;
      readonly messageText: string;
    };
```

Its import block is then exactly:

```ts
import { expandGrpcInput } from '../grpc/expand.js';
import type { GrpcSendInput } from '../grpc/send.js';
import { toGrpcSendInput } from '../send-options.js';
import { grpcEffectiveAuth } from './effective-auth.js';
import { prepareRest } from '../rest/run.js';
import type { PreparedRest } from '../rest/run.js';
import { prepareSoap } from '../soap/run.js';
import type { PreparedSoap } from '../soap/run.js';
import type { SelectedRequest } from './select.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import { authFor, baseUrlFor, tlsFor, unresolvedError, withSecrets } from './send-helpers.js';

export { authFor } from './send-helpers.js';
export { scopesFor } from './context.js';
export type { RunContext, RunWorkspace } from './context.js';
```

`run/run.ts`: `restSubject` is gone and re-exported; `createRunSender` and `sendScripted` are not edited. Imports and re-exports are then exactly:

```ts
import { isCallbackAssertion, sendAwaitingCallbacks } from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import { evaluateAssertions } from '../assert/index.js';
import type { Assertion, AssertionResult, AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import { readGrpcDefinitionCache } from '../grpc/cache.js';
import { callGrpc } from '../grpc/call.js';
import type { GrpcCallResult } from '../grpc/call.js';
import { loadProtoSet } from '../grpc/proto/load.js';
import type { ProtoSet } from '../grpc/proto/load.js';
import { protoSetFromDescriptorSet } from '../grpc/reflection/descriptors.js';
import { apiDefinitionDir } from '../project/paths.js';
import { restSubject } from '../rest/run.js';
import { sendRest } from '../rest/send.js';
import type { RestExchange } from '../rest/send.js';
import { sendSoapRequest } from '../send.js';
import { loadDefinition, soapSubject } from '../soap/run.js';
import type { LoadedDefinition } from '../soap/run.js';
import type { SoapExchange } from '../types.js';
import { createRunTokenSource } from './oauth2-token.js';
import { prepareSend, scopesFor } from './prepare.js';
import { dropRefusedToken, originOf } from './send-helpers.js';
import type { RunContext } from './prepare.js';
import type { SelectedRequest } from './select.js';
import type { TransferResult } from '../sequence/run.js';
import { expandSendInput } from '../project/properties.js';
import type { OpenApiDocument } from '../rest/openapi/model.js';
import { loadOpenApiDocument } from '../script/contracts.js';
import { scriptProperties } from '../script/props.js';
import {
  activeScripts,
  type RequestScripting,
  type ScriptedRequest,
  type ScriptRunValues,
} from '../script/request-scripts.js';
import {
  SecretPlaceholders,
  applyGrpcSnapshot,
  applyRestSnapshot,
  applySoapSnapshot,
  grpcRequestSnapshot,
  grpcResponseSnapshot,
  restRequestSnapshot,
  restResponseSnapshot,
  soapRequestSnapshot,
  soapResponseSnapshot,
} from '../script/send.js';
import {
  listedSecrets,
  mergeScriptValues,
  scriptAssertions,
  scriptSession,
  scriptTypesFor,
  type SentScripts,
} from './script-support.js';

export { restSubject } from '../rest/run.js';
export { soapResponseSubject } from '../soap/run.js';
```

`run/secret-needs.ts`: `signingNeeds` is gone and the REST arm of `needsOf` delegates. `needsOf` is then:

```ts
function needsOf(selected: SelectedRequest, project: Project, scopeSets: readonly PropertyScopes[]): SecretNeed[] {
  if (selected.kind === 'rest') {
    return [...tokenNeeds(selected, scopeSets), ...restRun.secretNeeds(selected, project)];
  }
  if (selected.kind === 'grpc') {
    return [
      ...tokenNeeds(selected, scopeSets),
      ...secretNeedsOfAuth(grpcEffectiveAuth(selected)),
      ...keystoreNeeds(project, selected.request.settings.sslKeystoreRef),
    ];
  }
  return [...tokenNeeds(selected, scopeSets), ...soapRun.secretNeeds(selected, project)];
}
```

Its import block is then exactly:

```ts
import { resolveScopes } from '../project/environments.js';
import type { PropertyScopes } from '../project/properties.js';
import type { Project, PropertyMap } from '../project/model.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { secretEnvName, secretPseudoRef } from '../secrets/secret-token.js';
import { restRun } from '../rest/run.js';
import { activeScripts } from '../script/request-scripts.js';
import { soapRun } from '../soap/run.js';
import { resolveWorkspaceScopes, withActiveEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import { grpcEffectiveAuth } from './effective-auth.js';
import type { SelectedRequest } from './select.js';
import { keystoreNeeds, secretNamesInValue } from './send-helpers.js';

export { secretNamesInValue } from './send-helpers.js';
```

`run/effective-auth.ts`: `restEffectiveAuth` is gone; only `grpcEffectiveAuth` is left and the imports do not change.

- [ ] **Step 6: Run the tests**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/rest/run-module.test.ts`
Expected: PASS, 9 tests.

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run packages/engine/test/unit/sequence`
Expected: PASS, 13 files, 135 tests; `webhook-signing.test.ts` and `send-order.test.ts` among them and not edited.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run`
Expected: PASS, 6 files, 34 tests.

- [ ] **Step 7: Format, check, commit**

```bash
pnpm exec prettier --write packages/engine/src/rest/run.ts packages/engine/src/rest/module.ts packages/engine/src/run packages/engine/test/unit/rest/run-module.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/rest/run.ts packages/engine/src/rest/module.ts packages/engine/src/run packages/engine/test/unit/rest/run-module.test.ts
git commit -m "refactor(engine): REST's run facet as a module, webhook items included (#184)"
```

Expected: `pnpm check` green.

---

### Task 1.6: gRPC's run facet and WebSocket's module

One task for two protocols: WebSocket's module is forty lines with no moved code, and with gRPC gone `run/prepare.ts` reaches its final form and `run/effective-auth.ts` is empty, which is one reviewable end state.

**Files:**
- Create: `packages/engine/src/grpc/run.ts`, `packages/engine/src/grpc/module.ts`, `packages/engine/src/ws/module.ts`
- Modify: `packages/engine/src/run/prepare.ts` (whole file), `packages/engine/src/run/run.ts`, `packages/engine/src/run/secret-needs.ts`
- Delete: `packages/engine/src/run/effective-auth.ts`
- Test: `packages/engine/test/unit/grpc/run-module.test.ts`, `packages/engine/test/unit/ws/module.test.ts` (new)

**Interfaces:**
- Consumes: `ProtocolRun`, `RunGroup`, `RunScope`, `SelectedBase`, `defineProtocol`; `run/context.ts`; `run/send-helpers.ts`; `run/tree.ts`; `SentRequest` (type, `run/run.ts`).
- Produces:
  - `interface GrpcSelected { kind: 'grpc'; path; group; api: GrpcApi; chain: readonly GrpcFolder[]; request: GrpcRequestDef }`
  - `interface PreparedGrpc { kind: 'grpc'; input: Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>; messageText: string }`
  - `grpcEffectiveAuth(selected: GrpcSelected): AuthConfig`
  - `prepareGrpc(selected: GrpcSelected, context: RunContext): Promise<PreparedGrpc>`
  - `grpcSubject(result: GrpcCallResult): AssertionSubject`
  - `grpcRun: ProtocolRun<GrpcSelected>`; memo key `grpc:<api id>:proto-set`
  - `grpcProtocol` (`grpc/module.ts`), `wsProtocol` (`ws/module.ts`)
  - until Task 1.7 only: `loadProtoSetFor` and `GRPC_UNAUTHENTICATED` are exported, because `run/run.ts` still uses them
  - `type PreparedSend = PreparedSoap | PreparedRest | PreparedGrpc`

- [ ] **Step 1: Write the failing tests**

`packages/engine/test/unit/grpc/run-module.test.ts`, the file in full:

```ts
/** gRPC's run facet on its own: unary calls only, why a request cannot run, its needs, one send. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest } from '../../../src/grpc/model.js';
import { grpcProtocol } from '../../../src/grpc/module.js';
import { grpcRun } from '../../../src/grpc/run.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';

const { events } = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('../../../src/grpc/call.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/grpc/call.js')>()),
  callGrpc: (input: { readonly target: string; readonly messageText: string }) => {
    events.push(`send ${input.target} ${input.messageText}`);
    return Promise.resolve({
      exchange: {
        status: 0,
        statusName: 'OK',
        headers: {},
        trailers: {},
        rawRequest: new Uint8Array(),
        rawResponse: new Uint8Array(),
        durationMs: 1,
      },
      methodKind: 'unary',
      requestType: '',
      responseType: '',
      requestMessages: [],
      responseMessages: [{ json: { message: 'Hello' } }],
    });
  },
}));

const SERVICE = 'wirebench.greet.Greeter';

function api(name: string, slug: string, order: number) {
  return createGrpcApi(name, {
    id: `api-${slug}`,
    slug,
    order,
    target: 'localhost:50051',
    tls: false,
    auth: { type: 'bearer', tokenRef: 'ref-token' },
    requests: [
      createGrpcRequest('Hello', {
        id: `${slug}-hello`,
        slug: 'hello',
        order: 1,
        service: SERVICE,
        method: 'SayHello',
        message: '{"name":"${secret:tenant}"}',
      }),
      createGrpcRequest('Chat', { id: `${slug}-chat`, order: 0, methodKind: 'bidi-streaming' }),
      { ...createGrpcRequest('Gone', { id: `${slug}-gone`, order: 2 }), orphaned: true },
      {
        ...createGrpcRequest('Both', { id: `${slug}-both`, order: 3, methodKind: 'server-streaming' }),
        orphaned: true,
      },
    ],
    folders: [
      createGrpcFolder('Admin', {
        id: `${slug}-admin`,
        slug: 'admin',
        order: 0,
        requests: [createGrpcRequest('Fail', { id: `${slug}-fail`, slug: 'fail', service: SERVICE, method: 'Fail' })],
      }),
    ],
  });
}

const project: Project = {
  ...createProject('gRPC module', { id: 'proj-grpc' }),
  grpcApis: [api('Greeter', 'greeter', 1), api('Uncached', 'uncached', 0)],
};

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wb-grpc-module-'));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  events.length = 0;
});

function context(): RunContext {
  return {
    project,
    projectDir: dir,
    overrides: {},
    getSecret: (ref) => {
      events.push(`secret ${ref}`);
      return Promise.resolve('abc123def456ghi789');
    },
  };
}

const itemAt = (path: string) =>
  grpcRun
    .groups(project)
    .flatMap((group) => group.candidates)
    .find((candidate) => candidate.item.path === path)?.item;

describe('grpcRun.groups', () => {
  it('offers one group per API with its unary, non-orphaned requests in explorer order', () => {
    expect(grpcRun.groups(project).map((group) => [group.order, group.name, group.explicitOnly])).toEqual([
      [1, 'Greeter', undefined],
      [0, 'Uncached', undefined],
    ]);
    const [greeter] = grpcRun.groups(project);
    expect(greeter?.candidates.map((candidate) => [candidate.item.path, candidate.diskPath])).toEqual([
      ['Greeter/Admin/Fail', 'apis/greeter/requests/admin/fail'],
      ['Greeter/Hello', 'apis/greeter/requests/hello'],
    ]);
  });

  it('offers exactly what a run selects of gRPC', () => {
    expect(selectRequests(project, ['Greeter']).selected).toEqual(
      grpcRun.groups(project)[0]?.candidates.map((candidate) => candidate.item),
    );
  });
});

describe('grpcRun.whyNotRunnable', () => {
  it('names streaming before orphaned, and says nothing for a unary call', () => {
    const streaming = 'A streaming gRPC call cannot be a sequence step; only unary calls can';
    expect(grpcRun.whyNotRunnable(project, 'greeter-chat')).toBe(streaming);
    expect(grpcRun.whyNotRunnable(project, 'greeter-both')).toBe(streaming);
    expect(grpcRun.whyNotRunnable(project, 'greeter-gone')).toBe('The request is no longer in its contract (orphaned)');
    expect(grpcRun.whyNotRunnable(project, 'greeter-fail')).toBeUndefined();
    expect(grpcRun.whyNotRunnable(project, 'nowhere')).toBeUndefined();
  });
});

describe('grpcRun.secretNeeds', () => {
  it('lists the effective auth through the folders to the API', () => {
    const fail = itemAt('Greeter/Admin/Fail');
    expect(fail && grpcRun.secretNeeds(fail, project)).toEqual([{ ref: 'ref-token', purpose: 'bearer token' }]);
  });
});

describe('grpcRun.send', () => {
  it('loads the schema, prepares, calls once, and reports a gRPC subject with the target as origin', async () => {
    const hello = itemAt('Greeter/Hello');
    const sent = hello && (await grpcRun.send(hello, createRunScope(context())));
    expect(events).toEqual([
      'secret ref-token',
      'secret secret:tenant',
      'send localhost:50051 {"name":"abc123def456ghi789"}',
    ]);
    expect(sent?.subject).toMatchObject({ protocol: 'grpc', status: 0, bodyText: '{"message":"Hello"}' });
    expect(sent?.exchange).toBeUndefined();
    expect(sent?.origin).toBe('localhost:50051');
  });

  it('refuses a call whose API has no cached definition before it asks for anything, and remembers', async () => {
    const hello = itemAt('Uncached/Hello');
    const scope = createRunScope(context());
    await expect(hello && grpcRun.send(hello, scope)).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    await expect(hello && grpcRun.send(hello, scope)).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    expect(events).toEqual([]);
  });
});

describe('grpcRun.scriptTypes', () => {
  it('types the messages from the schema, and leaves them untyped when the schema does not load', async () => {
    const scope = createRunScope(context());
    const typed = itemAt('Greeter/Hello');
    const untyped = itemAt('Uncached/Hello');
    expect((typed && (await grpcRun.scriptTypes(typed, scope)))?.generated).not.toContain('WbRequestMessage = unknown');
    expect((untyped && (await grpcRun.scriptTypes(untyped, scope)))?.generated).toContain('WbRequestMessage = unknown');
  });
});

describe('grpcProtocol', () => {
  it('is the grpc kind behind the grpc feature, with a run facet', () => {
    expect(grpcProtocol.kind).toBe('grpc');
    expect(grpcProtocol.feature).toEqual({ id: 'grpc', title: 'gRPC', default: true, stage: 'stable', requires: [] });
    expect(grpcProtocol.run?.groups(project)).toHaveLength(2);
  });
});
```

`packages/engine/test/unit/ws/module.test.ts`, the file in full:

```ts
/** WebSocket as a module: registered, never selected, and a reason for a sequence step. */
import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import type { RunScope, SelectedBase } from '../../../src/protocol/module.js';
import { createWsApi, createWsFolder, createWsRequest } from '../../../src/ws/model.js';
import { wsProtocol } from '../../../src/ws/module.js';

const project: Project = {
  ...createProject('WebSocket module', { id: 'proj-ws' }),
  wsApis: [
    createWsApi('Feed', {
      id: 'api-feed',
      requests: [createWsRequest('Ticker', { id: 'ws-ticker' })],
      folders: [createWsFolder('Admin', { id: 'ws-admin', requests: [createWsRequest('Audit', { id: 'ws-audit' })] })],
    }),
  ],
};

const selected: SelectedBase = {
  kind: 'websocket',
  path: 'Feed/Ticker',
  group: 'Feed',
  request: { id: 'ws-ticker', name: 'Ticker', slug: 'ticker' },
};

const scope = { context: { project, projectDir: '/nowhere', overrides: {} } } as RunScope;

describe('wsProtocol', () => {
  it('is the websocket kind behind the websocket feature', () => {
    expect(wsProtocol.kind).toBe('websocket');
    expect(wsProtocol.feature).toEqual({
      id: 'websocket',
      title: 'WebSocket',
      default: true,
      stage: 'stable',
      requires: [],
    });
  });

  it('offers a run no request', () => {
    expect(wsProtocol.run?.groups(project)).toEqual([]);
  });

  it('says why a WebSocket request cannot be a sequence step, wherever it sits in the tree', () => {
    expect(wsProtocol.run?.whyNotRunnable(project, 'ws-ticker')).toBe('A WebSocket request cannot be a sequence step');
    expect(wsProtocol.run?.whyNotRunnable(project, 'ws-audit')).toBe('A WebSocket request cannot be a sequence step');
    expect(wsProtocol.run?.whyNotRunnable(project, 'nowhere')).toBeUndefined();
  });

  it('cannot send, type or list needs: nothing ever reaches it', async () => {
    const message = 'A run cannot send a WebSocket request';
    await expect(wsProtocol.run?.send(selected, scope)).rejects.toThrow(message);
    await expect(wsProtocol.run?.scriptTypes(selected, scope)).rejects.toThrow(message);
    expect(() => wsProtocol.run?.secretNeeds(selected, project)).toThrow(message);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/grpc/run-module.test.ts packages/engine/test/unit/ws/module.test.ts`
Expected: FAIL: `src/grpc/run.js` and `src/ws/module.js` cannot be resolved.

- [ ] **Step 3: Create `packages/engine/src/grpc/run.ts`**

Top to bottom:

**(a) new.** Header and imports:

```ts
/**
 * gRPC's run facet (spec §3.3): unary calls only, since a stream needs an assertion model a run does
 * not have yet. The API's schema is loaded before the call is prepared: without a schema there is no
 * call, so no token is worth fetching. A schema that does not load is remembered for the run.
 */
import type { AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import type { AuthConfig } from '../project/model.js';
import { apiDefinitionDir } from '../project/paths.js';
import type { ProtocolRun, RunGroup, RunScope } from '../protocol/module.js';
import { resolveAuthChain } from '../rest/auth.js';
import { scopesFor } from '../run/context.js';
import type { RunContext } from '../run/context.js';
import {
  authFor,
  baseUrlFor,
  dropRefusedToken,
  keystoreNeeds,
  tlsFor,
  unresolvedError,
  withSecrets,
} from '../run/send-helpers.js';
import { ORPHANED_STEP_REASON, findInTree, walkTree } from '../run/tree.js';
import { grpcMessageTypes } from '../script/contracts.js';
import { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from '../script/send.js';
import { grpcScriptTypes } from '../script/types/grpc.js';
import { secretNeedsOfAuth } from '../secrets/env-names.js';
import { toGrpcSendInput } from '../send-options.js';
import { readGrpcDefinitionCache } from './cache.js';
import { callGrpc } from './call.js';
import type { GrpcCallResult } from './call.js';
import { expandGrpcInput } from './expand.js';
import type { GrpcApi, GrpcFolder, GrpcRequestDef } from './model.js';
import { loadProtoSet } from './proto/load.js';
import type { ProtoSet } from './proto/load.js';
import { protoSetFromDescriptorSet } from './reflection/descriptors.js';
import type { GrpcSendInput } from './send.js';
```

**(b) new.** The selection and the prepared call:

```ts
/** One saved gRPC request selected for a run. */
export interface GrpcSelected {
  readonly kind: 'grpc';
  readonly path: string;
  readonly group: string;
  readonly api: GrpcApi;
  readonly chain: readonly GrpcFolder[];
  readonly request: GrpcRequestDef;
}

/** A unary call ready for `callGrpc`, which also takes the API's proto set. */
export interface PreparedGrpc {
  readonly kind: 'grpc';
  // The streaming hooks are left out: a run makes unary calls, and wants only the result.
  readonly input: Omit<GrpcSendInput, 'messages' | 'onMessage' | 'onOpen'>;
  readonly messageText: string;
}
```

**(c) to (e) moved**, in this order:

| Part | Piece | From (lines at the start of the slice) | Change |
|---|---|---|---|
| c | `grpcEffectiveAuth` | `run/effective-auth.ts` 25–29 | parameter type `Extract<SelectedRequest, { kind: 'grpc' }>` becomes `GrpcSelected` |
| d | `prepareGrpc` | `run/prepare.ts` 548–590 (JSDoc 548–553) | new JSDoc and signature, below; the body is untouched |
| e | `loadProtoSetFor` | `run/run.ts` 278–303 | gains `export` (until Task 1.7) |
| e | `grpcSubject` | `run/run.ts` 305–322 | none (already exported) |
| e | `GRPC_UNAUTHENTICATED` | `run/run.ts` 324–325 | gains `export` (until Task 1.7) |

`prepareGrpc`'s JSDoc and first line (lines 548–554) are replaced by:

```ts
/**
 * The app's `resolveGrpcSend` plus what its send handler adds: the target through the
 * environment's override for the API (the slot a REST base URL uses), the settings ladder, one
 * expansion pass over target, metadata and message, then the request's own TLS identity and trust
 * decision and the chain's credentials. There is no proxy: the app sends gRPC direct as well.
 *
 * Exported for this module's tests and for `prepareSend`; not part of the run facet.
 *
 * @throws WirebenchError `unresolved-properties` | `secret-missing` | `auth-grant-unsupported` |
 * `keystore-missing`
 */
export async function prepareGrpc(selected: GrpcSelected, context: RunContext): Promise<PreparedGrpc> {
```

**(f) new.** The memoised schema and the run facet. `send` is the gRPC branch of `createRunSender` and of `sendScripted` (`run/run.ts`): the schema is loaded first, before anything is prepared, and a load that fails is remembered by `scope.memo` exactly as the sender's own `Map` of promises remembers it today. `scriptTypes` tolerates a schema that does not load (the messages are then untyped) and leaves the error to `send`:

```ts
/** The API's schema, read once per run; a failed load is remembered. */
function protoSetFor(api: GrpcApi, scope: RunScope): Promise<ProtoSet> {
  return scope.memo(`grpc:${api.id}:proto-set`, () => loadProtoSetFor(scope.context.projectDir, api));
}

const STREAMING_STEP_REASON = 'A streaming gRPC call cannot be a sequence step; only unary calls can';

/** gRPC's run facet. */
export const grpcRun: ProtocolRun<GrpcSelected> = {
  groups(project) {
    return project.grpcApis.map((api) => {
      const candidates: RunGroup<GrpcSelected>['candidates'][number][] = [];
      walkTree<GrpcFolder, GrpcRequestDef, GrpcSelected>(
        api,
        [],
        api.name,
        `apis/${api.slug}/requests`,
        (request, chain, group) =>
          request.orphaned === true || request.methodKind !== 'unary'
            ? undefined
            : { kind: 'grpc', path: `${group}/${request.name}`, group, api, chain, request },
        candidates,
      );
      return { order: api.order, name: api.name, candidates };
    });
  },

  whyNotRunnable(project, requestId) {
    for (const api of project.grpcApis) {
      const request = findInTree(api, requestId);
      if (request !== undefined) {
        if (request.methodKind !== 'unary') {
          return STREAMING_STEP_REASON;
        }
        return request.orphaned === true ? ORPHANED_STEP_REASON : undefined;
      }
    }
    return undefined;
  },

  async send(selected, scope, scripts) {
    // Before the send is prepared: without a schema there is no call, so no token is worth fetching.
    const protoSet = await protoSetFor(selected.api, scope);
    const { context } = scope;
    if (scripts === undefined) {
      const prepared = await prepareGrpc(selected, context);
      const result = await callGrpc({ ...prepared.input, set: protoSet, messageText: prepared.messageText });
      dropRefusedToken(context, prepared.input.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
      return { subject: grpcSubject(result), raw: result.exchange, origin: prepared.input.target };
    }

    const prepared = await prepareGrpc(selected, { ...context, secretPlaceholders: scripts.placeholders });
    const before = grpcRequestSnapshot(prepared.input, prepared.messageText);
    const sent = await scripts.session.pre(before);
    const changed = applyGrpcSnapshot(prepared.input, prepared.messageText, before, sent);
    const restored = await scripts.placeholders.restore(
      { metadata: changed.input.metadata, messageText: changed.messageText },
      context.getSecret,
    );
    const result = await callGrpc({
      ...changed.input,
      metadata: restored.metadata,
      set: protoSet,
      messageText: restored.messageText,
    });
    dropRefusedToken(context, prepared.input.auth, result.exchange.status === GRPC_UNAUTHENTICATED);
    return {
      subject: grpcSubject(result),
      raw: result.exchange,
      origin: prepared.input.target,
      script: await scripts.session.post(sent, grpcResponseSnapshot(result)),
    };
  },

  async scriptTypes(selected, scope) {
    // A schema that does not load leaves the messages untyped; the send reports the missing schema.
    const protoSet = await protoSetFor(selected.api, scope).catch(() => undefined);
    const types = grpcMessageTypes(protoSet, selected.request.service, selected.request.method);
    return {
      generated: grpcScriptTypes(types === undefined ? undefined : protoSet, types?.input ?? '', types?.output ?? ''),
    };
  },

  secretNeeds(selected, project) {
    return [
      ...secretNeedsOfAuth(grpcEffectiveAuth(selected)),
      ...keystoreNeeds(project, selected.request.settings.sslKeystoreRef),
    ];
  },
};
```

- [ ] **Step 4: Create `packages/engine/src/grpc/module.ts` and `packages/engine/src/ws/module.ts`**

`grpc/module.ts`, the file in full:

```ts
/** gRPC as a protocol module (spec §3). */
import { defineProtocol } from '../protocol/module.js';
import { grpcRun } from './run.js';

/** The gRPC protocol: APIs, their folders and their unary and streaming requests. */
export const grpcProtocol = defineProtocol({
  kind: 'grpc',
  feature: { id: 'grpc', title: 'gRPC', default: true, stage: 'stable', requires: [] },
  run: grpcRun,
});
```

`ws/module.ts`, the file in full. A run cannot send a WebSocket request, so `groups` offers none and the three methods nothing can reach reject with a plain `Error`:

```ts
/**
 * WebSocket as a protocol module (spec §3). A run cannot send a WebSocket request yet, so the run
 * facet offers no request and only answers why one cannot be a sequence step.
 */
import { defineProtocol } from '../protocol/module.js';
import type { ProtocolRun, SelectedBase } from '../protocol/module.js';
import type { SentRequest } from '../run/run.js';
import { findInTree } from '../run/tree.js';
import type { RequestScriptTypes } from '../script/request-scripts.js';
import type { SecretNeed } from '../secrets/env-names.js';

const NOT_RUNNABLE = 'A run cannot send a WebSocket request';

/** WebSocket's run facet: nothing to select, so nothing ever reaches `send`. */
const wsRun: ProtocolRun<SelectedBase> = {
  groups() {
    return [];
  },

  whyNotRunnable(project, requestId) {
    return project.wsApis.some((api) => findInTree(api, requestId) !== undefined)
      ? 'A WebSocket request cannot be a sequence step'
      : undefined;
  },

  send(): Promise<SentRequest> {
    return Promise.reject(new Error(NOT_RUNNABLE));
  },

  scriptTypes(): Promise<RequestScriptTypes> {
    return Promise.reject(new Error(NOT_RUNNABLE));
  },

  secretNeeds(): readonly SecretNeed[] {
    throw new Error(NOT_RUNNABLE);
  },
};

/** The WebSocket protocol: APIs, their folders and their saved requests. */
export const wsProtocol = defineProtocol({
  kind: 'websocket',
  feature: { id: 'websocket', title: 'WebSocket', default: true, stage: 'stable', requires: [] },
  run: wsRun,
});
```

- [ ] **Step 5: `run/prepare.ts` becomes a dispatcher**

With `prepareGrpc` and the alias `type GrpcSelected = …` (line 144) gone, nothing of a protocol is left in the file. The file in full:

```ts
/**
 * Turns one saved request into a send input, for a host with no editor: no draft to apply, no
 * user preferences to fold in, no renderer to keep credentials from. Each protocol module prepares
 * its own requests (`prepareSoap`, `prepareRest`, `prepareGrpc`); this file only picks the one for
 * the request's kind, and keeps the names the run module has always exported.
 */
import { prepareGrpc } from '../grpc/run.js';
import type { PreparedGrpc } from '../grpc/run.js';
import type { SelectedRequest } from './select.js';
import { prepareRest } from '../rest/run.js';
import type { PreparedRest } from '../rest/run.js';
import { prepareSoap } from '../soap/run.js';
import type { PreparedSoap } from '../soap/run.js';
import type { RunContext } from './context.js';

export { scopesFor } from './context.js';
export type { RunContext, RunWorkspace } from './context.js';
export { authFor } from './send-helpers.js';

/**
 * One request, ready for `sendSoapRequest` (with `scopes`), `sendRest`, or `callGrpc` (with the
 * API's proto set, which the caller loads: preparing a call needs no schema). It carries resolved
 * secret values (auth, `scopes.secrets`) but no list of them: the host masks what its `GetSecret`
 * handed out (see `GetSecret`).
 */
export type PreparedSend = PreparedSoap | PreparedRest | PreparedGrpc;

/**
 * @throws WirebenchError `unresolved-properties` | `endpoint-unresolved` | `secret-missing` |
 * `auth-grant-unsupported` | `wss-config-missing` | `keystore-missing` | `webhook-signing-secret`
 */
export function prepareSend(selected: SelectedRequest, context: RunContext): Promise<PreparedSend> {
  switch (selected.kind) {
    case 'soap':
      return prepareSoap(selected, context);
    case 'rest':
      return prepareRest(selected, context);
    case 'grpc':
      return prepareGrpc(selected, context);
  }
}
```

- [ ] **Step 6: Fix `run/run.ts` and `run/secret-needs.ts`, delete `run/effective-auth.ts`**

`run/run.ts`: the pieces of part e are gone; `createRunSender` and `sendScripted` are not edited. Imports and re-exports are then exactly:

```ts
import { isCallbackAssertion, sendAwaitingCallbacks } from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import { evaluateAssertions } from '../assert/index.js';
import type { Assertion, AssertionResult, AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import { callGrpc } from '../grpc/call.js';
import { GRPC_UNAUTHENTICATED, grpcSubject, loadProtoSetFor } from '../grpc/run.js';
import type { ProtoSet } from '../grpc/proto/load.js';
import { restSubject } from '../rest/run.js';
import { sendRest } from '../rest/send.js';
import type { RestExchange } from '../rest/send.js';
import { sendSoapRequest } from '../send.js';
import { loadDefinition, soapSubject } from '../soap/run.js';
import type { LoadedDefinition } from '../soap/run.js';
import type { SoapExchange } from '../types.js';
import { createRunTokenSource } from './oauth2-token.js';
import { prepareSend, scopesFor } from './prepare.js';
import { dropRefusedToken, originOf } from './send-helpers.js';
import type { RunContext } from './prepare.js';
import type { SelectedRequest } from './select.js';
import type { TransferResult } from '../sequence/run.js';
import { expandSendInput } from '../project/properties.js';
import type { OpenApiDocument } from '../rest/openapi/model.js';
import { loadOpenApiDocument } from '../script/contracts.js';
import { scriptProperties } from '../script/props.js';
import {
  activeScripts,
  type RequestScripting,
  type ScriptedRequest,
  type ScriptRunValues,
} from '../script/request-scripts.js';
import {
  SecretPlaceholders,
  applyGrpcSnapshot,
  applyRestSnapshot,
  applySoapSnapshot,
  grpcRequestSnapshot,
  grpcResponseSnapshot,
  restRequestSnapshot,
  restResponseSnapshot,
  soapRequestSnapshot,
  soapResponseSnapshot,
} from '../script/send.js';
import {
  listedSecrets,
  mergeScriptValues,
  scriptAssertions,
  scriptSession,
  scriptTypesFor,
  type SentScripts,
} from './script-support.js';

export { grpcSubject } from '../grpc/run.js';
export { restSubject } from '../rest/run.js';
export { soapResponseSubject } from '../soap/run.js';
```

`run/secret-needs.ts`: the gRPC arm of `needsOf` delegates; the function is then three branches that each ask a module:

```ts
function needsOf(selected: SelectedRequest, project: Project, scopeSets: readonly PropertyScopes[]): SecretNeed[] {
  if (selected.kind === 'rest') {
    return [...tokenNeeds(selected, scopeSets), ...restRun.secretNeeds(selected, project)];
  }
  if (selected.kind === 'grpc') {
    return [...tokenNeeds(selected, scopeSets), ...grpcRun.secretNeeds(selected, project)];
  }
  return [...tokenNeeds(selected, scopeSets), ...soapRun.secretNeeds(selected, project)];
}
```

Its import block is then exactly:

```ts
import { grpcRun } from '../grpc/run.js';
import { resolveScopes } from '../project/environments.js';
import type { PropertyScopes } from '../project/properties.js';
import type { Project, PropertyMap } from '../project/model.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { secretEnvName, secretPseudoRef } from '../secrets/secret-token.js';
import { restRun } from '../rest/run.js';
import { activeScripts } from '../script/request-scripts.js';
import { soapRun } from '../soap/run.js';
import { resolveWorkspaceScopes, withActiveEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import type { SelectedRequest } from './select.js';
import { secretNamesInValue } from './send-helpers.js';

export { secretNamesInValue } from './send-helpers.js';
```

`run/effective-auth.ts` has no function left and no importer:

```bash
git rm packages/engine/src/run/effective-auth.ts
```

- [ ] **Step 7: Run the tests**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/grpc/run-module.test.ts packages/engine/test/unit/ws/module.test.ts`
Expected: PASS, 2 files, 12 tests (`grpc` 8, `ws` 4).

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run packages/engine/test/unit/sequence`
Expected: PASS, 13 files, 135 tests; `grpc-subject.test.ts` and `send-order.test.ts` among them and not edited.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run`
Expected: PASS, 6 files, 34 tests.

- [ ] **Step 8: Format, check, commit**

```bash
pnpm exec prettier --write packages/engine/src/grpc/run.ts packages/engine/src/grpc/module.ts packages/engine/src/ws/module.ts packages/engine/src/run packages/engine/test/unit/grpc/run-module.test.ts packages/engine/test/unit/ws/module.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/grpc/run.ts packages/engine/src/grpc/module.ts packages/engine/src/ws/module.ts packages/engine/src/run packages/engine/test/unit/grpc/run-module.test.ts packages/engine/test/unit/ws/module.test.ts
git commit -m "refactor(engine): gRPC's run facet and WebSocket's module (#184)"
```

Expected: `pnpm check` green.

---

### Task 1.7: `protocols.ts`, and the run dispatches through the registry

The four modules exist. This task adds the one file that imports them all, and rewrites the generic half of the run so that it asks the registry: `select.ts` for groups and reasons, `run.ts` for `send` and `scriptTypes`, `secret-needs.ts` for `secretNeeds`. The `scripts` feature is registered and not yet enforced: a run with `scripts` switched off still runs scripts until slice 2.

**Two rules of this task that a reviewer should check by hand:**

1. `defaultRegistry()` is called inside functions only (as a default parameter value or in a body). `protocols.ts` imports the modules, the modules import `run/run.ts` and `run/select.ts` for types; a call at module scope would run before the modules are initialised.
2. No module file (`soap/run.ts`, `rest/run.ts`, `grpc/run.ts`, `ws/module.ts`) imports a *value* from `run/select.ts`, `run/run.ts`, `run/secret-needs.ts` or `protocols.ts`. Type imports are fine.

**Behaviour at the edges.** Spec §5.3 fixes the order of a scripted send as `scriptTypes`, the type check, then `send`. Today a gRPC send loads the schema first. Two results change, both for a gRPC request with scripts switched on whose API has no cached definition:

- with no script host in the run: the request errors with `script-unavailable` where it errors with `grpc-definition-missing` today;
- with a script host, and a script that fails the check against untyped messages: `script-type-error` where it is `grpc-definition-missing` today. A script that passes the untyped check still ends in `grpc-definition-missing`, from `send`.

Nothing else changes: `send-order.test.ts` passes unedited, which covers the order of `getSecret`, the token fetch, the contract load, the scripts and the wire for all three protocols, with and without scripts.

**Files:**
- Create: `packages/engine/src/protocols.ts`
- Modify: `packages/engine/src/run/select.ts` (whole file), `packages/engine/src/run/secret-needs.ts` (whole file), `packages/engine/src/run/run.ts` (imports and the part from `createRunSender` to `checkRunScripts`), `packages/engine/src/run/prepare.ts` (one import), `packages/engine/src/sequence/run.ts` (one option), `packages/engine/src/soap/run.ts` and `packages/engine/src/grpc/run.ts` (five `export` keywords removed)
- Test: `packages/engine/test/unit/run/registry-dispatch.test.ts` (new)

**Interfaces:**
- Consumes: `soapProtocol`, `restProtocol`, `grpcProtocol`, `wsProtocol`; `createProtocolRegistry`; `createRunScope`, `scopeWith`; `ScriptedSend`.
- Produces:
  - `protocols.ts`: `BUILTIN_PROTOCOLS: readonly ProtocolModule[]` (soap, rest, grpc, websocket), `SCRIPTS_FEATURE: FeatureDescriptor`, `createBuiltinRegistry(switches?: Readonly<Record<string, boolean>>): ProtocolRegistry`, `defaultRegistry(): ProtocolRegistry`, `type SelectedRequest = SoapSelected | RestSelected | GrpcSelected`, `type SentExchange`
  - `selectRequests(project, selectors, registry = defaultRegistry())`
  - `findStepRequest(project, requestId, registry = defaultRegistry())`
  - `secretNeedsOf(selected, project, overrides = {}, workspace?, registry = defaultRegistry())`
  - `createRunSender(context)` and `checkRunScripts(selected, context)` read `context.registry ?? defaultRegistry()`
  - `RunSequenceOptions.registry?: ProtocolRegistry`
  - `run/select.ts` still exports the type `SelectedRequest`; `run/run.ts` still exports `grpcSubject`, `restSubject`, `soapResponseSubject` and the type `SentExchange`. `run/index.ts` and `src/index.ts` are not touched in this slice.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/unit/run/registry-dispatch.test.ts`, the file in full:

```ts
/** Select, step lookup, secret needs and the sender ask the registry, and a switch turns a protocol off. */
import { describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { defineProtocol } from '../../../src/protocol/module.js';
import type { RunGroup, SelectedBase } from '../../../src/protocol/module.js';
import { createProtocolRegistry } from '../../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE, createBuiltinRegistry, defaultRegistry } from '../../../src/protocols.js';
import { createApi, createRestRequest, entry } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { checkRunScripts, createRunSender } from '../../../src/run/run.js';
import { secretNeedsOf } from '../../../src/run/secret-needs.js';
import { findStepRequest, selectRequests } from '../../../src/run/select.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import type { ScriptSandbox } from '../../../src/script/sandbox/host.js';
import { runSequence } from '../../../src/sequence/run.js';
import type { SequenceDef } from '../../../src/sequence/model.js';
import { createWsApi, createWsRequest } from '../../../src/ws/model.js';

const project: Project = {
  ...createProject('Dispatch', { id: 'proj-dispatch' }),
  apis: [
    createApi('Api', {
      id: 'api-1',
      slug: 'api',
      order: 0,
      auth: { type: 'bearer', tokenRef: 'ref-token' },
      requests: [
        {
          ...createRestRequest('Ping', { id: 'req-ping', url: 'https://api.example.test/ping' }),
          headers: [entry('X-Tenant', '${secret:tenant}')],
          scripts: { api: 'wirebench', enabled: true, secrets: [], pre: { text: '' } },
        },
      ],
    }),
  ],
  grpcApis: [
    createGrpcApi('Greeter', {
      id: 'api-greeter',
      slug: 'greeter',
      order: 1,
      requests: [
        createGrpcRequest('Hello', { id: 'g-hello' }),
        createGrpcRequest('Chat', { id: 'g-chat', methodKind: 'bidi-streaming' }),
      ],
    }),
  ],
  wsApis: [
    createWsApi('Feed', { id: 'api-feed', order: 2, requests: [createWsRequest('Ticker', { id: 'ws-ticker' })] }),
  ],
};

const context: RunContext = {
  project,
  projectDir: '/nowhere',
  overrides: {},
  getSecret: () => Promise.resolve(undefined),
};

describe('the built-in registry', () => {
  it('holds the four protocols in order, and the scripts feature', () => {
    expect(BUILTIN_PROTOCOLS.map((module) => module.kind)).toEqual(['soap', 'rest', 'grpc', 'websocket']);
    expect(createBuiltinRegistry().features.descriptors.map((descriptor) => descriptor.id)).toEqual([
      'soap',
      'rest',
      'grpc',
      'websocket',
      'scripts',
    ]);
    expect(SCRIPTS_FEATURE).toEqual({ id: 'scripts', title: 'Scripts', default: true, stage: 'stable', requires: [] });
  });

  it('is created once as the default, with every feature on', () => {
    expect(defaultRegistry()).toBe(defaultRegistry());
    expect(defaultRegistry().modules).toHaveLength(4);
    expect(defaultRegistry().features.isEnabled('scripts')).toBe(true);
  });

  it('applies switches', () => {
    const registry = createBuiltinRegistry({ grpc: false, scripts: false });
    expect(registry.modules.map((module) => module.kind)).toEqual(['soap', 'rest', 'websocket']);
    expect(registry.features.isEnabled('scripts')).toBe(false);
  });
});

describe('a protocol switched off', () => {
  const withoutGrpc = createBuiltinRegistry({ grpc: false });
  const withoutRest = createBuiltinRegistry({ rest: false });

  it('has no request to select, so a selector naming one is unmatched', () => {
    expect(selectRequests(project, []).selected.map((item) => item.path)).toEqual(['Api/Ping', 'Greeter/Hello']);
    expect(selectRequests(project, [], withoutGrpc).selected.map((item) => item.path)).toEqual(['Api/Ping']);
    expect(selectRequests(project, ['Greeter'], withoutGrpc)).toEqual({ selected: [], unmatched: ['Greeter'] });
  });

  it('leaves a step naming its request missing, with or without a reason to give', () => {
    expect(findStepRequest(project, 'g-hello').kind).toBe('found');
    expect(findStepRequest(project, 'g-chat').kind).toBe('unsupported');
    expect(findStepRequest(project, 'g-hello', withoutGrpc)).toEqual({ kind: 'missing' });
    expect(findStepRequest(project, 'g-chat', withoutGrpc)).toEqual({ kind: 'missing' });
    expect(findStepRequest(project, 'ws-ticker')).toEqual({
      kind: 'unsupported',
      reason: 'A WebSocket request cannot be a sequence step',
    });
    expect(findStepRequest(project, 'ws-ticker', createBuiltinRegistry({ websocket: false }))).toEqual({
      kind: 'missing',
    });
  });

  it('is what a sequence run looks its steps up in', async () => {
    const sequence: SequenceDef = {
      id: 'seq-1',
      name: 'One step',
      slug: 'one-step',
      order: 0,
      settings: { stopOnFailure: true },
      steps: [
        { id: 'step-1', requestId: 'g-hello', enabled: true, requestAssertions: true, assertions: [], transfers: [] },
      ],
    };
    const notSent = () => Promise.resolve({ error: { code: 'not-sent', message: 'not sent in this test' } });
    const on = await runSequence(sequence, project, notSent);
    expect(on.steps[0]?.error?.code).toBe('not-sent');
    const off = await runSequence(sequence, project, notSent, { registry: withoutGrpc });
    expect(off.steps[0]?.error?.code).toBe('sequence-step-missing-request');
  });

  it('keeps the generic secret needs of a request already selected, and drops its module’s', () => {
    const { selected } = selectRequests(project, ['Api/Ping']);
    expect(secretNeedsOf(selected, project).map((need) => need.ref)).toEqual(['secret:tenant', 'ref-token']);
    expect(secretNeedsOf(selected, project, {}, undefined, withoutRest).map((need) => need.ref)).toEqual([
      'secret:tenant',
    ]);
  });

  it('refuses a send of a request already selected with feature-disabled', async () => {
    const [ping] = selectRequests(project, ['Api/Ping']).selected;
    const send = createRunSender({ ...context, registry: withoutRest });
    await expect(ping && send(ping)).rejects.toMatchObject({
      code: 'feature-disabled',
      message: 'REST is switched off',
      details: { feature: 'rest' },
    });
  });

  it('reports the same refusal from the script check', async () => {
    const { selected } = selectRequests(project, ['Api/Ping']);
    const scripting = new RequestScripting({ sandbox: {} as ScriptSandbox });
    const errors = await checkRunScripts(selected, { ...context, scripting, registry: withoutRest });
    expect(errors.map((error) => error.code)).toEqual(['feature-disabled']);
    expect(await checkRunScripts(selected, { ...context, scripting })).toEqual([]);
  });
});

describe('the order of groups', () => {
  const item = (kind: string, name: string): SelectedBase => ({
    kind,
    path: `${name}/r`,
    group: name,
    request: { id: `${kind}-${name}`, name: 'r', slug: 'r' },
  });
  const group = (kind: string, order: number, name: string, explicitOnly = false): RunGroup => ({
    order,
    name,
    candidates: [{ item: item(kind, name), diskPath: `apis/${name}/requests/r` }],
    ...(explicitOnly ? { explicitOnly: true as const } : {}),
  });
  const module = (kind: string, groups: readonly RunGroup[]) =>
    defineProtocol({
      kind,
      feature: { id: kind, title: kind, default: true, stage: 'stable', requires: [] },
      run: {
        groups: () => groups,
        whyNotRunnable: () => undefined,
        send: () => Promise.reject(new Error('not sent in this test')),
        scriptTypes: () => Promise.resolve({ generated: '' }),
        secretNeeds: () => [],
      },
    });
  const registry = createProtocolRegistry([
    module('one', [group('one', 2, 'late'), group('one', 1, 'tie'), group('one', 0, 'hooks-b', true)]),
    module('two', [group('two', 1, 'tie'), group('two', 1, 'alpha'), group('two', 0, 'hooks-a', true)]),
  ]);
  const empty = createProject('Empty', { id: 'p0' });

  it('is by order, then name, then registration, with explicit-only groups left out of a run of everything', () => {
    expect(selectRequests(empty, [], registry).selected.map((s) => `${s.kind}:${s.group}`)).toEqual([
      'two:alpha',
      'one:tie',
      'two:tie',
      'one:late',
    ]);
  });

  it('puts explicit-only groups last when a selector reaches them', () => {
    const everything = ['alpha', 'tie', 'late', 'hooks-a', 'hooks-b'];
    expect(selectRequests(empty, everything, registry).selected.map((s) => `${s.kind}:${s.group}`)).toEqual([
      'two:alpha',
      'one:tie',
      'two:tie',
      'one:late',
      'two:hooks-a',
      'one:hooks-b',
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run/registry-dispatch.test.ts`
Expected: FAIL: `src/protocols.js` cannot be resolved.

- [ ] **Step 3: Create `packages/engine/src/protocols.ts`**

The file in full:

```ts
/**
 * The composition file (spec §4.3): the one core file that imports every built-in protocol module.
 * It holds the built-in registry every entry point falls back to, and the union types a host that
 * narrows on `kind` uses.
 */
import { grpcProtocol } from './grpc/module.js';
import type { GrpcSelected } from './grpc/run.js';
import type { FeatureDescriptor } from './protocol/features.js';
import type { ProtocolModule } from './protocol/module.js';
import { createProtocolRegistry } from './protocol/registry.js';
import type { ProtocolRegistry } from './protocol/registry.js';
import { restProtocol } from './rest/module.js';
import type { RestSelected } from './rest/run.js';
import type { RestExchange } from './rest/send.js';
import { soapProtocol } from './soap/module.js';
import type { SoapSelected } from './soap/run.js';
import type { SoapExchange } from './types.js';
import { wsProtocol } from './ws/module.js';

/** The four built-in protocols, in the order their containers tie-break in the explorer. */
export const BUILTIN_PROTOCOLS: readonly ProtocolModule[] = [soapProtocol, restProtocol, grpcProtocol, wsProtocol];

/** The feature that switches request scripts (#63). Not a protocol, so the registry is told of it. */
export const SCRIPTS_FEATURE: FeatureDescriptor = {
  id: 'scripts',
  title: 'Scripts',
  default: true,
  stage: 'stable',
  requires: [],
};

/** A registry of the built-in protocols and the `scripts` feature, with `switches` applied. */
export function createBuiltinRegistry(switches?: Readonly<Record<string, boolean>>): ProtocolRegistry {
  return createProtocolRegistry(BUILTIN_PROTOCOLS, {
    features: [SCRIPTS_FEATURE],
    ...(switches !== undefined ? { switches } : {}),
  });
}

let builtin: ProtocolRegistry | undefined;

/**
 * The registry an entry point uses when its caller passes none: the built-in protocols with every
 * feature on. Created on first use and kept. Call it inside a function, never at module scope: the
 * modules import core files that import this one.
 */
export function defaultRegistry(): ProtocolRegistry {
  builtin ??= createBuiltinRegistry();
  return builtin;
}

/** One saved request selected for a run, of any built-in protocol a run can send. */
export type SelectedRequest = SoapSelected | RestSelected | GrpcSelected;

/** The exchange a request travelled as, for a host that keeps more of it than a report does. */
export type SentExchange =
  { readonly kind: 'soap'; readonly soap: SoapExchange } | { readonly kind: 'rest'; readonly rest: RestExchange };
```

`RequestSnapshot` and `ResponseSnapshot`, which the preamble also lists for this file, arrive with the scripting facet in slice 2.

- [ ] **Step 4: Replace `packages/engine/src/run/select.ts`**

The file in full. What is gone: the union `SelectedRequest` (now in `protocols.ts`, re-exported here), `walkRest`, `walkGrpc`, `walkWebhooks`, and every loop over `project.interfaces`, `project.apis`, `project.grpcApis`, `project.wsApis` and `project.webhooks`.

```ts
/**
 * Which requests a run covers, and in what order: the order the explorer shows, so a report reads
 * like the project. Every container shares one ordering space (see `Project.apis`). The requests
 * themselves come from the protocol modules: nothing here names a protocol.
 */
import type { Project } from '../project/model.js';
import type { RunGroup, SelectedBase } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import type { SelectedRequest } from '../protocols.js';
import { byOrder } from './tree.js';

export type { SelectedRequest } from '../protocols.js';

interface Candidate {
  readonly item: SelectedBase;
  /** The request's path on disk, without the `.request.yaml` suffix. */
  readonly diskPath: string;
  /** In a group a run sends only when a selector names it (a webhook item). */
  readonly explicitOnly: boolean;
}

/**
 * A module's selection under the built-in union. A registry may hold a module that is not built in;
 * its items travel under this type too, and a caller that narrows on `kind` simply never matches them.
 */
const asSelected = (item: SelectedBase): SelectedRequest => item as SelectedRequest;

/** Every runnable request, container by container in explorer order, `explicitOnly` groups last. */
function candidates(project: Project, registry: ProtocolRegistry): Candidate[] {
  const groups: RunGroup[] = registry.modules.flatMap((module) => module.run?.groups(project) ?? []);
  const inOrder = [
    ...groups.filter((group) => group.explicitOnly !== true).sort(byOrder),
    ...groups.filter((group) => group.explicitOnly === true).sort(byOrder),
  ];
  return inOrder.flatMap((group) =>
    group.candidates.map(({ item, diskPath }) => ({ item, diskPath, explicitOnly: group.explicitOnly === true })),
  );
}

function normalise(selector: string): string {
  return selector
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.request\.yaml$/, '')
    .replace(/\/$/, '');
}

const covers = (selector: string, candidate: string): boolean =>
  candidate === selector || candidate.startsWith(`${selector}/`);

/**
 * Resolves `selectors` (display paths or on-disk paths, matched at a `/` boundary) against the
 * project's requests, in explorer order. An empty `selectors` list selects everything but the webhook
 * items: those deliver to a receiver rather than test an API, so a run sends one only when a selector
 * covers it (`Webhooks/…` or `webhooks/requests/…`). A WebSocket
 * API, and a gRPC request that streams, are skipped: neither is runnable from the command line yet,
 * and there is no per-selector reason to report — a selector naming one simply matches nothing and
 * surfaces through `unmatched`, same as a typo would. `unmatched` lists every selector that covered no
 * request, so the runner can refuse the run rather than quietly test nothing.
 *
 * `registry` is the set of protocol modules asked for their requests; the built-in ones by default.
 */
export function selectRequests(
  project: Project,
  selectors: readonly string[],
  registry: ProtocolRegistry = defaultRegistry(),
): { selected: SelectedRequest[]; unmatched: string[] } {
  const all = candidates(project, registry);
  if (selectors.length === 0) {
    return { selected: all.filter((c) => !c.explicitOnly).map((c) => asSelected(c.item)), unmatched: [] };
  }
  const matches = (selector: string, c: Candidate): boolean => {
    const s = normalise(selector);
    return covers(s, c.item.path) || covers(s, c.diskPath);
  };
  return {
    selected: all.filter((c) => selectors.some((s) => matches(s, c))).map((c) => asSelected(c.item)),
    unmatched: selectors.filter((s) => !all.some((c) => matches(s, c))),
  };
}

/** Where a sequence step's request id leads. */
export type StepRequestLookup =
  | { readonly kind: 'found'; readonly selected: SelectedRequest }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsupported'; readonly reason: string };

/**
 * Finds the request a sequence step names by id, among the requests a run can send, with the same
 * context `selectRequests` gives. A request that exists but cannot run (a webhook item, a WebSocket
 * request, a streaming gRPC call, one orphaned by its contract) says why, so the step errors with a
 * reason rather than as missing. Every module is asked for a reason before any candidate is looked
 * at: a webhook item is a candidate of a run, and still not a step.
 */
export function findStepRequest(
  project: Project,
  requestId: string,
  registry: ProtocolRegistry = defaultRegistry(),
): StepRequestLookup {
  for (const module of registry.modules) {
    const reason = module.run?.whyNotRunnable(project, requestId);
    if (reason !== undefined) {
      return { kind: 'unsupported', reason };
    }
  }
  const runnable = candidates(project, registry).find((candidate) => candidate.item.request.id === requestId);
  return runnable !== undefined ? { kind: 'found', selected: asSelected(runnable.item) } : { kind: 'missing' };
}
```

`findStepRequest` asks every module for a reason before it looks at a candidate. Today a runnable candidate is looked for first; the two orders differ only if two requests in different containers had the same id, which ULIDs rule out. The new order is what makes a webhook item, which is a candidate of a run, answer with its reason.

A disabled protocol is not in `registry.modules`, so a step naming one of its requests is `missing`, with no reason: the module that could give one is off.

- [ ] **Step 5: The generic half of `packages/engine/src/run/run.ts`**

Replace everything from the first `import` down to, and including, the three `export { … } from` lines with:

```ts
import { isCallbackAssertion, sendAwaitingCallbacks } from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import { evaluateAssertions } from '../assert/index.js';
import type { Assertion, AssertionResult, AssertionSubject } from '../assert/model.js';
import { isWirebenchError, WirebenchError } from '../errors.js';
import type { ProtocolRun, SelectedBase } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import type { SelectedRequest, SentExchange } from '../protocols.js';
import { scriptProperties } from '../script/props.js';
import { activeScripts, type RequestScripting, type ScriptedRequest } from '../script/request-scripts.js';
import { SecretPlaceholders } from '../script/send.js';
import type { TransferResult } from '../sequence/run.js';
import { scopesFor } from './context.js';
import type { RunContext } from './context.js';
import { createRunTokenSource } from './oauth2-token.js';
import { createRunScope, scopeWith } from './scope.js';
import {
  listedSecrets,
  mergeScriptValues,
  scriptAssertions,
  scriptSession,
  type ScriptSession,
  type SentScripts,
} from './script-support.js';

// The subjects are each protocol's own; they stay exported from here until the public exports move
// to the modules (slice 5 of the protocol modules plan).
export { grpcSubject } from '../grpc/run.js';
export type { SentExchange } from '../protocols.js';
export { restSubject } from '../rest/run.js';
export { soapResponseSubject } from '../soap/run.js';
```

Delete, by name:

- the aliases `type SoapSelected`, `type GrpcSelected`, `type RestSelected` (lines 142–144)
- the type `SentExchange` with its JSDoc (lines 344–346); it is in `protocols.ts` and re-exported above
- `createRunSender` with its JSDoc (368–488), `sendScripted` with its JSDoc (490–586) and `checkRunScripts` with its JSDoc (593–649)

In their place, between the type `RunRequestSender` and `runOne`, goes the generic part, in full:

```ts
/** The run facet of the module for `item`'s kind. */
function runOf(registry: ProtocolRegistry, item: SelectedBase): ProtocolRun {
  const run = registry.require(item.kind).run;
  if (run === undefined) {
    throw new Error(`The "${item.kind}" protocol cannot run requests`);
  }
  return run;
}

/**
 * The scripts of one send, opened when the module first runs one. The secrets a request lists for
 * its scripts are read then and not before, so they are asked for after everything preparing the
 * request asks for, as they always were.
 */
function deferredSession(scripting: RequestScripting, scripted: ScriptedRequest, context: RunContext): ScriptSession {
  let opening: Promise<ScriptSession> | undefined;
  const open = (): Promise<ScriptSession> => {
    opening ??= listedSecrets(scripted.scripts.secrets, context.getSecret).then((secrets) =>
      // The run records a value as it merges it (`mergeScriptValues`); nothing about the send is
      // shown before that.
      scriptSession(scripting, scripted, {
        vars: context.sequence ?? {},
        props: scriptProperties(scopesFor(context)),
        secrets,
      }),
    );
    return opening;
  };
  return {
    pre: async (before) => (await open()).pre(before),
    post: async (sent, response) => (await open()).post(sent, response),
  };
}

/**
 * A sender for one run: whatever a protocol loads for a container (a definition, a schema, an
 * OpenAPI document) is loaded once, and one OAuth2 token source serves every request behind the same
 * configuration. `runRequests` sends through it, and so does a sequence run, so a step is sent
 * exactly as a selected request is. Which protocol sends a request is the registry's answer
 * (`context.registry`, the built-in protocols by default).
 *
 * A request with scripts (#63) is type-checked first; its module then prepares it with its secrets
 * behind placeholders, runs the pre-request script on that, puts the secrets back, sends, and runs
 * the post-response script on the response.
 */
export function createRunSender(context: RunContext): RunRequestSender {
  const registry = context.registry ?? defaultRegistry();
  // One token source for the whole run: requests behind the same OAuth2 configuration share a token.
  const scope = createRunScope({
    ...context,
    tokenSource:
      context.tokenSource ??
      createRunTokenSource({
        getSecret: context.getSecret,
        ...(context.fetchToken !== undefined ? { send: context.fetchToken } : {}),
        ...(context.onSecretValue !== undefined ? { onSecretValue: context.onSecretValue } : {}),
      }),
  });

  return async (item, overrides = {}) => {
    const itemContext: RunContext = {
      ...scope.context,
      ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
      ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    };
    const itemScope = scopeWith(scope, itemContext);
    const run = runOf(registry, item);

    const scripts = activeScripts(item.request.scripts);
    if (scripts === undefined) {
      const sent = await run.send(item, itemScope);
      return item.request.scripts !== undefined ? { ...sent, scriptsOff: true } : sent;
    }

    const scripting = context.scripting;
    if (scripting === undefined) {
      throw new WirebenchError('script-unavailable', `"${item.path}" has scripts, and this run cannot run them`, {
        details: { path: item.path },
      });
    }
    const scripted: ScriptedRequest = {
      protocol: item.kind,
      path: item.path,
      name: item.request.name,
      slug: item.request.slug,
      scripts,
      types: await run.scriptTypes(item, itemScope),
    };
    await scripting.check(scripted);
    return run.send(item, itemScope, {
      session: deferredSession(scripting, scripted, itemContext),
      placeholders: new SecretPlaceholders(),
    });
  };
}

/**
 * Type-checks the scripts of every selected request before a run sends anything (spec
 * §Type-checking): each request whose scripts are switched on, against its own contract's types.
 * Returns one error per request that fails, in selection order; empty when all pass.
 */
export async function checkRunScripts(
  selected: readonly SelectedRequest[],
  context: RunContext,
): Promise<readonly WirebenchError[]> {
  const scripting = context.scripting;
  const errors: WirebenchError[] = [];
  if (scripting === undefined) return errors;
  const registry = context.registry ?? defaultRegistry();
  const scope = createRunScope(context);
  for (const item of selected) {
    const scripts = activeScripts(item.request.scripts);
    if (scripts === undefined) continue;
    try {
      await scripting.check({
        protocol: item.kind,
        path: item.path,
        name: item.request.name,
        slug: item.request.slug,
        scripts,
        types: await runOf(registry, item).scriptTypes(item, scope),
      });
    } catch (error) {
      errors.push(
        isWirebenchError(error)
          ? error
          : new WirebenchError('script-type-error', error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return errors;
}
```

Everything else in the file stays as it is: the header comment, `RequestOutcome` to `RunOptions`, `assertionsOf`, `EXCHANGE_CAP_BYTES`, `capped`, `identity`, `erroredResult`, `outcomeOf`, `SentRequest`, `RunSendOverrides`, `RunRequestSender`, and `runOne` to the end of the file.

Why the script session is deferred: today `sendScripted` prepares the request, then reads the secrets the request lists for its scripts, then opens the session. The module now prepares inside `send`, after core has built the `ScriptedSend`. `deferredSession` opens the session on the first `pre`, which every module calls after it has prepared, so the listed secrets are still read after everything preparing asks for. `send-order.test.ts` pins this.

`scriptTypesFor` stays exported from `run/script-support.ts` and `run/index.ts`; core no longer calls it. Slice 5 removes it with the other public exports the registry replaces (Task 5.2, Step 3). Until then the function, and the three subject re-exports at the top of `run/run.ts`, are imports core makes of a protocol folder; slice 4's layer check lists both files as temporary exceptions.

- [ ] **Step 6: Replace `packages/engine/src/run/secret-needs.ts`**

The file in full:

```ts
/**
 * Every secret a selection of requests will ask for, found before anything is sent, so a pipeline
 * can be told which variables to set (`wirebench secrets list`) and a run knows which names to
 * read. The generic part is here: every `${secret:name}` the request's own text reaches, and the
 * secrets its scripts list. What a protocol's configuration needs (effective auth, the request's
 * keystore, signing, WS-Security) is its module's answer, walking the same sources its send resolves.
 */
import { resolveScopes } from '../project/environments.js';
import type { Project, PropertyMap } from '../project/model.js';
import type { PropertyScopes } from '../project/properties.js';
import type { SelectedBase } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import type { SelectedRequest } from '../protocols.js';
import { activeScripts } from '../script/request-scripts.js';
import type { SecretNeed } from '../secrets/env-names.js';
import { secretEnvName, secretPseudoRef } from '../secrets/secret-token.js';
import { resolveWorkspaceScopes, withActiveEnvironment } from '../workspace/environments.js';
import type { Workspace } from '../workspace/model.js';
import { secretNamesInValue } from './send-helpers.js';

export { secretNamesInValue } from './send-helpers.js';

/** One secret a run needs, and which requests need it. */
export interface LocatedSecretNeed extends SecretNeed {
  /** Display paths of the requests that need it. */
  readonly usedBy: readonly string[];
}

function tokenNeeds(selected: SelectedBase, scopeSets: readonly PropertyScopes[]): SecretNeed[] {
  // A script's own text is code, not a template: nothing in it is a reference. The secrets its
  // request lists for `secrets.get` are needed instead (#63).
  const { scripts, ...request } = selected.request;
  const names = new Set(scopeSets.flatMap((scopes) => secretNamesInValue(request, scopes)));
  for (const name of activeScripts(scripts)?.secrets ?? []) {
    names.add(name);
  }
  return [...names].map((name) => ({
    ref: secretPseudoRef(name),
    envName: secretEnvName(name),
    purpose: `secret "${name}"`,
  }));
}

/** The generic needs of `selected`, then what its protocol's configuration needs. */
function needsOf(
  selected: SelectedBase,
  project: Project,
  scopeSets: readonly PropertyScopes[],
  registry: ProtocolRegistry,
): SecretNeed[] {
  const run = registry.find(selected.kind)?.run;
  return [...tokenNeeds(selected, scopeSets), ...(run !== undefined ? run.secretNeeds(selected, project) : [])];
}

/** A workspace's scopes with no environment active, then under each of its environments in turn. */
function workspaceScopeSets(workspace: Workspace, project: Project): PropertyScopes[] {
  return [undefined, ...workspace.environments.map((environment) => environment.id)].map((environmentId) =>
    resolveWorkspaceScopes({ workspace: withActiveEnvironment(workspace, environmentId), project, globals: {} }),
  );
}

/**
 * The secrets `selected` needs, one entry per ref in first-use order, each with every request
 * that uses it. The first declaration of a ref supplies its name and purpose. `overrides` are the
 * run's `--var` properties, laid over the environment's as a send lays them. With a `workspace`
 * the scopes are the ones a send inside it expands against: the workspace's properties, and each
 * workspace environment with its linked project environment. `registry` is the set of protocol
 * modules asked for their needs; the built-in ones by default.
 */
export function secretNeedsOf(
  selected: readonly SelectedRequest[],
  project: Project,
  overrides: PropertyMap = {},
  workspace?: Workspace,
  registry: ProtocolRegistry = defaultRegistry(),
): LocatedSecretNeed[] {
  const byRef = new Map<string, { need: SecretNeed; usedBy: string[] }>();
  // A token a property holds counts whichever environment a run picks: project properties alone,
  // then each environment laid over them. No process environment, so this stays pure.
  const withOverrides = (scopes: PropertyScopes): PropertyScopes => ({
    ...scopes,
    env: { ...(scopes.env ?? {}), ...overrides },
  });
  const scopeSets = (
    workspace === undefined
      ? [
          resolveScopes(project, undefined, {}, {}),
          ...project.environments.map((environment) => resolveScopes(project, environment.id, {}, {})),
        ]
      : workspaceScopeSets(workspace, project)
  ).map(withOverrides);
  for (const item of selected) {
    for (const need of needsOf(item, project, scopeSets, registry)) {
      const known = byRef.get(need.ref);
      if (known === undefined) {
        byRef.set(need.ref, { need, usedBy: [item.path] });
      } else {
        if (!known.usedBy.includes(item.path)) {
          known.usedBy.push(item.path);
        }
        if (known.need.envName === undefined && need.envName !== undefined) {
          known.need = { ...known.need, envName: need.envName };
        }
      }
    }
  }
  return [...byRef.values()].map(({ need, usedBy }) => ({ ...need, usedBy }));
}
```

A protocol that is switched off contributes no configuration needs for a request already in hand; the request's `${secret:…}` tokens and listed script secrets are still found, because those are core's.

- [ ] **Step 7: Three small edits**

`packages/engine/src/run/prepare.ts`: the import of `SelectedRequest` comes from the composition file:

```ts
import type { SelectedRequest } from '../protocols.js';
```

replaces `import type { SelectedRequest } from './select.js';`.

`packages/engine/src/sequence/run.ts`: `runSequence` has no `RunContext` (its caller builds the sender), so the registry a step is looked up in is an option of its own. Add the import after the other `../` type imports:

```ts
import type { ProtocolRegistry } from '../protocol/registry.js';
```

Add as the last field of `RunSequenceOptions`, after `onCallbackWaiting`:

```ts
  /**
   * The protocol modules a step's request is looked up in. Absent: the built-in ones. A host that
   * sends with `createRunSender` passes the registry of its `RunContext` here too.
   */
  readonly registry?: ProtocolRegistry;
```

And the one call of `findStepRequest` becomes:

```ts
    const target = findStepRequest(project, step.requestId, options.registry);
```

`packages/engine/src/soap/run.ts`: remove `export` from `interface LoadedDefinition`, `async function loadDefinition` and `function soapSubject`. `packages/engine/src/grpc/run.ts`: remove `export` from `async function loadProtoSetFor` and `const GRPC_UNAUTHENTICATED`. Nothing outside their files uses them any more. Prettier then puts `loadDefinition`'s signature back on one line.

- [ ] **Step 8: Run the tests**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run/registry-dispatch.test.ts`
Expected: PASS, 11 tests.

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run packages/engine/test/unit/sequence packages/engine/test/unit/soap/run-module.test.ts packages/engine/test/unit/rest/run-module.test.ts packages/engine/test/unit/grpc/run-module.test.ts packages/engine/test/unit/ws/module.test.ts`
Expected: PASS, 18 files, 175 tests (`test/unit/run`: 9 files, 107 tests). `send-order.test.ts`, `select.test.ts`, `secret-needs.test.ts` and `prepare.test.ts` pass without an edit.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run`
Expected: PASS, 6 files, 34 tests.

- [ ] **Step 9: Format, check, commit**

```bash
pnpm exec prettier --write packages/engine/src/protocols.ts packages/engine/src/run packages/engine/src/sequence/run.ts packages/engine/src/soap/run.ts packages/engine/src/grpc/run.ts packages/engine/test/unit/run/registry-dispatch.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/protocols.ts packages/engine/src/run packages/engine/src/sequence/run.ts packages/engine/src/soap/run.ts packages/engine/src/grpc/run.ts packages/engine/test/unit/run/registry-dispatch.test.ts
git commit -m "refactor(engine): select, run and secret needs dispatch through the protocol registry (#184)"
```

Expected: `pnpm check` green. It also type-checks `packages/cli` and `apps/desktop` against the engine; neither needs an edit, since every changed signature only gained an optional last parameter or an optional field.

---

### Task 1.8: The `echo` test protocol, run half

A fifth protocol that exists only in tests, registered beside the built-in four. If it can be selected, sent, asserted on, found as a sequence step and asked for its secret needs without a core file being edited, the run path knows no protocol. Later slices add its scripting and storage halves to the same helper.

**Files:**
- Create: `packages/engine/test/helpers/echo-protocol.ts`
- Test: `packages/engine/test/integration/echo-protocol.test.ts` (new)

**Interfaces:**
- Consumes: `defineProtocol`, `ProtocolRun`; `extraContainersOf`; `scopesFor`; `withSecrets`, `unresolvedError` (`run/send-helpers.ts`); `expand` (`project/properties.ts`); `createProtocolRegistry`, `BUILTIN_PROTOCOLS`, `SCRIPTS_FEATURE`.
- Produces (`test/helpers/echo-protocol.ts`):
  - `interface EchoRequest { id; name; slug; text; assertions?; scripts? }`
  - `interface EchoApi { kind: 'echo'; id; name; slug; order; requests: readonly EchoRequest[] }`
  - `interface EchoSelected { kind: 'echo'; path; group; api: EchoApi; request: EchoRequest }`
  - `echoApisOf(project): readonly EchoApi[]`, `withEchoApis(project, apis): Project` (the containers live in `project.extraContainers.echo`)
  - `echoRun: ProtocolRun<EchoSelected>`, `echoProtocol`
  - `echoApi(name, order, requests): EchoApi`, `echoRequest(name, text, extra?): EchoRequest`

- [ ] **Step 1: Write the failing test**

`packages/engine/test/integration/echo-protocol.test.ts`, the file in full:

```ts
/**
 * A fifth protocol registered beside the built-in ones goes through select, run and secret needs
 * without any core file knowing it (protocol modules spec §10). The run half: storage and scripts
 * join in later slices.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { createProtocolRegistry } from '../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../src/protocols.js';
import { createApi, createRestRequest } from '../../src/rest/model.js';
import type { RunContext } from '../../src/run/context.js';
import { runRequests } from '../../src/run/run.js';
import { secretNeedsOf } from '../../src/run/secret-needs.js';
import { findStepRequest, selectRequests } from '../../src/run/select.js';
import { echoApi, echoProtocol, echoRequest, withEchoApis } from '../helpers/echo-protocol.js';
import { startTestRestServer } from '../helpers/test-rest-server.js';
import type { TestRestServer } from '../helpers/test-rest-server.js';

const registry = createProtocolRegistry([...BUILTIN_PROTOCOLS, echoProtocol], { features: [SCRIPTS_FEATURE] });

let rest: TestRestServer;
let dir: string;

beforeAll(async () => {
  rest = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-echo-'));
});

afterAll(async () => {
  await rest.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(): Project {
  const base: Project = {
    ...createProject('Echo', { id: 'proj-echo' }),
    properties: { greeting: 'hello' },
    apis: [
      createApi('Api', {
        id: 'api-1',
        slug: 'api',
        order: 1,
        requests: [
          {
            ...createRestRequest('Ping', { id: 'req-ping', url: `${rest.url}/echo` }),
            assertions: [{ type: 'status', equals: 200 }],
          },
        ],
      }),
    ],
  };
  return withEchoApis(base, [
    echoApi('Mirror', 0, [
      echoRequest('Greeting', '{"greeting":"${#Project#greeting}"}', {
        assertions: [{ type: 'match', language: 'jsonpath', expression: '$.greeting', equals: 'hello' }],
      }),
      echoRequest('Token', 'token=${secret:echo_token}', { assertions: [{ type: 'status', equals: 200 }] }),
    ]),
  ]);
}

function contextFor(p: Project, secrets: Readonly<Record<string, string>> = {}): RunContext {
  return { project: p, projectDir: dir, overrides: {}, getSecret: (ref) => Promise.resolve(secrets[ref]), registry };
}

describe('the echo protocol beside the built-in ones', () => {
  it('is selected in explorer order with the REST requests, by display path and by disk path', () => {
    const p = project();
    expect(selectRequests(p, [], registry).selected.map((item) => [item.kind, item.path])).toEqual([
      ['echo', 'Mirror/Greeting'],
      ['echo', 'Mirror/Token'],
      ['rest', 'Api/Ping'],
    ]);
    expect(selectRequests(p, ['Mirror/Token'], registry).selected.map((item) => item.path)).toEqual(['Mirror/Token']);
    expect(
      selectRequests(p, ['apis/mirror/requests/greeting.request.yaml'], registry).selected.map((item) => item.path),
    ).toEqual(['Mirror/Greeting']);
  });

  it('is not there for a registry that does not hold it', () => {
    const p = project();
    expect(selectRequests(p, []).selected.map((item) => item.path)).toEqual(['Api/Ping']);
    expect(selectRequests(p, ['Mirror']).unmatched).toEqual(['Mirror']);
    expect(findStepRequest(p, 'echo-req-greeting')).toEqual({ kind: 'missing' });
  });

  it('runs beside a REST request, with a match assertion on what it echoed', async () => {
    const p = project();
    const { selected } = selectRequests(p, ['Mirror/Greeting', 'Api/Ping'], registry);
    const result = await runRequests(selected, contextFor(p));
    expect(result.requests.map((r) => [r.path, r.protocol, r.outcome, r.status])).toEqual([
      ['Mirror/Greeting', 'echo', 'passed', 200],
      ['Api/Ping', 'rest', 'passed', 200],
    ]);
    expect(result.requests[0]?.assertions).toMatchObject([{ type: 'match', outcome: 'passed' }]);
    expect(result.summary).toMatchObject({ total: 2, passed: 2 });
  });

  it('expands a secret token through the run’s secrets, and refuses the send without it', async () => {
    const p = project();
    const { selected } = selectRequests(p, ['Mirror/Token'], registry);
    const given = await runRequests(selected, contextFor(p, { 'secret:echo_token': 'abc123def456ghi789' }));
    expect(given.requests[0]).toMatchObject({ protocol: 'echo', outcome: 'passed' });
    const missing = await runRequests(selected, contextFor(p));
    expect(missing.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'secret-missing' } });
  });

  it('errors a request whose protocol the run’s registry does not hold', async () => {
    const p = project();
    const { selected } = selectRequests(p, ['Mirror/Greeting'], registry);
    const result = await runRequests(selected, {
      project: p,
      projectDir: dir,
      overrides: {},
      getSecret: () => Promise.resolve(undefined),
    });
    expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'project-kind-not-supported' } });
  });

  it('has the secret token in its text found by secretNeedsOf', () => {
    const p = project();
    const { selected } = selectRequests(p, [], registry);
    expect(secretNeedsOf(selected, p, {}, undefined, registry)).toEqual([
      { ref: 'secret:echo_token', envName: 'ECHO_TOKEN', purpose: 'secret "echo_token"', usedBy: ['Mirror/Token'] },
    ]);
  });

  it('is found as a sequence step by its request id', () => {
    const found = findStepRequest(project(), 'echo-req-greeting', registry);
    expect(found.kind === 'found' ? [found.selected.kind, found.selected.path] : found.kind).toEqual([
      'echo',
      'Mirror/Greeting',
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/echo-protocol.test.ts`
Expected: FAIL: `test/helpers/echo-protocol.js` cannot be resolved.

- [ ] **Step 3: Create `packages/engine/test/helpers/echo-protocol.ts`**

The file in full:

```ts
/**
 * A fifth protocol, for tests only: `echo` answers a request with the request's own text. It is
 * registered beside the built-in protocols to prove that no core file has to know a protocol
 * (protocol modules spec §10). Its containers live in `project.extraContainers.echo`.
 *
 * This file holds the run half. `send` reaches no network.
 */
import type { Assertion, AssertionSubject } from '../../src/assert/model.js';
import { extraContainersOf } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { expand } from '../../src/project/properties.js';
import { defineProtocol } from '../../src/protocol/module.js';
import type { ProtocolRun } from '../../src/protocol/module.js';
import { scopesFor } from '../../src/run/context.js';
import { unresolvedError, withSecrets } from '../../src/run/send-helpers.js';
import type { RequestScripts } from '../../src/script/model.js';

/** A saved echo request: the text it sends is the text it gets back. */
export interface EchoRequest {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** May hold `${…}` property references and `${secret:name}` tokens. */
  readonly text: string;
  readonly assertions?: readonly Assertion[];
  readonly scripts?: RequestScripts;
}

/** An echo API: a flat list of requests. */
export interface EchoApi {
  readonly kind: 'echo';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly requests: readonly EchoRequest[];
}

/** One echo request selected for a run. */
export interface EchoSelected {
  readonly kind: 'echo';
  readonly path: string;
  readonly group: string;
  readonly api: EchoApi;
  readonly request: EchoRequest;
}

/** The project's echo APIs. */
export function echoApisOf(project: Project): readonly EchoApi[] {
  return extraContainersOf(project, 'echo') as readonly EchoApi[];
}

/** `project` with `apis` as its echo APIs. */
export function withEchoApis(project: Project, apis: readonly EchoApi[]): Project {
  return { ...project, extraContainers: { ...project.extraContainers, echo: apis } };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The echo as assertions see it: always `200`; JSON when the text is JSON, so a `match` can read it. */
function echoSubject(text: string): AssertionSubject {
  return {
    // `AssertionSubject.protocol` is a closed union until Task 2.3 of the protocol modules plan widens it.
    protocol: 'echo' as AssertionSubject['protocol'],
    status: 200,
    durationMs: 0,
    bodyText: text,
    bodyKind: isJson(text) ? 'json' : 'other',
  };
}

/** Echo's run facet. */
export const echoRun: ProtocolRun<EchoSelected> = {
  groups(project) {
    return echoApisOf(project).map((api) => ({
      order: api.order,
      name: api.name,
      candidates: api.requests.map((request) => ({
        item: { kind: 'echo' as const, path: `${api.name}/${request.name}`, group: api.name, api, request },
        diskPath: `apis/${api.slug}/requests/${request.slug}`,
      })),
    }));
  },

  whyNotRunnable() {
    return undefined;
  },

  async send(selected, scope) {
    const { context } = scope;
    const { text } = selected.request;
    const scopes = await withSecrets(text, scopesFor(context), context.getSecret);
    const expanded = expand(text, scopes);
    if (expanded.unresolved.length > 0) {
      throw unresolvedError(selected.path, expanded.unresolved);
    }
    const raw = bytes(expanded.text);
    return { subject: echoSubject(expanded.text), raw: { rawRequest: raw, rawResponse: raw } };
  },

  scriptTypes() {
    return Promise.resolve({ generated: '' });
  },

  secretNeeds() {
    return [];
  },
};

/** The echo protocol, to register beside the built-in ones. */
export const echoProtocol = defineProtocol({
  kind: 'echo',
  feature: { id: 'echo', title: 'Echo', default: true, stage: 'experimental', requires: [] },
  run: echoRun,
});

/** An echo API for a test project. */
export function echoApi(name: string, order: number, requests: readonly EchoRequest[]): EchoApi {
  return { kind: 'echo', id: `echo-${name.toLowerCase()}`, name, slug: name.toLowerCase(), order, requests };
}

/** An echo request for a test project. */
export function echoRequest(name: string, text: string, extra: Partial<EchoRequest> = {}): EchoRequest {
  return { id: `echo-req-${name.toLowerCase()}`, name, slug: name.toLowerCase(), text, ...extra };
}
```

Three things in it are shaped by the engine as it is after this slice, and later slices revisit them:

- `protocol: 'echo' as AssertionSubject['protocol']`: `AssertionSubject.protocol` is the closed union `'soap' | 'rest' | 'grpc'` (`assert/model.ts` line 141). `RequestResult.protocol` is closed the same way, so a result for an echo request says `'echo'` at run time under a type that does not list it. Task 2.3 widens the first and removes this cast; Task 5.2 widens the second.
- `bodyKind` is `'json'` when the text parses as JSON: a `match` assertion refuses a subject whose `bodyKind` is `'other'` (`assert/match.ts` lines 33–37), and the test wants one `match` to pass.
- `send` resolves `${secret:…}` with the same `withSecrets` the built-in modules use, so `secretNeedsOf`'s generic half and the send agree on which secrets the text needs.

- [ ] **Step 4: Run the test**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/echo-protocol.test.ts`
Expected: PASS, 7 tests.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run`
Expected: PASS, 6 files, 34 tests.

- [ ] **Step 5: Format, check, commit**

```bash
pnpm exec prettier --write packages/engine/test/helpers/echo-protocol.ts packages/engine/test/integration/echo-protocol.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/test/helpers/echo-protocol.ts packages/engine/test/integration/echo-protocol.test.ts
git commit -m "test(engine): an echo protocol runs beside the built-in ones (#184)"
```

Expected: `pnpm check` green. Before the slice is pushed: `nice pnpm test:perf`, unskipped.

---

## Slice 2 — The scripting facet

Spec §3.4, §3.5, §5.5, §12 item 2. Five tasks: 2.1, 2.2a, 2.2b, 2.3, 2.4. Task 2.2 of the outline is split in two because its first half (three `git mv`s and the split of `script/contracts.ts`) changes no behaviour and no signature, and landing it alone keeps the second half's diff readable.

**What this slice is read against.** Line numbers are those of the tree at `f9c0411b` (main plus the spec). Slice 1 rewrote `run/run.ts` and created `soap/run.ts`, `rest/run.ts`, `grpc/run.ts`, the four `module.ts` files, `protocols.ts` and `test/helpers/echo-protocol.ts`. For those files a step quotes the statement as slice 1 wrote it and names the task that wrote it, never a line number.

**Facts the tasks below rely on, each verified against the code:**

- **The origin rule cannot use `urlOrigin` as it stands.** `urlOrigin('grpc.test:443')` (`project/sequence-guards.ts:75`) parses `grpc.test` as a scheme and returns `grpc.test://`, the same as for `grpc.test:8443`. Today that does not matter, because `script/apply.ts:158` compares a gRPC target for equality. A generic rule that compared `urlOrigin(destination)` would let a script change a gRPC port. So core's rule treats a destination as a URL only when it has a host, and everything else must stay identical (Task 2.2b, `originOf`). gRPC also keeps its own identity check in `validate`, for a target written as a URL (`grpcs://host:443`, which `grpc/target.ts:26` accepts).
- **Precedence.** Today's order of refusals is REST: method, URL line break, origin, header, uneditable body, secret. SOAP: endpoint or SOAPAction line break, origin, header, secret. gRPC: target, method, metadata, secret. The generic order is: shape, `lines`, destination, `fixed`, `pairs`, secrets, then the module's `validate`. That is today's order for SOAP and gRPC exactly. For REST two pairs swap, and only when a forged result breaks both rules at once: an uneditable body is now reported before a header line break, and a bad method after everything else. The code of a single broken rule never changes.
- **Two things are refused that today are let through**, both reachable only by a script that forges `__finish`: a REST body handed back as `kind: 'other'` when it was `text` or `none` (today `applyRestSnapshot` silently keeps the original body), and any change to a REST URL or SOAP endpoint that has no host (`file:///x`, `localhost:8080/x`; neither can be sent).
- **No existing test pins the text of a refusal from `script/apply.ts`**, except by the secret name it lists. Task 2.1 has the inventory.
- **`node scripts/docs-script-api.ts` loads `script/types/api.ts` from source**, which works today only because that file has no value imports. Once `apiReference` reads the registry it cannot. The generator moves to the build output, as `scripts/wsi-docs.ts` already does (`pnpm typecheck` emits it before `pnpm docs:script-api --check` in `pnpm check`).

**Existing tests this slice edits, beyond an import path** (each is named again in its task):

| Test | Edit | Why |
| --- | --- | --- |
| `packages/engine/test/unit/script/apply.test.ts` | its two imports become two local adapters with the same names (and the `facetOf` lookup they share); no line below them changes | `applyRequestChanges` and `secretReferencesIn` take what the facet describes |
| `packages/engine/test/unit/script/types-xsd.test.ts` lines 184, 207, 230 | `soap:` becomes `binding:` | `ScriptRunInput.soap` is renamed (spec §8, the one export this slice breaks) |
| `packages/engine/test/unit/assert/status.test.ts` lines 5–12 | the gRPC subject literal gains `statusNames` | a subject's names, not its protocol, select the rules (spec §3.5) |
| `packages/engine/test/unit/run/grpc-subject.test.ts` lines 32–43 | the expected subject gains `statusNames` | `grpcSubject` supplies it |

---

### Task 2.1: Pin the script rules per protocol

**Files:**
- Test: `packages/engine/test/unit/script/rules-per-protocol.test.ts` (new)

**Interfaces:**
- Consumes (today's, unchanged by slice 1): `applyRequestChanges(before: RequestSnapshot, returned: unknown): ApplyResult` from `script/apply.ts`; `RestRequestSnapshot`, `SoapRequestSnapshot`, `GrpcRequestSnapshot`, `RequestSnapshot`, `ScriptFailure` from `script/model.ts`.
- Produces: 27 tests that pass against today's rules and must pass, with no assertion changed, against the generic ones. Only the file's imports and its `apply` helper change, in Task 2.2b.

- [ ] **Step 1: Write the test**

```ts
// packages/engine/test/unit/script/rules-per-protocol.test.ts
/**
 * The rules a pre-request script's changes are held to (ADR-0016), one test per rule and protocol.
 *
 * Every call goes through `apply` below, so the tests read the same whether the rules branch on the
 * protocol or ask the protocol's module what its snapshot holds. A module that describes its
 * snapshot wrongly — a header list left out, a target that is not the destination — fails one of
 * these.
 */
import { describe, expect, it } from 'vitest';
import { applyRequestChanges } from '../../../src/script/apply.js';
import type {
  GrpcRequestSnapshot,
  RequestSnapshot,
  RestRequestSnapshot,
  ScriptFailure,
  SoapRequestSnapshot,
} from '../../../src/script/model.js';

type Snapshot = RequestSnapshot;

/** The one place this file calls the rules. */
const apply = (before: Snapshot, returned: unknown) => applyRequestChanges(before, returned);

const REST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'POST',
  url: 'https://api.test:8443/carts?page=1',
  headers: [['Authorization', 'Bearer ${secret:token}']],
  body: { kind: 'text', text: '{"items":[]}', language: 'json' },
};
const REST_FORM: RestRequestSnapshot = { ...REST, body: { kind: 'other', description: 'a multipart body' } };
const SOAP: SoapRequestSnapshot = {
  protocol: 'soap',
  endpoint: 'https://soap.test/stock',
  soapAction: 'urn:GetQuote',
  headers: [['X-Trace', '1']],
  envelope: '<e>${secret:token}</e>',
};
const GRPC: GrpcRequestSnapshot = {
  protocol: 'grpc',
  target: 'grpc.test:443',
  method: 'shop.Carts/Get',
  metadata: [['x-trace', '1']],
  message: { id: '${secret:token}' },
};

/** What `returned` is refused with, or undefined when it is accepted. */
const refusal = (before: Snapshot, returned: unknown): ScriptFailure | undefined => {
  const result = apply(before, returned);
  return result.ok ? undefined : result.error;
};
const code = (before: Snapshot, returned: unknown): string | undefined => refusal(before, returned)?.code;

const UNREADABLE = 'The script handed back a request the engine cannot read';

describe('REST', () => {
  it('accepts what a script may change: the path, the query, a header, a text body, the method', () => {
    const changed = {
      ...REST,
      method: 'PUT',
      url: 'https://api.test:8443/orders?page=2#top',
      headers: [...REST.headers, ['X-Signed', 'yes']],
      body: { kind: 'text', text: '{"items":["a"]}', language: 'json' },
    };
    expect(apply(REST, changed)).toEqual({ ok: true, request: changed });
    expect(apply(REST_FORM, { ...REST_FORM, headers: [] })).toMatchObject({ ok: true });
  });

  it('rule 1: refuses a shape it cannot read, and another protocol', () => {
    const unreadable = [
      undefined,
      null,
      'rest',
      { protocol: 'rest' },
      { ...REST, headers: [['only-a-name']] },
      SOAP,
      GRPC,
    ];
    for (const returned of unreadable) {
      expect(refusal(REST, returned)).toEqual({ code: 'script-error', message: UNREADABLE });
    }
  });

  it('rule 2: refuses another scheme, host or port', () => {
    for (const url of ['http://api.test:8443/carts', 'https://evil.test:8443/carts', 'https://api.test/carts']) {
      expect(code(REST, { ...REST, url })).toBe('script-origin-change');
    }
  });

  it('rule 2: a destination that is not a URL stays exactly as it was', () => {
    const relative = { ...REST, url: '/carts' };
    expect(code(relative, { ...relative, url: '/orders' })).toBe('script-origin-change');
    expect(apply(relative, relative)).toMatchObject({ ok: true });
  });

  it('rule 3: refuses any change to a body a script cannot edit', () => {
    for (const body of [
      { kind: 'none' },
      { kind: 'text', text: 'x', language: 'text' },
      { kind: 'other', description: 'a binary body' },
    ]) {
      expect(code(REST_FORM, { ...REST_FORM, body })).toBe('script-error');
    }
  });

  it('rule 4: refuses CR, LF or NUL in a header name or value', () => {
    for (const header of [
      ['X-A\r', 'v'],
      ['X-A', 'v\nInjected: 1'],
      ['X-A', 'v\0'],
    ]) {
      expect(code(REST, { ...REST, headers: [...REST.headers, header] })).toBe('script-value-invalid');
    }
  });

  it('rule 4: refuses CR, LF or NUL in the URL', () => {
    for (const url of ['https://api.test:8443/carts\r\nHost: evil.test', 'https://api.test:8443/carts\0']) {
      expect(code(REST, { ...REST, url })).toBe('script-value-invalid');
    }
  });

  it('rule 5: refuses a secret reference the request did not hold, wherever it is put', () => {
    for (const changed of [
      { ...REST, url: 'https://api.test:8443/carts?key=${secret:other}' },
      { ...REST, headers: [...REST.headers, ['X-Key', '${secret:other}']] },
      { ...REST, headers: [...REST.headers, ['${secret:other}', 'v']] },
      { ...REST, body: { kind: 'text', text: '${secret:other}', language: 'text' } },
    ]) {
      expect(refusal(REST, changed)).toMatchObject({
        code: 'script-secret-denied',
        message: expect.stringContaining('other') as unknown,
      });
    }
  });

  it('rule 5: lets a script move a reference the request already held', () => {
    const moved = {
      ...REST,
      headers: [['X-Token', '${secret:token}']],
      body: { kind: 'text', text: '${secret:token}', language: 'text' },
    };
    expect(apply(REST, moved)).toMatchObject({ ok: true });
  });

  it('its own rule: refuses a method that is not an HTTP token', () => {
    for (const method of ['GET /x HTTP/1.1', 'get', '', 'A'.repeat(33)]) {
      expect(refusal(REST, { ...REST, method })).toEqual({
        code: 'script-value-invalid',
        message: `"${method}" is not an HTTP method`,
      });
    }
  });
});

describe('SOAP', () => {
  it('accepts what a script may change: the path, the SOAPAction, a header, the envelope', () => {
    const changed = {
      ...SOAP,
      endpoint: 'https://soap.test/stock/v2',
      soapAction: 'urn:GetQuotes',
      headers: [['X-Trace', '2']],
      envelope: '<e><q>${secret:token}</q></e>',
    };
    expect(apply(SOAP, changed)).toEqual({ ok: true, request: changed });
  });

  it('rule 1: refuses a shape it cannot read, and another protocol', () => {
    for (const returned of [undefined, { protocol: 'soap' }, { ...SOAP, envelope: 7 }, REST, GRPC]) {
      expect(refusal(SOAP, returned)).toEqual({ code: 'script-error', message: UNREADABLE });
    }
  });

  it('rule 2: refuses another scheme, host or port', () => {
    for (const endpoint of ['http://soap.test/stock', 'https://evil.test/stock', 'https://soap.test:8443/stock']) {
      expect(code(SOAP, { ...SOAP, endpoint })).toBe('script-origin-change');
    }
  });

  // Rule 3 has nothing to hold for SOAP: every part of the snapshot is one a script may change.

  it('rule 4: refuses CR, LF or NUL in a header name or value', () => {
    for (const header of [
      ['X-A\n', 'v'],
      ['X-A', 'v\r\nInjected: 1'],
      ['X-A', 'v\0'],
    ]) {
      expect(code(SOAP, { ...SOAP, headers: [header] })).toBe('script-value-invalid');
    }
  });

  it('rule 4: refuses CR, LF or NUL in the endpoint and in the SOAPAction', () => {
    expect(code(SOAP, { ...SOAP, endpoint: 'https://soap.test/stock\r\nHost: evil.test' })).toBe(
      'script-value-invalid',
    );
    for (const soapAction of ['urn:a\rb', 'urn:a\nb', 'urn:a\0b']) {
      expect(code(SOAP, { ...SOAP, soapAction })).toBe('script-value-invalid');
    }
  });

  it('rule 5: refuses a secret reference the request did not hold, wherever it is put', () => {
    for (const changed of [
      { ...SOAP, endpoint: 'https://soap.test/${secret:other}' },
      { ...SOAP, soapAction: '${secret:other}' },
      { ...SOAP, headers: [['X-Key', '${secret:other}']] },
      { ...SOAP, envelope: '<e>${secret:token}${secret:other}</e>' },
    ]) {
      expect(refusal(SOAP, changed)).toMatchObject({
        code: 'script-secret-denied',
        message: expect.stringContaining('other') as unknown,
      });
    }
  });

  it('rule 5: lets a script move a reference the request already held', () => {
    expect(apply(SOAP, { ...SOAP, headers: [['X-Token', '${secret:token}']] })).toMatchObject({ ok: true });
  });
});

describe('gRPC', () => {
  it('accepts what a script may change: the metadata and the message', () => {
    const changed = { ...GRPC, metadata: [['x-trace', '2']], message: { id: '${secret:token}', page: 2 } };
    expect(apply(GRPC, changed)).toEqual({ ok: true, request: changed });
  });

  it('rule 1: refuses a shape it cannot read, and another protocol', () => {
    for (const returned of [undefined, { protocol: 'grpc' }, { ...GRPC, metadata: 'x-trace: 1' }, REST, SOAP]) {
      expect(refusal(GRPC, returned)).toEqual({ code: 'script-error', message: UNREADABLE });
    }
  });

  it('rule 2: refuses any other target, a port or a path included', () => {
    for (const target of ['evil.test:443', 'grpc.test:8443', 'grpc.test', 'grpc.test:443/x', 'grpcs://grpc.test:443']) {
      expect(code(GRPC, { ...GRPC, target })).toBe('script-origin-change');
    }
    const url = { ...GRPC, target: 'grpcs://grpc.test:443' };
    for (const target of ['grpcs://grpc.test:8443', 'grpc://grpc.test:443', 'grpcs://grpc.test:443/x']) {
      expect(code(url, { ...url, target })).toBe('script-origin-change');
    }
  });

  it('rule 3: refuses another method', () => {
    expect(code(GRPC, { ...GRPC, method: 'shop.Carts/Delete' })).toBe('script-error');
  });

  it('rule 4: refuses CR, LF or NUL in a metadata name or value', () => {
    for (const entry of [
      ['x-a\r', 'v'],
      ['x-a', 'v\n'],
      ['x-a', 'v\0'],
    ]) {
      expect(code(GRPC, { ...GRPC, metadata: [entry] })).toBe('script-value-invalid');
    }
  });

  it('rule 5: refuses a secret reference the request did not hold, wherever it is put', () => {
    for (const changed of [
      { ...GRPC, metadata: [['x-key', '${secret:other}']] },
      { ...GRPC, message: { id: '${secret:token}', key: '${secret:other}' } },
    ]) {
      expect(refusal(GRPC, changed)).toMatchObject({
        code: 'script-secret-denied',
        message: expect.stringContaining('other') as unknown,
      });
    }
  });

  it('rule 5: lets a script move a reference the request already held', () => {
    expect(apply(GRPC, { ...GRPC, metadata: [['x-token', '${secret:token}']] })).toMatchObject({ ok: true });
  });
});

describe('which refusal is reported when two rules are broken at once', () => {
  it('REST: a line break in the URL before the origin, the origin before a header, a header before a secret', () => {
    expect(code(REST, { ...REST, url: 'https://evil.test/carts\r\n' })).toBe('script-value-invalid');
    expect(code(REST, { ...REST, url: 'https://evil.test/carts', headers: [['X-A', 'v\n']] })).toBe(
      'script-origin-change',
    );
    expect(code(REST, { ...REST, headers: [['X-A\n', '${secret:other}']] })).toBe('script-value-invalid');
  });

  it('SOAP: a line break in the endpoint before the origin, the origin before a header, a header before a secret', () => {
    expect(code(SOAP, { ...SOAP, endpoint: 'https://evil.test/stock\n' })).toBe('script-value-invalid');
    expect(code(SOAP, { ...SOAP, endpoint: 'https://evil.test/stock', headers: [['X-A', 'v\n']] })).toBe(
      'script-origin-change',
    );
    expect(code(SOAP, { ...SOAP, headers: [['X-A\n', '${secret:other}']] })).toBe('script-value-invalid');
  });

  it('gRPC: the target before the method, the method before the metadata, the metadata before a secret', () => {
    expect(code(GRPC, { ...GRPC, target: 'evil.test:443', method: 'shop.Carts/Delete' })).toBe('script-origin-change');
    expect(code(GRPC, { ...GRPC, method: 'shop.Carts/Delete', metadata: [['x-a', 'v\0']] })).toBe('script-error');
    expect(code(GRPC, { ...GRPC, metadata: [['x-a\n', '${secret:other}']] })).toBe('script-value-invalid');
  });
});
```

Two REST combinations are deliberately absent from the last `describe`, because the generic order reports the other refusal (see the slice's facts): a header line break together with a changed uneditable body, and a bad method together with anything else.

- [ ] **Step 2: Run it against today's rules**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/script/rules-per-protocol.test.ts`
Expected: PASS, 27 tests. A failure here means the test is wrong, not the code: fix the test, never `script/apply.ts`.

- [ ] **Step 3: Read the inventory of pinned messages**

Nothing to change in this step. This is the list Task 2.2b is checked against: every place an existing test pins the text of a script refusal, and whether the text survives.

| Test | Pins | Raised by | After 2.2b |
| --- | --- | --- | --- |
| `test/unit/script/apply.test.ts:88–90` | `script-secret-denied`, message contains `four` | `script/apply.ts:175–178` | unchanged: the wording of rule 5 is kept |
| `test/unit/script/api.test.ts:134–137` | `script-secret-denied`, message contains `other` | same | unchanged |
| `test/unit/script/api.test.ts:145–148` | `script-error`, message contains `a form` | the REST prelude's `bodyText` (`script/api/prelude.ts:270`), not `apply.ts` | unchanged: the prelude moves verbatim |
| `test/unit/script/api.test.ts:164–167` | `script-secret-denied`, message contains `prod-db` | the common prelude's `secrets.get` (`prelude.ts:95`) | unchanged: stays in core |
| `test/unit/script/api.test.ts:212`, `253`, `261` | `Expected 7 to be 8`, `Error: boom`, `Expected 1 to be 2` | the common prelude, the sandbox | unchanged |
| `test/unit/script/types-xsd.test.ts:255–258` | `script-error`, message contains `request.envelope` | the SOAP prelude's `noSchema` (`prelude.ts:332`) | unchanged: moves verbatim |
| `test/unit/script/postman-layer.test.ts:148` | `script-unsupported`, message contains the call's name | `script/api/postman.ts` | untouched |
| `test/unit/sequence/run.test.ts:311` | `Pay.post.ts:1:1: Error: late` | `scriptError` and the sandbox | untouched |
| `test/integration/run/scripts.test.ts:223`, `260` | `Bad.post.ts:1:14`, `Error: late` | the checker, the sandbox | untouched |
| `apps/desktop/test/script-send.test.ts:210–212`, `228–229` | code `script-origin-change`; `script-type-error` and `Echo.post.ts:1:` | the rules (code only); the checker | the code is kept |
| this task's test | `The script handed back a request the engine cannot read`; `"X" is not an HTTP method` | `apply.ts:117`, `apply.ts:125` | both kept word for word |

No test pins the text of any other refusal from `script/apply.ts`, in `packages/`, `apps/` or `e2e/` (`git grep -nE "scheme, host or port|target of a gRPC|gRPC method is called|may not hold CR|cannot change a body" -- packages apps e2e ':!packages/engine/src'` prints nothing). The wordings that change in Task 2.2b:

| Code | Today | After 2.2b |
| --- | --- | --- |
| `script-value-invalid` | REST: `The URL may not hold CR, LF or NUL`. SOAP: `The endpoint and SOAPAction may not hold CR, LF or NUL` | `A single-line value of the request may not hold CR, LF or NUL` |
| `script-origin-change` | REST: `A script cannot change the scheme, host or port of the request`. SOAP: `… of the endpoint` | `A script cannot change the scheme, host or port the request is sent to` |
| `script-origin-change` | gRPC: `A script cannot change the target of a gRPC call` | the line above when core's rule catches it (a `host:port` target, or a URL target with another origin); unchanged when gRPC's own `validate` catches it (a URL target with the same origin and another path) |
| `script-error` | REST: ``A script cannot change a body that is ${description}``. gRPC: `A script cannot change which gRPC method is called` | `A script cannot change a part of the request that is fixed` |
| `script-value-invalid` | REST and SOAP: `The header "X" may not hold CR, LF or NUL`. gRPC: `The metadata "X" may not hold CR, LF or NUL` | `The header or metadata entry "X" may not hold CR, LF or NUL` |

Unchanged: `The script handed back a request the engine cannot read`, `A script cannot add a reference to a secret the request does not already use: …`, `"X" is not an HTTP method`, `request.body could not be written: …`.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write packages/engine/test/unit/script/rules-per-protocol.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/test/unit/script/rules-per-protocol.test.ts
git commit -m "test(engine): the script rules are pinned per protocol, before they become generic (#184)"
```

---

### Task 2.2a: Generated script types and contract lookups move into the protocol folders

**Files:**
- Move: `packages/engine/src/script/types/rest.ts` → `packages/engine/src/rest/script-types.ts`
- Move: `packages/engine/src/script/types/grpc.ts` → `packages/engine/src/grpc/script-types.ts`
- Move: `packages/engine/src/script/types/xsd.ts` → `packages/engine/src/soap/script-types.ts`
- Delete: `packages/engine/src/script/contracts.ts` (its five functions move into the three files above)
- Modify: `packages/engine/src/script/index.ts` (lines 64–70, 74–76), `packages/engine/src/index.ts` (line 506), `packages/engine/src/script/run.ts` (line 29), and every other importer the grep in Step 3 lists
- Test (imports only): `packages/engine/test/unit/script/types-rest.test.ts` (l.9), `check.test.ts` (l.19), `types-grpc.test.ts` (l.9), `types-xsd.test.ts` (l.10); `packages/engine/test/unit/run/send-order.test.ts` (the specifier of its `vi.mock` of `loadOpenApiDocument`)

`script/types/json-schema.ts` stays where it is: all three protocols use it (`JsonSchemaTypes` for REST, `propertyKey` for gRPC and SOAP).

**Interfaces:**
- Consumes: nothing new.
- Produces (same names and signatures as today, new homes):
  - `rest/script-types.ts`: `restScriptTypes(operation: OpenApiOperation | undefined): string`, `restOperationFor(document: OpenApiDocument | undefined, contract: RestContractLink | undefined): OpenApiOperation | undefined`, `loadOpenApiDocument(projectDir: string, apiSlug: string): Promise<OpenApiDocument | undefined>`
  - `grpc/script-types.ts`: `grpcScriptTypes(set: ProtoSet | undefined, inputType: string, outputType: string): string`, `grpcMessageTypes(set: ProtoSet | undefined, service: string, method: string): { readonly input: string; readonly output: string } | undefined`
  - `soap/script-types.ts`: `soapScriptTypes`, `ElementSlot`, `elementSlots`, `projectElement`, `serializeElement`, `soapBodyElement`, `projectSoapBody`, `replaceSoapBody` (all as in `script/types/xsd.ts`), `qnameFromClark(clark: string): QName`, `soapOperationElements(definition: WsdlDefinition, bindingName: string, operationName: string): { readonly input?: QName; readonly output?: QName }`

- [ ] **Step 1: Move the three files and fix their own imports**

```bash
git mv packages/engine/src/script/types/rest.ts packages/engine/src/rest/script-types.ts
git mv packages/engine/src/script/types/grpc.ts packages/engine/src/grpc/script-types.ts
git mv packages/engine/src/script/types/xsd.ts packages/engine/src/soap/script-types.ts
```

Change only these import lines; no other line of the three files changes.

`rest/script-types.ts` (were lines 9–10):

```ts
import type { OpenApiOperation } from './openapi/model.js';
import { JsonSchemaTypes } from '../script/types/json-schema.js';
```

`grpc/script-types.ts` (were lines 10–12):

```ts
import { describeMessage, type MessageFieldDescriptor } from './proto/describe.js';
import type { ProtoSet } from './proto/load.js';
import { propertyKey } from '../script/types/json-schema.js';
```

`soap/script-types.ts` (were lines 18–26):

```ts
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import type { ComplexType, ElementDecl, Occurs, Particle, ResolvedAttribute, SimpleType } from '../xsd/model.js';
import { resolveType } from '../xsd/sample-types.js';
import { builtinBaseOf, facetsOf } from '../xsd/sample-values.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import { scanXml, type ScannedElement } from '../xsd/xml-scan.js';
import { NS } from '../xml/namespaces.js';
import { propertyKey } from '../script/types/json-schema.js';
```

- [ ] **Step 2: Split `script/contracts.ts` into the three files**

Each function moves with its JSDoc and keeps its body. Append it at the end of its new file.

| Function | From `script/contracts.ts` | To | Imports the destination gains |
| --- | --- | --- | --- |
| `qnameFromClark` | lines 18–22 | `soap/script-types.ts` | none (`QName` is already imported) |
| `soapOperationElements` | lines 24–48 | `soap/script-types.ts` | `import { findBinding, findMessage, findPortType, type WsdlDefinition } from '../wsdl/model.js';` |
| `restOperationFor` | lines 50–59 | `rest/script-types.ts` | see below |
| `loadOpenApiDocument` | lines 61–78 | `rest/script-types.ts` | see below |
| `grpcMessageTypes` | lines 80–93 | `grpc/script-types.ts` | `describeMethod`, added to the existing `./proto/describe.js` import |

`rest/script-types.ts` ends up with this import block (the first two lines replace the `OpenApiOperation` import of Step 1):

```ts
import { ProjectError } from '../errors.js';
import { apiDefinitionDir } from '../project/paths.js';
import { JsonSchemaTypes } from '../script/types/json-schema.js';
import type { RestContractLink } from './model.js';
import { createCachedApiFetch, readApiDefinitionCache } from './openapi/cache.js';
import { parseOpenApi } from './openapi/import.js';
import type { OpenApiDocument, OpenApiOperation } from './openapi/model.js';
```

`grpc/script-types.ts`'s first import becomes:

```ts
import { describeMessage, describeMethod, type MessageFieldDescriptor } from './proto/describe.js';
```

Then:

```bash
git rm packages/engine/src/script/contracts.ts
```

- [ ] **Step 3: Point every importer at the new files**

Run: `git grep -nE "script/(types/(rest|grpc|xsd)|contracts)\.js|'\./(types/(rest|grpc|xsd)|contracts)\.js'" -- packages apps scripts e2e`

Rewrite each hit by this table. The path prefix depends on the importing file; the file name and the symbols do not.

| Imported today from | Symbols | Import from |
| --- | --- | --- |
| `script/types/rest.js` | `restScriptTypes` | `rest/script-types.js` |
| `script/types/grpc.js` | `grpcScriptTypes` | `grpc/script-types.js` |
| `script/types/xsd.js` | everything | `soap/script-types.js` |
| `script/contracts.js` | `qnameFromClark`, `soapOperationElements` | `soap/script-types.js` |
| `script/contracts.js` | `restOperationFor`, `loadOpenApiDocument` | `rest/script-types.js` |
| `script/contracts.js` | `grpcMessageTypes` | `grpc/script-types.js` |

A file inside a protocol folder imports its own folder's file as `./script-types.js`. The hits, all of them, after slice 1:

- `packages/engine/src/soap/run.ts` (Task 1.4): the two lines `import { soapOperationElements } from '../script/contracts.js';` and `import { soapScriptTypes } from '../script/types/xsd.js';` become one, `import { soapOperationElements, soapScriptTypes } from './script-types.js';`.
- `packages/engine/src/rest/run.ts` (Task 1.5): `import { loadOpenApiDocument, restOperationFor } from '../script/contracts.js';` and `import { restScriptTypes } from '../script/types/rest.js';` become `import { loadOpenApiDocument, restOperationFor, restScriptTypes } from './script-types.js';`.
- `packages/engine/src/grpc/run.ts` (Task 1.6): `import { grpcMessageTypes } from '../script/contracts.js';` and `import { grpcScriptTypes } from '../script/types/grpc.js';` become `import { grpcMessageTypes, grpcScriptTypes } from './script-types.js';`.
- `packages/engine/src/run/script-support.ts` (`scriptTypesFor`, which slice 1 leaves exported until slice 5): line 10 and lines 26–28,

```ts
import { grpcMessageTypes, restOperationFor, soapOperationElements } from '../script/contracts.js';
```

```ts
import { grpcScriptTypes } from '../script/types/grpc.js';
import { restScriptTypes } from '../script/types/rest.js';
import { soapScriptTypes } from '../script/types/xsd.js';
```

  become three lines, each in its alphabetical place among the file's imports:

```ts
import { grpcMessageTypes, grpcScriptTypes } from '../grpc/script-types.js';
import { restOperationFor, restScriptTypes } from '../rest/script-types.js';
import { soapOperationElements, soapScriptTypes } from '../soap/script-types.js';
```

- `packages/engine/src/run/run.ts` has no hit: slice 1's rewrite (Task 1.7) dropped its import of `loadOpenApiDocument`.
- `packages/engine/test/unit/run/send-order.test.ts` (Task 1.2) replaces `loadOpenApiDocument` with `vi.mock`. The module it mocks is the one `rest/run.ts` now imports, so both specifiers in

```ts
vi.mock('../../../src/script/contracts.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/script/contracts.js')>()),
```

  become `'../../../src/rest/script-types.js'`. Nothing else in that file changes, and its fifteen tests must pass unchanged in Step 4: they pin the order of a send across this move.
- `packages/engine/src/script/run.ts:29`: `import { projectSoapBody, replaceSoapBody } from '../soap/script-types.js';` (this import leaves `script/` in Task 2.2b).
- `packages/engine/src/index.ts:506`: `export { loadOpenApiDocument } from './rest/script-types.js';`
- `packages/engine/src/script/index.ts` lines 64–70 and 74–76 become:

```ts
export { loadOpenApiDocument, restOperationFor, restScriptTypes } from '../rest/script-types.js';
export { grpcMessageTypes, grpcScriptTypes } from '../grpc/script-types.js';
export {
  projectSoapBody,
  qnameFromClark,
  replaceSoapBody,
  soapOperationElements,
  soapScriptTypes,
} from '../soap/script-types.js';
```

- `packages/engine/test/unit/script/types-rest.test.ts:9` and `check.test.ts:19`: `'../../../src/rest/script-types.js'`.
- `packages/engine/test/unit/script/types-grpc.test.ts:9`: `'../../../src/grpc/script-types.js'`.
- `packages/engine/test/unit/script/types-xsd.test.ts:10`: `'../../../src/soap/script-types.js'`.

Run the grep again. Expected: no output.

- [ ] **Step 4: Run the tests**

Run: `nice pnpm exec tsc -b`
Expected: no errors.

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/script/ packages/engine/test/unit/run/send-order.test.ts`
Expected: PASS, every file, with no expected value touched.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/engine/src/rest/script-types.ts packages/engine/src/grpc/script-types.ts packages/engine/src/soap/script-types.ts packages/engine/src/script packages/engine/src/index.ts packages/engine/src/run packages/engine/src/soap/run.ts packages/engine/src/rest/run.ts packages/engine/src/grpc/run.ts packages/engine/test/unit/script packages/engine/test/unit/run/send-order.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages/engine
git commit -m "refactor(engine): a protocol's generated script types and contract lookups live in its folder (#184)"
```

---

### Task 2.2b: The three scripting facets and the generic rules

**Files:**
- Create: `packages/engine/src/soap/scripting.ts`, `packages/engine/src/rest/scripting.ts`, `packages/engine/src/grpc/scripting.ts`, `packages/engine/src/script/lookup.ts`
- Rewrite: `packages/engine/src/script/apply.ts`
- Modify: `packages/engine/src/script/model.ts`, `script/send.ts`, `script/run.ts`, `script/request-scripts.ts`, `script/api/prelude.ts`, `script/types/api.ts`, `script/index.ts`
- Modify: `packages/engine/src/protocols.ts` (the snapshot unions), `soap/module.ts`, `rest/module.ts`, `grpc/module.ts` (register the facet), `soap/run.ts`, `rest/run.ts`, `grpc/run.ts` (import paths), `run/script-support.ts` (`ScriptSession`)
- Modify: `scripts/docs-script-api.ts`
- Modify: `apps/desktop/src/main/script-host.ts` (line 161)
- Test: `packages/engine/test/unit/script/rules-per-protocol.test.ts` (imports and `apply`), `apply.test.ts` (lines 6–7), `api.test.ts` (lines 7–13), `postman-layer.test.ts` (line 7), `types-xsd.test.ts` (lines 11, 184, 207, 230)

**Interfaces:**
- Consumes (slice 1, from the preamble's contract): `ProtocolScripting<Q, R>`, `SnapshotFacts`, `RequestSnapshotBase`, `ResponseSnapshotBase`, `defineProtocol` (`protocol/module.ts`); `ProtocolRegistry` (`protocol/registry.ts`); `defaultRegistry()` (`protocols.ts`); `soapProtocol`, `restProtocol`, `grpcProtocol` and each protocol's `…Run.send`.
- Produces:
  - `script/apply.ts`:
    - `const headerPairSchema` (`z.tuple([z.string(), z.string()])`)
    - `type ApplyResult<Q extends RequestSnapshotBase = RequestSnapshotBase> = { readonly ok: true; readonly request: Q } | { readonly ok: false; readonly error: ScriptFailure }`
    - `secretReferencesIn(texts: readonly string[]): Set<string>`
    - `applyRequestChanges<Q extends RequestSnapshotBase, R extends ResponseSnapshotBase>(scripting: ProtocolScripting<Q, R>, before: Q, returned: unknown): ApplyResult<Q>`
  - `script/lookup.ts`:
    - `scriptingOf(protocol: string, registry?: ProtocolRegistry): ProtocolScripting | undefined`
    - `requireScripting(scripting: ProtocolScripting | string, registry?: ProtocolRegistry): ProtocolScripting` — throws `WirebenchError` `script-unsupported`
  - `script/api/prelude.ts`: `buildPrelude(scripting: ProtocolScripting, phase: ScriptPhase, api: ScriptApi, layer?: string): string`
  - `script/types/api.ts`:
    - `apiDeclarations(scripting: ProtocolScripting | string, phase: ScriptPhase, registry?: ProtocolRegistry): string`
    - `scriptDeclarations(scripting: ProtocolScripting | string, phase: ScriptPhase, secrets: readonly string[], generated: string, registry?: ProtocolRegistry): string`
    - `apiReference(registry?: ProtocolRegistry): readonly ApiReferenceSection[]`
  - `script/run.ts`: `ScriptRunInput.request: RequestSnapshotBase`, `.response?: ResponseSnapshot | ResponseSnapshotBase`, `.binding?: unknown` (replaces `.soap`), `.registry?: ProtocolRegistry`; `runScript(input: ScriptRunInput): Promise<ScriptOutcome>` unchanged in shape
  - `script/request-scripts.ts`: `RequestScriptTypes { readonly generated: string; readonly binding?: unknown }`; `RequestScriptingOptions.registry?: ProtocolRegistry`; `ScriptedRequest.protocol: string`; `RequestScripting.pre(request, snapshot: RequestSnapshotBase, values, layer?)`, `.post(request, sent: RequestSnapshotBase, response: ResponseSnapshotBase, values, layer?)`
  - `script/model.ts`: `ScriptOutcome.request?: RequestSnapshotBase`
  - `script/send.ts`: `pairsOf`, `entriesOf`, `recordPairs` exported
  - `run/script-support.ts`: `ScriptSession.pre: <S extends RequestSnapshotBase>(before: S) => Promise<S>`, `ScriptSession.post: (sent: RequestSnapshotBase, response: ResponseSnapshotBase) => Promise<SentScripts>`
  - `soap/scripting.ts`: `soapScripting: ProtocolScripting<SoapRequestSnapshot, SoapResponseSnapshot>`, `interface SoapScriptBinding { readonly schemas: SchemaSet; readonly input?: QName; readonly output?: QName }`, and, moved in under their names, `SoapRequestSnapshot`, `SoapResponseSnapshot`, `soapRequestSnapshot`, `applySoapSnapshot`, `soapResponseSnapshot`
  - `rest/scripting.ts`: `restScripting: ProtocolScripting<RestRequestSnapshot, RestResponseSnapshot>`, and `RestBodySnapshot`, `RestRequestSnapshot`, `RestResponseSnapshot`, `restRequestSnapshot`, `applyRestSnapshot`, `restResponseSnapshot`
  - `grpc/scripting.ts`: `grpcScripting: ProtocolScripting<GrpcRequestSnapshot, GrpcResponseSnapshot>`, and `GrpcRequestSnapshot`, `GrpcResponseSnapshot`, `grpcRequestSnapshot`, `applyGrpcSnapshot`, `grpcResponseSnapshot`
  - `protocols.ts`: `type RequestSnapshot = RestRequestSnapshot | SoapRequestSnapshot | GrpcRequestSnapshot`, `type ResponseSnapshot = RestResponseSnapshot | SoapResponseSnapshot | GrpcResponseSnapshot`

**One rule for every function this task adds to `script/`:** `scriptingOf`, `requireScripting`, `buildPrelude`, `apiDeclarations`, `scriptDeclarations` and `apiReference` are `function` declarations, never `const` arrows. They sit on an import cycle with `protocols.ts` (`script/` → `protocols.ts` → a module → `script/`), and a hoisted function is what makes that cycle harmless. None of them is called at module scope.

- [ ] **Step 1: Rewrite `script/apply.ts`**

The whole file:

```ts
/**
 * Checks what a pre-request script changed before any of it is sent (spec §What a pre-request
 * script can change; ADR-0016).
 *
 * The request a script hands back is untrusted input: a script can call `__finish` itself and
 * return any shape. So it is parsed against its protocol's schema first, then held to the rules.
 * The rules are the same for every protocol. A module says what its snapshot holds
 * (`ProtocolScripting.inspect`) and this file decides, so a module cannot forget a rule:
 *
 * 1. the value parses against the module's `requestSchema` and keeps its `protocol`
 *    (`script-error`);
 * 2. no single-line value holds CR, LF or NUL (`script-value-invalid`);
 * 3. the destination keeps its scheme, host and port, and one that is not a URL stays exactly as it
 *    was (`script-origin-change`);
 * 4. what the module calls fixed comes back unchanged (`script-error`);
 * 5. no header or metadata pair holds CR, LF or NUL (`script-value-invalid`);
 * 6. no `${secret:…}` reference appears that the request's own text did not already hold
 *    (`script-secret-denied`) — otherwise a script could read any secret by naming it;
 * 7. the module's own rules (`validate`), when it has any.
 *
 * The order is the one in which the three built-in protocols have always reported a request that
 * breaks two rules at once.
 */
import { z } from 'zod';
import type { ProtocolScripting, RequestSnapshotBase, ResponseSnapshotBase } from '../protocol/module.js';
import type { HeaderPair, ScriptFailure } from './model.js';

/** A header or metadata pair as a script hands it back; every module's `requestSchema` uses it. */
export const headerPairSchema = z.tuple([z.string(), z.string()]);

/** The checked request a pre-request script hands back, or why it is refused. */
export type ApplyResult<Q extends RequestSnapshotBase = RequestSnapshotBase> =
  { readonly ok: true; readonly request: Q } | { readonly ok: false; readonly error: ScriptFailure };

const CONTROL = /[\r\n\0]/;
const SECRET_OPEN = '${secret:';

const refuse = (
  code: ScriptFailure['code'],
  message: string,
): { readonly ok: false; readonly error: ScriptFailure } => ({ ok: false, error: { code, message } });

/** Every `${secret:name}` that `texts` name: a module's `inspect(snapshot).texts`. */
export function secretReferencesIn(texts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts) {
    addSecretNames(text, names);
  }
  return names;
}

/**
 * Adds the name of every `${secret:name}` in `text` to `names`: the text from each `${secret:` to
 * the first `}` after it. A scan rather than a regex, so text a server chose — many `${secret:`
 * with no closing brace — costs linear time, never quadratic.
 */
function addSecretNames(text: string, names: Set<string>): void {
  let from = 0;
  for (;;) {
    const open = text.indexOf(SECRET_OPEN, from);
    if (open === -1) return;
    const start = open + SECRET_OPEN.length;
    const close = text.indexOf('}', start);
    // No `}` after this opening means none after any later one either.
    if (close === -1) return;
    names.add(text.slice(start, close));
    from = close + 1;
  }
}

function badPair(pairs: readonly HeaderPair[]): string | undefined {
  return pairs.find(([name, value]) => CONTROL.test(name) || CONTROL.test(value))?.[0];
}

/**
 * The origin of a destination that is a URL with a host; undefined for anything else. A gRPC
 * `host:port` target parses as a scheme and a path with no host, and so does `localhost:8080/x`:
 * neither has an origin a path could change under, so both have to stay exactly as they were.
 */
function originOf(destination: string): string | undefined {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return undefined;
  }
  if (url.host === '') return undefined;
  // A non-special scheme (`grpc:`) has an opaque `origin` of "null"; host and port still say where
  // the request goes.
  return url.origin !== 'null' ? url.origin : `${url.protocol}//${url.host}`;
}

function sameDestination(before: string, after: string): boolean {
  const was = originOf(before);
  return was === undefined ? before === after : was === originOf(after);
}

/**
 * The checked request a pre-request script hands back, or why it is refused. `scripting` is the
 * facet of the protocol `before` belongs to.
 */
export function applyRequestChanges<Q extends RequestSnapshotBase, R extends ResponseSnapshotBase>(
  scripting: ProtocolScripting<Q, R>,
  before: Q,
  returned: unknown,
): ApplyResult<Q> {
  const parsed = scripting.requestSchema.safeParse(returned);
  if (!parsed.success || parsed.data.protocol !== before.protocol) {
    return refuse('script-error', 'The script handed back a request the engine cannot read');
  }
  const after = parsed.data;
  const was = scripting.inspect(before);
  const now = scripting.inspect(after);

  if (now.lines.some((line) => CONTROL.test(line))) {
    return refuse('script-value-invalid', 'A single-line value of the request may not hold CR, LF or NUL');
  }
  if (!sameDestination(was.destination, now.destination)) {
    return refuse('script-origin-change', 'A script cannot change the scheme, host or port the request is sent to');
  }
  if (JSON.stringify(now.fixed) !== JSON.stringify(was.fixed)) {
    return refuse('script-error', 'A script cannot change a part of the request that is fixed');
  }
  const pair = badPair(now.pairs);
  if (pair !== undefined) {
    return refuse('script-value-invalid', `The header or metadata entry "${pair}" may not hold CR, LF or NUL`);
  }
  const allowed = secretReferencesIn(was.texts);
  const added = [...secretReferencesIn(now.texts)].filter((name) => !allowed.has(name));
  if (added.length > 0) {
    return refuse(
      'script-secret-denied',
      `A script cannot add a reference to a secret the request does not already use: ${added.join(', ')}`,
    );
  }
  const failure = scripting.validate?.(before, after);
  if (failure !== undefined) {
    return { ok: false, error: failure };
  }
  return { ok: true, request: after };
}
```

`addSecretNames` and `badPair` are today's (lines 83–104) with no change. `sameOrigin` (lines 106–111) becomes `sameDestination` over `originOf`; the import of `urlOrigin` from `../project/sequence-guards.js` goes.

- [ ] **Step 2: `script/send.ts` keeps the placeholders and the pair helpers**

1. Delete the converters and what only they used: lines 91 (`RAW_LANGUAGES`) and 93–246. They move in Steps 5 to 7.
2. Lines 82–89 stay, each exported and documented:

```ts
/** The enabled rows of a key-value table as header pairs, in order. */
export const pairsOf = (entries: readonly KeyValueEntry[]): HeaderPair[] =>
  entries.filter((e) => e.enabled).map((e) => [e.name, e.value] as const);

/** Header pairs as enabled key-value rows. */
export const entriesOf = (pairs: readonly HeaderPair[]): KeyValueEntry[] =>
  pairs.map(([name, value]) => ({ name, value, enabled: true }));

/** A record's entries as header pairs. */
export const recordPairs = (record: Readonly<Record<string, string>> | undefined): HeaderPair[] =>
  Object.entries(record ?? {}).map(([name, value]) => [name, value] as const);
```

3. The import block (lines 15–32) becomes:

```ts
import { randomUUID } from 'node:crypto';
import type { KeyValueEntry } from '../rest/model.js';
import { resolveSecretTokens, type GetSecret } from '../secrets/resolve.js';
import type { HeaderPair } from './model.js';
```

4. In the header comment, replace its last paragraph (lines 11–13, `The converters turn…`) with:

```ts
 * Each protocol's converters between a prepared send and the snapshot a script sees live in its
 * own folder (`<protocol>/scripting.ts`); the helpers at the end of this file are what they share.
```

- [ ] **Step 3: `script/model.ts` becomes protocol-neutral**

1. Delete lines 16–86: `RestBodySnapshot`, `RestRequestSnapshot`, `SoapRequestSnapshot`, `GrpcRequestSnapshot`, `RequestSnapshot`, `RestResponseSnapshot`, `SoapResponseSnapshot`, `GrpcResponseSnapshot`, `ResponseSnapshot`. `HeaderPair` (lines 13–14) stays.
2. Add to the imports: `import type { RequestSnapshotBase } from '../protocol/module.js';`
3. Line 127, in `ScriptOutcome`: `readonly request?: RequestSnapshotBase;`
4. Line 8 gains its JSDoc and stays exported until slice 5:

```ts
/** The three built-in protocols that have scripts. Core takes any protocol's `kind`; this name goes in 3.0 (spec §8). */
export type ScriptProtocol = 'rest' | 'soap' | 'grpc';
```

- [ ] **Step 4: Create `script/lookup.ts`**

```ts
/** Finds the scripting facet of a protocol (spec §5.5). */
import { WirebenchError } from '../errors.js';
import type { ProtocolScripting } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';

/** The scripting facet of `protocol` in `registry` (the built-in one when absent), if it has one. */
export function scriptingOf(
  protocol: string,
  registry: ProtocolRegistry = defaultRegistry(),
): ProtocolScripting | undefined {
  return registry.find(protocol)?.scripting;
}

/**
 * A facet as given, or the facet of the protocol a `kind` names.
 *
 * @throws WirebenchError `script-unsupported` when the protocol has no scripting facet
 */
export function requireScripting(scripting: ProtocolScripting | string, registry?: ProtocolRegistry): ProtocolScripting {
  if (typeof scripting !== 'string') return scripting;
  const found = scriptingOf(scripting, registry);
  if (found === undefined) {
    throw new WirebenchError('script-unsupported', `Requests of the "${scripting}" protocol cannot have scripts`, {
      details: { protocol: scripting },
    });
  }
  return found;
}
```

- [ ] **Step 5: Create `rest/scripting.ts`**

Header and imports:

```ts
/**
 * What a script sees of a REST request and its response (spec §3.4): the snapshots, the converters
 * between a prepared send and a snapshot, the API's declarations, its sandbox-side source, and what
 * the script rules check.
 */
import { z } from 'zod';
import type { ProtocolScripting, SnapshotFacts } from '../protocol/module.js';
import { headerPairSchema } from '../script/apply.js';
import type { HeaderPair, ScriptFailure } from '../script/model.js';
import { entriesOf, pairsOf } from '../script/send.js';
import type { RawLanguage } from './model.js';
import type { RestExchange, RestSendInput } from './send.js';
import { composeUrl } from './url.js';
```

Moved in, in this order, each with its comment and no change to its body:

| What | From |
| --- | --- |
| `RestBodySnapshot`, `RestRequestSnapshot` | `script/model.ts` lines 16–30 |
| `RestResponseSnapshot` | `script/model.ts` lines 55–62 |
| `RAW_LANGUAGES` | `script/send.ts` line 91 |
| `restRequestSnapshot`, `applyRestSnapshot`, `restResponseSnapshot` | `script/send.ts` lines 95–161 |
| `range`, `STATUS_TYPES` | `script/types/api.ts` lines 11–23 |
| `REST_REQUEST`, `REST_PRE`, `REST_POST` | `script/types/api.ts` lines 93–146 |
| `REST` (the sandbox-side source, with its comment) | `script/api/prelude.ts` lines 218–319 |

New code, after them:

```ts
/** An HTTP method token. The generic rules do not know what a method is, so this one is REST's own. */
const METHOD = /^[A-Z][A-Z0-9_-]{0,31}$/;

const bodySchema: z.ZodType<RestBodySnapshot> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('text'), text: z.string(), language: z.string() }),
  z.object({ kind: z.literal('other'), description: z.string() }),
]);

const requestSchema: z.ZodType<RestRequestSnapshot> = z.object({
  protocol: z.literal('rest'),
  method: z.string(),
  url: z.string(),
  headers: z.array(headerPairSchema),
  body: bodySchema,
});

/** REST's scripting facet. */
export const restScripting: ProtocolScripting<RestRequestSnapshot, RestResponseSnapshot> = {
  declarations: (phase) => [STATUS_TYPES, REST_REQUEST, phase === 'pre' ? REST_PRE : REST_POST].join('\n'),
  reference: () => [
    { title: 'REST: shared by both phases', declarations: REST_REQUEST },
    { title: 'REST: pre-request', declarations: REST_PRE },
    { title: 'REST: post-response', declarations: REST_POST },
  ],
  prelude: () => REST,
  requestSchema,
  inspect(snapshot): SnapshotFacts {
    return {
      destination: snapshot.url,
      // A form, multipart or binary body comes back exactly as it went; a text body is the script's.
      fixed: snapshot.body.kind === 'other' ? snapshot.body : null,
      pairs: snapshot.headers,
      lines: [snapshot.url],
      texts: [
        snapshot.method,
        snapshot.url,
        ...snapshot.headers.flat(),
        ...(snapshot.body.kind === 'text' ? [snapshot.body.text] : []),
      ],
    };
  },
  validate(_before, after): ScriptFailure | undefined {
    return METHOD.test(after.method)
      ? undefined
      : { code: 'script-value-invalid', message: `"${after.method}" is not an HTTP method` };
  },
};
```

`validate` holds the one REST check the five generic rules do not cover: today's `METHOD` test (`script/apply.ts:56`, `124–126`), with its message unchanged.

- [ ] **Step 6: Create `soap/scripting.ts`**

Header and imports:

```ts
/**
 * What a script sees of a SOAP request and its response (spec §3.4): the snapshots, the converters
 * between an expanded send and a snapshot, the API's declarations, its sandbox-side source, what
 * the script rules check, and the typed `body` a schema gives the script.
 */
import { z } from 'zod';
import type { ProtocolScripting, SnapshotFacts } from '../protocol/module.js';
import { headerPairSchema } from '../script/apply.js';
import type { HeaderPair } from '../script/model.js';
import type { RequestScriptTypes } from '../script/request-scripts.js';
import { recordPairs } from '../script/send.js';
import type { SoapExchange, SoapSendInput } from '../types.js';
import type { QName } from '../wsdl/qname.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import { projectSoapBody, replaceSoapBody } from './script-types.js';
```

Moved in, in this order:

| What | From |
| --- | --- |
| `SoapRequestSnapshot` | `script/model.ts` lines 32–41 |
| `SoapResponseSnapshot` | `script/model.ts` lines 64–74 |
| `soapRequestSnapshot`, `applySoapSnapshot`, `soapResponseSnapshot` | `script/send.ts` lines 165–197 |
| `SOAP_PRE`, `SOAP_POST` | `script/types/api.ts` lines 148–180 |
| `SOAP` (the sandbox-side source) | `script/api/prelude.ts` lines 321–389 |
| `withBody` | `script/run.ts` lines 187–189 |

New code, after them. The three `views` functions are today's `withSoapBody` (`script/run.ts:191–201`), the response projection inside `runScript` (`script/run.ts:132–135`) and `writeSoapBody` (`script/run.ts:203–230`), reading the binding back from `types` where they took `ScriptRunInput['soap']`:

```ts
/**
 * What SOAP's script types carry for the typed `request.body` and `response.body`
 * (`RequestScriptTypes.binding`): the schema and the operation's input and output elements.
 */
export interface SoapScriptBinding {
  readonly schemas: SchemaSet;
  readonly input?: QName;
  readonly output?: QName;
}

/** The binding this module put on a request's script types, if it put one. */
function bindingOf(types: RequestScriptTypes): SoapScriptBinding | undefined {
  const binding = types.binding;
  if (typeof binding !== 'object' || binding === null || !('schemas' in binding)) return undefined;
  return binding as SoapScriptBinding;
}

const requestSchema: z.ZodType<SoapRequestSnapshot> = z.object({
  protocol: z.literal('soap'),
  endpoint: z.string(),
  soapAction: z.string(),
  headers: z.array(headerPairSchema),
  envelope: z.string(),
  body: z.unknown().optional(),
});

/** SOAP's scripting facet. */
export const soapScripting: ProtocolScripting<SoapRequestSnapshot, SoapResponseSnapshot> = {
  declarations: (phase) => (phase === 'pre' ? SOAP_PRE : SOAP_POST),
  reference: () => [
    { title: 'SOAP: pre-request', declarations: SOAP_PRE },
    { title: 'SOAP: post-response', declarations: SOAP_POST },
  ],
  prelude: () => SOAP,
  requestSchema,
  inspect(snapshot): SnapshotFacts {
    return {
      destination: snapshot.endpoint,
      fixed: null,
      pairs: snapshot.headers,
      lines: [snapshot.endpoint, snapshot.soapAction],
      // Not `body`: it is a view of the envelope, written back into it after the rules have run.
      texts: [snapshot.endpoint, snapshot.soapAction, snapshot.envelope, ...snapshot.headers.flat()],
    };
  },
  views: {
    /** The request with its body projected, when the schema describes the body element. */
    request(snapshot, types) {
      const binding = bindingOf(types);
      return binding === undefined
        ? snapshot
        : withBody(snapshot, projectSoapBody(binding.schemas, binding.input, snapshot.envelope));
    },
    response(snapshot, types) {
      const binding = bindingOf(types);
      return binding === undefined
        ? snapshot
        : withBody(snapshot, projectSoapBody(binding.schemas, binding.output, snapshot.text));
    },
    /**
     * Writes a changed `request.body` back into the envelope, replacing the body element. The body
     * wins over an envelope the script also edited, since it is written into that edited envelope.
     */
    writeBack(before, after, types) {
      const binding = bindingOf(types);
      const { body, ...rest } = after;
      if (body === undefined || JSON.stringify(body) === JSON.stringify(before.body) || binding?.input === undefined) {
        return { ok: true, request: rest };
      }
      try {
        return {
          ok: true,
          request: { ...rest, envelope: replaceSoapBody(binding.schemas, binding.input, rest.envelope, body) },
        };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'script-error',
            message: `request.body could not be written: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    },
  },
};
```

SOAP has no `validate`: everything today's SOAP branch checks (`script/apply.ts:142–155`) is rule 2, 3 or 5 above.

- [ ] **Step 7: Create `grpc/scripting.ts`**

Header and imports:

```ts
/**
 * What a script sees of a gRPC call and its answer (spec §3.4): the snapshots, the converters
 * between a prepared call and a snapshot, the API's declarations, its sandbox-side source, and what
 * the script rules check.
 */
import { z } from 'zod';
import type { ProtocolScripting, SnapshotFacts } from '../protocol/module.js';
import { headerPairSchema } from '../script/apply.js';
import type { HeaderPair, ScriptFailure } from '../script/model.js';
import { entriesOf, pairsOf, recordPairs } from '../script/send.js';
import type { GrpcCallResult } from './call.js';
import type { GrpcSendInput } from './send.js';
```

Moved in, in this order:

| What | From |
| --- | --- |
| `GrpcRequestSnapshot` | `script/model.ts` lines 43–51 |
| `GrpcResponseSnapshot` | `script/model.ts` lines 76–84 |
| `PreparedGrpc`, `grpcRequestSnapshot`, `applyGrpcSnapshot`, `grpcResponseSnapshot` | `script/send.ts` lines 201–246 |
| `GRPC_PRE`, `GRPC_POST` | `script/types/api.ts` lines 182–205 |
| `GRPC` (the sandbox-side source) | `script/api/prelude.ts` lines 391–432 |

New code, after them:

```ts
const requestSchema: z.ZodType<GrpcRequestSnapshot> = z.object({
  protocol: z.literal('grpc'),
  target: z.string(),
  method: z.string(),
  metadata: z.array(headerPairSchema),
  message: z.unknown(),
});

/** gRPC's scripting facet. */
export const grpcScripting: ProtocolScripting<GrpcRequestSnapshot, GrpcResponseSnapshot> = {
  declarations: (phase) => (phase === 'pre' ? GRPC_PRE : GRPC_POST),
  reference: () => [
    { title: 'gRPC: pre-request', declarations: GRPC_PRE },
    { title: 'gRPC: post-response', declarations: GRPC_POST },
  ],
  prelude: () => GRPC,
  requestSchema,
  inspect(snapshot): SnapshotFacts {
    return {
      destination: snapshot.target,
      fixed: snapshot.method,
      pairs: snapshot.metadata,
      lines: [],
      texts: [snapshot.target, ...snapshot.metadata.flat(), JSON.stringify(snapshot.message) ?? ''],
    };
  },
  /**
   * A target never changes at all. Core's destination rule already holds a `host:port` target to
   * that; one written as a URL (`grpcs://host:443`) would be allowed another path, so it is held
   * here.
   */
  validate(before, after): ScriptFailure | undefined {
    return after.target === before.target
      ? undefined
      : { code: 'script-origin-change', message: 'A script cannot change the target of a gRPC call' };
  },
};
```

`validate` holds the one gRPC check the generic rules only partly cover: today's `after.target !== was.target` (`script/apply.ts:158–160`).

- [ ] **Step 8: Add the snapshot unions to `protocols.ts`**

```ts
import type { GrpcRequestSnapshot, GrpcResponseSnapshot } from './grpc/scripting.js';
import type { RestRequestSnapshot, RestResponseSnapshot } from './rest/scripting.js';
import type { SoapRequestSnapshot, SoapResponseSnapshot } from './soap/scripting.js';

/** The request snapshot of any built-in protocol that has scripts (spec §3.1). */
export type RequestSnapshot = RestRequestSnapshot | SoapRequestSnapshot | GrpcRequestSnapshot;

/** The response snapshot of any built-in protocol that has scripts (spec §3.1). */
export type ResponseSnapshot = RestResponseSnapshot | SoapResponseSnapshot | GrpcResponseSnapshot;
```

- [ ] **Step 9: `script/api/prelude.ts` takes the facet**

1. Delete `REST`, `SOAP`, `GRPC` (lines 218–432, moved in Steps 5 to 7) and the `PROTOCOL` map (line 442). `COMMON` (lines 17–216) and `FINISH` (lines 434–440) stay.
2. Lines 14–15 become:

```ts
import type { ProtocolScripting } from '../../protocol/module.js';
import type { ScriptApi, ScriptPhase } from '../model.js';
import { SCRIPT_OUTPUT_LIMITS } from '../model.js';
```

3. `buildPrelude` (lines 444–451) becomes:

```ts
/**
 * The prelude for one script: the common API, the protocol's `request`/`response` from its
 * scripting facet, any extra layer and `__finish`.
 */
export function buildPrelude(scripting: ProtocolScripting, phase: ScriptPhase, api: ScriptApi, layer = ''): string {
  return `'use strict';\n(() => {\n${COMMON}\n${scripting.prelude(phase)}\n${api === 'postman' ? layer : ''}\n${FINISH}\n})();\n`;
}
```

The output is the same string as today for each built-in protocol: `scripting.prelude(phase)` returns the constant `PROTOCOL[protocol]` held.

- [ ] **Step 10: `script/types/api.ts` takes the facet, and the reference comes from the registry**

1. Delete `range`, `STATUS_TYPES` (lines 11–23) and `REST_REQUEST` through `GRPC_POST` (lines 93–205), moved in Steps 5 to 7. `COMMON` (lines 25–91), `secretNameType` (lines 224–228) and `ApiReferenceSection` (lines 240–244) stay.
2. The header comment (lines 1–8) becomes:

```ts
/**
 * The static half of a script's types (spec §API): the declarations every script has, followed by
 * the ones its protocol's scripting facet supplies for the phase. Those refer to aliases the
 * generated half defines from the request's contract (`<protocol>/script-types.ts`), and to
 * `WbSecretName`.
 *
 * A script is a global script, not a module: these are ambient declarations, one file per script.
 */
```

3. Line 9 becomes:

```ts
import type { ProtocolScripting } from '../../protocol/module.js';
import type { ProtocolRegistry } from '../../protocol/registry.js';
import { defaultRegistry } from '../../protocols.js';
import { requireScripting } from '../lookup.js';
import type { ScriptPhase } from '../model.js';
```

4. `apiDeclarations` (lines 207–222), `scriptDeclarations` (lines 230–238) and `apiReference` (lines 246–262) become:

```ts
/**
 * The API's declarations for one protocol and phase. `scripting` is the protocol's facet, or its
 * `kind`, looked up in `registry` (the built-in one when absent).
 *
 * @throws WirebenchError `script-unsupported` when a `kind` has no scripting facet
 */
export function apiDeclarations(
  scripting: ProtocolScripting | string,
  phase: ScriptPhase,
  registry?: ProtocolRegistry,
): string {
  return [COMMON, requireScripting(scripting, registry).declarations(phase)].join('\n');
}

/**
 * Everything a script is checked against: the API, its secret names, and the request's generated types.
 *
 * @throws WirebenchError `script-unsupported` when a `kind` has no scripting facet
 */
export function scriptDeclarations(
  scripting: ProtocolScripting | string,
  phase: ScriptPhase,
  secrets: readonly string[],
  generated: string,
  registry?: ProtocolRegistry,
): string {
  return `${apiDeclarations(scripting, phase, registry)}\n${secretNameType(secrets)}\n${generated}`;
}

/** Orders two protocols' sections by the title of the first, in code-unit order. */
function byFirstTitle(a: readonly ApiReferenceSection[], b: readonly ApiReferenceSection[]): number {
  const left = a[0]?.title ?? '';
  const right = b[0]?.title ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The API's declarations as the docs site's reference shows them (`pnpm docs:script-api`): what
 * every script has, then the sections of each protocol in `registry` that has a scripting facet.
 * Protocols are ordered by title, not by registration, so the page does not depend on the order a
 * host composed its modules in. The status literal types are described rather than listed.
 */
export function apiReference(registry: ProtocolRegistry = defaultRegistry()): readonly ApiReferenceSection[] {
  const perProtocol = registry.modules
    .map((module) => module.scripting?.reference() ?? [])
    .filter((sections) => sections.length > 0)
    .sort(byFirstTitle);
  return [{ title: 'Every script', declarations: COMMON }, ...perProtocol.flat()].map((section) => ({
    title: section.title,
    declarations: section.declarations.trim(),
  }));
}
```

`REST: …` sorts before `SOAP: …` before `gRPC: …` in code-unit order, which is the order of today's page. `apiDeclarations('rest', phase)` returns the same string as today: `[COMMON, [STATUS_TYPES, REST_REQUEST, X].join('\n')].join('\n')` equals `[COMMON, STATUS_TYPES, REST_REQUEST, X].join('\n')`.

- [ ] **Step 11: `script/run.ts` runs any protocol's script**

1. Lines 9–31 (the imports) become:

```ts
import { z } from 'zod';
import type { RequestSnapshotBase, ResponseSnapshotBase } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import type { ResponseSnapshot } from '../protocols.js';
import { TRANSFER_NAME_PATTERN } from '../sequence/model.js';
import { applyRequestChanges } from './apply.js';
import { buildPrelude } from './api/prelude.js';
import { POSTMAN_LAYER } from './api/postman.js';
import { scriptingOf } from './lookup.js';
import {
  SCRIPT_OUTPUT_LIMITS,
  type ScriptApi,
  type ScriptErrorCode,
  type ScriptFailure,
  type ScriptOutcome,
  type ScriptPhase,
  type ScriptTest,
  type ScriptValue,
} from './model.js';
import type { RequestScriptTypes } from './request-scripts.js';
import type { ScriptSandbox } from './sandbox/host.js';
import type { SandboxError } from './sandbox/model.js';
import { StripError, stripTypes } from './strip.js';
```

2. In `ScriptRunInput`, the `request` and `response` fields (lines 42–45) and the `soap` field with its comment (lines 58–63) become the four fields below. Every other field stays.

```ts
  /** For a pre-request script, the request it may change; for a post-response one, what was sent. */
  readonly request: RequestSnapshotBase;
  /**
   * Required for a post-response script. Any module's response snapshot; the built-in union is
   * named only so that a literal of one of its members type-checks.
   */
  readonly response?: ResponseSnapshot | ResponseSnapshotBase;
```

```ts
  /**
   * What the request's module put on its script types for typed views (`RequestScriptTypes.binding`).
   * For SOAP: the schema and the operation's elements, which give the script a typed `request.body`
   * and `response.body`. Without it the body is only reachable as `envelope`.
   */
  readonly binding?: unknown;
  /** Where the request's protocol is looked up; the built-in registry when absent. */
  readonly registry?: ProtocolRegistry;
```

3. `runScript` (lines 110–185) becomes:

```ts
/**
 * Runs one script. A request whose protocol has no scripting facet in the registry fails with
 * `script-unsupported`, and nothing runs.
 */
export async function runScript(input: ScriptRunInput): Promise<ScriptOutcome> {
  const empty = { tests: [], values: [], log: { lines: [], truncated: false } } as const;
  if (input.phase === 'post' && input.response === undefined) {
    throw new Error('runScript: a post-response script needs the response');
  }
  const scripting = scriptingOf(input.request.protocol, input.registry);
  if (scripting === undefined) {
    return {
      ok: false,
      error: {
        code: 'script-unsupported',
        message: `Requests of the "${input.request.protocol}" protocol cannot have scripts`,
      },
      ...empty,
    };
  }

  let code: string;
  try {
    code = input.api === 'wirebench' ? stripTypes(input.source) : input.source;
  } catch (error) {
    return {
      ok: false,
      error: { code: 'script-syntax-error', message: error instanceof StripError ? error.message : String(error) },
      ...empty,
    };
  }

  for (const value of Object.values(input.secrets)) {
    input.onSecretValue?.(value);
  }

  // The views read only the binding; a script's generated types are the checker's business.
  const types: RequestScriptTypes = {
    generated: '',
    ...(input.binding !== undefined ? { binding: input.binding } : {}),
  };
  const request = scripting.views?.request(input.request, types) ?? input.request;
  const response =
    input.response === undefined
      ? undefined
      : (scripting.views?.response(input.response, types) ?? input.response);

  const result = await input.sandbox.run({
    prelude: buildPrelude(
      scripting,
      input.phase,
      input.api,
      input.layer ?? (input.api === 'postman' ? POSTMAN_LAYER : undefined),
    ),
    code,
    filename: input.filename,
    timeoutMs: input.timeoutMs ?? 0,
    input: {
      phase: input.phase,
      request,
      ...(response !== undefined ? { response } : {}),
      vars: input.vars,
      props: input.props,
      secrets: input.secrets,
      info: { requestName: input.requestName },
    },
  });

  const output = readOutput(result.ok ? result.output : result.output);
  const tests: readonly ScriptTest[] = output !== undefined ? cleanTests(output.tests) : [];
  const values: readonly ScriptValue[] = output?.values ?? [];

  if (!result.ok) {
    return { ok: false, error: failureOf(result.error), tests, values, log: result.log };
  }
  if (output === undefined) {
    return {
      ok: false,
      error: { code: 'script-error', message: 'The script handed back something the engine cannot read' },
      ...empty,
      log: result.log,
    };
  }
  if (input.phase === 'pre') {
    const applied = applyRequestChanges(scripting, request, output.request);
    if (!applied.ok) {
      return { ok: false, error: applied.error, tests, values, log: result.log };
    }
    const written = scripting.views?.writeBack(request, applied.request, types) ?? {
      ok: true as const,
      request: applied.request,
    };
    if (!written.ok) {
      return { ok: false, error: written.error, tests, values, log: result.log };
    }
    return { ok: true, request: written.request, tests, values, log: result.log };
  }
  return { ok: true, tests, values, log: result.log };
}
```

4. Delete `withBody`, `withSoapBody` and `writeSoapBody` (lines 187–230): they are SOAP's `views` now.

`CODE_BY_ERROR_NAME`, `outputSchema`, `Output`, `failureOf`, `readOutput` and `cleanTests` (lines 66–108) do not change.

- [ ] **Step 12: `script/request-scripts.ts` carries an opaque binding and a registry**

1. Lines 6–22 (the imports) become:

```ts
import { createHash } from 'node:crypto';
import { WirebenchError } from '../errors.js';
import type { RequestSnapshotBase, ResponseSnapshotBase } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import type { ScriptChecker, ScriptDiagnostic } from './check/host.js';
import {
  scriptFileName,
  type RequestScripts,
  type ScriptFailure,
  type ScriptOutcome,
  type ScriptPhase,
  type ScriptSource,
} from './model.js';
import { runScript } from './run.js';
import type { ScriptSandbox } from './sandbox/host.js';
import { scriptDeclarations } from './types/api.js';
```

2. `RequestScriptTypes` (lines 24–28) becomes:

```ts
/** The generated half of a request's script types, and what its module needs for typed views. */
export interface RequestScriptTypes {
  readonly generated: string;
  /**
   * Opaque to everything but the module that produced it, which reads it back in its scripting
   * facet's `views` (SOAP: `SoapScriptBinding`).
   */
  readonly binding?: unknown;
}
```

3. `RequestScriptingOptions` (lines 92–98) gains a last field:

```ts
  /** Where a request's protocol is looked up; the built-in registry when absent. */
  readonly registry?: ProtocolRegistry;
```

4. In `ScriptedRequest` (line 102): `readonly protocol: string;`

5. In `diagnostics` (lines 135–138), the `declarations` constant becomes:

```ts
    const declarations =
      request.scripts.api === 'postman'
        ? ''
        : scriptDeclarations(
            request.protocol,
            phase,
            request.scripts.secrets,
            request.types.generated,
            this.options.registry,
          );
```

6. The private `run` method (lines 179–206) becomes:

```ts
  private run(
    request: ScriptedRequest,
    phase: ScriptPhase,
    snapshot: RequestSnapshotBase,
    response: ResponseSnapshotBase | undefined,
    values: ScriptRunValues,
    layer?: string,
  ): Promise<ScriptOutcome> {
    const source = request.scripts[phase];
    if (source === undefined) throw new Error(`No ${phase} script`);
    return runScript({
      sandbox: this.options.sandbox,
      phase,
      api: request.scripts.api,
      source: source.text,
      filename: this.filename(request, phase),
      ...(request.scripts.timeoutMs !== undefined ? { timeoutMs: request.scripts.timeoutMs } : {}),
      request: snapshot,
      ...(response !== undefined ? { response } : {}),
      vars: values.vars,
      props: values.props,
      secrets: values.secrets,
      requestName: request.name,
      ...(layer !== undefined ? { layer } : {}),
      ...(this.options.onSecretValue !== undefined ? { onSecretValue: this.options.onSecretValue } : {}),
      ...(request.types.binding !== undefined ? { binding: request.types.binding } : {}),
      ...(this.options.registry !== undefined ? { registry: this.options.registry } : {}),
    });
  }
```

7. In `pre` (line 215) the parameter is `snapshot: RequestSnapshotBase`; in `post` (lines 227–228) the parameters are `sent: RequestSnapshotBase` and `response: ResponseSnapshotBase`. Their bodies do not change.

- [ ] **Step 13: `run/script-support.ts`: a session takes any protocol's snapshots**

Slice 1 did not edit this file's imports. Three places name the two types: the import, and the two members of `ScriptSession`.

1. Remove the two lines `  RequestSnapshot,` and `  ResponseSnapshot,` from the file's `../script/model.js` type import (lines 11–18; `ScriptLog`, `ScriptOutcome`, `ScriptTest` and `ScriptValue` stay) and add:

```ts
import type { RequestSnapshotBase, ResponseSnapshotBase } from '../protocol/module.js';
```

2. In `ScriptSession`, the two members' types become (their comments stay):

```ts
  readonly pre: <S extends RequestSnapshotBase>(before: S) => Promise<S>;
```

```ts
  readonly post: (sent: RequestSnapshotBase, response: ResponseSnapshotBase) => Promise<SentScripts>;
```

`scriptSession`'s body does not change.

- [ ] **Step 14: Register each facet, and point the protocols' run code at the moved converters**

In `soap/module.ts`, `rest/module.ts` and `grpc/module.ts`, add the import and one property to the object handed to `defineProtocol`:

```ts
import { soapScripting } from './scripting.js';
// …
  scripting: soapScripting,
```

```ts
import { restScripting } from './scripting.js';
// …
  scripting: restScripting,
```

```ts
import { grpcScripting } from './scripting.js';
// …
  scripting: grpcScripting,
```

`ws/module.ts` gets none: a WebSocket request has no scripts.

Then run: `git grep -nE "script/(send|model)\.js" -- packages/engine/src/soap packages/engine/src/rest packages/engine/src/grpc packages/engine/src/run packages/engine/src/protocols.ts`

Rewrite each hit that imports a moved symbol:

| Symbols | Import from |
| --- | --- |
| `soapRequestSnapshot`, `applySoapSnapshot`, `soapResponseSnapshot`, `SoapRequestSnapshot`, `SoapResponseSnapshot` | `soap/scripting.js` (`./scripting.js` inside `soap/`) |
| `restRequestSnapshot`, `applyRestSnapshot`, `restResponseSnapshot`, `RestBodySnapshot`, `RestRequestSnapshot`, `RestResponseSnapshot` | `rest/scripting.js` |
| `grpcRequestSnapshot`, `applyGrpcSnapshot`, `grpcResponseSnapshot`, `GrpcRequestSnapshot`, `GrpcResponseSnapshot` | `grpc/scripting.js` |
| `RequestSnapshot`, `ResponseSnapshot` | `protocols.js` |
| `SecretPlaceholders`, `HeaderPair`, `RequestScripts`, `ScriptPhase` and every other name | unchanged |

The hits are three lines, one in each protocol's `run.ts`, and each becomes an import from the folder's own `./scripting.js` with the same names:

- `soap/run.ts` (Task 1.4): `import { applySoapSnapshot, soapRequestSnapshot, soapResponseSnapshot } from './scripting.js';`
- `rest/run.ts` (Task 1.5): `import { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from './scripting.js';`
- `grpc/run.ts` (Task 1.6): `import { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from './scripting.js';`

`run/run.ts`, `run/context.ts` and `run/send-helpers.ts` also match the grep, for `SecretPlaceholders` from `script/send.js`, which stays where it is: they are not edited. `protocols.ts` has no hit yet; Step 15 gives it the snapshot unions.

Two places build SOAP's script types, and in both the property `soap:` on the returned `RequestScriptTypes` becomes `binding:`, its value unchanged: `scriptTypes` of `soapRun` in `soap/run.ts` (Task 1.4), and `scriptTypesFor` in `run/script-support.ts` (the `case 'soap'` branch), which slice 1 leaves exported until slice 5.

`grpc/scripting.ts` keeps the file-local alias `PreparedGrpc` it brought from `script/send.ts` (Step 7). It is not exported, and it is not the interface `PreparedGrpc` that `grpc/run.ts` exports since Task 1.6; neither file imports the other's.

- [ ] **Step 15: `script/index.ts` re-exports everything under its old name**

The whole file:

```ts
/** Typed scripting (#63): the sandbox, the checker, the API's types and a request's scripts in a send. */
export { createScriptSandbox, clampTimeout, SCRIPT_QUEUE_LIMIT } from './sandbox/host.js';
export type { ScriptSandbox, ScriptSandboxOptions } from './sandbox/host.js';
export { SCRIPT_LIMITS } from './sandbox/model.js';
export type { SandboxLog, ScriptPosition } from './sandbox/model.js';
export { createScriptChecker, CHECK_DEADLINE_MS, ScriptCheckerError } from './check/host.js';
export type {
  ScriptChecker,
  ScriptCheckerOptions,
  ScriptCompletion,
  ScriptDiagnostic,
  ScriptModel,
  ScriptQuickInfo,
  ScriptSignatureHelp,
} from './check/host.js';
export { isScriptFileOf, SCRIPT_OUTPUT_LIMITS, scriptFileName } from './model.js';
export type {
  HeaderPair,
  RequestScripts,
  ScriptApi,
  ScriptErrorCode,
  ScriptFailure,
  ScriptLog,
  ScriptOutcome,
  ScriptPhase,
  ScriptProtocol,
  ScriptSource,
  ScriptTest,
  ScriptValue,
} from './model.js';
export {
  activeScripts,
  assertScriptsUsable,
  RequestScripting,
  scriptError,
  typeCheckError,
} from './request-scripts.js';
export type {
  RequestScriptingOptions,
  RequestScriptTypes,
  ScriptedRequest,
  ScriptRunValues,
} from './request-scripts.js';
export { SecretPlaceholders } from './send.js';
export { scriptProperties } from './props.js';
export { apiDeclarations, apiReference, scriptDeclarations, secretNameType } from './types/api.js';
export type { ApiReferenceSection } from './types/api.js';
export { stripTypes, StripError } from './strip.js';

// What lives in the protocol folders since the scripting facet, under the names it always had.
// These lines are the only place `script/` names a protocol; slice 5 moves them to `index.ts`.
export type { RequestSnapshot, ResponseSnapshot } from '../protocols.js';
export { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from '../rest/scripting.js';
export type { RestRequestSnapshot, RestResponseSnapshot } from '../rest/scripting.js';
export { loadOpenApiDocument, restOperationFor, restScriptTypes } from '../rest/script-types.js';
export { applySoapSnapshot, soapRequestSnapshot, soapResponseSnapshot } from '../soap/scripting.js';
export type { SoapRequestSnapshot, SoapResponseSnapshot } from '../soap/scripting.js';
export {
  projectSoapBody,
  qnameFromClark,
  replaceSoapBody,
  soapOperationElements,
  soapScriptTypes,
} from '../soap/script-types.js';
export { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from '../grpc/scripting.js';
export type { GrpcRequestSnapshot, GrpcResponseSnapshot } from '../grpc/scripting.js';
export { grpcMessageTypes, grpcScriptTypes } from '../grpc/script-types.js';
```

`packages/engine/src/index.ts` needs no edit: line 1663 is `export * from './script/index.js';`, and slice 1 added no export to `index.ts`.

**What `script/` still imports from a protocol folder after this task, all of it:**

| File | Import | Why it stays | Goes in |
| --- | --- | --- | --- |
| `script/index.ts` | the re-exports above | the public names must keep working through slice 4 | slice 5 |
| `script/send.ts` | `type KeyValueEntry` from `../rest/model.js` | `pairsOf` and `entriesOf` are typed by it | slice 4 (`http/entries.ts`, spec §7.3) |
| `script/types/json-schema.ts` | `type JsonSchema` from `../../rest/openapi/model.js` | the JSON Schema model is still REST's | slice 4 (`json/schema/`, spec §7.3) |

Check: `git grep -nE "from '\.\./(\.\./)?(soap|wsdl|xsd|wss|wsa|validate|rest|webhooks|grpc|ws|asyncapi)/" -- packages/engine/src/script` prints those three files and nothing else.

- [ ] **Step 16: The docs generator reads the build output**

`scripts/docs-script-api.ts`:

1. In the header comment, replace the last two sentences (`The source module has only type imports…`) with:

```ts
 * non-zero when the committed page is out of date (this runs as part of `pnpm check`). The
 * reference comes from the engine's registry, so the engine is read from its build output: run
 * `pnpm build` (or `pnpm typecheck`, which emits it) first.
```

2. Line 12 becomes a type-only import, which Node erases:

```ts
import type { ApiReferenceSection } from '../packages/engine/src/script/types/api.ts';
```

3. `main` begins:

```ts
async function main(): Promise<void> {
  // Imported here, not at the top: a test that imports `renderScriptApiReference` needs no build.
  const { apiReference } = await import('../packages/engine/dist/index.js');
  const rendered = renderScriptApiReference(apiReference());
```

Nothing else in the file changes.

- [ ] **Step 17: The desktop's one call site for the binding**

`apps/desktop/src/main/script-host.ts:161`: `soap: {` becomes `binding: {`. The object's three properties (lines 162–164) stay.

That is the only one: `git grep -nE "\bsoap\??: (\{|ScriptRunInput)|types\.soap\b" -- apps packages/cli` prints nothing else that builds or reads script types. `script-host.ts:256` (`scriptDeclarations(located.protocol, …)`) and the type `ScriptProtocol` (lines 41, 83) compile as they are: `scriptDeclarations` takes a `kind`, and `ScriptProtocol` is assignable to `ScriptedRequest.protocol`.

- [ ] **Step 18: Update the tests**

Imports and adapters only; no expected value changes.

`packages/engine/test/unit/script/rules-per-protocol.test.ts`: the imports and `apply` (everything above `const REST`) become:

```ts
import { describe, expect, it } from 'vitest';
import type { GrpcRequestSnapshot } from '../../../src/grpc/scripting.js';
import { defaultRegistry } from '../../../src/protocols.js';
import type { RequestSnapshot } from '../../../src/protocols.js';
import type { RestRequestSnapshot } from '../../../src/rest/scripting.js';
import { applyRequestChanges } from '../../../src/script/apply.js';
import type { ScriptFailure } from '../../../src/script/model.js';
import type { SoapRequestSnapshot } from '../../../src/soap/scripting.js';

type Snapshot = RequestSnapshot;

/** The one place this file calls the rules: with the facet the registry holds for the protocol. */
const apply = (before: Snapshot, returned: unknown) => {
  const scripting = defaultRegistry().find(before.protocol)?.scripting;
  if (scripting === undefined) throw new Error(`The registry has no scripting facet for "${before.protocol}"`);
  return applyRequestChanges(scripting, before, returned);
};
```

`packages/engine/test/unit/script/apply.test.ts`: lines 6–7 become the block below. The two adapters carry the names the file already uses, so no line under them changes.

```ts
import { grpcScripting } from '../../../src/grpc/scripting.js';
import type { GrpcRequestSnapshot } from '../../../src/grpc/scripting.js';
import type { ProtocolScripting } from '../../../src/protocol/module.js';
import { restScripting } from '../../../src/rest/scripting.js';
import type { RestRequestSnapshot } from '../../../src/rest/scripting.js';
import { applyRequestChanges as applyChanges, secretReferencesIn as referencesIn } from '../../../src/script/apply.js';
import { soapScripting } from '../../../src/soap/scripting.js';
import type { SoapRequestSnapshot } from '../../../src/soap/scripting.js';

type Snapshot = RestRequestSnapshot | SoapRequestSnapshot | GrpcRequestSnapshot;
const FACETS = { rest: restScripting, soap: soapScripting, grpc: grpcScripting } as const;
const facetOf = (request: Snapshot): ProtocolScripting => FACETS[request.protocol];
// The rules take the protocol's facet since they became generic; these keep the tests as written.
const applyRequestChanges = (before: Snapshot, returned: unknown) => applyChanges(facetOf(before), before, returned);
const secretReferencesIn = (request: Snapshot) => referencesIn(facetOf(request).inspect(request).texts);
```

`packages/engine/test/unit/script/api.test.ts` lines 7–13 become:

```ts
import type { GrpcRequestSnapshot } from '../../../src/grpc/scripting.js';
import type { RestRequestSnapshot, RestResponseSnapshot } from '../../../src/rest/scripting.js';
import type { ScriptOutcome } from '../../../src/script/model.js';
import type { SoapRequestSnapshot } from '../../../src/soap/scripting.js';
```

`packages/engine/test/unit/script/postman-layer.test.ts` line 7 becomes:

```ts
import type { RestRequestSnapshot, RestResponseSnapshot } from '../../../src/rest/scripting.js';
import type { ScriptOutcome } from '../../../src/script/model.js';
```

`packages/engine/test/unit/script/types-xsd.test.ts`: line 11 becomes `import type { SoapRequestSnapshot } from '../../../src/soap/scripting.js';`, and on lines 184, 207 and 230 `soap: { schemas: set, input: INPUT, output: OUTPUT },` becomes `binding: { schemas: set, input: INPUT, output: OUTPUT },`.

Those five are every test that imports a snapshot type from `script/model.js`. Check: `git grep -nE "Snapshot.* from '.*script/model\.js'" -- packages/engine/test apps/desktop/test packages/cli/test` prints nothing. (The desktop's `send-with-history.ts` takes `SoapRequestSnapshot` from `@wirebench/engine`, which still exports it.)

- [ ] **Step 19: Run the tests**

Run: `nice pnpm exec tsc -b`
Expected: no errors.

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/script/ packages/engine/test/unit/sequence/ packages/engine/test/unit/run/`
Expected: PASS. `rules-per-protocol.test.ts` passes its 27 tests with no assertion edited; `apply.test.ts`, `api.test.ts` and `types-xsd.test.ts` pass with the edits of Step 18 only.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run/scripts.test.ts packages/engine/test/integration/echo-protocol.test.ts`
Expected: PASS.

Run: `nice pnpm vitest run --project desktop apps/desktop/test/script-host.test.ts apps/desktop/test/script-send.test.ts`
Expected: PASS.

Run: `pnpm docs:script-api --check` (after the `tsc -b` above, which emits the engine)
Expected: `docs-site reference/script-api.md is up to date`. This is the byte-for-byte check of spec §5.5; if it fails, the facets' `reference()` or `apiReference`'s order is wrong, and the page is not to be regenerated.

- [ ] **Step 20: Commit**

```bash
pnpm exec prettier --write packages/engine/src packages/engine/test/unit/script scripts/docs-script-api.ts apps/desktop/src/main/script-host.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages/engine scripts/docs-script-api.ts apps/desktop/src/main/script-host.ts
git commit -m "refactor(engine): scripting is a facet of the protocol module, and the script rules are generic (#184)" -m "The rules of ADR-0016 are applied to what a module's inspect() describes, in one order for every protocol. A destination with no host must now stay identical, which is what keeps a gRPC host:port target from changing its port under a rule written for URLs."
```

---

### Task 2.3: `assert/` stops importing gRPC's status names to evaluate a status

**Files:**
- Modify: `packages/engine/src/assert/model.ts` (`AssertionSubject`, new `StatusNames`)
- Rewrite: `packages/engine/src/assert/status.ts`
- Modify: `packages/engine/src/grpc/status.ts` (new `grpcStatusNames`), `packages/engine/src/grpc/run.ts` (`grpcSubject`)
- Modify: `packages/engine/src/index.ts` (export `StatusNames` and `grpcStatusNames`)
- Test: `packages/engine/test/unit/assert/status.test.ts`, `packages/engine/test/unit/run/grpc-subject.test.ts`
- Modify (a cast that is no longer needed): `packages/engine/test/helpers/echo-protocol.ts`

`assert/schema.ts:2` also imports `GRPC_STATUS_NAMES`, for the request file's schema (`z.enum` of the seventeen names, pinned by `test/unit/assert/schema.test.ts:30–34`). A subject cannot serve a file schema, so spec §3.5 does not reach it and this task leaves it. So after this task `assert/status.ts` imports no protocol, and `assert/schema.ts` still does: it is the one import of a protocol that `assert/` keeps. Spec revision R12 rules on it: Task 4.6 moves the table to `assert/status-names.ts`, `grpc/status.ts` imports it from there, and `assert/schema.ts` follows then.

**Interfaces:**
- Consumes: `GRPC_STATUS_NAMES`, `grpcStatusName` (`grpc/status.ts`); `grpcSubject(result: GrpcCallResult): AssertionSubject` (in `grpc/run.ts` since slice 1).
- Produces:
  - `interface StatusNames { readonly byName: ReadonlyMap<string, number>; nameOf(code: number): string }` (`assert/model.ts`)
  - `AssertionSubject.protocol: string`; `AssertionSubject.statusNames?: StatusNames`
  - `const grpcStatusNames: StatusNames` (`grpc/status.ts`)
  - `evaluateStatus(subject: AssertionSubject, assertion: StatusAssertion): AssertionResult`, same signature, no protocol import

- [ ] **Step 1: Change the tests first**

`packages/engine/test/unit/assert/status.test.ts`: add the import and give the gRPC subject its names (lines 1–12 become):

```ts
import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';
import { grpcStatusNames } from '../../../src/grpc/status.js';

const grpcSubject = (over: Partial<AssertionSubject> = {}): AssertionSubject => ({
  protocol: 'grpc',
  status: 0,
  durationMs: 120,
  bodyText: '{}',
  bodyKind: 'json',
  statusNames: grpcStatusNames,
  ...over,
});
```

Append to the same file:

```ts
describe('status names come from the subject, whatever its protocol', () => {
  const subject: AssertionSubject = {
    protocol: 'echo',
    status: 2,
    durationMs: 1,
    bodyText: '',
    bodyKind: 'other',
    statusNames: {
      byName: new Map([
        ['READY', 1],
        ['BUSY', 2],
      ]),
      nameOf: (code) => (code === 1 ? 'READY' : code === 2 ? 'BUSY' : `UNKNOWN (${String(code)})`),
    },
  };

  it('passes by name and by exact code', async () => {
    const [byName, byCode] = await evaluateAssertions(subject, [
      { type: 'status', equals: 'BUSY' },
      { type: 'status', equals: 2 },
    ]);
    expect(byName?.outcome).toBe('passed');
    expect(byCode?.outcome).toBe('passed');
  });

  it('fails with the name of the status it got', async () => {
    const [failed] = await evaluateAssertions(subject, [{ type: 'status', equals: 'READY' }]);
    expect(failed).toMatchObject({ outcome: 'failed', expected: 'READY', actual: 'BUSY' });
  });

  it('errors on a name the subject does not have, and on an HTTP class', async () => {
    const [unknown, httpClass] = await evaluateAssertions(subject, [
      { type: 'status', equals: 'NOT_FOUND' },
      { type: 'status', equals: '2xx' },
    ]);
    expect(unknown?.outcome).toBe('errored');
    expect(httpClass?.outcome).toBe('errored');
  });

  it('a subject without names gets the HTTP rules, whatever it calls its protocol', async () => {
    const bare: AssertionSubject = { protocol: 'grpc', status: 5, durationMs: 1, bodyText: '', bodyKind: 'other' };
    const [low] = await evaluateAssertions(bare, [{ type: 'status', equals: 5 }]);
    expect(low).toMatchObject({ outcome: 'errored', message: '5 is not an HTTP status' });
  });
});
```

`packages/engine/test/unit/run/grpc-subject.test.ts`: add `import { grpcStatusNames } from '../../../src/grpc/status.js';`, and in the expected object of `'reads a decoded message as JSON'` (lines 32–43) add a last property `statusNames: grpcStatusNames,`. Its import of `grpcSubject` (line 10, from `'../../../src/run/run.js'`) stays: slice 1 did not edit this file, and `run/run.ts` still re-exports the function from `grpc/run.ts` until slice 5.

- [ ] **Step 2: Run them to see them fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/assert/status.test.ts packages/engine/test/unit/run/grpc-subject.test.ts`
Expected: FAIL. `grpcStatusNames` does not exist yet, so both files fail to load.

- [ ] **Step 3: `assert/model.ts`**

Before `AssertionSubject`, add:

```ts
/** A protocol's status codes by name, for a subject whose statuses have names (gRPC's `NOT_FOUND`). */
export interface StatusNames {
  readonly byName: ReadonlyMap<string, number>;
  /** The name of a code, including one the protocol does not define. */
  nameOf(code: number): string;
}
```

In `AssertionSubject`, the `protocol` line becomes:

```ts
  /** The `kind` of the protocol module that built the subject. */
  readonly protocol: string;
```

and after `headers` add:

```ts
  /**
   * Set when the protocol's statuses have names. A status assertion then accepts a name and
   * compares codes exactly; without it the HTTP rules apply (a number, or an `Nxx` class).
   */
  readonly statusNames?: StatusNames;
```

- [ ] **Step 4: Rewrite `assert/status.ts`**

The whole file:

```ts
import type { AssertionResult, AssertionSubject, StatusAssertion } from './model.js';

/** The shape of a status name (`NOT_FOUND`), as opposed to an `Nxx` class. */
const STATUS_NAME = /^[A-Z][A-Z_]*$/;

function holdsHttp(expected: number | string, status: number): boolean {
  return typeof expected === 'number' ? expected === status : Number(expected[0]) === Math.floor(status / 100);
}

/**
 * Checks the response status against one or more expected values. A subject that carries
 * `statusNames` is compared by exact code or by name; any other by HTTP code or `Nxx` class.
 */
export function evaluateStatus(subject: AssertionSubject, assertion: StatusAssertion): AssertionResult {
  const expected: readonly (number | string)[] =
    typeof assertion.equals === 'number' || typeof assertion.equals === 'string'
      ? [assertion.equals]
      : assertion.equals;
  const text = expected.join(' or ');
  const base = { type: 'status' as const, label: assertion.name ?? `status is ${text}` };

  const names = subject.statusNames;
  if (names !== undefined) {
    const unknownName = expected.find((value) => typeof value === 'string' && !names.byName.has(value));
    if (unknownName !== undefined) {
      return { ...base, outcome: 'errored', message: `${String(unknownName)} is not a gRPC status name` };
    }
    const matched = expected.some((value) =>
      typeof value === 'number' ? value === subject.status : names.byName.get(value) === subject.status,
    );
    return matched
      ? { ...base, outcome: 'passed' }
      : { ...base, outcome: 'failed', expected: text, actual: names.nameOf(subject.status) };
  }

  const statusName = expected.find((value) => typeof value === 'string' && STATUS_NAME.test(value));
  if (statusName !== undefined) {
    return { ...base, outcome: 'errored', message: `${String(statusName)} is a gRPC status name, not an HTTP one` };
  }
  const notHttp = expected.find((value) => typeof value === 'number' && value < 100);
  if (notHttp !== undefined) {
    return { ...base, outcome: 'errored', message: `${String(notHttp)} is not an HTTP status` };
  }
  return expected.some((value) => holdsHttp(value, subject.status))
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected: text, actual: String(subject.status) };
}
```

For every value a request file can hold (`assert/schema.ts:8–13`: an HTTP code, 0 to 16, an `Nxx` class, one of the seventeen names, or a list of them) this returns what today's code returns, outcome, `expected`, `actual` and message. The two messages keep the word gRPC because they are today's text; the file no longer imports it. One input outside what a file can hold differs: on an HTTP subject an all-capitals word that is not a status name (`'NOPE'`) now errors where it failed, because without the list every name-shaped string is a name.

- [ ] **Step 5: gRPC supplies its names**

`packages/engine/src/grpc/status.ts`: add the import at the top and the constant after `grpcStatusName`:

```ts
import type { StatusNames } from '../assert/model.js';
```

```ts
/** The status codes by name and back, as a gRPC answer's assertion subject carries them (spec §3.5). */
export const grpcStatusNames: StatusNames = Object.freeze({
  byName: new Map(Object.entries(GRPC_STATUS_NAMES).map(([code, name]) => [name, Number(code)])),
  nameOf: grpcStatusName,
});
```

`packages/engine/src/grpc/run.ts`, in `grpcSubject`: add `import { grpcStatusNames } from './status.js';` and a last property to the returned object, after `headers`:

```ts
    statusNames: grpcStatusNames,
```

`packages/engine/src/index.ts`: add `StatusNames` to the `export type { … } from './assert/model.js';` list at lines 2–19, after `AssertionSubject` (line 6), and `grpcStatusNames` to the export list from `./grpc/status.js` that holds `GRPC_STATUS_NAMES` (line 1147).

`packages/engine/test/helpers/echo-protocol.ts` (Task 1.8): `AssertionSubject.protocol` is a `string` now, so in `echoSubject` the two lines

```ts
    // `AssertionSubject.protocol` is a closed union until Task 2.3 of the protocol modules plan widens it.
    protocol: 'echo' as AssertionSubject['protocol'],
```

become one:

```ts
    protocol: 'echo',
```

The file still imports the type `AssertionSubject`, for `echoSubject`'s return type.

- [ ] **Step 6: Run the tests**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/assert/ packages/engine/test/unit/run/grpc-subject.test.ts packages/engine/test/unit/sequence/`
Expected: PASS.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run/run-grpc.test.ts`
Expected: PASS, with no change to the file: its status assertions by name go through `grpcSubject`.

Run: `git grep -n "grpc/" -- packages/engine/src/assert`
Expected: one line, `assert/schema.ts:2`.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write packages/engine/src/assert/model.ts packages/engine/src/assert/status.ts packages/engine/src/grpc/status.ts packages/engine/src/grpc/run.ts packages/engine/src/index.ts packages/engine/test/unit/assert/status.test.ts packages/engine/test/unit/run/grpc-subject.test.ts packages/engine/test/helpers/echo-protocol.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/assert/model.ts packages/engine/src/assert/status.ts packages/engine/src/grpc/status.ts packages/engine/src/grpc/run.ts packages/engine/src/index.ts packages/engine/test/unit/assert/status.test.ts packages/engine/test/unit/run/grpc-subject.test.ts packages/engine/test/helpers/echo-protocol.ts
git commit -m "refactor(engine): a status assertion takes its status names from the subject (#184)"
```

---

### Task 2.4: The `scripts` feature is enforced, the API reference is pinned, and `echo` gets scripts

**Files:**
- Modify: `packages/engine/src/run/run.ts` (`createRunSender`, `checkRunScripts`, new `scriptsRefusal`)
- Modify: `packages/engine/test/helpers/echo-protocol.ts` (`echoScripting`, the scripted `send`)
- Test: `packages/engine/test/integration/echo-protocol-scripts.test.ts` (new), `packages/engine/test/integration/run/scripts-feature.test.ts` (new), `scripts/docs-script-api.test.ts` (new)

The echo script tests go in a file of their own, not into slice 1's `echo-protocol.test.ts`: that file's helpers are slice 1's to name, and a second file cannot clash with them.

**Interfaces:**
- Consumes:
  - Slice 1: `createRunSender`, `checkRunScripts`, `runRequests` (`run/run.ts`); `RunContext` with `registry?` (`run/context.ts`); `selectRequests(project, selectors, registry?)`; `createProtocolRegistry`, `featureDisabled(features: FeatureSet, id: string): WirebenchError` (`protocol/registry.ts`); `defineProtocol`, `ProtocolRun`, `RunScope`, `ScriptedSend`, `SelectedBase` (`protocol/module.ts`); `BUILTIN_PROTOCOLS`, `SCRIPTS_FEATURE`, `createBuiltinRegistry`, `defaultRegistry` (`protocols.ts`); and from `test/helpers/echo-protocol.ts` (Task 1.8, all exported): `EchoRequest`, `EchoApi`, `EchoSelected`, `echoRun`, `echoProtocol`, `echoApi`, `echoRequest`, `withEchoApis`.
  - Task 2.2b: `ProtocolScripting`, `RequestScriptingOptions.registry`, `apiReference(registry?)`, `ScriptSession.pre`/`post` over base snapshots.
- Produces:
  - `run/run.ts`: a request with active scripts is refused before anything is prepared or sent, with `feature-disabled` (`details.feature: 'scripts'`) when the `scripts` feature is off, and with `script-unsupported` (`details: { path, protocol }`) when its module has no scripting facet. `checkRunScripts` returns the same error for the request.
  - `test/helpers/echo-protocol.ts`: `interface EchoRequestSnapshot { readonly protocol: 'echo'; readonly text: string }`, `interface EchoResponseSnapshot { readonly protocol: 'echo'; readonly text: string; readonly durationMs: number }`, `echoScripting: ProtocolScripting<EchoRequestSnapshot, EchoResponseSnapshot>`; `echoProtocol` registered with it.

- [ ] **Step 1: Give the echo helper a scripting facet**

In `packages/engine/test/helpers/echo-protocol.ts`, the import block Task 1.8 wrote gains three things: `zod`, two more types from `protocol/module.js` on the line that already imports `ProtocolRun`, and `SentRequest`. The block is then exactly:

```ts
import { z } from 'zod';
import type { Assertion, AssertionSubject } from '../../src/assert/model.js';
import { extraContainersOf } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { expand } from '../../src/project/properties.js';
import { defineProtocol } from '../../src/protocol/module.js';
import type { ProtocolRun, ProtocolScripting, RunScope } from '../../src/protocol/module.js';
import { scopesFor } from '../../src/run/context.js';
import type { SentRequest } from '../../src/run/run.js';
import { unresolvedError, withSecrets } from '../../src/run/send-helpers.js';
import type { RequestScripts } from '../../src/script/model.js';
```

Add, before `echoRun`:

```ts
/** An echo request as a script sees it. */
export interface EchoRequestSnapshot {
  readonly protocol: 'echo';
  readonly text: string;
}

/** An echo as a script sees it. */
export interface EchoResponseSnapshot {
  readonly protocol: 'echo';
  readonly text: string;
  readonly durationMs: number;
}

const ECHO_PRE = `
declare const request: { text: string };
`;

const ECHO_POST = `
declare const request: { readonly text: string };
declare const response: { readonly text: string; readonly durationMs: number };
`;

/** Runs inside the common prelude's closure: `input`, `define`, `state` and `deepFreeze` are its. */
const ECHO_PRELUDE = String.raw`
const echoRequest = (snapshot, writable) => {
  const data = { text: snapshot.text };
  const request = Object.freeze({
    get text() { return data.text; },
    set text(value) {
      if (!writable) throw new TypeError('The text of a sent request cannot be changed');
      data.text = String(value);
    },
  });
  const snapshotOf = () => ({ protocol: 'echo', text: data.text });
  return { request, snapshotOf };
};

if (input.phase === 'pre') {
  const built = echoRequest(input.request, true);
  define('request', built.request);
  state.request = built.snapshotOf;
} else {
  define('request', echoRequest(input.request, false).request);
  define('response', deepFreeze({ text: input.response.text, durationMs: input.response.durationMs }));
}
`;

/** Echo's scripting facet: one text, which is also every place a secret reference could be. */
export const echoScripting: ProtocolScripting<EchoRequestSnapshot, EchoResponseSnapshot> = {
  declarations: (phase) => (phase === 'pre' ? ECHO_PRE : ECHO_POST),
  reference: () => [
    { title: 'Echo: pre-request', declarations: ECHO_PRE },
    { title: 'Echo: post-response', declarations: ECHO_POST },
  ],
  prelude: () => ECHO_PRELUDE,
  requestSchema: z.object({ protocol: z.literal('echo'), text: z.string() }),
  inspect: (snapshot) => ({ destination: '', fixed: null, pairs: [], lines: [], texts: [snapshot.text] }),
};
```

- [ ] **Step 2: Run the scripts around the echo**

In the same file:

1. The body of `echoRun.send` as Task 1.8 wrote it becomes a module-level function, above `echoRun`, with no statement changed:

```ts
/** One echo without scripts: what `send` was before it ran scripts. */
async function echoPlain(selected: EchoSelected, scope: RunScope): Promise<SentRequest> {
  const { context } = scope;
  const { text } = selected.request;
  const scopes = await withSecrets(text, scopesFor(context), context.getSecret);
  const expanded = expand(text, scopes);
  if (expanded.unresolved.length > 0) {
    throw unresolvedError(selected.path, expanded.unresolved);
  }
  const raw = bytes(expanded.text);
  return { subject: echoSubject(expanded.text), raw: { rawRequest: raw, rawResponse: raw } };
}
```

2. `echoRun.send` becomes:

```ts
  async send(selected, scope, scripts) {
    if (scripts === undefined) return echoPlain(selected, scope);
    // Every `${secret:…}` goes behind a placeholder before the script sees the text, and comes back
    // as its value after it, as the built-in protocols do it.
    const hidden = selected.request.text.replace(/\$\{secret:([^}]+)\}/g, (_whole, name: string) =>
      scripts.placeholders.placeholderFor(name),
    );
    const before: EchoRequestSnapshot = { protocol: 'echo', text: hidden };
    const sent = await scripts.session.pre(before);
    const restored = await scripts.placeholders.restore({ text: sent.text }, scope.context.getSecret);
    const echoed = await echoPlain({ ...selected, request: { ...selected.request, text: restored.text } }, scope);
    const response: EchoResponseSnapshot = {
      protocol: 'echo',
      text: echoed.subject.bodyText,
      durationMs: echoed.subject.durationMs,
    };
    return { ...echoed, script: await scripts.session.post(sent, response) };
  },
```

3. `echoProtocol` gains the facet. The declaration becomes:

```ts
/** The echo protocol, to register beside the built-in ones. */
export const echoProtocol = defineProtocol({
  kind: 'echo',
  feature: { id: 'echo', title: 'Echo', default: true, stage: 'experimental', requires: [] },
  run: echoRun,
  scripting: echoScripting,
});
```

- [ ] **Step 3: Write the echo script tests**

```ts
// packages/engine/test/integration/echo-protocol-scripts.test.ts
/**
 * A fifth protocol runs scripts (spec §10): the test-only `echo` module has a scripting facet, and
 * the sandbox, the checker, the rules and the run go through it without a line of core naming it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { createProtocolRegistry } from '../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../src/protocols.js';
import type { RunContext } from '../../src/run/context.js';
import { runRequests } from '../../src/run/run.js';
import { selectRequests } from '../../src/run/select.js';
import { createScriptChecker } from '../../src/script/check/host.js';
import type { RequestScripts } from '../../src/script/model.js';
import { RequestScripting } from '../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../src/script/sandbox/host.js';
import { apiReference } from '../../src/script/types/api.js';
import { echoProtocol } from '../helpers/echo-protocol.js';
import type { EchoApi, EchoRequest } from '../helpers/echo-protocol.js';

const API_KEY = 'abc123def456ghi789';

const sandbox = createScriptSandbox();
const checker = createScriptChecker();
const dir = mkdtempSync(join(tmpdir(), 'wb-echo-scripts-'));
const registry = createProtocolRegistry([...BUILTIN_PROTOCOLS, echoProtocol], { features: [SCRIPTS_FEATURE] });

afterAll(async () => {
  await sandbox.dispose();
  await checker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const scripts = (extra: Partial<RequestScripts>): RequestScripts => ({
  api: 'wirebench',
  enabled: true,
  secrets: [],
  ...extra,
});

function project(requests: readonly EchoRequest[]): Project {
  const api: EchoApi = { kind: 'echo', id: 'echo-1', name: 'Echo', slug: 'echo', order: 0, requests };
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-echo-scripts',
    name: 'Echo scripts',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [],
    apis: [],
    grpcApis: [],
    wsApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
    sequences: [],
    extraContainers: { echo: [api] },
  } as unknown as Project;
}

async function run(requests: readonly EchoRequest[]) {
  const p = project(requests);
  const context: RunContext = {
    project: p,
    projectDir: dir,
    overrides: {},
    getSecret: (ref) => Promise.resolve(ref.replace(/^secret:/, '') === 'api_key' ? API_KEY : undefined),
    scripting: new RequestScripting({ sandbox, checker, registry }),
    registry,
  };
  const { selected } = selectRequests(p, [], registry);
  return runRequests(selected, context);
}

describe('an echo request with scripts', () => {
  it('sends the text its pre-request script rewrote, and records its post-response test', { timeout: 30_000 }, async () => {
    const result = await run([
      {
        id: 'echo-ping',
        name: 'Ping',
        slug: 'ping',
        text: 'ping',
        scripts: scripts({
          pre: { text: "request.text = request.text + ' and back';\n" },
          post: { text: "test('echoed', () => expect(response.text).toBe('ping and back'));\n" },
        }),
      },
    ]);
    expect(result.requests[0]).toMatchObject({
      protocol: 'echo',
      outcome: 'passed',
      assertions: [{ type: 'script', label: 'echoed', outcome: 'passed' }],
    });
  });

  it('shows the script a placeholder for a secret, and sends the value', { timeout: 30_000 }, async () => {
    const result = await run([
      {
        id: 'echo-key',
        name: 'Key',
        slug: 'key',
        text: 'key=${secret:api_key}',
        scripts: scripts({
          pre: { text: 'log(request.text);\n' },
          post: { text: `test('restored', () => expect(response.text).toBe('key=${API_KEY}'));\n` },
        }),
      },
    ]);
    const key = result.requests[0];
    expect(key).toMatchObject({ outcome: 'passed', assertions: [{ label: 'restored', outcome: 'passed' }] });
    expect(key?.scriptLog?.[0]).toMatch(/^key=wbsec[0-9a-f]+n0z$/);
  });

  it('is held to the rules through its own inspect: a new secret reference is refused', { timeout: 30_000 }, async () => {
    const result = await run([
      {
        id: 'echo-steal',
        name: 'Steal',
        slug: 'steal',
        text: 'ping',
        scripts: scripts({ pre: { text: "request.text = '${secret:other}';\n" } }),
      },
    ]);
    expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'script-secret-denied' } });
  });

  it('is type-checked against its own declarations', { timeout: 30_000 }, async () => {
    const result = await run([
      {
        id: 'echo-typo',
        name: 'Typo',
        slug: 'typo',
        text: 'ping',
        scripts: scripts({ post: { text: 'log(response.txt);\n' } }),
      },
    ]);
    expect(result.requests[0]).toMatchObject({
      outcome: 'errored',
      error: { code: 'script-type-error', message: expect.stringContaining('typo.post.ts:1:') as unknown },
    });
  });
});

describe('the script API reference of a registry with a fifth protocol', () => {
  it('lists its sections, ordered by title', () => {
    expect(apiReference(registry).map((section) => section.title)).toEqual([
      'Every script',
      'Echo: pre-request',
      'Echo: post-response',
      'REST: shared by both phases',
      'REST: pre-request',
      'REST: post-response',
      'SOAP: pre-request',
      'SOAP: post-response',
      'gRPC: pre-request',
      'gRPC: post-response',
    ]);
  });
});
```

- [ ] **Step 4: Write the feature tests**

```ts
// packages/engine/test/integration/run/scripts-feature.test.ts
/**
 * The `scripts` feature in a run (spec §5.3, §9): a request with active scripts is refused, not
 * sent, when the feature is off or its protocol has no scripting facet; a request whose own scripts
 * are switched off is sent either way.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_SETTINGS, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { defineProtocol } from '../../../src/protocol/module.js';
import type { ProtocolModule, ProtocolRun } from '../../../src/protocol/module.js';
import { createProtocolRegistry } from '../../../src/protocol/registry.js';
import type { ProtocolRegistry } from '../../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../../src/protocols.js';
import type { RunContext } from '../../../src/run/context.js';
import { checkRunScripts, runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { echoProtocol, echoRun, echoScripting } from '../../helpers/echo-protocol.js';
import type { EchoApi, EchoRequest, EchoSelected } from '../../helpers/echo-protocol.js';

const sandbox = createScriptSandbox();
const dir = mkdtempSync(join(tmpdir(), 'wb-scripts-feature-'));

afterAll(async () => {
  await sandbox.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** How many requests reached the protocol's `send`. */
let sends = 0;
beforeEach(() => {
  sends = 0;
});

const counted: ProtocolRun<EchoSelected> = {
  ...echoRun,
  send: (selected, scope, scripted) => {
    sends += 1;
    return echoRun.send(selected, scope, scripted);
  },
};
const scriptable = defineProtocol({ kind: 'echo', feature: echoProtocol.feature, run: counted, scripting: echoScripting });
const scriptless = defineProtocol({ kind: 'echo', feature: echoProtocol.feature, run: counted });

const registryOf = (echo: ProtocolModule, switches: Readonly<Record<string, boolean>> = {}): ProtocolRegistry =>
  createProtocolRegistry([...BUILTIN_PROTOCOLS, echo], { features: [SCRIPTS_FEATURE], switches });

const ACTIVE: RequestScripts = {
  api: 'wirebench',
  enabled: true,
  secrets: [],
  post: { text: "test('ran', () => expect(response.text).toBe('ping'));\n" },
};
const SWITCHED_OFF: RequestScripts = { ...ACTIVE, enabled: false };

function project(scripts: RequestScripts | undefined): Project {
  const request: EchoRequest = {
    id: 'echo-ping',
    name: 'Ping',
    slug: 'ping',
    text: 'ping',
    ...(scripts !== undefined ? { scripts } : {}),
  };
  const api: EchoApi = { kind: 'echo', id: 'echo-1', name: 'Echo', slug: 'echo', order: 0, requests: [request] };
  return {
    formatVersion: FORMAT_VERSION,
    id: 'proj-scripts-feature',
    name: 'Scripts feature',
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [],
    apis: [],
    grpcApis: [],
    wsApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
    sequences: [],
    extraContainers: { echo: [api] },
  } as unknown as Project;
}

function setup(scripts: RequestScripts | undefined, registry: ProtocolRegistry) {
  const p = project(scripts);
  const context: RunContext = {
    project: p,
    projectDir: dir,
    overrides: {},
    getSecret: () => Promise.resolve(undefined),
    // No checker: these tests are about what is refused before a script is looked at.
    scripting: new RequestScripting({ sandbox, registry }),
    registry,
  };
  return { selected: selectRequests(p, [], registry).selected, context };
}

async function run(scripts: RequestScripts | undefined, registry: ProtocolRegistry) {
  const { selected, context } = setup(scripts, registry);
  return (await runRequests(selected, context)).requests[0];
}

describe('the scripts feature in a run', () => {
  it('on: a request with active scripts runs them', { timeout: 30_000 }, async () => {
    const result = await run(ACTIVE, registryOf(scriptable));
    expect(result).toMatchObject({ outcome: 'passed', assertions: [{ label: 'ran', outcome: 'passed' }] });
    expect(result?.scriptsOff).toBeUndefined();
    expect(sends).toBe(1);
  });

  it('off: a request with active scripts errors with feature-disabled and is not sent', async () => {
    const result = await run(ACTIVE, registryOf(scriptable, { scripts: false }));
    expect(result).toMatchObject({
      outcome: 'errored',
      error: { code: 'feature-disabled', details: { feature: 'scripts' } },
    });
    expect(sends).toBe(0);
  });

  it('off: a request whose own scripts are switched off is sent, and says so', async () => {
    const result = await run(SWITCHED_OFF, registryOf(scriptable, { scripts: false }));
    expect(result).toMatchObject({ outcome: 'passed', scriptsOff: true });
    expect(sends).toBe(1);
  });

  it('off: a request with no scripts is sent', async () => {
    const result = await run(undefined, registryOf(scriptable, { scripts: false }));
    expect(result).toMatchObject({ outcome: 'passed' });
    expect(result?.scriptsOff).toBeUndefined();
    expect(sends).toBe(1);
  });

  it('on: a request whose own scripts are switched off is sent without them, and says so', async () => {
    const result = await run(SWITCHED_OFF, registryOf(scriptable));
    expect(result).toMatchObject({ outcome: 'passed', scriptsOff: true, assertions: [] });
    expect(sends).toBe(1);
  });
});

describe('a protocol with no scripting facet', () => {
  it('refuses a request with active scripts with script-unsupported, and does not send it', async () => {
    const result = await run(ACTIVE, registryOf(scriptless));
    expect(result).toMatchObject({
      outcome: 'errored',
      error: { code: 'script-unsupported', details: { path: 'Echo/Ping', protocol: 'echo' } },
    });
    expect(sends).toBe(0);
  });

  it('sends a request whose scripts are switched off', async () => {
    const result = await run(SWITCHED_OFF, registryOf(scriptless));
    expect(result).toMatchObject({ outcome: 'passed', scriptsOff: true });
    expect(sends).toBe(1);
  });
});

describe('checkRunScripts', () => {
  it('reports feature-disabled for a request with active scripts when the feature is off', async () => {
    const { selected, context } = setup(ACTIVE, registryOf(scriptable, { scripts: false }));
    const errors = await checkRunScripts(selected, context);
    expect(errors.map((error) => error.code)).toEqual(['feature-disabled']);
  });

  it('reports script-unsupported for a protocol with no scripting facet', async () => {
    const { selected, context } = setup(ACTIVE, registryOf(scriptless));
    const errors = await checkRunScripts(selected, context);
    expect(errors.map((error) => error.code)).toEqual(['script-unsupported']);
  });

  it('reports nothing for switched-off scripts, or when the feature is on', async () => {
    const off = setup(SWITCHED_OFF, registryOf(scriptable, { scripts: false }));
    expect(await checkRunScripts(off.selected, off.context)).toEqual([]);
    const on = setup(ACTIVE, registryOf(scriptable));
    expect(await checkRunScripts(on.selected, on.context)).toEqual([]);
  });
});
```

- [ ] **Step 5: Write the reference pin**

```ts
// scripts/docs-script-api.test.ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../packages/engine/src/protocols.js';
import { apiReference } from '../packages/engine/src/script/types/api.js';
import { renderScriptApiReference } from './docs-script-api.ts';

const target = fileURLToPath(new URL('../docs-site/src/content/docs/reference/script-api.md', import.meta.url));

describe('docs-site reference/script-api.md', () => {
  it('is generated from the registry, byte for byte', async () => {
    const committed = await readFile(target, 'utf-8');
    expect(renderScriptApiReference(apiReference(createBuiltinRegistry()))).toBe(committed);
  });

  it('has a section for every built-in protocol with a scripting facet, in the order of the page', () => {
    expect(apiReference(createBuiltinRegistry()).map((section) => section.title)).toEqual([
      'Every script',
      'REST: shared by both phases',
      'REST: pre-request',
      'REST: post-response',
      'SOAP: pre-request',
      'SOAP: post-response',
      'gRPC: pre-request',
      'gRPC: post-response',
    ]);
  });

  it('leaves out a protocol that is switched off', () => {
    const titles = apiReference(createBuiltinRegistry({ grpc: false })).map((section) => section.title);
    expect(titles).not.toContain('gRPC: pre-request');
    expect(titles).toContain('SOAP: pre-request');
  });
});
```

- [ ] **Step 6: Run the tests to see what fails**

Run: `nice pnpm vitest run --project scripts scripts/docs-script-api.test.ts`
Expected: PASS already. This test pins what Task 2.2b did; it guards every later change to a facet's declarations.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/echo-protocol-scripts.test.ts packages/engine/test/integration/echo-protocol.test.ts`
Expected: PASS. The helper's facet from Steps 1 and 2 is all the echo tests need.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run/scripts-feature.test.ts`
Expected: FAIL in four tests. `off: a request with active scripts…` passes with its script run and `sends` at 1; `refuses a request with active scripts with script-unsupported` errors with another code; and the first two `checkRunScripts` tests get `[]` or another code.

- [ ] **Step 7: Enforce the feature in `run/run.ts`**

1. Add one import. Task 1.7 already gave the file `SelectedBase`, `ProtocolRegistry` and `defaultRegistry`; the line below goes directly above its `import type { ProtocolRegistry } from '../protocol/registry.js';`:

```ts
import { featureDisabled } from '../protocol/registry.js';
```

2. Add above `createRunSender`:

```ts
/**
 * Why a request's active scripts cannot run in this registry, as the error its send reports (spec
 * §5.3, §9): the `scripts` feature is off, or the request's protocol has no scripting facet.
 * Undefined when they can run.
 */
function scriptsRefusal(item: SelectedBase, registry: ProtocolRegistry): WirebenchError | undefined {
  if (!registry.features.isEnabled('scripts')) {
    return featureDisabled(registry.features, 'scripts');
  }
  if (registry.find(item.kind)?.scripting === undefined) {
    return new WirebenchError('script-unsupported', `"${item.path}" has scripts, and ${item.kind} requests cannot have them`, {
      details: { path: item.path, protocol: item.kind },
    });
  }
  return undefined;
}
```

3. In the function `createRunSender` returns, Task 1.7 wrote the unscripted send as an early return and the scripted one after it. Insert the refusal between the two, so that this part of the function reads (the first and last statements are Task 1.7's, the two in the middle are new; `registry` is the constant `createRunSender` already has):

```ts
    const scripts = activeScripts(item.request.scripts);
    if (scripts === undefined) {
      const sent = await run.send(item, itemScope);
      return item.request.scripts !== undefined ? { ...sent, scriptsOff: true } : sent;
    }

    const refused = scriptsRefusal(item, registry);
    if (refused !== undefined) throw refused;

    const scripting = context.scripting;
```

Nothing after it changes: the `script-unavailable` check, `run.scriptTypes`, `scripting.check`, the deferred session and `run.send(item, itemScope, { session, placeholders })` stay in Task 1.7's order. The early return for a request without active scripts keeps marking `scriptsOff` when `item.request.scripts !== undefined`.

4. In `checkRunScripts`, in the loop, directly after the line that skips a request without active scripts (`if (scripts === undefined) continue;`), insert (`registry` is the constant Task 1.7 declares above the loop):

```ts
    const refused = scriptsRefusal(item, registry);
    if (refused !== undefined) {
      errors.push(refused);
      continue;
    }
```

`checkRunScripts` still returns no errors at all for a run with no script host (`context.scripting === undefined`), as today: such a run refuses each scripted request when it sends it.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run/ packages/engine/test/integration/echo-protocol.test.ts packages/engine/test/integration/echo-protocol-scripts.test.ts`
Expected: PASS, the new files and every existing one (`scripts.test.ts` unchanged: the built-in registry has `scripts` on).

Run: `nice pnpm vitest run --project scripts scripts/docs-script-api.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm exec prettier --write packages/engine/src/run/run.ts packages/engine/test/helpers/echo-protocol.ts packages/engine/test/integration/echo-protocol-scripts.test.ts packages/engine/test/integration/run/scripts-feature.test.ts scripts/docs-script-api.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/run/run.ts packages/engine/test/helpers/echo-protocol.ts packages/engine/test/integration/echo-protocol-scripts.test.ts packages/engine/test/integration/run/scripts-feature.test.ts scripts/docs-script-api.test.ts
git commit -m "feat(engine): the scripts feature is enforced in a run, and a fifth protocol runs scripts (#184)"
```

Before pushing the slice: `nice pnpm test:perf`.

---

## Slice 3 — The storage facet and placeholders

Spec §3.2, §5.1, §5.2, §6, §9, §12 item 3. Line ranges below are those of the tree at `f9c0411b` (main plus the spec); slices 1 and 2 do not touch `project/load.ts`, `serialize.ts`, `save.ts` or `schema.ts`, so the ranges hold when this slice starts.

Rules that hold for every task of this slice:

- **A storage file never imports `project/load.ts`, `project/serialize.ts` or `project/save.ts` as a value.** Those three import `protocols.ts` (for `defaultRegistry()`), which imports every module, which imports its `storage.ts`. A storage file takes what it needs from the helper files this slice creates (`project/schema-parts.ts`, `project/load-helpers.ts`, `project/serialize-helpers.ts`, `project/managed-files.ts`). A type-only import of `ProjectProblem` from `project/load.ts` is fine.
- **The registration order is the file order.** `projectFiles` today writes interfaces, REST APIs, gRPC APIs, WebSocket APIs, in that order. After Task 3.3 that order comes from `registry.modules`, which is the order of `BUILTIN_PROTOCOLS` in `packages/engine/src/protocols.ts`: `[soapProtocol, restProtocol, grpcProtocol, wsProtocol]`, as Task 1.7 wrote it. `save-dispatch.test.ts` (Task 3.3, Step 1) pins the resulting file order.
- **Named core-to-protocol imports this slice keeps** (spec §7.2, all removed in phase 3): `project/load.ts` imports `restRequestReader` and `signingOf` from `rest/storage.ts`; `project/serialize.ts` imports `writeRestRequest` and `signingDocument` from `rest/storage.ts`; `project/schema-parts.ts` imports `signatureSchemeSchema` from `webhooks/signature.ts`; `project/schema.ts` imports the WS-Security defaults from `wss/model.ts` and, until slice 5, re-exports the four `files.ts`; `project/load-helpers.ts` and `project/serialize-helpers.ts` import the type `KeyValueEntry` from `rest/model.ts` until slice 4 moves it to `http/entries.ts`.
- One existing test changes its expected value in this slice, because spec §6 changes the behaviour it pins: `packages/engine/test/unit/project/rest-format.test.ts`, "refuses an api.yaml of an unknown kind the same way" (Task 3.4, Step 9). No other existing test changes.

---

### Task 3.1: File schemas move to their protocols

**Files:**
- Create: `packages/engine/src/project/schema-parts.ts`
- Create: `packages/engine/src/soap/files.ts`, `packages/engine/src/rest/files.ts`, `packages/engine/src/grpc/files.ts`, `packages/engine/src/ws/files.ts`
- Modify: `packages/engine/src/project/schema.ts`
- Test: `packages/engine/test/unit/project/schema-split.test.ts` (new)

**Interfaces:**
- Consumes: `assertionsSchema` (`assert/schema.ts`), `signatureSchemeSchema` (`webhooks/signature.ts`), `SECRET_NAME_PATTERN` (`secrets/secret-token.ts`), `ProjectError`.
- Produces:
  - `project/schema-parts.ts`: `nonEmpty`, `envName`, `endpointAuthSchema`, `authConfigSchema`, `soapOwnerAuthSchema`, `definitionAuthSchema`, `attachmentSourceSchema`, `scriptsSchema`, `keyValueEntrySchema`, `hookLinkSchema`, `webhookSigningSchema`, `restFolderFileSchema`, `assertSupportedKind(document: unknown, file: string): void`, `parseFile<T>(schema: z.ZodType<T>, value: unknown, file: string): T`; types `WebhookSigningFile`, `KeyValueEntryFile`, `RestFolderFile`.
  - `soap/files.ts`: `interfaceFileSchema`, `requestFileSchema`; types `InterfaceFile`, `RequestFile`.
  - `rest/files.ts`: `restBodySchema`, `restRequestFileSchema`, `apiFileSchema`; types `ApiFile`, `RestRequestFile`.
  - `grpc/files.ts`: `grpcMethodKindSchema`, `grpcRequestFileSchema`, `grpcApiFileSchema`; types `GrpcApiFile`, `GrpcRequestFile`.
  - `ws/files.ts`: `wsRequestFileSchema`, `wsApiFileSchema`; types `WsApiFile`, `WsRequestFile`.
  - `project/schema.ts` exports every name it exported before, so `index.ts`, `load.ts`, the three definition caches and every test import unchanged.

**Why a sixth file.** The brief for this task keeps the shared pieces (key-value entries, auth, attachment source, `parseFile`) in `project/schema.ts` and has `schema.ts` re-export the moved schemas. Both cannot be true in one file: `soap/files.ts` would import `soapOwnerAuthSchema` from `schema.ts` while `schema.ts` imports `soap/files.ts` to re-export it, and whichever of the two loads second reads an uninitialised binding at module scope (`auth: soapOwnerAuthSchema.optional()` runs when the file is evaluated). So the shared pieces go to `project/schema-parts.ts`, which imports no `files.ts`; `schema.ts` and the four `files.ts` import it.

**What goes where** (every line of `project/schema.ts`, by its current range):

| Lines | What | Goes to |
| --- | --- | --- |
| 1–20 | header comment | stays; `schema-parts.ts` and each `files.ts` get the header given below |
| 30 | `nonEmpty` | `schema-parts.ts`, exported |
| 31 | `propertyMapSchema` | stays |
| 33–40 | `envName` | `schema-parts.ts`, exported |
| 42–61 | `endpointAuthSchema` | `schema-parts.ts` |
| 63–77, 79–92 | `PLAINTEXT_SECRET_KEYS`, `refuseSecretValues` | `schema-parts.ts` (not exported) |
| 94, 96–103, 105–113, 115–130 | `inheritAuthSchema`, `bearerAuthSchema`, `apiKeyAuthSchema`, `oauth2AuthSchema` | `schema-parts.ts` (not exported) |
| 132–144, 146–154, 156–167 | `authConfigSchema`, `soapOwnerAuthSchema`, `definitionAuthSchema` | `schema-parts.ts` |
| 169–176, 178–198, 200–205 | `endpointSchema`, `wsaSchema`, `operationEntrySchema` | `soap/files.ts` |
| 207–225 | `manifestSchema` | stays |
| 227–241 | `interfaceFileSchema` | `soap/files.ts` |
| 243–265 | `requestPropertiesSchema` | `soap/files.ts` |
| 267–271 | `attachmentSourceSchema` | `schema-parts.ts` |
| 273–283 | `attachmentSchema` | `soap/files.ts` |
| 285–297 | `scriptsSchema` | `schema-parts.ts` |
| 299–320 | `requestFileSchema` | `soap/files.ts` |
| 322–331 | `keyValueEntrySchema` | `schema-parts.ts` |
| 333–340, 342–358 | `methodSchema`, `multipartPartSchema` | `rest/files.ts` |
| 360–376 | `restBodySchema` | `rest/files.ts` |
| 378–390 | `restSettingsSchema` | `rest/files.ts` |
| 392–401 | `hookLinkSchema` | `schema-parts.ts` |
| 403–421 | `webhookSigningSchema`, `WebhookSigningFile` | `schema-parts.ts` |
| 423–428 | `webhooksFileSchema` | stays |
| 430–454 | `restRequestFileSchema` | `rest/files.ts` |
| 456–463 | `restFolderFileSchema` | `schema-parts.ts` (one `folder.yaml` shape serves the REST, gRPC, WebSocket and webhook trees, and core's tree reader parses it) |
| 465–470 | `webhookFolderFileSchema` | stays |
| 472–490 | `apiFileSchema` | `rest/files.ts` |
| 492–499, 501–502, 504–525, 527–549 | `grpcSettingsSchema`, `grpcMethodKindSchema`, `grpcRequestFileSchema`, `grpcApiFileSchema` | `grpc/files.ts` |
| 551–558, 560–572, 574–595, 597–616 | `wsSettingsSchema`, `wsSavedMessageSchema`, `wsRequestFileSchema`, `wsApiFileSchema` | `ws/files.ts` |
| 618–619, 621–646 | `SUPPORTED_KINDS`, `assertSupportedKind` | `schema-parts.ts` (request readers in every module call it) |
| 648–656 | `apiKindOf` | stays (unused after Task 3.2; slice 5, Task 5.2 Step 4, deletes it) |
| 658–667 | `environmentFileSchema` | stays |
| 669–793 | the WS-Security entry and file schemas | stay |
| 795–813 | `keystoreEntrySchema`, `keystoresFileSchema` | stay |
| 815–916 | the four definition-cache manifest schemas and their six types | stay (they are neither container nor request files; `wsdl/cache.ts`, `rest/openapi/cache.ts` and `grpc/cache.ts` keep importing them from `project/schema.js`) |
| 918–919, 924–925 | `ManifestFile`, `EnvironmentFile` | stay |
| 920–923 | `InterfaceFile`, `RequestFile` | `soap/files.ts` |
| 926–927, 930–931 | `KeyValueEntryFile`, `RestFolderFile` | `schema-parts.ts` |
| 928–929, 932–933 | `ApiFile`, `RestRequestFile` | `rest/files.ts` |
| 934–937 | `GrpcApiFile`, `GrpcRequestFile` | `grpc/files.ts` |
| 938–941 | `WsApiFile`, `WsRequestFile` | `ws/files.ts` |
| 943–960 | `parseFile` | `schema-parts.ts` |

The WS-Security file schemas and the three webhook schemas (`webhooksFileSchema`, `webhookFolderFileSchema`, and the `hook`/`signing` pieces in `schema-parts.ts`) staying in core is one of spec §7.2's named exceptions: core loads and saves both until phase 3.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/project/schema-split.test.ts
/**
 * The file schemas live with their protocols, and `project/schema.ts` still exports every one of
 * them under its old name (spec §3.2), so nothing that imports it had to change.
 */
import { describe, expect, it } from 'vitest';
import * as grpcFiles from '../../../src/grpc/files.js';
import * as parts from '../../../src/project/schema-parts.js';
import * as schema from '../../../src/project/schema.js';
import * as restFiles from '../../../src/rest/files.js';
import * as soapFiles from '../../../src/soap/files.js';
import * as wsFiles from '../../../src/ws/files.js';

type Exports = Readonly<Record<string, unknown>>;

const MOVED: readonly (readonly [string, Exports, readonly string[]])[] = [
  ['soap/files.ts', { ...soapFiles }, ['interfaceFileSchema', 'requestFileSchema']],
  ['rest/files.ts', { ...restFiles }, ['apiFileSchema', 'restBodySchema', 'restRequestFileSchema']],
  ['grpc/files.ts', { ...grpcFiles }, ['grpcApiFileSchema', 'grpcMethodKindSchema', 'grpcRequestFileSchema']],
  ['ws/files.ts', { ...wsFiles }, ['wsApiFileSchema', 'wsRequestFileSchema']],
  [
    'project/schema-parts.ts',
    { ...parts },
    [
      'assertSupportedKind',
      'attachmentSourceSchema',
      'authConfigSchema',
      'definitionAuthSchema',
      'endpointAuthSchema',
      'hookLinkSchema',
      'keyValueEntrySchema',
      'parseFile',
      'restFolderFileSchema',
      'scriptsSchema',
      'soapOwnerAuthSchema',
      'webhookSigningSchema',
    ],
  ],
];

const CORE = [
  'apiDefinitionCacheManifestSchema',
  'apiKindOf',
  'definitionCacheManifestSchema',
  'descriptorDefinitionCacheManifestSchema',
  'environmentFileSchema',
  'keystoreEntrySchema',
  'keystoresFileSchema',
  'manifestSchema',
  'protoDefinitionCacheManifestSchema',
  'webhookFolderFileSchema',
  'webhooksFileSchema',
  'wssEntrySchema',
  'wssIncomingFileSchema',
  'wssOutgoingFileSchema',
];

describe('the file schemas after the split', () => {
  const old: Exports = { ...schema };

  for (const [file, module, names] of MOVED) {
    it(`project/schema.ts still exports what moved to ${file}, as the same object`, () => {
      for (const name of names) {
        expect(module[name], name).toBeDefined();
        expect(old[name], name).toBe(module[name]);
      }
    });
  }

  it('keeps the core file schemas in project/schema.ts and nowhere else', () => {
    for (const name of CORE) {
      expect(old[name], name).toBeDefined();
      for (const [file, module] of MOVED) {
        expect(module[name], `${name} in ${file}`).toBeUndefined();
      }
    }
  });

  it('gives each protocol a container schema that takes its own kind only', () => {
    const api = { id: 'A1', name: 'Shop', order: 0 };
    expect(restFiles.apiFileSchema.safeParse({ ...api, kind: 'rest', baseUrl: '' }).success).toBe(true);
    expect(restFiles.apiFileSchema.safeParse({ ...api, kind: 'grpc', baseUrl: '' }).success).toBe(false);
    expect(grpcFiles.grpcApiFileSchema.safeParse({ ...api, kind: 'grpc', target: 'localhost:1' }).success).toBe(true);
    expect(wsFiles.wsApiFileSchema.safeParse({ ...api, kind: 'websocket', url: '' }).success).toBe(true);
    expect(soapFiles.interfaceFileSchema.safeParse({ ...api, kind: 'rest' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/schema-split.test.ts`
Expected: FAIL — `Cannot find module '../../../src/grpc/files.js'` (none of the five new files exists).

- [ ] **Step 3: Create `packages/engine/src/project/schema-parts.ts`**

Header and imports, written in full:

```ts
/**
 * The pieces every project file schema is built from: the non-empty string, the authentication
 * schemes, a table row, a request's `scripts` key, the webhook `hook` and `signing` keys, a request
 * tree's `folder.yaml`, and the two guards every reader calls ({@link assertSupportedKind},
 * {@link parseFile}).
 *
 * Its own file, apart from `schema.ts`, because each protocol's file schemas (`soap/files.ts`,
 * `rest/files.ts`, `grpc/files.ts`, `ws/files.ts`) import these pieces while `schema.ts` re-exports
 * those schemas under their old names: were the pieces in `schema.ts`, the two would import each
 * other, and whichever loaded second would read a binding that is not initialised yet.
 *
 * The strictness policy is `schema.ts`'s: every object is `z.looseObject`, and any additive field
 * bumps `formatVersion` (ADR-0003). This file imports no protocol folder but `webhooks/signature.ts`:
 * the webhook collection is core's until phase 3 of #184.
 */

import { z } from 'zod';
import { ProjectError } from '../errors.js';
import { SECRET_NAME_PATTERN } from '../secrets/secret-token.js';
import { signatureSchemeSchema } from '../webhooks/signature.js';

/** A string with at least one character: an id, a slug, a file name. */
export const nonEmpty = z.string().min(1);
```

Then move in, from `project/schema.ts`, in this order and with their comments, unchanged except that `envName` gains `export`: lines 33–40 (`envName`), 42–61, 63–77, 79–92, 94, 96–103, 105–113, 115–130, 132–144, 146–154, 156–167, 267–271, 285–297, 322–331, 392–401, 403–421, 456–463, 618–619, 621–646, 926–927 (`KeyValueEntryFile`), 930–931 (`RestFolderFile`), 943–960 (`parseFile`).

- [ ] **Step 4: Create the four `files.ts`**

Each file is its header and imports (in full below), then the moved schemas in their current order with their comments, unchanged.

`packages/engine/src/soap/files.ts` — then lines 169–176, 178–198, 200–205, 227–241, 243–265, 273–283, 299–320, 920–923:

```ts
/**
 * The SOAP files of a project folder: `interfaces/<slug>/interface.yaml` and each
 * `operations/<slug>/<name>.request.yaml` under it (spec §3.2). The shared pieces and the
 * strictness policy are `project/schema-parts.ts`'s.
 */

import { z } from 'zod';
import { assertionsSchema } from '../assert/schema.js';
import { attachmentSourceSchema, nonEmpty, scriptsSchema, soapOwnerAuthSchema } from '../project/schema-parts.js';
```

`packages/engine/src/rest/files.ts` — then lines 333–340, 342–358, 360–376, 378–390, 430–454, 472–490, 928–929, 932–933:

```ts
/**
 * The REST files of a project folder: `apis/<slug>/api.yaml` with `kind: rest`, and each
 * `*.request.yaml` of its request tree (spec §3.2). The same request schema reads the items of the
 * project's webhook collection, which is REST requests in a tree of its own.
 */

import { z } from 'zod';
import { assertionsSchema } from '../assert/schema.js';
import {
  attachmentSourceSchema,
  authConfigSchema,
  definitionAuthSchema,
  hookLinkSchema,
  keyValueEntrySchema,
  nonEmpty,
  scriptsSchema,
  webhookSigningSchema,
} from '../project/schema-parts.js';
```

`packages/engine/src/grpc/files.ts` — then lines 492–499, 501–502, 504–525, 527–549, 934–937:

```ts
/**
 * The gRPC files of a project folder: `apis/<slug>/api.yaml` with `kind: grpc`, and each
 * `*.request.yaml` of its request tree (spec §3.2).
 */

import { z } from 'zod';
import { assertionsSchema } from '../assert/schema.js';
import { authConfigSchema, keyValueEntrySchema, nonEmpty, scriptsSchema } from '../project/schema-parts.js';
```

`packages/engine/src/ws/files.ts` — then lines 551–558, 560–572, 574–595, 597–616, 938–941:

```ts
/**
 * The WebSocket files of a project folder: `apis/<slug>/api.yaml` with `kind: websocket`, and each
 * `*.request.yaml` of its request tree (spec §3.2).
 */

import { z } from 'zod';
import { authConfigSchema, definitionAuthSchema, keyValueEntrySchema, nonEmpty } from '../project/schema-parts.js';
```

- [ ] **Step 5: Reduce `packages/engine/src/project/schema.ts` to the core schemas**

1. Delete every range the table sends elsewhere.
2. Replace the import block (lines 22–28) and line 30 with:

```ts
import { z } from 'zod';
import { FORMAT_VERSION } from './model.js';
import { DEFAULT_WSS_ENCRYPTION_PARTS, DEFAULT_WSS_SIGNATURE_PARTS } from '../wss/model.js';
import { authConfigSchema, envName, nonEmpty, restFolderFileSchema, webhookSigningSchema } from './schema-parts.js';

// Everything that moved out keeps its old name here until the public exports change (slice 5 of
// the protocol modules plan), so no importer of this file had to change with the move.
export {
  assertSupportedKind,
  attachmentSourceSchema,
  authConfigSchema,
  definitionAuthSchema,
  endpointAuthSchema,
  hookLinkSchema,
  keyValueEntrySchema,
  parseFile,
  restFolderFileSchema,
  scriptsSchema,
  soapOwnerAuthSchema,
  webhookSigningSchema,
} from './schema-parts.js';
export type { KeyValueEntryFile, RestFolderFile, WebhookSigningFile } from './schema-parts.js';
export { interfaceFileSchema, requestFileSchema } from '../soap/files.js';
export type { InterfaceFile, RequestFile } from '../soap/files.js';
export { apiFileSchema, restBodySchema, restRequestFileSchema } from '../rest/files.js';
export type { ApiFile, RestRequestFile } from '../rest/files.js';
export { grpcApiFileSchema, grpcMethodKindSchema, grpcRequestFileSchema } from '../grpc/files.js';
export type { GrpcApiFile, GrpcRequestFile } from '../grpc/files.js';
export { wsApiFileSchema, wsRequestFileSchema } from '../ws/files.js';
export type { WsApiFile, WsRequestFile } from '../ws/files.js';
```

The file loses its imports of `assertionsSchema`, `ProjectError`, `SECRET_NAME_PATTERN` and `signatureSchemeSchema`; nothing left in it uses them. `propertyMapSchema` (line 31) stays where it is.

3. In the header comment, append one paragraph before the closing `*/`:

```ts
 *
 * This file holds the core documents only: the manifest, an environment, the keystore registry, the
 * WS-Security configurations, the webhook collection and the definition-cache manifests. A
 * protocol's container and request files are in its own folder (`soap/files.ts`, `rest/files.ts`,
 * `grpc/files.ts`, `ws/files.ts`), and the pieces they share in `schema-parts.ts`.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/`
Expected: PASS, the new `schema-split.test.ts` and, unchanged, `schema.test.ts`, `auth-config.test.ts`, `roundtrip.test.ts`, `rest-format.test.ts`, `grpc-format.test.ts`, `ws-format.test.ts`, `webhooks-format.test.ts`, `webhook-signing-format.test.ts`, `scripts-format.test.ts`.

Run: `nice pnpm exec tsc -b`
Expected: no errors (`index.ts`, `load.ts`, `wsdl/cache.ts`, `rest/openapi/cache.ts`, `grpc/cache.ts` still import from `project/schema.js`).

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write packages/engine/src/project/schema.ts packages/engine/src/project/schema-parts.ts packages/engine/src/soap/files.ts packages/engine/src/rest/files.ts packages/engine/src/grpc/files.ts packages/engine/src/ws/files.ts packages/engine/test/unit/project/schema-split.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/project/schema.ts packages/engine/src/project/schema-parts.ts packages/engine/src/soap/files.ts packages/engine/src/rest/files.ts packages/engine/src/grpc/files.ts packages/engine/src/ws/files.ts packages/engine/test/unit/project/schema-split.test.ts
git commit -m "refactor(engine): each protocol's file schemas live in its own folder (#184)"
```

---

### Task 3.2: `storage.load` for the four modules, and the loader dispatches

**Files:**
- Create: `packages/engine/src/project/load-helpers.ts`
- Create: `packages/engine/src/soap/storage.ts`, `packages/engine/src/rest/storage.ts`, `packages/engine/src/grpc/storage.ts`, `packages/engine/src/ws/storage.ts`
- Modify: `packages/engine/src/project/load.ts`
- Modify: `packages/engine/src/soap/module.ts`, `packages/engine/src/rest/module.ts`, `packages/engine/src/grpc/module.ts`, `packages/engine/src/ws/module.ts` (each passes its storage to `defineProtocol`)
- Test: `packages/engine/test/unit/project/load-dispatch.test.ts` (new)

**Interfaces:**
- Consumes: `ProtocolStorage<C>`, `LoadContext`, `ContainerBase`, `ContainerDir` (`protocol/module.ts`); `ProtocolRegistry` (`protocol/registry.ts`); `defaultRegistry()`, `createBuiltinRegistry(switches?)` (`protocols.ts`); the schemas of Task 3.1.
- Produces:
  - `project/load-helpers.ts`: `abs(root: string, relative: string): string`, `readYaml(fs: FsLike, root: string, relative: string): Promise<unknown>`, `byOrder`, `optional`, `exact`, `loadScripts`, `authConfig(parsed: Record<string, unknown>): AuthConfig`, `definitionAuth`, `keyValueEntries(rows: readonly KeyValueEntryFile[]): KeyValueEntry[]`, `loadFolderContents`, and the types `FolderNode<R>`, `FolderContents<R>`, `RequestReader<R>`.
  - `soapStorage: ProtocolStorage<Interface>`, `restStorage: ProtocolStorage<RestApi>`, `grpcStorage: ProtocolStorage<GrpcApi>`, `wsStorage: ProtocolStorage<WsApi>`, with `dir`, `load`, `containers`, `withContainers` working.
  - `rest/storage.ts` also exports `restRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<RestRequestDef>` and `signingOf(parsed: WebhookSigningFile): WebhookSigning`, for core's webhook loader.
  - `LoadProjectOptions.registry?: ProtocolRegistry`.

**Two members are stubs for one commit.** `ProtocolStorage` has six members and the loader needs the object on the module now, so `files` and `managed` throw in this task and Task 3.3 replaces them. Nothing calls them until Task 3.3 rewrites the writer.

**`loadBody` does not go to the core helper file.** Only REST's request reader calls it and it returns a `RestBody`, so it moves to `rest/storage.ts` with the reader.

**Where each part of `project/load.ts` goes:**

| Lines | What | Goes to |
| --- | --- | --- |
| 86–114, 116–120 | `ProjectProblem`, `LoadResult` | stay |
| 122–125 | `LoadProjectOptions` | stays, gains `registry` |
| 127–129 | `abs` | `load-helpers.ts`, exported |
| 131–134 | `readYaml` | `load-helpers.ts`, exported |
| 136–139 | `byOrder` | `load-helpers.ts`, exported |
| 141–143 | `optional` | `load-helpers.ts`, exported |
| 145–148 and 160–169 | the comment above line 149 (it describes `exact`, not `signingOf`) and `exact` | `load-helpers.ts`, exported, comment directly above the function |
| 149–158 | `signingOf` | `rest/storage.ts`, exported |
| 171–226 | `loadScripts` | `load-helpers.ts`, exported |
| 228–292 | `loadRequests` | `soap/storage.ts` |
| 294–356 | `loadInterface` | becomes `soapStorage.load` (Step 5) |
| 358–372 | `authConfig` | `load-helpers.ts`, exported |
| 374–383 | `soapOwnerAuth` | `soap/storage.ts` |
| 385–392 | `definitionAuth` | `load-helpers.ts`, exported |
| 394–399 | `keyValueEntries` | `load-helpers.ts`, exported |
| 401–451, 453–454 | `loadBody`, `RestRequestFileBody` | `rest/storage.ts` |
| 456–466, 468–472, 474–478 | `FolderNode`, `FolderContents`, `RequestReader` | `load-helpers.ts`, exported |
| 480–520 | `restRequestReader` | `rest/storage.ts`, exported |
| 522–540 | `apiRequestReader` | `rest/storage.ts` |
| 542–605 | `grpcRequestReader` | `grpc/storage.ts` |
| 607–663 | `wsRequestReader` | `ws/storage.ts` |
| 665–731 | `loadFolderContents` | `load-helpers.ts`, exported |
| 733–737, 739–875 | `LoadedApi`, `loadApi` | deleted; its three branches become `grpcStorage.load`, `wsStorage.load`, `restStorage.load` (Step 5) |
| 877–896, 898–911, 913–947 | `loadEnvironments`, `loadWssRefs`, `loadWebhooks` | stay |
| 949–1048 | `loadProject` | rewritten (Step 6) |

Moved functions keep their bodies. The ones that gain `export` and had no comment (`abs`, `readYaml`, `optional`) get the one-line JSDoc given in Step 3.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/project/load-dispatch.test.ts
/**
 * The loader reads each container through the module its `kind` names (spec §5.1), and what it
 * returns and reports is what it returned and reported when it branched on the kind itself.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { grpcStorage } from '../../../src/grpc/storage.js';
import { loadProject } from '../../../src/project/load.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { createBuiltinRegistry } from '../../../src/protocols.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { restStorage } from '../../../src/rest/storage.js';
import { soapStorage } from '../../../src/soap/storage.js';
import { createWsApi, createWsRequest } from '../../../src/ws/model.js';
import { wsStorage } from '../../../src/ws/storage.js';
import { sampleProject, tempProjectDir } from './fixture.js';

/** The sample project's two interfaces, plus one API of each other kind. */
function mixedProject(): Project {
  return {
    ...sampleProject(),
    apis: [
      createApi('Shop', {
        id: 'A1',
        order: 2,
        baseUrl: 'https://shop.test',
        requests: [createRestRequest('List', { id: 'R1', url: '/items' })],
      }),
    ],
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'G1',
        order: 3,
        target: 'localhost:50051',
        requests: [createGrpcRequest('Hello', { id: 'GR1', service: 'demo.Greeter', method: 'SayHello' })],
      }),
    ],
    wsApis: [
      createWsApi('Chat', {
        id: 'W1',
        order: 4,
        url: 'wss://chat.test',
        requests: [createWsRequest('Feed', { id: 'WR1', url: '/feed' })],
      }),
    ],
  };
}

describe('loading through the protocol modules', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempProjectDir();
    await saveProject(mixedProject(), dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('puts every kind in its own list, with the default registry and with one passed in', async () => {
    const byDefault = await loadProject(dir);
    const explicit = await loadProject(dir, { registry: createBuiltinRegistry() });

    expect(byDefault.problems).toEqual([]);
    expect(byDefault.project.interfaces.map((iface) => iface.slug)).toEqual(
      sampleProject().interfaces.map((iface) => iface.slug),
    );
    expect(byDefault.project.apis.map((api) => [api.kind, api.slug])).toEqual([['rest', 'Shop']]);
    expect(byDefault.project.grpcApis.map((api) => [api.kind, api.slug])).toEqual([['grpc', 'Greeter']]);
    expect(byDefault.project.wsApis.map((api) => [api.kind, api.slug])).toEqual([['websocket', 'Chat']]);
    expect(explicit).toEqual(byDefault);
  });

  it('each built-in storage says where its containers live and which list holds them', () => {
    const project = mixedProject();

    expect([soapStorage.dir, restStorage.dir, grpcStorage.dir, wsStorage.dir]).toEqual([
      'interfaces',
      'apis',
      'apis',
      'apis',
    ]);
    expect(soapStorage.containers(project)).toBe(project.interfaces);
    expect(restStorage.containers(project)).toBe(project.apis);
    expect(grpcStorage.containers(project)).toBe(project.grpcApis);
    expect(wsStorage.containers(project)).toBe(project.wsApis);
    expect(soapStorage.withContainers(project, []).interfaces).toEqual([]);
    expect(restStorage.withContainers(project, []).apis).toEqual([]);
    expect(grpcStorage.withContainers(project, []).grpcApis).toEqual([]);
    expect(wsStorage.withContainers(project, []).wsApis).toEqual([]);
    expect(restStorage.withContainers(project, []).grpcApis).toBe(project.grpcApis);
  });

  it('reads an api.yaml without a kind as REST, which its schema then refuses', async () => {
    const file = join(dir, 'apis', 'Shop', 'api.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('kind: rest\n', ''));

    await expect(loadProject(dir)).rejects.toMatchObject({
      code: 'project-file-invalid',
      details: { file: 'apis/Shop/api.yaml' },
    });
  });

  it('reports a container directory with no container file, in either directory', async () => {
    await mkdir(join(dir, 'interfaces', 'Hollow'), { recursive: true });
    await mkdir(join(dir, 'apis', 'Hollow'), { recursive: true });

    const { project, problems } = await loadProject(dir);

    expect([...problems].sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      {
        code: 'missing-api-file',
        message: 'Folder "Hollow" has no api.yaml and was skipped',
        file: 'apis/Hollow/api.yaml',
      },
      {
        code: 'missing-interface-file',
        message: 'Folder "Hollow" has no interface.yaml and was skipped',
        file: 'interfaces/Hollow/interface.yaml',
      },
    ]);
    expect(project.apis.map((api) => api.slug)).toEqual(['Shop']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/load-dispatch.test.ts`
Expected: FAIL — `Cannot find module '../../../src/grpc/storage.js'`.

- [ ] **Step 3: Create `packages/engine/src/project/load-helpers.ts`**

Header, imports and the three new one-line comments in full; everything else is moved in from `project/load.ts` with `export` added, in this order: `abs` (127–129), `readYaml` (131–134), `byOrder` (136–139), `optional` (141–143), `exact` (comment 145–148, function 160–169), `loadScripts` (171–226), `authConfig` (358–372), `definitionAuth` (385–392), `keyValueEntries` (394–399), `FolderNode` (456–466), `FolderContents` (468–472), `RequestReader` (474–478), `loadFolderContents` (665–731).

```ts
/**
 * What core's loader and every protocol's `storage.load` share when they read a project folder:
 * YAML from a relative path, the `undefined`-dropping helpers, authentication as loaded, a
 * request's scripts, and the request tree an API (of any protocol) and the webhook collection keep
 * under `requests/`.
 *
 * A protocol's storage imports this file and never `load.ts`, which imports the protocols.
 */

import { join } from 'node:path';
import type { z } from 'zod';
import type { KeyValueEntry } from '../rest/model.js';
import { scriptFileName } from '../script/model.js';
import type { RequestScripts, ScriptPhase, ScriptSource } from '../script/model.js';
import { SCRIPT_LIMITS } from '../script/sandbox/model.js';
import type { FsLike } from './fs.js';
import { readFileIfExists, readdirIfExists } from './fs.js';
import type { ProjectProblem } from './load.js';
import type { AuthConfig, DefinitionAuth } from './model.js';
import { FOLDER_FILE, MAX_FOLDER_DEPTH, REQUEST_SUFFIX } from './paths.js';
import { parseFile, restFolderFileSchema } from './schema-parts.js';
import type { KeyValueEntryFile, scriptsSchema } from './schema-parts.js';
import { parseYaml } from './yaml.js';
```

The three comments to add above the functions that had none:

```ts
/** The absolute path of a `/`-separated path relative to the project root. */
export function abs(root: string, relative: string): string {

/** Reads and parses one YAML file of the project; undefined when the file does not exist. */
export async function readYaml(fs: FsLike, root: string, relative: string): Promise<unknown> {

/** `{ [key]: value }`, or nothing at all when the value is undefined (`exactOptionalPropertyTypes`). */
export function optional<T>(key: string, value: T | undefined): Record<string, T> {
```

- [ ] **Step 4: Create the four `storage.ts` with their readers**

Each file below is: header and imports in full; the moved functions by name and range; then the storage object in full (Step 5).

`packages/engine/src/soap/storage.ts` — moved in: `soapOwnerAuth` (374–383), `loadRequests` (228–292):

```ts
/**
 * How SOAP interfaces are stored in a project folder (spec §3.2): `interfaces/<slug>/interface.yaml`,
 * and under `operations/<operation slug>/` one `<slug>.request.yaml` with its envelope in the sibling
 * `<slug>.xml` and its scripts beside it.
 */

import type { Assertion } from '../assert/model.js';
import { toCallbackAssertion } from '../assert/schema.js';
import type { FsLike } from '../project/fs.js';
import { readFileIfExists, readdirIfExists } from '../project/fs.js';
import { abs, authConfig, byOrder, exact, loadScripts, optional, readYaml } from '../project/load-helpers.js';
import type { ProjectProblem } from '../project/load.js';
import type {
  Attachment,
  Endpoint,
  Interface,
  OperationDef,
  RequestProperties,
  SoapOwnerAuth,
  SoapRequestDef,
} from '../project/model.js';
import { INTERFACES_DIR, OPERATIONS_DIR, REQUEST_SUFFIX } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import type { ProtocolStorage } from '../protocol/module.js';
import { normalizeWsa } from '../wsa/model.js';
import { interfaceFileSchema, requestFileSchema } from './files.js';
```

`packages/engine/src/rest/storage.ts` — moved in: `signingOf` (149–158, gains `export`), `loadBody` (401–451), `RestRequestFileBody` (453–454), `restRequestReader` (480–520, gains `export`), `apiRequestReader` (522–540):

```ts
/**
 * How REST APIs are stored in a project folder (spec §3.2): `apis/<slug>/api.yaml` with
 * `kind: rest`, and a tree of folders and `*.request.yaml` files under `requests/`, a raw body in
 * the sibling `<slug>.body.<ext>`.
 *
 * `restRequestReader` and `signingOf` are exported for core's loader, which reads the project's
 * webhook collection (REST requests in a tree of their own) until phase 3 of #184 moves it here.
 */

import type { Assertion } from '../assert/model.js';
import { toCallbackAssertion } from '../assert/schema.js';
import { ProjectError } from '../errors.js';
import type { FsLike } from '../project/fs.js';
import { readFileIfExists } from '../project/fs.js';
import {
  abs,
  authConfig,
  definitionAuth,
  exact,
  keyValueEntries,
  loadFolderContents,
  loadScripts,
  optional,
  readYaml,
} from '../project/load-helpers.js';
import type { RequestReader } from '../project/load-helpers.js';
import type { ProjectProblem } from '../project/load.js';
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR, WEBHOOKS_DIR } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import type { WebhookSigningFile } from '../project/schema-parts.js';
import type { ProtocolStorage } from '../protocol/module.js';
import type { HookLink, WebhookSigning } from '../webhooks/model.js';
import { toSignatureScheme } from '../webhooks/signature.js';
import { apiFileSchema, restRequestFileSchema } from './files.js';
import type { RestApi, RestBody, RestRequestDef, RestRequestSettings } from './model.js';
```

`packages/engine/src/grpc/storage.ts` — moved in: `grpcRequestReader` (542–605):

```ts
/**
 * How gRPC APIs are stored in a project folder (spec §3.2): `apis/<slug>/api.yaml` with
 * `kind: grpc`, and a tree of folders and `*.request.yaml` files under `requests/`, each request's
 * message in the sibling `<slug>.body.json`.
 */

import type { Assertion } from '../assert/model.js';
import { toCallbackAssertion } from '../assert/schema.js';
import type { FsLike } from '../project/fs.js';
import { readFileIfExists } from '../project/fs.js';
import {
  abs,
  authConfig,
  exact,
  keyValueEntries,
  loadFolderContents,
  loadScripts,
  optional,
  readYaml,
} from '../project/load-helpers.js';
import type { RequestReader } from '../project/load-helpers.js';
import type { ProjectProblem } from '../project/load.js';
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import type { ProtocolStorage } from '../protocol/module.js';
import { grpcApiFileSchema, grpcRequestFileSchema } from './files.js';
import type { GrpcApi, GrpcRequestDef, GrpcRequestSettings } from './model.js';
```

`packages/engine/src/ws/storage.ts` — moved in: `wsRequestReader` (607–663):

```ts
/**
 * How WebSocket APIs are stored in a project folder (spec §3.2): `apis/<slug>/api.yaml` with
 * `kind: websocket`, and a tree of folders and `*.request.yaml` files under `requests/`, each saved
 * message in a sibling `<slug>.msg-<message slug>.<ext>`.
 */

import type { FsLike } from '../project/fs.js';
import { readFileIfExists } from '../project/fs.js';
import {
  abs,
  authConfig,
  definitionAuth,
  exact,
  keyValueEntries,
  loadFolderContents,
  optional,
  readYaml,
} from '../project/load-helpers.js';
import type { RequestReader } from '../project/load-helpers.js';
import type { ProjectProblem } from '../project/load.js';
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import type { ProtocolStorage } from '../protocol/module.js';
import { wsApiFileSchema, wsRequestFileSchema } from './files.js';
import type { WsApi, WsRequestDef, WsRequestSettings, WsSavedMessage } from './model.js';
```

- [ ] **Step 5: Write the four storage objects**

At the end of `packages/engine/src/soap/storage.ts` (`load` is `loadInterface`, lines 311–355, with the file read and the missing-file problem left to core):

```ts
/** SOAP's storage facet. */
export const soapStorage: ProtocolStorage<Interface> = {
  dir: INTERFACES_DIR,

  async load(ctx, slug, document) {
    const { fs, root, problems } = ctx;
    const relative = `${INTERFACES_DIR}/${slug}/interface.yaml`;
    const parsed = parseFile(interfaceFileSchema, document, relative);
    const operationsDir = `${INTERFACES_DIR}/${slug}/${OPERATIONS_DIR}`;
    const folders = new Set(
      (await readdirIfExists(fs, abs(root, operationsDir))).filter((e) => e.isDirectory).map((e) => e.name),
    );
    const operations: OperationDef[] = [];
    for (const entry of parsed.operations) {
      folders.delete(entry.slug);
      operations.push({
        name: entry.name,
        bindingName: entry.bindingName,
        slug: entry.slug,
        order: entry.order,
        requests: await loadRequests(fs, root, `${operationsDir}/${entry.slug}`, problems),
      });
    }
    for (const orphan of [...folders].sort()) {
      problems.push({
        code: 'orphan-operation-folder',
        message: `Operation folder "${orphan}" is not listed in interface.yaml`,
        file: `${operationsDir}/${orphan}`,
      });
    }
    const endpoints: readonly Endpoint[] = parsed.endpoints.map((e) => ({
      id: e.id,
      name: e.name,
      url: e.url,
      ...optional('auth', soapOwnerAuth(e.auth)),
      authMode: e.authMode,
    }));
    return {
      kind: 'soap',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      definitionUrl: parsed.definitionUrl,
      cacheDefinition: parsed.cacheDefinition,
      ...optional('targetNamespace', parsed.targetNamespace),
      endpoints,
      ...optional('defaultEndpointId', parsed.defaultEndpointId),
      wsa: normalizeWsa(parsed.wsa),
      ...optional('auth', soapOwnerAuth(parsed.auth)),
      operations: operations.sort(byOrder),
    };
  },

  // Task 3.3 moves the writer here. Until then core writes this protocol's files itself.
  files() {
    throw new Error('soapStorage.files is not implemented yet');
  },
  managed() {
    return Promise.reject(new Error('soapStorage.managed is not implemented yet'));
  },

  containers: (project) => project.interfaces,
  withContainers: (project, interfaces) => ({ ...project, interfaces }),
};
```

At the end of `packages/engine/src/rest/storage.ts` (`load` is `loadApi`'s `default` branch, lines 838–872):

```ts
/** REST's storage facet. */
export const restStorage: ProtocolStorage<RestApi> = {
  dir: APIS_DIR,

  async load(ctx, slug, document) {
    const { fs, root, problems } = ctx;
    const parsed = parseFile(apiFileSchema, document, `${APIS_DIR}/${slug}/${API_FILE}`);
    const contents = await loadFolderContents(
      fs,
      root,
      `${APIS_DIR}/${slug}/${REQUESTS_DIR}`,
      0,
      problems,
      apiRequestReader(fs, root, problems),
    );
    return {
      kind: 'rest',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      baseUrl: parsed.baseUrl,
      servers: parsed.servers.map((server) => exact<{ url: string; description?: string }>(server)),
      ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
      ...(parsed.definition !== undefined
        ? {
            definition: {
              source: parsed.definition.source,
              cache: parsed.definition.cache,
              version: parsed.definition.version,
              ...optional('auth', definitionAuth(parsed.definition.auth)),
            },
          }
        : {}),
      folders: contents.folders,
      requests: contents.requests,
    };
  },

  // Task 3.3 moves the writer here. Until then core writes this protocol's files itself.
  files() {
    throw new Error('restStorage.files is not implemented yet');
  },
  managed() {
    return Promise.reject(new Error('restStorage.managed is not implemented yet'));
  },

  containers: (project) => project.apis,
  withContainers: (project, apis) => ({ ...project, apis }),
};
```

At the end of `packages/engine/src/grpc/storage.ts` (`load` is `loadApi`'s `'grpc'` branch, lines 760–797):

```ts
/** gRPC's storage facet. */
export const grpcStorage: ProtocolStorage<GrpcApi> = {
  dir: APIS_DIR,

  async load(ctx, slug, document) {
    const { fs, root, problems } = ctx;
    const parsed = parseFile(grpcApiFileSchema, document, `${APIS_DIR}/${slug}/${API_FILE}`);
    const contents = await loadFolderContents(
      fs,
      root,
      `${APIS_DIR}/${slug}/${REQUESTS_DIR}`,
      0,
      problems,
      grpcRequestReader(fs, root, problems),
    );
    return {
      kind: 'grpc',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      target: parsed.target,
      tls: parsed.tls,
      metadata: keyValueEntries(parsed.metadata),
      ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
      ...(parsed.definition !== undefined
        ? {
            definition: {
              kind: parsed.definition.kind,
              source: parsed.definition.source,
              cache: parsed.definition.cache,
              roots: parsed.definition.roots,
              ...optional('reflectionVersion', parsed.definition.reflectionVersion),
              ...optional('trustInvalid', parsed.definition.trustInvalid),
            },
          }
        : {}),
      folders: contents.folders,
      requests: contents.requests,
    };
  },

  // Task 3.3 moves the writer here. Until then core writes this protocol's files itself.
  files() {
    throw new Error('grpcStorage.files is not implemented yet');
  },
  managed() {
    return Promise.reject(new Error('grpcStorage.managed is not implemented yet'));
  },

  containers: (project) => project.grpcApis,
  withContainers: (project, grpcApis) => ({ ...project, grpcApis }),
};
```

At the end of `packages/engine/src/ws/storage.ts` (`load` is `loadApi`'s `'websocket'` branch, lines 800–835):

```ts
/** WebSocket's storage facet. */
export const wsStorage: ProtocolStorage<WsApi> = {
  dir: APIS_DIR,

  async load(ctx, slug, document) {
    const { fs, root, problems } = ctx;
    const parsed = parseFile(wsApiFileSchema, document, `${APIS_DIR}/${slug}/${API_FILE}`);
    const contents = await loadFolderContents(
      fs,
      root,
      `${APIS_DIR}/${slug}/${REQUESTS_DIR}`,
      0,
      problems,
      wsRequestReader(fs, root, problems),
    );
    return {
      kind: 'websocket',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      url: parsed.url,
      headers: keyValueEntries(parsed.headers),
      ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
      ...(parsed.definition !== undefined
        ? {
            definition: {
              kind: parsed.definition.kind,
              source: parsed.definition.source,
              cache: parsed.definition.cache,
              ...optional('server', parsed.definition.server),
              ...optional('auth', definitionAuth(parsed.definition.auth)),
            },
          }
        : {}),
      folders: contents.folders,
      requests: contents.requests,
    };
  },

  // Task 3.3 moves the writer here. Until then core writes this protocol's files itself.
  files() {
    throw new Error('wsStorage.files is not implemented yet');
  },
  managed() {
    return Promise.reject(new Error('wsStorage.managed is not implemented yet'));
  },

  containers: (project) => project.wsApis,
  withContainers: (project, wsApis) => ({ ...project, wsApis }),
};
```

Then give each module its storage. In `soap/module.ts` add `import { soapStorage } from './storage.js';` and the line `storage: soapStorage,` to the object passed to `defineProtocol`; the same in `rest/module.ts` (`restStorage`), `grpc/module.ts` (`grpcStorage`) and `ws/module.ts` (`wsStorage`). A `ProtocolStorage<Interface>` is accepted where `ProtocolStorage` is asked for because the facet's members are declared with method syntax (plan ruling "Method syntax, no casts").

- [ ] **Step 6: Rewrite `packages/engine/src/project/load.ts`**

1. Delete every range the table sends elsewhere.
2. Replace the whole import block (lines 12–84) with:

```ts
import { ProjectError } from '../errors.js';
import type { ContainerBase, LoadContext, ProtocolStorage } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import { restRequestReader, signingOf } from '../rest/storage.js';
import { readSequences } from '../sequence/load.js';
import type { WebhookCollection, WebhookFolder } from '../webhooks/model.js';
import type { FsLike } from './fs.js';
import { nodeFs, readdirIfExists } from './fs.js';
import { abs, authConfig, byOrder, exact, loadFolderContents, optional, readYaml } from './load-helpers.js';
import { migrate } from './migrate.js';
import { FORMAT_VERSION } from './model.js';
import type { Environment, Project, ProjectSettings, WssRef } from './model.js';
import {
  API_FILE,
  APIS_DIR,
  ENVIRONMENTS_DIR,
  INTERFACES_DIR,
  REQUESTS_DIR,
  WEBHOOKS_DIR,
  WEBHOOKS_FILE,
  WSS_DIR,
} from './paths.js';
import { assertSupportedKind, parseFile } from './schema-parts.js';
import {
  environmentFileSchema,
  keystoresFileSchema,
  manifestSchema,
  webhookFolderFileSchema,
  webhooksFileSchema,
  wssIncomingFileSchema,
  wssOutgoingFileSchema,
} from './schema.js';
import { KEYSTORES_PATH, MANIFEST_PATH } from './serialize.js';
```

3. Replace `LoadProjectOptions` with:

```ts
/** Options for {@link loadProject}. */
export interface LoadProjectOptions {
  readonly fs?: FsLike;
  /** The protocols the project may hold. Defaults to the built-in ones, all switched on. */
  readonly registry?: ProtocolRegistry;
}
```

4. Replace `loadProject` (and its comment) with the following. `loadEnvironments`, `loadWssRefs` and `loadWebhooks` stay above it unchanged.

```ts
/**
 * The two directories a project keeps containers in: each one's container file, the kind a file
 * without one has (the directory's first protocol), and the problem an empty directory is.
 */
const CONTAINER_DIRS = [
  { dir: INTERFACES_DIR, file: 'interface.yaml', defaultKind: 'soap', missing: 'missing-interface-file' },
  { dir: APIS_DIR, file: API_FILE, defaultKind: 'rest', missing: 'missing-api-file' },
] as const;

type ContainerLayout = (typeof CONTAINER_DIRS)[number];

/** A container file's `kind`, or `fallback` when it has none. */
function kindOf(document: unknown, fallback: string): string {
  const kind =
    typeof document === 'object' && document !== null ? (document as Record<string, unknown>)['kind'] : undefined;
  return typeof kind === 'string' ? kind : fallback;
}

/**
 * The storage that reads the container file `document`, found in `layout.dir`: the enabled module
 * its `kind` names, when that module keeps its containers in this directory.
 *
 * Anything else is refused as it was before the registry: an unknown kind by name, and a known kind
 * in the wrong directory by the schema of the directory's first protocol.
 *
 * @throws ProjectError `project-kind-not-supported`; WirebenchError `feature-disabled`
 */
function storageFor(
  registry: ProtocolRegistry,
  layout: ContainerLayout,
  document: unknown,
  relative: string,
): ProtocolStorage {
  const kind = kindOf(document, layout.defaultKind);
  const storage = registry.find(kind)?.storage;
  if (storage !== undefined && storage.dir === layout.dir) {
    return storage;
  }
  assertSupportedKind(document, relative);
  const fallback = registry.require(storage === undefined ? kind : layout.defaultKind).storage;
  if (fallback === undefined) {
    throw new ProjectError(
      'project-kind-not-supported',
      `${relative} is a "${kind}" document, which this build cannot open`,
      { details: { file: relative, kind } },
    );
  }
  return fallback;
}

/**
 * Loads the project stored in the directory `root`. Each container directory under `interfaces/`
 * and `apis/` is read by the protocol module its container file's `kind` names (spec §5.1).
 *
 * @throws ProjectError `project-not-found` when there is no `wirebench.yaml`,
 * `project-format-too-new` for a newer format version, `project-file-invalid`
 * for malformed or schema-violating YAML (with the offending file in `details`),
 * `project-kind-not-supported` for a container or request of a kind this build has no module for.
 */
export async function loadProject(root: string, options?: LoadProjectOptions): Promise<LoadResult> {
  const fs = options?.fs ?? nodeFs;
  const registry = options?.registry ?? defaultRegistry();
  const manifestDocument = await readYaml(fs, root, MANIFEST_PATH);
  if (manifestDocument === undefined) {
    throw new ProjectError('project-not-found', `No ${MANIFEST_PATH} in ${root}`, {
      details: { file: MANIFEST_PATH, root },
    });
  }
  const manifest = parseFile(manifestSchema, migrate(manifestDocument, MANIFEST_PATH), MANIFEST_PATH);

  const problems: ProjectProblem[] = [];
  const ctx: LoadContext = { fs, root, problems };
  const loaded = new Map<ProtocolStorage, ContainerBase[]>();
  const interfaceSlugs = new Set<string>();
  for (const layout of CONTAINER_DIRS) {
    for (const entry of await readdirIfExists(fs, abs(root, layout.dir))) {
      if (!entry.isDirectory) {
        continue;
      }
      const relative = `${layout.dir}/${entry.name}/${layout.file}`;
      const document = await readYaml(fs, root, relative);
      if (document === undefined) {
        problems.push({
          code: layout.missing,
          message: `Folder "${entry.name}" has no ${layout.file} and was skipped`,
          file: relative,
        });
        continue;
      }
      const storage = storageFor(registry, layout, document, relative);
      const container = await storage.load(ctx, entry.name, document);
      if (container === undefined) {
        continue;
      }
      if (layout.dir === INTERFACES_DIR) {
        interfaceSlugs.add(container.slug.toLowerCase());
      } else if (interfaceSlugs.has(container.slug.toLowerCase())) {
        // An environment's endpoint overrides are keyed by slug, so two entities sharing one would
        // make the override ambiguous. The folders never collide; the override key would. Every
        // kind of API shares one directory, so their slugs cannot collide with each other.
        problems.push({
          code: 'api-slug-conflict',
          message: `API "${container.name}" and an interface share the slug "${container.slug}"; the API was skipped`,
          file: `${APIS_DIR}/${container.slug}/${API_FILE}`,
        });
        continue;
      }
      const containers = loaded.get(storage) ?? [];
      containers.push(container);
      loaded.set(storage, containers);
    }
  }

  const keystoresDocument = await readYaml(fs, root, KEYSTORES_PATH);
  const keystores =
    keystoresDocument === undefined
      ? []
      : parseFile(keystoresFileSchema, keystoresDocument, KEYSTORES_PATH).keystores.map((k) => ({
          id: k.id,
          name: k.name,
          document: k,
        }));

  const sequenceFiles = await readSequences(fs, root);
  problems.push(...sequenceFiles.problems);

  const webhooks = await loadWebhooks(fs, root, problems);

  const core: Project = {
    formatVersion: FORMAT_VERSION,
    id: manifest.id,
    name: manifest.name,
    ...optional('description', manifest.description),
    settings: exact<ProjectSettings>(manifest.settings),
    properties: manifest.properties,
    disabledProperties: manifest.disabled ?? [],
    ...optional('activeEnvironmentId', manifest.activeEnvironmentId),
    interfaces: [],
    apis: [],
    grpcApis: [],
    wsApis: [],
    sequences: sequenceFiles.loaded.map((entry) => entry.sequence).sort(byOrder),
    ...(webhooks !== undefined ? { webhooks } : {}),
    environments: await loadEnvironments(fs, root),
    wss: {
      outgoing: await loadWssRefs(fs, root, 'outgoing'),
      incoming: await loadWssRefs(fs, root, 'incoming'),
      keystores,
    },
  };
  // A module that loaded nothing is not asked: the four built-in lists are already empty, and a
  // kind kept in `extraContainers` must not appear there when the project holds none of it.
  let project = core;
  for (const [storage, containers] of loaded) {
    project = storage.withContainers(project, containers.sort(byOrder));
  }
  return { project, problems };
}
```

What this keeps exactly as it was: the order in which directories are read (`interfaces/` then `apis/`, each in the order the file system lists it), so the order of problems; the order of everything read after the containers (keystores, sequences, webhooks, environments, outgoing, incoming), so which error a project with two bad files throws; the slug-conflict check after the API has loaded, so the API's own problems are reported before the conflict; the two missing-file problems, word for word; and `project-file-invalid` for `kind: soap` under `apis/` (it reaches REST's schema, as `apiKindOf` sent it there before).

5. In the file's header comment, keep what is there and add this paragraph before the closing `*/`:

```ts
 *
 * Core reads the manifest, environments, sequences, keystores, WS-Security references and the
 * webhook collection. A container is read by its protocol's `storage.load` (`soap/storage.ts`,
 * `rest/storage.ts`, `grpc/storage.ts`, `ws/storage.ts`), found through the registry.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/`
Expected: PASS — `load-dispatch.test.ts`, and unchanged: `roundtrip.test.ts`, `rest-format.test.ts` (including both "a kind this build does not support" cases and the `api-slug-conflict` case), `grpc-format.test.ts`, `ws-format.test.ts`, `ws-save.test.ts`, `webhooks-format.test.ts`, `webhook-signing-format.test.ts`, `scripts-format.test.ts`, `format-migration.test.ts`, `assertions-roundtrip.test.ts`.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/echo-protocol.test.ts`
Expected: PASS (it builds its project in memory; the loader is not involved yet).

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write packages/engine/src/project/load.ts packages/engine/src/project/load-helpers.ts packages/engine/src/soap/storage.ts packages/engine/src/rest/storage.ts packages/engine/src/grpc/storage.ts packages/engine/src/ws/storage.ts packages/engine/src/soap/module.ts packages/engine/src/rest/module.ts packages/engine/src/grpc/module.ts packages/engine/src/ws/module.ts packages/engine/test/unit/project/load-dispatch.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/project/load.ts packages/engine/src/project/load-helpers.ts packages/engine/src/soap/storage.ts packages/engine/src/rest/storage.ts packages/engine/src/grpc/storage.ts packages/engine/src/ws/storage.ts packages/engine/src/soap/module.ts packages/engine/src/rest/module.ts packages/engine/src/grpc/module.ts packages/engine/src/ws/module.ts packages/engine/test/unit/project/load-dispatch.test.ts
git commit -m "refactor(engine): the project loader reads each container through its protocol module (#184)"
```

---

### Task 3.3: `storage.files` and `storage.managed`, and the writer dispatches

**Files:**
- Create: `packages/engine/src/project/serialize-helpers.ts`, `packages/engine/src/project/managed-files.ts`
- Modify: `packages/engine/src/soap/storage.ts`, `packages/engine/src/rest/storage.ts`, `packages/engine/src/grpc/storage.ts`, `packages/engine/src/ws/storage.ts`
- Modify: `packages/engine/src/project/serialize.ts`, `packages/engine/src/project/save.ts`
- Modify: `packages/engine/src/project/model.ts` (`takenContainerSlugs`), `packages/engine/src/index.ts` (export it)
- Test: `packages/engine/test/unit/project/save-dispatch.test.ts` (new)

**Interfaces:**
- Consumes: the storage objects of Task 3.2; `defaultRegistry()`; `ProtocolRegistry.modules`; `unsupportedOf`, `extraContainersOf`, `Project.extraContainers` (`project/model.ts`, Task 1.1); `ContainerBase`, `ContainerDir` (`protocol/module.ts`).
- Produces:
  - `takenContainerSlugs(project: Project, dir: ContainerDir): ReadonlySet<string>` in `project/model.ts`, exported from `index.ts`: every slug in use under one container directory, in memory or as a placeholder. It is the one place that lists them; the save's live set (this task) and every host that names a new container (Task 3.4) read it.
  - `project/serialize-helpers.ts`: `authDocument(auth: AuthConfig): Record<string, unknown>`, `definitionDocument(definition: { readonly auth?: DefinitionAuth }): Record<string, unknown>`, `scriptsDocument`, `writeScriptFiles(files: Map<string, string>, dir: string, scripts: RequestScripts | undefined, slug: string): void`, `keyValueDocuments(rows: readonly KeyValueEntry[]): Record<string, unknown>[]`, `addFolderFiles`, types `FolderNode<R>`, `RequestWriter<R>`.
  - `project/managed-files.ts`: `toAbsolute(root: string, relative: string): string`, `isWsMessageSibling(name: string, requestSlug: string): boolean`, `listApiTreeFiles(fs: FsLike, root: string, dir: string): Promise<string[]>`, `apiManagedFiles(fs: FsLike, root: string, slug: string): Promise<string[]>`.
  - `files(container)` and `managed(fs, root, slug)` on all four storage objects.
  - `rest/storage.ts` also exports `writeRestRequest: RequestWriter<RestRequestDef>` and `signingDocument(signing: WebhookSigning | undefined): Record<string, unknown> | undefined`, for core's webhook writer.
  - `ProjectFilesOptions.registry?: ProtocolRegistry`, `SaveProjectOptions.registry?: ProtocolRegistry`.
  - `project/serialize.ts` still exports `authDocument` (re-exported from the helper file), `MANIFEST_PATH`, `KEYSTORES_PATH`, `ProjectFiles`, `wssRefPath`, `projectFiles`.

**The shared part goes to core.** The REST, gRPC and WebSocket trees, and the webhook collection's, are one layout: `folder.yaml`, `*.request.yaml`, and siblings named after a request slug. One writer (`addFolderFiles`) and one lister (`listApiTreeFiles`) serve all four today, and the lister claims every sibling convention (`.body.<ext>`, `.msg-<slug>.<ext>`, the script files) whatever the API's kind. Both move to core unchanged, so the set of managed files stays exactly what it was. Splitting the sibling conventions per protocol is phase 3's.

**A save never deletes what its registry cannot write** (plan ruling, spec revision R6). The live container directories are every container the project holds in memory (the four lists and every `extraContainers` entry) plus every placeholder, whatever registry the save is given. The registry decides only what is written and which files are managed: a container whose kind has no enabled module in the save's registry is treated like a placeholder, so nothing under its directory is written, managed or removed. A project loaded with every protocol on and saved through `createBuiltinRegistry({ grpc: false })` therefore leaves its gRPC APIs' directories exactly as they are. `takenContainerSlugs` is the one function that lists those slugs, so the save and the hosts that name new containers cannot disagree about which directories are taken.

**Where each part of `project/serialize.ts` goes:**

| Lines | What | Goes to |
| --- | --- | --- |
| 39–46 | `ProjectFiles`, `MANIFEST_PATH`, `KEYSTORES_PATH` | stay |
| 48–57 | `disabledList` | stays |
| 59–69 | `authDocument` | `serialize-helpers.ts`; `serialize.ts` re-exports it |
| 71–81 | `signingDocument` | `rest/storage.ts`, exported |
| 83–89 | `definitionDocument` | `serialize-helpers.ts`, exported, parameter type changed (Step 3) |
| 91–126, 128–138 | `scriptsDocument`, `writeScriptFiles` | `serialize-helpers.ts`, exported |
| 140–162 | `requestDocument` | `soap/storage.ts` |
| 164–186 | `interfaceDocument` | `soap/storage.ts` |
| 188–198 | `keyValueDocuments` | `serialize-helpers.ts`, exported |
| 200–234 | `bodyDocument` | `rest/storage.ts` |
| 236–260 | `restRequestDocument` | `rest/storage.ts` |
| 262–272, 274–275 | `FolderNode`, `RequestWriter` | `serialize-helpers.ts`, exported |
| 277–284 | `writeRestRequest` | `rest/storage.ts`, exported |
| 286–320 | `writeGrpcRequest` | `grpc/storage.ts` |
| 322–370 | `writeWsRequest` | `ws/storage.ts` |
| 372–416 | `addFolderFiles` | `serialize-helpers.ts`, exported |
| 418–439 | `addApiFiles` | `rest/storage.ts` |
| 441–473 | `addGrpcApiFiles` | `grpc/storage.ts` |
| 475–496 | `addWsApiFiles` | `ws/storage.ts` |
| 498–518 | `addWebhookFiles` | stays |
| 520–536 | `wssDocument`, `wssRefPath` | stay |
| 538–542 | `ProjectFilesOptions` | stays, gains `registry` |
| 544–637 | `projectFiles` | rewritten (Step 6); its interface loop (591–605) becomes `soapStorage.files` |

**Where each part of `project/save.ts` goes:**

| Lines | What | Goes to |
| --- | --- | --- |
| 84–86 | `toAbsolute` | `managed-files.ts`, exported; `save.ts` imports it |
| 88–192 | `listManagedFiles` | replaced by `listCoreManagedFiles` (Step 7); its `apis/` loop (131–140) becomes `apiManagedFiles`; its `interfaces/` loop (155–190) becomes `soapStorage.managed` |
| 194–210 | `isWsMessageSibling` | `managed-files.ts`, exported |
| 212–265 | `listApiTreeFiles` | `managed-files.ts`, exported |
| 267–288, 290–317 | `pruneEmptyDirs`, `refuseOverwritingForeignSequences` | stay |
| 319–404 | `saveProject` | rewritten (Step 7) |
| 406–431 | `backupStamp`, `timestampedBackupPath` | stay |

- [ ] **Step 1: Write the pinning test**

This test pins today's writer, so it passes before anything moves, except for its one use of the `registry` option.

```ts
// packages/engine/test/unit/project/save-dispatch.test.ts
/**
 * The writer and the save go through the protocol modules (spec §5.2) and produce the bytes they
 * always did: every fixture project saves to what it was loaded from, and the files of a project
 * come out in the order they always had.
 */
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { loadProject } from '../../../src/project/load.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { createBuiltinRegistry } from '../../../src/protocols.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../src/ws/model.js';
import { sampleProject, tempProjectDir } from './fixture.js';

const ENGINE_FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
const CLI_FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'cli', 'test', 'fixtures');

/** Every project folder committed as a fixture: the five format generations, and the CLI's runner project. */
const FIXTURE_PROJECTS: readonly (readonly [string, string])[] = [
  ['format-v1', join(ENGINE_FIXTURES, 'format-v1', 'project')],
  ['format-v2', join(ENGINE_FIXTURES, 'format-v2', 'project')],
  ['format-v3', join(ENGINE_FIXTURES, 'format-v3', 'project')],
  ['format-v4', join(ENGINE_FIXTURES, 'format-v4', 'project')],
  ['format-v5', join(ENGINE_FIXTURES, 'format-v5', 'project')],
  ['runner-project', join(CLI_FIXTURES, 'runner-project')],
];

function mixedProject(): Project {
  return {
    ...sampleProject(),
    apis: [
      createApi('Shop', {
        id: 'A1',
        order: 2,
        baseUrl: 'https://shop.test',
        requests: [
          createRestRequest('Create', {
            id: 'R1',
            method: 'POST',
            url: '/items',
            body: { kind: 'raw', language: 'json', text: '{\n  "name": "Fido"\n}\n' },
          }),
        ],
      }),
    ],
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'G1',
        order: 3,
        target: 'localhost:50051',
        requests: [createGrpcRequest('Hello', { id: 'GR1', service: 'demo.Greeter', method: 'SayHello' })],
      }),
    ],
    wsApis: [
      createWsApi('Chat', {
        id: 'W1',
        order: 4,
        url: 'wss://chat.test',
        requests: [
          createWsRequest('Feed', {
            id: 'WR1',
            url: '/feed',
            messages: [createWsSavedMessage('Ping', { id: 'M1', content: '{"type":"ping"}' })],
          }),
        ],
      }),
    ],
  };
}

describe('saving a fixture project', () => {
  it.each(FIXTURE_PROJECTS)('%s: the first save touches only the manifest, the second nothing', async (_name, source) => {
    const dir = await tempProjectDir();
    await cp(source, dir, { recursive: true });

    const first = await saveProject((await loadProject(dir)).project, dir);
    expect(first.written.filter((file) => file !== 'wirebench.yaml')).toEqual([]);
    expect(first.removed).toEqual([]);

    const second = await saveProject((await loadProject(dir)).project, dir);
    expect(second.written).toEqual([]);
    expect(second.removed).toEqual([]);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('the files of a project', () => {
  it('list core’s and every protocol’s in the order they always had', () => {
    const keys = [...projectFiles(mixedProject()).keys()];
    const first = (prefix: string): number => keys.findIndex((key) => key.startsWith(prefix));

    expect(keys[0]).toBe('wirebench.yaml');
    const order = ['environments/', 'interfaces/', 'apis/Shop/', 'apis/Greeter/', 'apis/Chat/', 'wss/'].map(first);
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('are the same through a registry passed in and through the default one', () => {
    const project = mixedProject();

    expect([...projectFiles(project, { registry: createBuiltinRegistry() })]).toEqual([...projectFiles(project)]);
  });

  it('a save through a registry passed in writes what the default one writes', async () => {
    const dir = await tempProjectDir();
    await saveProject(mixedProject(), dir);

    const again = await saveProject(mixedProject(), dir, { registry: createBuiltinRegistry() });

    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});
```

`createWsSavedMessage(name, input)` takes `{ id, content }`; read its signature at `packages/engine/src/ws/model.ts:290` and adjust the one call if its input names differ.

- [ ] **Step 2: Run the test against today's writer**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/save-dispatch.test.ts`
Expected: PASS for all nine cases (vitest does not type-check, and today's `projectFiles` and `saveProject` ignore the unknown `registry` option). This is the baseline; the same run must pass again after Step 7, when the option is real.

Run: `nice pnpm exec tsc -b`
Expected: FAIL — `'registry' does not exist in type 'ProjectFilesOptions'` and the same for `SaveProjectOptions`. Steps 6 and 7 fix it.

- [ ] **Step 3: Create `packages/engine/src/project/serialize-helpers.ts`**

Header, imports and the changed `definitionDocument` in full; moved in from `project/serialize.ts` with `export` added, in this order: `authDocument` (59–69, already exported), `definitionDocument` (below), `scriptsDocument` (91–126), `writeScriptFiles` (128–138), `keyValueDocuments` (188–198), `FolderNode` (262–272), `RequestWriter` (274–275), `addFolderFiles` (372–416).

```ts
/**
 * What core's writer and every protocol's `storage.files` share when they turn a project into
 * files: authentication and a definition record as written, a request's `scripts` key and script
 * files, a table row, and the request tree an API (of any protocol) and the webhook collection
 * keep under `requests/`.
 *
 * A protocol's storage imports this file and never `serialize.ts`, which imports the protocols.
 */

import { ProjectError } from '../errors.js';
import type { KeyValueEntry } from '../rest/model.js';
import { scriptFileName } from '../script/model.js';
import type { RequestScripts } from '../script/model.js';
import type { AuthConfig, DefinitionAuth } from './model.js';
import { assertPathSegment, FOLDER_FILE, MAX_FOLDER_DEPTH } from './paths.js';
import { compact, stringifyYaml } from './yaml.js';
```

```ts
/**
 * A definition record as written (REST's and WebSocket's): its own fields, with the fetch
 * credentials in the schema's spelling through {@link authDocument} — references only, like every
 * other auth.
 */
export function definitionDocument(definition: { readonly auth?: DefinitionAuth }): Record<string, unknown> {
  return compact({ ...definition, auth: definition.auth === undefined ? undefined : authDocument(definition.auth) });
}
```

Only the parameter type changed (it was `RestDefinitionRef | WsDefinitionRef`, two protocols' types in a core file); the body is the same line, and the spread still carries every field of the record it is given.

- [ ] **Step 4: Create `packages/engine/src/project/managed-files.ts`**

Header, imports and `apiManagedFiles` in full; moved in from `project/save.ts` with `export` added: `toAbsolute` (84–86), `isWsMessageSibling` (194–210), `listApiTreeFiles` (212–265).

```ts
/**
 * Which files of a request tree a save manages, and so may delete when it no longer writes them:
 * the part of `save.ts` that every protocol keeping its requests under `apis/<slug>/requests/`
 * shares, and that the webhook collection's tree uses too.
 *
 * One lister claims every sibling convention (`.body.<ext>`, `.msg-<slug>.<ext>`, the script
 * files) whatever the API's protocol, exactly as it did when `save.ts` walked `apis/` itself.
 */

import { join } from 'node:path';
import { isScriptFileOf } from '../script/model.js';
import type { FsLike } from './fs.js';
import { readFileIfExists, readdirIfExists } from './fs.js';
import { API_FILE, APIS_DIR, FOLDER_FILE, REQUEST_SUFFIX, REQUESTS_DIR } from './paths.js';
```

Add above the moved `toAbsolute`: `/** The absolute path of a `/`-separated path relative to the project root. */`.

```ts
/** The managed files of one `apis/<slug>/`: its `api.yaml` when it is there, and its request tree. */
export async function apiManagedFiles(fs: FsLike, root: string, slug: string): Promise<string[]> {
  const base = `${APIS_DIR}/${slug}`;
  const managed: string[] = [];
  if ((await readFileIfExists(fs, toAbsolute(root, `${base}/${API_FILE}`))) !== undefined) {
    managed.push(`${base}/${API_FILE}`);
  }
  managed.push(...(await listApiTreeFiles(fs, root, `${base}/${REQUESTS_DIR}`)));
  return managed;
}
```

- [ ] **Step 5: Give the four storage objects their `files` and `managed`**

**`packages/engine/src/soap/storage.ts`.** Move in `requestDocument` (140–162) and `interfaceDocument` (164–186) above `soapStorage`. Add to the imports:

```ts
import { readFileIfExists } from '../project/fs.js'; // already there from Task 3.2
import type { RequestDef } from '../project/model.js'; // add `RequestDef` to the existing type import
import { assertPathSegment, INTERFACES_DIR, OPERATIONS_DIR, REQUEST_SUFFIX } from '../project/paths.js'; // adds assertPathSegment
import { authDocument, scriptsDocument, writeScriptFiles } from '../project/serialize-helpers.js';
import { compact, stringifyYaml } from '../project/yaml.js';
import { isScriptFileOf } from '../script/model.js';
```

Replace the two stub members of `soapStorage` with:

```ts
  files(iface) {
    const files = new Map<string, string>();
    assertPathSegment(iface.slug);
    const base = `${INTERFACES_DIR}/${iface.slug}`;
    files.set(`${base}/interface.yaml`, stringifyYaml(interfaceDocument(iface)));
    for (const operation of iface.operations) {
      assertPathSegment(operation.slug);
      const dir = `${base}/${OPERATIONS_DIR}/${operation.slug}`;
      for (const request of operation.requests) {
        assertPathSegment(request.slug);
        files.set(`${dir}/${request.slug}${REQUEST_SUFFIX}`, stringifyYaml(requestDocument(request)));
        files.set(`${dir}/${request.slug}.xml`, request.envelopeXml);
        writeScriptFiles(files, dir, request.scripts, request.slug);
      }
    }
    return files;
  },

  /**
   * `interface.yaml`, every `operations/<slug>/*.request.yaml`, and the `.xml` and script files
   * that sit beside a request file of the same slug. An envelope with no request file, the
   * definition cache and anything else in the folder are not Wirebench's to delete.
   */
  async managed(fs, root, slug) {
    const managed: string[] = [];
    const base = `${INTERFACES_DIR}/${slug}`;
    const ifaceFile = `${base}/interface.yaml`;
    if ((await readFileIfExists(fs, abs(root, ifaceFile))) !== undefined) {
      managed.push(ifaceFile);
    }
    const opsDir = `${base}/${OPERATIONS_DIR}`;
    for (const opEntry of await readdirIfExists(fs, abs(root, opsDir))) {
      if (!opEntry.isDirectory) {
        continue;
      }
      const opDir = `${opsDir}/${opEntry.name}`;
      const requestSlugs = new Set<string>();
      const opFiles = await readdirIfExists(fs, abs(root, opDir));
      for (const fileEntry of opFiles) {
        if (fileEntry.isFile && fileEntry.name.endsWith(REQUEST_SUFFIX)) {
          requestSlugs.add(fileEntry.name.slice(0, -REQUEST_SUFFIX.length));
          managed.push(`${opDir}/${fileEntry.name}`);
        }
      }
      for (const fileEntry of opFiles) {
        if (fileEntry.isFile && fileEntry.name.endsWith('.xml')) {
          const requestSlug = fileEntry.name.slice(0, -'.xml'.length);
          if (requestSlugs.has(requestSlug)) {
            managed.push(`${opDir}/${fileEntry.name}`);
          }
        } else if (fileEntry.isFile && [...requestSlugs].some((known) => isScriptFileOf(fileEntry.name, known))) {
          managed.push(`${opDir}/${fileEntry.name}`);
        }
      }
    }
    return managed;
  },
```

(This is `save.ts` lines 159–189 for one interface. Two locals are renamed because `slug` is now the parameter: the inner `slug` of line 181 is `requestSlug`, and the arrow's `slug` of line 185 is `known`.)

**`packages/engine/src/rest/storage.ts`.** Move in, above `restStorage`: `signingDocument` (71–81, gains `export`), `bodyDocument` (200–234), `restRequestDocument` (236–260), `writeRestRequest` (277–284, gains `export` and the comment below), `addApiFiles` (418–439). Add to the imports:

```ts
import { apiManagedFiles } from '../project/managed-files.js';
import { restBodyFileName } from '../project/paths.js'; // add to the existing paths import
import {
  addFolderFiles,
  authDocument,
  definitionDocument,
  keyValueDocuments,
  scriptsDocument,
  writeScriptFiles,
} from '../project/serialize-helpers.js';
import type { RequestWriter } from '../project/serialize-helpers.js';
import { compact, stringifyYaml } from '../project/yaml.js';
import { RAW_LANGUAGE_EXTENSIONS } from './model.js';
```

```ts
/** A REST request as written: its document, its raw body file and its script files. Core writes the webhook collection's items with it. */
export const writeRestRequest: RequestWriter<RestRequestDef> = (files, dir, request) => {
```

Replace the two stub members of `restStorage` with:

```ts
  files(api) {
    const files = new Map<string, string>();
    addApiFiles(files, api);
    return files;
  },
  managed: (fs, root, slug) => apiManagedFiles(fs, root, slug),
```

**`packages/engine/src/grpc/storage.ts`.** Move in, above `grpcStorage`: `writeGrpcRequest` (286–320), `addGrpcApiFiles` (441–473). Add to the imports:

```ts
import { apiManagedFiles } from '../project/managed-files.js';
import { restBodyFileName } from '../project/paths.js'; // add to the existing paths import
import {
  addFolderFiles,
  authDocument,
  keyValueDocuments,
  scriptsDocument,
  writeScriptFiles,
} from '../project/serialize-helpers.js';
import type { RequestWriter } from '../project/serialize-helpers.js';
import { compact, stringifyYaml } from '../project/yaml.js';
```

Replace the two stub members of `grpcStorage` with:

```ts
  files(api) {
    const files = new Map<string, string>();
    addGrpcApiFiles(files, api);
    return files;
  },
  managed: (fs, root, slug) => apiManagedFiles(fs, root, slug),
```

**`packages/engine/src/ws/storage.ts`.** Move in, above `wsStorage`: `writeWsRequest` (322–370), `addWsApiFiles` (475–496). Add to the imports:

```ts
import { ProjectError } from '../errors.js';
import { apiManagedFiles } from '../project/managed-files.js';
import { addFolderFiles, authDocument, definitionDocument, keyValueDocuments } from '../project/serialize-helpers.js';
import type { RequestWriter } from '../project/serialize-helpers.js';
import { compact, stringifyYaml } from '../project/yaml.js';
import { wsMessageFileName } from './model.js';
```

Replace the two stub members of `wsStorage` with:

```ts
  files(api) {
    const files = new Map<string, string>();
    addWsApiFiles(files, api);
    return files;
  },
  managed: (fs, root, slug) => apiManagedFiles(fs, root, slug),
```

`writeWsRequest` refuses two messages of one slug by asking `files.has(…)`. The map it asks is now the API's own and not the whole project's; the paths it checks are inside the API's directory, so the answer is the same.

- [ ] **Step 6: Rewrite `packages/engine/src/project/serialize.ts`**

1. Delete every range the table sends elsewhere.
2. Replace the import block (lines 9–37) with:

```ts
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import type { RestRequestDef } from '../rest/model.js';
import { signingDocument, writeRestRequest } from '../rest/storage.js';
import { sequenceDocument, sequenceFilePath } from '../sequence/file.js';
import type { WebhookCollection, WebhookFolder } from '../webhooks/model.js';
import type { Project, PropertyMap, WssRef } from './model.js';
import {
  assertPathSegment,
  assertWssRelativePath,
  ENVIRONMENTS_DIR,
  REQUESTS_DIR,
  slugify,
  WEBHOOKS_DIR,
  WEBHOOKS_FILE,
  WSS_DIR,
} from './paths.js';
import { addFolderFiles, authDocument } from './serialize-helpers.js';
import { compact, stringifyYaml } from './yaml.js';

export { authDocument } from './serialize-helpers.js';
```

3. Replace `ProjectFilesOptions` and `projectFiles` with:

```ts
/** Options for {@link projectFiles}. */
export interface ProjectFilesOptions {
  /** Recorded in the manifest as `writtenBy`. Defaults to `'wirebench'`. */
  readonly writer?: string;
  /** The protocols whose containers are written. Defaults to the built-in ones, all switched on. */
  readonly registry?: ProtocolRegistry;
}

/**
 * Builds the complete `relative path -> content` map for a project: core's own files, and every
 * enabled module's `storage.files` for each of its containers (spec §5.2).
 *
 * Every slug is validated with {@link assertPathSegment} (and every
 * `WssRef.file` with {@link assertWssRelativePath}) before any path is built,
 * so a corrupted slug or an unvalidated file reference throws
 * `ProjectError('project-path-invalid')` here — before `saveProject` ever
 * touches the file system.
 */
export function projectFiles(project: Project, options?: ProjectFilesOptions): ProjectFiles {
  const files = new Map<string, string>();
  const writer = options?.writer ?? 'wirebench';
  const registry = options?.registry ?? defaultRegistry();

  files.set(
    MANIFEST_PATH,
    stringifyYaml(
      compact({
        formatVersion: project.formatVersion,
        id: project.id,
        name: project.name,
        description: project.description,
        settings: compact({ ...project.settings }),
        properties: { ...project.properties },
        disabled: disabledList(project.disabledProperties, project.properties),
        activeEnvironmentId: project.activeEnvironmentId,
        writtenBy: writer,
      }),
    ),
  );

  for (const environment of project.environments) {
    assertPathSegment(environment.slug);
    files.set(
      `${ENVIRONMENTS_DIR}/${environment.slug}.yaml`,
      stringifyYaml(
        compact({
          id: environment.id,
          name: environment.name,
          order: environment.order,
          endpoints: { ...environment.endpoints },
          properties: { ...environment.properties },
          disabled: disabledList(environment.disabledProperties, environment.properties),
        }),
      ),
    );
  }

  // In registration order, which is the order these files always had: interfaces, then each kind
  // of API.
  for (const module of registry.modules) {
    const storage = module.storage;
    if (storage === undefined) {
      continue;
    }
    for (const container of storage.containers(project)) {
      for (const [relative, content] of storage.files(container)) {
        files.set(relative, content);
      }
    }
  }

  for (const sequence of project.sequences) {
    assertPathSegment(sequence.slug);
    files.set(sequenceFilePath(sequence.slug), sequenceDocument(sequence));
  }
  if (project.webhooks !== undefined) {
    addWebhookFiles(files, project.webhooks);
  }

  for (const [direction, refs] of [
    ['outgoing', project.wss.outgoing],
    ['incoming', project.wss.incoming],
  ] as const) {
    for (const ref of refs) {
      files.set(wssRefPath(direction, ref), wssDocument(ref));
    }
  }
  if (project.wss.keystores.length > 0) {
    files.set(KEYSTORES_PATH, stringifyYaml({ keystores: project.wss.keystores.map((k) => k.document) }));
  }

  return files;
}
```

`addWebhookFiles` (498–518) stays as it is; its `writeRestRequest` and `signingDocument` now come from `rest/storage.ts`.

- [ ] **Step 7: Rewrite `packages/engine/src/project/save.ts`**

First the helper the save's live set is read from. In `packages/engine/src/project/model.ts`, after `extraContainersOf` (add `ContainerDir` to the file's type import from `../protocol/module.js`, which has brought `ContainerBase` since Task 1.1):

```ts
/**
 * Every slug in use under one of the two container directories: the containers the project holds
 * there, and the placeholders (spec §6). A save keeps exactly these directories, whatever its
 * registry can write. Hand it to `uniqueSlug` when naming a new container, so a save never has to
 * refuse it with `container-slug-conflict`.
 */
export function takenContainerSlugs(project: Project, dir: ContainerDir): ReadonlySet<string> {
  const containers: readonly ContainerBase[] =
    dir === 'interfaces'
      ? project.interfaces
      : [
          ...project.apis,
          ...project.grpcApis,
          ...project.wsApis,
          ...Object.values(project.extraContainers ?? {}).flat(),
        ];
  return new Set([
    ...containers.map((container) => container.slug),
    ...unsupportedOf(project)
      .filter((placeholder) => placeholder.dir === dir)
      .map((placeholder) => placeholder.slug),
  ]);
}
```

(Every kind but SOAP keeps its containers under `apis/`, spec §3.2, so `extraContainers` count there.)

In `packages/engine/src/index.ts`, add `takenContainerSlugs,` to the value export block of `./project/model.js`.

Then `save.ts`:

1. Delete `toAbsolute`, `listManagedFiles`, `isWsMessageSibling` and `listApiTreeFiles`.
2. Replace the import block (lines 14–36) with:

```ts
import { dirname } from 'node:path';
import { ProjectError } from '../errors.js';
import type { ContainerDir } from '../protocol/module.js';
import type { ProtocolRegistry } from '../protocol/registry.js';
import { defaultRegistry } from '../protocols.js';
import { SEQUENCES_DIR } from '../sequence/file.js';
import { readSequences } from '../sequence/load.js';
import type { FsLike } from './fs.js';
import { nodeFs, readFileIfExists, readdirIfExists, writeFileAtomic } from './fs.js';
import { listApiTreeFiles, toAbsolute } from './managed-files.js';
import { takenContainerSlugs } from './model.js';
import type { Project } from './model.js';
import { APIS_DIR, ENVIRONMENTS_DIR, INTERFACES_DIR, REQUESTS_DIR, WEBHOOKS_DIR, WEBHOOKS_FILE, WSS_DIR } from './paths.js';
import type { ProjectFiles } from './serialize.js';
import { KEYSTORES_PATH, MANIFEST_PATH, projectFiles } from './serialize.js';
```

3. Add to `SaveProjectOptions`, after `writer`:

```ts
  /**
   * The protocols this save can write: their containers are what is written, and their files what
   * is managed. A container the project holds whose kind has no enabled module here is left on
   * disk exactly as it is, as a placeholder is. Defaults to the built-in ones, all switched on.
   */
  readonly registry?: ProtocolRegistry;
```

4. In place of `listManagedFiles`:

```ts
/**
 * Lists the files core itself manages under `root` — every file that matches one of these
 * patterns:
 *
 * - `wirebench.yaml`
 * - `environments/*.yaml`
 * - `wss/{outgoing,incoming}/*.yaml`
 * - `wss/keystores.yaml`
 * - `webhooks/webhooks.yaml`
 * - `webhooks/requests/**` (the collection's own request tree, same layout as an API's)
 * - the `sequences/*.sequence.yaml` this build loaded
 *
 * A container's files are its protocol's to list (`storage.managed`). Anything else on disk — a
 * README, a `.gitkeep`, notes — is a foreign file and is never a deletion candidate, even when it
 * sits inside a directory Wirebench otherwise manages.
 */
async function listCoreManagedFiles(fs: FsLike, root: string): Promise<string[]> {
  const managed: string[] = [];
  if ((await readFileIfExists(fs, toAbsolute(root, MANIFEST_PATH))) !== undefined) {
    managed.push(MANIFEST_PATH);
  }

  for (const entry of await readdirIfExists(fs, toAbsolute(root, ENVIRONMENTS_DIR))) {
    if (entry.isFile && entry.name.endsWith('.yaml')) {
      managed.push(`${ENVIRONMENTS_DIR}/${entry.name}`);
    }
  }

  for (const direction of ['outgoing', 'incoming'] as const) {
    const dir = `${WSS_DIR}/${direction}`;
    for (const entry of await readdirIfExists(fs, toAbsolute(root, dir))) {
      if (entry.isFile && entry.name.endsWith('.yaml')) {
        managed.push(`${dir}/${entry.name}`);
      }
    }
  }
  if ((await readFileIfExists(fs, toAbsolute(root, KEYSTORES_PATH))) !== undefined) {
    managed.push(KEYSTORES_PATH);
  }

  // The request tree is managed only beside its `webhooks.yaml`, as an API's is beside its `api.yaml`.
  const webhooksFile = `${WEBHOOKS_DIR}/${WEBHOOKS_FILE}`;
  if ((await readFileIfExists(fs, toAbsolute(root, webhooksFile))) !== undefined) {
    managed.push(webhooksFile);
    managed.push(...(await listApiTreeFiles(fs, root, `${WEBHOOKS_DIR}/${REQUESTS_DIR}`)));
  }

  // Only the sequence files this build loaded: one it refused (too new, malformed, a duplicate id) is
  // foreign, so a save can never delete a sequence the user has not seen (`sequence/load.ts`).
  for (const { file } of (await readSequences(fs, root)).loaded) {
    managed.push(file);
  }
  return managed;
}
```

5. Replace `saveProject` with:

```ts
/**
 * Saves `project` into the directory `root`, creating it if needed.
 *
 * @returns which files were written, removed and left untouched.
 */
export async function saveProject(project: Project, root: string, options?: SaveProjectOptions): Promise<SaveResult> {
  const fs = options?.fs ?? nodeFs;
  const registry = options?.registry ?? defaultRegistry();
  const desired = projectFiles(project, {
    registry,
    ...(options?.writer !== undefined ? { writer: options.writer } : {}),
  });

  // Which container directories are alive: every container the project holds and every placeholder,
  // whatever this save's registry can write (spec R6). A save never deletes what it cannot write.
  const live: Record<ContainerDir, ReadonlySet<string>> = {
    interfaces: takenContainerSlugs(project, 'interfaces'),
    apis: takenContainerSlugs(project, 'apis'),
  };
  // What this save may delete: core's own files, then each module's word on each of its containers
  // (spec §5.2). A container no enabled module answers for has no managed file, so nothing under
  // its directory is removed, and `projectFiles` wrote nothing for it.
  const existing = await listCoreManagedFiles(fs, root);
  for (const module of registry.modules) {
    const storage = module.storage;
    if (storage === undefined) {
      continue;
    }
    for (const container of storage.containers(project)) {
      existing.push(...(await storage.managed(fs, root, container.slug)));
    }
  }
  await refuseOverwritingForeignSequences(fs, root, desired, existing);

  const backupsWritten: string[] = [];
  for (const backup of options?.backups ?? []) {
    if (!backup.endsWith('.xml.bak')) {
      continue;
    }
    const source = backup.slice(0, -'.bak'.length);
    const current = await readFileIfExists(fs, toAbsolute(root, source));
    if (current === undefined) {
      continue;
    }
    const timestamped = await timestampedBackupPath(fs, root, backup, options?.now ?? (() => new Date()));
    await writeFileAtomic(fs, toAbsolute(root, timestamped), current);
    backupsWritten.push(timestamped);
  }

  const written: string[] = [];
  const unchanged: string[] = [];
  for (const [relative, content] of desired) {
    const absolute = toAbsolute(root, relative);
    const previous =
      options?.previous?.get(relative) ??
      (options?.previous !== undefined ? undefined : (await readFileIfExists(fs, absolute))?.toString('utf8'));
    if (previous === content) {
      unchanged.push(relative);
      continue;
    }
    await writeFileAtomic(fs, absolute, Buffer.from(content, 'utf8'));
    written.push(relative);
  }

  const removed: string[] = [];
  const touchedDirs = new Set<string>();

  // A deleted interface or API takes its whole folder with it, definition cache included.
  const goneEntities = new Set<string>();
  for (const dir of [INTERFACES_DIR, APIS_DIR] as const) {
    for (const entry of await readdirIfExists(fs, toAbsolute(root, dir))) {
      if (entry.isDirectory && !live[dir].has(entry.name)) {
        const relative = `${dir}/${entry.name}`;
        await fs.rm(toAbsolute(root, relative), { recursive: true, force: true });
        removed.push(relative);
        goneEntities.add(`${relative}/`);
      }
    }
  }

  for (const relative of existing) {
    if (desired.has(relative) || [...goneEntities].some((prefix) => relative.startsWith(prefix))) {
      continue;
    }
    await fs.rm(toAbsolute(root, relative), { force: true });
    removed.push(relative);
    const parent = dirname(relative);
    if (parent !== '.' && parent !== '') {
      touchedDirs.add(parent);
    }
  }
  removed.push(...(await pruneEmptyDirs(fs, root, touchedDirs)));

  written.sort();
  removed.sort();
  unchanged.sort();
  backupsWritten.sort();
  return { written, removed, unchanged, backups: backupsWritten };
}
```

Why the result is the same. With the default registry every container in memory belongs to an enabled module, so the live set is what it was: the slugs of `project.interfaces` under `interfaces/`, and those of the three API lists under `apis/` (no placeholder exists before Task 3.4, and the built-in kinds keep nothing in `extraContainers`). The old lister walked every directory under `interfaces/` and `apis/`; the new one asks only about the directories of live containers. The difference is the managed files of a directory that is not live, and those were never used: the directory is removed whole and its files are skipped by the `goneEntities` test. `projectFiles` still runs before anything is read or written, so a slug that would escape the root is refused before `storage.managed` is ever given it.

6. In the file's header comment, replace `Only Wirebench's own subtrees are managed.` with `Only Wirebench's own subtrees are managed: core lists its own files, and each protocol module lists those of its containers.`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/`
Expected: PASS. `save-dispatch.test.ts` passes as it did in Step 2. The existing tests that prove the output is byte-identical, all unchanged:
- `roundtrip.test.ts`: "writes the documented folder layout", "writes envelopes byte-exactly, CRLF and trailing space included", "emits YAML with stable, sorted key order and no line wrapping", "leaves a re-save of an unchanged project entirely untouched", "rewrites exactly the two files of a renamed request", "removes exactly the two files of a deleted request", "leaves foreign files inside managed directories untouched by a save", "deletes a removed interface folder, definition cache included, and never touches a live one", "prunes an operation folder once its last request is deleted", "survives a second save/load cycle without touching a file", "rejects a slug that would escape the project root, before touching disk".
- `rest-format.test.ts`: "puts every API, folder, request and raw body where the format says", "is byte-stable: saving what was loaded changes nothing", "renaming a request touches exactly its two files", "deleting an API takes its whole folder, definition cache included", "leaves a foreign file inside an API alone".
- `grpc-format.test.ts`: "puts the API beside the REST one, with kind: grpc at the top of every file it owns", "is byte-stable: saving what was loaded changes nothing".
- `ws-format.test.ts`: "round-trips a WebSocket API byte-identically", "serialises exactly as before this task", "makes serializeProject throw duplicate-slug for two messages with the same slug", "leaves the committed format-v3 fixture byte-identical but for its formatVersion line".
- `ws-save.test.ts`: all five.
- `webhooks-format.test.ts`: "round-trips, byte-stable", "removes the files when the collection goes", "leaves a webhooks/requests tree alone when there is no webhooks.yaml".
- `scripts-format.test.ts`, `format-migration.test.ts`, `backups.test.ts`, `assertions-roundtrip.test.ts`, `webhook-signing-format.test.ts`: all.

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/` and `nice pnpm vitest run --project desktop apps/desktop/test/project-host.test.ts`
Expected: PASS (both save through the default registry).

- [ ] **Step 9: Commit**

```bash
pnpm exec prettier --write packages/engine/src/project/serialize.ts packages/engine/src/project/serialize-helpers.ts packages/engine/src/project/save.ts packages/engine/src/project/managed-files.ts packages/engine/src/project/model.ts packages/engine/src/index.ts packages/engine/src/soap/storage.ts packages/engine/src/rest/storage.ts packages/engine/src/grpc/storage.ts packages/engine/src/ws/storage.ts packages/engine/test/unit/project/save-dispatch.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/project/serialize.ts packages/engine/src/project/serialize-helpers.ts packages/engine/src/project/save.ts packages/engine/src/project/managed-files.ts packages/engine/src/project/model.ts packages/engine/src/index.ts packages/engine/src/soap/storage.ts packages/engine/src/rest/storage.ts packages/engine/src/grpc/storage.ts packages/engine/src/ws/storage.ts packages/engine/test/unit/project/save-dispatch.test.ts
git commit -m "refactor(engine): the project writer and the save go through the protocol modules (#184)"
```

---

### Task 3.4: Placeholders

**Files:**
- Modify: `packages/engine/src/project/load.ts` (`ProjectProblem`, `storageFor`, `loadProject`; new `placeholderOf`, `unsupportedProblem`)
- Modify: `packages/engine/src/project/serialize.ts` (`projectFiles`: the webhook collection)
- Modify: `packages/engine/src/project/save.ts` (`listCoreManagedFiles`, `saveProject`; new `refusePlaceholderConflicts`)
- Modify: `packages/engine/src/project/paths.ts` (`WEBHOOKS_FEATURE`)
- Modify: `apps/desktop/src/main/project-rest-mutations.ts`, `project-grpc-mutations.ts`, `project-ws-mutations.ts`, `project-host.ts`
- Modify: `packages/cli/src/ops/items.ts`, `packages/cli/src/ops/import.ts`
- Modify: `packages/engine/test/unit/project/rest-format.test.ts` (one case, see Step 9)
- Test: `packages/engine/test/unit/project/placeholders.test.ts` (new), `packages/cli/test/unit/ops/items.test.ts` (new), `apps/desktop/test/placeholder-slugs.test.ts` (new)

**Interfaces:**
- Consumes: `UnsupportedContainer`, `unsupportedOf`, `extraContainersOf` (`project/model.ts`); `takenContainerSlugs(project, dir)` (`project/model.ts`, exported from `index.ts`, Task 3.3) and the live set `saveProject` reads from it; `ProtocolRegistry.status`, `.find`, `.features`; `createBuiltinRegistry`, `BUILTIN_PROTOCOLS`, `SCRIPTS_FEATURE`; `defineProtocol`, `createProtocolRegistry`.
- Produces:
  - `ProjectProblem['code']` gains `'container-unsupported'`; `ProjectProblem.details?: Readonly<Record<string, unknown>>` (spec §9: `kind`, `reason`, `dir`, `slug`).
  - `loadProject` sets `project.unsupported` (sorted by `dir`, then `slug`) when there is at least one placeholder, and leaves the field absent otherwise.
  - `saveProject` throws `ProjectError` `container-slug-conflict` with `details: { dir, slug, kind, reason }`.
  - every host site that names a new container reads `takenContainerSlugs` (desktop and CLI, Step 8).
  - `WEBHOOKS_FEATURE = 'rest'` in `project/paths.ts`.
  - CLI: `resolveItem` throws `OpsError` `unsupported-kind` for a reference into a placeholder, naming the kind and the reason.

**Slug allocation: what is there today.** The engine has no helper that chooses a container's slug. It has `uniqueSlug(name, taken)` (`project/paths.ts:93`), and every host builds `taken` itself:

| Site | `taken` today |
| --- | --- |
| `apps/desktop/src/main/project-rest-mutations.ts:414` (`addApi`) | `apis` + `interfaces` |
| `apps/desktop/src/main/project-rest-mutations.ts:426–429` (`updateApi`) | `apis` but this one + `interfaces` |
| `apps/desktop/src/main/project-grpc-mutations.ts:61–67` (`takenApiSlugs`, used at 173 and 192) | `apis` + `grpcApis` but this one + `interfaces` |
| `apps/desktop/src/main/project-ws-mutations.ts:79–86` (`takenApiSlugs`, used at 194, 211 and `project-host.ts:3096`) | `apis` + `grpcApis` + `wsApis` but this one + `interfaces` |
| `apps/desktop/src/main/project-host.ts:2070–2074` (gRPC import) | `apis` + `grpcApis` + `interfaces` |
| `apps/desktop/src/main/project-host.ts:2653` (`addInterface`) | `interfaces` |
| `apps/desktop/src/main/project-host.ts:2774` (`importLegacyProject`) | `interfaces` |
| `apps/desktop/src/main/project-host.ts:3037–3040` (OpenAPI import) | `apis` + `interfaces` |
| `packages/cli/src/ops/import.ts:192` (WSDL import) | `interfaces` |
| `packages/cli/src/ops/import.ts:257` (OpenAPI import) | `apis` + `interfaces` |

Task 3.3 added the engine helper (`takenContainerSlugs`, which the save's live set also reads); this task points every site at it. One consequence besides placeholders: every `apis/` site now avoids the slugs of all API kinds. Today REST's two sites do not look at gRPC or WebSocket APIs, and gRPC's do not look at WebSocket ones, although all three share `apis/` and a clash would put two `api.yaml` in one directory. No existing test creates that clash.

**Decisions where the spec is silent:**
- A placeholder under `apis/` is kept even when an interface has its slug. The `api-slug-conflict` rule skips a loaded API; skipping a placeholder would leave its directory out of the live set and the next save would delete it.
- A disabled kind is `feature-disabled` whichever directory it is found in: the registry does not show a disabled module, so its directory cannot be checked.
- The slug comparison of `container-slug-conflict` ignores case, as `uniqueSlug` does: on macOS and Windows `apis/Graph` and `apis/graph` are one directory.
- The loader leaves `project.unsupported` absent when there is none (plan ruling: absent means none), so every existing `toEqual` on a loaded project still holds.

- [ ] **Step 1: Write the failing engine test**

```ts
// packages/engine/test/unit/project/placeholders.test.ts
/**
 * A container whose kind has no enabled module in its directory loads as a placeholder with a
 * problem, and its directory survives a save byte for byte (spec §6).
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { nodeFs } from '../../../src/project/fs.js';
import type { FsLike } from '../../../src/project/fs.js';
import { loadProject } from '../../../src/project/load.js';
import { createProject, extraContainersOf, takenContainerSlugs, unsupportedOf } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { uniqueSlug } from '../../../src/project/paths.js';
import { saveProject } from '../../../src/project/save.js';
import { defineProtocol } from '../../../src/protocol/module.js';
import type { ContainerBase, ProtocolStorage } from '../../../src/protocol/module.js';
import { createProtocolRegistry } from '../../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, createBuiltinRegistry, SCRIPTS_FEATURE } from '../../../src/protocols.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createWebhookCollection } from '../../../src/webhooks/model.js';
import { tempProjectDir } from './fixture.js';

/** One REST API and one gRPC API, both with a request. */
function baseProject(): Project {
  return {
    ...createProject('Placeholders', { id: 'P1' }),
    apis: [
      createApi('Shop', {
        id: 'A1',
        order: 0,
        baseUrl: 'https://shop.test',
        requests: [createRestRequest('List', { id: 'R1', url: '/items' })],
      }),
    ],
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'G1',
        order: 1,
        target: 'localhost:50051',
        requests: [
          createGrpcRequest('Hello', {
            id: 'GR1',
            service: 'demo.Greeter',
            method: 'SayHello',
            message: '{\n  "name": "abc123def456ghi789"\n}\n',
          }),
        ],
      }),
    ],
  };
}

/** Writes `apis/Graph/`, a container of a kind no built-in module has, with files a loader would choke on. */
async function addGraph(dir: string): Promise<void> {
  const graph = join(dir, 'apis', 'Graph');
  await mkdir(join(graph, 'requests'), { recursive: true });
  await writeFile(join(graph, 'api.yaml'), 'kind: graphql\nid: GQ1\nname: Graph\norder: 7\nendpoint: https://graph.test/\n');
  await writeFile(join(graph, 'requests', 'Query.request.yaml'), 'kind: graphql\nid: Q1\nname: Query\n');
  await writeFile(join(graph, 'requests', 'broken.request.yaml'), ': : not yaml [\n');
  await writeFile(join(graph, 'notes.txt'), 'kept\r\nas it is \r\n');
}

/** Every directory and every file below `dir`, the files as base64 of their bytes. */
async function snapshot(dir: string, prefix = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.set(`${relative}/`, '');
      for (const [path, bytes] of await snapshot(join(dir, entry.name), relative)) {
        out.set(path, bytes);
      }
    } else {
      out.set(relative, (await readFile(join(dir, entry.name))).toString('base64'));
    }
  }
  return out;
}

/** A module for the `graphql` kind that keeps only what every container has, to stand for "the module is back". */
interface GraphApi extends ContainerBase {
  readonly kind: 'graphql';
}

const graphStorage: ProtocolStorage<GraphApi> = {
  dir: 'apis',
  load(_ctx, slug, document) {
    const file = document as { readonly id: string; readonly name: string; readonly order: number };
    return Promise.resolve({ kind: 'graphql', id: file.id, name: file.name, slug, order: file.order });
  },
  files: () => new Map<string, string>(),
  managed: () => Promise.resolve([]),
  containers: (project) => extraContainersOf(project, 'graphql') as readonly GraphApi[],
  withContainers: (project, containers) => ({
    ...project,
    extraContainers: { ...project.extraContainers, graphql: containers },
  }),
};

const withGraph = createProtocolRegistry(
  [
    ...BUILTIN_PROTOCOLS,
    defineProtocol({
      kind: 'graphql',
      feature: { id: 'graphql', title: 'GraphQL', default: true, stage: 'experimental', requires: [] },
      storage: graphStorage,
    }),
  ],
  { features: [SCRIPTS_FEATURE] },
);

describe('a container of an unknown kind', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempProjectDir();
    await saveProject(baseProject(), dir);
    await addGraph(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads as a placeholder with a problem, and the rest of the project loads', async () => {
    const { project, problems } = await loadProject(dir);

    expect(project.apis.map((api) => api.slug)).toEqual(['Shop']);
    expect(project.grpcApis.map((api) => api.slug)).toEqual(['Greeter']);
    expect(unsupportedOf(project)).toEqual([
      { dir: 'apis', slug: 'Graph', kind: 'graphql', reason: 'unknown-kind', name: 'Graph', order: 7 },
    ]);
    expect(problems).toEqual([
      {
        code: 'container-unsupported',
        message:
          'apis/Graph/api.yaml is a "graphql" container, and this build has no such protocol for apis/; it was not loaded and is left as it is',
        file: 'apis/Graph/api.yaml',
        details: { kind: 'graphql', reason: 'unknown-kind', dir: 'apis', slug: 'Graph' },
      },
    ]);
  });

  it('reads nothing under the directory but its container file', async () => {
    const touched: string[] = [];
    const graph = join(dir, 'apis', 'Graph');
    const fs: FsLike = {
      ...nodeFs,
      readFile: (path) => {
        touched.push(path);
        return nodeFs.readFile(path);
      },
      readdir: (path) => {
        touched.push(path);
        return nodeFs.readdir(path);
      },
    };

    await loadProject(dir, { fs });

    expect(touched.filter((path) => path.startsWith(graph))).toEqual([join(graph, 'api.yaml')]);
  });

  it('takes the name and the order only when they are a string and a number', async () => {
    await writeFile(join(dir, 'apis', 'Graph', 'api.yaml'), 'kind: graphql\nname: 5\norder: soon\n');

    const { project } = await loadProject(dir);

    expect(unsupportedOf(project)).toEqual([{ dir: 'apis', slug: 'Graph', kind: 'graphql', reason: 'unknown-kind' }]);
  });

  it('is left byte-identical by a save that writes elsewhere', async () => {
    const before = await snapshot(join(dir, 'apis', 'Graph'));
    const { project } = await loadProject(dir);

    const result = await saveProject(
      { ...project, apis: project.apis.map((api) => ({ ...api, name: 'Shop, renamed' })) },
      dir,
    );

    expect(result.written).toEqual(['apis/Shop/api.yaml']);
    expect(result.removed).toEqual([]);
    expect(await snapshot(join(dir, 'apis', 'Graph'))).toEqual(before);
  });

  it('refuses a save that would put a container in its directory', async () => {
    const before = await snapshot(dir);
    const { project } = await loadProject(dir);

    for (const name of ['Graph', 'graph']) {
      const clashing = { ...project, apis: [...project.apis, createApi(name, { id: 'A9', order: 9 })] };
      await expect(saveProject(clashing, dir)).rejects.toMatchObject({
        name: 'ProjectError',
        code: 'container-slug-conflict',
        details: { dir: 'apis', slug: name, kind: 'graphql', reason: 'unknown-kind' },
      });
    }
    expect(await snapshot(dir)).toEqual(before);
  });

  it('is a slug the engine’s helper steers a new container around', async () => {
    const { project } = await loadProject(dir);

    expect([...takenContainerSlugs(project, 'apis')].sort()).toEqual(['Graph', 'Greeter', 'Shop']);
    expect([...takenContainerSlugs(project, 'interfaces')]).toEqual([]);
    expect(uniqueSlug('Graph', takenContainerSlugs(project, 'apis'))).toBe('Graph-2');
  });

  it('is a container again once a module for its kind is registered', async () => {
    const { project, problems } = await loadProject(dir, { registry: withGraph });

    expect(problems).toEqual([]);
    expect(unsupportedOf(project)).toEqual([]);
    expect(extraContainersOf(project, 'graphql')).toEqual([
      { kind: 'graphql', id: 'GQ1', name: 'Graph', slug: 'Graph', order: 7 },
    ]);
  });
});

describe('a container whose protocol is switched off', () => {
  const grpcOff = createBuiltinRegistry({ grpc: false });
  let dir: string;

  beforeEach(async () => {
    dir = await tempProjectDir();
    await saveProject(baseProject(), dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads as a placeholder that says so', async () => {
    const { project, problems } = await loadProject(dir, { registry: grpcOff });

    expect(project.grpcApis).toEqual([]);
    expect(project.apis.map((api) => api.slug)).toEqual(['Shop']);
    expect(unsupportedOf(project)).toEqual([
      { dir: 'apis', slug: 'Greeter', kind: 'grpc', reason: 'feature-disabled', name: 'Greeter', order: 1 },
    ]);
    expect(problems).toEqual([
      {
        code: 'container-unsupported',
        message:
          'apis/Greeter/api.yaml is a "grpc" container, and that protocol is switched off; it was not loaded and is left as it is',
        file: 'apis/Greeter/api.yaml',
        details: { kind: 'grpc', reason: 'feature-disabled', dir: 'apis', slug: 'Greeter' },
      },
    ]);
  });

  it('is left byte-identical by a save, and loads whole again with the switch back', async () => {
    const before = await snapshot(join(dir, 'apis', 'Greeter'));
    const { project } = await loadProject(dir, { registry: grpcOff });

    const result = await saveProject(
      { ...project, apis: project.apis.map((api) => ({ ...api, name: 'Shop, renamed' })) },
      dir,
      { registry: grpcOff },
    );

    expect(result.written).toEqual(['apis/Shop/api.yaml']);
    expect(result.removed).toEqual([]);
    expect(await snapshot(join(dir, 'apis', 'Greeter'))).toEqual(before);

    const back = await loadProject(dir);
    expect(back.problems).toEqual([]);
    expect(unsupportedOf(back.project)).toEqual([]);
    expect(back.project.grpcApis).toEqual(baseProject().grpcApis);
  });

  it('is left byte-identical by a save whose registry cannot write it, though the project holds it in memory', async () => {
    const before = await snapshot(join(dir, 'apis', 'Greeter'));
    // Loaded with every protocol on: the gRPC API is a container in memory, not a placeholder.
    const { project } = await loadProject(dir);
    expect(project.grpcApis.map((api) => api.slug)).toEqual(['Greeter']);
    expect(unsupportedOf(project)).toEqual([]);

    const result = await saveProject(
      {
        ...project,
        apis: project.apis.map((api) => ({ ...api, name: 'Shop, renamed' })),
        grpcApis: project.grpcApis.map((api) => ({ ...api, name: 'Greeter, renamed' })),
      },
      dir,
      { registry: grpcOff },
    );

    // A save never deletes what its registry cannot write (spec R6): nothing of the gRPC API is
    // written, managed or removed.
    expect(result.written).toEqual(['apis/Shop/api.yaml']);
    expect(result.removed).toEqual([]);
    expect(await snapshot(join(dir, 'apis', 'Greeter'))).toEqual(before);
  });
});

describe('a kind in the wrong directory', () => {
  it('is a placeholder of an unknown kind, in either directory', async () => {
    const dir = await tempProjectDir();
    await saveProject(baseProject(), dir);
    await mkdir(join(dir, 'interfaces', 'Wrong'), { recursive: true });
    await writeFile(join(dir, 'interfaces', 'Wrong', 'interface.yaml'), 'kind: rest\nid: X1\nname: Wrong\norder: 3\n');
    await mkdir(join(dir, 'apis', 'Soapy'), { recursive: true });
    await writeFile(join(dir, 'apis', 'Soapy', 'api.yaml'), 'kind: soap\nid: X2\nname: Soapy\norder: 4\n');

    const { project, problems } = await loadProject(dir);

    expect(unsupportedOf(project)).toEqual([
      { dir: 'apis', slug: 'Soapy', kind: 'soap', reason: 'unknown-kind', name: 'Soapy', order: 4 },
      { dir: 'interfaces', slug: 'Wrong', kind: 'rest', reason: 'unknown-kind', name: 'Wrong', order: 3 },
    ]);
    expect(problems.map((problem) => problem.file).sort()).toEqual([
      'apis/Soapy/api.yaml',
      'interfaces/Wrong/interface.yaml',
    ]);
    expect(project.interfaces).toEqual([]);

    const result = await saveProject(project, dir);
    expect(result.removed).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('the webhook collection with REST switched off', () => {
  it('is not loaded, not written and not deleted, and is back with the switch', async () => {
    const restOff = createBuiltinRegistry({ rest: false });
    const dir = await tempProjectDir();
    const withHooks: Project = {
      ...baseProject(),
      webhooks: createWebhookCollection({
        target: 'https://hooks.test',
        requests: [
          createRestRequest('order.created', {
            id: 'H1',
            slug: 'order-created',
            method: 'POST',
            url: '/orders',
            body: { kind: 'raw', language: 'json', text: '{ "event": "order.created" }' },
          }),
        ],
      }),
    };
    await saveProject(withHooks, dir);
    const before = await snapshot(join(dir, 'webhooks'));

    const { project } = await loadProject(dir, { registry: restOff });
    expect(project.webhooks).toBeUndefined();
    expect(unsupportedOf(project).map((placeholder) => [placeholder.slug, placeholder.reason])).toEqual([
      ['Shop', 'feature-disabled'],
    ]);

    const result = await saveProject(
      { ...project, grpcApis: project.grpcApis.map((api) => ({ ...api, name: 'Greeter, renamed' })) },
      dir,
      { registry: restOff },
    );
    expect(result.written).toEqual(['apis/Greeter/api.yaml']);
    expect(result.removed).toEqual([]);
    expect(await snapshot(join(dir, 'webhooks'))).toEqual(before);

    const back = await loadProject(dir);
    expect(back.project.webhooks?.requests.map((request) => request.slug)).toEqual(['order-created']);
    expect(back.project.apis.map((api) => api.slug)).toEqual(['Shop']);
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/placeholders.test.ts`
Expected: FAIL in eleven of the twelve cases, on `project-kind-not-supported` or `feature-disabled` thrown by `loadProject` (the loader of Task 3.2 still refuses a container file of a kind it does not list, whatever the registry). One passes already, because Task 3.3 built what it tests: "is left byte-identical by a save whose registry cannot write it, though the project holds it in memory" loads with every protocol on and saves through `grpcOff`, which is the save ruling and needs no placeholder.

- [ ] **Step 3: The constant and the problem code**

In `packages/engine/src/project/paths.ts`, after `WEBHOOKS_FILE`:

```ts
/**
 * The feature that also switches the webhook collection: it is REST requests in a tree of its own,
 * so it is loaded and saved only while `rest` is on (spec §3.2).
 */
export const WEBHOOKS_FEATURE = 'rest';
```

`takenContainerSlugs` needs no change: it has counted placeholders since Task 3.3, and the loader is about to make some. `WEBHOOKS_FEATURE` is not exported from `index.ts` (core only).

In `packages/engine/src/project/load.ts`, `ProjectProblem`: add as the last member of the `code` union

```ts
    /** A container whose kind has no enabled module; it is a placeholder and is left as it is (spec §6). */
    | 'container-unsupported';
```

and after `file`:

```ts
  /** For `container-unsupported`: `kind`, `reason`, `dir` and `slug`. */
  readonly details?: Readonly<Record<string, unknown>>;
```

- [ ] **Step 4: The loader makes placeholders**

In `packages/engine/src/project/load.ts`:

1. Imports: remove `assertSupportedKind` from the `./schema-parts.js` import (the loader no longer calls it; request readers in the modules still do). Add `UnsupportedContainer` to the type import from `./model.js`, and `WEBHOOKS_FEATURE` to the import from `./paths.js`.

2. Replace `storageFor` with these three functions:

```ts
/**
 * The storage that reads a container file found in `layout.dir`: the enabled module its `kind`
 * names, when that module keeps its containers in this directory. Undefined makes a placeholder.
 */
function storageFor(registry: ProtocolRegistry, layout: ContainerLayout, document: unknown): ProtocolStorage | undefined {
  const storage = registry.find(kindOf(document, layout.defaultKind))?.storage;
  return storage !== undefined && storage.dir === layout.dir ? storage : undefined;
}

/**
 * What is kept of a container no enabled module reads (spec §6): where it is, its kind as written,
 * why it was not loaded, and its name and order when the file has them as a string and a number.
 */
function placeholderOf(
  registry: ProtocolRegistry,
  layout: ContainerLayout,
  slug: string,
  document: unknown,
): UnsupportedContainer {
  const kind = kindOf(document, layout.defaultKind);
  const fields = typeof document === 'object' && document !== null ? (document as Record<string, unknown>) : {};
  const name = fields['name'];
  const order = fields['order'];
  return {
    dir: layout.dir,
    slug,
    kind,
    // A kind the registry has a module for but in the other directory is unknown here.
    reason: registry.status(kind) === 'disabled' ? 'feature-disabled' : 'unknown-kind',
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof order === 'number' ? { order } : {}),
  };
}

/** The problem a placeholder is reported with. */
function unsupportedProblem(placeholder: UnsupportedContainer, file: string): ProjectProblem {
  const why =
    placeholder.reason === 'feature-disabled'
      ? 'that protocol is switched off'
      : `this build has no such protocol for ${placeholder.dir}/`;
  return {
    code: 'container-unsupported',
    message: `${file} is a "${placeholder.kind}" container, and ${why}; it was not loaded and is left as it is`,
    file,
    details: { kind: placeholder.kind, reason: placeholder.reason, dir: placeholder.dir, slug: placeholder.slug },
  };
}
```

3. Replace `loadProject` and its comment with:

```ts
/**
 * Loads the project stored in the directory `root`. Each container directory under `interfaces/`
 * and `apis/` is read by the protocol module its container file's `kind` names (spec §5.1). A
 * container whose kind has no enabled module in that directory becomes a placeholder in
 * `project.unsupported` and a `container-unsupported` problem; nothing below its directory is read
 * but its container file, and a save leaves all of it as it is (spec §6).
 *
 * @throws ProjectError `project-not-found` when there is no `wirebench.yaml`,
 * `project-format-too-new` for a newer format version, `project-file-invalid`
 * for malformed or schema-violating YAML (with the offending file in `details`),
 * `project-kind-not-supported` for a request file of a kind this build has no module for.
 */
export async function loadProject(root: string, options?: LoadProjectOptions): Promise<LoadResult> {
  const fs = options?.fs ?? nodeFs;
  const registry = options?.registry ?? defaultRegistry();
  const manifestDocument = await readYaml(fs, root, MANIFEST_PATH);
  if (manifestDocument === undefined) {
    throw new ProjectError('project-not-found', `No ${MANIFEST_PATH} in ${root}`, {
      details: { file: MANIFEST_PATH, root },
    });
  }
  const manifest = parseFile(manifestSchema, migrate(manifestDocument, MANIFEST_PATH), MANIFEST_PATH);

  const problems: ProjectProblem[] = [];
  const ctx: LoadContext = { fs, root, problems };
  const loaded = new Map<ProtocolStorage, ContainerBase[]>();
  const unsupported: UnsupportedContainer[] = [];
  const interfaceSlugs = new Set<string>();
  for (const layout of CONTAINER_DIRS) {
    for (const entry of await readdirIfExists(fs, abs(root, layout.dir))) {
      if (!entry.isDirectory) {
        continue;
      }
      const relative = `${layout.dir}/${entry.name}/${layout.file}`;
      const document = await readYaml(fs, root, relative);
      if (document === undefined) {
        problems.push({
          code: layout.missing,
          message: `Folder "${entry.name}" has no ${layout.file} and was skipped`,
          file: relative,
        });
        continue;
      }
      const storage = storageFor(registry, layout, document);
      if (storage === undefined) {
        // Kept whatever its slug: a placeholder that was skipped would not be live, and the next
        // save would delete the directory this build could not read.
        const placeholder = placeholderOf(registry, layout, entry.name, document);
        unsupported.push(placeholder);
        problems.push(unsupportedProblem(placeholder, relative));
        continue;
      }
      const container = await storage.load(ctx, entry.name, document);
      if (container === undefined) {
        continue;
      }
      if (layout.dir === INTERFACES_DIR) {
        interfaceSlugs.add(container.slug.toLowerCase());
      } else if (interfaceSlugs.has(container.slug.toLowerCase())) {
        // An environment's endpoint overrides are keyed by slug, so two entities sharing one would
        // make the override ambiguous. The folders never collide; the override key would. Every
        // kind of API shares one directory, so their slugs cannot collide with each other.
        problems.push({
          code: 'api-slug-conflict',
          message: `API "${container.name}" and an interface share the slug "${container.slug}"; the API was skipped`,
          file: `${APIS_DIR}/${container.slug}/${API_FILE}`,
        });
        continue;
      }
      const containers = loaded.get(storage) ?? [];
      containers.push(container);
      loaded.set(storage, containers);
    }
  }

  const keystoresDocument = await readYaml(fs, root, KEYSTORES_PATH);
  const keystores =
    keystoresDocument === undefined
      ? []
      : parseFile(keystoresFileSchema, keystoresDocument, KEYSTORES_PATH).keystores.map((k) => ({
          id: k.id,
          name: k.name,
          document: k,
        }));

  const sequenceFiles = await readSequences(fs, root);
  problems.push(...sequenceFiles.problems);

  // The collection is REST requests: with REST off it is not read, and a save leaves it alone.
  const webhooks = registry.features.isEnabled(WEBHOOKS_FEATURE) ? await loadWebhooks(fs, root, problems) : undefined;

  const core: Project = {
    formatVersion: FORMAT_VERSION,
    id: manifest.id,
    name: manifest.name,
    ...optional('description', manifest.description),
    settings: exact<ProjectSettings>(manifest.settings),
    properties: manifest.properties,
    disabledProperties: manifest.disabled ?? [],
    ...optional('activeEnvironmentId', manifest.activeEnvironmentId),
    interfaces: [],
    apis: [],
    grpcApis: [],
    wsApis: [],
    sequences: sequenceFiles.loaded.map((entry) => entry.sequence).sort(byOrder),
    ...(webhooks !== undefined ? { webhooks } : {}),
    environments: await loadEnvironments(fs, root),
    wss: {
      outgoing: await loadWssRefs(fs, root, 'outgoing'),
      incoming: await loadWssRefs(fs, root, 'incoming'),
      keystores,
    },
    // Absent when there is none, as every project written before placeholders is.
    ...(unsupported.length > 0
      ? { unsupported: unsupported.sort((a, b) => a.dir.localeCompare(b.dir) || a.slug.localeCompare(b.slug)) }
      : {}),
  };
  // A module that loaded nothing is not asked: the four built-in lists are already empty, and a
  // kind kept in `extraContainers` must not appear there when the project holds none of it.
  let project = core;
  for (const [storage, containers] of loaded) {
    project = storage.withContainers(project, containers.sort(byOrder));
  }
  return { project, problems };
}
```

`ProjectError` stays imported (the `project-not-found` throw). `assertSupportedKind` stays exported from `project/schema-parts.ts` and `project/schema.ts` and in use by the five request readers.

- [ ] **Step 5: The writer leaves the webhook collection alone when REST is off**

In `packages/engine/src/project/serialize.ts`, add `WEBHOOKS_FEATURE` to the import from `./paths.js`, and in `projectFiles` replace

```ts
  if (project.webhooks !== undefined) {
    addWebhookFiles(files, project.webhooks);
  }
```

with

```ts
  // REST requests in a tree of their own: written only while REST is on (spec §3.2).
  if (project.webhooks !== undefined && registry.features.isEnabled(WEBHOOKS_FEATURE)) {
    addWebhookFiles(files, project.webhooks);
  }
```

- [ ] **Step 6: The save keeps placeholders and refuses to write into one**

In `packages/engine/src/project/save.ts`:

1. Imports: the value import from `./model.js` that Task 3.3 added becomes `import { takenContainerSlugs, unsupportedOf } from './model.js';`, and `WEBHOOKS_FEATURE` joins the import from `./paths.js`.

2. `listCoreManagedFiles` takes the registry. Change its signature to

```ts
async function listCoreManagedFiles(fs: FsLike, root: string, registry: ProtocolRegistry): Promise<string[]> {
```

and replace its webhook block with

```ts
  // The request tree is managed only beside its `webhooks.yaml`, as an API's is beside its `api.yaml`,
  // and only while REST is on: with it off the collection was not loaded, and is not this save's.
  const webhooksFile = `${WEBHOOKS_DIR}/${WEBHOOKS_FILE}`;
  if (
    registry.features.isEnabled(WEBHOOKS_FEATURE) &&
    (await readFileIfExists(fs, toAbsolute(root, webhooksFile))) !== undefined
  ) {
    managed.push(webhooksFile);
    managed.push(...(await listApiTreeFiles(fs, root, `${WEBHOOKS_DIR}/${REQUESTS_DIR}`)));
  }
```

In its comment, change the two webhook bullets to end with `, while the `rest` feature is on`.

3. Add above `saveProject`:

```ts
/**
 * Refuses a save that would write a container into a placeholder's directory (spec §6): the files
 * there belong to a container this build could not read, and none of them may be replaced. Slugs
 * are compared without case, as `uniqueSlug` compares them, because on most machines two names
 * that differ only in case are one directory. A host that names containers with
 * `takenContainerSlugs` never gets here.
 *
 * @throws ProjectError `container-slug-conflict`
 */
function refusePlaceholderConflicts(project: Project, registry: ProtocolRegistry): void {
  const placeholders = unsupportedOf(project);
  if (placeholders.length === 0) {
    return;
  }
  for (const module of registry.modules) {
    const storage = module.storage;
    if (storage === undefined) {
      continue;
    }
    for (const container of storage.containers(project)) {
      const placeholder = placeholders.find(
        (candidate) => candidate.dir === storage.dir && candidate.slug.toLowerCase() === container.slug.toLowerCase(),
      );
      if (placeholder !== undefined) {
        throw new ProjectError(
          'container-slug-conflict',
          `"${container.name}" would be saved to ${storage.dir}/${placeholder.slug}, which holds a "${placeholder.kind}" container this build did not load; give it another name`,
          {
            details: {
              dir: storage.dir,
              slug: container.slug,
              kind: placeholder.kind,
              reason: placeholder.reason,
            },
          },
        );
      }
    }
  }
}
```

4. In `saveProject`, replace the lines from `const desired = …` down to and including `await refuseOverwritingForeignSequences(…)` with the block below. Against Task 3.3's it adds the call of `refusePlaceholderConflicts` and hands the registry to `listCoreManagedFiles`. The live set is not edited: `takenContainerSlugs` already counts placeholders, so the loader making them (Step 4) is what keeps their directories.

```ts
  const desired = projectFiles(project, {
    registry,
    ...(options?.writer !== undefined ? { writer: options.writer } : {}),
  });
  refusePlaceholderConflicts(project, registry);

  // Which container directories are alive: every container the project holds and every placeholder,
  // whatever this save's registry can write (spec R6). A save never deletes what it cannot write.
  const live: Record<ContainerDir, ReadonlySet<string>> = {
    interfaces: takenContainerSlugs(project, 'interfaces'),
    apis: takenContainerSlugs(project, 'apis'),
  };
  // What this save may delete: core's own files, then each module's word on each of its containers
  // (spec §5.2). A placeholder, and a container no enabled module answers for, has no managed file,
  // so nothing under its directory is removed or touched (spec §6).
  const existing = await listCoreManagedFiles(fs, root, registry);
  for (const module of registry.modules) {
    const storage = module.storage;
    if (storage === undefined) {
      continue;
    }
    for (const container of storage.containers(project)) {
      existing.push(...(await storage.managed(fs, root, container.slug)));
    }
  }
  await refuseOverwritingForeignSequences(fs, root, desired, existing);
```

The rest of `saveProject` is as Task 3.3 left it. Update its doc comment to:

```ts
/**
 * Saves `project` into the directory `root`, creating it if needed.
 *
 * @returns which files were written, removed and left untouched.
 * @throws ProjectError `container-slug-conflict` when a container has the slug of a placeholder in
 * its directory; `sequence-file-conflict`; what {@link projectFiles} throws
 */
```

- [ ] **Step 7: Run the engine test to verify it passes**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/placeholders.test.ts`
Expected: PASS, 12 cases.

- [ ] **Step 8: Point every slug allocation site at the helper**

Each file below adds `takenContainerSlugs` to its existing value import from `@wirebench/engine`.

`apps/desktop/src/main/project-rest-mutations.ts`, line 414, replace the `const taken = …` line of `addApi` with:

```ts
  const taken = new Set([...takenContainerSlugs(project, 'apis'), ...takenContainerSlugs(project, 'interfaces')]);
```

and lines 426–429 of `updateApi` with:

```ts
  // Every slug at the project's top level but this API's own, placeholders included.
  const taken = new Set([...takenContainerSlugs(project, 'apis'), ...takenContainerSlugs(project, 'interfaces')]);
  taken.delete(api.slug);
```

`apps/desktop/src/main/project-grpc-mutations.ts`, lines 60–67, replace `takenApiSlugs` with:

```ts
/** Every slug an API, an interface or a placeholder already uses at the project's top level. */
function takenApiSlugs(project: Project, exceptId?: string): Set<string> {
  const taken = new Set([...takenContainerSlugs(project, 'apis'), ...takenContainerSlugs(project, 'interfaces')]);
  const except = project.grpcApis.find((api) => api.id === exceptId);
  if (except !== undefined) {
    taken.delete(except.slug);
  }
  return taken;
}
```

`apps/desktop/src/main/project-ws-mutations.ts`, lines 78–86, replace `takenApiSlugs` with:

```ts
/** Every slug an API, an interface or a placeholder already uses at the project's top level. */
export function takenApiSlugs(project: Project, exceptId?: string): Set<string> {
  const taken = new Set([...takenContainerSlugs(project, 'apis'), ...takenContainerSlugs(project, 'interfaces')]);
  const except = project.wsApis.find((api) => api.id === exceptId);
  if (except !== undefined) {
    taken.delete(except.slug);
  }
  return taken;
}
```

`apps/desktop/src/main/project-host.ts`:
- lines 2070–2074 (gRPC import) and lines 3037–3040 (OpenAPI import), each `const taken = new Set([...]);` becomes

```ts
    const taken = new Set([
      ...takenContainerSlugs(open.project, 'apis'),
      ...takenContainerSlugs(open.project, 'interfaces'),
    ]);
```

- line 2653 (`addInterface`) and line 2774 (`importLegacyProject`, which adds to the set as it goes), each becomes

```ts
    const taken = new Set(takenContainerSlugs(open.project, 'interfaces'));
```

- line 3096 (AsyncAPI import) is unchanged: it calls `takenApiSlugs` from `project-ws-mutations.ts`.

`packages/cli/src/ops/import.ts`:
- line 192 becomes `const slug = uniqueSlug(interfaceName, takenContainerSlugs(project, 'interfaces'));`
- line 257 becomes `const taken = new Set([...takenContainerSlugs(project, 'apis'), ...takenContainerSlugs(project, 'interfaces')]);`

New desktop test:

```ts
// apps/desktop/test/placeholder-slugs.test.ts
/**
 * A new API never takes the slug of a placeholder: its directory holds a container this build did
 * not load, and a save would refuse to write into it.
 */
import { describe, expect, it } from 'vitest';
import { createGrpcApi, createProject } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { addGrpcApi } from '../src/main/project-grpc-mutations.js';
import { addApi } from '../src/main/project-rest-mutations.js';
import { addWsApi } from '../src/main/project-ws-mutations.js';

const project: Project = {
  ...createProject('Placeholders', { id: 'p1' }),
  unsupported: [{ dir: 'apis', slug: 'Shop', kind: 'graphql', reason: 'unknown-kind' }],
};

describe('adding an API beside a placeholder', () => {
  it('gives a REST API another slug', () => {
    expect(addApi(project, { name: 'Shop', baseUrl: '' }).project.apis.map((api) => api.slug)).toEqual(['Shop-2']);
  });

  it('gives a gRPC API another slug', () => {
    const added = addGrpcApi(project, { name: 'Shop', target: 'localhost:50051' });
    expect(added.project.grpcApis.map((api) => api.slug)).toEqual(['Shop-2']);
  });

  it('gives a WebSocket API another slug', () => {
    expect(addWsApi(project, { name: 'Shop' }).project.wsApis.map((api) => api.slug)).toEqual(['Shop-2']);
  });

  it('gives a REST API another slug than a gRPC API in the same directory', () => {
    const withGrpc: Project = { ...project, grpcApis: [createGrpcApi('Greeter', { id: 'g1' })] };
    expect(addApi(withGrpc, { name: 'Greeter', baseUrl: '' }).project.apis.map((api) => api.slug)).toEqual([
      'Greeter-2',
    ]);
  });
});
```

Run: `nice pnpm vitest run --project desktop apps/desktop/test/placeholder-slugs.test.ts apps/desktop/test/project-rest-mutations.test.ts apps/desktop/test/project-grpc-mutations.test.ts apps/desktop/test/project-mutations.test.ts`
Expected: PASS, the three existing files unchanged.

- [ ] **Step 9: Change the one existing test whose behaviour the spec changes**

Spec §6: "A project written by a later build opens in an earlier one with its unknown containers shown as problems, where today it fails to open." In `packages/engine/test/unit/project/rest-format.test.ts`, replace the case at lines 505–515

```ts
  it('refuses an api.yaml of an unknown kind the same way', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    const file = join(dir, APIS_DIR, 'Orders', 'api.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('kind: rest', 'kind: graphql'));

    const error = (await loadProject(dir).catch((e: unknown) => e)) as ProjectError;

    expect(error.code).toBe('project-kind-not-supported');
    await rm(dir, { recursive: true, force: true });
  });
```

with

```ts
  it('loads an api.yaml of an unknown kind as a placeholder, and the rest of the project with it', async () => {
    const dir = await tempProjectDir();
    await saveProject(apiProject(), dir);
    const file = join(dir, APIS_DIR, 'Orders', 'api.yaml');
    await writeFile(file, (await readFile(file, 'utf8')).replace('kind: rest', 'kind: graphql'));

    const { project, problems } = await loadProject(dir);

    expect(project.apis.map((api) => api.slug)).toEqual(['Petstore']);
    expect(project.unsupported).toEqual([
      { dir: 'apis', slug: 'Orders', kind: 'graphql', reason: 'unknown-kind', name: 'Orders', order: 1 },
    ]);
    expect(problems.map((problem) => problem.code)).toEqual(['container-unsupported']);
    await rm(dir, { recursive: true, force: true });
  });
```

The case above it, "refuses a request file of an unknown kind by name instead of guessing", stays as it is and still passes: a request file of an unknown kind under a loaded container refuses the project (spec §6, "Request files").

- [ ] **Step 10: The CLI names placeholders**

Write the failing test first:

```ts
// packages/cli/test/unit/ops/items.test.ts
/**
 * `resolveItem` on a reference into a placeholder: the container is there but this build did not
 * load it, and the refusal says which kind it is and why.
 */
import { createProject } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { OpsError } from '../../../src/ops/errors.js';
import { resolveItem } from '../../../src/ops/items.js';

const project: Project = {
  ...createProject('Placeholders', { id: 'p1' }),
  unsupported: [
    { dir: 'apis', slug: 'Graph', kind: 'graphql', reason: 'unknown-kind', name: 'Graph API', order: 0 },
    { dir: 'apis', slug: 'Greeter', kind: 'grpc', reason: 'feature-disabled' },
  ],
};

function refusal(ref: string): { readonly code: string; readonly message: string } {
  try {
    resolveItem(project, ref);
  } catch (error) {
    if (error instanceof OpsError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error(`"${ref}" resolved to a request`);
}

describe('resolveItem and placeholders', () => {
  it('names the kind of a container this build has no protocol for, by its display name', () => {
    expect(refusal('Graph API/Query')).toEqual({
      code: 'unsupported-kind',
      message:
        '"Graph API/Query" is in "Graph API", a "graphql" container this build did not load: it has no such protocol',
    });
  });

  it('names a container whose protocol is switched off, by its folder on disk', () => {
    expect(refusal('apis/Greeter/requests/Hello')).toEqual({
      code: 'unsupported-kind',
      message:
        '"apis/Greeter/requests/Hello" is in "Greeter", a "grpc" container this build did not load: that protocol is switched off',
    });
  });

  it('still says not found for a reference into nothing', () => {
    expect(refusal('Nowhere/Nothing').code).toBe('item-not-found');
  });
});
```

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/items.test.ts`
Expected: FAIL — the first two cases get `item-not-found`.

Then replace `packages/cli/src/ops/items.ts` with:

```ts
/**
 * The saved request `send` takes: its item path as `operations` lists it (or as `wirebench run`
 * selects it, on disk or displayed), else its name when only one request has it.
 */
import { selectRequests } from '@wirebench/engine';
import type { Project, SelectedRequest } from '@wirebench/engine';
import { OpsError } from './errors.js';

export type SendableItem = Extract<SelectedRequest, { kind: 'soap' | 'rest' }>;

/** A container the project's folder holds and this build did not load. */
type Placeholder = NonNullable<Project['unsupported']>[number];

function sendable(item: SelectedRequest): SendableItem {
  if (item.kind === 'grpc') {
    throw new OpsError('unsupported-kind', `"${item.path}" is a gRPC request; send takes SOAP and REST requests`, {
      item: item.path,
    });
  }
  return item;
}

function ambiguous(ref: string, items: readonly SelectedRequest[]): OpsError {
  return new OpsError(
    'item-ambiguous',
    `"${ref}" names ${String(items.length)} requests; pass one path: ${items.map((item) => item.path).join(', ')}`,
    { item: ref },
  );
}

/** The placeholder `ref` points into: by its display name, or by its folder on disk. */
function placeholderFor(project: Project, ref: string): Placeholder | undefined {
  return (project.unsupported ?? []).find((container) => {
    const label = container.name ?? container.slug;
    const folder = `${container.dir}/${container.slug}`;
    return ref === label || ref.startsWith(`${label}/`) || ref === folder || ref.startsWith(`${folder}/`);
  });
}

/** @throws OpsError `item-not-found`, `item-ambiguous`, `unsupported-kind` */
export function resolveItem(project: Project, ref: string): SendableItem {
  const { selected } = selectRequests(project, [ref]);
  const exact = selected.filter((item) => item.path === ref);
  if (exact.length === 1 && exact[0] !== undefined) {
    return sendable(exact[0]);
  }
  if (selected.length === 1 && selected[0] !== undefined) {
    return sendable(selected[0]);
  }
  if (selected.length > 1) {
    throw ambiguous(ref, selected);
  }
  const named = selectRequests(project, []).selected.filter((item) => item.request.name === ref);
  if (named.length === 1 && named[0] !== undefined) {
    return sendable(named[0]);
  }
  if (named.length > 1) {
    throw ambiguous(ref, named);
  }
  // WebSocket APIs and streaming gRPC calls are not selectable at all; name them rather than "not found".
  const unsupported = [
    ...project.wsApis.map((api) => ({ name: api.name, kind: 'WebSocket' })),
    ...project.grpcApis.map((api) => ({ name: api.name, kind: 'gRPC' })),
  ].find((api) => ref === api.name || ref.startsWith(`${api.name}/`));
  if (unsupported !== undefined) {
    throw new OpsError(
      'unsupported-kind',
      `"${ref}" is in the ${unsupported.kind} API "${unsupported.name}"; send takes SOAP and REST requests`,
      { item: ref },
    );
  }
  // Nor is anything in a placeholder: the engine never read its request files. Say which and why.
  const placeholder = placeholderFor(project, ref);
  if (placeholder !== undefined) {
    const why = placeholder.reason === 'feature-disabled' ? 'that protocol is switched off' : 'it has no such protocol';
    throw new OpsError(
      'unsupported-kind',
      `"${ref}" is in "${placeholder.name ?? placeholder.slug}", a "${placeholder.kind}" container this build did not load: ${why}`,
      { item: ref, kind: placeholder.kind, reason: placeholder.reason },
    );
  }
  throw new OpsError('item-not-found', `No saved request matches "${ref}"; wirebench operations lists them`, {
    item: ref,
  });
}
```

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/items.test.ts packages/cli/test/unit/ops/send.test.ts packages/cli/test/unit/ops/import.test.ts`
Expected: PASS, the two existing files unchanged.

- [ ] **Step 11: Run everything the task touched**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/`
Expected: PASS — `placeholders.test.ts`, the changed case of `rest-format.test.ts`, and every other file unchanged. `ws-format.test.ts`'s `assertSupportedKind` case still passes: the function is unchanged.

- [ ] **Step 12: Commit**

```bash
pnpm exec prettier --write packages/engine/src/project/load.ts packages/engine/src/project/serialize.ts packages/engine/src/project/save.ts packages/engine/src/project/paths.ts packages/engine/src/project/model.ts packages/engine/src/index.ts packages/engine/test/unit/project/placeholders.test.ts packages/engine/test/unit/project/rest-format.test.ts apps/desktop/src/main/project-rest-mutations.ts apps/desktop/src/main/project-grpc-mutations.ts apps/desktop/src/main/project-ws-mutations.ts apps/desktop/src/main/project-host.ts apps/desktop/test/placeholder-slugs.test.ts packages/cli/src/ops/items.ts packages/cli/src/ops/import.ts packages/cli/test/unit/ops/items.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/project/load.ts packages/engine/src/project/serialize.ts packages/engine/src/project/save.ts packages/engine/src/project/paths.ts packages/engine/src/project/model.ts packages/engine/src/index.ts packages/engine/test/unit/project/placeholders.test.ts packages/engine/test/unit/project/rest-format.test.ts apps/desktop/src/main/project-rest-mutations.ts apps/desktop/src/main/project-grpc-mutations.ts apps/desktop/src/main/project-ws-mutations.ts apps/desktop/src/main/project-host.ts apps/desktop/test/placeholder-slugs.test.ts packages/cli/src/ops/items.ts packages/cli/src/ops/import.ts packages/cli/test/unit/ops/items.test.ts
git commit -m "feat(engine): a container of an unknown or switched-off kind loads as a placeholder and survives a save (#184)"
```

---

### Task 3.5: `echo` gets storage, and `storage` becomes required

**Files:**
- Modify: `packages/engine/test/helpers/echo-protocol.ts` (`echoStorage`, and `storage: echoStorage` on `echoProtocol`)
- Modify: `packages/engine/test/integration/echo-protocol.test.ts` (one new `describe`)
- Create: `packages/engine/test/helpers/empty-storage.ts`
- Modify: `packages/engine/src/protocol/module.ts` (`ProtocolModule.storage`, `defineProtocol`)
- Modify: `packages/engine/src/project/load.ts`, `packages/engine/src/project/serialize.ts`, `packages/engine/src/project/save.ts` (drop the `storage === undefined` branches)
- Modify (the four tests of slices 1 and 2 that define a module without storage, Step 6): `packages/engine/test/unit/protocol/module.test.ts`, `packages/engine/test/unit/protocol/registry.test.ts`, `packages/engine/test/unit/run/registry-dispatch.test.ts`, `packages/engine/test/integration/run/scripts-feature.test.ts`

**Interfaces:**
- Consumes: `EchoApi`, `EchoRequest`, `echoProtocol`, `echoRun` (the helper, Task 1.8) and `echoScripting` (Task 2.4); the module-scope `registry` of `test/integration/echo-protocol.test.ts` (Task 1.8); `parseFile`, `nonEmpty` (`project/schema-parts.ts`); `readYaml` (`project/load-helpers.ts`); `stringifyYaml` (`project/yaml.ts`); `selectRequests(project, selectors, registry)`, `runRequests(selected, context)` with `RunContext.registry` (slice 1).
- Produces:
  - `echoStorage: ProtocolStorage<EchoApi>` exported by the helper.
  - `emptyStorage(kind: string, dir?: ContainerDir): ProtocolStorage` in `test/helpers/empty-storage.ts`.
  - `ProtocolModule.storage: ProtocolStorage` (required); `defineProtocol`'s parameter requires `storage`.

- [ ] **Step 1: Write the failing integration test**

In `packages/engine/test/integration/echo-protocol.test.ts` (Task 1.8), the import block gains what the new cases need. Four lines are new and two change; the block is then exactly:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadProject } from '../../src/project/load.js';
import { createProject, unsupportedOf } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { saveProject } from '../../src/project/save.js';
import { createProtocolRegistry } from '../../src/protocol/registry.js';
import { BUILTIN_PROTOCOLS, SCRIPTS_FEATURE } from '../../src/protocols.js';
import { createApi, createRestRequest } from '../../src/rest/model.js';
import type { RunContext } from '../../src/run/context.js';
import { runRequests } from '../../src/run/run.js';
import { secretNeedsOf } from '../../src/run/secret-needs.js';
import { findStepRequest, selectRequests } from '../../src/run/select.js';
import { echoApi, echoProtocol, echoRequest, withEchoApis } from '../helpers/echo-protocol.js';
import type { EchoApi } from '../helpers/echo-protocol.js';
import { startTestRestServer } from '../helpers/test-rest-server.js';
import type { TestRestServer } from '../helpers/test-rest-server.js';
```

Append the `describe` below at the end of the file. It uses the file's module-scope `registry` (the built-in protocols plus `echoProtocol`), and names its own project and folder `onDisk` and `folder`, because the file already has a function `project` and a variable `dir` at module scope:

```ts
describe('an echo API in a project folder', () => {
  const mirror: EchoApi = {
    kind: 'echo',
    id: 'echo-api-1',
    name: 'Mirror',
    slug: 'Mirror',
    order: 0,
    requests: [
      { id: 'echo-req-1', name: 'First', slug: 'First', text: 'hello' },
      { id: 'echo-req-2', name: 'Second', slug: 'Second', text: 'hello again' },
    ],
  };
  const onDisk: Project = {
    ...createProject('Echo on disk', { id: 'echo-project' }),
    extraContainers: { echo: [mirror] },
  };
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'wirebench-echo-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('is written as its module says, loads back the same, runs, and saves again without a write', async () => {
    const first = await saveProject(onDisk, folder, { registry });
    expect(first.written).toEqual([
      'apis/Mirror/api.yaml',
      'apis/Mirror/requests/First.request.yaml',
      'apis/Mirror/requests/Second.request.yaml',
      'wirebench.yaml',
    ]);
    expect(await readFile(join(folder, 'apis', 'Mirror', 'api.yaml'), 'utf8')).toBe(
      'id: echo-api-1\nkind: echo\nname: Mirror\norder: 0\n',
    );
    expect(await readFile(join(folder, 'apis', 'Mirror', 'requests', 'First.request.yaml'), 'utf8')).toBe(
      'id: echo-req-1\nkind: echo\nname: First\ntext: hello\n',
    );

    const loaded = await loadProject(folder, { registry });
    expect(loaded.problems).toEqual([]);
    expect(loaded.project.extraContainers).toEqual({ echo: [mirror] });

    const { selected, unmatched } = selectRequests(loaded.project, [], registry);
    expect(unmatched).toEqual([]);
    expect(selected.map((item) => item.path)).toEqual(['Mirror/First', 'Mirror/Second']);
    const run = await runRequests(selected, {
      project: loaded.project,
      projectDir: folder,
      overrides: {},
      getSecret: () => Promise.resolve(undefined),
      registry,
    });
    expect(run.summary).toMatchObject({ total: 2, errored: 0, failed: 0 });

    const second = await saveProject(loaded.project, folder, { registry });
    expect(second.written).toEqual([]);
    expect(second.removed).toEqual([]);
  });

  it('removes the file of a request that is gone, and nothing else', async () => {
    await saveProject(onDisk, folder, { registry });
    const shorter: Project = {
      ...onDisk,
      extraContainers: { echo: [{ ...mirror, requests: mirror.requests.slice(0, 1) }] },
    };

    const result = await saveProject(shorter, folder, { registry });

    expect(result.removed).toEqual(['apis/Mirror/requests/Second.request.yaml']);
    expect(result.written).toEqual([]);
  });

  it('is a placeholder to a registry with no echo module, and is left as it is', async () => {
    await saveProject(onDisk, folder, { registry });
    const apiFile = join(folder, 'apis', 'Mirror', 'api.yaml');
    const before = await readFile(apiFile);

    const loaded = await loadProject(folder);
    expect(loaded.project.extraContainers).toBeUndefined();
    expect(unsupportedOf(loaded.project)).toEqual([
      { dir: 'apis', slug: 'Mirror', kind: 'echo', reason: 'unknown-kind', name: 'Mirror', order: 0 },
    ]);
    expect(loaded.problems.map((problem) => problem.code)).toEqual(['container-unsupported']);

    const saved = await saveProject(loaded.project, folder);
    expect(saved.written).toEqual([]);
    expect(saved.removed).toEqual([]);
    expect((await readFile(apiFile)).equals(before)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/echo-protocol.test.ts`
Expected: FAIL — the first two cases: the first save writes only `wirebench.yaml` (the echo module has no storage, so the writer skips it); the third passes already (an `echo` container is unknown to the default registry), once Step 3 has written the folder it reads, and fails until then on the missing `api.yaml`.

- [ ] **Step 3: Give the echo helper its storage**

In `packages/engine/test/helpers/echo-protocol.ts`, the import block, as Tasks 1.8 and 2.4 left it, gains six lines and one type (`ProtocolStorage`). It is then exactly:

```ts
import { join } from 'node:path';
import { z } from 'zod';
import type { Assertion, AssertionSubject } from '../../src/assert/model.js';
import { readFileIfExists, readdirIfExists } from '../../src/project/fs.js';
import { readYaml } from '../../src/project/load-helpers.js';
import { extraContainersOf } from '../../src/project/model.js';
import type { Project } from '../../src/project/model.js';
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR } from '../../src/project/paths.js';
import { expand } from '../../src/project/properties.js';
import { nonEmpty, parseFile } from '../../src/project/schema-parts.js';
import { stringifyYaml } from '../../src/project/yaml.js';
import { defineProtocol } from '../../src/protocol/module.js';
import type { ProtocolRun, ProtocolScripting, ProtocolStorage, RunScope } from '../../src/protocol/module.js';
import { scopesFor } from '../../src/run/context.js';
import type { SentRequest } from '../../src/run/run.js';
import { unresolvedError, withSecrets } from '../../src/run/send-helpers.js';
import type { RequestScripts } from '../../src/script/model.js';
```

Then add above `echoProtocol`:

```ts
const echoApiFileSchema = z.looseObject({
  kind: z.literal('echo'),
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
});

const echoRequestFileSchema = z.looseObject({
  kind: z.literal('echo'),
  id: nonEmpty,
  name: z.string(),
  text: z.string(),
});

/**
 * How the echo protocol is stored: `apis/<slug>/api.yaml` with `kind: echo`, and one
 * `requests/<slug>.request.yaml` per request holding its text. Its containers have no list of
 * their own on `Project`, so they are kept in `extraContainers.echo`. Scripts and assertions are
 * not stored: the run tests build those requests in memory.
 */
export const echoStorage: ProtocolStorage<EchoApi> = {
  dir: APIS_DIR,

  async load(ctx, slug, document) {
    const base = `${APIS_DIR}/${slug}`;
    const api = parseFile(echoApiFileSchema, document, `${base}/${API_FILE}`);
    const requests: EchoRequest[] = [];
    const entries = await readdirIfExists(ctx.fs, join(ctx.root, APIS_DIR, slug, REQUESTS_DIR));
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile || !entry.name.endsWith(REQUEST_SUFFIX)) {
        continue;
      }
      const relative = `${base}/${REQUESTS_DIR}/${entry.name}`;
      const parsed = parseFile(echoRequestFileSchema, await readYaml(ctx.fs, ctx.root, relative), relative);
      requests.push({
        id: parsed.id,
        name: parsed.name,
        slug: entry.name.slice(0, -REQUEST_SUFFIX.length),
        text: parsed.text,
      });
    }
    return { kind: 'echo', id: api.id, name: api.name, slug, order: api.order, requests };
  },

  files(api) {
    const files = new Map<string, string>();
    assertPathSegment(api.slug);
    const base = `${APIS_DIR}/${api.slug}`;
    files.set(`${base}/${API_FILE}`, stringifyYaml({ kind: api.kind, id: api.id, name: api.name, order: api.order }));
    for (const request of api.requests) {
      assertPathSegment(request.slug);
      files.set(
        `${base}/${REQUESTS_DIR}/${request.slug}${REQUEST_SUFFIX}`,
        stringifyYaml({ kind: 'echo', id: request.id, name: request.name, text: request.text }),
      );
    }
    return files;
  },

  async managed(fs, root, slug) {
    const base = `${APIS_DIR}/${slug}`;
    const managed: string[] = [];
    if ((await readFileIfExists(fs, join(root, APIS_DIR, slug, API_FILE))) !== undefined) {
      managed.push(`${base}/${API_FILE}`);
    }
    for (const entry of await readdirIfExists(fs, join(root, APIS_DIR, slug, REQUESTS_DIR))) {
      if (entry.isFile && entry.name.endsWith(REQUEST_SUFFIX)) {
        managed.push(`${base}/${REQUESTS_DIR}/${entry.name}`);
      }
    }
    return managed;
  },

  containers: (project) => extraContainersOf(project, 'echo') as readonly EchoApi[],
  withContainers: (project, containers) => ({
    ...project,
    extraContainers: { ...project.extraContainers, echo: containers },
  }),
};
```

and give `echoProtocol` the facet. The declaration, as Task 2.4 left it with one line added, is:

```ts
/** The echo protocol, to register beside the built-in ones. */
export const echoProtocol = defineProtocol({
  kind: 'echo',
  feature: { id: 'echo', title: 'Echo', default: true, stage: 'experimental', requires: [] },
  storage: echoStorage,
  run: echoRun,
  scripting: echoScripting,
});
```

In the file's header comment, the sentence `This file holds the run half.` becomes `This file holds all three facets.`

Nothing outside the helper changes for the echo containers to load, select, run and save: that is the proof spec §10 asks for.

- [ ] **Step 4: Run the test to verify it passes**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/echo-protocol.test.ts`
Expected: PASS, the three new cases and every case the file had.

- [ ] **Step 5: `storage` becomes required**

In `packages/engine/src/protocol/module.ts`:

1. In `interface ProtocolModule`, replace

```ts
  /** Optional until slice 3 of the plan lands; every built-in module has one after it. */
  readonly storage?: ProtocolStorage;
```

with

```ts
  /** How its containers are read from and written to a project folder. */
  readonly storage: ProtocolStorage;
```

2. Replace `defineProtocol` with:

```ts
/**
 * A module as the registry holds it: the facets written against the protocol's own types, with a
 * guard on every call that takes a selected request, so a wrong pairing fails loudly.
 *
 * @throws Error when the feature's id is not the module's kind
 */
export function defineProtocol<S extends SelectedBase>(module: {
  readonly kind: string;
  readonly feature: FeatureDescriptor;
  readonly storage: ProtocolStorage;
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
    storage: module.storage,
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
```

3. Remove the branches core carried while it was optional:

- `packages/engine/src/project/serialize.ts`, `projectFiles`: replace

```ts
  for (const module of registry.modules) {
    const storage = module.storage;
    if (storage === undefined) {
      continue;
    }
    for (const container of storage.containers(project)) {
```

with

```ts
  for (const { storage } of registry.modules) {
    for (const container of storage.containers(project)) {
```

- `packages/engine/src/project/save.ts`, in `refusePlaceholderConflicts` and in `saveProject`: the same replacement, twice (`for (const { storage } of registry.modules) {` and the three lines `const storage = module.storage; if (storage === undefined) { continue; }` gone). The live set above the loop in `saveProject` is not touched: it never depended on the modules.

- `packages/engine/src/project/load.ts`, `storageFor`: replace its body with

```ts
  const storage = registry.find(kindOf(document, layout.defaultKind))?.storage;
  return storage?.dir === layout.dir ? storage : undefined;
```

(`registry.find` can still return nothing; what is gone is a module without storage.)

- [ ] **Step 6: Give storage to the test modules that had none**

Run: `nice pnpm exec tsc -b`
Expected: errors in four test files and nowhere else, each for a module without `storage`: `packages/engine/test/unit/protocol/module.test.ts`, `packages/engine/test/unit/protocol/registry.test.ts`, `packages/engine/test/unit/run/registry-dispatch.test.ts` (slice 1) and `packages/engine/test/integration/run/scripts-feature.test.ts` (slice 2). Every other module already has one: the four built-in modules since Task 3.2, `echoProtocol` since Step 3, and the `graphql` module of `placeholders.test.ts` from the start. `rules-per-protocol.test.ts` defines no module.

Create the helper they use:

```ts
// packages/engine/test/helpers/empty-storage.ts
import { extraContainersOf } from '../../src/project/model.js';
import type { ContainerDir, ProtocolStorage } from '../../src/protocol/module.js';

/**
 * A storage facet for a test module that is not about storage: it loads nothing, writes nothing,
 * manages nothing, and keeps its containers in `extraContainers[kind]`.
 */
export function emptyStorage(kind: string, dir: ContainerDir = 'apis'): ProtocolStorage {
  return {
    dir,
    load: () => Promise.resolve(undefined),
    files: () => new Map<string, string>(),
    managed: () => Promise.resolve([]),
    containers: (project) => extraContainersOf(project, kind),
    withContainers: (project, containers) => ({
      ...project,
      extraContainers: { ...project.extraContainers, [kind]: containers },
    }),
  };
}
```

Then the four files.

`packages/engine/test/unit/protocol/module.test.ts` (Task 1.1): add `import { emptyStorage } from '../../helpers/empty-storage.js';` after the `run/run.js` import, and after `const FEATURE … ;`:

```ts
const STORAGE = emptyStorage('ping');
```

Each of the four `defineProtocol` calls gains `storage: STORAGE`:

```ts
    expect(() => defineProtocol({ kind: 'ping', feature: { ...FEATURE, id: 'pong' }, storage: STORAGE })).toThrow(
```

```ts
    const module = defineProtocol({ kind: 'ping', feature: FEATURE, storage: STORAGE });
    expect(module).toEqual({ kind: 'ping', feature: FEATURE, storage: STORAGE });
```

```ts
    const module = defineProtocol({ kind: 'ping', feature: FEATURE, storage: STORAGE, run });
```

(the last one twice, in "passes every call through for a request of its own kind" and in "throws when handed a request of another kind"). The `toEqual` of "leaves out the facets a module does not have" names the storage because the module now always has one; the case still proves that `run` and `scripting` are left out. It is a test this plan added in Task 1.1, not one that existed before it.

`packages/engine/test/unit/protocol/registry.test.ts` (Task 1.1): add `import { emptyStorage } from '../../helpers/empty-storage.js';` after the `protocol/registry.js` import, and the helper `module` becomes:

```ts
function module(kind: string, feature: Partial<FeatureDescriptor> = {}): ProtocolModule {
  return {
    kind,
    feature: { id: kind, title: kind.toUpperCase(), default: true, stage: 'stable', requires: [], ...feature },
    storage: emptyStorage(kind),
  };
}
```

`packages/engine/test/unit/run/registry-dispatch.test.ts` (Task 1.7): add `import { emptyStorage } from '../../helpers/empty-storage.js';` as the last import, and in the helper `module` add one line after `feature`:

```ts
  const module = (kind: string, groups: readonly RunGroup[]) =>
    defineProtocol({
      kind,
      feature: { id: kind, title: kind, default: true, stage: 'stable', requires: [] },
      storage: emptyStorage(kind),
      run: {
```

`packages/engine/test/integration/run/scripts-feature.test.ts` (Task 2.4): its two modules stand in for `echoProtocol`, so they take its storage. Add `echoStorage` to the file's value import from `'../../helpers/echo-protocol.js'`, and the two declarations become:

```ts
const scriptable = defineProtocol({
  kind: 'echo',
  feature: echoProtocol.feature,
  storage: echoStorage,
  run: counted,
  scripting: echoScripting,
});
const scriptless = defineProtocol({ kind: 'echo', feature: echoProtocol.feature, storage: echoStorage, run: counted });
```

No other line of the four files changes.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `nice pnpm exec tsc -b`
Expected: no errors.

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/protocol/ packages/engine/test/unit/project/ packages/engine/test/unit/script/ packages/engine/test/unit/run/`
Expected: PASS.

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/echo-protocol.test.ts packages/engine/test/integration/echo-protocol-scripts.test.ts packages/engine/test/integration/run/scripts-feature.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write packages/engine/src/protocol/module.ts packages/engine/src/project/load.ts packages/engine/src/project/serialize.ts packages/engine/src/project/save.ts packages/engine/test/helpers/echo-protocol.ts packages/engine/test/helpers/empty-storage.ts packages/engine/test/integration/echo-protocol.test.ts packages/engine/test/integration/run/scripts-feature.test.ts packages/engine/test/unit/protocol/module.test.ts packages/engine/test/unit/protocol/registry.test.ts packages/engine/test/unit/run/registry-dispatch.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/protocol/module.ts packages/engine/src/project/load.ts packages/engine/src/project/serialize.ts packages/engine/src/project/save.ts packages/engine/test/helpers/echo-protocol.ts packages/engine/test/helpers/empty-storage.ts packages/engine/test/integration/echo-protocol.test.ts packages/engine/test/integration/run/scripts-feature.test.ts packages/engine/test/unit/protocol/module.test.ts packages/engine/test/unit/protocol/registry.test.ts packages/engine/test/unit/run/registry-dispatch.test.ts
git commit -m "refactor(engine): the echo test protocol stores its containers, and every module must have storage (#184)"
```

Before the slice is pushed: `nice pnpm test:perf`, unskipped. The project-load budget must hold; the loader now does one map lookup per container and reads each container file once, as before.

---

## Slice 4 — Cutting cross-group imports

Spec §7 and §12 item 4. When this slice is done no protocol folder imports another, core imports a protocol only from the files `CORE_EXCEPTIONS` lists, and `pnpm check` fails the moment either stops being true.

**How this slice was drawn up.** The inventory below is the output of the script Task 4.1 commits, run on `f9c0411b` (main plus the spec). Line ranges are those of `f9c0411b`; each one is also named by its declarations, so it can be found when an earlier slice has shifted it. The commands and edits of Tasks 4.2 to 4.8 were then run, in order and as written, on a copy of `f9c0411b`: `tsc -b` was clean after every task, and after Task 4.8 the `engine-unit` and `engine-integration` projects passed (4,130 tests; the copy had no ESLint config, so `lint-guard.test.ts` could not run there). What could not be run is the tree slices 1 to 3 leave. Every task therefore names the files those slices add that it has to rewrite (the list is under "The importers slices 1 to 3 add" below, drawn from those slices' drafts), and Task 4.1 starts by comparing the real tree with what this slice expects.

**Conventions of this slice.**

- A path without a package prefix is relative to `packages/engine/src/`. Commands run from the worktree root and use full paths.
- **A whole file that moves** moves with `git mv`, leaves nothing behind, and every importer's specifier is rewritten, tests included. The rewrite is `perl -pi -e` (the same on macOS and Linux; `sed -i` is not).
- **A part of a file that moves** goes to a new core file, declarations unchanged, under a header this plan gives in full. The old file imports the names it still uses and re-exports all of them, so code in the same group, `index.ts`, the browser subpaths and the tests keep their import paths. Only importers in another group switch to the new file.
- **The importers slices 1 to 3 add.** Those slices add files that import what this slice moves. Each is named here with the import as its slice writes it and the task that rewrites it; the tasks repeat them where they apply.

  | File (added or kept by) | Import | Task | Becomes |
  | --- | --- | --- | --- |
  | `script/send.ts` (kept by Task 2.2b) | `import type { KeyValueEntry } from '../rest/model.js';` | 4.2, Step 5 | `'../http/entries.js'` |
  | `project/load-helpers.ts` (Task 3.2), `project/serialize-helpers.ts` (Task 3.3) | the same line | 4.2, Step 5 | `'../http/entries.js'` |
  | `run/send-helpers.ts` (Task 1.3) | `import type { SendAuth } from '../types.js';` | 4.3, Step 2 | `'../http/auth/send-auth.js'` |
  | `rest/run.ts` (Task 1.5) | `resolveAuthChain` from `'./auth.js'` | 4.3, Step 3 | `'../http/auth/apply-auth.js'` |
  | `grpc/run.ts` (Task 1.6) | `resolveAuthChain` from `'../rest/auth.js'` | 4.3, Step 3 | `'../http/auth/apply-auth.js'` |
  | `project/schema-parts.ts` (Task 3.1) | `signatureSchemeSchema` from `'../webhooks/signature.js'` | 4.3, Step 3 | `'../http/webhook-signature.js'` |
  | `rest/storage.ts` (Task 3.2) | `toSignatureScheme` from `'../webhooks/signature.js'` | 4.3, Step 3 | `'../http/webhook-signature.js'` |
  | `script/types/json-schema.ts` (kept by Task 2.2b) | `JsonSchema` from `'../../rest/openapi/model.js'` | 4.5, Step 5 | `'../../json/schema/model.js'` |
  | `run/send-helpers.ts` (Task 1.3) | `loadKeystore`, `toTlsClientIdentity` and `Keystore` from `'../wss/keystore/index.js'` | 4.7, Step 1 | `'../keystore/index.js'` |
  | `soap/run.ts` (Task 1.4) | `'../project/wss-configs.js'` | 4.7, Step 1 | `'../wss/configs.js'` |
  | `soap/run.ts` (Task 1.4) | `'../send-options.js'`, `'../send.js'`, `'../types.js'` | 4.8, Step 1 | `'./send-input.js'`, `'./send.js'`, `'./types.js'` |
  | `soap/scripting.ts` (Task 2.2b) | `'../types.js'` | 4.8, Step 1 | `'./types.js'` |
  | `rest/run.ts` (Task 1.5), `grpc/run.ts` (Task 1.6) | `'../send-options.js'` | 4.8, Steps 1 and 2 | `'./send-input.js'` |
  | `protocols.ts` (Task 1.7) | `SoapExchange` from `'./types.js'` | 4.8, Step 1 | `'./soap/types.js'` |
  | `soap/run.ts` (Task 1.4) | `expandSendInput` from `'../project/properties.js'` | 4.8, Step 4 | `'./expand.js'` |

  Two core files of slice 1 keep a protocol import on purpose until slice 5, and get an entry in `CORE_EXCEPTIONS` (see "Exceptions" below): `run/run.ts` re-exports the three subject functions from `soap/run.ts`, `rest/run.ts` and `grpc/run.ts` (Task 1.7), and `run/script-support.ts` still holds `scriptTypesFor`, with its imports of the three `script-types.ts` files and of four protocol types (Tasks 1.7 and 2.2a). The other files slices 1 to 3 add import nothing this slice moves: `run/context.ts`, `run/tree.ts`, `run/scope.ts`, `run/select.ts`, `run/secret-needs.ts`, `script/lookup.ts`, `project/managed-files.ts`, the four `module.ts`, `storage.ts` and `files.ts`, the three `script-types.ts`, and `rest/scripting.ts` and `grpc/scripting.ts`. Two finders show what is left after a step, and catch an import this list missed:
  - `node scripts/engine-import-graph.mjs --check 2>&1 | grep '^unresolved import'` lists every relative import in `packages/engine/src` that no longer names a file (expected after each move step: no output);
  - `nice pnpm exec tsc -b` lists the same for the tests (`TS2307`), and a name an old file no longer exports (`TS2305`, `TS2724`).
- **The end of every task** is the same block, given in full in each task: format what changed, `tsc -b`, the task's own check of the import graph, the engine tests, `WIREBENCH_SKIP_PERF=1 nice pnpm check`, `nice pnpm pack:check` (it builds every package and the desktop app, which is what proves the browser subpaths still bundle), then the commit.
- No test changes anything but an import path in this slice. 69 test and helper files change, all under `packages/engine/test/`: 0 in Task 4.2, 7 in 4.3, 13 in 4.4, 6 in 4.5, 1 in 4.6, 11 in 4.7, 31 in 4.8. One test file is new (`scripts/engine-layers.test.ts`, Task 4.9). The 69 were counted on `f9c0411b`. Two tests slice 1 adds mock `src/send.js` (`test/unit/run/send-order.test.ts` and `test/unit/soap/run-module.test.ts`); Task 4.8, Step 1 rewrites their specifier with the rest, which makes 71 files, 33 of them in Task 4.8. No other test of slices 1 to 3 imports a file this slice moves.

**The inventory.** `node scripts/engine-import-graph.mjs` on `f9c0411b` prints 402 imports that leave their group for a protocol group, where a group is what spec §7.1 says (the five SOAP root files count as SOAP): core to soap 165, core to rest 108, core to grpc 56, core to ws 38, grpc to rest 5, grpc to soap 1, rest to soap 11, rest to ws 2, soap to rest 1, ws to rest 13, ws to soap 2. An import statement, a re-export, an `import()` type and a dynamic `import()` each count once.

Each edge is in one class:

- **(a) gone when slices 1 to 3 have landed**: 72. The code that imports moves into a protocol folder, or stops importing. Four of the 72 (rows 106 to 109, `run/script-support.ts`) go one slice later than the rest: `scriptTypesFor` loses its caller in slice 1 and stays exported until slice 5 removes it, so those imports are a temporary exception in this slice.
- **(b) allowed**: 256. `index.ts` makes 230 of them (one row below); 13 more are in spec §7.2's table as it is written; 13 are marked **b\*** and need the table widened (see "Exceptions" below).
- **(c) removed in this slice**: 74. The last column names what moves and the task.

| # | Importer | Imports from | Names | Class | What happens |
| --- | --- | --- | --- | --- | --- |
| – | `index.ts` | every protocol folder (230 statements) | the public exports | b | `index.ts`: public exports, spec §7.2 |
| 1 | `assert/schema.ts` | `grpc/status.ts` | `GRPC_STATUS_NAMES` | c | `GRPC_STATUS_NAMES` → `assert/status-names.ts` (4.6) |
| 2 | `assert/status.ts` | `grpc/status.ts` | `GRPC_STATUS_NAMES`, `grpcStatusName` | a | slice 2 (Task 2.3): `AssertionSubject.statusNames`, supplied by `grpc/run.ts` |
| 3 | `asyncapi/import.ts` | `rest/openapi/import.ts` | `OpenApiSource` (type) | c | `OpenApiSource` → `json/schema/source.ts` (4.5) |
| 4 | `asyncapi/import.ts` | `rest/openapi/refs.ts` | `ResolvedDocument` (type) | c | `rest/openapi/refs.ts` → `json/schema/refs.ts` (4.5) |
| 5 | `asyncapi/map.ts` | `rest/model.ts` | `entry`, `KeyValueEntry` | c | `KeyValueEntry`, `entry` → `http/entries.ts` (4.2) |
| 6 | `asyncapi/map.ts` | `rest/openapi/sample.ts` | `sampleFromSchema` | c | `rest/openapi/sample.ts` → `json/schema/sample.ts` (4.5) |
| 7 | `asyncapi/parse.ts` | `rest/openapi/import.ts` | `OpenApiSource` (type) | c | `OpenApiSource` → `json/schema/source.ts` (4.5) |
| 8 | `asyncapi/parse.ts` | `rest/openapi/parse.ts` | `parseDocumentText` | c | `parseDocumentText` → `json/schema/parse-text.ts` (4.5) |
| 9 | `asyncapi/parse.ts` | `rest/openapi/refs.ts` | `resolveRefs`, `RefProblem`, `ResolvedDocument` | c | `rest/openapi/refs.ts` → `json/schema/refs.ts` (4.5) |
| 10 | `asyncapi/parse.ts` | `wsdl/resolver.ts` | `FetchDocument` (type) | c | `FetchDocument`, `FetchedDocument`, `createDefaultFetchDocument` → `http/fetch-document.ts` (4.4) |
| 11 | `grpc/command.ts` | `rest/model.ts` | `KeyValueEntry` (type) | c | `KeyValueEntry`, `entry` → `http/entries.ts` (4.2) |
| 12 | `grpc/expand.ts` | `rest/body.ts` | `escapeForLanguage` | c | `escapeForLanguage` → `http/escape.ts` (4.2) |
| 13 | `grpc/expand.ts` | `rest/model.ts` | `KeyValueEntry` (type) | c | `KeyValueEntry`, `entry` → `http/entries.ts` (4.2) |
| 14 | `grpc/model.ts` | `rest/model.ts` | `KeyValueEntry` (type) | c | `KeyValueEntry`, `entry` → `http/entries.ts` (4.2) |
| 15 | `grpc/send.ts` | `rest/model.ts` | `KeyValueEntry` (type) | c | `KeyValueEntry`, `entry` → `http/entries.ts` (4.2) |
| 16 | `grpc/send.ts` | `types.ts` | `SendAuth` (type) | c | `SendAuth`, `AuthSummary` → `http/auth/send-auth.ts` (4.3) |
| 17 | `http/auth/apply.ts` | `types.ts` | `AuthSummary`, `SendAuth` (type) | c | `SendAuth`, `AuthSummary` → `http/auth/send-auth.ts` (4.3) |
| 18 | `http/curl.ts` | `types.ts` | `SoapSendInput` (type) | c | `soapToCurl`, `fromCurl`, `FromCurlResult` → `soap/curl.ts` (4.8) |
| 19 | `http/curl.ts` | `soap/soap-action.ts` | `soapActionHeaders` | c | `soapToCurl`, `fromCurl`, `FromCurlResult` → `soap/curl.ts` (4.8) |
| 20 | `http/document-fetch.ts` | `rest/auth.ts` | `applyAuth` | c | `rest/auth.ts` → `http/auth/apply-auth.ts` (4.3) |
| 21 | `http/document-fetch.ts` | `types.ts` | `SendAuth` (type) | c | `SendAuth`, `AuthSummary` → `http/auth/send-auth.ts` (4.3) |
| 22 | `http/document-fetch.ts` | `wsdl/fetch.ts` | `createDefaultFetchDocument`, `decodeXmlBytes` | c | `wsdl/fetch.ts` → `http/fetch-document.ts`; `decodeXmlBytes` → `xml/decode.ts` (4.4) |
| 23 | `http/document-fetch.ts` | `wsdl/resolver.ts` | `FetchDocument`, `FetchedDocument` (type) | c | `FetchDocument`, `FetchedDocument`, `createDefaultFetchDocument` → `http/fetch-document.ts` (4.4) |
| 24 | `import-detect.ts` | `rest/postman/parse.ts` | `isPostmanCollection` | b | `import-detect.ts`: format detectors |
| 25 | `import-detect.ts` | `soap/legacy-project/format.ts` | `looksLikeLegacyProject` | b | `import-detect.ts`: format detectors |
| 26 | `project/attachments-cache.ts` | `soap/mime/types.ts` | `AttachmentResolver` (type) | c | `AttachmentResolver` → `project/attachments-cache.ts` itself (4.6) |
| 27 | `project/environments.ts` | `rest/model.ts` | `RestApi` (type) | c | the `Pick` of `slug` and `baseUrl` from `RestApi` written out as a structural type; import removed (4.6) |
| 28 | `project/history.ts` | `ws/model.ts` | `WsExchange`, `WsFrame` (type) | b | `project/history.ts`: exchange record types |
| 29 | `project/history.ts` | `ws/transcript.ts` | `capFrames` | b* | `project/history.ts`: the caps History applies (value imports) |
| 30 | `project/history.ts` | `rest/sse.ts` | `SseRow` (type) | b | `project/history.ts`: exchange record types |
| 31 | `project/history.ts` | `rest/sse-transcript.ts` | `capSseRows`, `SSE_HISTORY_LIMITS` | b* | `project/history.ts`: the caps History applies (value imports) |
| 32 | `project/history.ts` | `rest/contract-check.ts` | `MAX_CONTRACT_MESSAGE_LENGTH`, `MAX_CONTRACT_PROBLEMS` | b* | `project/history.ts`: the caps History applies (value imports) |
| 33 | `project/history.ts` | `rest/contract-check.ts` | `RestContractResult` (type) | b | `project/history.ts`: exchange record types |
| 34 | `project/keystores.ts` | `wss/keystore/model.ts` | `KeystoreDef` (type) | c | `wss/keystore/` → `keystore/` (4.7) |
| 35 | `project/load.ts` | `rest/model.ts` | `KeyValueEntry`, `RestApi`, `RestBody`, `RestRequestDef`, `RestRequestSettings` (type) | b | `project/load.ts`: REST's request reader for `webhooks/` |
| 36 | `project/load.ts` | `grpc/model.ts` | `GrpcApi`, `GrpcRequestDef`, `GrpcRequestSettings` (type) | a | slice 3: `grpc/storage.ts` |
| 37 | `project/load.ts` | `ws/model.ts` | `WsApi`, `WsRequestDef`, `WsRequestSettings`, `WsSavedMessage` (type) | a | slice 3: `ws/storage.ts` |
| 38 | `project/load.ts` | `wsa/model.ts` | `normalizeWsa` | a | slice 3: `soap/storage.ts` |
| 39 | `project/load.ts` | `webhooks/model.ts` | `HookLink`, `WebhookCollection`, `WebhookFolder`, `WebhookSigning` (type) | b | `project/load.ts`: REST's request reader for `webhooks/` |
| 40 | `project/load.ts` | `webhooks/signature.ts` | `toSignatureScheme` | c | `webhooks/signature.ts` → `http/webhook-signature.ts` (4.3) |
| 41 | `project/model.ts` | `wsa/model.ts` | `DEFAULT_WSA_CONFIG` | b* | `project/model.ts`: WS-Addressing configuration of the SOAP types it declares |
| 42 | `project/model.ts` | `wsa/model.ts` | `WsaConfig` (type) | b* | `project/model.ts`: WS-Addressing configuration of the SOAP types it declares |
| 43 | `project/model.ts` | `grpc/model.ts` | `GrpcApi`, `GrpcRequestDef` (type) | b | `project/model.ts`: container types, type-only |
| 44 | `project/model.ts` | `rest/model.ts` | `RestApi`, `RestRequestDef` (type) | b | `project/model.ts`: container types, type-only |
| 45 | `project/model.ts` | `ws/model.ts` | `WsApi`, `WsRequestDef` (type) | b | `project/model.ts`: container types, type-only |
| 46 | `project/model.ts` | `webhooks/model.ts` | `WebhookCollection` (type) | b* | `project/model.ts`: `WebhookCollection`, type-only |
| 47 | `project/model.ts` | `wsa/model.ts` | `WsaConfig`, `WsaConfigPatch`, `WsaMustUnderstand`, `WsaVersion` (type) (re-export) | b* | `project/model.ts`: WS-Addressing configuration of the SOAP types it declares |
| 48 | `project/properties.ts` | `soap/transforms.ts` | `entitizeValue` | c | `entitizeValue` → `xml/entitize.ts` (4.6) |
| 49 | `project/properties.ts` | `types.ts` | `SoapSendInput` (type) | c | `expandSendInput` → `soap/expand.ts` (4.8) |
| 50 | `project/request-location.ts` | `rest/model.ts` | `RestFolder` (type) | b* | `project/request-location.ts`: `RestFolder`, type-only |
| 51 | `project/schema.ts` | `wss/model.ts` | `DEFAULT_WSS_ENCRYPTION_PARTS`, `DEFAULT_WSS_SIGNATURE_PARTS` | b* | `project/schema.ts`: the default part lists of the WS-Security file schemas (value import) |
| 52 | `project/schema.ts` | `webhooks/signature.ts` | `signatureSchemeSchema` | c | `webhooks/signature.ts` → `http/webhook-signature.ts` (4.3) |
| 53 | `project/serialize.ts` | `rest/model.ts` | `KeyValueEntry`, `RestApi`, `RestBody`, `RestDefinitionRef`, `RestRequestDef` (type) | b | `project/serialize.ts`: REST's request writer for `webhooks/` |
| 54 | `project/serialize.ts` | `grpc/model.ts` | `GrpcApi`, `GrpcRequestDef` (type) | a | slice 3: `grpc/storage.ts` |
| 55 | `project/serialize.ts` | `ws/model.ts` | `WsApi`, `WsDefinitionRef`, `WsRequestDef` (type) | a | slice 3: `ws/storage.ts` |
| 56 | `project/serialize.ts` | `ws/model.ts` | `wsMessageFileName` | a | slice 3: `ws/storage.ts` |
| 57 | `project/serialize.ts` | `rest/model.ts` | `RAW_LANGUAGE_EXTENSIONS` | b | `project/serialize.ts`: REST's request writer for `webhooks/` |
| 58 | `project/serialize.ts` | `webhooks/model.ts` | `WebhookCollection`, `WebhookFolder`, `WebhookSigning` (type) | b | `project/serialize.ts`: REST's request writer for `webhooks/` |
| 59 | `project/wss-configs.ts` | `wss/model.ts` | `DEFAULT_WSS_TIMESTAMP_SKEW_SECONDS` | c | `project/wss-configs.ts` → `wss/configs.ts` (4.7) |
| 60 | `project/wss-configs.ts` | `wss/model.ts` | `WssEntry`, `WssIncomingConfig`, `WssOutgoingConfig` (type) | c | `project/wss-configs.ts` → `wss/configs.ts` (4.7) |
| 61 | `rest/auth.ts` | `types.ts` | `SendAuth` (type) | c | `SendAuth`, `AuthSummary` → `http/auth/send-auth.ts` (4.3) |
| 62 | `rest/body.ts` | `soap/charset.ts` | `encodeBody` | c | `soap/charset.ts` → `http/charset.ts` (4.2) |
| 63 | `rest/body.ts` | `soap/mime/multipart.ts` | `mediaTypeOf` | c | `mediaTypeOf` → `http/media-type.ts` (4.2) |
| 64 | `rest/openapi/cache.ts` | `wsdl/cache-naming.ts` | `assignFileNames` | c | `wsdl/cache-naming.ts` → `project/cache-naming.ts` (4.4) |
| 65 | `rest/openapi/cache.ts` | `wsdl/resolver.ts` | `FetchDocument`, `FetchedDocument` (type) | c | `FetchDocument`, `FetchedDocument`, `createDefaultFetchDocument` → `http/fetch-document.ts` (4.4) |
| 66 | `rest/openapi/import.ts` | `wsdl/resolver.ts` | `FetchDocument` (type) | c | `FetchDocument`, `FetchedDocument`, `createDefaultFetchDocument` → `http/fetch-document.ts` (4.4) |
| 67 | `rest/openapi/refs.ts` | `wsdl/ref-policy.ts` | `referencePolicyFor`, `MAX_IMPORT_DEPTH`, `MAX_IMPORT_DOCUMENTS` | c | `wsdl/ref-policy.ts` → `http/ref-policy.ts` (4.4) |
| 68 | `rest/openapi/refs.ts` | `wsdl/resolver.ts` | `FetchDocument` (type) | c | `FetchDocument`, `FetchedDocument`, `createDefaultFetchDocument` → `http/fetch-document.ts` (4.4) |
| 69 | `rest/response.ts` | `soap/charset.ts` | `decodeBody` | c | `soap/charset.ts` → `http/charset.ts` (4.2) |
| 70 | `rest/response.ts` | `soap/mime/multipart.ts` | `mediaTypeOf` | c | `mediaTypeOf` → `http/media-type.ts` (4.2) |
| 71 | `rest/send.ts` | `types.ts` | `AuthSummary`, `SendAuth` (type) | c | `SendAuth`, `AuthSummary` → `http/auth/send-auth.ts` (4.3) |
| 72 | `rest/sse-transcript.ts` | `ws/transcript.ts` | `CapLimits` (type) | c | `capByEnds`, `CapLimits`, `WS_HISTORY_*` → `http/transcript-cap.ts` (4.2) |
| 73 | `rest/sse-transcript.ts` | `ws/transcript.ts` | `capByEnds`, `WS_HISTORY_HEAD`, `WS_HISTORY_MAX_BYTES`, `WS_HISTORY_TAIL` | c | `capByEnds`, `CapLimits`, `WS_HISTORY_*` → `http/transcript-cap.ts` (4.2) |
| 74 | `run/effective-auth.ts` | `rest/auth.ts` | `resolveAuthChain` | a | slice 1: file deleted; `rest/run.ts`, `grpc/run.ts` (then `resolveAuthChain` → `http/auth/apply-auth.ts`, 4.3) |
| 75 | `run/oauth2-token.ts` | `rest/oauth2.ts` | `buildTokenRequest`, `needsRefresh`, `parseTokenResponse` | c | `rest/oauth2.ts` → `http/auth/oauth2.ts` (4.3) |
| 76 | `run/oauth2-token.ts` | `rest/oauth2.ts` | `TokenSet` (type) | c | `rest/oauth2.ts` → `http/auth/oauth2.ts` (4.3) |
| 77 | `run/prepare.ts` | `grpc/expand.ts` | `expandGrpcInput` | a | slice 1: `grpc/run.ts` |
| 78 | `run/prepare.ts` | `grpc/send.ts` | `GrpcSendInput` (type) | a | slice 1: `grpc/run.ts` |
| 79 | `run/prepare.ts` | `rest/expand.ts` | `expandRestSendInput` | a | slice 1: `rest/run.ts` |
| 80 | `run/prepare.ts` | `rest/send.ts` | `RestSendInput` (type) | a | slice 1: `rest/run.ts` |
| 81 | `run/prepare.ts` | `types.ts` | `SoapSendInput`, `SoapSendWss` (type) | a | slice 1: `soap/run.ts` |
| 82 | `run/prepare.ts` | `webhooks/model.ts` | `signingSecretMissing`, `signingSecretRef` | a | slice 1: `rest/run.ts` |
| 83 | `run/prepare.ts` | `wsa/model.ts` | `effectiveWsa` | a | slice 1: `soap/run.ts` |
| 84 | `run/prepare.ts` | `wss/keystore/index.ts` | `loadKeystore`, `toTlsClientIdentity` | c | carried by `run/send-helpers.ts`; `wss/keystore/` → `keystore/` (4.7) |
| 85 | `run/prepare.ts` | `wss/keystore/index.ts` | `Keystore` (type) | c | carried by `run/send-helpers.ts`; `wss/keystore/` → `keystore/` (4.7) |
| 86 | `run/prepare.ts` | `wss/model.ts` | `createWssContext` | a | slice 1: `soap/run.ts` |
| 87 | `run/run.ts` | `grpc/cache.ts` | `readGrpcDefinitionCache` | a | slice 1: `grpc/run.ts` |
| 88 | `run/run.ts` | `grpc/call.ts` | `callGrpc` | a | slice 1: `grpc/run.ts` |
| 89 | `run/run.ts` | `grpc/call.ts` | `GrpcCallResult` (type) | a | slice 1: `grpc/run.ts` |
| 90 | `run/run.ts` | `grpc/proto/load.ts` | `loadProtoSet` | a | slice 1: `grpc/run.ts` |
| 91 | `run/run.ts` | `grpc/proto/load.ts` | `ProtoSet` (type) | a | slice 1: `grpc/run.ts` |
| 92 | `run/run.ts` | `grpc/reflection/descriptors.ts` | `protoSetFromDescriptorSet` | a | slice 1: `grpc/run.ts` |
| 93 | `run/run.ts` | `rest/send.ts` | `sendRest` | a | slice 1: `rest/run.ts` |
| 94 | `run/run.ts` | `rest/send.ts` | `RestExchange` (type) | a | slice 1: `rest/run.ts` |
| 95 | `run/run.ts` | `send.ts` | `sendSoapRequest` | a | slice 1: `soap/run.ts` |
| 96 | `run/run.ts` | `types.ts` | `SendAuth`, `SoapExchange` (type) | a | slice 1: `soap/run.ts` (`SendAuth` in `run/send-helpers.ts` → `http/auth/send-auth.ts`, 4.3) |
| 97 | `run/run.ts` | `validate/index.ts` | `bindingContextFor`, `validateMessage` | a | slice 1: `soap/run.ts` |
| 98 | `run/run.ts` | `wsa/policy-detect.ts` | `summarizeWsa` | a | slice 1: `soap/run.ts` |
| 99 | `run/run.ts` | `wsdl/merge.ts` | `parseWsdlBundle` | a | slice 1: `soap/run.ts` |
| 100 | `run/run.ts` | `wsdl/model.ts` | `WsdlDefinition` (type) | a | slice 1: `soap/run.ts` |
| 101 | `run/run.ts` | `wsdl/cache.ts` | `readDefinitionCache` | a | slice 1: `soap/run.ts` |
| 102 | `run/run.ts` | `wsdl/resolver.ts` | `DefinitionBundle` (type) | a | slice 1: `soap/run.ts` |
| 103 | `run/run.ts` | `xsd/schema-set.ts` | `buildSchemaSet` | a | slice 1: `soap/run.ts` |
| 104 | `run/run.ts` | `xsd/schema-set.ts` | `SchemaSet` (type) | a | slice 1: `soap/run.ts` |
| 105 | `run/run.ts` | `rest/openapi/model.ts` | `OpenApiDocument` (type) | a | slice 1: `rest/run.ts` |
| 106 | `run/script-support.ts` | `grpc/proto/load.ts` | `ProtoSet` (type) | a | slice 1 gives the send `run.scriptTypes` of `grpc/run.ts`; `scriptTypesFor` keeps this import until slice 5 removes it (temporary exception) |
| 107 | `run/script-support.ts` | `rest/openapi/model.ts` | `OpenApiDocument` (type) | a | slice 1 gives the send `run.scriptTypes` of `rest/run.ts`; `scriptTypesFor` keeps this import until slice 5 removes it (temporary exception) |
| 108 | `run/script-support.ts` | `wsdl/model.ts` | `WsdlDefinition` (type) | a | slice 1 gives the send `run.scriptTypes` of `soap/run.ts`; `scriptTypesFor` keeps this import until slice 5 removes it (temporary exception) |
| 109 | `run/script-support.ts` | `xsd/schema-set.ts` | `SchemaSet` (type) | a | slice 1 gives the send `run.scriptTypes` of `soap/run.ts`; `scriptTypesFor` keeps this import until slice 5 removes it (temporary exception) |
| 110 | `run/secret-needs.ts` | `webhooks/model.ts` | `signingSecretRef`, `signingSourceLabel` | a | slice 1: `run.secretNeeds` of `rest/run.ts` |
| 111 | `run/secret-needs.ts` | `wss/model.ts` | `WssIncomingConfig`, `WssOutgoingConfig` (type) | a | slice 1: `run.secretNeeds` of `soap/run.ts` |
| 112 | `run/select.ts` | `grpc/model.ts` | `GrpcApi`, `GrpcFolder`, `GrpcRequestDef` (type) | a | slice 1: `run.groups` of `grpc/run.ts` |
| 113 | `run/select.ts` | `rest/model.ts` | `RestApi`, `RestFolder`, `RestRequestDef` (type) | a | slice 1: `run.groups` of `rest/run.ts` |
| 114 | `run/select.ts` | `rest/model.ts` | `createApi` | a | slice 1: `run.groups` of `rest/run.ts` |
| 115 | `run/select.ts` | `webhooks/model.ts` | `EffectiveSigning`, `WebhookCollection`, `WebhookFolder` (type) | a | slice 1: `run.groups` of `rest/run.ts` |
| 116 | `run/select.ts` | `webhooks/model.ts` | `effectiveSigning`, `effectiveTarget` | a | slice 1: `run.groups` of `rest/run.ts` |
| 117 | `script/contracts.ts` | `wsdl/qname.ts` | `QName` (type) | a | slice 2 (Task 2.2a): `soap/script-types.ts` |
| 118 | `script/contracts.ts` | `wsdl/model.ts` | `findBinding`, `findMessage`, `findPortType`, `WsdlDefinition` | a | slice 2 (Task 2.2a): `soap/script-types.ts` |
| 119 | `script/contracts.ts` | `rest/openapi/cache.ts` | `createCachedApiFetch`, `readApiDefinitionCache` | a | slice 2 (Task 2.2a): `rest/script-types.ts` |
| 120 | `script/contracts.ts` | `rest/openapi/import.ts` | `parseOpenApi` | a | slice 2 (Task 2.2a): `rest/script-types.ts` |
| 121 | `script/contracts.ts` | `rest/openapi/model.ts` | `OpenApiDocument`, `OpenApiOperation` (type) | a | slice 2 (Task 2.2a): `rest/script-types.ts` |
| 122 | `script/contracts.ts` | `rest/model.ts` | `RestContractLink` (type) | a | slice 2 (Task 2.2a): `rest/script-types.ts` |
| 123 | `script/contracts.ts` | `grpc/proto/describe.ts` | `describeMethod` | a | slice 2 (Task 2.2a): `grpc/script-types.ts` |
| 124 | `script/contracts.ts` | `grpc/proto/load.ts` | `ProtoSet` (type) | a | slice 2 (Task 2.2a): `grpc/script-types.ts` |
| 125 | `script/run.ts` | `xsd/schema-set.ts` | `SchemaSet` (type) | a | slice 2: `soap/scripting.ts` |
| 126 | `script/run.ts` | `wsdl/qname.ts` | `QName` (type) | a | slice 2: `soap/scripting.ts` |
| 127 | `script/send.ts` | `grpc/call.ts` | `GrpcCallResult` (type) | a | slice 2: `grpc/scripting.ts` |
| 128 | `script/send.ts` | `grpc/send.ts` | `GrpcSendInput` (type) | a | slice 2: `grpc/scripting.ts` |
| 129 | `script/send.ts` | `rest/model.ts` | `KeyValueEntry`, `RawLanguage` (type) | a | slice 2: `RawLanguage` goes with the snapshot code to `rest/scripting.ts`; `script/send.ts` keeps the type `KeyValueEntry`, which Task 4.2 points at `http/entries.ts` |
| 130 | `script/send.ts` | `rest/send.ts` | `RestExchange`, `RestSendInput` (type) | a | slice 2: `rest/scripting.ts` |
| 131 | `script/send.ts` | `rest/url.ts` | `composeUrl` | a | slice 2: `rest/scripting.ts` |
| 132 | `script/send.ts` | `types.ts` | `SoapExchange`, `SoapSendInput` (type) | a | slice 2: `soap/scripting.ts` |
| 133 | `script/types/grpc.ts` | `grpc/proto/describe.ts` | `describeMessage`, `MessageFieldDescriptor` | a | slice 2 (Task 2.2a): `grpc/script-types.ts` |
| 134 | `script/types/grpc.ts` | `grpc/proto/load.ts` | `ProtoSet` (type) | a | slice 2 (Task 2.2a): `grpc/script-types.ts` |
| 135 | `script/types/json-schema.ts` | `rest/openapi/model.ts` | `JsonSchema` (type) | c | `JsonSchema` → `json/schema/model.ts` (4.5) |
| 136 | `script/types/rest.ts` | `rest/openapi/model.ts` | `OpenApiOperation` (type) | a | slice 2 (Task 2.2a): `rest/script-types.ts` |
| 137 | `script/types/xsd.ts` | `wsdl/qname.ts` | `QName` (type) | a | slice 2 (Task 2.2a): `soap/script-types.ts` |
| 138 | `script/types/xsd.ts` | `wsdl/qname.ts` | `qnameToString` | a | slice 2 (Task 2.2a): `soap/script-types.ts` |
| 139 | `script/types/xsd.ts` | `xsd/model.ts` | `ComplexType`, `ElementDecl`, `Occurs`, `Particle`, `ResolvedAttribute`, `SimpleType` (type) | a | slice 2 (Task 2.2a): `soap/script-types.ts` |
| 140 | `script/types/xsd.ts` | `xsd/sample-types.ts` | `resolveType` | a | slice 2 (Task 2.2a): `soap/script-types.ts` |
| 141 | `script/types/xsd.ts` | `xsd/sample-values.ts` | `builtinBaseOf`, `facetsOf` | a | slice 2 (Task 2.2a): `soap/script-types.ts` |
| 142 | `script/types/xsd.ts` | `xsd/schema-set.ts` | `SchemaSet` (type) | a | slice 2 (Task 2.2a): `soap/script-types.ts` |
| 143 | `script/types/xsd.ts` | `xsd/xml-scan.ts` | `scanXml`, `ScannedElement` | a | slice 2 (Task 2.2a): `soap/script-types.ts` |
| 144 | `secrets/resolve.ts` | `types.ts` | `SendAuth` (type) | c | `SendAuth`, `AuthSummary` → `http/auth/send-auth.ts` (4.3) |
| 145 | `secrets/scan/apply.ts` | `rest/model.ts` | `KeyValueEntry`, `RestBody`, `RestRequestDef` (type) | b* | `secrets/scan/apply.ts`: request types, type-only (`KeyValueEntry` → `http/entries.ts`, 4.2) |
| 146 | `secrets/scan/walk.ts` | `rest/model.ts` | `KeyValueEntry`, `RestBody`, `RestRequestDef` (type) | b* | `secrets/scan/walk.ts`: request types, type-only (`KeyValueEntry` → `http/entries.ts`, 4.2) |
| 147 | `secrets/scan/walk.ts` | `grpc/model.ts` | `GrpcRequestDef` (type) | b* | `secrets/scan/walk.ts`: request types, type-only |
| 148 | `secrets/scan/walk.ts` | `ws/model.ts` | `WsRequestDef` (type) | b* | `secrets/scan/walk.ts`: request types, type-only |
| 149 | `send-options.ts` | `soap/mime/types.ts` | `AttachmentResolver` (type) | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 150 | `send-options.ts` | `soap/soap-action.ts` | `soapActionHeaders` | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 151 | `send-options.ts` | `soap/transforms.ts` | `prettyPrint`, `removeEmptyContent`, `stripWhitespaces` | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 152 | `send-options.ts` | `types.ts` | `SendAuth`, `SoapSendInput` (type) | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 153 | `send-options.ts` | `rest/body.ts` | `FileResolver` (type) | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 154 | `send-options.ts` | `rest/model.ts` | `KeyValueEntry`, `RestBody`, `RestMethod`, `RestRequestSettings` (type) | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 155 | `send-options.ts` | `rest/response.ts` | `Cookie` (type) | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 156 | `send-options.ts` | `rest/send.ts` | `RestSendInput` (type) | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 157 | `send-options.ts` | `grpc/model.ts` | `GrpcMethodKind`, `GrpcRequestSettings` (type) | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 158 | `send-options.ts` | `grpc/send.ts` | `GrpcSendInput` (type) | c | split into `soap/`, `rest/`, `grpc/send-input.ts` (4.8) |
| 159 | `sequence/transfer.ts` | `rest/response.ts` | `parseSetCookie` | c | `parseSetCookie`, `Cookie` → `http/cookies.ts` (4.2) |
| 160 | `server-api/hooks.ts` | `webhooks/signature.ts` | `SIGNATURE_FAILURES`, `signatureSchemeSchema` | c | `webhooks/signature.ts` → `http/webhook-signature.ts` (4.3) |
| 161 | `soap/auth.ts` | `rest/auth.ts` | `applyAuth` | c | `rest/auth.ts` → `http/auth/apply-auth.ts` (4.3) |
| 162 | `workspace/environments.ts` | `rest/model.ts` | `RestApi` (type) | c | the `Pick` of `slug` and `baseUrl` from `RestApi` written out as a structural type; import removed (4.6) |
| 163 | `ws/call.ts` | `types.ts` | `SendAuth` (type) | c | `SendAuth`, `AuthSummary` → `http/auth/send-auth.ts` (4.3) |
| 164 | `ws/call.ts` | `rest/auth.ts` | `applyAuth` | c | `rest/auth.ts` → `http/auth/apply-auth.ts` (4.3) |
| 165 | `ws/call.ts` | `rest/model.ts` | `KeyValueEntry` (type) | c | `KeyValueEntry`, `entry` → `http/entries.ts` (4.2) |
| 166 | `ws/expand.ts` | `rest/body.ts` | `escapeForLanguage` | c | `escapeForLanguage` → `http/escape.ts` (4.2) |
| 167 | `ws/expand.ts` | `rest/model.ts` | `KeyValueEntry` (type) | c | `KeyValueEntry`, `entry` → `http/entries.ts` (4.2) |
| 168 | `ws/model.ts` | `rest/model.ts` | `KeyValueEntry` (type) | c | `KeyValueEntry`, `entry` → `http/entries.ts` (4.2) |
| 169 | `ws/url.ts` | `rest/model.ts` | `KeyValueEntry` (type) | c | `KeyValueEntry`, `entry` → `http/entries.ts` (4.2) |
| 170 | `xml/index.ts` | `xsd/locate.ts` | `elementPathAt`, `completionContextAt`, `CompletionContext`, `TextRange` (re-export) | c | the text half of `xsd/locate.ts` → `xml/locate.ts` (4.6) |
| 171 | `xpath/evaluate.ts` | `xsd/locate.ts` | `TextRange` (type) | c | the text half of `xsd/locate.ts` → `xml/locate.ts` (4.6) |
| 172 | `xpath/namespaces.ts` | `soap/prefixes.ts` | `prefixForNamespace` | c | `soap/prefixes.ts` → `xml/prefixes.ts` (4.6) |

**Corrections to spec §7.3.** The table there says "all of them"; checked against the code it is short, and four of its rows need a different destination.

1. `http/auth/apply.ts` exists (it holds `sendWithAuth`). `rest/auth.ts` moves to `http/auth/apply-auth.ts`, whole: `resolveAuthChain` in the same file serves gRPC as well as REST, and `applyAuth` serves all four protocols and the definition fetcher.
2. `escapeForLanguage` takes a `RawLanguage`, so the type moves with it (`http/escape.ts`); `rest/model.ts` re-exports it.
3. `parseSetCookie` returns `Cookie[]`, so the interface moves with it (`http/cookies.ts`). `rest/cookies.ts` (the jar) exists and stays.
4. `FetchDocument` is also imported by `rest/openapi/cache.ts`, `import.ts` and `refs.ts`; `rest/openapi/refs.ts` imports `wsdl/ref-policy.ts` and `rest/openapi/cache.ts` imports `wsdl/cache-naming.ts`. Both files move to core (`http/ref-policy.ts`, `project/cache-naming.ts`).
5. `asyncapi/` also takes `OpenApiSource` and `parseDocumentText`; `script/types/json-schema.ts` takes `JsonSchema`. `json/schema/` therefore holds `model.ts`, `parse-text.ts`, `source.ts`, `refs.ts` and `sample.ts`.
6. `http/` imports `soapActionHeaders` for `soapToCurl`, which lives in `http/curl.ts` beside `fromCurl` and also takes `SoapSendInput`; the send does not pass through it. The SOAP half of `http/curl.ts` moves to `soap/curl.ts`; no signature changes.
7. `assert/schema.ts` imports `GRPC_STATUS_NAMES` for the request file's schema, which `AssertionSubject.statusNames` cannot serve. The table moves to `assert/status-names.ts`; `grpc/status.ts` re-exports it.
8. Not in the table at all: `run/oauth2-token.ts` imports `rest/oauth2.ts` (moves to `http/auth/oauth2.ts`); `project/schema.ts`, `project/load.ts` and `server-api/hooks.ts` import `webhooks/signature.ts` (moves to `http/webhook-signature.ts`); `project/keystores.ts` and the run code import `wss/keystore/` (moves to `keystore/`); `project/wss-configs.ts` imports `wss/model.ts` (the file moves to `wss/configs.ts`); `project/attachments-cache.ts` imports `AttachmentResolver` from `soap/mime/types.ts` (the type moves to it); `project/properties.ts` imports `entitizeValue` from `soap/transforms.ts` (moves to `xml/entitize.ts`) and `SoapSendInput` for `expandSendInput` (moves to `soap/expand.ts`); `xml/index.ts` and `xpath/evaluate.ts` import the text half of `xsd/locate.ts` (moves to `xml/locate.ts`, with `QName` to `xml/qname.ts`); `xpath/namespaces.ts` imports `soap/prefixes.ts` (moves to `xml/prefixes.ts`); `project/environments.ts` and `workspace/environments.ts` import `RestApi` for a two-field `Pick` (written out).

**Exceptions to rule 2 after this slice.** These are the entries of `CORE_EXCEPTIONS` in the script of Task 4.1. Rule 1 has none.

| Core file | May import | Kind | Until | In spec §7.2's table |
| --- | --- | --- | --- | --- |
| `protocols.ts` | any protocol file | value | stays | yes |
| `index.ts` | any protocol file | value | stays | yes |
| `run/prepare.ts` | any protocol file | value | slice 5 deletes the file | no: temporary, preamble ruling |
| `run/run.ts` | `soap/run.ts`, `rest/run.ts`, `grpc/run.ts` | value | slice 5 | no: the re-exports of `soapResponseSubject`, `restSubject` and `grpcSubject` slice 1 leaves (Task 1.7) |
| `run/script-support.ts` | any protocol file | value | slice 5 removes `scriptTypesFor` | no: the function slice 1 leaves exported without a caller (Task 1.7) |
| `script/index.ts` | any protocol file | value | slice 5 | no: the re-exports slice 2 leaves |
| `project/schema.ts` | `soap/files.ts`, `rest/files.ts`, `grpc/files.ts`, `ws/files.ts` | value | slice 5 | no: the re-exports slice 3 leaves |
| `project/schema.ts` | `wss/model.ts` | value | phase 3 | no: **b\*** |
| `project/model.ts` | `rest/model.ts`, `grpc/model.ts`, `ws/model.ts` | type-only | phase 3 | yes |
| `project/model.ts` | `webhooks/model.ts` | type-only | phase 3 | no: **b\*** |
| `project/model.ts` | `wsa/model.ts` | value | phase 3 | no: **b\*** |
| `project/history.ts` | `ws/model.ts`, `rest/sse.ts` | type-only | phase 2 | yes |
| `project/history.ts` | `ws/transcript.ts`, `rest/sse-transcript.ts`, `rest/contract-check.ts` | value | phase 2 | types yes, values no: **b\*** |
| `project/load.ts`, `project/serialize.ts` | `rest/…`, `webhooks/…` | value | phase 3 | yes |
| `project/request-location.ts` | `rest/model.ts` | type-only | phase 3 | no: **b\*** |
| `secrets/scan/walk.ts` | `rest/model.ts`, `grpc/model.ts`, `ws/model.ts` | type-only | phase 3 | no: **b\*** |
| `secrets/scan/apply.ts` | `rest/model.ts` | type-only | phase 3 | no: **b\*** |
| `import-detect.ts` | `rest/postman/parse.ts`, `soap/legacy-project/format.ts` | value | phase 7 | yes |

Why each **b\*** edge is not removed here: `project/model.ts` declares the SOAP request and interface types, which carry a `WsaConfig` and its default, and the project's webhook collection; `project/history.ts` applies the caps when it writes an entry; `project/schema.ts` holds the WS-Security file schemas core loads and saves until phase 3, and they default two part lists; `project/request-location.ts` and the two `secrets/scan/` files walk the request trees of every protocol by their types. Each of them is the container split of phase 3 or the History split of phase 2, not a move. The spec's table also names `project/save.ts`; it imports no protocol folder, so it has no entry. The "slice 5" rows and `run/prepare.ts` are temporary: slice 5 (Task 5.2) deletes `run/prepare.ts` and `scriptTypesFor`, moves the re-exports of `run/run.ts`, `script/index.ts` and `project/schema.ts` to `index.ts`, and deletes the ten entries with them. Spec R10 counts three temporary edges (`run/prepare.ts`, `script/index.ts`, `project/schema.ts`); the two `run/` files are two more, because slice 1 keeps the subject functions and `scriptTypesFor` exported from where they were until the public exports change.

**What moves, by symbol.** This is the table the rule for unlisted importers refers to.

| Imported from | Names | New home | Task |
| --- | --- | --- | --- |
| `rest/model.ts` | `KeyValueEntry`, `entry` | `http/entries.ts` | 4.2 |
| `rest/model.ts` | `RawLanguage` | `http/escape.ts` | 4.2 |
| `rest/body.ts` | `escapeForLanguage` | `http/escape.ts` | 4.2 |
| `rest/response.ts` | `Cookie`, `parseSetCookie` | `http/cookies.ts` | 4.2 |
| `soap/charset.ts` | the whole file | `http/charset.ts` | 4.2 |
| `soap/mime/multipart.ts` | `mediaTypeOf` | `http/media-type.ts` | 4.2 |
| `ws/transcript.ts` | `capByEnds`, `CapLimits`, `WS_HISTORY_HEAD`, `WS_HISTORY_TAIL`, `WS_HISTORY_MAX_BYTES` | `http/transcript-cap.ts` | 4.2 |
| root `types.ts` | `SendAuth`, `AuthSummary` | `http/auth/send-auth.ts` | 4.3 |
| `rest/auth.ts` | the whole file | `http/auth/apply-auth.ts` | 4.3 |
| `rest/oauth2.ts` | the whole file | `http/auth/oauth2.ts` | 4.3 |
| `webhooks/signature.ts` | the whole file | `http/webhook-signature.ts` | 4.3 |
| `wsdl/resolver.ts` | `FetchDocument`, `FetchedDocument` | `http/fetch-document.ts` | 4.4 |
| `wsdl/fetch.ts` | `createDefaultFetchDocument` (the file) | `http/fetch-document.ts` | 4.4 |
| `wsdl/fetch.ts` | `decodeXmlBytes` | `xml/decode.ts` | 4.4 |
| `wsdl/ref-policy.ts` | the whole file | `http/ref-policy.ts` | 4.4 |
| `wsdl/cache-naming.ts` | the whole file | `project/cache-naming.ts` | 4.4 |
| `rest/openapi/model.ts` | `JsonValue`, `JsonSchema`, `OpenApiDiscriminator`, `OpenApiXml` | `json/schema/model.ts` | 4.5 |
| `rest/openapi/parse.ts` | `parseDocumentText` | `json/schema/parse-text.ts` | 4.5 |
| `rest/openapi/import.ts` | `OpenApiSource` | `json/schema/source.ts` | 4.5 |
| `rest/openapi/refs.ts`, `rest/openapi/sample.ts` | the whole files | `json/schema/refs.ts`, `json/schema/sample.ts` | 4.5 |
| `wsdl/qname.ts` | `QName` (the type only) | `xml/qname.ts` | 4.6 |
| `xsd/locate.ts` | `TextRange`, `CompletionContext`, `elementPathAt`, `completionContextAt` | `xml/locate.ts` | 4.6 |
| `soap/prefixes.ts` | the whole file | `xml/prefixes.ts` | 4.6 |
| `soap/transforms.ts` | `entitizeValue` | `xml/entitize.ts` | 4.6 |
| `grpc/status.ts` | `GRPC_STATUS_NAMES` | `assert/status-names.ts` | 4.6 |
| `soap/mime/types.ts` | `AttachmentResolver` | `project/attachments-cache.ts` | 4.6 |
| `wss/keystore/` | the whole folder | `keystore/` | 4.7 |
| `project/wss-configs.ts` | the whole file (it is SOAP's) | `wss/configs.ts` | 4.7 |
| root `import.ts`, `send.ts`, `generate.ts`, `operations.ts`, `types.ts` | the whole files | `soap/` | 4.8 |
| root `send-options.ts` | `toSendInput` and its types / `toRestSendInput` and its types / `toGrpcSendInput` and its types | `soap/send-input.ts` / `rest/send-input.ts` / `grpc/send-input.ts` | 4.8 |
| `http/curl.ts` | `soapToCurl`, `fromCurl`, `FromCurlResult` | `soap/curl.ts` | 4.8 |
| `project/properties.ts` | `expandSendInput` | `soap/expand.ts` | 4.8 |

Two decisions this table carries that the preamble's File Structure does not show. `soap/transforms.ts` stays where it is: its three envelope transforms know the SOAP wrapper elements, and only `entitizeValue` is used by core. The WS-Security file schemas stay in `project/schema.ts`: core loads and saves those files until phase 3, slice 3's split test pins them there, and the one import they need is a listed exception.

---

### Task 4.1: The import graph script, and the tree compared with what this slice expects

**Files:**
- Create: `scripts/engine-import-graph.mjs`

**Interfaces:**
- Consumes: the `typescript` package (already a root dev dependency), for its parser only.
- Produces:
  - `node scripts/engine-import-graph.mjs` prints every cross-group import, one per line, then `N cross-group import(s)`; `--check` prints what breaks a rule on stderr and one summary line on stdout, and exits 1 when anything does; `--json` prints `{ edges, violations, stale, unresolved }`; `--src <dir>` reads another tree.
  - Exports, for `eslint.config.js` and the test of Task 4.9: `GROUP_FOLDERS`, `SOAP_ROOT_FILES` (until Task 4.8), `CORE_EXCEPTIONS`, `groupOf(file)`, `collectEdges(srcDir)`, `checkEdges(edges, exceptions?)`, `formatEdge(edge)`.

A `.mjs` file, not `.ts`: `eslint.config.js` imports its two lists in Task 4.9, and an ESLint config has to load under any Node the editor integration runs, with or without type stripping. `tsc --noEmit -p scripts/tsconfig.json` includes `**/*.ts` only, so the JSDoc types are for the editor; Prettier checks the file like any other.

`--check` is not part of `pnpm check` until Task 4.9: the tree breaks the rules until Task 4.8 is done.

- [ ] **Step 1: Create `scripts/engine-import-graph.mjs`**

```js
/**
 * The import graph of `packages/engine/src`, by group (protocol modules spec §7).
 *
 * Every folder of the engine belongs to one group: a protocol (`soap`, `rest`, `grpc`, `ws`) or
 * `core`. Two rules hold between them:
 *
 *  1. a protocol group imports core and itself, never another protocol group;
 *  2. core imports no protocol group, except the edges listed in {@link CORE_EXCEPTIONS}.
 *
 * `node scripts/engine-import-graph.mjs` prints every import that leaves its group for a protocol
 * group, one per line: `[core->rest] project/history.ts -> rest/sse.ts : SseRow (type-only)`.
 * `--check` prints only what breaks a rule and exits non-zero when anything does; an exception that
 * no import uses any more breaks it too, so the list cannot outlive its reasons. `--json` prints the
 * same as JSON. `--src <dir>` reads another tree (the test's fixture).
 *
 * Wired into `pnpm check` as `pnpm check:engine-layers`. `eslint.config.js` builds its
 * `no-restricted-imports` blocks from the same {@link GROUP_FOLDERS} and {@link CORE_EXCEPTIONS}, so
 * an editor flags a wrong import as it is typed; this script is the exact gate, because it resolves
 * each import to a file, tells a type-only import from a value import, and sees `import()` types.
 *
 * A plain `.mjs` file so that `eslint.config.js` can import it under any Node version.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/** The top-level folders of `packages/engine/src` that make up each protocol group (spec §7.1). */
export const GROUP_FOLDERS = Object.freeze({
  soap: ['soap', 'wsdl', 'xsd', 'wss', 'wsa', 'validate'],
  rest: ['rest', 'webhooks'],
  grpc: ['grpc'],
  ws: ['ws', 'asyncapi'],
});

/**
 * Root files that are SOAP's until they move under `soap/`. Removed by the task that moves them.
 *
 * @type {readonly string[]}
 */
export const SOAP_ROOT_FILES = Object.freeze(['import.ts', 'send.ts', 'generate.ts', 'operations.ts', 'types.ts']);

/**
 * One import core is allowed to make of a protocol group.
 *
 * @typedef {object} CoreException
 * @property {string} from the importing file, relative to the source root
 * @property {string} to the imported file; a value ending in `/` allows every file under that
 *   folder, and `*` allows any protocol file
 * @property {boolean} [typeOnly] when true, only a type-only import is allowed
 * @property {string} until what removes the exception
 */

/**
 * The imports core makes of a protocol group (spec §7.2, rule 2). Rule 1 has no exceptions.
 *
 * Three kinds, told apart by `until`: the two files that are what they are (`protocols.ts`,
 * `index.ts`); the barrels that keep an old import path working until the public exports change;
 * and the project model, History, the loader and the writer, which hold protocol types until the
 * phases of #184 that split them.
 *
 * The spec's table also names `project/save.ts`; it imports no protocol folder, so it has no entry
 * here, and an entry nothing uses fails the check.
 *
 * @type {readonly CoreException[]}
 */
export const CORE_EXCEPTIONS = Object.freeze([
  { from: 'protocols.ts', to: '*', until: 'stays: the composition file' },
  { from: 'index.ts', to: '*', until: 'stays: the public exports' },
  { from: 'run/prepare.ts', to: '*', until: 'slice 5 deletes the file' },
  { from: 'run/run.ts', to: 'soap/run.ts', until: 'slice 5: the re-export of soapResponseSubject' },
  { from: 'run/run.ts', to: 'rest/run.ts', until: 'slice 5: the re-export of restSubject' },
  { from: 'run/run.ts', to: 'grpc/run.ts', until: 'slice 5: the re-export of grpcSubject' },
  { from: 'run/script-support.ts', to: '*', until: 'slice 5 removes scriptTypesFor' },
  { from: 'script/index.ts', to: '*', until: 'slice 5: the re-exports of the scripting facets' },
  { from: 'project/schema.ts', to: 'soap/files.ts', until: 'slice 5: the re-exports of the file schemas' },
  { from: 'project/schema.ts', to: 'rest/files.ts', until: 'slice 5: the re-exports of the file schemas' },
  { from: 'project/schema.ts', to: 'grpc/files.ts', until: 'slice 5: the re-exports of the file schemas' },
  { from: 'project/schema.ts', to: 'ws/files.ts', until: 'slice 5: the re-exports of the file schemas' },
  { from: 'project/schema.ts', to: 'wss/model.ts', until: 'phase 3' },
  { from: 'project/model.ts', to: 'rest/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'project/model.ts', to: 'grpc/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'project/model.ts', to: 'ws/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'project/model.ts', to: 'webhooks/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'project/model.ts', to: 'wsa/model.ts', until: 'phase 3' },
  { from: 'project/history.ts', to: 'ws/model.ts', typeOnly: true, until: 'phase 2' },
  { from: 'project/history.ts', to: 'ws/transcript.ts', until: 'phase 2' },
  { from: 'project/history.ts', to: 'rest/sse.ts', typeOnly: true, until: 'phase 2' },
  { from: 'project/history.ts', to: 'rest/sse-transcript.ts', until: 'phase 2' },
  { from: 'project/history.ts', to: 'rest/contract-check.ts', until: 'phase 2' },
  { from: 'project/load.ts', to: 'rest/', until: 'phase 3' },
  { from: 'project/load.ts', to: 'webhooks/', until: 'phase 3' },
  { from: 'project/serialize.ts', to: 'rest/', until: 'phase 3' },
  { from: 'project/serialize.ts', to: 'webhooks/', until: 'phase 3' },
  { from: 'project/request-location.ts', to: 'rest/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'secrets/scan/walk.ts', to: 'rest/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'secrets/scan/walk.ts', to: 'grpc/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'secrets/scan/walk.ts', to: 'ws/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'secrets/scan/apply.ts', to: 'rest/model.ts', typeOnly: true, until: 'phase 3' },
  { from: 'import-detect.ts', to: 'rest/postman/parse.ts', until: 'phase 7' },
  { from: 'import-detect.ts', to: 'soap/legacy-project/format.ts', until: 'phase 7' },
]);

/**
 * One import that leaves its group for a protocol group.
 *
 * @typedef {object} Edge
 * @property {string} from the importing file, relative to the source root, `/`-separated
 * @property {string} to the imported file, likewise
 * @property {string} fromGroup
 * @property {string} toGroup
 * @property {readonly string[]} names the imported names, as the imported file exports them
 * @property {boolean} typeOnly true when the import disappears at build time
 */

/**
 * The group a source file belongs to.
 *
 * @param {string} file relative to the source root, `/`-separated
 * @returns {string} `soap`, `rest`, `grpc`, `ws` or `core`
 */
export function groupOf(file) {
  const slash = file.indexOf('/');
  if (slash === -1) {
    return SOAP_ROOT_FILES.includes(file) ? 'soap' : 'core';
  }
  const top = file.slice(0, slash);
  for (const [group, folders] of Object.entries(GROUP_FOLDERS)) {
    if (folders.includes(top)) {
      return group;
    }
  }
  return 'core';
}

/**
 * Every `.ts` file under `dir`, sorted.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found.sort();
}

/**
 * The file a relative specifier names, as the engine writes them (`'../rest/model.js'`).
 *
 * @param {string} importer absolute path of the importing file
 * @param {string} specifier
 * @returns {string | undefined}
 */
function resolveSpecifier(importer, specifier) {
  const base = resolve(dirname(importer), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/**
 * Every module a file names: static imports, re-exports, `import()` calls and `import()` types.
 *
 * @param {string} file absolute path
 * @returns {{ specifier: string, names: string[], typeOnly: boolean }[]}
 */
function importsOf(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  /** @type {{ specifier: string, names: string[], typeOnly: boolean }[]} */
  const found = [];
  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = [];
      let typeOnly = clause?.isTypeOnly ?? false;
      if (clause === undefined) {
        names.push('(side effect)');
      } else {
        if (clause.name !== undefined) {
          names.push('default');
        }
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          names.push('*');
        }
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            names.push((element.propertyName ?? element.name).text);
          }
          const allTyped = bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
          typeOnly = typeOnly || (clause.name === undefined && allTyped);
        }
      }
      found.push({ specifier: node.moduleSpecifier.text, names, typeOnly });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      const names = [];
      let typeOnly = node.isTypeOnly;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        names.push('*');
      } else {
        for (const element of clause.elements) {
          names.push((element.propertyName ?? element.name).text);
        }
        typeOnly = typeOnly || (clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly));
      }
      found.push({ specifier: node.moduleSpecifier.text, names, typeOnly });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const name = node.qualifier === undefined ? '*' : node.qualifier.getText(source);
      found.push({ specifier: node.argument.literal.text, names: [name], typeOnly: true });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push({ specifier: node.arguments[0].text, names: ['(dynamic)'], typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Walks `srcDir` and returns every import that leaves its group for a protocol group, plus the
 * relative imports that name no file.
 *
 * @param {string} srcDir
 * @returns {{ edges: Edge[], unresolved: string[] }}
 */
export function collectEdges(srcDir) {
  const root = resolve(srcDir);
  /** @type {Edge[]} */
  const edges = [];
  /** @type {string[]} */
  const unresolved = [];
  for (const file of sourceFiles(root)) {
    const from = relative(root, file).split(sep).join('/');
    for (const found of importsOf(file)) {
      if (!found.specifier.startsWith('.')) {
        continue;
      }
      const target = resolveSpecifier(file, found.specifier);
      if (target === undefined) {
        unresolved.push(`${from} -> ${found.specifier}`);
        continue;
      }
      const to = relative(root, target).split(sep).join('/');
      const fromGroup = groupOf(from);
      const toGroup = groupOf(to);
      if (toGroup !== 'core' && toGroup !== fromGroup) {
        edges.push({ from, to, fromGroup, toGroup, names: found.names, typeOnly: found.typeOnly });
      }
    }
  }
  return { edges, unresolved };
}

/**
 * @param {CoreException} exception
 * @param {Edge} edge
 * @returns {boolean}
 */
function allows(exception, edge) {
  if (exception.from !== edge.from || (exception.typeOnly === true && !edge.typeOnly)) {
    return false;
  }
  if (exception.to === '*') {
    return true;
  }
  return exception.to.endsWith('/') ? edge.to.startsWith(exception.to) : edge.to === exception.to;
}

/**
 * Splits `edges` into what the rules allow and what they do not.
 *
 * @param {readonly Edge[]} edges
 * @param {readonly CoreException[]} [exceptions]
 * @returns {{ violations: Edge[], stale: CoreException[] }} `violations` break rule 1 or rule 2;
 *   `stale` are exceptions no edge uses
 */
export function checkEdges(edges, exceptions = CORE_EXCEPTIONS) {
  const used = new Set();
  const violations = edges.filter((edge) => {
    if (edge.fromGroup !== 'core') {
      return true;
    }
    const matching = exceptions.filter((exception) => allows(exception, edge));
    for (const exception of matching) {
      used.add(exception);
    }
    return matching.length === 0;
  });
  return { violations, stale: exceptions.filter((exception) => !used.has(exception)) };
}

/**
 * One edge as a line of the report.
 *
 * @param {Edge} edge
 * @returns {string}
 */
export function formatEdge(edge) {
  const names = edge.names.join(', ');
  const suffix = edge.typeOnly ? ' (type-only)' : '';
  return `[${edge.fromGroup}->${edge.toGroup}] ${edge.from} -> ${edge.to} : ${names}${suffix}`;
}

/** @param {readonly string[]} argv */
function main(argv) {
  const srcFlag = argv.indexOf('--src');
  const srcDir =
    srcFlag === -1
      ? fileURLToPath(new URL('../packages/engine/src', import.meta.url))
      : resolve(argv[srcFlag + 1] ?? '.');
  const { edges, unresolved } = collectEdges(srcDir);
  const { violations, stale } = checkEdges(edges);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ edges, violations, stale, unresolved }, null, 2));
  } else if (argv.includes('--check')) {
    for (const edge of violations) {
      const rule =
        edge.fromGroup === 'core' ? 'rule 2: core imports no protocol group' : 'rule 1: no other protocol group';
      console.error(`${formatEdge(edge)}\n    breaks ${rule} (protocol modules spec §7.2)`);
    }
    for (const exception of stale) {
      console.error(`stale exception: ${exception.from} -> ${exception.to} is no longer imported; remove it`);
    }
    for (const line of unresolved) {
      console.error(`unresolved import: ${line}`);
    }
    const allowed = edges.length - violations.length;
    console.log(
      `engine layers: ${String(violations.length)} violation(s), ${String(stale.length)} stale exception(s), ` +
        `${String(allowed)} allowed import(s) from core`,
    );
  } else {
    for (const edge of edges) {
      console.log(formatEdge(edge));
    }
    console.log(`${String(edges.length)} cross-group import(s)`);
  }

  if (argv.includes('--check') && violations.length + stale.length + unresolved.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 2: Run it**

Run: `node scripts/engine-import-graph.mjs | tail -1`
Expected: `N cross-group import(s)`. On `f9c0411b` alone N is 402; with slices 1 to 3 landed it is lower (68 of their 72 class-(a) edges are gone) and a little higher again (`protocols.ts` and `run/prepare.ts` importing the modules, the re-exports of `run/run.ts`, `script/index.ts` and `project/schema.ts`, and the imports listed under "The importers slices 1 to 3 add").

Run: `node scripts/engine-import-graph.mjs --check; echo "exit $?"`
Expected: lines of the form

```
[grpc->rest] grpc/model.ts -> rest/model.ts : KeyValueEntry (type-only)
    breaks rule 1: no other protocol group (protocol modules spec §7.2)
```

then possibly `stale exception: …` lines, then `engine layers: V violation(s), S stale exception(s), A allowed import(s) from core` and `exit 1`. No line starts with `unresolved import`.

- [ ] **Step 3: Compare the violations with what this slice removes**

Run: `node scripts/engine-import-graph.mjs --check 2>&1 | grep '^\['`

Every line it prints must be one of these. If a line is none of them, stop and report it: it is a protocol reaching into another for something this plan does not move.

1. A row of class (c) in the slice's table, from the same importer.
2. A class-(c) import made by a file slices 1 to 3 created or kept, of names in "What moves, by symbol". They are the rows of "The importers slices 1 to 3 add" that cross a group: `script/send.ts`, `project/load-helpers.ts` and `project/serialize-helpers.ts` import `KeyValueEntry` from `rest/model.ts` (Task 4.2); `script/types/json-schema.ts` imports `JsonSchema` from `rest/openapi/model.ts` (Task 4.5); `project/schema-parts.ts` imports `signatureSchemeSchema` from `webhooks/signature.ts` (Task 4.3); `run/send-helpers.ts` imports `wss/keystore/index.ts` (Task 4.7) and `SendAuth` from the root `types.ts` (Task 4.3); `grpc/run.ts` imports `resolveAuthChain` from `rest/auth.ts` (Task 4.3). (`rest/run.ts` and `grpc/run.ts` also import the root `send-options.ts`; that file is core until Task 4.8 moves it, so those two imports are not printed here.)
3. An import the root `send-options.ts` makes (Task 4.8 splits it).

The imports slices 1 to 3 kept in core on purpose are already entries of `CORE_EXCEPTIONS` and are not printed: `run/prepare.ts`, the three re-exports of `run/run.ts`, `run/script-support.ts` (`scriptTypesFor`), `script/index.ts`, and the four `files.ts` re-exports of `project/schema.ts`. An import from core that is in neither list above and not in `CORE_EXCEPTIONS` is one this plan did not expect: stop and report it.

No `stale exception` line is expected: every entry names an import the tree has at this point. A `stale exception` line means slices 1 to 3 did not leave the import the entry names; note it, and Task 4.9, Step 3 deals with it.

- [ ] **Step 4: Format, check, commit**

```bash
pnpm exec prettier --write scripts/engine-import-graph.mjs
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add scripts/engine-import-graph.mjs
git commit -m "chore(scripts): an import graph of the engine, by protocol group (#184)" -m "Prints every import that leaves its group for a protocol group, and with --check what breaks the two dependency rules of the protocol modules spec (§7.2). Not yet part of pnpm check: the tree breaks the rules until the moves that follow are done."
```

---

### Task 4.2: Table rows, body escaping, cookies, charsets, media types and the transcript cap move to `http/`

**Files:**
- Create: `packages/engine/src/http/entries.ts`, `http/escape.ts`, `http/cookies.ts`, `http/media-type.ts`, `http/transcript-cap.ts`
- Move: `packages/engine/src/soap/charset.ts` → `packages/engine/src/http/charset.ts`
- Modify (the files that give something up): `rest/model.ts`, `rest/body.ts`, `rest/response.ts`, `soap/mime/multipart.ts`, `ws/transcript.ts`
- Modify (importers): `rest/sse-transcript.ts`, `soap/mime/send-pipeline.ts`, the root `send.ts`, `grpc/command.ts`, `grpc/expand.ts`, `grpc/model.ts`, `grpc/send.ts`, `ws/call.ts`, `ws/expand.ts`, `ws/model.ts`, `ws/url.ts`, `asyncapi/map.ts`, `secrets/scan/walk.ts`, `secrets/scan/apply.ts`, `sequence/transfer.ts`, and by the rule `script/send.ts`, `project/load-helpers.ts`, `project/serialize-helpers.ts`
- Test: none changes. `packages/engine/test/**` keeps importing `entry`, `escapeForLanguage`, `parseSetCookie`, `mediaTypeOf` and the caps from where it did, through the re-exports.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `http/entries.ts`: `interface KeyValueEntry`, `entry(name, value, options?)`
  - `http/escape.ts`: `type RawLanguage`, `escapeForLanguage(value, language)`
  - `http/cookies.ts`: `interface Cookie`, `parseSetCookie(rawHeaders)`
  - `http/media-type.ts`: `mediaTypeOf(contentType)`
  - `http/transcript-cap.ts`: `WS_HISTORY_HEAD`, `WS_HISTORY_TAIL`, `WS_HISTORY_MAX_BYTES`, `interface CapLimits`, `capByEnds(items, limits, sizeOf, strip)`
  - `http/charset.ts`: everything `soap/charset.ts` exported, unchanged
  - Re-exports that keep every other import path working: `rest/model.ts` (`KeyValueEntry`, `entry`, `RawLanguage`), `rest/body.ts` (`escapeForLanguage`), `rest/response.ts` (`Cookie`, `parseSetCookie`), `soap/mime/multipart.ts` (`mediaTypeOf`), `ws/transcript.ts` (the three constants, `CapLimits`, `capByEnds`)

- [ ] **Step 1: `http/entries.ts` and `http/escape.ts`, out of `rest/model.ts` and `rest/body.ts`**

Create `packages/engine/src/http/entries.ts`: the header below, a blank line, then `rest/model.ts` lines 40–68 unchanged (the JSDoc and declaration of `KeyValueEntry`, the JSDoc and body of `entry`).

```ts
/**
 * A row of a name/value table: a path or query parameter, a header, a form field, a metadata entry.
 *
 * In `http/` because REST, gRPC and WebSocket requests all keep such rows, and a protocol folder
 * imports core and itself, never another protocol (protocol modules spec §7.2). `rest/model.ts`
 * re-exports both names, so REST code and the public exports read them where they always did.
 */
```

Create `packages/engine/src/http/escape.ts`: the header below, a blank line, `rest/model.ts` lines 70–71 (the JSDoc and declaration of `RawLanguage`), a blank line, then `rest/body.ts` lines 188–210 (the JSDoc and body of `escapeForLanguage`), all unchanged.

```ts
/**
 * Escaping a value that is substituted into a body, by the language the body is written in.
 *
 * In `http/` because the REST, gRPC and WebSocket expansions all apply it, and a protocol folder
 * imports core and itself, never another protocol (protocol modules spec §7.2). `rest/model.ts`
 * re-exports {@link RawLanguage} and `rest/body.ts` re-exports {@link escapeForLanguage}.
 */
```

In `rest/model.ts`:

1. Add two imports after `import type { Assertion } from '../assert/model.js';`:

```ts
import type { KeyValueEntry } from '../http/entries.js';
import type { RawLanguage } from '../http/escape.js';
```

2. Replace lines 40–71 (everything from the JSDoc of `KeyValueEntry` through the declaration of `RawLanguage`) with:

```ts
// Declared in `http/`, which the gRPC and WebSocket folders share with this one; re-exported so REST
// code and the public exports keep reading them from here.
export { entry } from '../http/entries.js';
export type { KeyValueEntry, RawLanguage };
```

In `rest/body.ts`:

1. Replace the two imports

```ts
import { encodeBody } from '../soap/charset.js';
import { mediaTypeOf } from '../soap/mime/multipart.js';
```

with

```ts
import { encodeBody } from '../http/charset.js';
import { mediaTypeOf } from '../http/media-type.js';
```

2. Replace lines 188–210 (the JSDoc and body of `escapeForLanguage`) with:

```ts
export { escapeForLanguage } from '../http/escape.js';
```

3. In the JSDoc of `charset` in `EncodeBodyOptions` (line 27), `soap/charset.ts` becomes `http/charset.ts`.

- [ ] **Step 2: `http/cookies.ts`, out of `rest/response.ts`**

Create `packages/engine/src/http/cookies.ts`: the header below, a blank line, then `rest/response.ts` lines 175–276 unchanged (`Cookie`, `parseSetCookie`, and the two private functions `parseOne` and `unquote`; they are the end of the file).

```ts
/**
 * The cookies a response sets: what one is, and how every `Set-Cookie` header is read.
 *
 * In `http/` because a sequence's transfers read a response's cookies whatever protocol sent the
 * request, and core imports no protocol folder (protocol modules spec §7.2). `rest/response.ts`
 * re-exports both names; the cookie jar itself stays in `rest/cookies.ts`.
 */
```

In `rest/response.ts`:

1. Replace the two imports

```ts
import { decodeBody } from '../soap/charset.js';
import { mediaTypeOf } from '../soap/mime/multipart.js';
```

with

```ts
import { decodeBody } from '../http/charset.js';
import { mediaTypeOf } from '../http/media-type.js';
```

2. Replace lines 175–276 with:

```ts
export { parseSetCookie } from '../http/cookies.js';
export type { Cookie } from '../http/cookies.js';
```

- [ ] **Step 3: `http/media-type.ts`, out of `soap/mime/multipart.ts`**

Create `packages/engine/src/http/media-type.ts`: the header below, a blank line, then `soap/mime/multipart.ts` lines 48–52 unchanged (the JSDoc and body of `mediaTypeOf`).

```ts
/**
 * Reading a `Content-Type` header value.
 *
 * In `http/` because the SOAP multipart code and the REST body and response code both need the bare
 * media type, and a protocol folder imports core and itself, never another protocol (protocol
 * modules spec §7.2). `soap/mime/multipart.ts` re-exports the name.
 */
```

In `soap/mime/multipart.ts`, add after `import { randomBytes } from 'node:crypto';`:

```ts
import { mediaTypeOf } from '../../http/media-type.js';
```

and replace lines 48–52 with:

```ts
export { mediaTypeOf };
```

(The file calls `mediaTypeOf` itself, twice, which is why it imports the name and does not only re-export it.)

- [ ] **Step 4: `http/transcript-cap.ts`, out of `ws/transcript.ts`**

Create `packages/engine/src/http/transcript-cap.ts`: the header below, a blank line, `ws/transcript.ts` lines 7–9 (the three `WS_HISTORY_…` constants), a blank line, then lines 17–52 (`CapLimits`, the JSDoc and body of `capByEnds`), all unchanged. The names keep their `WS_` prefix: they are public exports, and slice 5 owns renames.

```ts
/**
 * The cap History puts on a long exchange: both ends kept, then a byte budget.
 *
 * In `http/` because a WebSocket session's frames and a REST event stream's rows are capped the same
 * way, and a protocol folder imports core and itself, never another protocol (protocol modules spec
 * §7.2). `ws/transcript.ts` re-exports every name, under the names they have always had.
 */
```

In `ws/transcript.ts`, delete lines 7–9 and lines 17–52, and replace the import line `import type { WsFrame } from './model.js';` with:

```ts
import { capByEnds, WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL } from '../http/transcript-cap.js';
import type { CapLimits } from '../http/transcript-cap.js';
import type { WsFrame } from './model.js';

export { capByEnds, WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL };
export type { CapLimits };
```

In `rest/sse-transcript.ts`, both imports (lines 5–6) change their specifier from `'../ws/transcript.js'` to `'../http/transcript-cap.js'`:

```ts
import type { CapLimits } from '../http/transcript-cap.js';
import { capByEnds, WS_HISTORY_HEAD, WS_HISTORY_MAX_BYTES, WS_HISTORY_TAIL } from '../http/transcript-cap.js';
```

- [ ] **Step 5: Move `soap/charset.ts`, and switch the importers in other groups**

```bash
git mv packages/engine/src/soap/charset.ts packages/engine/src/http/charset.ts
perl -pi -e "s{'\./soap/charset\.js'}{'./http/charset.js'}" packages/engine/src/send.ts
perl -pi -e "s{'\.\./charset\.js'}{'../../http/charset.js'}" packages/engine/src/soap/mime/send-pipeline.ts
git grep -lF "import type { KeyValueEntry } from '../rest/model.js';" -- packages/engine/src ':!packages/engine/src/rest' ':!packages/engine/src/webhooks' | xargs perl -pi -e "s{^import type \{ KeyValueEntry \} from '\.\./rest/model\.js';}{import type { KeyValueEntry } from '../http/entries.js';}"
git grep -lF "import { escapeForLanguage } from '../rest/body.js';" -- packages/engine/src | xargs perl -pi -e "s{^import \{ escapeForLanguage \} from '\.\./rest/body\.js';}{import { escapeForLanguage } from '../http/escape.js';}"
```

The first three lines move the charset file and fix its two remaining importers (Steps 1 and 2 already wrote the new path into `rest/body.ts` and `rest/response.ts`). The fourth switches every file outside `rest/` and `webhooks/` whose import line is exactly `import type { KeyValueEntry } from '../rest/model.js';`: on `f9c0411b` that is `grpc/command.ts`, `grpc/expand.ts`, `grpc/model.ts`, `grpc/send.ts`, `ws/call.ts`, `ws/expand.ts`, `ws/model.ts` and `ws/url.ts`, and after slices 2 and 3 also `script/send.ts`, `project/load-helpers.ts` and `project/serialize-helpers.ts`. The fifth switches `grpc/expand.ts` and `ws/expand.ts`.

Four importers take the names together with others, so they are edited by hand:

`asyncapi/map.ts`:

```ts
// before
import { entry, type KeyValueEntry } from '../rest/model.js';
// after
import { entry, type KeyValueEntry } from '../http/entries.js';
```

`secrets/scan/walk.ts` and `secrets/scan/apply.ts` (the same line in both):

```ts
// before
import type { KeyValueEntry, RestBody, RestRequestDef } from '../../rest/model.js';
// after
import type { KeyValueEntry } from '../../http/entries.js';
import type { RestBody, RestRequestDef } from '../../rest/model.js';
```

`sequence/transfer.ts`:

```ts
// before
import { parseSetCookie } from '../rest/response.js';
// after
import { parseSetCookie } from '../http/cookies.js';
```

The three files of slices 2 and 3 are caught by the fourth command, as said above; no other file those slices add imports one of these names from another group. Should `tsc` or the import graph show one all the same, the rule is: `KeyValueEntry` and `entry` come from `http/entries.js`, `RawLanguage` and `escapeForLanguage` from `http/escape.js`, `Cookie` and `parseSetCookie` from `http/cookies.js`; a line that imports one of them together with REST-only names is split as `secrets/scan/walk.ts` is. `project/load.ts` and `project/serialize.ts` are left alone: they import `KeyValueEntry` beside REST types from a file they are allowed to import.

- [ ] **Step 6: Verify**

```bash
nice pnpm exec tsc -b
node scripts/engine-import-graph.mjs --check 2>&1 | grep '^unresolved import'
node scripts/engine-import-graph.mjs --check 2>&1 | grep -E "KeyValueEntry|: entry|escapeForLanguage|parseSetCookie|soap/charset|mediaTypeOf|ws/transcript"
nice pnpm vitest run --project engine-unit --project engine-integration
```

Expected: `tsc` prints nothing. The first `grep` prints nothing. The second prints exactly one line, which Task 4.8 removes:

```
[core->rest] send-options.ts -> rest/model.ts : KeyValueEntry, RestBody, RestMethod, RestRequestSettings (type-only)
```

Any other line names an importer to switch by the rule of Step 5. The tests pass with the counts they had before the task: no test file changed.

- [ ] **Step 7: Format, check, commit**

```bash
git add -A packages/engine
git diff --cached --name-only --diff-filter=d -z | xargs -0 pnpm exec prettier --write --ignore-unknown
git add -A packages/engine
WIREBENCH_SKIP_PERF=1 nice pnpm check
nice pnpm pack:check
git commit -m "refactor(engine): table rows, body escaping, cookies, charsets and the transcript cap move to http/ (#184)" -m "gRPC, WebSocket and AsyncAPI code took KeyValueEntry, entry and escapeForLanguage from rest/; REST took the charset and media type helpers from soap/ and the transcript cap from ws/; a sequence transfer took parseSetCookie from rest/. Each is protocol-neutral, so it now lives in http/ and the file it came from re-exports it: no public export and no test import changes."
```

---

### Task 4.3: Send credentials, applying them, OAuth2 and webhook signatures move to `http/`

**Files:**
- Create: `packages/engine/src/http/auth/send-auth.ts`
- Move: `rest/auth.ts` → `http/auth/apply-auth.ts`; `rest/oauth2.ts` → `http/auth/oauth2.ts`; `webhooks/signature.ts` → `http/webhook-signature.ts`
- Modify: the root `types.ts`, `send.ts` and `send-options.ts`; `index.ts`; `grpc/send.ts`, `http/auth/apply.ts`, `http/document-fetch.ts`, `rest/send.ts`, `rest/curl.ts`, `secrets/resolve.ts`, `soap/auth.ts`, `ws/call.ts`, `webhooks/model.ts`, `rest/storage.ts` and `project/schema-parts.ts` (the two importers of `webhooks/signature.ts` since slice 3; on `f9c0411b` they were `project/load.ts` and `project/schema.ts`), `project/model.ts` (a comment), `run/oauth2-token.ts`, `server-api/hooks.ts`, and the run code that names `SendAuth` or `resolveAuthChain`: `run/send-helpers.ts` (`SendAuth`), `rest/run.ts` and `grpc/run.ts` (`resolveAuthChain`) since slice 1 (on `f9c0411b` it was `run/run.ts` and `run/effective-auth.ts`)
- Modify (a comment): `apps/desktop/src/renderer/features/rest-editor/rest-actions.ts`
- Test (import paths only, 7 files): `packages/engine/test/integration/auth/ntlm.test.ts`, `integration/http/document-fetch.test.ts`, `integration/rest/auth.test.ts`, `integration/rest/redirects.test.ts`, `integration/rest/send-signing.test.ts`, `unit/rest/auth.test.ts`, `unit/rest/oauth2.test.ts`

**Interfaces:**
- Consumes: `KeyValueEntry` from `http/entries.ts` (Task 4.2).
- Produces:
  - `http/auth/send-auth.ts`: `type SendAuth`, `interface AuthSummary`
  - `http/auth/apply-auth.ts`: everything `rest/auth.ts` exported (`resolveAuthChain`, `applyAuth` and their types), unchanged
  - `http/auth/oauth2.ts`: everything `rest/oauth2.ts` exported, unchanged
  - `http/webhook-signature.ts`: everything `webhooks/signature.ts` exported, unchanged
  - `index.ts` exports the same names as before, from the new files.

The spec's table sends `applyAuth` to `http/auth/apply.ts`. That file exists and holds `sendWithAuth`, the challenge loop of Basic and NTLM; the moved file keeps its own name's meaning as `apply-auth.ts` beside it. No re-export is left in `rest/` or `webhooks/`: these are whole files, and the root `types.ts` stops exporting the two credential types because it becomes `soap/types.ts` in Task 4.8.

- [ ] **Step 1: `http/auth/send-auth.ts`, out of the root `types.ts`**

Create `packages/engine/src/http/auth/send-auth.ts`: the header below, a blank line, then the root `types.ts` lines 106–147 unchanged (the JSDoc and declaration of `SendAuth`, the JSDoc and declaration of `AuthSummary`).

```ts
/**
 * The credentials of one send, and what authentication did with them.
 *
 * In `http/auth/` because every protocol's send takes a {@link SendAuth} and a protocol folder
 * imports core and itself, never another protocol (protocol modules spec §7.2).
 */
```

In the root `types.ts`, delete lines 106–147 and add one import before `import type { HttpExchange, ProxyOptions, TlsOptions } from './http/types.js';` (the file still uses both types, in `SoapSendInput.auth` and `SoapExchange.auth`):

```ts
import type { AuthSummary, SendAuth } from './http/auth/send-auth.js';
```

- [ ] **Step 2: Switch every importer of the two types**

```bash
git grep -lE "^import type \{ (AuthSummary, )?SendAuth \} from '\.\./types\.js';" -- packages/engine/src | xargs perl -pi -e "s{^(import type \{ (?:AuthSummary, )?SendAuth \} from )'\.\./types\.js';}{\$1'../http/auth/send-auth.js';}"
perl -pi -e "s{'\.\./http/auth/send-auth\.js'}{'./auth/send-auth.js'}" packages/engine/src/http/document-fetch.ts
perl -pi -e "s{^(import type \{ AuthSummary, SendAuth \} from )'\.\./\.\./types\.js';}{\$1'./send-auth.js';}" packages/engine/src/http/auth/apply.ts
git grep -lF "import type { SendAuth } from '../../../src/types.js';" -- packages/engine/test | xargs perl -pi -e "s{^import type \{ SendAuth \} from '\.\./\.\./\.\./src/types\.js';}{import type { SendAuth } from '../../../src/http/auth/send-auth.js';}"
```

The first command switches the importers one folder deep whose line is `import type { SendAuth } from '../types.js';` or `import type { AuthSummary, SendAuth } from '../types.js';`: on `f9c0411b`, `grpc/send.ts`, `http/document-fetch.ts`, `rest/auth.ts`, `rest/send.ts`, `secrets/resolve.ts`, `soap/auth.ts`, `ws/call.ts`; and, since slice 1, `run/send-helpers.ts`, whose line is the first of the two. The second and third give the two files inside `http/` their short paths. The fourth switches the four tests that import only `SendAuth` from the root `types.js`.

Three files import the types together with SOAP types, so they are edited by hand. (On `f9c0411b` `run/run.ts` was a fourth, with `import type { SendAuth, SoapExchange } from '../types.js';`. Slice 1 rewrote its imports, and it names neither type any more; `soap/run.ts`, `rest/run.ts` and `grpc/run.ts` do not import `SendAuth` from the root `types.js` either.)

The root `send-options.ts`:

```ts
// before
import type { SendAuth, SoapSendInput } from './types.js';
// after
import type { SendAuth } from './http/auth/send-auth.js';
import type { SoapSendInput } from './types.js';
```

The root `send.ts`:

```ts
// before
import type { AuthSummary, SendAuth, SoapExchange, SoapSendInput } from './types.js';
// after
import type { AuthSummary, SendAuth } from './http/auth/send-auth.js';
import type { SoapExchange, SoapSendInput } from './types.js';
```

`index.ts`: in the `export type { … } from './types.js';` statement remove the two lines `  AuthSummary,` and `  SendAuth,`, and add directly after the statement:

```ts
export type { AuthSummary, SendAuth } from './http/auth/send-auth.js';
```

Run: `nice pnpm exec tsc -b`
Expected: no output. `error TS2459` or `TS2305` naming `SendAuth` or `AuthSummary` points at an importer still reading them from `types.js`: switch it the same way.

- [ ] **Step 3: Move the three files and rewrite their importers**

```bash
git mv packages/engine/src/rest/auth.ts packages/engine/src/http/auth/apply-auth.ts
git mv packages/engine/src/rest/oauth2.ts packages/engine/src/http/auth/oauth2.ts
git mv packages/engine/src/webhooks/signature.ts packages/engine/src/http/webhook-signature.ts
git grep -lE "(rest/auth|rest/oauth2|webhooks/signature)\.js'" -- packages/engine | xargs perl -pi -e "s{rest/auth\.js'}{http/auth/apply-auth.js'}g; s{rest/oauth2\.js'}{http/auth/oauth2.js'}g; s{webhooks/signature\.js'}{http/webhook-signature.js'}g"
perl -pi -e "s{'\./auth\.js'}{'../http/auth/apply-auth.js'}" packages/engine/src/rest/curl.ts packages/engine/src/rest/send.ts packages/engine/src/rest/run.ts
perl -pi -e "s{'\./signature\.js'}{'../http/webhook-signature.js'}" packages/engine/src/webhooks/model.ts
perl -pi -e "s{'\.\./http/auth/apply-auth\.js'}{'./auth/apply-auth.js'}" packages/engine/src/http/document-fetch.ts
perl -pi -e "s{'\.\./project/model\.js'}{'../../project/model.js'}; s{'\.\./http/auth/send-auth\.js'}{'./send-auth.js'}; s{'\./model\.js'}{'../entries.js'}" packages/engine/src/http/auth/apply-auth.ts
perl -pi -e "s{'\.\./errors\.js'}{'../../errors.js'}; s{'\.\./project/model\.js'}{'../../project/model.js'}; s{'\.\./http/types\.js'}{'../types.js'}" packages/engine/src/http/auth/oauth2.ts
```

What the lines do, in order: three moves; every specifier ending in `rest/auth.js'`, `rest/oauth2.js'` or `webhooks/signature.js'` anywhere under `packages/engine` (source and tests) gets the new path; the importers that sat beside the moved files (`rest/curl.ts`, `rest/send.ts`, slice 1's `rest/run.ts`, `webhooks/model.ts`) stop using `./`; `http/document-fetch.ts` gets the short path; the two moved files that changed depth get their own imports fixed, and `apply-auth.ts` takes `KeyValueEntry` from `../entries.js` instead of reaching back into `rest/model.ts`.

Then check nothing still names an old path:

Run: `git grep -nE "(rest/(auth|oauth2)|webhooks/signature)\.js'" -- packages apps scripts; git grep -nE "'\./(auth|oauth2)\.js'" -- packages/engine/src/rest; git grep -n "'\./signature\.js'" -- packages/engine/src/webhooks`
Expected: no output. The second command of the block above reached `grpc/run.ts` (`'../rest/auth.js'`), `project/schema-parts.ts` and `rest/storage.ts` (`'../webhooks/signature.js'`); the third reached `rest/run.ts`.

- [ ] **Step 4: The comments that name the old path**

1. `http/auth/apply-auth.ts`, line 2 of the header: `Working out which credentials a REST request uses, and turning them into what goes on the wire.` becomes `Working out which credentials a request uses, and turning them into what goes on the wire.`
2. `project/model.ts` (the JSDoc of the `inherit` authentication, line 74 on `f9c0411b`): `rest/auth.ts` becomes `http/auth/apply-auth.ts`.
3. `ws/call.ts` (the comment above the Basic branch, line 94 on `f9c0411b`): `rest/auth.ts` becomes `http/auth/apply-auth.ts`.
4. `apps/desktop/src/renderer/features/rest-editor/rest-actions.ts`, line 29: `rest/auth.ts` becomes `http/auth/apply-auth.ts`.

- [ ] **Step 5: Verify**

```bash
nice pnpm exec tsc -b
node scripts/engine-import-graph.mjs --check 2>&1 | grep '^unresolved import'
node scripts/engine-import-graph.mjs --check 2>&1 | grep -E "SendAuth|AuthSummary|rest/auth|rest/oauth2|webhooks/signature"
nice pnpm vitest run --project engine-unit --project engine-integration
```

Expected: no output from `tsc` and from either `grep`; the tests pass.

- [ ] **Step 6: Format, check, commit**

```bash
git add -A packages/engine apps/desktop/src/renderer/features/rest-editor/rest-actions.ts
git diff --cached --name-only --diff-filter=d -z | xargs -0 pnpm exec prettier --write --ignore-unknown
git add -A packages/engine apps/desktop/src/renderer/features/rest-editor/rest-actions.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
nice pnpm pack:check
git commit -m "refactor(engine): send credentials, applying them, OAuth2 and webhook signatures move to http/ (#184)" -m "SendAuth and AuthSummary sat in the SOAP types file and every protocol imported them; applyAuth and resolveAuthChain sat in rest/ and SOAP, gRPC, WebSocket and the definition fetcher imported them; the run code imported rest/oauth2, and the project schema and the server imported webhooks/signature. All four are protocol-neutral and now live in http/. The auth file is apply-auth.ts because http/auth/apply.ts already holds the challenge loop."
```

---

### Task 4.4: The document fetcher, the reference policy and cache file naming leave `wsdl/`

**Files:**
- Create: `packages/engine/src/xml/decode.ts`
- Move: `wsdl/fetch.ts` → `http/fetch-document.ts`; `wsdl/ref-policy.ts` → `http/ref-policy.ts`; `wsdl/cache-naming.ts` → `project/cache-naming.ts`
- Modify: `wsdl/resolver.ts`, `wsdl/cache.ts`, `wsdl/export-definition.ts`, `http/document-fetch.ts`, `asyncapi/parse.ts`, `rest/openapi/cache.ts`, `rest/openapi/import.ts`, `rest/openapi/refs.ts`, the root `import.ts`, `index.ts`
- Modify (a path in prose): `docs/adr/0005-renderer-path-safety.md`, `docs/security.md`
- Test (import paths only, 13 files): `packages/engine/test/unit/soap/form-request.test.ts`, `unit/soap/mime/wsdl-attachments.test.ts`, `unit/soap/request-builder.test.ts`, `unit/wsa/policy-detect.test.ts`, `unit/wsdl/cache-naming.test.ts`, `unit/wsdl/cache.test.ts`, `unit/wsdl/export.test.ts`, `unit/wsdl/fetch.test.ts`, `unit/wsdl/ref-policy.test.ts`, `unit/wsdl/resolver.test.ts`, `unit/xsd/form-model.test.ts`, `unit/xsd/sample-generator.test.ts`, `unit/xsd/schema-set.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `xml/decode.ts`: `decodeXmlBytes(bytes)`
  - `http/fetch-document.ts`: `interface FetchedDocument`, `type FetchDocument`, `createDefaultFetchDocument()`
  - `http/ref-policy.ts`: everything `wsdl/ref-policy.ts` exported, unchanged
  - `project/cache-naming.ts`: everything `wsdl/cache-naming.ts` exported, unchanged
  - `wsdl/resolver.ts` re-exports the types `FetchDocument` and `FetchedDocument`, so SOAP code and the 13 tests that import the type from `wsdl/resolver.js` keep their import.

- [ ] **Step 1: `xml/decode.ts`, and the two types into the fetcher**

Create `packages/engine/src/xml/decode.ts`: the header below, a blank line, then `wsdl/fetch.ts` lines 9–24 unchanged (the JSDoc and body of `decodeXmlBytes`).

```ts
/**
 * Reading the bytes of an XML document as text.
 *
 * In `xml/` because every definition fetcher decodes what it fetched, whatever the protocol, and
 * core imports no protocol folder (protocol modules spec §7.2).
 */
```

In `wsdl/fetch.ts` (it moves in Step 2; edit it where it is):

1. Replace lines 1–4 (its four imports; the file has no header) with the block below, followed by a blank line and `wsdl/resolver.ts` lines 16–25 unchanged (the JSDoc and declaration of `FetchedDocument`, the JSDoc and declaration of `FetchDocument`).

```ts
/**
 * Fetching one document by its location: what a fetcher is, and the default one.
 *
 * In `http/` because the WSDL, OpenAPI and AsyncAPI imports all take a {@link FetchDocument}, and a
 * protocol folder imports core and itself, never another protocol (protocol modules spec §7.2).
 * `wsdl/resolver.ts` re-exports the two types.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../errors.js';
import { decodeXmlBytes } from '../xml/decode.js';
```

2. Delete lines 9–24 (`decodeXmlBytes`, now in `xml/decode.ts`).

In `wsdl/resolver.ts`:

1. Delete lines 16–25 (the two declarations that moved).
2. Add after `import { WsdlParseError } from '../errors.js';`:

```ts
import type { FetchDocument, FetchedDocument } from '../http/fetch-document.js';
```

3. Add directly above `/** Options for {@link resolveDefinition}. */`:

```ts
export type { FetchDocument, FetchedDocument };

```

- [ ] **Step 2: Move the three files and rewrite their importers**

```bash
git mv packages/engine/src/wsdl/fetch.ts packages/engine/src/http/fetch-document.ts
git mv packages/engine/src/wsdl/ref-policy.ts packages/engine/src/http/ref-policy.ts
git mv packages/engine/src/wsdl/cache-naming.ts packages/engine/src/project/cache-naming.ts
git grep -lE "wsdl/(fetch|ref-policy|cache-naming)\.js'" -- packages/engine | xargs perl -pi -e "s{wsdl/fetch\.js'}{http/fetch-document.js'}g; s{wsdl/ref-policy\.js'}{http/ref-policy.js'}g; s{wsdl/cache-naming\.js'}{project/cache-naming.js'}g"
perl -pi -e "s{'\./ref-policy\.js'}{'../http/ref-policy.js'}" packages/engine/src/wsdl/resolver.ts
perl -pi -e "s{'\./cache-naming\.js'}{'../project/cache-naming.js'}" packages/engine/src/wsdl/cache.ts packages/engine/src/wsdl/export-definition.ts
perl -pi -e "s{'\.\./project/paths\.js'}{'./paths.js'}" packages/engine/src/project/cache-naming.ts
```

In order: three moves; every specifier ending in `wsdl/fetch.js'`, `wsdl/ref-policy.js'` or `wsdl/cache-naming.js'` under `packages/engine` gets the new path (the root `import.ts`, `index.ts`, `rest/openapi/cache.ts`, `rest/openapi/refs.ts`, `http/document-fetch.ts` and the 13 tests); the three `wsdl/` files that imported a moved neighbour stop using `./`; `project/cache-naming.ts` imports `./paths.js`.

- [ ] **Step 3: The importers in other groups take the types from the fetcher**

`asyncapi/parse.ts`:

```ts
// before
import type { FetchDocument } from '../wsdl/resolver.js';
// after
import type { FetchDocument } from '../http/fetch-document.js';
```

`rest/openapi/cache.ts`:

```ts
// before
import type { FetchDocument, FetchedDocument } from '../../wsdl/resolver.js';
// after
import type { FetchDocument, FetchedDocument } from '../../http/fetch-document.js';
```

`rest/openapi/import.ts` and `rest/openapi/refs.ts` (the same line in both):

```ts
// before
import type { FetchDocument } from '../../wsdl/resolver.js';
// after
import type { FetchDocument } from '../../http/fetch-document.js';
```

`http/document-fetch.ts`, whose two imports read as below after Step 2:

```ts
// before
import { createDefaultFetchDocument, decodeXmlBytes } from '../http/fetch-document.js';
import type { FetchDocument, FetchedDocument } from '../wsdl/resolver.js';
// after
import { decodeXmlBytes } from '../xml/decode.js';
import { createDefaultFetchDocument } from './fetch-document.js';
import type { FetchDocument, FetchedDocument } from './fetch-document.js';
```

Rule for an importer not listed: a file outside the SOAP group that imports `FetchDocument` or `FetchedDocument` from `wsdl/resolver.js` takes it from `http/fetch-document.js`. Files in `soap/`, `wsdl/`, `xsd/`, `wss/`, `wsa/`, `validate/`, the root SOAP files and the tests are left alone.

- [ ] **Step 4: The prose that names the old path**

```bash
perl -pi -e "s{packages/engine/src/wsdl/ref-policy\.ts}{packages/engine/src/http/ref-policy.ts}" docs/adr/0005-renderer-path-safety.md docs/security.md
perl -pi -e 's{`wsdl/ref-policy\.ts`}{`http/ref-policy.ts`}; s{see `ref-policy\.ts`}{see `http/ref-policy.ts`}' packages/engine/src/wsdl/resolver.ts packages/engine/src/rest/openapi/refs.ts packages/engine/test/unit/wsdl/ref-policy.test.ts
```

The first line changes one path in each of the two documents (ADR-0005 line 44, `docs/security.md` line 240). The second changes five comments: three in `wsdl/resolver.ts` (lines 58, 271 and 313 on `f9c0411b`), one in the header of `rest/openapi/refs.ts`, one in the header of the test.

- [ ] **Step 5: Verify**

```bash
nice pnpm exec tsc -b
node scripts/engine-import-graph.mjs --check 2>&1 | grep '^unresolved import'
node scripts/engine-import-graph.mjs --check 2>&1 | grep -E "FetchDocument|FetchedDocument|wsdl/fetch|ref-policy|cache-naming|decodeXmlBytes"
git grep -nE "wsdl/(fetch|ref-policy|cache-naming)" -- packages apps scripts docs/adr docs/security.md docs/success-criteria.md docs-site
nice pnpm vitest run --project engine-unit --project engine-integration
```

Expected: no output from `tsc` and from the three `grep`s; the tests pass.

- [ ] **Step 6: Format, check, commit**

```bash
git add -A packages/engine docs/adr/0005-renderer-path-safety.md docs/security.md
git diff --cached --name-only --diff-filter=d -z | xargs -0 pnpm exec prettier --write --ignore-unknown
git add -A packages/engine docs/adr/0005-renderer-path-safety.md docs/security.md
WIREBENCH_SKIP_PERF=1 nice pnpm check
nice pnpm pack:check
git commit -m "refactor(engine): the document fetcher, the reference policy and cache file naming leave wsdl/ (#184)" -m "The OpenAPI and AsyncAPI imports took FetchDocument, the reference policy and the cache file naming from wsdl/, and the authenticated fetcher in http/ took the default fetcher and the XML decoder from it. The fetcher and the policy are http/'s, the file naming is the project's, the decoder is xml/'s. wsdl/resolver.ts re-exports the two fetcher types."
```

---

### Task 4.5: The JSON Schema model, reading a description's text, `$ref` resolution and sampling move to `json/schema/`

**Files:**
- Create: `packages/engine/src/json/schema/model.ts`, `json/schema/parse-text.ts`, `json/schema/source.ts`
- Move: `rest/openapi/refs.ts` → `json/schema/refs.ts`; `rest/openapi/sample.ts` → `json/schema/sample.ts`
- Modify: `rest/openapi/model.ts`, `rest/openapi/parse.ts`, `rest/openapi/import.ts`, `rest/openapi/cache.ts`, `rest/openapi/map.ts`, `rest/json-form.ts`, `asyncapi/parse.ts`, `asyncapi/import.ts`, `asyncapi/map.ts`, `script/types/json-schema.ts`, `index.ts`
- Test (import paths only, 6 files): `packages/engine/test/bench/scenarios.ts`, `unit/rest/json-form.test.ts`, `unit/rest/openapi/cache.test.ts`, `unit/rest/openapi/graph.test.ts`, `unit/rest/openapi/refs.test.ts`, `unit/rest/openapi/sample.test.ts`

**Interfaces:**
- Consumes: `FetchDocument` from `http/fetch-document.ts` and the policy from `http/ref-policy.ts` (Task 4.4), which `refs.ts` already imports by then.
- Produces:
  - `json/schema/model.ts`: `type JsonValue`, `interface JsonSchema`, `interface OpenApiDiscriminator`, `interface OpenApiXml`
  - `json/schema/parse-text.ts`: `parseDocumentText(text, where?)`
  - `json/schema/source.ts`: `type OpenApiSource`
  - `json/schema/refs.ts`, `json/schema/sample.ts`: everything the two `rest/openapi/` files exported, unchanged
  - Re-exports: `rest/openapi/model.ts` (the four types), `rest/openapi/parse.ts` (`parseDocumentText`), `rest/openapi/import.ts` (`OpenApiSource`). The OpenAPI-only part (`parseOpenApiDocument`, the mapping, the cache, the update plan) stays in `rest/openapi/`.

`sample.ts` moves whole, `sampleXml` included: its JSON and XML generators share private helpers, and both read nothing but a `JsonSchema`. The names `OpenApiDiscriminator`, `OpenApiXml`, `OpenApiSource` and the error `OpenApiError` that `parseDocumentText` throws keep their names: they are public, and renames are slice 5's.

- [ ] **Step 1: `json/schema/model.ts`, out of `rest/openapi/model.ts`**

Create `packages/engine/src/json/schema/model.ts`: the header below, a blank line, `rest/openapi/model.ts` lines 15–16 (the JSDoc and declaration of `JsonValue`), a blank line, then lines 93–142 (`JsonSchema`, `OpenApiDiscriminator`, `OpenApiXml`, each with its JSDoc), all unchanged.

```ts
/**
 * A JSON value and the JSON Schema subset the engine reads.
 *
 * In `json/schema/` because an OpenAPI description, an AsyncAPI description and a script's generated
 * types all read the same schemas, and no protocol folder imports another (protocol modules spec
 * §7.2). `rest/openapi/model.ts` re-exports the four names.
 */
```

In `rest/openapi/model.ts`, delete lines 93–142, and replace lines 15–16 with:

```ts
import type { JsonSchema, JsonValue, OpenApiDiscriminator, OpenApiXml } from '../../json/schema/model.js';

export type { JsonSchema, JsonValue, OpenApiDiscriminator, OpenApiXml };
```

- [ ] **Step 2: `json/schema/parse-text.ts`, out of `rest/openapi/parse.ts`**

Create `packages/engine/src/json/schema/parse-text.ts`: the header and imports below, a blank line, then `rest/openapi/parse.ts` lines 74–100 unchanged (the JSDoc and body of `parseDocumentText`, and the private `messageOf` it alone uses).

```ts
/**
 * Reading the text of a description, JSON or YAML, into a value.
 *
 * In `json/schema/` because the OpenAPI and the AsyncAPI imports both start here, and no protocol
 * folder imports another (protocol modules spec §7.2). `rest/openapi/parse.ts` re-exports
 * {@link parseDocumentText}.
 */

import { parse as parseYamlDocument } from 'yaml';
import { OpenApiError } from '../../errors.js';
```

In `rest/openapi/parse.ts`:

1. Delete line 15, `import { parse as parseYamlDocument } from 'yaml';` (nothing else in the file parses YAML).
2. Replace lines 74–100 with:

```ts
export { parseDocumentText } from '../../json/schema/parse-text.js';
```

- [ ] **Step 3: `json/schema/source.ts`, out of `rest/openapi/import.ts`**

Create `packages/engine/src/json/schema/source.ts`: the header below, a blank line, then `rest/openapi/import.ts` lines 20–25 unchanged (the JSDoc and declaration of `OpenApiSource`).

```ts
/**
 * Where a description comes from.
 *
 * In `json/schema/` because the OpenAPI and the AsyncAPI imports take the same three sources, and no
 * protocol folder imports another (protocol modules spec §7.2). `rest/openapi/import.ts` re-exports
 * the type under the name it has always had.
 */
```

In `rest/openapi/import.ts`:

1. Delete lines 20–25.
2. Add after `import type { FetchDocument } from '../../http/fetch-document.js';`:

```ts
import type { OpenApiSource } from '../../json/schema/source.js';
```

3. Add directly above `export interface ParseOpenApiOptions {`:

```ts
export type { OpenApiSource };

```

- [ ] **Step 4: Move the two files and rewrite their importers**

```bash
git mv packages/engine/src/rest/openapi/refs.ts packages/engine/src/json/schema/refs.ts
git mv packages/engine/src/rest/openapi/sample.ts packages/engine/src/json/schema/sample.ts
git grep -lE "rest/openapi/(refs|sample)\.js'" -- packages/engine | xargs perl -pi -e "s{rest/openapi/(refs|sample)\.js'}{json/schema/\$1.js'}g"
perl -pi -e "s{'\./refs\.js'}{'../../json/schema/refs.js'}" packages/engine/src/rest/openapi/cache.ts packages/engine/src/rest/openapi/import.ts
perl -pi -e "s{'\./sample\.js'}{'../../json/schema/sample.js'}" packages/engine/src/rest/openapi/map.ts
perl -pi -e "s{'\./openapi/sample\.js'}{'../json/schema/sample.js'}" packages/engine/src/rest/json-form.ts
perl -pi -e "s{'\./parse\.js'}{'./parse-text.js'}" packages/engine/src/json/schema/refs.ts
```

In order: two moves; every specifier ending in `rest/openapi/refs.js'` or `rest/openapi/sample.js'` under `packages/engine` gets the new path (`asyncapi/import.ts`, `asyncapi/map.ts`, `asyncapi/parse.ts`, `index.ts` and the six test files); the four REST files that imported a moved neighbour stop using `./`; `json/schema/refs.ts` takes `parseDocumentText` from `./parse-text.js`. `json/schema/sample.ts` needs no edit: its one import is `./model.js`, which now resolves to `json/schema/model.ts` and exports the three names it takes.

- [ ] **Step 5: The importers in other groups**

`asyncapi/parse.ts`:

```ts
// before
import type { OpenApiSource } from '../rest/openapi/import.js';
import { parseDocumentText } from '../rest/openapi/parse.js';
// after
import type { OpenApiSource } from '../json/schema/source.js';
import { parseDocumentText } from '../json/schema/parse-text.js';
```

`asyncapi/import.ts`:

```ts
// before
import type { OpenApiSource } from '../rest/openapi/import.js';
// after
import type { OpenApiSource } from '../json/schema/source.js';
```

`script/types/json-schema.ts`:

```ts
// before
import type { JsonSchema } from '../../rest/openapi/model.js';
// after
import type { JsonSchema } from '../../json/schema/model.js';
```

Three comments in `rest/openapi/parse.ts` name the resolver by its old neighbour's name (lines 11, 192 and 601 on `f9c0411b`):

```bash
perl -pi -e 's{`refs\.ts`}{`json/schema/refs.ts`}' packages/engine/src/rest/openapi/parse.ts
```

Rule for an importer not listed: outside `rest/` and `webhooks/`, the four schema types come from `json/schema/model.js`, `parseDocumentText` from `json/schema/parse-text.js`, `OpenApiSource` from `json/schema/source.js`. A REST file keeps importing them from `rest/openapi/`.

- [ ] **Step 6: Verify**

```bash
nice pnpm exec tsc -b
node scripts/engine-import-graph.mjs --check 2>&1 | grep '^unresolved import'
node scripts/engine-import-graph.mjs --check 2>&1 | grep -E "rest/openapi/(refs|sample|parse|import)\.ts|JsonSchema"
nice pnpm vitest run --project engine-unit --project engine-integration
```

Expected: no output from `tsc` and from either `grep`; the tests pass. (Slice 2 left no core file importing `parseOpenApi` from `rest/openapi/import.ts`: `loadOpenApiDocument`, its one caller in `script/`, went to `rest/script-types.ts` in Task 2.2a.)

- [ ] **Step 7: Format, check, commit**

```bash
git add -A packages/engine
git diff --cached --name-only --diff-filter=d -z | xargs -0 pnpm exec prettier --write --ignore-unknown
git add -A packages/engine
WIREBENCH_SKIP_PERF=1 nice pnpm check
nice pnpm pack:check
git commit -m "refactor(engine): the JSON Schema model, \$ref resolution and sampling move to json/schema/ (#184)" -m "The AsyncAPI import resolved references, parsed text and generated samples with REST's OpenAPI code, and a script's generated types read its JsonSchema. That part is about JSON Schema, not OpenAPI, so it moves to json/schema/; what reads an OpenAPI document stays in rest/openapi/, which re-exports the types, parseDocumentText and OpenApiSource."
```

---

### Task 4.6: Core stops importing XML helpers, status names and attachment types from protocol folders

**Files:**
- Create: `packages/engine/src/xml/qname.ts`, `xml/locate.ts`, `xml/entitize.ts`, `assert/status-names.ts`
- Move: `soap/prefixes.ts` → `xml/prefixes.ts`
- Modify: `wsdl/qname.ts`, `xsd/locate.ts`, `xml/index.ts`, `xpath/evaluate.ts`, `xpath/namespaces.ts`, `grpc/status.ts`, `assert/schema.ts`, `soap/mime/types.ts`, `project/attachments-cache.ts`, `project/environments.ts`, `workspace/environments.ts`, `soap/transforms.ts`, `project/properties.ts`, `soap/namespace-scope.ts`, `index.ts`
- Test (import path only, 1 file): `packages/engine/test/unit/soap/prefixes.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `xml/qname.ts`: `interface QName`
  - `xml/locate.ts`: `interface TextRange`, `interface CompletionContext`, `elementPathAt(text, offset)`, `completionContextAt(text, offset)`
  - `xml/entitize.ts`: `entitizeValue(value)`
  - `xml/prefixes.ts`: everything `soap/prefixes.ts` exported, unchanged
  - `assert/status-names.ts`: `GRPC_STATUS_NAMES`
  - `project/attachments-cache.ts` also exports `type AttachmentResolver`
  - Re-exports: `wsdl/qname.ts` (`QName`), `xsd/locate.ts` (the four names), `soap/transforms.ts` (`entitizeValue`), `grpc/status.ts` (`GRPC_STATUS_NAMES`), `soap/mime/types.ts` (`AttachmentResolver`)

`xml/index.ts` is the browser subpath `@wirebench/engine/xml`. After this task it takes the two cursor functions from `xml/locate.ts`, which imports one type and nothing else, where it used to reach through `xsd/locate.ts`.

- [ ] **Step 1: `xml/qname.ts`, out of `wsdl/qname.ts`**

Create `packages/engine/src/xml/qname.ts`: the header below, a blank line, then `wsdl/qname.ts` lines 3–7 unchanged (the JSDoc and declaration of `QName`).

```ts
/**
 * A namespace-qualified name.
 *
 * In `xml/` because the text helpers beside it (`locate.ts`) speak of element names without
 * knowing WSDL or XSD, and core imports no protocol folder (protocol modules spec §7.2).
 * `wsdl/qname.ts` re-exports the type and keeps everything that resolves or compares one.
 */
```

In `wsdl/qname.ts`, delete lines 3–7 and replace line 1, `import type { Element } from '@xmldom/xmldom';`, with:

```ts
import type { Element } from '@xmldom/xmldom';
import type { QName } from '../xml/qname.js';

export type { QName };
```

- [ ] **Step 2: `xml/locate.ts`, out of `xsd/locate.ts`**

Create `packages/engine/src/xml/locate.ts`: the header and import below, a blank line, then `xsd/locate.ts` lines 6–141 unchanged. That range is everything from the JSDoc of `TextRange` through the closing brace of `completionContextAt`: the two interfaces, the two regular expressions, `XML_PREFIX`, `XML_NS`, `Scope`, `xmlnsDeclarations`, `resolvePrefixed`, `scopeStackAt`, `elementPathAt`, `completionContextAt`. None of it reads a schema; the schema half starts at `resolveDeclType` on line 143.

```ts
/**
 * Where a cursor is in an XML text: the element path at an offset, and what a completion would
 * replace. Pure text, no DOM and no schema, so it is safe in the browser subpath (`xml/index.ts`).
 *
 * In `xml/` because core's XML and XPath helpers use it and core imports no protocol folder
 * (protocol modules spec §7.2). `xsd/locate.ts` keeps the half that reads a schema set, and
 * re-exports these names.
 */

import type { QName } from './qname.js';
```

In `xsd/locate.ts`, keep the four imports (lines 1–4: the schema half still uses `QName` and `qnameEquals`) and replace lines 6–141 with:

```ts
export { completionContextAt, elementPathAt } from '../xml/locate.js';
export type { CompletionContext, TextRange } from '../xml/locate.js';
```

`xml/index.ts`:

```ts
// before
export { elementPathAt, completionContextAt, type CompletionContext, type TextRange } from '../xsd/locate.js';
// after
export { elementPathAt, completionContextAt, type CompletionContext, type TextRange } from './locate.js';
```

`xpath/evaluate.ts`:

```ts
// before
import type { TextRange } from '../xsd/locate.js';
// after
import type { TextRange } from '../xml/locate.js';
```

- [ ] **Step 3: `assert/status-names.ts`, out of `grpc/status.ts`**

Task 2.3 stopped `assert/status.ts` importing gRPC's names to evaluate a status: the subject carries them as `statusNames`, which `grpc/status.ts` builds as `grpcStatusNames`. `assert/schema.ts` still imports the table, for the request file's schema, which a subject cannot supply (spec R12).

Create `packages/engine/src/assert/status-names.ts`: the header below, a blank line, then the JSDoc and declaration of `GRPC_STATUS_NAMES` from `grpc/status.ts`, unchanged (lines 6–25 on `f9c0411b`; two lines lower since Task 2.3 put an import above them).

```ts
/**
 * The status names a request file's `status` assertion may be written with.
 *
 * In `assert/` because the assertion file schema (`schema.ts`) lists them, and core imports no
 * protocol folder (protocol modules spec §7.2). They are gRPC's; `grpc/status.ts` re-exports the
 * table and keeps everything else about a status.
 */
```

In `grpc/status.ts`, delete that JSDoc and declaration, and make the top of the file, below its header comment, read (the first import is Task 2.3's):

```ts
import type { StatusNames } from '../assert/model.js';
import { GRPC_STATUS_NAMES } from '../assert/status-names.js';

export { GRPC_STATUS_NAMES };
```

`grpcStatusName` and `grpcStatusNames` (Task 2.3) are not edited: both are built from `GRPC_STATUS_NAMES`, which is now the imported table. So the file schema in `assert/schema.ts` and the names a gRPC subject carries come from the one table in `assert/status-names.ts`, and `assert/` imports no protocol folder.

`assert/schema.ts`:

```ts
// before
import { GRPC_STATUS_NAMES } from '../grpc/status.js';
// after
import { GRPC_STATUS_NAMES } from './status-names.js';
```

- [ ] **Step 4: `AttachmentResolver` is declared where core uses it**

In `soap/mime/types.ts`, replace lines 11–14 (the import of `Attachment`, which only that declaration used, and the JSDoc and declaration of `AttachmentResolver`) with:

```ts
export type { AttachmentResolver } from '../../project/attachments-cache.js';
```

In `project/attachments-cache.ts`, delete the import `import type { AttachmentResolver } from '../soap/mime/types.js';` and add, after the last import (`import { parseYaml, stringifyYaml } from './yaml.js';`) and a blank line, the two lines that came out of `soap/mime/types.ts`, unchanged:

```ts
/** Resolves one attachment's bytes. Rejects when the attachment cannot be read. */
export type AttachmentResolver = (attachment: Attachment) => Promise<Uint8Array>;
```

(`Attachment` is already imported there, from `./model.js`.)

- [ ] **Step 5: Two `Pick`s of `RestApi` are written out**

`project/environments.ts`: delete `import type { RestApi } from '../rest/model.js';` and change the parameter (line 93 on `f9c0411b`):

```ts
// before
  api: Pick<RestApi, 'slug' | 'baseUrl'>,
// after
  api: { readonly slug: string; readonly baseUrl: string },
```

`workspace/environments.ts`: delete `import type { RestApi } from '../rest/model.js';` and change the field (line 153 on `f9c0411b`):

```ts
// before
  readonly api: Pick<RestApi, 'slug' | 'baseUrl'>;
// after
  readonly api: { readonly slug: string; readonly baseUrl: string };
```

Both fields are `readonly string` on `RestApi`, so every caller that passes an API still type-checks.

- [ ] **Step 6: `xml/entitize.ts`, out of `soap/transforms.ts`**

Create `packages/engine/src/xml/entitize.ts`: the header below, a blank line, then `soap/transforms.ts` lines 164–175 unchanged (the JSDoc and body of `entitizeValue`, the last declaration of the file).

```ts
/**
 * Escaping a value that lands inside XML text.
 *
 * In `xml/` because property expansion (`project/properties.ts`) applies it for every protocol,
 * and core imports no protocol folder (protocol modules spec §7.2). `soap/transforms.ts` re-exports
 * it beside the envelope transforms it has always sat with.
 */
```

In `soap/transforms.ts`:

1. Replace lines 164–175 with:

```ts
export { entitizeValue } from '../xml/entitize.js';
```

2. The last sentence of the header comment changes, because the function no longer lives here:

```ts
// before
 * is applied *during* expansion instead (see `project/properties.ts`'s `entitize` option), and
 * lives here alongside its siblings.
// after
 * is applied *during* expansion instead (see `project/properties.ts`'s `entitize` option). It
 * lives in `xml/entitize.ts`, which core can import, and is re-exported here beside its siblings.
```

`project/properties.ts`:

```ts
// before
import { entitizeValue } from '../soap/transforms.js';
// after
import { entitizeValue } from '../xml/entitize.js';
```

- [ ] **Step 7: Move `soap/prefixes.ts`**

```bash
git mv packages/engine/src/soap/prefixes.ts packages/engine/src/xml/prefixes.ts
git grep -l "soap/prefixes\.js'" -- packages/engine | xargs perl -pi -e "s{soap/prefixes\.js'}{xml/prefixes.js'}g"
perl -pi -e "s{'\./prefixes\.js'}{'../xml/prefixes.js'}" packages/engine/src/soap/namespace-scope.ts
```

The second line rewrites `index.ts`, `xpath/namespaces.ts` and the test; the third the one SOAP file that sat beside it.

- [ ] **Step 8: Verify**

```bash
nice pnpm exec tsc -b
node scripts/engine-import-graph.mjs --check 2>&1 | grep '^unresolved import'
node scripts/engine-import-graph.mjs --check 2>&1 | grep -E "QName|xsd/locate|soap/prefixes|entitizeValue|GRPC_STATUS_NAMES|AttachmentResolver|environments\.ts"
nice pnpm vitest run --project engine-unit --project engine-integration
```

Expected: no output from `tsc` and from the first `grep`. The second `grep` prints exactly one line, which Task 4.8 removes:

```
[core->soap] send-options.ts -> soap/mime/types.ts : AttachmentResolver (type-only)
```

A core file that still imports the type `QName` from `wsdl/qname.js` takes it from `xml/qname.js`. The tests pass.

- [ ] **Step 9: Format, check, commit**

```bash
git add -A packages/engine
git diff --cached --name-only --diff-filter=d -z | xargs -0 pnpm exec prettier --write --ignore-unknown
git add -A packages/engine
WIREBENCH_SKIP_PERF=1 nice pnpm check
nice pnpm pack:check
git commit -m "refactor(engine): core stops importing XML helpers, status names and attachment types from protocol folders (#184)" -m "xml/ and xpath/ took the cursor helpers from xsd/ and the prefix mnemonics from soap/; property expansion took entitizeValue from soap/; the assertion file schema took gRPC's status names from grpc/; the attachment cache took its resolver type from soap/mime/; two environment helpers named RestApi for two of its fields. Each now lives in core, and the protocol file it came from re-exports it."
```

---

### Task 4.7: Keystores become core, and the WS-Security configuration helpers join `wss/`

**Files:**
- Move: the folder `packages/engine/src/wss/keystore/` → `packages/engine/src/keystore/` (`certificate.ts`, `index.ts`, `model.ts`, `pem.ts`, `pkcs12.ts`); `project/wss-configs.ts` → `wss/configs.ts`
- Modify (specifiers only): `wss/apply.ts`, `wss/model.ts`, `wss/key-identifiers.ts`, `wss/incoming/decrypt.ts`, `wss/incoming/index.ts`, `wss/incoming/verify.ts`, `wss/outgoing/encryption.ts`, `wss/outgoing/signature.ts`, `project/keystores.ts`, `index.ts`, and the run code that loads a keystore or reads a WS-Security configuration: `run/send-helpers.ts` (the keystore) and `soap/run.ts` (the configuration) since slice 1 (on `f9c0411b`: `run/prepare.ts`, `run/secret-needs.ts`)
- Test (import paths only, 11 files): `packages/engine/test/helpers/wss-responses.ts`, `integration/wss/incoming-send.test.ts`, `integration/wss/inline-files-signature.test.ts`, `integration/wss/keystore-tls.test.ts`, `unit/project/wss-configs.test.ts`, `unit/wss/incoming/process.test.ts`, `unit/wss/incoming/verify.test.ts`, `unit/wss/keystore/certificate.test.ts`, `unit/wss/keystore/keystore.test.ts`, `unit/wss/outgoing/encryption.test.ts`, `unit/wss/outgoing/signature.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `keystore/index.ts`, `keystore/model.ts`, `keystore/certificate.ts`, `keystore/pem.ts`, `keystore/pkcs12.ts` and `wss/configs.ts`, each exporting what it exported under its old path. `index.ts` exports the same names.

Why these two. A keystore holds the client identity of a TLS handshake for every protocol (`sslKeystoreRef` is a setting of REST, gRPC and SOAP requests alike), so `project/keystores.ts` and the run code import it from core's side; nothing in the five files imports `wss/`. `project/wss-configs.ts` turns a stored reference into a `WssOutgoingConfig` or `WssIncomingConfig`: it is SOAP's, and it is the one file of `project/` that imported `wss/model.ts` for anything but a file schema.

What stays: the WS-Security file schemas in `project/schema.ts`, with their import of the two default part lists from `wss/model.ts`. Core loads and saves `wss/*.yaml` until phase 3 (spec §7.2), and `CORE_EXCEPTIONS` lists that one import. The test files keep their paths (`unit/wss/keystore/…`, `unit/project/wss-configs.test.ts`): `docs/success-criteria.md` cites test paths.

- [ ] **Step 1: Move the folder and the file, and rewrite the importers**

```bash
git mv packages/engine/src/wss/keystore packages/engine/src/keystore
git mv packages/engine/src/project/wss-configs.ts packages/engine/src/wss/configs.ts
git grep -lE "(wss/keystore/|project/wss-configs\.js')" -- packages/engine | xargs perl -pi -e "s{wss/keystore/}{keystore/}g; s{project/wss-configs\.js'}{wss/configs.js'}g"
perl -pi -e "s{'\./keystore/}{'../keystore/}" packages/engine/src/wss/apply.ts packages/engine/src/wss/model.ts packages/engine/src/wss/key-identifiers.ts
perl -pi -e "s{'\.\./keystore/}{'../../keystore/}" packages/engine/src/wss/incoming/decrypt.ts packages/engine/src/wss/incoming/index.ts packages/engine/src/wss/incoming/verify.ts packages/engine/src/wss/outgoing/encryption.ts packages/engine/src/wss/outgoing/signature.ts
perl -pi -e "s{'\.\./\.\./errors\.js'}{'../errors.js'}" packages/engine/src/keystore/index.ts packages/engine/src/keystore/pem.ts packages/engine/src/keystore/pkcs12.ts
perl -pi -e "s{'\./schema\.js'}{'../project/schema.js'}; s{'\./model\.js'}{'../project/model.js'}; s{'\.\./wss/model\.js'}{'./model.js'}" packages/engine/src/wss/configs.ts
```

In order: the two moves; every specifier containing `wss/keystore/` or ending in `project/wss-configs.js'` under `packages/engine` gets the new path (`index.ts`, `project/keystores.ts`, the run code, the eleven test files); the three files directly in `wss/` and the five in `wss/incoming/` and `wss/outgoing/` go one level further up for the keystore; the three keystore files that import `errors.js` go one level less; `wss/configs.ts` swaps its three specifiers (`./schema.js` and `./model.js` were `project/`'s, `../wss/model.js` is now its neighbour; the order of the three substitutions in the command matters and is right as written).

The pattern `wss/keystore/` has a trailing slash on purpose: the many comments that name the file `wss/keystores.yaml` do not match it.

- [ ] **Step 2: Verify**

```bash
nice pnpm exec tsc -b
node scripts/engine-import-graph.mjs --check 2>&1 | grep '^unresolved import'
node scripts/engine-import-graph.mjs --check 2>&1 | grep -E "keystore|wss-configs|wss/configs"
git grep -nE "wss/keystore/|wss-configs\.js" -- packages apps scripts
nice pnpm vitest run --project engine-unit --project engine-integration
```

Expected: no output from `tsc` and from the three `grep`s; the tests pass.

If the first `grep` prints a file in `project/` that imported `./wss-configs.js`, its specifier becomes `'../wss/configs.js'`. If the second prints a core file importing `wss/configs.ts`, that file is doing SOAP's work in core: on `f9c0411b` those were `run/prepare.ts` and `run/secret-needs.ts`, whose WS-Security code slice 1 moved into `soap/run.ts` (Tasks 1.4 and 1.7). After slice 1 no core file imports it: `soap/run.ts` is its one importer outside `wss/`, the third command of Step 1 rewrote that import to `'../wss/configs.js'`, and the same command rewrote the keystore import of `run/send-helpers.ts` to `'../keystore/index.js'`. A core file printed here is one this plan did not expect: stop and report it.

- [ ] **Step 3: Format, check, commit**

```bash
git add -A packages/engine
git diff --cached --name-only --diff-filter=d -z | xargs -0 pnpm exec prettier --write --ignore-unknown
git add -A packages/engine
WIREBENCH_SKIP_PERF=1 nice pnpm check
nice pnpm pack:check
git commit -m "refactor(engine): keystores become core, and the WS-Security configuration helpers join wss/ (#184)" -m "A keystore is the TLS client identity of every protocol, and the project's keystore registry and the run code imported it from inside wss/. It moves to keystore/. project/wss-configs.ts builds SOAP's WS-Security configurations and moves to wss/configs.ts. The WS-Security file schemas stay in project/schema.ts until core stops loading those files."
```

---

### Task 4.8: The SOAP root files move under `soap/`, and `send-options.ts` splits by protocol

**Files:**
- Move: the root `import.ts`, `send.ts`, `generate.ts`, `operations.ts`, `types.ts` → `soap/import.ts`, `soap/send.ts`, `soap/generate.ts`, `soap/operations.ts`, `soap/types.ts`; the root `send-options.ts` → `soap/send-input.ts` (it keeps its SOAP third)
- Create: `packages/engine/src/rest/send-input.ts`, `grpc/send-input.ts`, `project/inherit.ts`, `soap/curl.ts`, `soap/expand.ts`
- Modify: `http/curl.ts`, `project/properties.ts`, `project/preferences.ts` (a comment), `rest/expand.ts` (a comment), `soap/legacy-project/map.ts`, `soap/mime/send-pipeline.ts`, `validate/wsi/run-message.ts`, `validate/wsi/types.ts`, `wsdl/docs-generator.ts`, `wsdl/update-definition.ts`, `index.ts`, `scripts/engine-import-graph.mjs`, and the importers of the root files that slices 1 to 3 created (`soap/run.ts`, `soap/scripting.ts`, `protocols.ts`, `rest/run.ts`, `grpc/run.ts`; on `f9c0411b` they are `run/prepare.ts`, `run/run.ts`, `script/send.ts`)
- Test (import paths only, 31 files): `packages/engine/test/bench/scenarios.ts`; `integration/auth/basic.test.ts`, `integration/auth/ntlm.test.ts`, `integration/auth/token.test.ts`, `integration/end-to-end.test.ts`, `integration/mime.test.ts`, `integration/run/run.test.ts`, `integration/send-compression.test.ts`, `integration/send-encoding.test.ts`, `integration/wsa-send.test.ts`, `integration/wsi-message.test.ts`, `integration/wss/incoming-send.test.ts`, `integration/wss/inline-files-signature.test.ts`, `integration/wss/outgoing-send.test.ts`; `interop/public-services.test.ts`; `unit/grpc/expand-command.test.ts`, `unit/http/curl.test.ts`, `unit/import.test.ts`, `unit/project/properties.test.ts`, `unit/project/sequence-guards.test.ts`, `unit/send-options.test.ts`, `unit/soap/legacy-project/map.test.ts`, `unit/validate/schema-validator.test.ts`, `unit/validate/validate-message.test.ts`, `unit/validate/wsi/message.test.ts`, `unit/validate/wsi/wsdl.test.ts`, `unit/wsdl/cache.test.ts`, `unit/wsdl/docs.test.ts`, `unit/wsdl/export.test.ts`, `unit/wsdl/mime-parts.test.ts`, `unit/wsdl/update.test.ts`. No test file is renamed: `docs/success-criteria.md` cites `unit/import.test.ts` and `unit/send-options.test.ts` by path.

**Interfaces:**
- Consumes: `SendAuth` (`http/auth/send-auth.ts`, Task 4.3), `Cookie` (`http/cookies.ts`) and `KeyValueEntry` (`http/entries.ts`, Task 4.2).
- Produces:
  - `soap/import.ts`, `soap/send.ts`, `soap/generate.ts`, `soap/operations.ts`, `soap/types.ts`: what the root files exported, unchanged
  - `soap/send-input.ts`: `SendRequestInput`, `AttachmentResolvers`, `ToSendInputArgs`, `toSendInput(args)`
  - `rest/send-input.ts`: `RestSendRequestInput`, `ToRestSendInputArgs`, `toRestSendInput(args)`
  - `grpc/send-input.ts`: `GrpcSendRequestInput`, `ToGrpcSendInputArgs`, `toGrpcSendInput(args)`
  - `project/inherit.ts`: `inherited<T>(...values)`
  - `soap/curl.ts`: `soapToCurl(input, options?)`, `interface FromCurlResult`, `fromCurl(text)`; `http/curl.ts` keeps `toCurl`, `quoteForShell` and the `Curl…` types and no longer imports SOAP
  - `soap/expand.ts`: `expandSendInput(input, scopes, options?)`; `project/properties.ts` no longer imports SOAP
  - `index.ts` exports every name it exported before. Slice 5 renames some of them.

Spec §7.3 says `http/` stops importing `soapActionHeaders` because "the SOAP send passes its headers in". The import is `soapToCurl`'s, not the send's, and `fromCurl` beside it returns a `Partial<SoapSendInput>`; both are SOAP's view of `curl`, as `rest/curl.ts` is REST's. They move, and no signature changes.

- [ ] **Step 1: Move the six files and rewrite their importers**

```bash
for f in import send generate operations types; do git mv packages/engine/src/$f.ts packages/engine/src/soap/$f.ts; done
git mv packages/engine/src/send-options.ts packages/engine/src/soap/send-input.ts
perl -pi -e "s{'\./(errors\.js|grpc/|http/|project/|rest/|wsa/|wsdl/|wss/|xml/|xsd/)}{'../\$1}; s{'\./soap/}{'./}" packages/engine/src/soap/import.ts packages/engine/src/soap/send.ts packages/engine/src/soap/generate.ts packages/engine/src/soap/operations.ts packages/engine/src/soap/types.ts packages/engine/src/soap/send-input.ts
git grep -lE "src/(import|send|generate|operations|types|send-options)\.js'" -- packages/engine/test | xargs perl -pi -e "s{src/(import|send|generate|operations|types)\.js'}{src/soap/\$1.js'}g; s{src/send-options\.js'}{src/soap/send-input.js'}g"
perl -pi -e "s{'\./(import|send|generate|operations|types)\.js'}{'./soap/\$1.js'}; s{'\./send-options\.js'}{'./soap/send-input.js'}" packages/engine/src/index.ts
perl -pi -e "s{'\.\./\.\./types\.js'}{'../types.js'}" packages/engine/src/soap/legacy-project/map.ts packages/engine/src/soap/mime/send-pipeline.ts
perl -pi -e "s{'\.\./\.\./types\.js'}{'../../soap/types.js'}" packages/engine/src/validate/wsi/run-message.ts packages/engine/src/validate/wsi/types.ts
perl -pi -e "s{'\.\./(types|generate)\.js'}{'../soap/\$1.js'}" packages/engine/src/wsdl/docs-generator.ts packages/engine/src/wsdl/update-definition.ts
```

In order: the six moves; inside the six moved files a specifier that started `./soap/` loses that segment and one that started at another folder or at `errors.js` gains `../` (the moved files import each other as `./types.js`, which stays right); every test specifier ending in `src/import.js'`, `src/send.js'`, `src/generate.js'`, `src/operations.js'`, `src/types.js'` or `src/send-options.js'` gets `soap/` (52 specifiers in 31 files, one of them the dynamic `import('../../../src/import.js')` in `unit/validate/schema-validator.test.ts`); `index.ts`; the two SOAP files two folders deep; the two `validate/wsi/` files; the two `wsdl/` files.

Then the importers slices 1 to 3 added. Five files of theirs import a root file that is now in `soap/`:

| Importer | Specifier before | After |
| --- | --- | --- |
| `soap/run.ts` (Task 1.4) | `'../send-options.js'` (two import lines) | `'./send-input.js'` |
| `soap/run.ts` | `'../send.js'` | `'./send.js'` |
| `soap/run.ts` | `'../types.js'` | `'./types.js'` |
| `soap/scripting.ts` (Task 2.2b) | `'../types.js'` | `'./types.js'` |
| `protocols.ts` (Task 1.7) | `'./types.js'` | `'./soap/types.js'` |
| `rest/run.ts` (Task 1.5), `grpc/run.ts` (Task 1.6) | `'../send-options.js'` | `'./send-input.js'` (Step 2 creates the two files) |

```bash
perl -pi -e "s{'\.\./send-options\.js'}{'./send-input.js'}; s{'\.\./(send|types)\.js'}{'./\$1.js'}" packages/engine/src/soap/run.ts packages/engine/src/soap/scripting.ts
perl -pi -e "s{'\./types\.js'}{'./soap/types.js'}" packages/engine/src/protocols.ts
perl -pi -e "s{'\.\./send-options\.js'}{'./send-input.js'}" packages/engine/src/rest/run.ts packages/engine/src/grpc/run.ts
```

`soap/storage.ts`, the four `module.ts` and `run/prepare.ts` import none of the six: slice 1 left `run/prepare.ts` a dispatcher over the modules' `prepare…` functions, and `script/send.ts` lost its SOAP types to `soap/scripting.ts` in slice 2. (On `f9c0411b` the importers were `run/prepare.ts`, `run/run.ts` and `script/send.ts`.)

Run: `node scripts/engine-import-graph.mjs --check 2>&1 | grep '^unresolved import'`

Expected: two lines, `rest/run.ts` and `grpc/run.ts` each `-> ./send-input.js`, which Step 2 creates. Any other line is `unresolved import: <file> -> <specifier>` for an importer this plan did not list: a file directly in `soap/` takes `'./<name>.js'`, a file in another SOAP folder `'../soap/<name>.js'`; a file in `rest/`, `grpc/`, `ws/`, `asyncapi/` or core (other than `protocols.ts` and `index.ts`) that imported a SOAP type from the root `types.ts` is a cross-group import this plan did not expect: stop and report it.

- [ ] **Step 2: `send-input.ts` for REST and gRPC, out of `soap/send-input.ts`**

Line numbers are those of `soap/send-input.ts` as Step 1 left it (one more than the root `send-options.ts` had on `f9c0411b`, because Task 4.3 split an import).

Create `packages/engine/src/project/inherit.ts`: the header below, a blank line, then lines 213–216 (the JSDoc and body of `inherited`) with `export` added in front of `function`. Nothing else about it changes.

```ts
/**
 * "Inherit", as a send input means it: a setting a request leaves unset takes the value of the next
 * level up. Shared by the REST and gRPC send inputs, which climb the same ladder (request, API,
 * project, preference), so it lives in core (protocol modules spec §7.2).
 */
```

Create `packages/engine/src/rest/send-input.ts`: the header and imports below, a blank line, lines 182–211 (`RestSendRequestInput`, `ToRestSendInputArgs`, each with its JSDoc), a blank line, then lines 218–287 (the JSDoc and body of `toRestSendInput`), unchanged.

```ts
/**
 * Turns a saved REST request plus the settings around it into the {@link RestSendInput} the
 * transport receives. The precedence between the layers of configuration is fixed here rather than
 * in the host: the request's own setting wins, then the API's, then the project's, then the user's
 * preference. A setting left unset is therefore never "off" — it is "inherit".
 */

import type { SendAuth } from '../http/auth/send-auth.js';
import type { Cookie } from '../http/cookies.js';
import type { KeyValueEntry } from '../http/entries.js';
import type { ProxyOptions, TlsOptions } from '../http/types.js';
import { inherited } from '../project/inherit.js';
import type { ProjectSettings } from '../project/model.js';
import { DEFAULT_PREFERENCES } from '../project/preferences.js';
import type { Preferences } from '../project/preferences.js';
import type { FileResolver } from './body.js';
import type { RestBody, RestMethod, RestRequestSettings } from './model.js';
import type { RestSendInput } from './send.js';
```

Create `packages/engine/src/grpc/send-input.ts`: the header and imports below, a blank line, then lines 289–353 unchanged (`GrpcSendRequestInput`, `ToGrpcSendInputArgs`, the JSDoc and body of `toGrpcSendInput`; they are the end of the file).

```ts
/**
 * Turns a saved gRPC request plus the settings around it into the transport input of one call,
 * everything but the encoded messages. The precedence between the layers of configuration is fixed
 * here rather than in the host: request, then API, then project, then the user's preference.
 */

import type { SendAuth } from '../http/auth/send-auth.js';
import type { KeyValueEntry } from '../http/entries.js';
import type { TlsOptions } from '../http/types.js';
import { inherited } from '../project/inherit.js';
import type { ProjectSettings } from '../project/model.js';
import { DEFAULT_PREFERENCES } from '../project/preferences.js';
import type { Preferences } from '../project/preferences.js';
import type { GrpcMethodKind, GrpcRequestSettings } from './model.js';
import type { GrpcSendInput } from './send.js';
```

In `soap/send-input.ts`, delete lines 181–353 (everything after the closing brace of `toSendInput`) and the eight imports nothing in the SOAP third uses, so that the top of the file reads:

```ts
/**
 * Turns a saved request plus the settings around it into the {@link SoapSendInput} the
 * transport actually receives.
 *
 * This is the single place the three layers of configuration meet, and the precedence between
 * them is fixed here rather than in the desktop app: the request's own property wins, then the
 * project's setting, then the user's preference (which is also the engine default). A property
 * left unset in the request is therefore never "off" — it is "inherit".
 */

import { DEFAULT_PREFERENCES } from '../project/preferences.js';
import type { Preferences } from '../project/preferences.js';
import type { Attachment, HeaderEntry, ProjectSettings, RequestProperties } from '../project/model.js';
import type { AttachmentResolver } from './mime/types.js';
import { soapActionHeaders } from './soap-action.js';
import { prettyPrint, removeEmptyContent, stripWhitespaces } from './transforms.js';
import type { SoapSendInput } from './types.js';
```

(The deleted imports are `SendAuth`, `ProxyOptions` and `TlsOptions`, `FileResolver`, the four REST model types, `Cookie`, `RestSendInput`, the two gRPC model types and `GrpcSendInput`.)

`index.ts`, which reads as below after Step 1:

```ts
// before
export { toGrpcSendInput, toRestSendInput, toSendInput } from './soap/send-input.js';
export type {
  AttachmentResolvers,
  GrpcSendRequestInput,
  RestSendRequestInput,
  SendRequestInput,
  ToGrpcSendInputArgs,
  ToRestSendInputArgs,
  ToSendInputArgs,
} from './soap/send-input.js';
// after
export { toSendInput } from './soap/send-input.js';
export { toRestSendInput } from './rest/send-input.js';
export { toGrpcSendInput } from './grpc/send-input.js';
export type { AttachmentResolvers, SendRequestInput, ToSendInputArgs } from './soap/send-input.js';
export type { RestSendRequestInput, ToRestSendInputArgs } from './rest/send-input.js';
export type { GrpcSendRequestInput, ToGrpcSendInputArgs } from './grpc/send-input.js';
```

Importers of the REST and gRPC thirds: `rest/run.ts` calls `toRestSendInput` and `grpc/run.ts` calls `toGrpcSendInput` (slice 1), and Step 1 already pointed both at `'./send-input.js'`, which now exists. `run/prepare.ts` imported all three functions on `f9c0411b`; since Task 1.6 it imports none of them, and is not edited.

Two tests:

`packages/engine/test/unit/send-options.test.ts`:

```ts
// before (after Step 1)
import { toRestSendInput, toSendInput } from '../../src/soap/send-input.js';
// after
import { toRestSendInput } from '../../src/rest/send-input.js';
import { toSendInput } from '../../src/soap/send-input.js';
```

`packages/engine/test/unit/grpc/expand-command.test.ts`:

```ts
// before (after Step 1)
import { toGrpcSendInput } from '../../../src/soap/send-input.js';
// after
import { toGrpcSendInput } from '../../../src/grpc/send-input.js';
```

In the header comment of `project/preferences.ts` (line 7), the file name `send-options.ts` becomes `soap/send-input.ts`.

- [ ] **Step 3: `soap/curl.ts`, out of `http/curl.ts`**

Create `packages/engine/src/soap/curl.ts`: the header and imports below, a blank line, then `http/curl.ts` lines 159–327 unchanged (`soapToCurl`, `FromCurlResult`, the private `tokenize`, `fromCurl`; they are the end of the file).

```ts
/**
 * A SOAP send as a `curl` command, and a pasted `curl` command back as a partial SOAP send input.
 *
 * The command itself — the quoting, the line continuations, the two shells — is `http/curl.ts`'s
 * {@link toCurl}; this file builds its description from a {@link SoapSendInput}, as `rest/curl.ts`
 * does from a REST one.
 */

import { expandBundles, takesNoValue } from '../http/curl-flags.js';
import { toCurl } from '../http/curl.js';
import type { CurlHeader, ToCurlOptions } from '../http/curl.js';
import { findHeredoc, findHereString } from '../http/heredoc.js';
import { soapActionHeaders } from './soap-action.js';
import type { SoapSendInput } from './types.js';
```

In `http/curl.ts`:

1. Delete lines 159–327.
2. Delete its four imports, lines 11–14 (`SoapSendInput`, `soapActionHeaders`, `findHeredoc` and `findHereString`, `expandBundles` and `takesNoValue`): everything that used them has left. The file then imports nothing.
3. Two doc comments link to a function that is no longer in scope. In the header (line 7) and above `ToCurlOptions` (line 59):

```ts
// before
 * description from its own send input ({@link soapToCurl} here, `restToCurl` in `rest/curl.ts`), so the
// after
 * description from its own send input (`soapToCurl` in `soap/curl.ts`, `restToCurl` in `rest/curl.ts`), so the
```

```ts
// before
/** Options for {@link toCurl} and {@link soapToCurl}. */
// after
/** Options for {@link toCurl} and for `soapToCurl` in `soap/curl.ts`. */
```

`index.ts`:

```ts
// before
export { fromCurl, soapToCurl, toCurl } from './http/curl.js';
export type { CurlBody, CurlCommand, CurlHeader, CurlPart } from './http/curl.js';
export type { FromCurlResult, ToCurlOptions } from './http/curl.js';
// after
export { toCurl } from './http/curl.js';
export type { CurlBody, CurlCommand, CurlHeader, CurlPart, ToCurlOptions } from './http/curl.js';
export { fromCurl, soapToCurl } from './soap/curl.js';
export type { FromCurlResult } from './soap/curl.js';
```

`packages/engine/test/unit/http/curl.test.ts`:

```ts
// before
import { soapToCurl, fromCurl } from '../../../src/http/curl.js';
// after
import { soapToCurl, fromCurl } from '../../../src/soap/curl.js';
```

- [ ] **Step 4: `soap/expand.ts`, out of `project/properties.ts`**

Create `packages/engine/src/soap/expand.ts`: the header and imports below, a blank line, then `project/properties.ts` lines 531–638 unchanged (the JSDoc and body of `expandSendInput`, and the private `expandEnvelope` it alone calls; they are the end of the file).

```ts
/**
 * Property expansion over a SOAP send input: the endpoint, the envelope, the SOAP action, the
 * headers, the attachments and the WS-Addressing fields.
 *
 * The expansion itself is `project/properties.ts`'s {@link expand}; this file knows which fields of
 * a {@link SoapSendInput} take it, as `rest/expand.ts`, `grpc/expand.ts` and `ws/expand.ts` do for
 * theirs.
 */

import { expand } from '../project/properties.js';
import type { ExpandOptions, PropertyScopes, UnresolvedRef } from '../project/properties.js';
import {
  assertNoControlCharacters,
  assertOriginIndependent,
  escapeXmlValue,
  expandWithSequenceEscaped,
} from '../project/sequence-guards.js';
import type { SoapSendInput } from './types.js';
```

In `project/properties.ts`:

1. Delete lines 531–638.
2. Delete the two imports only that code used, lines 21–27: `import type { SoapSendInput } from '../types.js';` and the four-name import from `./sequence-guards.js`.
3. The JSDoc of `ExpandOptions` (line 434) links to the function that left:

```ts
// before
/** Options accepted by {@link expand} and {@link expandSendInput}. */
// after
/** Options accepted by {@link expand} and by `expandSendInput` in `soap/expand.ts`. */
```

`soap/send.ts`:

```ts
// before (after Step 1)
import { expandSendInput } from '../project/properties.js';
// after
import { expandSendInput } from './expand.js';
```

The one other caller is `soap/run.ts` (slice 1; on `f9c0411b` it was `run/run.ts` and `run/prepare.ts`). Its line `import { expandSendInput } from '../project/properties.js';` becomes `import { expandSendInput } from './expand.js';`, and its type import of `PropertyScopes` from `'../project/properties.js'` stays.

`index.ts`:

```ts
// before
export { enabledProperties, expand, expandSendInput, hasExpansions, secretNamesIn } from './project/properties.js';
// after
export { enabledProperties, expand, hasExpansions, secretNamesIn } from './project/properties.js';
export { expandSendInput } from './soap/expand.js';
```

`packages/engine/test/unit/project/properties.test.ts`: remove the line `  expandSendInput,` from the import of `'../../../src/project/properties.js'` and add after that import:

```ts
import { expandSendInput } from '../../../src/soap/expand.js';
```

`packages/engine/test/unit/project/sequence-guards.test.ts`:

```ts
// before
import { expand, expandSendInput } from '../../../src/project/properties.js';
// after
import { expand } from '../../../src/project/properties.js';
import { expandSendInput } from '../../../src/soap/expand.js';
```

In the header of `rest/expand.ts` (line 5), the words `project/properties.ts` in "`project/properties.ts`'s `expandSendInput`" become `soap/expand.ts`.

- [ ] **Step 5: The script no longer knows root SOAP files**

In `scripts/engine-import-graph.mjs`, delete the constant and its JSDoc:

```js
/**
 * Root files that are SOAP's until they move under `soap/`. Removed by the task that moves them.
 *
 * @type {readonly string[]}
 */
export const SOAP_ROOT_FILES = Object.freeze(['import.ts', 'send.ts', 'generate.ts', 'operations.ts', 'types.ts']);

```

and in `groupOf` replace

```js
  const slash = file.indexOf('/');
  if (slash === -1) {
    return SOAP_ROOT_FILES.includes(file) ? 'soap' : 'core';
  }
  const top = file.slice(0, slash);
```

with

```js
  const slash = file.indexOf('/');
  const top = slash === -1 ? '' : file.slice(0, slash);
```

- [ ] **Step 6: Verify**

```bash
nice pnpm exec tsc -b
node scripts/engine-import-graph.mjs --check
node scripts/engine-import-graph.mjs | grep -cE '^\[(soap|rest|grpc|ws)->'
git grep -nE "send-options\.js|src/(import|send|generate|operations|types)\.js'" -- packages apps scripts
nice pnpm vitest run --project engine-unit --project engine-integration
```

Expected: `tsc` prints nothing. `--check` prints no line starting with `[` and no `unresolved import`; its summary reads `engine layers: 0 violation(s), S stale exception(s), A allowed import(s) from core` (it exits 1 while S is not 0; Task 4.9 brings it to 0). The count of imports between protocol groups is `0`. The `git grep` prints nothing. The tests pass.

If `--check` still prints a violation, it is one of two things: a name in "What moves, by symbol" that an earlier task's rule should have switched (switch it now, by that rule); or something this plan did not expect, in which case stop and report it. The imports slices 1 to 3 kept in core on purpose are entries of `CORE_EXCEPTIONS` since Task 4.1 and are not printed.

- [ ] **Step 7: Format, check, commit**

```bash
git add -A packages/engine scripts/engine-import-graph.mjs
git diff --cached --name-only --diff-filter=d -z | xargs -0 pnpm exec prettier --write --ignore-unknown
git add -A packages/engine scripts/engine-import-graph.mjs
WIREBENCH_SKIP_PERF=1 nice pnpm check
nice pnpm pack:check
git commit -m "refactor(engine): the SOAP root files move under soap/, and send-options splits by protocol (#184)" -m "import.ts, send.ts, generate.ts, operations.ts and types.ts at the root of the engine are SOAP's and now say so by where they are. send-options.ts held one function per protocol: each goes to its protocol's send-input.ts, and the ladder helper they share to project/inherit.ts. The SOAP half of http/curl.ts and the SOAP expansion in project/properties.ts move to soap/, so neither core file imports SOAP any more. The public exports are unchanged."
```

---

### Task 4.9: The lint, and its test

**Files:**
- Create: `scripts/engine-layers.test.ts`
- Modify: `eslint.config.js`, `package.json` (one script, and `check`), `scripts/engine-import-graph.mjs` (only if Step 3 finds a stale entry, which is not expected)

**Interfaces:**
- Consumes: `GROUP_FOLDERS`, `CORE_EXCEPTIONS` and the `--check` mode of `scripts/engine-import-graph.mjs` (Task 4.1).
- Produces:
  - `pnpm check:engine-layers` (`node scripts/engine-import-graph.mjs --check`), run by `pnpm check`
  - in `eslint.config.js`, one `no-restricted-imports` block per protocol group and one for core, each carrying the Electron and React ban the engine-wide block has today
  - `scripts/engine-layers.test.ts` in the `scripts` vitest project

**Two enforcers, and why.** The spec asks for an ESLint `no-restricted-imports` block per group. Patterns can express "a relative import that reaches into one of these folders" (the regex below), so the blocks are written and an editor flags a wrong import as it is typed. They cannot be the gate on their own, for three reasons: an exception in ESLint is a whole file (`ignores`), while `project/history.ts` may import five named files and `project/model.ts` only types; `no-restricted-imports` sees import and export statements, not `import('…')` types or dynamic imports; and nothing tells ESLint that an exception has gone stale. `pnpm check:engine-layers` resolves every import to a file, tells a type from a value, holds each exception to the file it names, and fails on an exception nothing uses. Both read the same two lists from the script, so they cannot disagree about which folder is whose.

- [ ] **Step 1: Write the test**

Create `scripts/engine-layers.test.ts`:

```ts
/**
 * The engine's dependency rules (protocol modules spec §7.2), checked three ways: the import-graph
 * script against a fixture tree that breaks each rule once, the same script against the real tree,
 * and the ESLint blocks `eslint.config.js` builds from the script's lists.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('./engine-import-graph.mjs', import.meta.url));

interface ReportedEdge {
  readonly from: string;
  readonly to: string;
  readonly fromGroup: string;
  readonly toGroup: string;
  readonly typeOnly: boolean;
}

interface Report {
  readonly edges: readonly ReportedEdge[];
  readonly violations: readonly ReportedEdge[];
  readonly unresolved: readonly string[];
}

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A source tree with one import of each kind the rules tell apart. */
const FIXTURE: Readonly<Record<string, string>> = {
  'http/entries.ts': 'export const shared = 1;\n',
  'rest/model.ts': 'export interface RestApi {\n  readonly id: string;\n}\nexport const REST = 1;\n',
  // A protocol importing core and itself: no edge.
  'rest/send.ts':
    "import { shared } from '../http/entries.js';\nimport { REST } from './model.js';\nexport const sent = shared + REST;\n",
  // Rule 1, and a type-only import breaks it too.
  'grpc/model.ts':
    "import type { RestApi } from '../rest/model.js';\nexport interface GrpcApi {\n  readonly rest: RestApi;\n}\n",
  // Rule 2.
  'assert/status.ts': "import { REST } from '../rest/model.js';\nexport const status = REST;\n",
  // An exception, used as it is written: type-only.
  'project/model.ts':
    "import type { RestApi } from '../rest/model.js';\nexport interface Project {\n  readonly apis: readonly RestApi[];\n}\n",
  // An exception that allows a type, used for a value.
  'project/request-location.ts': "import { REST } from '../rest/model.js';\nexport const located = REST;\n",
  // An `import()` type is an import.
  'script/run.ts': "export type Api = import('../rest/model.js').RestApi;\n",
};

describe('engine-import-graph.mjs', () => {
  let fixture: string;

  beforeAll(async () => {
    fixture = await mkdtemp(join(tmpdir(), 'wirebench-engine-layers-'));
    for (const [file, text] of Object.entries(FIXTURE)) {
      await mkdir(dirname(join(fixture, file)), { recursive: true });
      await writeFile(join(fixture, file), text);
    }
  });

  afterAll(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it('reports every import that leaves its group, and which of them break a rule', () => {
    const result = run(['--src', fixture, '--json']);
    const report = JSON.parse(result.stdout) as Report;

    expect(report.unresolved).toEqual([]);
    expect(report.edges.map((edge) => `${edge.from} -> ${edge.to}`)).toEqual([
      'assert/status.ts -> rest/model.ts',
      'grpc/model.ts -> rest/model.ts',
      'project/model.ts -> rest/model.ts',
      'project/request-location.ts -> rest/model.ts',
      'script/run.ts -> rest/model.ts',
    ]);
    expect(report.violations.map((edge) => edge.from)).toEqual([
      'assert/status.ts',
      'grpc/model.ts',
      'project/request-location.ts',
      'script/run.ts',
    ]);
  }, 30_000);

  it('exits non-zero under --check and names the rule each import breaks', () => {
    const result = run(['--src', fixture, '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[grpc->rest] grpc/model.ts -> rest/model.ts : RestApi (type-only)');
    expect(result.stderr).toContain('breaks rule 1: no other protocol group');
    expect(result.stderr).toContain('[core->rest] assert/status.ts -> rest/model.ts : REST');
    expect(result.stderr).toContain('breaks rule 2: core imports no protocol group');
    expect(result.stderr).not.toContain('project/model.ts -> rest/model.ts');
  }, 30_000);

  it('finds no violation and no stale exception in the engine itself', () => {
    const result = run(['--check']);

    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^engine layers: 0 violation\(s\), 0 stale exception\(s\), \d+ allowed import\(s\)/);
    expect(result.status).toBe(0);
  }, 30_000);
});

describe('the ESLint blocks for the engine layers', () => {
  const eslint = new ESLint({ cwd: repoRoot });

  /** Lints `code` as if it were the engine file `file`; the file exists, so typed linting has a project for it. */
  async function layerMessages(file: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: join(repoRoot, 'packages/engine/src', file) });
    return (result?.messages ?? [])
      .filter((message) => message.ruleId === 'no-restricted-imports')
      .map((message) => message.message);
  }

  it('refuses an import of another protocol group, with the spec section in the message', async () => {
    const messages = await layerMessages(
      'grpc/status.ts',
      "import { entry } from '../rest/model.js';\nexport const made = entry('a', 'b');\n",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('the grpc group imports core and itself, never another protocol group');
    expect(messages[0]).toContain('spec §7.2, rule 1');
  }, 60_000);

  it('refuses an import of a protocol group from core', async () => {
    const messages = await layerMessages(
      'assert/status.ts',
      "import { GRPC_STATUS_NAMES } from '../grpc/status.js';\nexport const names = GRPC_STATUS_NAMES;\n",
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('core imports no protocol group (protocol modules spec §7.2, rule 2)');
  }, 60_000);

  it('lets a protocol import core and itself, and an exception file import a protocol', async () => {
    expect(
      await layerMessages(
        'rest/openapi/map.ts',
        "import { entry } from '../../http/entries.js';\nimport { composeUrl } from '../url.js';\nimport { hookKey } from '../../webhooks/model.js';\nexport const used = [entry, composeUrl, hookKey];\n",
      ),
    ).toEqual([]);
    expect(
      await layerMessages(
        'project/model.ts',
        "import type { RestApi } from '../rest/model.js';\nexport type Api = RestApi;\n",
      ),
    ).toEqual([]);
  }, 60_000);

  it('still keeps Electron out of a protocol folder', async () => {
    const messages = await layerMessages('grpc/status.ts', "import 'electron';\n");

    expect(messages).toEqual([
      "'electron' import is restricted from being used. engine must stay free of Electron/React",
    ]);
  }, 60_000);
});
```

The ESLint cases lint text under the path of a file that exists (`grpc/status.ts`, `assert/status.ts`, `rest/openapi/map.ts`, `project/model.ts`): the type-checked config cannot lint a path the TypeScript project service has never seen, which is the same reason `packages/engine/test/unit/lint-guard.test.ts` falls back to a real file. The fixture's two allowed imports lean on two entries of the real `CORE_EXCEPTIONS` (`project/model.ts` and `project/request-location.ts`, both to `rest/model.ts`, type-only); the phase that removes those entries changes the fixture with them.

- [ ] **Step 2: Run the test to see it fail**

Run: `nice pnpm vitest run --project scripts scripts/engine-layers.test.ts`
Expected: FAIL. `refuses an import of another protocol group, with the spec section in the message` and `refuses an import of a protocol group from core` fail with `expected [] to have a length of 1 but got +0`: the ESLint blocks do not exist yet. `finds no violation and no stale exception in the engine itself` fails too if Task 4.8, Step 6 reported stale exceptions. The two fixture cases, the allowed-imports case and the Electron case pass.

- [ ] **Step 3: Make the exception list match the tree**

Run: `node scripts/engine-import-graph.mjs --check`

Expected: no line on stderr: the list of Task 4.1 already has an entry for every import core keeps, the ten temporary ones of slices 1 to 3 included (`run/prepare.ts`, three for `run/run.ts`, `run/script-support.ts`, `script/index.ts`, four for `project/schema.ts`), and every entry is used. If it prints one all the same:

1. For a `stale exception: <from> -> <to> is no longer imported; remove it` line, delete that entry from `CORE_EXCEPTIONS` in `scripts/engine-import-graph.mjs`, and say in the commit body which slice did not leave the import.
2. For a violation line, stop and report it: an import core makes of a protocol that no slice of this plan announced is not given an exception here.
3. Run it again.

Expected then: no line on stderr, `engine layers: 0 violation(s), 0 stale exception(s), A allowed import(s) from core` on stdout, exit 0.

- [ ] **Step 4: Wire the check into `pnpm check`**

In `package.json`, add the script after `"check:banned-terms"`:

```json
    "check:engine-layers": "node scripts/engine-import-graph.mjs --check",
```

and in the `"check"` script insert `pnpm check:engine-layers && ` directly after `pnpm check:banned-terms && `, so that part of the line reads:

```
pnpm check:docs-images && pnpm check:banned-terms && pnpm check:engine-layers && pnpm licenses:third-party --check
```

CI runs `pnpm check` on Ubuntu and `pnpm check:tests` on macOS and Windows; the script runs with the first, the test of Step 1 with both.

- [ ] **Step 5: The ESLint blocks**

Replace `eslint.config.js` with the file below. What changes against today's file: the import of the two lists; the constants `ENGINE_PATHS`, `ENGINE_SRC`, `PROTOCOL_GROUPS`, `foldersOf` and `intoFolders`; the engine-wide block now names `ENGINE_PATHS` where it spelled the four paths out; and the five new blocks at the end. Nothing above the engine-wide block changes.

If a hook refuses the edit because the file is a linter configuration, stop and ask the owner to allow this one change. Do not write the file by another route.

```js
// @ts-check
import tseslint from 'typescript-eslint';
import { CORE_EXCEPTIONS, GROUP_FOLDERS } from './scripts/engine-import-graph.mjs';

/** The Monaco entry point every other module must go through; it is the one file allowed a bare import. */
const MONACO_CORE = 'apps/desktop/src/renderer/editor/monaco-core.ts';

/** Bans a bare `import 'monaco-editor'`. */
const MONACO_PATH = {
  name: 'monaco-editor',
  allowTypeImports: true,
  message: 'import Monaco through renderer/editor/monaco-core.ts; a bare import re-adds every worker',
};

/**
 * Bans every `@wirebench/engine` import bar the browser-safe subpaths. A regex, not a `group`:
 * gitignore-style globs cannot express "this package and every subpath of it *except* these".
 *
 * `/xml` carries the parser Monaco's XML language service needs; `/rest` carries the URL helpers the
 * REST editor's query table and URL field share with the send path — the one thing that must not be
 * reimplemented in the renderer, since two sets of escaping rules would eventually disagree about
 * what is being sent; `/grpc` carries the pure method-kind and target rules; `/detect` carries
 * pure-text format detection for the unified import dialog; `/json` carries the cursor analysis
 * Monaco's JSON completion provider runs on every keystroke, which is why it is not an IPC call;
 * `/snapshot` carries the semantic diff the Snapshot tab reruns on every response.
 * All of them are pure text code with no Node dependency.
 */
const ENGINE_PATTERN = {
  regex: '^@wirebench/engine(?!/(xml|rest|grpc|ws|json|detect|snapshot)$)(/.*)?$',
  message:
    'the renderer reaches the engine over IPC; only the browser-safe @wirebench/engine/xml, /rest, /grpc, /ws, /json, /detect, and /snapshot subpaths may be imported (ADR-0002)',
};

/** What no engine file may import, whatever its group. */
const ENGINE_PATHS = [
  { name: 'electron', message: 'engine must stay free of Electron/React' },
  { name: 'react', message: 'engine must stay free of Electron/React' },
  { name: 'react-dom', message: 'engine must stay free of Electron/React' },
  { name: '@wirebench/desktop', message: 'engine must stay free of Electron/React' },
];

const ENGINE_SRC = 'packages/engine/src';

/** The engine's protocol groups, as `scripts/engine-import-graph.mjs` defines them. */
const PROTOCOL_GROUPS = /** @type {(keyof typeof GROUP_FOLDERS)[]} */ (Object.keys(GROUP_FOLDERS));

/**
 * Every top-level engine folder of `groups`.
 *
 * @param {readonly (keyof typeof GROUP_FOLDERS)[]} groups
 */
const foldersOf = (groups) => groups.flatMap((group) => GROUP_FOLDERS[group]);

/**
 * Matches a relative import that reaches into one of `folders`, however deep the importer sits:
 * `../rest/model.js`, `../../wsdl/resolver.js`. A regex, not a `group`: a glob would also match a
 * package whose name is a folder's (`ws`).
 *
 * @param {readonly string[]} folders
 */
const intoFolders = (folders) => `^\\.{1,2}/(?:.*/)?(?:${folders.join('|')})/`;

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-test/**',
      '**/out/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.superpowers/**',
      '**/fixtures/**',
      'docs-site/.astro/**',
      // Its astro:content types are generated into .astro/ by an Astro build or `astro sync`, which
      // the lint job never runs, so typed rules would see every import as unresolved.
      'docs-site/src/content.config.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Monaco may only be pulled in at runtime through `editor/monaco-core.ts`, which imports the
    // trimmed set of feature modules. A bare `import 'monaco-editor'` anywhere else re-registers
    // every bundled language and the four language-service workers (17 MB of build output), and
    // nothing else would catch it until the renderer bundle had already doubled. Type-only
    // imports are fine: they disappear at build time.
    files: ['apps/desktop/**/*.{ts,tsx,mts,cts}'],
    ignores: [MONACO_CORE],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [MONACO_PATH] }],
    },
  },
  {
    // ADR-0002 put the engine in the main process: the renderer talks to it over IPC, never by
    // importing it. The exceptions are the two browser-safe subpaths `@wirebench/engine/xml` and
    // `@wirebench/engine/rest` (see ENGINE_PATTERN), so the ban is expressed as "the engine, except
    // those subpaths" rather than as a convention nobody can enforce. The
    // Monaco rule from the block above is repeated here because a second `no-restricted-imports`
    // entry replaces the first rather than merging with it.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx,mts,cts}'],
    ignores: [MONACO_CORE],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { paths: [MONACO_PATH], patterns: [ENGINE_PATTERN] }],
    },
  },
  {
    // `monaco-core.ts` is exempt from the Monaco rule alone — it is the file the rest of the
    // renderer imports Monaco through. It is renderer code like any other, so the engine ban
    // still applies to it, and it gets its own block because exempting it from the block above
    // would have exempted it from both rules at once.
    files: [MONACO_CORE],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [ENGINE_PATTERN] }],
    },
  },
  {
    files: ['packages/engine/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': ['error', { paths: ENGINE_PATHS }],
    },
  },
  // The engine's dependency rules (protocol modules spec §7.2). Each block below repeats
  // ENGINE_PATHS because a second `no-restricted-imports` entry for a file replaces the first rather
  // than merging with it. `pnpm check:engine-layers` is the exact gate; these blocks are the same
  // two rules as an editor sees them, one import line at a time.
  ...PROTOCOL_GROUPS.map((group) => ({
    // Rule 1: a protocol group imports core and itself, never another protocol group.
    files: GROUP_FOLDERS[group].map((folder) => `${ENGINE_SRC}/${folder}/**/*.ts`),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ENGINE_PATHS,
          patterns: [
            {
              regex: intoFolders(foldersOf(PROTOCOL_GROUPS.filter((other) => other !== group))),
              message: `the ${group} group imports core and itself, never another protocol group (protocol modules spec §7.2, rule 1); move what is shared into core`,
            },
          ],
        },
      ],
    },
  })),
  {
    // Rule 2: core imports no protocol group. The files that may are the importers named in
    // CORE_EXCEPTIONS: they are left to the engine-wide block above, and the script holds each of
    // them to the exact files its exceptions list.
    files: [`${ENGINE_SRC}/**/*.ts`],
    ignores: [
      ...foldersOf(PROTOCOL_GROUPS).map((folder) => `${ENGINE_SRC}/${folder}/**`),
      ...new Set(CORE_EXCEPTIONS.map((exception) => `${ENGINE_SRC}/${exception.from}`)),
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ENGINE_PATHS,
          patterns: [
            {
              regex: intoFolders(foldersOf(PROTOCOL_GROUPS)),
              message:
                'core imports no protocol group (protocol modules spec §7.2, rule 2); call the protocol through the registry, or move what is shared into core',
            },
          ],
        },
      ],
    },
  },
);
```

A block whose `files` match a file replaces the `no-restricted-imports` options of an earlier block for that file, which is why every new block repeats `ENGINE_PATHS`. A file of an exception (`project/model.ts`, `index.ts`, …) is ignored by the core block and so keeps the engine-wide block's options: the Electron and React ban still reaches it.

- [ ] **Step 6: Run the tests and the lint**

Run: `nice pnpm vitest run --project scripts scripts/engine-layers.test.ts`
Expected: PASS, 7 tests.

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/lint-guard.test.ts`
Expected: PASS. The existing guard probes a file at the root of `packages/engine/src`, which the core block covers, with `ENGINE_PATHS` in it.

Run: `nice pnpm lint`
Expected: no error. The ESLint blocks are looser than the script everywhere but in one respect: they match a protocol folder's name anywhere in a relative specifier, so a subfolder of core named like a protocol folder (a `something/ws/`) would be flagged though the script allows it. There is none on `f9c0411b`, and slices 1 to 3 add none (their new core folders and files are `protocol/`, `protocols.ts`, `run/context.ts`, `run/scope.ts`, `run/tree.ts`, `run/send-helpers.ts`, `script/lookup.ts` and four files in `project/`).

- [ ] **Step 7: What is left, printed**

```bash
node scripts/engine-import-graph.mjs | grep -cE '^\[(soap|rest|grpc|ws)->'
node scripts/engine-import-graph.mjs | sed -nE 's/^\[[a-z]+->[a-z]+\] ([^ ]+) -> .*/\1/p' | sort -u
```

Expected: `0`, then the importers of every remaining cross-group import, which are exactly the `from` files of `CORE_EXCEPTIONS`:

```
import-detect.ts
index.ts
project/history.ts
project/load.ts
project/model.ts
project/request-location.ts
project/schema.ts
project/serialize.ts
protocols.ts
run/prepare.ts
run/run.ts
run/script-support.ts
script/index.ts
secrets/scan/apply.ts
secrets/scan/walk.ts
```

A name missing from this list means Step 3 removed its entry as stale, and the commit body says so. A name that is in neither this list nor `CORE_EXCEPTIONS` cannot appear: `--check` would have failed.

Note for slice 5: Task 5.2 deletes `run/prepare.ts` and `scriptTypesFor`, and moves the re-exports out of `run/run.ts`, `script/index.ts` and `project/schema.ts`. Each leaves stale entries that `pnpm check:engine-layers` reports by name; Task 5.2 deletes the ten entries in the same commit (its Steps 2, 3 and 9 quote them), after which `run/prepare.ts`, `run/run.ts`, `run/script-support.ts` and `script/index.ts` are gone from the list above and `project/schema.ts` stays for its import of `wss/model.ts`.

- [ ] **Step 8: Format, check, commit**

```bash
pnpm exec prettier --write eslint.config.js package.json scripts/engine-import-graph.mjs scripts/engine-layers.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
nice pnpm pack:check
git add eslint.config.js package.json scripts/engine-import-graph.mjs scripts/engine-layers.test.ts
git commit -m "build(lint): a protocol folder imports core and itself, and core imports no protocol (#184)" -m "pnpm check:engine-layers, part of pnpm check, resolves every import in the engine to a file and fails on an import between protocol groups, on an import of a protocol from core that CORE_EXCEPTIONS does not list, and on a listed exception nothing uses any more. ESLint gets the same two rules as no-restricted-imports blocks built from the same lists, for the editor; it cannot be the gate because its exceptions are whole files and it does not see import() types."
```

---

## Slice 5 — Public exports, documentation and the ADR

Spec §8, §9 (the documentation row), §11 and §12 item 5. Slices 1 to 4 have landed when this slice starts: the registry, the four modules, the storage facet with placeholders, and the cut of cross-group imports. `packages/engine/src/index.ts` still exports every 2.x name, from the new locations. This slice is the only one that breaks a public export.

Six tasks. The one behaviour change spec §8 asks of the CLI (the "not selectable" message names placeholders) is not here: slice 3 made it with the placeholders themselves (Task 3.4, Step 10: `resolveItem` refuses a reference into a placeholder with `unsupported-kind`, tested by `packages/cli/test/unit/ops/items.test.ts`). This slice documents it.

| Task | What |
| --- | --- |
| 5.1 | Rename the SOAP-era exports, in the engine, the CLI and the desktop |
| 5.2 | Remove what the registry replaces and the re-exports slices 1 to 3 left in core, widen `protocol` to `string`, export the module API |
| 5.3 | A guard on the public surface: a unit test and a type-level file |
| 5.4 | Documentation: ADR-0017, the overview, the engine README, CONTRIBUTING, the changelog, `docs/cli.md`, the roadmap's plugin lines |
| 5.5 | Version numbers and milestones |
| 5.6 | Final verification, push, pull request |

Line numbers below are those of `main` at 6478e58e unless a line says "after slice N". Where a file moved in slices 1 to 4, both paths are given. An edit earlier in the same file shifts the numbers after it, so every replacement also quotes the text it replaces: anchor on the text. Every command runs from the worktree root.

**A fact that holds for every task here.** `nice pnpm exec tsc -b` checks the engine, the CLI, the server and their tests. It does not check the desktop, `scripts/` or `e2e/`. The renames reach the desktop, so the type check of this slice is `nice pnpm typecheck` (`tsc -b && pnpm --filter @wirebench/desktop typecheck && tsc --noEmit -p scripts/tsconfig.json && tsc --noEmit -p e2e/tsconfig.json`).

---

### Task 5.1: Rename the SOAP-era exports

**Files:**
- Modify (engine, declarations; after slice 4 the root files are under `soap/`):
  - `packages/engine/src/soap/import.ts` (was `src/import.ts`)
  - `packages/engine/src/soap/types.ts` (was `src/types.ts`)
  - `packages/engine/src/soap/generate.ts` (was `src/generate.ts`)
  - `packages/engine/src/soap/operations.ts` (was `src/operations.ts`)
  - `packages/engine/src/soap/send-input.ts` (the SOAP third of `src/send-options.ts`)
  - `packages/engine/src/index.ts`
- Modify (engine, uses): every file the script in Step 2 touches under `packages/engine/src` and `packages/engine/test`
- Modify (CLI): `packages/cli/src/ops/import.ts`, `packages/cli/src/ops/operations.ts`
- Modify (desktop): `apps/desktop/src/main/engine-service.ts`, `engine-wire.ts`, `ipc/xml.ts`, `project-host.ts`, `project-wire.ts`, `script-host.ts`, `apps/desktop/src/shared/wire-types.ts`, `apps/desktop/src/renderer/features/interface-editor/interface-editor.tsx`, `apps/desktop/test/engine-wire.test.ts`, `ipc-validate.test.ts`, `ipc-wsi.test.ts`, `project-definition-update.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: fifteen renamed exports of `@wirebench/engine`. No signature, no behaviour and no file name changes.

| 2.x | 3.0 | Declared (main) | After slice 4 |
| --- | --- | --- | --- |
| `importDefinition` | `importWsdl` | `src/import.ts:152` | `src/soap/import.ts` |
| `ImportSource` | `WsdlImportSource` | `src/types.ts:25` | `src/soap/types.ts` |
| `ImportProgress` | `WsdlImportProgress` | `src/types.ts:36` | `src/soap/types.ts` |
| `ImportCacheOptions` | `WsdlImportCacheOptions` | `src/types.ts:49` | `src/soap/types.ts` |
| `ImportOptions` | `WsdlImportOptions` | `src/types.ts:56` | `src/soap/types.ts` |
| `ImportProblem` | `WsdlImportProblem` | `src/types.ts:68` | `src/soap/types.ts` |
| `OperationSummary` | `SoapOperationSummary` | `src/types.ts:78` | `src/soap/types.ts` |
| `ImportResult` | `WsdlImportResult` | `src/types.ts:94` | `src/soap/types.ts` |
| `SendAttachmentOptions` | `SoapAttachmentOptions` | `src/types.ts:228` | `src/soap/types.ts` |
| `summarizeOperations` | `summarizeSoapOperations` | `src/operations.ts:43` | `src/soap/operations.ts` |
| `generateRequest` | `generateSoapRequest` | `src/generate.ts:13` | `src/soap/generate.ts` |
| `generateEmptyRequest` | `generateEmptySoapRequest` | `src/generate.ts:23` | `src/soap/generate.ts` |
| `SendRequestInput` | `SoapSendRequestInput` | `src/send-options.ts:27` | `src/soap/send-input.ts` |
| `ToSendInputArgs` | `ToSoapSendInputArgs` | `src/send-options.ts:49` | `src/soap/send-input.ts` |
| `toSendInput` | `toSoapSendInput` | `src/send-options.ts:108` | `src/soap/send-input.ts` |

None of the fifteen new names exists anywhere in the tree today (checked with `git grep -w`), so no rename can collide.

**References outside the engine** (whole-word hits, `git grep -w -c`, excluding `docs/specs` and `docs/plans`). `packages/server`, `docs-site`, `e2e`, `scripts`, `docs/*.md`, `README.md` and `CHANGELOG.md` have none.

| Name | Files outside the engine, with the count of hits |
| --- | --- |
| `importDefinition` | The engine's symbol in 5 files: `packages/cli/src/ops/import.ts` 2 · `apps/desktop/src/main/engine-service.ts` 1 (line 16 only) · `apps/desktop/test/engine-wire.test.ts` 3 · `apps/desktop/test/ipc-validate.test.ts` 2 · `apps/desktop/test/ipc-wsi.test.ts` 2. A further 20 hits in 9 files are **not** the engine's symbol: see below. |
| `ImportSource` | `apps/desktop/src/main/engine-service.ts` 3 · `apps/desktop/src/shared/wire-types.ts` 1 (a comment) |
| `ImportProgress` | `apps/desktop/src/main/engine-service.ts` 3 |
| `ImportCacheOptions`, `ImportOptions`, `ImportProblem` | none |
| `ImportResult` | 13 files: `apps/desktop/src/main/engine-service.ts` 11 · `engine-wire.ts` 4 · `ipc/xml.ts` 2 · `project-host.ts` 2 (comments) · `project-wire.ts` 1 (a comment) · `script-host.ts` 3 · `apps/desktop/src/renderer/features/interface-editor/interface-editor.tsx` 1 (a comment) · `apps/desktop/src/shared/wire-types.ts` 2 (comments) · `apps/desktop/test/engine-wire.test.ts` 1 · `ipc-validate.test.ts` 2 · `ipc-wsi.test.ts` 2 · `project-definition-update.test.ts` 1 (a comment) · `packages/cli/src/ops/import.ts` 3 |
| `OperationSummary` | `packages/cli/src/ops/operations.ts` 2 |
| `SendAttachmentOptions` | `apps/desktop/src/main/project-host.ts` 2 |
| `summarizeOperations` | `packages/cli/src/ops/operations.ts` 2 |
| `generateRequest` | `apps/desktop/src/main/engine-service.ts` 2 · `apps/desktop/test/engine-wire.test.ts` 2 · `packages/cli/src/ops/import.ts` 2 |
| `generateEmptyRequest` | `apps/desktop/src/main/engine-service.ts` 2 · `apps/desktop/src/shared/wire-types.ts` 1 (a comment) |
| `SendRequestInput`, `ToSendInputArgs` | none |
| `toSendInput` | `apps/desktop/src/main/project-host.ts` 5 (lines 66, 663, 718, and the comments at 631 and 715) |

**Not renamed, and why.**

- `importDefinition` is also the name of two things that belong to the desktop, and the desktop does not change its own API in this slice (spec §8: "Neither changes behaviour"):
  - the method `EngineService.importDefinition` (`apps/desktop/src/main/engine-service.ts:372`), the `{@link importDefinition}` in that class's constructor comment (`:334`), and its callers: `apps/desktop/src/main/ipc/definition.ts:61`, `apps/desktop/test/engine-service.test.ts` (6 hits), `ipc-definition.test.ts:58`, `ipc-request-actions.test.ts:148`, `ipc-xml.test.ts:34` and `:133`;
  - the renderer store's action `importDefinition` (`apps/desktop/src/renderer/state/project.ts:189` and `:1208`), its caller `apps/desktop/src/renderer/features/explorer/import-dialog.tsx:648`, and `apps/desktop/test/renderer/project-store.test.ts` (4 hits).

  That is 20 hits in 9 files, and Step 3 checks that exactly those remain.
- `ImportSourceWire`, `importSourceSchema` and the IPC channel `definition.import` in `apps/desktop/src/shared/` are the desktop's wire names. They are different words, a whole-word match does not touch them, and they stay.
- `docs/specs/**` and `docs/plans/**` are dated records and keep the names they were written with.
- The test files `packages/engine/test/unit/import.test.ts` and `send-options.test.ts` keep their file names (slice 4 rewrote their import paths and moved neither): `docs/success-criteria.md` cites test paths, and `pnpm check:doc-paths` fails on a path that no longer exists.

**Why a whole-word replace is safe.** Apart from `importDefinition`, no file in the repository declares a function, type, constant, method or property with one of the fifteen old names other than the engine's own declaration (checked: `git grep -n -P '(function|interface|type|const|class|readonly|async) (<each name>)\b'` finds only the rows of the table above, plus the two desktop `importDefinition` members). Comments that name an engine type are meant to follow the rename.

- [ ] **Step 1: See the starting point**

```bash
for n in importDefinition ImportSource ImportOptions ImportCacheOptions ImportProgress ImportProblem ImportResult \
  summarizeOperations OperationSummary generateRequest generateEmptyRequest toSendInput ToSendInputArgs \
  SendRequestInput SendAttachmentOptions; do
  printf '%-24s %s\n' "$n" "$(git grep -w -l "$n" -- packages apps scripts e2e docs-site | wc -l | tr -d ' ') files"
done
```

Expected: every name is in at least two files (its declaration file and `index.ts`). Slices 1 to 4 rename none of the fifteen, so a name that is in no file means the branch is not the one this plan describes: stop and ask.

- [ ] **Step 2: Rename**

Run this once. It is not committed.

```bash
bash <<'EOF'
set -euo pipefail
SCOPE=(packages apps scripts e2e docs-site)

# $1 old name, $2 new name: every whole-word occurrence in every tracked file in scope.
rename() {
  local old="$1" new="$2" files
  files=$(git grep -l -w "$old" -- "${SCOPE[@]}" || true)
  if [ -n "$files" ]; then
    printf '%s\n' "$files" | xargs perl -pi -e "s/\\b${old}\\b/${new}/g"
  fi
}

rename ImportSource          WsdlImportSource
rename ImportOptions         WsdlImportOptions
rename ImportCacheOptions    WsdlImportCacheOptions
rename ImportProgress        WsdlImportProgress
rename ImportProblem         WsdlImportProblem
rename ImportResult          WsdlImportResult
rename OperationSummary      SoapOperationSummary
rename SendAttachmentOptions SoapAttachmentOptions
rename SendRequestInput      SoapSendRequestInput
rename ToSendInputArgs       ToSoapSendInputArgs
rename summarizeOperations   summarizeSoapOperations
rename generateEmptyRequest  generateEmptySoapRequest
rename generateRequest       generateSoapRequest
rename toSendInput           toSoapSendInput

# importDefinition: the engine and the CLI everywhere; the desktop only where it is the engine's.
git grep -l -w importDefinition -- packages/engine packages/cli \
  | xargs perl -pi -e 's/\bimportDefinition\b/importWsdl/g'
perl -pi -e 's/\bimportDefinition as engineImportDefinition\b/importWsdl as engineImportDefinition/' \
  apps/desktop/src/main/engine-service.ts
perl -pi -e 's/\bimportDefinition\b/importWsdl/g' \
  apps/desktop/test/engine-wire.test.ts apps/desktop/test/ipc-validate.test.ts apps/desktop/test/ipc-wsi.test.ts
EOF
```

The replace is idempotent: `\bImportSource\b` does not match inside `WsdlImportSource`.

- [ ] **Step 3: Check what is left**

```bash
git grep -n -w -E 'ImportSource|ImportOptions|ImportCacheOptions|ImportProgress|ImportProblem|ImportResult|summarizeOperations|OperationSummary|generateRequest|generateEmptyRequest|toSendInput|ToSendInputArgs|SendRequestInput|SendAttachmentOptions' -- packages apps scripts e2e docs-site
```

Expected: no output.

```bash
git grep -c -w importDefinition -- packages apps scripts e2e docs-site
```

Expected, exactly:

```
apps/desktop/src/main/engine-service.ts:2
apps/desktop/src/main/ipc/definition.ts:1
apps/desktop/src/renderer/features/explorer/import-dialog.tsx:1
apps/desktop/src/renderer/state/project.ts:2
apps/desktop/test/engine-service.test.ts:6
apps/desktop/test/ipc-definition.test.ts:1
apps/desktop/test/ipc-request-actions.test.ts:1
apps/desktop/test/ipc-xml.test.ts:2
apps/desktop/test/renderer/project-store.test.ts:4
```

A line under `packages/` means the engine or the CLI still has the old name; a different count under `apps/desktop` means the script touched a desktop member it should not have, or missed an engine import. Fix by hand against the "Not renamed" list.

- [ ] **Step 4: Read the `index.ts` result**

The script renamed the names inside the existing export statements; nothing else in `index.ts` changes in this task. After it, the statements read (the paths are the ones Task 4.3, Step 2 and Task 4.8, Steps 1 and 2 left):

```ts
export { importWsdl } from './soap/import.js';
export { sendSoapRequest } from './soap/send.js';
export { generateEmptySoapRequest, generateSoapRequest } from './soap/generate.js';
export { summarizeSoapOperations } from './soap/operations.js';
export type {
  WsdlImportCacheOptions,
  WsdlImportOptions,
  WsdlImportProblem,
  WsdlImportProgress,
  WsdlImportResult,
  WsdlImportSource,
  SoapOperationSummary,
  SoapAttachmentOptions,
  SoapExchange,
  SoapSendInput,
  SoapSendWsa,
  SoapSendWss,
} from './soap/types.js';
export type { AuthSummary, SendAuth } from './http/auth/send-auth.js';
```

```ts
export { toSoapSendInput } from './soap/send-input.js';
export { toRestSendInput } from './rest/send-input.js';
export { toGrpcSendInput } from './grpc/send-input.js';
export type {
  AttachmentResolvers,
  SoapSendRequestInput,
  ToSoapSendInputArgs,
} from './soap/send-input.js';
export type { RestSendRequestInput, ToRestSendInputArgs } from './rest/send-input.js';
export type { GrpcSendRequestInput, ToGrpcSendInputArgs } from './grpc/send-input.js';
```

Sort the renamed names back into alphabetical order inside each list by hand (`SoapAttachmentOptions`, `SoapExchange`, `SoapOperationSummary`, `SoapSendInput`, `SoapSendWsa`, `SoapSendWss`, then the `Wsdl…` names). `SendAuth`, `AuthSummary`, `AttachmentResolvers`, `toRestSendInput`, `toGrpcSendInput` and `sendSoapRequest` keep their names (spec §8 "Unchanged").

- [ ] **Step 5: Format, type-check, test**

```bash
git diff --name-only -z | xargs -0 pnpm exec prettier --write --ignore-unknown
nice pnpm typecheck
nice pnpm vitest run --project engine-unit --project engine-integration
nice pnpm vitest run --project cli-unit --project cli-integration
nice pnpm vitest run --project desktop
```

Expected: `typecheck` exits 0; every project passes with the same number of tests as before the task. The longer names re-wrap a few lines under prettier; that is the only formatting change. A test title that named an old export (for example `describe('importDefinition', …)`) now names the new one, which the plan's rule allows ("a renamed export").

If `typecheck` reports `Cannot find name` or `has no exported member` in the desktop, the file holds one of the desktop's own `importDefinition` members that the script renamed by mistake, or an engine import it missed: compare with the "Not renamed" list.

- [ ] **Step 6: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages apps
git commit -m "refactor(engine)!: the SOAP-era exports take SOAP names (#184)" -m "importDefinition, ImportResult and the other names that read as every protocol's are WSDL's and SOAP's, and say so from 3.0: importWsdl, WsdlImport*, summarizeSoapOperations, SoapOperationSummary, generateSoapRequest, generateEmptySoapRequest, toSoapSendInput and its two types, SoapAttachmentOptions. No alias is kept. The CLI and the desktop follow; the desktop's own importDefinition method and store action keep their names."
```

---

### Task 5.2: Remove what the registry replaces, widen `protocol`, export the module API

**Files:**
- Delete: `packages/engine/src/run/prepare.ts`
- Create: `packages/engine/test/helpers/prepare-for.ts`
- Modify: `packages/engine/src/run/index.ts`, `packages/engine/src/run/script-support.ts`, `packages/engine/src/run/run.ts`, `packages/engine/src/script/model.ts`, `packages/engine/src/script/index.ts`, `packages/engine/src/project/model.ts`, `packages/engine/src/project/schema.ts`, `packages/engine/src/project/schema-parts.ts`, `packages/engine/src/index.ts`
- Modify (the allow-list of slice 4 loses its temporary entries): `scripts/engine-import-graph.mjs`
- Modify (the `@internal` tag): `packages/engine/src/protocol/features.ts`, `protocol/module.ts`, `protocol/registry.ts`, `packages/engine/src/protocols.ts`, `packages/engine/src/project/model.ts`, `packages/engine/src/assert/model.ts`
- Modify (uses of `RequestDef`): `packages/engine/src/project/environments.ts`, `project/serialize.ts` (after slice 3 its SOAP half is `soap/storage.ts`), `workspace/environments.ts`, `workspace/reidentify.ts`, `wsdl/update-definition.ts`, `packages/engine/test/unit/project/roundtrip.test.ts`, `packages/engine/test/unit/wsdl/update.test.ts`, `apps/desktop/src/main/expansion-preflight.ts`, `project-host.ts`, `project-mutations.ts`, `project-wire.ts`, `apps/desktop/src/shared/wire-types.ts`
- Modify (uses of `ScriptProtocol`): `apps/desktop/src/main/script-host.ts`
- Modify: `packages/cli/src/reporters/json.ts`
- Modify (tests): `packages/engine/test/unit/run/prepare.test.ts`, `packages/engine/test/unit/run/webhook-signing.test.ts`, `packages/engine/test/unit/run/send-order.test.ts` and the six integration tests that import `RunContext` from `run/prepare.js` (import paths only); `packages/engine/test/unit/project/schema.test.ts` (import paths only); `packages/engine/test/unit/project/schema-split.test.ts` (slice 3's own test of the re-exports this task removes, Steps 4 and 9)

**Interfaces:**
- Consumes: `prepareSoap` (`packages/engine/src/soap/run.ts`), `prepareRest` (`rest/run.ts`), `prepareGrpc` (`grpc/run.ts`), `RunContext` (`run/context.ts`), `SelectedRequest` (`protocols.ts`), all from slice 1; the re-exports slice 1 left in `run/run.ts` (Task 1.7), slice 2 in `script/index.ts` (Task 2.2b, Step 15) and slice 3 in `project/schema.ts` (Task 3.1, Step 5); `CORE_EXCEPTIONS` and `pnpm check:engine-layers` (slice 4, Tasks 4.1 and 4.9).
- Produces:
  - removed from `@wirebench/engine`: `prepareSend`, `PreparedSend`, `assertSupportedKind`, `apiKindOf`, `RequestDef`, `scriptTypesFor`, `ScriptProtocol`
  - widened to `string`: `RequestResult.protocol`. The other two are already `string`: `AssertionSubject.protocol` since Task 2.3 and `ScriptedRequest.protocol` since Task 2.2b.
  - added to `@wirebench/engine`, each tagged `@internal` where it is declared: the spec §8 "Added" list, plus the supporting names of Step 8
  - no core file but `protocols.ts` and `index.ts` re-exports a protocol's names any more: every public name `run/run.ts`, `script/index.ts` and `project/schema.ts` re-exported is exported by `index.ts` from the file that declares it (Step 9), and `CORE_EXCEPTIONS` has no entry whose `until` names slice 5
  - test-only: `prepareFor(selected: SelectedRequest, context: RunContext): Promise<Prepared>` in `packages/engine/test/helpers/prepare-for.ts`

**References outside the engine** (whole words, as in Task 5.1):

| Name | Outside the engine |
| --- | --- |
| `prepareSend`, `PreparedSend` | none. In the engine: `test/unit/run/prepare.test.ts` (56 hits) and `test/unit/run/webhook-signing.test.ts` (4 hits) call it; `src/run/run.ts`, `run/secret-needs.ts` and `sequence/run.ts` name it (after slice 1, in comments only) |
| `assertSupportedKind` | none. In the engine: declared in `src/project/schema-parts.ts` and re-exported by `project/schema.ts` (Task 3.1); called by the five request readers in the modules' `storage.ts` files and, since Task 3.4, no longer by `project/load.ts`; tested in `test/unit/project/ws-format.test.ts` (lines 10, 190 to 197) |
| `apiKindOf` | none. In the engine: declared in `src/project/schema.ts`, with no caller since Task 3.2; `test/unit/project/schema-split.test.ts` (slice 3) lists it |
| `scriptTypesFor` | none. In the engine: declared in `src/run/script-support.ts` and exported by `run/index.ts`, with no caller since Task 1.7 (`createRunSender` asks the module's `run.scriptTypes`) |
| `RequestDef` | 5 desktop files, 25 hits: `apps/desktop/src/main/expansion-preflight.ts` 4 · `project-host.ts` 2 · `project-mutations.ts` 15 · `project-wire.ts` 3 · `apps/desktop/src/shared/wire-types.ts` 1 (a comment, line 1205) |
| `ScriptProtocol` | `apps/desktop/src/main/script-host.ts` 2 (the import at line 41, the field at line 83) |

**The two prepare tests: decided.**

- `packages/engine/test/unit/run/prepare.test.ts` (700 lines) guards what `prepareSoap`, `prepareRest` and `prepareGrpc` resolve: endpoints, scopes, auth, TLS, WS-Addressing, attachments, keystores. Those functions stay, as each module's own. The file **stays where it is and stays one file**: its SOAP, REST and gRPC cases share one fixture project and the `contextFor` and `inWorkspace` helpers, a three-way split would rewrite it in a slice that may not change an expected value, and `docs/success-criteria.md` (SC-O3) cites its path, which `pnpm check:doc-paths` checks. It calls the test helper `prepareFor` instead of the removed export.
- `packages/engine/test/unit/run/webhook-signing.test.ts` guards `prepareRest` for webhook items (three calls). It stays, and calls `prepareFor`.
- No test is deleted.

- [ ] **Step 1: The test helper that replaces `prepareSend` for the tests**

Create `packages/engine/test/helpers/prepare-for.ts`. Its body is the dispatch of the thin `run/prepare.ts` that Task 1.6, Step 5 left, moved: the same three `prepare…` imports from `soap/run.ts`, `rest/run.ts` and `grpc/run.ts`, with `SelectedRequest` taken from `protocols.ts`, where Task 1.7 declared it.

```ts
/**
 * Prepares a selected request with its own module's `prepare…` function, for the tests that look
 * at a prepared send. No engine code needs this dispatch: a module's `send` prepares for itself
 * (ADR-0017), which is why it is not an export.
 */
import { prepareGrpc } from '../../src/grpc/run.js';
import type { SelectedRequest } from '../../src/protocols.js';
import { prepareRest } from '../../src/rest/run.js';
import type { RunContext } from '../../src/run/context.js';
import { prepareSoap } from '../../src/soap/run.js';

/** What the three modules' `prepare…` functions resolve to, told apart by `kind`. */
export type Prepared =
  | Awaited<ReturnType<typeof prepareSoap>>
  | Awaited<ReturnType<typeof prepareRest>>
  | Awaited<ReturnType<typeof prepareGrpc>>;

/** @throws WirebenchError what the module's `prepare…` throws */
export function prepareFor(selected: SelectedRequest, context: RunContext): Promise<Prepared> {
  switch (selected.kind) {
    case 'soap':
      return prepareSoap(selected, context);
    case 'rest':
      return prepareRest(selected, context);
    case 'grpc':
      return prepareGrpc(selected, context);
  }
}
```

Point the tests at it, and at `run/context.js` for `RunContext`:

```bash
perl -pi -e 's/\bprepareSend\b/prepareFor/g' \
  packages/engine/test/unit/run/prepare.test.ts packages/engine/test/unit/run/webhook-signing.test.ts
perl -pi -e "s#^import \{ prepareFor \} from '\.\./\.\./\.\./src/run/prepare\.js';#import { prepareFor } from '../../helpers/prepare-for.js';#" \
  packages/engine/test/unit/run/prepare.test.ts packages/engine/test/unit/run/webhook-signing.test.ts
git grep -l "src/run/prepare\.js" -- packages/engine/test | xargs perl -pi -e 's#src/run/prepare\.js#src/run/context.js#'
```

The last line reaches nine files: the two unit tests above, `packages/engine/test/unit/run/send-order.test.ts` (Task 1.2) and six integration tests (`packages/engine/test/integration/run/run.test.ts`, `run-callback.test.ts`, `run-grpc.test.ts`, `run-oauth-rejected.test.ts`, `run-oauth-shared.test.ts`, `scripts.test.ts`), each of which imports only the type `RunContext` from that path. The tests slices 1 to 3 added after Task 1.2 already import it from `run/context.js`.

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/run/`
Expected: PASS, the same tests as before; the two `describe` titles now read `prepareFor — …`.

- [ ] **Step 2: Delete `run/prepare.ts`**

```bash
git rm packages/engine/src/run/prepare.ts
git grep -n "prepare\.js'" -- packages/engine/src/run packages/engine/src/sequence
```

Expected from the `grep`: only `packages/engine/src/run/index.ts`, lines 3 and 4 (slice 1 did not edit that file, and Task 1.7 pointed `run/run.ts` at `./context.js`). Replace its two lines

```ts
export { prepareSend, scopesFor } from './prepare.js';
export type { PreparedSend, RunContext, RunWorkspace } from './prepare.js';
```

with:

```ts
export { scopesFor } from './context.js';
export type { RunContext, RunWorkspace } from './context.js';
```

Then delete the entry of the deleted file from `CORE_EXCEPTIONS` in `scripts/engine-import-graph.mjs`, or `pnpm check:engine-layers` fails on a stale exception:

```js
  { from: 'run/prepare.ts', to: '*', until: 'slice 5 deletes the file' },
```

- [ ] **Step 3: Remove `scriptTypesFor`**

In `packages/engine/src/run/script-support.ts`, delete the function `scriptTypesFor` with its JSDoc (on `main`: lines 42 to 66, from `/** The script types for a selected request, …` to the function's closing brace) and the imports only it used. No other function in the file uses any of them. As Task 2.2a, Step 3 left them, they are these eight lines and one specifier:

```ts
import type { ProtoSet } from '../grpc/proto/load.js';
import { grpcMessageTypes, grpcScriptTypes } from '../grpc/script-types.js';
import type { OpenApiDocument } from '../rest/openapi/model.js';
import { restOperationFor, restScriptTypes } from '../rest/script-types.js';
import { soapOperationElements, soapScriptTypes } from '../soap/script-types.js';
import type { WsdlDefinition } from '../wsdl/model.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import type { SelectedRequest } from './select.js';
```

and `type RequestScriptTypes,` in the import from `'../script/request-scripts.js'`. After this the file imports no protocol folder. Run `pnpm exec eslint packages/engine/src/run/script-support.ts`; expected: no unused import reported.

Then delete the file's entry from `CORE_EXCEPTIONS` in `scripts/engine-import-graph.mjs` (slice 4 added it because `scriptTypesFor` stayed in core until this step):

```js
  { from: 'run/script-support.ts', to: '*', until: 'slice 5 removes scriptTypesFor' },
```

In `packages/engine/src/run/index.ts`, replace

```ts
export { mergeScriptValues, scriptAssertions, scriptSession, scriptTypesFor, listedSecrets } from './script-support.js';
```

with

```ts
export { mergeScriptValues, scriptAssertions, scriptSession, listedSecrets } from './script-support.js';
```

Check: `git grep -n -w scriptTypesFor -- packages apps` prints nothing. If it prints a caller in `packages/engine/src`, Task 1.7 did not finish moving `createRunSender` to the module's `run.scriptTypes`: stop and ask, do not re-point the caller here.

- [ ] **Step 4: `assertSupportedKind` and `apiKindOf` leave the public exports**

In `packages/engine/src/index.ts`, remove the two names from the `./project/schema.js` export list (on `main`: line 738 `assertSupportedKind,` and line 760 `apiKindOf,`).

What stays as an internal function:

- `assertSupportedKind` **stays**. Since Task 3.1 it is declared in `packages/engine/src/project/schema-parts.ts` and re-exported by `project/schema.ts`; the five request readers in the modules' `storage.ts` files call it, so a request file of a kind its container's module does not accept still refuses the project with `project-kind-not-supported` (spec §6). That re-export is core to core and stays, and the test in `packages/engine/test/unit/project/ws-format.test.ts` (which imports the function from `src/project/schema.js`, not from the index) stays untouched. In `project/schema-parts.ts`, add one sentence to the end of its JSDoc description, before `@throws`:

  ```ts
   * Internal since 3.0: a module's request reader calls it; a container of an unknown kind loads
   * as a placeholder instead (`Project.unsupported`), and a host asks `ProtocolRegistry.status`.
  ```

- `apiKindOf` **goes**. It has had no caller since Task 3.2 (the loader asks the registry). In `packages/engine/src/project/schema.ts`, delete the function and its JSDoc (on `main`: lines 648 to 656). In `packages/engine/test/unit/project/schema-split.test.ts` (slice 3), delete the line `  'apiKindOf',` from the `CORE` list.

Check:

```bash
git grep -n -w apiKindOf -- packages apps
```

Expected: no output.

- [ ] **Step 5: Remove `RequestDef`**

Order matters: the alias and the index entry go first, or the replace turns them into `export type SoapRequestDef = SoapRequestDef` and a duplicate export.

1. In `packages/engine/src/project/model.ts`, delete (on `main`: lines 315 to 319):

   ```ts
   /**
    * The name this type had before REST requests existed, kept as an alias for one release so
    * callers that only ever mean a SOAP request need not be touched. Prefer {@link SoapRequestDef}.
    */
   export type RequestDef = SoapRequestDef;
   ```

2. In `packages/engine/src/index.ts`, delete the line `  RequestDef,` from the `./project/model.js` type list (on `main`: line 374). `SoapRequestDef,` three lines below it stays.

3. Replace every other use:

   ```bash
   git grep -l -w RequestDef -- packages apps | xargs perl -pi -e 's/\bRequestDef\b/SoapRequestDef/g'
   ```

   A whole-word match leaves `SoapRequestDef`, `AnyRequestDef`, `RestRequestDef`, `GrpcRequestDef` and `WsRequestDef` alone. No file on `main` imports both `RequestDef` and `SoapRequestDef`; if `tsc` reports `Duplicate identifier 'SoapRequestDef'` in an import list, a slice added the second import: delete one of the two specifiers.

Check: `git grep -n -w RequestDef -- packages apps` prints nothing.

- [ ] **Step 6: Remove `ScriptProtocol`; widen `RequestResult.protocol`**

`ScriptedRequest.protocol` is already `string` (Task 2.2b, Step 12), and `AssertionSubject.protocol` too (Task 2.3). Slice 2 also took `ScriptProtocol` out of `script/request-scripts.ts`, `script/api/prelude.ts` and `script/types/api.ts`, and left the type exported (Task 2.2b, Step 3). What is left of it is four hits in three files, and this step removes them.

1. In `packages/engine/src/script/model.ts`, delete `export type ScriptProtocol = 'rest' | 'soap' | 'grpc';` and the JSDoc Task 2.2b, Step 3 gave it (line 8 on `main`).
2. In `packages/engine/src/script/index.ts`, delete the line `  ScriptProtocol,` from the `./model.js` type list (on `main`: line 32).
3. `apps/desktop/src/main/script-host.ts`: delete `  ScriptProtocol,` from the engine type import (line 41) and change the field of `interface Located` (line 83) to `readonly protocol: string;`. The three places that build a `Located` (`protocol: 'soap'`, `'rest'`, `'grpc'`, lines 143, 177 and 199) and the one that copies it into a `ScriptedRequest` (line 231) need no change.
4. Check: `git grep -n -w ScriptProtocol -- packages apps` prints nothing.
5. `packages/engine/src/run/run.ts`, in `interface RequestResult` (on `main`: line 77):

   ```ts
     /** The request's kind, as its module registered it. */
     readonly protocol: string;
   ```

   The echo helper needs no edit: its cast on `AssertionSubject.protocol` went in Task 2.3, and it never named `RequestResult`.

**What no longer narrows.** Widening breaks an assignment *from* the field *to* a closed union, and nothing else. There is one such place in the repository, and no `switch` or comparison on either field in the CLI's reporters, the desktop or the tests (checked: `git grep -n -P '\bprotocol\b' -- packages/cli apps/desktop/src/main`; the desktop's `request.protocol === 'rest'` tests in `ipc/log.ts`, `har.ts` and `log-curl.ts` are on its own wire types, not on these two).

- `packages/cli/src/reporters/json.ts:45`, in `interface JsonReportRequest`: `toReportRequest` copies `result.protocol` into it. Change

  ```ts
    readonly protocol: 'soap' | 'rest' | 'grpc';
  ```

  to

  ```ts
    /** The request's kind: `soap`, `rest` or `grpc` for the built-in protocols. */
    readonly protocol: string;
  ```

  The report's `formatVersion` stays 1: the values a built-in run writes are the same three. Task 5.4 updates the sentence in `docs/cli.md`.

Left as they are, on purpose: `SequenceStepResult.protocol` (`packages/engine/src/sequence/run.ts:77`) is typed `SelectedRequest['kind']`, the built-in union of spec §3.1, and spec §8 does not list it; `packages/cli/src/commands/sequence.ts:227` and `apps/desktop/src/main/sequence-runner.ts:141` copy it into a `string` and into the desktop's wire enum, and both still compile. The test literals `protocol: 'soap'` and `'rest'` in `packages/cli/test/unit/**` are assignable to `string`.

- [ ] **Step 7: Comments that still name what is gone**

```bash
git grep -n -w -E 'prepareSend|PreparedSend|scriptTypesFor' -- packages apps
```

Each remaining hit is a comment. Reword it to name what replaced the thing; the ones on `main` and their new wording:

| File (main) | Old | New |
| --- | --- | --- |
| `packages/engine/src/run/secret-needs.ts:4` | `It walks the same sources \`prepareSend\` resolves:` | `It walks the same sources a module's send resolves:` |
| `packages/engine/src/run/secret-needs.ts:76` | `\`prepareSend\` refuses such a request with its own error;` | `The module's send refuses such a request with its own error;` |
| `packages/engine/src/sequence/run.ts:3` | `(the CLI through \`prepareSend\`, the desktop through its own send` | `(the CLI through \`createRunSender\`, the desktop through its own send` |
| `RunContext.tokenSource` JSDoc (after slice 1 in `packages/engine/src/run/context.ts`) | `a lone \`prepareSend\` without one gets a fresh source.` | `a send outside a run gets a fresh source.` |
| the `tokenSourceOf` comment (after slice 1 in `packages/engine/src/run/send-helpers.ts`) | `or a fresh one for a \`prepareSend\` called on its own.` | `or a fresh one for a send outside a run.` |
| `packages/engine/src/run/run.ts` (two `throw new Error('prepareSend returned a send of the wrong protocol')`) | gone with slice 1's rewrite of `createRunSender`; if one is left, the code around it is dead: stop and ask | |

Expected after the edits: the `grep` prints nothing.

- [ ] **Step 8: Export the module API from `index.ts`, tagged `@internal`**

No earlier slice exported any of these names. The earlier slices added three exports to `index.ts`, none of them in the block below: `StatusNames` and `grpcStatusNames` (Task 2.3) and `takenContainerSlugs` (Task 3.3). This command confirms it:

```bash
grep -n -w -E 'createFeatureSet|FeatureDescriptor|FeatureSet|WhyDisabled|defineProtocol|ContainerBase|ContainerDir|LoadContext|ProtocolModule|ProtocolRun|ProtocolScripting|ProtocolStorage|RequestSnapshotBase|ResponseSnapshotBase|RunGroup|RunScope|ScriptedSend|SelectedBase|SnapshotFacts|createProtocolRegistry|ProtocolRegistry|ProtocolRegistryOptions|BUILTIN_PROTOCOLS|createBuiltinRegistry|extraContainersOf|unsupportedOf|UnsupportedContainer' \
  packages/engine/src/index.ts packages/engine/src/run/index.ts packages/engine/src/script/index.ts packages/engine/src/sequence/index.ts
```

Expected: no output. Then add this block to `packages/engine/src/index.ts`, directly after `export * from './run/index.js';`:

```ts
// Protocol modules, the registry and features (ADR-0017). Exported for the engine's own hosts and
// tagged `@internal` where they are declared: they are not yet a plugin API.
export { createFeatureSet } from './protocol/features.js';
export type { FeatureDescriptor, FeatureSet, WhyDisabled } from './protocol/features.js';
export { defineProtocol } from './protocol/module.js';
export type {
  ContainerBase,
  ContainerDir,
  LoadContext,
  ProtocolModule,
  ProtocolRun,
  ProtocolScripting,
  ProtocolStorage,
  RequestSnapshotBase,
  ResponseSnapshotBase,
  RunGroup,
  RunScope,
  ScriptedSend,
  SelectedBase,
  SnapshotFacts,
} from './protocol/module.js';
export { createProtocolRegistry } from './protocol/registry.js';
export type { ProtocolRegistry, ProtocolRegistryOptions } from './protocol/registry.js';
export { BUILTIN_PROTOCOLS, createBuiltinRegistry } from './protocols.js';
export { extraContainersOf, unsupportedOf } from './project/model.js';
export type { UnsupportedContainer } from './project/model.js';
```

Spec §8 lists `ProtocolModule`, `ProtocolStorage`, `ProtocolRun`, `ProtocolScripting`, `SnapshotFacts`, `SelectedBase`, `RunGroup`, `RunScope`, `ProtocolRegistry`, `createProtocolRegistry`, `createBuiltinRegistry`, `BUILTIN_PROTOCOLS`, `FeatureDescriptor`, `FeatureSet`, `createFeatureSet` and `UnsupportedContainer`. The other eleven are supporting names: the types the listed interfaces name in their own signatures (`ContainerBase`, `ContainerDir`, `LoadContext`, `ScriptedSend`, `RequestSnapshotBase`, `ResponseSnapshotBase`, `WhyDisabled`, `ProtocolRegistryOptions`), the one way to make a `ProtocolModule` (`defineProtocol`), and the two readers the plan's rulings require for the optional fields `Project.unsupported` and `Project.extraContainers` (`unsupportedOf`, `extraContainersOf`). Spec R14's list also has `takenContainerSlugs`; it has been exported since Task 3.3, which the desktop and the CLI needed it for, and gets the tag below like the others. `Project.unsupported` and `AssertionSubject.statusNames` are fields of types already exported.

**The tag.** Every declaration below gets this as the **last line** of its JSDoc (Task 5.3's guard looks for it there):

```
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
```

A one-line comment becomes a block. For example, in `packages/engine/src/protocol/features.ts`:

```ts
/**
 * One switchable feature.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface FeatureDescriptor {
```

A comment that has tags keeps them, and `@internal` goes after them. In `packages/engine/src/protocol/registry.ts`:

```ts
/**
 * Builds a registry from `modules`. Its feature set is the modules' descriptors plus
 * `options.features`, with `options.switches` applied.
 *
 * @throws Error for two modules of one kind; what `createFeatureSet` throws
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function createProtocolRegistry(
```

A field is tagged the same way. In `packages/engine/src/project/model.ts`, inside `interface Project`:

```ts
  /**
   * Containers this build could not load and left untouched on disk. Absent means none.
   *
   * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
   */
  readonly unsupported?: readonly UnsupportedContainer[];
```

The declarations, all of them:

| File | Declarations |
| --- | --- |
| `packages/engine/src/protocol/features.ts` | `FeatureDescriptor`, `WhyDisabled`, `FeatureSet`, `createFeatureSet` |
| `packages/engine/src/protocol/module.ts` | `ContainerDir`, `ContainerBase`, `LoadContext`, `ProtocolStorage`, `SelectedBase`, `RunGroup`, `RunScope`, `ScriptedSend`, `ProtocolRun`, `RequestSnapshotBase`, `ResponseSnapshotBase`, `SnapshotFacts`, `ProtocolScripting`, `ProtocolModule`, `defineProtocol` |
| `packages/engine/src/protocol/registry.ts` | `ProtocolRegistry`, `ProtocolRegistryOptions`, `createProtocolRegistry` |
| `packages/engine/src/protocols.ts` | `BUILTIN_PROTOCOLS`, `createBuiltinRegistry` |
| `packages/engine/src/project/model.ts` | `UnsupportedContainer`, `unsupportedOf`, `extraContainersOf`, `takenContainerSlugs`, and the fields `Project.extraContainers` and `Project.unsupported` |
| `packages/engine/src/assert/model.ts` | the field `AssertionSubject.statusNames` |

`stripInternal` is not set in `tsconfig.base.json`, and it must stay unset: with it, TypeScript would drop every tagged declaration from `dist/*.d.ts`, and the CLI would stop compiling against the built engine. Task 5.6 checks the built declarations.

- [ ] **Step 9: The re-exports slices 1 to 3 left in core move to `index.ts`**

Three core files still re-export a protocol's names so that the public exports kept working while the code moved: `run/run.ts` (Task 1.7), `script/index.ts` (Task 2.2b, Step 15) and `project/schema.ts` (Task 3.1, Step 5). Slice 4 allowed each of them by an entry in `CORE_EXCEPTIONS`. `index.ts` now exports every one of those names from the file that declares it, and the re-exports and their entries go. No public name is lost: the lists below are complete.

**a. The subjects, out of `run/run.ts`.**

1. In `packages/engine/src/run/run.ts`, delete the comment and the three protocol lines of this block, and keep the type line, which is core's own:

   ```ts
   // The subjects are each protocol's own; they stay exported from here until the public exports move
   // to the modules (slice 5 of the protocol modules plan).
   export { grpcSubject } from '../grpc/run.js';
   export type { SentExchange } from '../protocols.js';
   export { restSubject } from '../rest/run.js';
   export { soapResponseSubject } from '../soap/run.js';
   ```

   What is left of it is `export type { SentExchange } from '../protocols.js';`.
2. In `packages/engine/src/run/index.ts`, delete the three lines `  grpcSubject,`, `  restSubject,` and `  soapResponseSubject,` from the value list of `./run.js`.
3. In `packages/engine/test/unit/run/grpc-subject.test.ts`, line 10, `import { grpcSubject } from '../../../src/run/run.js';` becomes `import { grpcSubject } from '../../../src/grpc/run.js';`. No other file imports a subject from `run/run.js` or `run/index.js` (the desktop's `sequence-runner.ts` takes the three from `@wirebench/engine`).

**b. The scripting names, out of `script/index.ts`.**

In `packages/engine/src/script/index.ts`, delete the last block of the file, comment included:

```ts
// What lives in the protocol folders since the scripting facet, under the names it always had.
// These lines are the only place `script/` names a protocol; slice 5 moves them to `index.ts`.
export type { RequestSnapshot, ResponseSnapshot } from '../protocols.js';
export { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from '../rest/scripting.js';
export type { RestRequestSnapshot, RestResponseSnapshot } from '../rest/scripting.js';
export { loadOpenApiDocument, restOperationFor, restScriptTypes } from '../rest/script-types.js';
export { applySoapSnapshot, soapRequestSnapshot, soapResponseSnapshot } from '../soap/scripting.js';
export type { SoapRequestSnapshot, SoapResponseSnapshot } from '../soap/scripting.js';
export {
  projectSoapBody,
  qnameFromClark,
  replaceSoapBody,
  soapOperationElements,
  soapScriptTypes,
} from '../soap/script-types.js';
export { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from '../grpc/scripting.js';
export type { GrpcRequestSnapshot, GrpcResponseSnapshot } from '../grpc/scripting.js';
export { grpcMessageTypes, grpcScriptTypes } from '../grpc/script-types.js';
```

No file imports these names through `script/index.js`: its one importer is `index.ts`'s `export * from './script/index.js';`.

**c. The file schemas, out of `project/schema.ts`.**

1. In `packages/engine/src/project/schema.ts`, delete these eight lines:

   ```ts
   export { interfaceFileSchema, requestFileSchema } from '../soap/files.js';
   export type { InterfaceFile, RequestFile } from '../soap/files.js';
   export { apiFileSchema, restBodySchema, restRequestFileSchema } from '../rest/files.js';
   export type { ApiFile, RestRequestFile } from '../rest/files.js';
   export { grpcApiFileSchema, grpcMethodKindSchema, grpcRequestFileSchema } from '../grpc/files.js';
   export type { GrpcApiFile, GrpcRequestFile } from '../grpc/files.js';
   export { wsApiFileSchema, wsRequestFileSchema } from '../ws/files.js';
   export type { WsApiFile, WsRequestFile } from '../ws/files.js';
   ```

   and replace the comment above the `export { … } from './schema-parts.js';` that stays,

   ```ts
   // Everything that moved out keeps its old name here until the public exports change (slice 5 of
   // the protocol modules plan), so no importer of this file had to change with the move.
   ```

   with:

   ```ts
   // The pieces the protocols' file schemas share are declared in `schema-parts.ts` and keep their
   // old names here. A protocol's own file schemas are exported from its folder.
   ```

2. Three files imported a moved name through `project/schema.js`. `index.ts` is d. below. In `packages/engine/test/unit/project/schema.test.ts`, the import at lines 3 to 14,

   ```ts
   import {
     apiFileSchema,
     environmentFileSchema,
     interfaceFileSchema,
     keystoresFileSchema,
     manifestSchema,
     parseFile,
     requestFileSchema,
     wsApiFileSchema,
     wssIncomingFileSchema,
     wssOutgoingFileSchema,
   } from '../../../src/project/schema.js';
   ```

   becomes:

   ```ts
   import {
     environmentFileSchema,
     keystoresFileSchema,
     manifestSchema,
     parseFile,
     wssIncomingFileSchema,
     wssOutgoingFileSchema,
   } from '../../../src/project/schema.js';
   import { apiFileSchema } from '../../../src/rest/files.js';
   import { interfaceFileSchema, requestFileSchema } from '../../../src/soap/files.js';
   import { wsApiFileSchema } from '../../../src/ws/files.js';
   ```

   Nothing else in that file changes.
3. `packages/engine/test/unit/project/schema-split.test.ts` is slice 3's test that `project/schema.ts` re-exported what moved. It now says the opposite for the four `files.ts`. Replace its header comment

   ```ts
   /**
    * The file schemas live with their protocols, and `project/schema.ts` still exports every one of
    * them under its old name (spec §3.2), so nothing that imports it had to change.
    */
   ```

   with

   ```ts
   /**
    * The file schemas live with their protocols and are exported from there. `project/schema.ts`
    * holds the core documents, and still exports the shared pieces of `schema-parts.ts` (spec §3.2).
    */
   ```

   and the loop

   ```ts
     for (const [file, module, names] of MOVED) {
       it(`project/schema.ts still exports what moved to ${file}, as the same object`, () => {
         for (const name of names) {
           expect(module[name], name).toBeDefined();
           expect(old[name], name).toBe(module[name]);
         }
       });
     }
   ```

   with

   ```ts
     for (const [file, module, names] of MOVED) {
       const shared = file === 'project/schema-parts.ts';
       const title = shared ? `still exports what moved to ${file}, as the same object` : `no longer re-exports ${file}`;
       it(`project/schema.ts ${title}`, () => {
         for (const name of names) {
           expect(module[name], name).toBeDefined();
           expect(old[name], name).toBe(shared ? module[name] : undefined);
         }
       });
     }
   ```

   The file's other two cases do not change (Step 4 already took `'apiKindOf'` out of `CORE`). This is a test the plan added in Task 3.1, not one that existed before it.

**d. `index.ts` exports each name from where it is declared.**

1. In the value list of `./project/schema.js` (on `main`: lines 736 to 767), delete the eight lines `apiFileSchema,`, `interfaceFileSchema,`, `requestFileSchema,`, `restBodySchema,`, `restRequestFileSchema,`, `grpcApiFileSchema,`, `grpcRequestFileSchema,` and `grpcMethodKindSchema,`. In the type list below it (lines 768 to 784), delete the six lines `ApiFile,`, `InterfaceFile,`, `RequestFile,`, `RestRequestFile,`, `GrpcApiFile,` and `GrpcRequestFile,`. `index.ts` never exported the four WebSocket names, and still does not.
2. Add directly after the block of Step 8:

   ```ts
   // What three core files re-exported until 3.0, from the module that declares it.
   export { soapResponseSubject } from './soap/run.js';
   export { restSubject } from './rest/run.js';
   export { grpcSubject } from './grpc/run.js';
   export type { RequestSnapshot, ResponseSnapshot } from './protocols.js';
   export { applySoapSnapshot, soapRequestSnapshot, soapResponseSnapshot } from './soap/scripting.js';
   export type { SoapRequestSnapshot, SoapResponseSnapshot } from './soap/scripting.js';
   export {
     projectSoapBody,
     qnameFromClark,
     replaceSoapBody,
     soapOperationElements,
     soapScriptTypes,
   } from './soap/script-types.js';
   export { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from './rest/scripting.js';
   export type { RestRequestSnapshot, RestResponseSnapshot } from './rest/scripting.js';
   export { restOperationFor, restScriptTypes } from './rest/script-types.js';
   export { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from './grpc/scripting.js';
   export type { GrpcRequestSnapshot, GrpcResponseSnapshot } from './grpc/scripting.js';
   export { grpcMessageTypes, grpcScriptTypes } from './grpc/script-types.js';
   export { interfaceFileSchema, requestFileSchema } from './soap/files.js';
   export type { InterfaceFile, RequestFile } from './soap/files.js';
   export { apiFileSchema, restBodySchema, restRequestFileSchema } from './rest/files.js';
   export type { ApiFile, RestRequestFile } from './rest/files.js';
   export { grpcApiFileSchema, grpcMethodKindSchema, grpcRequestFileSchema } from './grpc/files.js';
   export type { GrpcApiFile, GrpcRequestFile } from './grpc/files.js';
   ```

   `loadOpenApiDocument` is not in the block: `index.ts` has exported it by name since before this plan (line 506 on `main`; Task 2.2a pointed that line at `./rest/script-types.js`).

**e. The allow-list.** In `scripts/engine-import-graph.mjs`, delete these eight entries from `CORE_EXCEPTIONS`:

```js
  { from: 'run/run.ts', to: 'soap/run.ts', until: 'slice 5: the re-export of soapResponseSubject' },
  { from: 'run/run.ts', to: 'rest/run.ts', until: 'slice 5: the re-export of restSubject' },
  { from: 'run/run.ts', to: 'grpc/run.ts', until: 'slice 5: the re-export of grpcSubject' },
  { from: 'script/index.ts', to: '*', until: 'slice 5: the re-exports of the scripting facets' },
  { from: 'project/schema.ts', to: 'soap/files.ts', until: 'slice 5: the re-exports of the file schemas' },
  { from: 'project/schema.ts', to: 'rest/files.ts', until: 'slice 5: the re-exports of the file schemas' },
  { from: 'project/schema.ts', to: 'grpc/files.ts', until: 'slice 5: the re-exports of the file schemas' },
  { from: 'project/schema.ts', to: 'ws/files.ts', until: 'slice 5: the re-exports of the file schemas' },
```

With the two entries Steps 2 and 3 deleted, no entry's `until` names slice 5 any more. In the JSDoc of `CORE_EXCEPTIONS`, replace the sentence

```js
 * Three kinds, told apart by `until`: the two files that are what they are (`protocols.ts`,
 * `index.ts`); the barrels that keep an old import path working until the public exports change;
 * and the project model, History, the loader and the writer, which hold protocol types until the
 * phases of #184 that split them.
```

with

```js
 * Two kinds, told apart by `until`: the two files that are what they are (`protocols.ts`,
 * `index.ts`); and the project model, History, the loader and the writer, which hold protocol
 * types until the phases of #184 that split them.
```

**f. Check.**

```bash
pnpm check:engine-layers
git grep -nE "from '\.\./(\.\./)?(soap|wsdl|xsd|wss|wsa|validate|rest|webhooks|grpc|ws|asyncapi)/" -- packages/engine/src/script packages/engine/src/run
git grep -n "slice 5" -- scripts/engine-import-graph.mjs packages/engine/src
nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/schema-split.test.ts packages/engine/test/unit/project/schema.test.ts packages/engine/test/unit/run/grpc-subject.test.ts
nice pnpm vitest run --project scripts scripts/engine-layers.test.ts
```

Expected: `pnpm check:engine-layers` exits 0 and prints no `stale exception` and no violation. The first `git grep` prints nothing: `script/` and `run/` import no protocol folder. The second prints nothing: no comment or entry still waits for this slice. The tests pass; `schema-split.test.ts` has the same number of cases as before, four of them under a new title.

- [ ] **Step 10: The complete diff of the export statements this task changes**

`packages/engine/src/index.ts` (context lines as on `main`; the first hunk's new lines are the blocks of Step 8 and of Step 9, d.):

```diff
 export * from './run/index.js';
+
+// Protocol modules, the registry and features (ADR-0017). Exported for the engine's own hosts and
+// tagged `@internal` where they are declared: they are not yet a plugin API.
+export { createFeatureSet } from './protocol/features.js';
+export type { FeatureDescriptor, FeatureSet, WhyDisabled } from './protocol/features.js';
+export { defineProtocol } from './protocol/module.js';
+export type {
+  ContainerBase,
+  ContainerDir,
+  LoadContext,
+  ProtocolModule,
+  ProtocolRun,
+  ProtocolScripting,
+  ProtocolStorage,
+  RequestSnapshotBase,
+  ResponseSnapshotBase,
+  RunGroup,
+  RunScope,
+  ScriptedSend,
+  SelectedBase,
+  SnapshotFacts,
+} from './protocol/module.js';
+export { createProtocolRegistry } from './protocol/registry.js';
+export type { ProtocolRegistry, ProtocolRegistryOptions } from './protocol/registry.js';
+export { BUILTIN_PROTOCOLS, createBuiltinRegistry } from './protocols.js';
+export { extraContainersOf, unsupportedOf } from './project/model.js';
+export type { UnsupportedContainer } from './project/model.js';
+
+// What three core files re-exported until 3.0, from the module that declares it.
+export { soapResponseSubject } from './soap/run.js';
+export { restSubject } from './rest/run.js';
+export { grpcSubject } from './grpc/run.js';
+export type { RequestSnapshot, ResponseSnapshot } from './protocols.js';
+export { applySoapSnapshot, soapRequestSnapshot, soapResponseSnapshot } from './soap/scripting.js';
+export type { SoapRequestSnapshot, SoapResponseSnapshot } from './soap/scripting.js';
+export {
+  projectSoapBody,
+  qnameFromClark,
+  replaceSoapBody,
+  soapOperationElements,
+  soapScriptTypes,
+} from './soap/script-types.js';
+export { applyRestSnapshot, restRequestSnapshot, restResponseSnapshot } from './rest/scripting.js';
+export type { RestRequestSnapshot, RestResponseSnapshot } from './rest/scripting.js';
+export { restOperationFor, restScriptTypes } from './rest/script-types.js';
+export { applyGrpcSnapshot, grpcRequestSnapshot, grpcResponseSnapshot } from './grpc/scripting.js';
+export type { GrpcRequestSnapshot, GrpcResponseSnapshot } from './grpc/scripting.js';
+export { grpcMessageTypes, grpcScriptTypes } from './grpc/script-types.js';
+export { interfaceFileSchema, requestFileSchema } from './soap/files.js';
+export type { InterfaceFile, RequestFile } from './soap/files.js';
+export { apiFileSchema, restBodySchema, restRequestFileSchema } from './rest/files.js';
+export type { ApiFile, RestRequestFile } from './rest/files.js';
+export { grpcApiFileSchema, grpcMethodKindSchema, grpcRequestFileSchema } from './grpc/files.js';
+export type { GrpcApiFile, GrpcRequestFile } from './grpc/files.js';
```

```diff
   ProjectSettings,
   PropertyMap,
-  RequestDef,
   RequestProperties,
   SoapOwnerAuth,
   SoapRequestDef,
```

```diff
 export {
-  apiFileSchema,
-  assertSupportedKind,
   attachmentSourceSchema,
   authConfigSchema,
   definitionAuthSchema,
   definitionCacheManifestSchema,
   environmentFileSchema,
   keyValueEntrySchema,
-  interfaceFileSchema,
   soapOwnerAuthSchema,
   keystoreEntrySchema,
   keystoresFileSchema,
   manifestSchema,
   parseFile,
-  requestFileSchema,
-  restBodySchema,
   apiDefinitionCacheManifestSchema,
   restFolderFileSchema,
-  restRequestFileSchema,
-  grpcApiFileSchema,
-  grpcRequestFileSchema,
-  grpcMethodKindSchema,
   protoDefinitionCacheManifestSchema,
-  apiKindOf,
   hookLinkSchema,
   webhookFolderFileSchema,
   webhooksFileSchema,
   wssIncomingFileSchema,
   wssEntrySchema,
   wssOutgoingFileSchema,
 } from './project/schema.js';
 export type {
   ApiDefinitionCacheDocument,
   ApiDefinitionCacheManifest,
-  ApiFile,
   DefinitionCacheDocument,
   DefinitionCacheManifest,
   EnvironmentFile,
-  InterfaceFile,
   KeyValueEntryFile,
   ManifestFile,
-  RequestFile,
   RestFolderFile,
-  RestRequestFile,
-  GrpcApiFile,
-  GrpcRequestFile,
   ProtoDefinitionCacheManifest,
 } from './project/schema.js';
```

`packages/engine/src/run/index.ts`:

```diff
-export { prepareSend, scopesFor } from './prepare.js';
-export type { PreparedSend, RunContext, RunWorkspace } from './prepare.js';
+export { scopesFor } from './context.js';
+export type { RunContext, RunWorkspace } from './context.js';
```

```diff
-export { mergeScriptValues, scriptAssertions, scriptSession, scriptTypesFor, listedSecrets } from './script-support.js';
+export { mergeScriptValues, scriptAssertions, scriptSession, listedSecrets } from './script-support.js';
```

```diff
   errorOf,
-  grpcSubject,
-  restSubject,
   runRequests,
   scriptReport,
-  soapResponseSubject,
 } from './run.js';
```

`packages/engine/src/script/index.ts`:

```diff
   ScriptPhase,
-  ScriptProtocol,
   ScriptSource,
```

and the file's last block, from the comment `// What lives in the protocol folders since the scripting facet, …` to its end, deleted whole (Step 9, b.).

`packages/engine/src/project/schema.ts`: the eight `export … from '../<protocol>/files.js';` lines deleted (Step 9, c.).

`RequestScriptTypes.soap` is not in this diff: slice 2 turned it into `binding`.

- [ ] **Step 11: Format, type-check, test**

```bash
git diff --name-only -z HEAD | xargs -0 pnpm exec prettier --write --ignore-unknown
pnpm exec prettier --write packages/engine/test/helpers/prepare-for.ts
nice pnpm typecheck
pnpm check:engine-layers
nice pnpm vitest run --project engine-unit --project engine-integration
nice pnpm vitest run --project cli-unit --project cli-integration
nice pnpm vitest run --project desktop
```

Expected: `typecheck` exits 0, and with it every name the desktop and the CLI import from `@wirebench/engine` is still exported (`restBodySchema`, the snapshot types and the three subjects among them). `pnpm check:engine-layers` prints `0 violation(s), 0 stale exception(s)`. Every project passes; the engine-unit count is unchanged (no test was added or deleted in this task).

If `typecheck` reports `Type 'string' is not assignable to type '"soap" | "rest" | "grpc"'` anywhere other than `packages/cli/src/reporters/json.ts`, a slice added a second place that copies `RequestResult.protocol` or `ScriptedRequest.protocol` into a closed union: widen that target to `string` too, and say so in the commit body.

- [ ] **Step 12: Commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages apps scripts/engine-import-graph.mjs
git commit -m "refactor(engine)!: drop what the registry replaces, and export the module API (#184)" -m "prepareSend, PreparedSend, scriptTypesFor, assertSupportedKind, apiKindOf, RequestDef and ScriptProtocol leave the public exports: a run sends through createRunSender, a host asks ProtocolRegistry.status, and a module's own prepare function is internal (its tests reach it through a test helper). RequestResult.protocol is string, as AssertionSubject.protocol and ScriptedRequest.protocol already were, so a protocol the built-in union does not know can be reported. ProtocolModule, the registry, the feature set and UnsupportedContainer are exported, tagged @internal: for the engine's own hosts, not yet a plugin API. The re-exports that kept old import paths working in run/run.ts, script/index.ts and project/schema.ts are gone: index.ts exports those names from the modules that declare them, and the layer check has no temporary exception left."
```

---

### Task 5.3: A guard on the public surface

**Files:**
- Create: `packages/engine/test/unit/public-exports.test.ts`
- Create: `packages/engine/test/unit/public-exports.types.ts`

**Interfaces:**
- Consumes: `packages/engine/src/index.ts` as Tasks 5.1 and 5.2 left it; `createBuiltinRegistry(switches?)`, `BUILTIN_PROTOCOLS` (slice 1).
- Produces: no export. Two files that fail when a 3.0 name goes missing, a 2.x name comes back, or an `@internal` tag is lost.

The repository has no type-test pattern yet (no `expectTypeOf`, no `*.types.ts`, no `*.test-d.ts`). The type half is a plain `.ts` file under `packages/engine/test/`, which `packages/engine/tsconfig.test.json` includes, so `tsc -b` checks it and vitest (which collects `*.test.ts` only) never runs it.

The guard comes after the two tasks it guards, not before: a test that imports names which do not exist yet cannot be committed green, and each of those tasks must end green. Step 3 shows it failing.

- [ ] **Step 1: Write the unit test**

```ts
// packages/engine/test/unit/public-exports.test.ts
/**
 * The public surface of `@wirebench/engine` in 3.0 (spec §8): what was added, what was renamed and
 * what was removed. The type names are guarded by `public-exports.types.ts`, which `tsc -b` checks.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as engine from '../../src/index.js';

const names = new Set(Object.keys(engine));
const valueOf = (name: string): unknown => Reflect.get(engine, name);

const ADDED = [
  'BUILTIN_PROTOCOLS',
  'createBuiltinRegistry',
  'createFeatureSet',
  'createProtocolRegistry',
  'defineProtocol',
  'extraContainersOf',
  'takenContainerSlugs',
  'unsupportedOf',
] as const;

/** 2.x name, 3.0 name. */
const RENAMED: Array<[string, string]> = [
  ['importDefinition', 'importWsdl'],
  ['summarizeOperations', 'summarizeSoapOperations'],
  ['generateRequest', 'generateSoapRequest'],
  ['generateEmptyRequest', 'generateEmptySoapRequest'],
  ['toSendInput', 'toSoapSendInput'],
];

const REMOVED = ['prepareSend', 'assertSupportedKind', 'apiKindOf', 'scriptTypesFor'] as const;

/** A sample of what spec §8 lists as unchanged. */
const UNCHANGED = [
  'sendSoapRequest',
  'sendRest',
  'callGrpc',
  'soapResponseSubject',
  'restSubject',
  'grpcSubject',
  'runRequests',
  'createRunSender',
  'selectRequests',
  'loadProject',
  'saveProject',
  'toRestSendInput',
  'toGrpcSendInput',
] as const;

/** Values three core files re-exported until 3.0; `index.ts` now exports each from the module that declares it. */
const REHOMED = [
  'apiFileSchema',
  'applyGrpcSnapshot',
  'applyRestSnapshot',
  'applySoapSnapshot',
  'grpcApiFileSchema',
  'grpcMessageTypes',
  'grpcMethodKindSchema',
  'grpcRequestFileSchema',
  'grpcRequestSnapshot',
  'grpcResponseSnapshot',
  'grpcScriptTypes',
  'interfaceFileSchema',
  'loadOpenApiDocument',
  'projectSoapBody',
  'qnameFromClark',
  'replaceSoapBody',
  'requestFileSchema',
  'restBodySchema',
  'restOperationFor',
  'restRequestFileSchema',
  'restRequestSnapshot',
  'restResponseSnapshot',
  'restScriptTypes',
  'soapOperationElements',
  'soapRequestSnapshot',
  'soapResponseSnapshot',
  'soapScriptTypes',
] as const;

/** File under `src/`, and the declarations in it that carry `@internal` as their JSDoc's last line. */
const INTERNAL: Readonly<Record<string, readonly string[]>> = {
  'protocol/features.ts': ['FeatureDescriptor', 'WhyDisabled', 'FeatureSet', 'createFeatureSet'],
  'protocol/module.ts': [
    'ContainerDir',
    'ContainerBase',
    'LoadContext',
    'ProtocolStorage',
    'SelectedBase',
    'RunGroup',
    'RunScope',
    'ScriptedSend',
    'ProtocolRun',
    'RequestSnapshotBase',
    'ResponseSnapshotBase',
    'SnapshotFacts',
    'ProtocolScripting',
    'ProtocolModule',
    'defineProtocol',
  ],
  'protocol/registry.ts': ['ProtocolRegistry', 'ProtocolRegistryOptions', 'createProtocolRegistry'],
  'protocols.ts': ['BUILTIN_PROTOCOLS', 'createBuiltinRegistry'],
  'project/model.ts': ['UnsupportedContainer', 'unsupportedOf', 'extraContainersOf', 'takenContainerSlugs'],
};

/** File under `src/`, and the fields in it that carry the tag. */
const INTERNAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'project/model.ts': ['extraContainers', 'unsupported'],
  'assert/model.ts': ['statusNames'],
};

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8').replaceAll('\r\n', '\n');
}

describe('the public exports of 3.0', () => {
  it.each(ADDED)('exports %s', (name) => {
    expect(valueOf(name)).toBeDefined();
  });

  it.each(RENAMED)('exports %s under its 3.0 name only', (before, after) => {
    expect(names.has(before)).toBe(false);
    expect(typeof valueOf(after)).toBe('function');
  });

  it.each(REMOVED)('no longer exports %s', (name) => {
    expect(names.has(name)).toBe(false);
  });

  it.each(UNCHANGED)('still exports %s', (name) => {
    expect(typeof valueOf(name)).toBe('function');
  });

  it.each(REHOMED)('still exports %s, from the module that declares it', (name) => {
    expect(valueOf(name)).toBeDefined();
  });

  it('composes the four built-in protocols, every one enabled', () => {
    expect(engine.BUILTIN_PROTOCOLS.map((module) => module.kind).sort()).toEqual(['grpc', 'rest', 'soap', 'websocket']);
    const registry = engine.createBuiltinRegistry();
    expect(registry.modules.map((module) => module.kind).sort()).toEqual(['grpc', 'rest', 'soap', 'websocket']);
    expect(registry.features.isEnabled('scripts')).toBe(true);
  });

  it('tells an enabled kind from a disabled and an unknown one', () => {
    const registry = engine.createBuiltinRegistry({ grpc: false });
    expect(registry.status('soap')).toBe('enabled');
    expect(registry.status('grpc')).toBe('disabled');
    expect(registry.status('graphql')).toBe('unknown');
  });
});

describe('the module API is tagged @internal', () => {
  for (const [file, declarations] of Object.entries(INTERNAL)) {
    const text = source(file);
    it.each(declarations)(`${file}: %s`, (name) => {
      const tagged = new RegExp(`@internal[^\\n]*\\n \\*/\\nexport (?:interface|type|function|const) ${name}\\b`);
      expect(tagged.test(text)).toBe(true);
    });
  }

  for (const [file, fields] of Object.entries(INTERNAL_FIELDS)) {
    const text = source(file);
    it.each(fields)(`${file}: the field %s`, (name) => {
      const tagged = new RegExp(`@internal[^\\n]*\\n\\s*\\*/\\n\\s*readonly ${name}\\??:`);
      expect(tagged.test(text)).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Write the type-level file**

```ts
// packages/engine/test/unit/public-exports.types.ts
/**
 * The type half of the public-exports guard (spec §8). Nothing runs this file: `tsc -b` checks it
 * through `packages/engine/tsconfig.test.json`. A 3.0 type that goes missing is an error where it
 * is named; a 2.x type that comes back makes its `@ts-expect-error` unused, which is an error too.
 */
import type * as Engine from '../../src/index.js';

/** Every type 3.0 adds. */
export type Added = [
  Engine.ProtocolModule,
  Engine.ProtocolStorage,
  Engine.ProtocolRun,
  Engine.ProtocolScripting,
  Engine.SnapshotFacts,
  Engine.SelectedBase,
  Engine.RunGroup,
  Engine.RunScope,
  Engine.ScriptedSend,
  Engine.ContainerBase,
  Engine.ContainerDir,
  Engine.LoadContext,
  Engine.RequestSnapshotBase,
  Engine.ResponseSnapshotBase,
  Engine.ProtocolRegistry,
  Engine.ProtocolRegistryOptions,
  Engine.FeatureDescriptor,
  Engine.FeatureSet,
  Engine.WhyDisabled,
  Engine.UnsupportedContainer,
];

/** Every type 3.0 renames, under its new name. */
export type Renamed = [
  Engine.WsdlImportSource,
  Engine.WsdlImportOptions,
  Engine.WsdlImportCacheOptions,
  Engine.WsdlImportProgress,
  Engine.WsdlImportProblem,
  Engine.WsdlImportResult,
  Engine.SoapOperationSummary,
  Engine.ToSoapSendInputArgs,
  Engine.SoapSendRequestInput,
  Engine.SoapAttachmentOptions,
];

/** A sample of the types spec §8 lists as unchanged, and every type Task 5.2, Step 9 moved to a direct export. */
export type Unchanged = [
  Engine.SendAuth,
  Engine.AuthSummary,
  Engine.SelectedRequest,
  Engine.SentExchange,
  Engine.SentRequest,
  Engine.RunContext,
  Engine.SoapRequestDef,
  Engine.AttachmentResolvers,
  Engine.RequestSnapshot,
  Engine.ResponseSnapshot,
  Engine.SoapRequestSnapshot,
  Engine.SoapResponseSnapshot,
  Engine.RestRequestSnapshot,
  Engine.RestResponseSnapshot,
  Engine.GrpcRequestSnapshot,
  Engine.GrpcResponseSnapshot,
  Engine.InterfaceFile,
  Engine.RequestFile,
  Engine.ApiFile,
  Engine.RestRequestFile,
  Engine.GrpcApiFile,
  Engine.GrpcRequestFile,
];

/** The fields 3.0 adds exist. */
export type AddedFields = [
  Engine.Project['unsupported'],
  Engine.Project['extraContainers'],
  Engine.AssertionSubject['statusNames'],
  Engine.RequestScriptTypes['binding'],
  Engine.RunContext['registry'],
];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

/** The three `protocol` fields are `string`, not a closed union. */
export type Widened = [
  Expect<Same<Engine.RequestResult['protocol'], string>>,
  Expect<Same<Engine.AssertionSubject['protocol'], string>>,
  Expect<Same<Engine.ScriptedRequest['protocol'], string>>,
];

// @ts-expect-error -- renamed to `WsdlImportSource` in 3.0
export type Gone01 = Engine.ImportSource;
// @ts-expect-error -- renamed to `WsdlImportOptions` in 3.0
export type Gone02 = Engine.ImportOptions;
// @ts-expect-error -- renamed to `WsdlImportCacheOptions` in 3.0
export type Gone03 = Engine.ImportCacheOptions;
// @ts-expect-error -- renamed to `WsdlImportProgress` in 3.0
export type Gone04 = Engine.ImportProgress;
// @ts-expect-error -- renamed to `WsdlImportProblem` in 3.0
export type Gone05 = Engine.ImportProblem;
// @ts-expect-error -- renamed to `WsdlImportResult` in 3.0
export type Gone06 = Engine.ImportResult;
// @ts-expect-error -- renamed to `SoapOperationSummary` in 3.0
export type Gone07 = Engine.OperationSummary;
// @ts-expect-error -- renamed to `ToSoapSendInputArgs` in 3.0
export type Gone08 = Engine.ToSendInputArgs;
// @ts-expect-error -- renamed to `SoapSendRequestInput` in 3.0
export type Gone09 = Engine.SendRequestInput;
// @ts-expect-error -- renamed to `SoapAttachmentOptions` in 3.0
export type Gone10 = Engine.SendAttachmentOptions;
// @ts-expect-error -- removed in 3.0: a module's own prepare function is internal
export type Gone11 = Engine.PreparedSend;
// @ts-expect-error -- removed in 3.0: use `SoapRequestDef`
export type Gone12 = Engine.RequestDef;
// @ts-expect-error -- removed in 3.0: a protocol is a `string`
export type Gone13 = Engine.ScriptProtocol;
// @ts-expect-error -- `RequestScriptTypes.soap` became `binding` in 3.0
export type Gone14 = Engine.RequestScriptTypes['soap'];
```

- [ ] **Step 3: Run both, and see the guard bite**

```bash
pnpm exec prettier --write packages/engine/test/unit/public-exports.test.ts packages/engine/test/unit/public-exports.types.ts
nice pnpm exec tsc -b
nice pnpm vitest run --project engine-unit packages/engine/test/unit/public-exports.test.ts
```

Expected: `tsc -b` exits 0; the test file passes (8 + 5 + 4 + 13 + 27 + 2 cases in the first `describe`, 31 in the second).

Prettier must leave each `// @ts-expect-error` line directly above a one-line `export type`. It does at the repository's 120 columns; if a later edit makes one wrap, shorten the comment, not the type.

Now break one name on purpose: in `packages/engine/src/index.ts`, delete `createFeatureSet` from its export line, and run the two commands again.

Expected: `tsc -b` still exits 0 (the type file names no value); the test fails at `exports createFeatureSet`. Then delete `FeatureSet,` from the type export beside it and run `nice pnpm exec tsc -b`: it fails in `public-exports.types.ts` with `Namespace '…' has no exported member 'FeatureSet'`. Restore the file:

```bash
git checkout -- packages/engine/src/index.ts
```

- [ ] **Step 4: Commit**

```bash
nice pnpm typecheck
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/test/unit/public-exports.test.ts packages/engine/test/unit/public-exports.types.ts
git commit -m "test(engine): a guard on the 3.0 public exports (#184)" -m "A unit test holds the value exports to spec §8: the module API is there and tagged @internal, each renamed function answers to its new name only, and what the registry replaced is gone. A type-level file, checked by tsc -b, does the same for the type names and for the three protocol fields that are now string."
```

---

### Task 5.4: Documentation

**Files:**
- Create: `docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md`
- Modify: `docs/adr/0007-apis-beside-interfaces.md`, `docs/architecture/overview.md`, `packages/engine/README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/cli.md`, `docs/roadmap.md`

**Interfaces:**
- Consumes: the code as Tasks 5.1 to 5.3 left it; the CLI's refusal of an item inside a placeholder and `takenContainerSlugs` in `wirebench import` (Task 3.4, Steps 8 and 10); the exception list of `scripts/engine-import-graph.mjs` as Task 5.2 left it; and the final File Structure of the plan's preamble.
- Produces: no code. `docs/` and `CHANGELOG.md` are in `.prettierignore`; `CONTRIBUTING.md` and `packages/engine/README.md` are not, and go through prettier. `pnpm check:banned-terms` scans all of them. `docs/roadmap.md`'s milestone names are Task 5.5, not this one.

- [ ] **Step 1: `docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md`**

The whole file:

````markdown
# ADR-0017: A protocol is a module behind one interface

- Status: accepted
- Date: 2026-09-30
- Context: issue #184 (phase 1); `docs/specs/2026-09-30-wirebench-protocol-modules-design.md`, built by
  `docs/plans/2026-09-30-wirebench-protocol-modules-plan.md`. Keeps ADR-0002 (the engine runs in main), ADR-0003 (the
  project folder format) and ADR-0007 (APIs beside interfaces), and carries ADR-0016 (a script runs with no
  capabilities) to every protocol.

## Context

ADR-0007 made each protocol a sibling container with its own model, files and editor, and asked every shared layer to
branch on `kind` in one place. Four protocols later, the engine had eleven such places: the run loop, the send
preparation, selection, the secret-needs walk, the loader, the serializer, the writer, and four files of the script
host each held a `switch` over `'soap' | 'rest' | 'grpc' | 'websocket'`. A fifth protocol would have edited all of them
again.

The protocols had also grown into each other. REST imported SOAP's charset code and WebSocket's transcript cap; gRPC,
WebSocket and AsyncAPI imported REST's key-value entries, escaping and `$ref` resolution; the assertion code imported
gRPC's status names. Nothing said which folder was allowed to import which.

And nothing could be switched off. A host could not run without scripts, or without a protocol, and a project that held
a container of a kind the build did not know failed to open at all.

## Decision

**One interface.** A protocol is a `ProtocolModule` (`packages/engine/src/protocol/module.ts`): its `kind`, the feature
that switches it, and up to three facets.

- **Storage** (`ProtocolStorage`) says which directory its containers live in (`interfaces` or `apis`), reads one
  container directory, returns every file a container is written as, lists the files a save may delete, and gets and
  replaces its containers on a `Project`.
- **Run** (`ProtocolRun`) lists the requests a run can send, one group per container; says why a request it holds is
  not runnable; sends one request; produces a request's script types; and names the secrets its configuration needs. A
  module without it cannot be run: WebSocket has none.
- **Scripting** (`ProtocolScripting`) gives the script API's declarations and prelude for a phase, the schema a changed
  request must parse against, and `inspect`, which describes a request snapshot to the rules below. A module without it
  cannot have scripts.

Each module lives in its own folder (`soap/module.ts`, `rest/module.ts`, `grpc/module.ts`, `ws/module.ts`) and is
written against its own types. The registry holds modules with those types erased; `defineProtocol` does the erasing
and guards every call that takes a request with a check of its `kind`.

**A registry and a feature set.** `createProtocolRegistry` takes the modules a host composed and answers, for a kind,
`enabled`, `disabled` or `unknown`. Every protocol is a *feature* with a descriptor (id, title, default, stage, the
features it requires), and `scripts` is a feature that is not a protocol. A feature set is immutable: a host that
changes a switch builds a new registry. `packages/engine/src/protocols.ts` is the composition file, the one place that
imports every built-in module. Every entry point that needs a registry takes one as an option and falls back to the
built-in one, so no caller had to change.

**Two dependency rules**, enforced by `pnpm check:engine-layers` as part of `pnpm check`. The script
(`scripts/engine-import-graph.mjs`) resolves every import of the engine to a file and fails on one that breaks a rule,
and on an exception nothing uses any more. ESLint blocks built from the same lists flag a wrong import in the editor.

1. A protocol's folders import core and themselves, never another protocol's. No exceptions.
2. Core imports no protocol. The exceptions are these files, each with the phase of #184 that removes it:

| Core file | What it imports | Removed in |
| --- | --- | --- |
| `protocols.ts` | every module: it is the composition file | stays; becomes the `engine` package in phase 5 |
| `index.ts` | the public exports | stays |
| `project/model.ts` | the REST, gRPC, WebSocket and webhook container types, type-only; the WS-Addressing model | phase 3 |
| `project/history.ts` | exchange record types, type-only; the caps on a WebSocket transcript, an event stream and a contract check | phase 2 |
| `project/load.ts`, `project/serialize.ts` | REST's request reader and writer for `webhooks/`; the webhook model | phase 3 |
| `project/schema.ts` | the defaults of the WS-Security model | phase 3 |
| `project/request-location.ts`, `secrets/scan/walk.ts`, `secrets/scan/apply.ts` | request types, type-only | phase 3 |
| `import-detect.ts` | format detectors | phase 7 |

The groups are: SOAP (`soap/`, `wsdl/`, `xsd/`, `wss/`, `wsa/`, `validate/`), REST (`rest/`, `webhooks/`), gRPC
(`grpc/`), WebSocket (`ws/`, `asyncapi/`), and core, which is everything else. What two protocols shared moved into
core: header entries, escaping, applying a configured auth, cookies, charsets and the document fetcher into `http/`;
`$ref` resolution, parsing and sampling into `json/schema/`; keystores into `keystore/`.

**The four container lists stay for now.** `Project.interfaces`, `apis`, `grpcApis` and `wsApis` are referenced about
250 times in source and 700 times in tests across the engine, the CLI and the desktop. The storage facet's
`containers` and `withContainers` already hide where a module keeps its containers, so one list would buy the engine
nothing in this phase and would cost a desktop-wide change. The price is the `project/model.ts` exception above.
Phase 3 replaces the lists, together with the desktop's per-kind code. A kind with no list of its own keeps its
containers in `Project.extraContainers`.

**The script rules stay in core.** The rules of ADR-0016 are applied by `script/apply.ts` to every protocol the same
way: the changed request parses against the module's schema and keeps its protocol; its destination keeps its origin;
what the module marks as fixed is unchanged; no header, metadata or single-line value holds CR, LF or NUL; no
`${secret:…}` name appears that was not there before. A module describes its snapshot through `inspect` and does not
implement a rule, so it cannot forget one. A test refuses each rule for each module through `inspect`, so a module that
describes its snapshot wrongly fails.

**`send` is one call.** The run facet has `send`, not a `prepare` followed by a `send`. The three protocols order their
steps differently: gRPC loads its schema before it fetches a token, SOAP expands properties before its script runs, and
REST rebuilds its URL only when the script changed it. Nothing outside a module needs the prepared value, and an
interface with two steps would have had to fix one order for all. Each module keeps its own `prepare…` function for its
own tests; it is not part of the interface and not exported.

**A kind with no enabled module loads as a placeholder.** A container whose kind is unknown, or whose feature is off,
becomes an entry in `Project.unsupported` and a `container-unsupported` problem. Only its container file is read. A
save counts its directory as live and manages none of its files, so nothing in it is rewritten or deleted, and a save
that would write into it is refused with `container-slug-conflict`. A save never deletes what its registry cannot
write: a container the project holds in memory whose kind has no enabled module in the save's registry is left on disk
the same way. Switching the feature back on, or opening the
project in a build that has the module, gives the container back as it was. Using a feature that is off is refused in
the engine with `feature-disabled`, so a host cannot bypass the switch by not showing it.

**The exports are for the engine's own hosts.** `ProtocolModule`, the registry and the feature set are exported from
`@wirebench/engine` and tagged `@internal`. They are not a plugin API: nothing loads third-party code, and the
interface may change in any release. Phase 7 decides what of it is promised.

## Consequences

- Adding a protocol to the engine is one folder and one line in `protocols.ts`. A test-only fifth protocol goes through
  load, select, run with scripts, secret needs and save without a core file knowing it, and that test is what keeps the
  claim true.
- ADR-0007's consequence that every protocol-neutral surface needs a `kind` branch no longer holds for the engine. It
  still holds for the desktop, whose send path, mutations, IPC and editors are per kind until phases 2 and 3.
- The desktop does not send through the modules yet. A switch turned off in code would stop a CLI run and not a desktop
  send. No user-facing switch exists until phase 4, which depends on phase 2, so no user can reach that gap.
- A project written by a later build, holding a kind this build does not know, opens with that container shown as a
  problem and the rest usable. Before, it did not open. A request file of a kind its container's module does not accept
  still refuses the project.
- The engine's public exports broke once, for 3.0.0: the SOAP-era names that read as every protocol's were renamed, and
  what the registry replaces was removed, with no aliases. `packages/engine/README.md` has the tables.
- The modules are stored with their types erased. A request handed to the wrong module is a programming error and
  throws; the compiler does not catch it.
- Core still names the four built-in container types in `project/model.ts`, and still loads webhooks and WS-Security
  configurations itself. The exception table is the list of what is left to cut.

## Alternatives considered

- **A generalised "interface" model**, one container type whose fields mean different things per protocol. Rejected
  for the reason ADR-0007 gave, which stands: a shared container lies about every protocol it holds. The module
  interface is over behaviour (load, run, script), not over the shape of a container.
- **A typed container map through declaration merging**, where each module augments an interface so that
  `project.containers.grpc` is typed. Rejected: the types would depend on which modules a file happens to import, a
  module that is not imported would silently be `never`, and it does not survive the package split, where core must
  compile without any protocol.
- **Splitting the engine into packages first**, and letting package boundaries enforce the rules. Rejected: the import
  cycles had to be cut before any package could be carved out, and cutting them needed the interface. The lint gives
  the same enforcement inside one package, and the split (phase 5) becomes a move of folders.
- **A `prepare` and a `send` on the interface.** Rejected, as above: it fixes one order of steps for protocols that do
  not share one.
- **Refusing a project that holds an unknown or disabled kind**, as the loader did. Rejected: switching a protocol off
  must never make a project unopenable or lose its files, and the same path serves a project from a later build.
````

- [ ] **Step 2: `docs/adr/0007-apis-beside-interfaces.md`**

`CONTRIBUTING.md` asks for an ADR to be updated when what it describes changes. ADR-0007 says an unknown `kind` refuses the file by name, and that every shared layer branches on `kind`.

1. Change the status line (line 3) to:

```markdown
- Status: accepted; updated 2026-09-16 when gRPC landed, and 2026-09-30 by ADR-0017 (see the *Updates* below)
```

2. Append at the end of the file:

```markdown

## Update (2026-09-30): the `kind` branches moved behind an interface

[ADR-0017](0017-a-protocol-is-a-module-behind-one-interface.md) (#184) keeps this ADR's shape — sibling containers,
`kind` on every file, `apis/` beside `interfaces/` — and changes two things it said about the engine:

- **The engine no longer branches on `kind` per layer.** Each protocol is a module behind one interface, and the
  loader, the writer, the run loop and the script host ask a registry for the module. The *Consequences* point about
  a `kind` branch on every protocol-neutral surface now describes the desktop only.
- **An unknown `kind` on a container no longer refuses the project.** The container loads as a placeholder, reported
  as a `container-unsupported` problem, and a save leaves its files untouched. A request file whose `kind` its
  container's module does not accept is still refused by name with `project-kind-not-supported`, as this ADR
  reserved.

The four in-memory lists (`interfaces`, `apis`, `grpcApis`, `wsApis`) stay until the desktop's per-kind code moves.
```

- [ ] **Step 3: `docs/architecture/overview.md`**

1. In the diagram, add one node to the engine subgraph, after the line `    Oa["rest/openapi/<br/>parse · refs · map · sample · cache"]` (line 53):

```
    Mo["protocol/ · protocols.ts<br/>modules · registry · features"]
```

2. Replace two paragraphs with the text below: the paragraph at lines 119 to 130, from `**The \`rest/\` module.** \`packages/engine/src/rest/\` is the REST half of the engine,` to `Nothing else in \`rest/\` is importable from the renderer.`, and the paragraph at lines 132 to 136, from `**Engine.** \`packages/engine\`, \`@wirebench/engine\`.` to `planned \`wirebench run\` CLI unchanged.`. The blank line between them goes too.

```markdown
**Engine.** `packages/engine`, `@wirebench/engine`. Zero Electron, DOM or React imports —
enforced by lint, not convention. Every I/O entry point takes an `AbortSignal`, every export
carries JSDoc, every error is a `WirebenchError` subclass with a stable `code`, and every model
object is `readonly`. It is a library, not a service: the same code runs in the desktop's main
process, in `wirebench run` and in `wirebench mcp`.

**Protocol modules (ADR-0017).** Each protocol is one module behind the `ProtocolModule` interface
(`packages/engine/src/protocol/module.ts`), defined in its own folder: `soap/module.ts`,
`rest/module.ts`, `grpc/module.ts` and `ws/module.ts`. A module has up to three facets. *Storage*
reads and writes its containers in a project folder. *Run* lists the requests a run can send, sends
one, and names the secrets it needs. *Scripting* describes what a script sees of a request and a
response. WebSocket has the storage facet only, so its requests load and save and are not run.
`packages/engine/src/protocols.ts` is the one file that imports every module. It builds the default
*registry*, and the loader, the writer, the run loop, the secret-needs walk and the script host ask
that registry for a module by `kind` where they used to branch on it. The registry also holds the
*features*: one per protocol, plus `scripts`. Using a feature that is off is refused with
`feature-disabled`, and a container whose kind has no enabled module loads as a placeholder
(`Project.unsupported`) whose files a save leaves untouched. Every feature is on, and nothing in
the app or the CLI switches one off yet.

Two rules keep the modules apart, and `pnpm check:engine-layers` (part of `pnpm check`) enforces both: a protocol's folders import core
and themselves, never another protocol's; core imports no protocol, apart from the exceptions
ADR-0017 lists. The protocol folders are `soap/` with `wsdl/`, `xsd/`, `wss/`, `wsa/` and
`validate/`; `rest/` with `rest/openapi/` and `webhooks/`; `grpc/`; and `ws/` with `asyncapi/`.
What they share is core: `http/` (one dispatcher for every protocol, so keystores, TLS trust, the
proxy, timeouts and raw-byte capture are shared code and not a second implementation; applying a
configured auth; header entries; cookies; charsets), `json/schema/` (`$ref` resolution across
documents, memoised per target, and sampling under a node budget, for OpenAPI and AsyncAPI alike),
`keystore/`, `xml/` and `xpath/`. `rest/browser.ts` is the browser-safe subpath
`@wirebench/engine/rest`: the URL helpers the renderer needs so the URL field and the query table
cannot disagree with what is actually sent. Nothing else in `rest/` is importable from the renderer.
```

3. In the "Where things live" table, replace the rows at lines 237 to 241:

```markdown
| Envelope generation, faults, MTOM/SwA, cURL | `packages/engine/src/soap` |
| REST URL, bodies, send, auth, OAuth2, cookies, cURL | `packages/engine/src/rest` |
| OpenAPI parse, `$ref` resolution, mapping, sampling, cache | `packages/engine/src/rest/openapi` |
| HTTP, auth (Basic/NTLMv2), TLS, proxy, timings | `packages/engine/src/http` |
| WS-Security, WS-Addressing | `packages/engine/src/wss`, `packages/engine/src/wsa` |
```

with:

```markdown
| The protocol interface, the registry, features | `packages/engine/src/protocol` |
| The built-in modules composed; the default registry | `packages/engine/src/protocols.ts` |
| WSDL import, sample requests, the SOAP send, envelopes, faults, MTOM/SwA | `packages/engine/src/soap` |
| REST URL, bodies, send, OAuth2, the cookie jar, cURL; webhook items | `packages/engine/src/rest`, `packages/engine/src/webhooks` |
| OpenAPI import, mapping, Update Definition, the definition cache | `packages/engine/src/rest/openapi` |
| gRPC calls, `.proto` sets, server reflection | `packages/engine/src/grpc` |
| WebSocket sessions; AsyncAPI import | `packages/engine/src/ws`, `packages/engine/src/asyncapi` |
| JSON Schema `$ref` resolution, parsing and sampling | `packages/engine/src/json/schema` |
| HTTP, auth (Basic, NTLMv2, applying a configured scheme), header entries, cookies, charsets, TLS, proxy, timings | `packages/engine/src/http` |
| WS-Security, WS-Addressing | `packages/engine/src/wss`, `packages/engine/src/wsa` |
| Keystores (PKCS#12, PEM) | `packages/engine/src/keystore` |
| Selection, the run loop, secret needs | `packages/engine/src/run` |
| The script sandbox, the checker, the rules on a changed request | `packages/engine/src/script` |
```

4. Under "Further reading", add after the ADR-0009 entry (line 270):

```markdown
- [ADR-0017](../adr/0017-a-protocol-is-a-module-behind-one-interface.md) — a protocol is a module
  behind one interface
```

5. Check every path the new text names exists:

```bash
for p in packages/engine/src/protocol/module.ts packages/engine/src/protocols.ts packages/engine/src/soap/module.ts \
  packages/engine/src/rest/module.ts packages/engine/src/grpc/module.ts packages/engine/src/ws/module.ts \
  packages/engine/src/rest/browser.ts packages/engine/src/rest/openapi packages/engine/src/webhooks \
  packages/engine/src/json/schema packages/engine/src/keystore packages/engine/src/http packages/engine/src/run \
  packages/engine/src/script packages/engine/src/asyncapi packages/engine/src/validate; do
  test -e "$p" || echo "MISSING $p"
done
```

Expected: no output. A `MISSING` line means slice 4 named a folder differently from the plan's File Structure: use the real name in the text.

- [ ] **Step 4: `packages/engine/README.md`**

The file today is a title and one paragraph, which says the package "has no stability promise of its own until a 3.0 release". That sentence would now read as a promise 3.0.0 does not make. Replace the whole file with:

````markdown
# @wirebench/engine

`@wirebench/engine` is an internal dependency of [`@wirebench/cli`](https://github.com/wirebench/wirebench/tree/main/packages/cli) and is published so the CLI can depend on a versioned package rather than a workspace link. It has no stability promise of its own: a major release may rename or remove exports, as 3.0 did, and the exports tagged `@internal` may change in any release. See the [Wirebench repository](https://github.com/wirebench/wirebench) for usage, documentation, and issue tracking.

## Migrating to 3.0

3.0 puts every protocol behind one interface ([ADR-0017](https://github.com/wirebench/wirebench/blob/main/docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md)). The main entry's exports changed; nothing was kept as a deprecated alias. The subpaths (`./xml`, `./rest`, `./json`, `./grpc`, `./asyncapi`, `./snapshot`, `./detect`) did not change.

### Renamed

These names read as every protocol's and were WSDL's and SOAP's. Signatures are unchanged.

| 2.x | 3.0 |
| --- | --- |
| `importDefinition` | `importWsdl` |
| `ImportSource` | `WsdlImportSource` |
| `ImportOptions` | `WsdlImportOptions` |
| `ImportCacheOptions` | `WsdlImportCacheOptions` |
| `ImportProgress` | `WsdlImportProgress` |
| `ImportProblem` | `WsdlImportProblem` |
| `ImportResult` | `WsdlImportResult` |
| `summarizeOperations` | `summarizeSoapOperations` |
| `OperationSummary` | `SoapOperationSummary` |
| `generateRequest` | `generateSoapRequest` |
| `generateEmptyRequest` | `generateEmptySoapRequest` |
| `toSendInput` | `toSoapSendInput` |
| `ToSendInputArgs` | `ToSoapSendInputArgs` |
| `SendRequestInput` | `SoapSendRequestInput` |
| `SendAttachmentOptions` | `SoapAttachmentOptions` |

```ts
// 2.x
import { generateRequest, importDefinition } from '@wirebench/engine';
import type { ImportResult } from '@wirebench/engine';

const result: ImportResult = await importDefinition({ kind: 'file', path: 'calculator.wsdl' });
const [operation] = result.operations;
if (operation !== undefined) {
  const sample = generateRequest(result, {
    bindingName: operation.bindingName,
    operationName: operation.operationName,
  });
}
```

```ts
// 3.0
import { generateSoapRequest, importWsdl } from '@wirebench/engine';
import type { WsdlImportResult } from '@wirebench/engine';

const result: WsdlImportResult = await importWsdl({ kind: 'file', path: 'calculator.wsdl' });
const [operation] = result.operations;
if (operation !== undefined) {
  const sample = generateSoapRequest(result, {
    bindingName: operation.bindingName,
    operationName: operation.operationName,
  });
}
```

### Removed

| 2.x | Use instead |
| --- | --- |
| `prepareSend`, `PreparedSend` | `createRunSender`. A module's own prepare function is internal. |
| `assertSupportedKind`, `apiKindOf` | `ProtocolRegistry.status(kind)`, which answers `enabled`, `disabled` or `unknown`. |
| `RequestDef` | `SoapRequestDef`, which it was an alias of. |
| `scriptTypesFor` | The module's `run.scriptTypes`. A run that goes through `createRunSender` or `runRequests` needs neither. |
| `RequestScriptTypes.soap` | `RequestScriptTypes.binding`, an opaque value the module that made it reads back. |
| `ScriptProtocol` | `string`. |

`prepareSend` handed back one of three shapes, and the caller sent it with the matching function. `createRunSender` does both, with the run's caches and the request's scripts:

```ts
// 2.x
import { prepareSend, selectRequests, sendRest } from '@wirebench/engine';

const { selected } = selectRequests(project, ['Orders/List orders']);
for (const item of selected) {
  const prepared = await prepareSend(item, context);
  if (prepared.kind === 'rest') {
    const exchange = await sendRest(prepared.input);
    console.log(item.path, exchange.status);
  }
}
```

```ts
// 3.0
import { createRunSender, selectRequests } from '@wirebench/engine';

const { selected } = selectRequests(project, ['Orders/List orders']);
const send = createRunSender(context);
for (const item of selected) {
  const sent = await send(item);
  console.log(item.path, sent.subject.status);
}
```

`sent.exchange` holds the whole SOAP or REST exchange when a host needs more than the status, and `sendSoapRequest`, `sendRest` and `callGrpc` are still exported for a caller that builds its own input.

### Widened

`RequestResult.protocol`, `AssertionSubject.protocol` and `ScriptedRequest.protocol` were the union `'soap' | 'rest' | 'grpc'` and are now `string`. Code that copies one of them into a closed union needs a check first; a comparison such as `result.protocol === 'grpc'` compiles as before.

### Added

`ProtocolModule` and its facets (`ProtocolStorage`, `ProtocolRun`, `ProtocolScripting`), `defineProtocol`, `ProtocolRegistry`, `createProtocolRegistry`, `createBuiltinRegistry`, `BUILTIN_PROTOCOLS`, `FeatureDescriptor`, `FeatureSet`, `createFeatureSet`, `UnsupportedContainer`, `unsupportedOf`, `Project.unsupported` and `AssertionSubject.statusNames`. They are exported for Wirebench's own hosts and tagged `@internal`: they are not a plugin API, and they may change in any release.

A project can now hold containers the engine did not load: one whose `kind` has no module in the build, or whose protocol is switched off. `loadProject` reports each as a `container-unsupported` problem and lists it in `Project.unsupported`; `saveProject` leaves its files untouched. A host that lists a project's containers should list these too, as not loaded.
````

- [ ] **Step 5: `CONTRIBUTING.md`**

Insert a new section between the end of `## Testing` (its last line is `test touches the network except \`packages/engine/test/interop\`.`, line 82) and `## Commit style` (line 84):

```markdown
## Adding a protocol

A protocol is one module behind the `ProtocolModule` interface
([ADR-0017](docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md)). Adding one to the engine
changes its own folder and one line of `packages/engine/src/protocols.ts`; if a change needs any other
core file to know the protocol's name, the interface is missing something, and that is worth an issue
before the code.

This covers the engine, which is what `wirebench run` uses. The desktop app does not read the registry
yet (issue #184, phases 2 and 3): a new protocol's editor, IPC channels and wire types are separate
work, and until then the app does not show its containers.

The checklist, with `packages/engine/test/helpers/echo-protocol.ts` as the smallest complete example:

1. **A folder**, `packages/engine/src/<name>/`, holding the model and a file per facet. Leave a facet
   out when the protocol has none: no `run.ts` means its requests cannot be run, no `scripting.ts`
   means they cannot have scripts.
   - `files.ts`: the zod schemas of the container file and the request files.
   - `storage.ts`: a `ProtocolStorage`. `load` reads one container directory and pushes problems that
     do not stop the load; `files` returns every file a container is written as, deterministically;
     `managed` lists the files a save may delete. A kind with no list of its own on `Project` keeps
     its containers in `Project.extraContainers[kind]`.
   - `run.ts`: a `ProtocolRun`. `groups` lists what a run can send, in explorer order; `send` prepares,
     runs the scripts it is handed, and sends, in whatever order the protocol needs; `secretNeeds`
     names every secret its auth, keystores and signing read. Cache a contract with `scope.memo`
     under the key `<kind>:<container id>:<what>`.
   - `scripting.ts`: a `ProtocolScripting`. `inspect` describes a request snapshot (its destination,
     what a script may not change, its header pairs, its single-line values, every text in which a
     `${secret:…}` would be expanded). The rules of ADR-0016 are applied in core from that
     description; a module never implements one.
   - `module.ts`: `defineProtocol({ kind, feature, storage, run, scripting })`.
2. **The feature descriptor.** `feature.id` equals `kind`. Give it a `title`, `default`, `stage`
   (`experimental` for a protocol that should ship off) and the features it `requires`.
3. **Register it**: add the module to `BUILTIN_PROTOCOLS` in `packages/engine/src/protocols.ts`, and
   its selection, exchange and snapshot types to the unions declared there. Add what a host needs to
   `packages/engine/src/index.ts`.
4. **The dependency rules.** A protocol's folders import core and themselves, never another
   protocol's; core imports no protocol. Add the new folder to `GROUP_FOLDERS` in
   `scripts/engine-import-graph.mjs`. `pnpm check:engine-layers`, which `pnpm check` runs, fails on an
   import that breaks either rule, and `eslint.config.js` builds a `no-restricted-imports` block per
   group from the same list, so an editor flags it too (`scripts/engine-layers.test.ts` proves both
   bite). If two protocols need the same code, it moves into core (`http/`, `json/`, `xml/`), in its
   own commit.
5. **The tests every module needs:**
   - a round trip: a project holding its containers loads, and saves back byte-identical;
   - the order of `getSecret`, token fetch and contract load inside `send`, pinned as
     `packages/engine/test/unit/run/send-order.test.ts` pins the built-in ones;
   - each of the five script rules refused through its `inspect`, added to
     `packages/engine/test/unit/script/rules-per-protocol.test.ts`;
   - its secret needs, against a request that uses every kind of secret it supports;
   - a project that holds its containers, loaded with the feature switched off: a placeholder and a
     `container-unsupported` problem, a save that leaves the folder byte-identical, and the container
     back when the switch is on again.
6. **Errors** are `WirebenchError` subclasses with a stable `code`; a new code goes in `docs/cli.md`.
7. **Exports** are tagged `@internal` until a plugin API exists. Do not describe the module interface
   as stable in any document.
```

- [ ] **Step 6: `CHANGELOG.md`**

The 3.0.0 entry is today's `## [Unreleased]` section: everything in it ships in 3.0.0, and the heading gets its version and date when the owner tags (`docs/release.md`, "Cutting a release", step 2). This task gives the entry its opening, breaking changes first, and adds one item to `### Added`.

1. Insert directly after the line `## [Unreleased]` (line 7) and its blank line, before `### Added`:

```markdown
This release is 3.0.0. The major version is `@wirebench/engine`'s public exports: the names that
dated from the SOAP-only engine are renamed, and what the new protocol registry replaces is removed,
with no deprecated aliases. Projects, workspaces and the `wirebench` command line are not affected by
that change: a project loads, runs and saves as before. (The project format does move in this
release, to `formatVersion: 6`, for request scripts: see below.)

### Breaking

- **`@wirebench/engine`: SOAP-era names renamed.** `importDefinition` is `importWsdl`; `ImportSource`,
  `ImportOptions`, `ImportCacheOptions`, `ImportProgress`, `ImportProblem` and `ImportResult` gain a
  `Wsdl` prefix (`WsdlImportSource`, …); `summarizeOperations` and `OperationSummary` are
  `summarizeSoapOperations` and `SoapOperationSummary`; `generateRequest` and `generateEmptyRequest`
  are `generateSoapRequest` and `generateEmptySoapRequest`; `toSendInput`, `ToSendInputArgs` and
  `SendRequestInput` are `toSoapSendInput`, `ToSoapSendInputArgs` and `SoapSendRequestInput`;
  `SendAttachmentOptions` is `SoapAttachmentOptions`. Signatures are unchanged.
- **`@wirebench/engine`: exports removed.** `prepareSend` and `PreparedSend` (send through
  `createRunSender`); `assertSupportedKind` and `apiKindOf` (ask `ProtocolRegistry.status`);
  `RequestDef` (it was an alias of `SoapRequestDef`); `scriptTypesFor`; `ScriptProtocol` (it is
  `string`); and `RequestScriptTypes.soap`, which is now the opaque `binding`.
- **`@wirebench/engine`: `protocol` is a `string`.** `RequestResult.protocol`,
  `AssertionSubject.protocol` and `ScriptedRequest.protocol` were the union `'soap' | 'rest' | 'grpc'`.
  The JSON report's `protocol` field is typed the same way; the values a run writes are unchanged.

[`packages/engine/README.md`](packages/engine/README.md#migrating-to-30) has the full tables and a
before and after for the two changes that need more than a rename. The package's subpaths (`./xml`,
`./rest`, `./json`, `./grpc`, `./asyncapi`, `./snapshot`, `./detect`) are unchanged.

```

2. Add as the first bullet under `### Added`, before `- **Agents over MCP, and the same verbs in the terminal.**`:

```markdown
- **Protocol modules in the engine.** SOAP, REST, gRPC and WebSocket each sit behind one interface,
  held in a registry, so the loader, the writer, the run loop and the script host no longer branch on
  the protocol ([ADR-0017](docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md), #184). Two
  things follow for a project. An interface or API of a kind this build does not know no longer stops
  the project from opening: it is reported as a `container-unsupported` problem, the rest of the
  project loads, and a save leaves that container's files exactly as they were. And `wirebench send`
  names such a container, with the reason, where it answered that no request matched. The registry
  also carries feature switches for each protocol and for scripts; every one is on, and nothing in the
  app or the command line turns one off yet. `@wirebench/engine` exports the module interface for
  Wirebench's own use, tagged `@internal`: it is not a plugin API.

```

Nothing else in the file changes. The link list at the end (`[Unreleased]: …compare/v2.2.1...HEAD`) stays as it is until the tag.

- [ ] **Step 7: `docs/cli.md`**

`docs/cli.md` has no table of error codes: its two `| Code | Meaning |` tables (lines 429 and 593) are exit codes, and engine codes are named in prose. Spec §9 asks for the three new codes in "the error table", so this step adds one, in the file's two-dash pipe style, under the exit codes it explains.

1. Insert after the paragraph that ends `that this machine has nothing to authenticate with.` (line 445), before `## Proxy and TLS`:

```markdown

Three codes come from the engine's protocol modules and feature switches
([ADR-0017](adr/0017-a-protocol-is-a-module-behind-one-interface.md)):

| Code | Exit | When |
| --- | --- | --- |
| `feature-disabled` | 3 | A request's protocol is switched off, or scripts are and the request's scripts are switched on. The request is not sent. The error's `details.feature` names the feature, and `details.requires` the feature it depends on when that one is what is off. No flag or variable of `wirebench` switches a feature off yet. |
| `container-unsupported` | none: a warning | An interface or API whose `kind` this build has no enabled protocol for. It is printed at load as `warning: container-unsupported: …`, its folder is left untouched, and its requests cannot be selected. The rest of the project runs. |
| `container-slug-conflict` | 3 | A save would write an interface or API into the folder of a container that was not loaded. Nothing is written. `wirebench import` does not run into it: it names the new folder around every container the project holds, loaded or not, so an import of `Shop` beside a `Shop` that was not loaded is written to `Shop-2`. |
```

2. Replace the sentence at line 409, `\`protocol\` is \`"soap"\`, \`"rest"\` or \`"grpc"\`; for a gRPC request \`status\` is the gRPC status`, with:

```markdown
`protocol` is the request's kind: `"soap"`, `"rest"` or `"grpc"`; for a gRPC request `status` is the gRPC status
```

3. In the `**\`send\`.**` paragraph (lines 487 to 494), replace `them and \`send\` refuses them with \`unsupported-kind\`. Server-sent events` with:

```markdown
them and `send` refuses them with `unsupported-kind`, as it does an item inside a container that was
  not loaded, naming the reason. Server-sent events
```

- [ ] **Step 8: `docs/roadmap.md`, the two plugin lines**

1. Replace the bullet at lines 303 and 304,

```markdown
- **Plugin API.** An idea only, and deliberately after the CLI and MCP surfaces have settled: those two give
  extensibility without committing to an internal API for years.
```

with:

```markdown
- **Plugin API.** Still an idea (#82), and still after the CLI and MCP surfaces have settled: those two give
  extensibility without committing to an internal API for years. Its groundwork has started (#184): in 3.0.0 every
  built-in protocol is a module behind one interface, held in a registry with feature switches
  ([ADR-0017](adr/0017-a-protocol-is-a-module-behind-one-interface.md)). That interface is for the engine's own
  modules and may change in any release. Whether any of it becomes a public plugin API is decided at the end of
  that epic, not before.
```

2. Replace line 434,

```markdown
- **A plugin API before the CLI and MCP surfaces are stable.**
```

with:

```markdown
- **A plugin API before the CLI and MCP surfaces are stable.** The protocol modules of 3.0.0 (#184) are groundwork
  inside the engine, not a plugin API: nothing loads third-party code, and the module interface carries no
  stability promise.
```

- [ ] **Step 9: Check and commit**

```bash
pnpm exec prettier --write CONTRIBUTING.md packages/engine/README.md
pnpm check:banned-terms
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md docs/adr/0007-apis-beside-interfaces.md docs/architecture/overview.md packages/engine/README.md CONTRIBUTING.md CHANGELOG.md docs/cli.md docs/roadmap.md
git commit -m "docs: ADR-0017, the engine's modules in the overview, migrating to 3.0, adding a protocol (#184)"
```

Prettier pads the README's tables to equal column widths; that is its formatting, keep it. `pnpm check:banned-terms` must print no hit: none of the texts above names another product.

---

### Task 5.5: Version numbers and milestones

**Files:**
- Modify: `docs/roadmap.md`
- Modify (the recipes' example pin, Step 4): `README.md`, `action/README.md`, `action/action.yml`, `docs/cli.md`, `docs/release.md`, `docs-site/src/content/docs/guides/run-in-ci.mdx`, `templates/gitlab/wirebench.gitlab-ci.yml`
- GitHub: the repository's milestones

**Interfaces:**
- Consumes: the mapping below, which is the owner's ruling of 2026-09-30 (spec R17, and the plan's preamble).
- Produces: no code.

**This task tags nothing and bumps no `package.json` version.** The release that carries this work is v3.0.0 for the whole product: `release.yml` sets the version of `@wirebench/engine` and `@wirebench/cli` from the tag (`docs/release.md`, "Publishing the CLI: image and npm"), and `apps/desktop/package.json`'s `version` is bumped in the release commit ("Cutting a release", step 1). Both are the owner's. Today's versions stay as they are: `apps/desktop/package.json` 2.2.1; `packages/engine`, `packages/cli`, `packages/server` and `e2e` 2.1.1. The `CHANGELOG.md` heading stays `## [Unreleased]`.

**The milestones today** (`gh api 'repos/wirebench/wirebench/milestones?state=all'`, read 2026-09-30; all six are open):

| Number | Title | Open | Closed |
| --- | --- | --- | --- |
| 1 | `2.2 — Install and learn` | 0 | 6 |
| 2 | `2.3 — Runs in CI, driven by agents` | 3 | 6 |
| 3 | `2.4 — REST and gRPC daily use` | 2 | 13 |
| 4 | `2.5 — Enterprise trust` | 8 | 2 |
| 5 | `3.0 — Contracts, mocks and testing` | 12 | 4 |
| 6 | `Later — demand-driven` | 11 | 1 |

None of the six descriptions names a version number, so only titles change. Issue #184 itself has no milestone.

**Every line of `docs/roadmap.md` that names a milestone by its number:**

| Line | Text |
| --- | --- |
| 82 | `intentions: 3.0 is a major because Sequences and mock stubs are new file kinds, which is the kind of one-way` (the sentence starts on line 81, `The version numbers are`, and ends on line 83, `door 2.0 was.`) |
| 87 | the table row `[2.2 — Install and learn](…/milestone/1)` |
| 88 | the table row `[2.3 — Runs in CI, driven by agents](…/milestone/2)` |
| 89 | the table row `[2.4 — REST and gRPC daily use](…/milestone/3)` |
| 90 | the table row `[2.5 — Enterprise trust](…/milestone/4)` |
| 91 | the table row `[3.0 — Contracts, mocks and testing](…/milestone/5)` |
| 100 | `issue, on purpose. 2.4 ahead of 2.5 is a bet on daily use before the enterprise buyer; nothing in 2.5 waits` |
| 101 | `on 2.4, so the two can swap the day an enterprise evaluation arrives first.` |
| 371 | `- **Server-Sent Events** (milestone 2.4) — **shipped 2026-09-21**; see` (four lines lower once Task 5.4 has rewritten the Plugin API bullet) |
| 378 | `- **WebSocket request kind** (milestone 3.0) — **shipped 2026-09-19**, as the fourth container on the shape` (likewise) |

Not milestone names, and left alone: released versions (lines 51, 54, 59, 60, 110, 191, 306 and 418: `2.0.0`, `2.1.0`, `2.2.0`), other specifications' versions (lines 191 to 194, 230, 310), and the `v1 spec`'s "1.1" of the legend (line 43). The milestone links use the milestone's number, which does not change when its title does. `docs/specs/**` name milestones 2.2 and 2.3 in their headers; they are dated records and stay.

**The mapping** (one row per milestone: number, current title, new title; a row whose title does not change says so):

| Number | Current title | New title |
| --- | --- | --- |
| 1 | `2.2 — Install and learn` | unchanged |
| 2 | `2.3 — Runs in CI, driven by agents` | `3.0 — Runs in CI, driven by agents` |
| 3 | `2.4 — REST and gRPC daily use` | `3.1 — REST and gRPC daily use` |
| 4 | `2.5 — Enterprise trust` | `3.2 — Enterprise trust` |
| 5 | `3.0 — Contracts, mocks and testing` | `4.0 — Contracts, mocks and testing` |
| 6 | `Later — demand-driven` | unchanged |

The short names follow: 2.3 becomes 3.0, 2.4 becomes 3.1, 2.5 becomes 3.2, and the old 3.0 becomes 4.0.

- [ ] **Step 1: Rename the milestones on GitHub**

Read them again first, in case one was renamed or closed since:

```bash
gh api 'repos/wirebench/wirebench/milestones?state=all' --jq '.[] | "\(.number) \(.state) \(.title)"'
```

Expected: the six rows of the table above. Then the four renames, milestone 5 first so that no two milestones are ever both called 3.0:

```bash
gh api -X PATCH repos/wirebench/wirebench/milestones/5 -f title='4.0 — Contracts, mocks and testing'
gh api -X PATCH repos/wirebench/wirebench/milestones/4 -f title='3.2 — Enterprise trust'
gh api -X PATCH repos/wirebench/wirebench/milestones/3 -f title='3.1 — REST and gRPC daily use'
gh api -X PATCH repos/wirebench/wirebench/milestones/2 -f title='3.0 — Runs in CI, driven by agents'
```

Milestones 1 (`2.2 — Install and learn`) and 6 (`Later — demand-driven`) are not renamed. Run the read command again. Expected:

```
1 open 2.2 — Install and learn
2 open 3.0 — Runs in CI, driven by agents
3 open 3.1 — REST and gRPC daily use
4 open 3.2 — Enterprise trust
5 open 4.0 — Contracts, mocks and testing
6 open Later — demand-driven
```

Issues keep their milestone: a rename moves none.

- [ ] **Step 2: `docs/roadmap.md`, the milestone names**

1. In the table, the link text of four rows changes. The URL (`…/milestone/<number>`) and the rest of each row stay. Each pattern below occurs once in the file:

```bash
perl -pi -e 's/\[2\.3 — Runs in CI, driven by agents\]/[3.0 — Runs in CI, driven by agents]/; s/\[2\.4 — REST and gRPC daily use\]/[3.1 — REST and gRPC daily use]/; s/\[2\.5 — Enterprise trust\]/[3.2 — Enterprise trust]/; s/\[3\.0 — Contracts, mocks and testing\]/[4.0 — Contracts, mocks and testing]/' docs/roadmap.md
```

   After it, lines 88 to 91 start:

```markdown
| [3.0 — Runs in CI, driven by agents](https://github.com/wirebench/wirebench/milestone/2) | 3, 4, 5 |
| [3.1 — REST and gRPC daily use](https://github.com/wirebench/wirebench/milestone/3) | 8, 17 (gRPC follow-ups) |
| [3.2 — Enterprise trust](https://github.com/wirebench/wirebench/milestone/4) | 6, 7, 10, fleet management |
| [4.0 — Contracts, mocks and testing](https://github.com/wirebench/wirebench/milestone/5) | 9, 11, 12, 13, 17 (WebSocket), more importers and exporters |
```

   Line 87 (`[2.2 — Install and learn]`) and line 92 (`[Later — demand-driven]`) do not change.

2. Replace lines 100 and 101,

```markdown
issue, on purpose. 2.4 ahead of 2.5 is a bet on daily use before the enterprise buyer; nothing in 2.5 waits
on 2.4, so the two can swap the day an enterprise evaluation arrives first.
```

   with:

```markdown
issue, on purpose. 3.1 ahead of 3.2 is a bet on daily use before the enterprise buyer; nothing in 3.2 waits
on 3.1, so the two can swap the day an enterprise evaluation arrives first.
```

3. Replace the line `- **Server-Sent Events** (milestone 2.4) — **shipped 2026-09-21**; see` (371 on `main`) with:

```markdown
- **Server-Sent Events** (milestone 3.1) — **shipped 2026-09-21**; see
```

4. Replace the line `- **WebSocket request kind** (milestone 3.0) — **shipped 2026-09-19**, as the fourth container on the shape` (378 on `main`) with:

```markdown
- **WebSocket request kind** (milestone 4.0) — **shipped 2026-09-19**, as the fourth container on the shape
```

5. Replace the sentence on lines 81 to 83,

```markdown
it waits for. The milestones carry no dates, for the reason the legend gives. The version numbers are
intentions: 3.0 is a major because Sequences and mock stubs are new file kinds, which is the kind of one-way
door 2.0 was. No issue sits in an earlier milestone than one it is blocked by.
```

with:

```markdown
it waits for. The milestones carry no dates, for the reason the legend gives. The version numbers are
intentions, and they were renumbered on 2026-09-30: 3.0.0 is the release that renames the engine's public
exports (#184, [ADR-0017](adr/0017-a-protocol-is-a-module-behind-one-interface.md)), so the milestone that
held that number moved. 4.0 is a major because mock stubs are a new file kind, which is the kind of one-way
door 2.0 was. No issue sits in an earlier milestone than one it is blocked by.
```

Milestone 5 keeps a major number (4.0), so the reason it is a major stays in the text, under its new number. Sequences, which the old sentence also named, shipped on 2026-09-28 (#62) and are no longer a reason.

- [ ] **Step 3: Check the roadmap**

```bash
grep -n -w -E '2\.3|2\.4|2\.5' docs/roadmap.md
grep -n 'milestone 3\.0\|3\.0 —\|\[3\.0' docs/roadmap.md
grep -c -E '\[3\.1 — |\[3\.2 — |\[4\.0 — |milestone 3\.1\)|milestone 4\.0\)|3\.1 ahead of 3\.2|^on 3\.1,|4\.0 is a major' docs/roadmap.md
```

Expected: the first prints nothing (no retired short name is left; the roadmap names no `2.3.0`). The second prints one line, the table row `[3.0 — Runs in CI, driven by agents]`. The third prints `8`: the three other table rows, the two lines about 3.1 and 3.2, the two milestone mentions, and the sentence about 4.0.

- [ ] **Step 4: The recipes' example pin**

The CI recipes were written when the first publishing release was expected to be 2.3.0, and they pin it: `uses: wirebench/wirebench/action@v2.3.0`, `WIREBENCH_VERSION: '2.3.0'`, `ghcr.io/wirebench/wirebench-cli:2.3.0`, `npx --yes @wirebench/cli@2.3.0`. With this release tagged v3.0.0, no `v2.3.0` tag, image or npm version will exist, and a copied recipe would fail. This is a release number, not a milestone name, so it needs no mapping.

```bash
perl -pi -e 's/2\.3\.0/3.0.0/g' README.md action/README.md action/action.yml docs/cli.md docs/release.md \
  docs-site/src/content/docs/guides/run-in-ci.mdx templates/gitlab/wirebench.gitlab-ci.yml
perl -pi -e 's/`3\.0\.0`, `2\.3`, `latest`/`3.0.0`, `3.0`, `latest`/' docs/release.md
git grep -n '2\.3\.0' -- . ':!pnpm-lock.yaml' ':!docs/specs' ':!docs/plans' ':!THIRD-PARTY-LICENSES.md' ':!**/package.json'
```

Expected from the `grep`: only `scripts/recipes.test.ts` (lines 177 to 194), where `v2.3.0` is test data for parsing an action ref and any version does. It stays. The lines changed are (numbers as on `main`; Task 5.4 moved the ones in `docs/cli.md` down): `README.md:123`; `action/README.md:6` and `:35`; `action/action.yml:48` (a description); `docs/cli.md:678`, `:696`, `:701`, `:718`, `:730`; `docs/release.md:174` and `:175`; `docs-site/src/content/docs/guides/run-in-ci.mdx:24`, `:51`, `:62`, `:67`, `:92`, `:105`, `:122`; `templates/gitlab/wirebench.gitlab-ci.yml:6` and `:11` (comments).

Spec R17 asks for this change with the milestones: "CI recipes that pin `v2.3.0` are changed to `v3.0.0`".

- [ ] **Step 5: Check and commit**

```bash
pnpm exec prettier --write README.md action/README.md action/action.yml docs-site/src/content/docs/guides/run-in-ci.mdx templates/gitlab/wirebench.gitlab-ci.yml
nice pnpm vitest run --project scripts scripts/recipes.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add docs/roadmap.md README.md action/README.md action/action.yml docs/cli.md docs/release.md docs-site/src/content/docs/guides/run-in-ci.mdx templates/gitlab/wirebench.gitlab-ci.yml
git commit -m "docs(roadmap): renumber the milestones now that this release is 3.0.0 (#184)" -m "The engine's renamed exports make the next release a major, so 3.0 is no longer the contracts-and-mocks milestone. The milestones on GitHub carry the same new titles. The CI recipes pin 3.0.0, the first release that publishes the image and the npm packages. Nothing is tagged and no package version moves here: both are the release's."
```

---

### Task 5.6: Final verification, push, pull request

**Files:** none changed. If a check below fails, the fix is its own commit, in the task the failure belongs to.

**Interfaces:**
- Consumes: the branch `feat/protocol-registry` with slices 1 to 5 committed and a clean tree (`git status --short` prints nothing).
- Produces: the pushed branch and one pull request against `main`.

- [ ] **Step 1: The whole gate, then the performance gate unskipped**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
nice pnpm test:perf
```

Expected: both exit 0. `pnpm test:perf` runs the `engine-perf` project, which is four files:

- `packages/engine/test/perf/budgets.test.ts`: the eleven scenarios of `packages/engine/test/bench/budgets.ts` (`calculator-import-generate`, `countryinfo-import-generate`, `large-schema-import-generate`, `send-overhead`, `mtom-package-10mb`, `xpath-evaluate-1mb`, `openapi-import-1mb`, `openapi-samples`, `rest-pretty-5mb`, `rest-send-overhead`, `sse-parse-100k-events`), each a median under `budget × 1.5` locally;
- `packages/engine/test/perf/secret-scan.perf.test.ts`, `rest-contract-check.perf.test.ts` and `asyncapi-frame-check.perf.test.ts`.

Every `[perf] <name>: median …` line must be under its gate, as on `main`. The scenarios reach the renamed functions (`packages/engine/test/bench/scenarios.ts` calls `importWsdl` and `generateSoapRequest` after Task 5.1).

- [ ] **Step 2: Project load and a 50-request run**

Spec §10 asks for no regression in project load and in a 50-request run. **No perf test covers either**: `send-overhead` and `rest-send-overhead` time `sendSoapRequest` and `sendRest` called directly, which never touch the registry, and no scenario calls `loadProject` or `runRequests`. So this step measures both by hand, on this branch and on `main`, with a throwaway script that uses only exports both have. Save it outside the repository, as `"$TMPDIR/wb-load-run.mjs"`:

```js
// Project load and a 50-request run against the built engine. Run from the repository root.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const engine = await import(pathToFileURL(join(process.cwd(), 'packages/engine/dist/index.js')).href);
const { createApi, createProject, createRestRequest, loadProject, runRequests, saveProject, selectRequests } = engine;

const median = (samples) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end('{"ok":true}');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const requests = Array.from({ length: 50 }, (_, index) =>
  createRestRequest(`Request ${index + 1}`, { id: `req-${index}`, order: index, url: `/items/${index}` }),
);
const project = {
  ...createProject('Perf', { id: 'perf' }),
  apis: [createApi('Items', { id: 'api-items', baseUrl: base, requests })],
};
const dir = await mkdtemp(join(tmpdir(), 'wb-perf-'));
try {
  await saveProject(project, dir);
  await loadProject(dir);
  const loads = [];
  for (let i = 0; i < 20; i += 1) {
    const started = performance.now();
    await loadProject(dir);
    loads.push(performance.now() - started);
  }

  const { project: loaded } = await loadProject(dir);
  const { selected } = selectRequests(loaded, []);
  const context = { project: loaded, projectDir: dir, overrides: {}, getSecret: async () => undefined };
  await runRequests(selected, context);
  const runs = [];
  for (let i = 0; i < 5; i += 1) {
    const started = performance.now();
    const result = await runRequests(selected, context);
    runs.push(performance.now() - started);
    if (result.summary.total !== 50 || result.summary.errored !== 0) {
      throw new Error(`unexpected run: ${JSON.stringify(result.summary)}`);
    }
  }
  console.log(`load: median ${median(loads).toFixed(1)} ms · 50-request run: median ${median(runs).toFixed(1)} ms`);
} finally {
  server.close();
  await rm(dir, { recursive: true, force: true });
}
```

Measure this branch, then `main`, then come back (the tree is clean, so a detached checkout loses nothing; no `git stash`):

```bash
nice pnpm --filter @wirebench/engine build && nice node "$TMPDIR/wb-load-run.mjs"
git checkout --detach origin/main
nice pnpm --filter @wirebench/engine build && nice node "$TMPDIR/wb-load-run.mjs"
git checkout feat/protocol-registry
nice pnpm --filter @wirebench/engine build
```

Run each measurement three times and take the middle line. On `main` at 6478e58e this script printed `load: median 6.8 ms · 50-request run: median 18.0 ms` on the machine this plan was drafted on. Expected: the branch's two medians are within 20% of `main`'s on the same machine in the same minute. A larger gap in the load is the loader reading more than the container file for a placeholder, or a registry built per call instead of the memoized `defaultRegistry()`; in the run, a `RunScope.memo` that misses. Fix it in the slice that owns the code, not here. Put both output lines in the pull request.

- [ ] **Step 3: The package**

```bash
nice pnpm pack:check
```

Expected: exit 0, and two `packed …tgz` lines (`pnpm build`, then `scripts/pack-check.ts`; the tarball assertions themselves are `scripts/pack-check.test.ts`, which `pnpm check` ran in Step 1).

The published subpaths still resolve from the build, and the module API is in the built declarations:

```bash
nice node --input-type=module -e "
for (const path of ['index', 'xml/index', 'rest/browser', 'json/cursor', 'grpc/browser', 'asyncapi/browser', 'snapshot/index', 'import-detect']) {
  const module = await import(new URL('packages/engine/dist/' + path + '.js', 'file://' + process.cwd() + '/').href);
  console.log(path, Object.keys(module).length);
}"
grep -c 'createProtocolRegistry' packages/engine/dist/protocol/registry.d.ts
grep -c 'interface ProtocolModule' packages/engine/dist/protocol/module.d.ts
grep -c 'importWsdl' packages/engine/dist/index.d.ts
grep -c -w -E 'importDefinition|prepareSend|assertSupportedKind|apiKindOf|scriptTypesFor' packages/engine/dist/index.d.ts
```

Expected: eight lines, one per file of `publishConfig.exports` in `packages/engine/package.json` (`.`, `./xml`, `./rest`, `./json`, `./grpc`, `./asyncapi`, `./snapshot`, `./detect`), none throwing; on `main` the counts are `index 1000`, `xml/index 3`, `rest/browser 14`, `json/cursor 2`, `grpc/browser 8`, `asyncapi/browser 0`, `snapshot/index 4`, `import-detect 2`, and only `index` may differ. Then `1`, `1`, `1` (or more), and `0`. A `0` for one of the first three `grep`s means `stripInternal` got switched on somewhere: the `@internal` tag must not remove a declaration.

- [ ] **Step 4: The generated script reference is unchanged**

```bash
pnpm docs:script-api --check
git diff --stat main -- docs-site/src/content/docs/reference/script-api.md
```

Expected: `docs-site reference/script-api.md is up to date`, and an empty diff: the page generated from the registry is byte-identical to the one `main` has.

- [ ] **Step 5: Banned terms, and the engine's layers**

```bash
pnpm check:banned-terms
pnpm check:engine-layers
node scripts/engine-import-graph.mjs --json | node -e "const r = JSON.parse(require('node:fs').readFileSync(0, 'utf8')); console.log([...new Set(r.edges.filter((e) => e.fromGroup === 'core').map((e) => e.from))].sort().join('\n'));"
grep -c "slice 5" scripts/engine-import-graph.mjs
```

Expected: no hit from the first. The second prints `engine layers: 0 violation(s), 0 stale exception(s), A allowed import(s) from core` and exits 0 (`pnpm check` ran it in Step 1; it is run here on its own because this slice deleted ten entries of its allow-list). The third prints the core files that still import a protocol, and they are exactly the files ADR-0017's table lists:

```
import-detect.ts
index.ts
project/history.ts
project/load.ts
project/model.ts
project/request-location.ts
project/schema.ts
project/serialize.ts
protocols.ts
secrets/scan/apply.ts
secrets/scan/walk.ts
```

`run/run.ts`, `run/script-support.ts`, `script/index.ts` and `run/prepare.ts` are not among them. The fourth prints `0`: no exception still waits for this slice.

- [ ] **Step 6: No removed or renamed name is left**

```bash
git grep -n -w -E 'prepareSend|PreparedSend|scriptTypesFor|RequestDef|ScriptProtocol|ImportSource|ImportOptions|ImportCacheOptions|ImportProgress|ImportProblem|ImportResult|summarizeOperations|OperationSummary|generateRequest|generateEmptyRequest|toSendInput|ToSendInputArgs|SendRequestInput|SendAttachmentOptions' -- . \
  ':!CHANGELOG.md' ':!packages/engine/README.md' ':!docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md' \
  ':!docs/specs' ':!docs/plans' \
  ':!packages/engine/test/unit/public-exports.test.ts' ':!packages/engine/test/unit/public-exports.types.ts'
```

Expected: no output. The exclusions are the three documents that record the change, the dated specs and plans, and the guard, which names the old names to prove they are gone.

Three names are checked differently, because they still exist as something else:

```bash
git grep -c -w importDefinition -- packages apps scripts e2e docs-site
git grep -n -w -E 'assertSupportedKind|apiKindOf' -- . ':!CHANGELOG.md' ':!packages/engine/README.md' ':!docs/specs' ':!docs/plans' ':!packages/engine/test/unit/public-exports.test.ts'
```

Expected from the first: the nine `apps/desktop` lines of Task 5.1, Step 3, and nothing under `packages/` (the desktop's own method and store action). Expected from the second: `assertSupportedKind` only, in `packages/engine/src/project/schema-parts.ts` (its declaration), `packages/engine/src/project/schema.ts` (the re-export), the modules' `storage.ts` files, `packages/engine/test/unit/project/ws-format.test.ts` and `packages/engine/test/unit/project/schema-split.test.ts` (the internal function the request readers keep); `apiKindOf` nowhere; and no hit in `packages/engine/src/index.ts`, `packages/cli` or `apps`.

- [ ] **Step 7: Push and open the pull request**

```bash
git status --short
git push -u origin feat/protocol-registry
```

Expected: `git status --short` prints nothing before the push.

```bash
gh pr create --base main --head feat/protocol-registry \
  --title "Engine: every protocol is a module behind one interface, with a registry and feature switches (#184, phase 1)" \
  --body "$(cat <<'EOF'
Phase 1 of #184. Design: `docs/specs/2026-09-30-wirebench-protocol-modules-design.md`. Plan: `docs/plans/2026-09-30-wirebench-protocol-modules-plan.md`. Decision record: `docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md`.

## What changed

- **One interface.** SOAP, REST, gRPC and WebSocket are each a `ProtocolModule` in their own folder, with up to three facets: storage (load and save its containers), run (list, send, script types, secret needs) and scripting (what a script sees, described to core's rules). WebSocket has the storage facet only.
- **A registry and features.** `packages/engine/src/protocols.ts` composes the four modules. The loader, the writer, the run loop, the secret-needs walk and the script host ask the registry for a module where they branched on `kind`. Every protocol is a feature, and so is `scripts`; all are on, and no user-facing switch exists yet.
- **Placeholders.** A container whose kind is unknown or switched off loads as an entry in `Project.unsupported` with a `container-unsupported` problem, and a save leaves its files untouched. Before, such a project did not open.
- **Dependency rules.** No protocol folder imports another, and core imports no protocol apart from the exceptions ADR-0017 lists with the phase that removes each. `pnpm check:engine-layers` enforces both as part of `pnpm check`, and ESLint flags a wrong import in the editor. What protocols shared moved into `http/`, `json/schema/` and `keystore/`.
- **The script rules are generic.** ADR-0016's rules are applied by core to every protocol from the module's description of its snapshot.
- **A fifth protocol as the proof.** A test-only `echo` module goes through load, select, run with scripts, secret needs and save without a core file knowing it.
- **CLI.** `wirebench send` names a container that was not loaded, with the reason. Nothing else in the CLI or the desktop changes behaviour.

## Breaking changes

`@wirebench/engine`'s main entry, for 3.0.0. No deprecated aliases. The tables are in `packages/engine/README.md` ("Migrating to 3.0").

- Renamed: `importDefinition` → `importWsdl`; `ImportSource`, `ImportOptions`, `ImportCacheOptions`, `ImportProgress`, `ImportProblem`, `ImportResult` → `WsdlImport…`; `summarizeOperations`, `OperationSummary` → `summarizeSoapOperations`, `SoapOperationSummary`; `generateRequest`, `generateEmptyRequest` → `generateSoapRequest`, `generateEmptySoapRequest`; `toSendInput`, `ToSendInputArgs`, `SendRequestInput` → `toSoapSendInput`, `ToSoapSendInputArgs`, `SoapSendRequestInput`; `SendAttachmentOptions` → `SoapAttachmentOptions`.
- Removed: `prepareSend`, `PreparedSend`, `assertSupportedKind`, `apiKindOf`, `RequestDef`, `scriptTypesFor`, `ScriptProtocol`, `RequestScriptTypes.soap`.
- Widened to `string`: `RequestResult.protocol`, `AssertionSubject.protocol`, `ScriptedRequest.protocol`.
- Added, tagged `@internal`: `ProtocolModule` and its facets, `ProtocolRegistry`, `createProtocolRegistry`, `createBuiltinRegistry`, `BUILTIN_PROTOCOLS`, `FeatureDescriptor`, `FeatureSet`, `createFeatureSet`, `UnsupportedContainer`. Not a plugin API.

The project folder format does not change (`formatVersion` stays 6), and the package's subpaths do not change.

This pull request tags nothing and bumps no package version. The milestones were renumbered, since 3.0 is now this release.

## How it was verified

- `WIREBENCH_SKIP_PERF=1 pnpm check` and `pnpm test:perf`, green on the last commit.
- The existing engine, CLI and desktop suites pass with no expected value changed: a test changed only its imports, a renamed export, or the wording of a script refusal the plan lists.
- New tests: the feature set and the registry; the order of secret reads, token fetches and contract loads in each protocol's send, pinned before any code moved; each script rule refused for each module; placeholders for an unknown kind and for a switched-off one, saved byte-identical; the `echo` protocol end to end; the dependency lint against a fixture; the public exports, values and types.
- `pnpm docs:script-api --check`: the script API reference generated from the registry is byte-identical.
- `pnpm pack:check`, and every published subpath imported from the build.
- Project load and a 50-request run, measured on this branch and on `main` with the same script (no perf test covers either):
  - `main`: <the line the script printed>
  - this branch: <the line the script printed>

## What is next

The later phases of #184, each with its own spec: the desktop's send path and History move onto the modules (phase 2); one container list and the desktop's per-kind code, with the placeholder row in the explorer (phase 3); user-facing feature switches in Settings, the CLI and team policy (phase 4); the engine split into packages (phase 5); import detection opened up and the export surface pruned, with a decision on what, if anything, becomes a plugin API (phase 7). Running a WebSocket request from the command line gets its own issue.
EOF
)"
```

Fill the two `<the line the script printed>` slots from Step 2 before running the command. The body ends with its last section: no generated-by line, no session link, no sign-off.

- [ ] **Step 8: After the pull request is open**

Wait for CI on the pushed head. Do not merge with a red check: fix the failure in the task it belongs to (or confirm it is red on `main` too and port the fix), push, and wait for green. Merging is by hand with `gh pr merge --merge` once green; this repository's `main` is unprotected, so `--auto` would merge at once.

---

## Spec coverage

| Spec | Tasks |
| --- | --- |
| §3 interface, §4 registry and features | 1.1, 1.7 |
| §3.3, §5.3, §5.4 run facet, selection, secret needs | 1.2 to 1.8 |
| §3.4, §5.5 scripting facet and the rules | 2.1, 2.2a, 2.2b, 2.4 |
| §3.5 assertion subject | 2.3, 4.6 |
| §3.2, §5.1, §5.2 storage facet | 3.1, 3.2, 3.3, 3.5 |
| §6 placeholders, R6 | 3.3, 3.4 |
| §7 dependency rules, R10, R11, R13 | 4.1 to 4.9, 5.2 |
| §8 public exports, R14 | 5.1, 5.2, 5.3 |
| §9 errors | 1.1, 3.4, 5.4 |
| §10 testing: the fifth module | 1.8, 2.4, 3.5 |
| §10 testing: pinning tests | 1.2, 2.1 |
| §11 documentation, ADR-0017 | 5.4 |
| R15 load and run measurement, R17 milestones | 5.5, 5.6 |
