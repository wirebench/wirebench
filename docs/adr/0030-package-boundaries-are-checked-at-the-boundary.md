# ADR-0030: package boundaries are checked at the boundary

Date: 2026-10-22 · Status: proposed · Issue #750 (phase 5 of #184) · Spec
`docs/specs/2026-10-22-package-split-phase-5.md`. Carries ADR-0017 (a protocol is a module behind
one interface) from folders to packages and amends its dependency-rule table.

## Context

ADR-0017 drew the seam between the engine's core and its protocols inside one package and fixed
two rules: a protocol's folders import core and themselves, never another protocol's; core
imports no protocol. `scripts/engine-import-graph.mjs` enforces them from `pnpm check`, with a
list of exceptions each tied to the phase of #184 that removes it. It is the only enforcement:
the compiler sees one project, an editor flags nothing, and the exception list is where the
seam leaks.

Three leaks are structural, not oversights. The composition file `protocols.ts` is counted as
core, and nineteen core files reach into it for the built-in registry a caller did not pass, and
five more for the unions of every protocol's selected request, exchange, live event and
snapshot. `RunContext` declares two SOAP-only host hooks. Three core files hold SOAP's endpoint
and attachment types. The collection importers and exporters, which turn one file into several
protocols' containers, import every protocol by design.

The epic's target shape puts core and each protocol in a workspace package of its own, with
`engine` composing them under its npm name. Package boundaries make rule 1 a resolution error: a
protocol that imports another has no `node_modules` entry for it. They do not make rule 2 one:
nothing stops `core` from listing a protocol as a dependency, and nothing stops a relative
`../../protocol-rest/src/…` import from compiling under `tsc -b`, where the whole workspace is one
build.

## Decision

**Three groups, three rules, no exceptions.** The groups are packages: `packages/core` is core;
`packages/protocol-soap`, `protocol-rest`, `protocol-grpc`, `protocol-ws` and `protocol-mcp` are
protocols; `packages/engine` is the composition. A protocol imports core and itself. Core imports
core. The composition imports anything, and nothing imports the composition. There is no exception
list: what needed one has moved to the composition (`index.ts`, `protocols.ts`, `project-files.ts`,
`import-detect.ts`, the exporters, the client importers) or to its protocol (SOAP's endpoint and
attachment resolvers).

**A script checks the boundary, because the compiler checks only half of it.** The gate stays
`pnpm check:engine-layers`, run by `pnpm check` and CI, and checks three things per package:
every relative import resolves inside the package; every bare `@wirebench/*` import, and every
`@wirebench/*` entry in the manifest's `dependencies`, follows the rules; and no file imports
`electron`, `react`, `react-dom` or `@wirebench/desktop`. The last is in the script and not in
`eslint.config.js` because that file names `packages/engine/**` and is protected from edits by a
repository hook, and the owner prefers a script gate for what the config cannot express; a script
also runs the same on every platform CI builds on. There is still no lint rule for the dependency rules; an
editor flags nothing, `pnpm check` does.

**Packages export their files by subpath.** `@wirebench/core/*` and `@wirebench/protocol-*/*` map
`./*` to `src/*.ts` under the `development` condition and `dist/*.js` otherwise. Protocols reach
112 distinct core files and `engine`'s `index.ts` re-exports 313 names from the protocols; a
curated barrel per package would be a public-API design, which is phase 7's, for packages only
`engine` consumes. `@wirebench/engine` keeps its curated `index.ts` and its seven subpaths; that
is the API promised to hosts and npm users, as before.

**Core holds a slot for the default registry; the composition fills it.** `defaultRegistry()`
lives in core, throws `registry-missing` until `installDefaultRegistry` is called, and
`protocols.ts` calls it when loaded. The nineteen fallbacks keep their signatures. ADR-0017 said
the engine keeps no process-wide registry; it keeps one slot, holding the built-in registry with
every feature on, and a host that switches features off still passes its own registry to every
call, as before.

**The unions are open interfaces a module augments.** Core declares `SelectedRequests`,
`SentExchanges`, `LiveEvents`, `RequestSnapshots` and `ResponseSnapshots` as empty interfaces and
each union as the interface's values. A protocol adds its member by module augmentation, written beside the member's own definition
(its `run.ts`, `scripting.ts`, `events.ts`, `model.ts`) so that any program holding the file that
builds a value of it also holds the augmentation, and the composition re-exports one type from each
such file, since a value import leaves no trace in a `.d.ts` and a host compiling against `dist`
would otherwise see an incomplete union. `RunContext`'s SOAP hooks are added the same way by
`soap/run.ts`. Core's own code works on the
erased base types and never reads a union member, so in a compile of core alone the unions are
`never` and nothing notices; in every compile that holds the modules, which is every compile of
`engine` and its hosts, they are the unions `protocols.ts` exported before.

## Consequences

- Rule 1 is now also a resolution error and a compiler error (`rootDir`), rule 2 and rule 3 are
  the script's, and the exception list is gone, so the gate cannot drift: a new import either
  follows the rules or fails `pnpm check`.
- A protocol written against the interface (phase 6) is a package that depends on `core` and
  nothing else, registered in `engine`'s `protocols.ts` and `index.ts` and in the gate's package
  list. No core file names it.
- A host that composes a protocol `@wirebench/engine` does not know must import that protocol's
  package for its union members to appear in `SelectedRequest` and the others; a module it does
  not import is absent from the types and present at runtime. ADR-0017 rejected this trade for
  the container lists, where the desktop narrows everywhere; it is accepted here because the
  unions are read only by hosts, every host compiles every module it composes, and the alternative
  (a type parameter threaded through `RunContext`, `RunResult`, `RequestResult` and the reports,
  or a wrapper per entry point in `engine`) costs every host a changed type to buy nothing.
- The engine's tests stay in `packages/engine/test` and import the packages; a package has no
  tests of its own yet. Moving them is a follow-up, not a condition of this phase.
- The six packages are vendored into `engine` at prepack (the `@wirebench/ssh` route, #460), the
  owner's choice recorded in the spec §6.4: they stay private, `engine` lists their third-party
  dependencies as its own, and `@wirebench/engine` is what hosts install, one tarball as before. A
  host cannot compose its own engine from npm; phase 7 can publish them if it wants that.

## Alternatives considered

- **An ESLint `no-restricted-imports` block per package.** Rejected: the config file is
  protected, the rule cannot read `package.json` dependencies, and it would duplicate what the
  script already resolves exactly, type-only imports and `import()` types included.
- **Only the package graph, no script.** Rejected: it checks rule 1 alone (above).
- **A required registry parameter in core, wrappers in `engine`.** Rejected: nineteen wrappers to
  keep nineteen signatures, for the same runtime behaviour as a slot.
- **Generic result types** (`RequestResult<E>`, `RunContext<S>`). Rejected: every host type
  changes, for unions only hosts read.
- **One package, folders as today, the script as the only wall.** This is the state phases 1 to 4
  left, and it holds while everyone runs `pnpm check`. The epic chose packages so that phase 6 can
  add a protocol without touching the engine's folders, and so that the rules are the shape of
  the repository, not a list in a script.
