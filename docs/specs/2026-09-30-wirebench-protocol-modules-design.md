# Wirebench: protocol modules and feature switches in the engine — design

Date: 2026-09-30 · Status: draft, awaiting the owner's review · Issue #184 (phase 1 of the epic).
Phases 2 to 7 of #184 get their own specs.

- Builds on:
  - ADR-0002 (the engine runs in main), ADR-0003 (project folder format), ADR-0007 (APIs beside
    interfaces), ADR-0016 (a script runs with no capabilities).
  - The engine's run module (`packages/engine/src/run/`), the project loader and writer
    (`project/load.ts`, `project/serialize.ts`, `project/save.ts`), and the script host (`script/`).
- Decisions recorded here (owner, 2026-09-30):
  - **One spec, a sliced plan.** The interface is designed once against the run loop, the loader and
    the script host together. The plan lands it in five slices (§12).
  - **WebSocket registers but does not run.** It becomes a module for loading and saving. Running a
    WebSocket request from the command line is new behaviour and gets its own issue.
  - **An unknown or disabled kind loads as a placeholder** and its files are never rewritten. The
    engine half is in this phase; the desktop's placeholder row is phase 3.
  - **The engine's public exports break, and the release is v3.0.0.** SOAP-era names are renamed and
    what the registry replaces is removed, with no deprecated aliases. The release pipeline takes the
    npm version from the product tag (`docs/release.md`), so the release that carries this work is
    tagged v3.0.0 for the whole product, and the milestone now called 3.0 is renumbered.

## 1. Goal

Adding a protocol to the engine means writing one module and registering it. No file outside that
module's folder, other than the one composition file, changes.

Today the engine has four protocols and no seam between them and the rest. `run/run.ts`,
`run/prepare.ts`, `run/select.ts`, `run/secret-needs.ts`, `project/load.ts`, `project/serialize.ts`,
`project/save.ts`, `script/apply.ts`, `script/send.ts`, `script/run.ts` and `script/types/api.ts` each
branch on `'soap' | 'rest' | 'grpc' | 'websocket'`. This phase replaces those branches with calls
through one interface, and adds the switch that lets a host turn a protocol or scripting off.

### 1.1 In scope

- A `ProtocolModule` interface with three facets: storage, run and scripting (§3).
- A registry of modules and a feature set of switches, passed to the engine's entry points (§4).
- SOAP, REST, gRPC and WebSocket rewritten as modules. WebSocket has the storage facet only.
- The run loop, the loader, the writer, the script host and the secret-needs walk dispatch through
  the registry (§5).
- A container of an unknown or disabled kind loads as a placeholder and survives a save (§6).
- No protocol folder imports another protocol folder, enforced by lint (§7).
- Public export changes for 3.0.0 (§8).
- ADR-0017 recording the interface and the dependency rules; architecture overview, engine README,
  changelog and migration notes updated.

### 1.2 Not in scope

- **The desktop's send path.** `apps/desktop/src/main/rest-send.ts`, `grpc-send.ts`, `ws-send.ts`
  and `send-with-history.ts` stay as they are; phase 2 moves them onto the module's `send`.
- **The `Project` model's four container lists.** `interfaces`, `apis`, `grpcApis` and `wsApis` stay
  (§3.2 says why). Unifying them is phase 3, with the desktop's per-kind work.
- **History.** `project/history.ts` keeps its entry union. It becomes a module facet in phase 2,
  when its main writer (the desktop) moves.
- **Running WebSocket requests, or streaming gRPC calls.** Both stay not runnable, as today.
- **Any user-facing switch.** No Settings screen, CLI flag, environment variable or team policy;
  those are phase 4. In this phase every feature is on, and only a host's code can turn one off.
- **Import format detection.** `import-detect.ts` keeps its closed union until phase 7.
- **Pruning the export surface.** `index.ts` has 1,712 named exports, of which 891 are referenced by
  no other workspace package. Deciding which of those are library API is phase 7's work, with the
  narrow plugin subpath. This phase renames and removes only what §8 lists.
- **Splitting the engine into packages.** Phase 5.
- **Any change to the project folder format.** `FORMAT_VERSION` does not move.

## 2. Vocabulary

- **Protocol module**: one protocol's whole engine behaviour behind the `ProtocolModule` interface.
- **Facet**: one part of that interface. A module may omit the run facet (WebSocket) or the
  scripting facet.
- **Container**: a SOAP interface or an API; what a project holds one directory of.
- **Registry**: the set of modules a host composed, with its feature set.
- **Feature**: something a host can switch off, named by an id. Every protocol is a feature.
- **Core**: every engine folder that is not a protocol folder (§7.1).

## 3. The `ProtocolModule` interface

New folder `packages/engine/src/protocol/` holds the interface, the registry and the feature set.
It imports no protocol.

```ts
export interface ProtocolModule {
  /** The `kind` written on the container file and on every request file under it. */
  readonly kind: string;
  /** The feature that switches this protocol; its `id` equals `kind`. */
  readonly feature: FeatureDescriptor;
  readonly storage: ProtocolStorage;
  /** Absent: the protocol's requests cannot be run (WebSocket). */
  readonly run?: ProtocolRun;
  /** Absent: the protocol's requests cannot have scripts. */
  readonly scripting?: ProtocolScripting;
}
```

Each module is defined in its own folder (`soap/module.ts`, `rest/module.ts`, `grpc/module.ts`,
`ws/module.ts`) with its concrete types. The registry holds them type-erased; the erasure happens in
one helper in `protocol/` and nowhere else.

### 3.1 What stays typed

The built-in union types stay exported for hosts that narrow on `kind`:

- `SelectedRequest` is the union of the three runnable modules' selection types. Core code uses
  `SelectedBase` (kind, path, group, and the request's id, name, slug, assertions and scripts).
- `SentExchange` stays the union of the SOAP and REST exchanges.
- `RequestSnapshot` and `ResponseSnapshot` stay the union of the three modules' snapshot types.

These unions are declared in the composition file (§4.3), not in core.

### 3.2 The storage facet

```ts
export interface ProtocolStorage<C extends ContainerBase = ContainerBase> {
  /** Where its containers live: `interfaces` (SOAP) or `apis` (every other protocol). */
  readonly dir: ContainerDir;
  /** Reads one container directory. Problems go to `ctx.problems`; undefined skips the container. */
  load(ctx: LoadContext, slug: string, document: unknown): Promise<C | undefined>;
  /** Every file the container is written as: relative path to text. */
  files(container: C): ReadonlyMap<string, string>;
  /** The files under the container's directory a save may delete when they are no longer written. */
  managed(fs: FsLike, root: string, slug: string): Promise<readonly string[]>;
  /** The project's containers of this kind, and the project with them replaced. */
  containers(project: Project): readonly C[];
  withContainers(project: Project, containers: readonly C[]): Project;
}
```

`ContainerBase` is `{ kind, id, name, slug, order }`. Each module's file schemas move out of
`project/schema.ts` into the module's folder, with its half of `load.ts` and `serialize.ts`.

**The four lists stay.** `Project.interfaces`, `apis`, `grpcApis` and `wsApis` are referenced about
250 times in source and 700 times in tests across the engine, the CLI and the desktop. Replacing
them with one list is a desktop-wide change with no engine benefit in this phase, because
`containers` and `withContainers` already hide where a module's containers are kept. The cost is one
named exception to the dependency rules (§7.2): `project/model.ts` imports the four container types.

**Not containers.** Environments, sequences, keystores, WS-Security configurations and the webhook
collection are loaded and saved by core as they are today. The webhook collection is REST requests
in its own tree; it is loaded only when the `rest` feature is on and is otherwise left untouched on
disk. It moves into the REST module in phase 3.

### 3.3 The run facet

```ts
export interface ProtocolRun<S extends SelectedBase = SelectedBase> {
  /** The requests a run can send, in explorer order, one group per container. */
  groups(project: Project): readonly RunGroup<S>[];
  /** For a request id found in this protocol's containers but not runnable: why. */
  whyNotRunnable(project: Project, requestId: string): string | undefined;
  /** Sends one request as a run does: prepare, run its scripts when `scripts` is given, send. */
  send(selected: S, scope: RunScope, scripts?: ScriptedSend): Promise<SentRequest>;
  /** The request's script types, from whatever contract the run has cached for it. */
  scriptTypes(selected: S, scope: RunScope): Promise<RequestScriptTypes>;
  /** The secrets this protocol's configuration needs: auth, keystores, signing, WS-Security. */
  secretNeeds(selected: S, project: Project): readonly SecretNeed[];
}

export interface RunGroup<S> {
  readonly order: number;
  readonly name: string;
  readonly candidates: readonly { readonly item: S; readonly diskPath: string }[];
  /** Sent only when a selector names it, and listed after every container (webhook items). */
  readonly explicitOnly?: true;
}

export interface RunScope {
  readonly context: RunContext;
  /** One value per key for the whole run: a compiled WSDL, a proto set, an OpenAPI document. */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

export interface ScriptedSend {
  readonly session: ScriptSession;
  readonly placeholders: SecretPlaceholders;
}
```

Five methods. `send` is deliberately one call and not `prepare` then `send`: the three protocols
order their steps differently (gRPC loads its schema before it fetches a token; SOAP expands before
its script runs; REST rebuilds its URL only when the script changed it), and nothing outside a
module needs the prepared value. `RunScope.memo` replaces the three per-run caches `run.ts` keeps
today, keyed `<kind>:<container id>:<what>`. A load that rejects is remembered, as the gRPC schema
load is today.

Each module keeps its own `prepare` as a function exported from its folder for its own tests. It is
not part of the interface and not part of the public exports.

`RunContext.defaultWsaActionFor` stays in this phase. It is SOAP's, but the desktop's sequence
runner supplies it from a definition the run's cache may not hold, so removing it would change what
is sent. The SOAP module reads it; phase 2 removes it with the desktop's send path.

### 3.4 The scripting facet

```ts
export interface ProtocolScripting<Q extends RequestSnapshotBase, R extends ResponseSnapshotBase> {
  /** The API's ambient declarations for one phase, and the docs site's reference sections. */
  declarations(phase: ScriptPhase): string;
  reference(): readonly ApiReferenceSection[];
  /** Sandbox-side source that builds `request` and `response` from a snapshot. */
  prelude(phase: ScriptPhase): string;
  /** The shape a pre-request script may hand back. */
  readonly requestSchema: z.ZodType<Q>;
  /** What core's rules check on a snapshot (below). */
  inspect(snapshot: Q): SnapshotFacts;
  /** Protocol-only rules on a changed request, after core's. */
  validate?(before: Q, after: Q): ScriptFailure | undefined;
  /** Adds typed views before the script runs and writes them back after (SOAP's typed body). */
  project?(snapshot: Q | R, types: RequestScriptTypes): Q | R;
  writeBack?(before: Q, after: Q, types: RequestScriptTypes): Q | ScriptFailure;
}

export interface SnapshotFacts {
  /** Where the request goes. A URL keeps its scheme, host and port; anything else stays identical. */
  readonly destination: string;
  /** Values a script may not change at all (a gRPC method, a body it cannot edit). */
  readonly fixed: unknown;
  /** Header or metadata pairs, and other single-line values: none may hold CR, LF or NUL. */
  readonly pairs: readonly HeaderPair[];
  readonly lines: readonly string[];
  /** Every text in which a `${secret:…}` reference would be expanded. */
  readonly texts: readonly string[];
}
```

The rules of ADR-0016 stay in core (`script/apply.ts`) and are applied to every protocol the same
way. A module describes its snapshot with `inspect`; it does not implement the rules, so it cannot
forget one:

1. the returned value parses against `requestSchema` and has the same `protocol`;
2. `destination` keeps its origin (`script-origin-change`);
3. `fixed` is deep-equal before and after (`script-error`);
4. no entry of `pairs` or `lines` holds CR, LF or NUL (`script-value-invalid`);
5. no `${secret:…}` name appears in `texts` that was not there before (`script-secret-denied`).

Every refusal keeps its current code. A message may change wording where it named a protocol's
field; the plan lists each one a test pins.

The snapshot types, their converters (`script/send.ts`), the API declarations (`script/types/api.ts`),
the generated contract types (`script/types/rest.ts`, `grpc.ts`, `xsd.ts`, `script/contracts.ts`) and
each protocol's part of the prelude move into the protocol's folder and stay exported under their
current names. `script/` keeps the sandbox, the type checker host, the common API, the rules,
`RequestScripting` and `scriptSession`. `RequestScriptTypes.soap` becomes an opaque `binding` that
the module which produced it reads back.

### 3.5 The assertion subject

`AssertionSubject` is already protocol-neutral, with two leaks: `assert/status.ts` imports gRPC's
status names, and `protocol` is a closed union.

- `protocol` becomes `string`.
- The subject gains `statusNames?: { readonly byName: ReadonlyMap<string, number>; nameOf(code:
  number): string }`. With it, a status assertion accepts names and compares codes exactly, as it
  does for gRPC today; without it, the HTTP rules apply. gRPC's module supplies it when it builds
  its subject. `assert/` imports no protocol.
- `fault` and `validateContract` stay as they are: optional capabilities a module's subject may
  carry.

## 4. Registry and features

### 4.1 Features

```ts
export interface FeatureDescriptor {
  readonly id: string;
  readonly title: string;
  readonly default: boolean;
  readonly stage: 'stable' | 'experimental';
  /** Features that must be on for this one to be on. */
  readonly requires: readonly string[];
}

export type WhyDisabled =
  | { readonly by: 'switch' }
  | { readonly by: 'requires'; readonly feature: string };

export interface FeatureSet {
  readonly descriptors: readonly FeatureDescriptor[];
  isEnabled(id: string): boolean;
  /** Undefined when on. Otherwise: switched off itself, or off because a required feature is. */
  whyDisabled(id: string): WhyDisabled | undefined;
}

export function createFeatureSet(
  descriptors: readonly FeatureDescriptor[],
  switches?: Readonly<Record<string, boolean>>,
): FeatureSet;
```

- A feature is on when its switch says so, or its `default` when there is no switch, and every
  feature it `requires` is on.
- An id with no descriptor is off. A switch for an id with no descriptor is ignored: it may belong
  to a module this build does not have.
- A duplicate id or a `requires` cycle throws when the set is created. Both are programming errors.
- A feature set is immutable. A host that changes a switch creates a new set and a new registry.

Features in this phase, all `default: true` and `stage: 'stable'`: `soap`, `rest`, `grpc`,
`websocket`, and `scripts`. Others get a descriptor when they get an enforcement point (phase 4).

### 4.2 The registry

```ts
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

export interface ProtocolRegistryOptions {
  /** Descriptors for features that are not protocols (`scripts`). */
  readonly features?: readonly FeatureDescriptor[];
  readonly switches?: Readonly<Record<string, boolean>>;
}

export function createProtocolRegistry(
  modules: readonly ProtocolModule[],
  options?: ProtocolRegistryOptions,
): ProtocolRegistry;
```

The registry builds its feature set from the modules' descriptors plus `options.features`. Two
modules with one `kind` throw.

### 4.3 The composition file and the default

`packages/engine/src/protocols.ts` is the one file that imports every built-in module. It exports:

- `BUILTIN_PROTOCOLS`, the four modules;
- `createBuiltinRegistry(switches?)`;
- the built-in union types of §3.1.

Every entry point that needs a registry takes it as an option and falls back to
`createBuiltinRegistry()` with no switches:

| Entry point | Where the registry goes |
| --- | --- |
| `loadProject`, `saveProject`, `projectFiles` | `options.registry` |
| `selectRequests`, `findStepRequest`, `secretNeedsOf` | a trailing `registry` parameter |
| `runRequests`, `createRunSender`, `checkRunScripts`, `runSequence` | `RunContext.registry` |

The fallback is what keeps the engine's existing callers and tests unchanged. When the engine is
split into packages (phase 5), the fallback moves to the composing package and core's parameter
becomes required.

## 5. How core uses the registry

### 5.1 Load

For each directory under `interfaces/` and `apis/`, the loader reads the container file, takes its
`kind` (absent means `soap` under `interfaces/` and `rest` under `apis/`, as today), and asks the
registry:

- `enabled`, and the module's `storage.dir` is this directory: `storage.load`.
- anything else: a placeholder (§6).

Containers are then attached to the project with each module's `withContainers`. Slug collisions
between `interfaces/` and `apis/` are reported as they are today.

### 5.2 Save

`projectFiles` is the union of core's own files and every enabled module's `storage.files` for each
of its containers. `saveProject` lists managed files with `storage.managed`, and its set of live
container directories is every module's containers plus every placeholder (§6).

### 5.3 Select and run

`selectRequests` collects `run.groups(project)` from every enabled module with a run facet, orders
the groups by `(order, name)` with `explicitOnly` groups last, and matches selectors as today.
`findStepRequest` looks among the candidates, then asks each module's `whyNotRunnable`.

`createRunSender` becomes: find the module, then

1. if the request has active scripts: refuse when `scripts` is off (`feature-disabled`) or the run
   has no script host (`script-unavailable`); type-check with `run.scriptTypes`; create the session
   and placeholders; call `run.send(item, scope, { session, placeholders })`;
2. otherwise call `run.send(item, scope)` and mark `scriptsOff` when the request has scripts that
   are switched off on the request itself.

`runRequests`, `runOne`, callback waits, assertion evaluation and reporting do not change.
`RequestResult.protocol` becomes `string`.

### 5.4 Secret needs

`secretNeedsOf` keeps the generic part (every `${secret:…}` in the request's own text, and the
secrets its scripts list) and adds `run.secretNeeds(selected, project)`. `keystoreNeeds` stays a core
helper the modules call, since keystores are shared by all three.

### 5.5 Scripts

`runScript`, `applyRequestChanges`, `buildPrelude`, `scriptDeclarations` and `apiReference` take the
module's scripting facet where they took a protocol name. The docs site's script API reference
(`pnpm docs:script-api`) is generated from the registry and must come out byte-identical.

## 6. Unknown and disabled kinds

```ts
export interface UnsupportedContainer {
  readonly dir: ContainerDir;
  readonly slug: string;
  /** As written in the container file. */
  readonly kind: string;
  readonly reason: 'unknown-kind' | 'feature-disabled';
  /** Read from the container file when present, for a placeholder row. */
  readonly name?: string;
  readonly order?: number;
}

export interface Project {
  // …
  readonly unsupported: readonly UnsupportedContainer[];
}
```

- **Load.** A container whose kind has no enabled module in that directory becomes an
  `UnsupportedContainer` and a `container-unsupported` problem naming the kind and the reason. The
  rest of the project loads. Nothing under the container's directory is read beyond its container
  file. A kind found in the wrong directory (`kind: soap` under `apis/`) is `unknown-kind`.
- **Save.** A placeholder's directory counts as live, so it is not removed. None of its files are
  managed, so none is deleted or rewritten. Nothing is written into it.
- **Slugs.** A save refuses with `ProjectError` `container-slug-conflict` when a live container has
  the slug of a placeholder in the same directory. The engine's slug helper takes placeholders into
  account, so a host that uses it never reaches the refusal.
- **Run.** A placeholder has no candidates. A selector that covers only placeholders is unmatched,
  as a WebSocket API is today. A sequence step whose request lives in a placeholder is `missing`:
  the engine does not read a placeholder's request files, so it cannot tell.
- **Request files.** A request file whose `kind` its container's module does not accept still
  refuses the project with `project-kind-not-supported`, as today.
- **Re-enabling** a feature and loading again gives the container back exactly as it was.

This replaces `assertSupportedKind` at the container level. A project written by a later build
opens in an earlier one with its unknown containers shown as problems, where today it fails to open.

`createProject` sets `unsupported: []`. The desktop does not show placeholders in this phase; the
field rides through its mutations because they spread the project.

## 7. Dependency rules

### 7.1 Which folder is what

| Group | Folders and root files |
| --- | --- |
| soap | `soap/`, `wsdl/`, `xsd/`, `wss/`, `wsa/`, `validate/`, and the root `import.ts`, `send.ts`, `generate.ts`, `operations.ts`, `types.ts` moved under `soap/` |
| rest | `rest/`, `webhooks/` |
| grpc | `grpc/` |
| ws | `ws/`, `asyncapi/` |
| core | everything else |

`send-options.ts` is split three ways: `toSendInput` to `soap/`, `toRestSendInput` to `rest/`,
`toGrpcSendInput` to `grpc/`.

### 7.2 The rules

1. **A protocol group imports core and itself, never another group.** Enforced with zero
   exceptions.
2. **Core imports no protocol group.** Enforced, with the exceptions below. Each names the phase
   that removes it.

| Core file | What it imports | Removed in |
| --- | --- | --- |
| `protocols.ts` | every module (the composition file) | stays; becomes the `engine` package |
| `index.ts` | the public exports | stays |
| `project/model.ts` | the four container types, type-only | phase 3 |
| `project/history.ts` | exchange record types, type-only | phase 2 |
| `project/load.ts`, `serialize.ts`, `save.ts` | REST's request reader and writer for `webhooks/`; WS-Security configurations | phase 3 |
| `import-detect.ts` | format detectors | phase 7 |

The lint is an ESLint `no-restricted-imports` block per group, in `eslint.config.js` beside the
existing engine rules, so `pnpm check` fails on a violation.

### 7.3 What moves into core

These are today's cross-group imports, all of them:

| Importer | Imports today | Becomes |
| --- | --- | --- |
| `grpc/`, `ws/`, `asyncapi/`, `script/` | `KeyValueEntry`, `entry` from `rest/model.ts` | `http/entries.ts` |
| `grpc/`, `ws/` | `escapeForLanguage` from `rest/body.ts` | `http/escape.ts` |
| `ws/`, `soap/`, `http/` | `applyAuth` from `rest/auth.ts` | `http/auth/apply.ts` |
| `sequence/` | `parseSetCookie` from `rest/response.ts` | `http/cookies.ts` |
| `rest/` | `decodeBody`, `encodeBody` from `soap/charset.ts`; `mediaTypeOf` from `soap/mime/multipart.ts` | `http/charset.ts`, `http/media-type.ts` |
| `rest/` | `capByEnds`, `CapLimits` and the history caps from `ws/transcript.ts` | `http/transcript-cap.ts` |
| `asyncapi/` | `$ref` resolution, parsing and sampling from `rest/openapi/` | `json/schema/`; the OpenAPI-only part stays in `rest/` |
| `asyncapi/`, `http/` | `FetchDocument`, `FetchedDocument`, `createDefaultFetchDocument` from `wsdl/` | `http/fetch-document.ts` |
| `http/` | `decodeXmlBytes` from `wsdl/fetch.ts` | `xml/` |
| `http/` | `soapActionHeaders` from `soap/soap-action.ts` | the SOAP send passes its headers in |
| `assert/` | `GRPC_STATUS_NAMES`, `grpcStatusName` from `grpc/status.ts` | `AssertionSubject.statusNames` (§3.5) |
| root `types.ts` | `SendAuth`, `AuthSummary` | `http/auth/send-auth.ts` |

Files move with `git mv` and keep their content; only import paths change. Where a file holds both
a shared and a protocol-only part, the plan splits it in its own commit.

## 8. Public exports in 3.0.0

`@wirebench/engine`'s subpaths (`./xml`, `./rest`, `./json`, `./grpc`, `./asyncapi`, `./snapshot`,
`./detect`) do not change. From the main entry:

**Renamed**, because the name says "every protocol" and the thing is SOAP's:

| 2.x | 3.0 |
| --- | --- |
| `importDefinition` | `importWsdl` |
| `ImportSource`, `ImportOptions`, `ImportCacheOptions`, `ImportProgress`, `ImportProblem`, `ImportResult` | `WsdlImportSource`, `WsdlImportOptions`, `WsdlImportCacheOptions`, `WsdlImportProgress`, `WsdlImportProblem`, `WsdlImportResult` |
| `summarizeOperations`, `OperationSummary` | `summarizeSoapOperations`, `SoapOperationSummary` |
| `generateRequest`, `generateEmptyRequest` | `generateSoapRequest`, `generateEmptySoapRequest` |
| `toSendInput`, `ToSendInputArgs`, `SendRequestInput` | `toSoapSendInput`, `ToSoapSendInputArgs`, `SoapSendRequestInput` |
| `SendAttachmentOptions` | `SoapAttachmentOptions` |

**Removed**, because the registry replaces them:

| 2.x | Use instead |
| --- | --- |
| `prepareSend`, `PreparedSend` | `createRunSender`; a module's own `prepare` is internal |
| `assertSupportedKind`, `apiKindOf` | `ProtocolRegistry.status` |
| `RequestDef` (an alias of `SoapRequestDef`) | `SoapRequestDef` |
| `scriptTypesFor` | the module's `run.scriptTypes` |
| `RequestScriptTypes.soap`, `ScriptRunInput.soap` | `RequestScriptTypes.binding` |
| `ScriptProtocol` | `string` |

**Widened** from a closed union to `string`: `RequestResult.protocol`, `AssertionSubject.protocol`,
`ScriptedRequest.protocol`.

**Added**: `ProtocolModule`, `ProtocolStorage`, `ProtocolRun`, `ProtocolScripting`, `SnapshotFacts`,
`SelectedBase`, `RunGroup`, `RunScope`, `ProtocolRegistry`, `createProtocolRegistry`,
`createBuiltinRegistry`, `BUILTIN_PROTOCOLS`, `FeatureDescriptor`, `FeatureSet`, `createFeatureSet`,
`UnsupportedContainer`, `Project.unsupported`, `AssertionSubject.statusNames`. These are exported
for the engine's own hosts and marked `@internal` in JSDoc: they are not yet a plugin API, and
phase 7 decides what of them is promised.

**Unchanged**: `SendAuth`, `AuthSummary`, `sendSoapRequest`, `sendRest`, `callGrpc`,
`soapResponseSubject`, `restSubject`, `grpcSubject`, `SelectedRequest`, `SentExchange`,
`SentRequest`, `RunContext` (it gains `registry`), `runRequests`, `createRunSender`,
`selectRequests`, `loadProject`, `saveProject`, and everything not listed above.

The CLI and the desktop are updated for the renames in the same change. Neither changes behaviour,
with one exception: the CLI's "not selectable" message (`packages/cli/src/ops/items.ts`) also names
placeholders, with the reason.

The engine README gets a "Migrating to 3.0" section with the two tables. The changelog's 3.0.0
entry opens with the breaking changes. The milestone named "3.0 — Contracts, mocks and testing" and
the roadmap's version numbers are renumbered in the pull request of slice 5. That pull request tags
nothing; the tag is the owner's.

## 9. Errors

| Code | Class | When |
| --- | --- | --- |
| `feature-disabled` (new) | `WirebenchError` | `registry.require` on a disabled kind; a request with active scripts when `scripts` is off. `details`: `feature`, and `requires` when a required feature is what is off |
| `container-unsupported` (new) | a load problem, not thrown | a placeholder was made; `details`: `kind`, `reason`, `dir`, `slug` |
| `container-slug-conflict` (new) | `ProjectError` | a save would write into a placeholder's directory |
| `project-kind-not-supported` | `ProjectError` | unchanged for request files; `registry.require` on an unknown kind |

Every other code is unchanged. `docs/cli.md`'s error table gains the three new rows.

## 10. Testing

The refactor is behaviour-preserving, so the existing suites are the main check: 256 engine unit
files, 36 engine integration files and the CLI's suites must pass with no change to an expected
value. A test may change only its imports, a renamed export, or the wording of a script refusal
message the plan lists.

New tests:

- **Feature set**: defaults, a switch, `requires` on and off, an unknown id, a switch for an unknown
  id, a duplicate id, a cycle.
- **Registry**: `status`, `find` and `require` for enabled, disabled and unknown; duplicate kind.
- **A fifth module.** A test-only `echo` protocol in `packages/engine/test/helpers/` with all three
  facets, registered beside the built-ins. One integration test loads a project holding an `echo`
  API, selects it, runs it with a pre-request and a post-response script, reads its secret needs and
  saves it back byte-identical. This is the proof that no core file needs to know a protocol; it
  touches nothing outside its helper and the registry.
- **Placeholders**: a project with an unknown kind and one with `grpc` switched off each load with
  the problem, save with those directories byte-identical, refuse a slug conflict, and load fully
  once the module or the switch is back.
- **Scripts off**: a request with active scripts errors with `feature-disabled` and is not sent; a
  request whose own scripts are switched off is sent.
- **Script rules per module**: each of the five rules of §3.4 refused for each of the three
  scripting modules, through `inspect`, so a module that misdescribes its snapshot fails a test.
- **Script API reference**: the generated reference equals the committed one.
- **Dependency lint**: a fixture file with a cross-group import fails the rule.

`pnpm test:perf` must show no regression in project load and in a 50-request run; the registry adds
one map lookup per request.

## 11. Documentation

- **ADR-0017: a protocol is a module behind one interface.** The interface, the two dependency
  rules with their exceptions, and why the four lists stay for now.
- `docs/architecture/overview.md`: the engine section describes modules, the registry and features;
  the `rest/` paragraph is folded into it.
- `packages/engine/README.md`: migration section.
- `CONTRIBUTING.md`: a new "Adding a protocol" section, as the module checklist.
- `CHANGELOG.md`, `docs/cli.md` error table, `docs/roadmap.md` version numbers.

## 12. Slices

Each slice is one or more commits that leave `WIREBENCH_SKIP_PERF=1 pnpm check` green. Slices 1 to 4
remove or rename no public export, so the branch can be reviewed slice by slice.

1. **Registry, features and the run facet.** `protocol/`, `protocols.ts`, the three run modules,
   `run/` dispatching through them, secret needs, the `echo` module's run half.
2. **The scripting facet.** Snapshot types, converters, declarations, prelude and generated types
   move into the modules; the rules become generic; the `scripts` feature is enforced.
3. **The storage facet and placeholders.** Schemas, load and serialize halves move into the modules;
   WebSocket's module; `Project.unsupported`; save keeps placeholders.
4. **Cutting cross-group imports.** The moves of §7.3, then the lint.
5. **Public exports, documentation and the ADR.** §8 and §11, with the CLI and desktop updated.

## 13. Risks

- **A behaviour change hidden in a move.** The order of steps inside each protocol's send is subtle
  (when a token is fetched, when a schema is loaded, what a refused token does). Each module's
  `send` is assembled from the existing functions without reordering, and slice 1 adds a test per
  protocol pinning the order of `getSecret`, token fetch and schema load calls before any code
  moves.
- **Type erasure at the registry.** A module is written against its own types and stored erased. A
  wrong pairing of module and item is a programming error, and the erasing helper guards it with a
  `kind` check that throws.
- **The script rules.** They are security rules (ADR-0016), and making them generic must not weaken
  one. The per-module rule tests of §10 are written first and must pass against the current code
  before it is changed.
- **Desktop drift.** Until phase 2 the desktop still sends through its own path, so a switch turned
  off in code would not stop a desktop send. No host can turn one off through any user-facing means
  until phase 4, which depends on phase 2.
