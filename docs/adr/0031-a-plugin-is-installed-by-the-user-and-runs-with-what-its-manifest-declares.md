# ADR-0031: a plugin is installed by the user and runs with what its manifest declares

Date: 2026-10-23 · Status: proposed · Issue #765 (phase 7 of #184, feeds #82) · Spec
`docs/specs/2026-10-23-extension-points-phase-7.md`. Extends ADR-0016 from project code to
installed code, and ADR-0029 to plugins.

## Context

Until now, every line of code Wirebench runs either ships with it or arrives in a project. Project
code is scripts, and ADR-0016 holds them to a sandbox with no capabilities, because a script arrives
with a `git pull`. Phase 7 lets a person add their own importers, report formats and code
generators. That is code nobody at Wirebench wrote or reviewed, and some of it needs more than a
script has: an importer may have to fetch the schemas a document references.

Three routes would hand that code more than its author meant to ask for. A plugin that arrived with
a project would let a repository install code on every machine that opens it. A plugin that opened
its own sockets would skip the proxy, the trusted CAs, redaction and history every other request
goes through. Plugin code in the renderer would need `unsafe-eval` there and could reach every IPC
channel.

## Decision

- **Installed by the user, never by a project.** Plugins are read only from one per-user folder,
  `<userData>/plugins/<id>/`, shared by the desktop and the CLI. They get there only through
  `wirebench plugin install` or Settings → Plugins, each of which shows what the plugin contributes
  and which origins it may reach, and asks first. No file in a project folder, and no server, can
  install, enable or name a plugin into existence. A project that needs a plugin the machine lacks
  fails with `plugin-missing`; it is never rewritten. No environment variable or flag points
  Wirebench at another plugins folder, since a CI job or a project's `.env` could set it; turning
  plugins off (`--no-plugins`) is always allowed.
- **The installed files are the ones that run.** The installer records the SHA-256 of the manifest
  and the code in a lock file outside the plugin folders. The loader reads the code once, hashes
  that buffer and evaluates that buffer. A plugin whose files changed afterwards refuses to load
  until it is installed again.
- **A manifest declares everything.** `wirebench-plugin.json` names the plugin, the plugin API major
  it was written for, each contribution, and the network origins it may reach. Code the manifest
  does not declare is not loaded; a capability it does not declare does not exist in the sandbox.
- **Plugin code runs in the script sandbox.** QuickJS in WebAssembly, on a worker thread, a fresh
  runtime per call, bounded in time and memory, no module loading, no files, no environment, no
  timers, no secrets, no project beyond the input of the call (ADR-0016). Every result is data and
  is validated before use.
- **Network is brokered, and only importers have it.** A reporter is handed run results and a code
  generator a request, and both carry values no mask catches; an origin list limits where data
  goes, not what goes, so neither gets network. An importer's only way out is `net.fetch`, a host
  function. The engine checks the origin of the request and of every redirect it follows itself
  against the manifest, refuses loopback, private and metadata addresses and connects to the
  address it checked, sends through its own dispatcher so proxy and TLS settings apply, attaches
  no credential, cookie or secret, redacts the exchange and records it in history. A plugin that
  lists no origin has no network.
- **UI is declarative.** No plugin code runs in the renderer. The renderer shows what manifests
  declare (titles, extensions, languages, origins), received over IPC.
- **Plugins are feature switches.** A `plugins` switch covers all of them and a `plugin:<id>` switch
  each one. A team policy may list either to turn plugins off in a workspace and, per ADR-0029, can
  never turn one on. A policy naming a plugin the machine does not have restricts nothing.
- **Built-ins are trusted.** The built-in importers, reporters and code generators register through
  the same registry, in process. Built-in detection runs first, so a plugin cannot take a format
  away from its built-in importer, and plugin contribution ids are namespaced so none can shadow a
  built-in.

## Consequences

- What a plugin can do is what its manifest lists: transform the input it is given and, for an
  importer, reach the origins it named through the same network path as every request. Its reach
  is the listed origins; what it can carry there is everything in an import call's input, which is
  the file the person chose to import. Credential-bearing values reach a code generator as
  environment reads, never as text.
- A policy names a plugin by the id the plugin chose, so it cannot block one ahead of its install;
  the `plugins` switch covers that until a hash-based entry exists.
- Plugins cannot be shared through a project or a team workspace. A team that standardises on a
  plugin installs it on each machine; this is deliberate, and the policy switch lets an
  administrator keep plugins out.
- The engine gains one runtime dependency, the asyncify build of the QuickJS release it already uses
  (MIT), because a brokered call must wait on the host. Scripts keep the sync build.
- Plugins load at start-up. Installing, removing or switching one takes effect at the next start.
- The plugin API is versioned apart from the engine (`PLUGIN_API_VERSION`) and its surface is a
  committed report a check compares, so a change to what plugin authors rely on is a reviewed,
  versioned change.
- Anything later that runs installed code, including a protocol plugin in #82, starts from this
  ADR.
