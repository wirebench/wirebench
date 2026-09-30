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
  module without it cannot be run. WebSocket's offers no request and only says why one cannot be a sequence step,
  because a run cannot send a WebSocket request yet.
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
and on an exception nothing uses any more. Only this script enforces the rules: there are no lint rules for them, so
an editor does not flag a wrong import, and `pnpm check` (and CI) does.

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
core: header entries, escaping, applying a configured auth, cookies, charsets and the document fetcher into `http/`,
with media types (`http/media-type.ts`), the transcript cap (`http/transcript-cap.ts`), webhook signatures
(`http/webhook-signature.ts`) and the OAuth2 messages (`http/auth/oauth2.ts`); QNames, locating a node, decoding,
entitizing and namespace prefixes into `xml/` (`qname.ts`, `locate.ts`, `decode.ts`, `entitize.ts`, `prefixes.ts`);
status names into `assert/status-names.ts`; `$ref` resolution, parsing and sampling into `json/schema/`; keystores
into `keystore/`.

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
the same way. Switching the feature back on, or opening the project in a build that has the module, gives the
container back as it was. Using a feature that is off is refused in the engine with `feature-disabled`, so a host
cannot bypass the switch by not showing it.

**The exports are for the engine's own hosts.** `ProtocolModule`, the registry and the feature set are exported from
`@wirebench/engine` and tagged `@internal`. They are not a plugin API: nothing loads third-party code, and the
interface may change in any release. Phase 7 decides what of it is promised.

## Consequences

- Adding a protocol to the engine is one folder plus registration edits: the module in `BUILTIN_PROTOCOLS` and its
  types in the `SelectedRequest`, `RequestSnapshot` and `ResponseSnapshot` unions of `protocols.ts`, its exports in
  `index.ts`, and its folder in `GROUP_FOLDERS` in `scripts/engine-import-graph.mjs`. No other core file names it. A
  test-only fifth protocol goes through
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
  cycles had to be cut before any package could be carved out, and cutting them needed the interface. The
  import-graph check gives the same enforcement inside one package, and the split (phase 5) becomes a move of folders.
- **A `prepare` and a `send` on the interface.** Rejected, as above: it fixes one order of steps for protocols that do
  not share one.
- **Refusing a project that holds an unknown or disabled kind**, as the loader did. Rejected: switching a protocol off
  must never make a project unopenable or lose its files, and the same path serves a project from a later build.
