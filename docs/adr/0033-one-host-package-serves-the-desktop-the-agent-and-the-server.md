# ADR-0033: one host package serves the desktop, the agent and the server

Date: 2026-10-24 · Status: accepted 2026-10-27, built in #779 and #780 (design
`docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.1, §5.1, §5.2) · Issue: #776, slice 1 #777

## Context

The desktop renderer is a browser application already: it imports nothing from Electron or Node, and it
reaches the main process only through `window.wirebench`, which the preload builds from the channel
registry given an injected `invoke` and `on`. The main process, about 65 000 lines, is where every
service lives, and 37 of its 269 files import `electron` directly for paths, dialogs, the shell,
`safeStorage`, the theme and window lookups. Handlers are bound to `ipcMain.handle` with a `WebContents`
as the caller.

A browser client needs the same handlers reachable over a socket, from two places: a local agent on the
person's machine (private targets, SSH, keychains, files) and the server (nothing to install). Writing a
second implementation of the handlers for either would be the duplication the owner asked to avoid.

## Decision

**The main process becomes `@wirebench/host`, a package with no `electron` import, embedded by three
programs.** Precisely:

- Every direct Electron use in main goes through one injected `HostPlatform` interface: paths, secret
  encryption, optional dialogs, optional shell, app facts, proxy resolution, and the set of capabilities
  the platform has. The Electron app implements it with Electron; the agent with Node and the OS
  keychain; the server with per-tenant directories and sealed secrets.
- The package's only export is `createHost(platform)`: the desktop's composition root, which today
  constructs its services at module scope, becomes a function, and `@wirebench/host` has no module-level
  mutable state, checked by a gate, so one process can run a host per browser user.
- Handlers receive a `Caller` (an id, `send`, a close signal) instead of a `WebContents`. An Electron
  window, a paired browser socket on the agent, and a browser socket on the server are all callers.
- A caller's kind decides what it may reach. The agent's own window gets the full registry; a browser
  caller on the agent gets a declared subset (private sends, secret sources, team secrets, keystores,
  Kerberos, the agent's cookie jars, and SSH only by opt-in at pairing), never files, SFTP, dialogs, git,
  the terminal, the secret store's writes or `app.*`, because origin and nonce authenticate the page and
  not the server behind it.
- The wire does not change: the channel registry, the zod schemas and the `IpcResult` envelope are the
  contract over IPC and over both sockets alike.
- A capability the platform lacks means the handler is not registered and the renderer hides the feature
  through the area and feature switches it already has; the renderer never names a host.
- The import-graph gate of ADR-0030 refuses an `electron` import inside `@wirebench/host`.

## Consequences

- One codebase runs as the desktop app, as a headless agent and inside the server; a fix in a handler
  lands in all three.
- The desktop app is unchanged for its users; the refactor is proven by the existing tests passing
  against a fake platform and by a fake-socket test of the renderer's API builder. The socket transport
  itself arrives with the agent, not with the seam.
- The seam is a composition-root rewrite before it is a file-by-file edit: the 37 files that import
  Electron are the smaller half of the work.
- Per-window services become per-caller services, which is what a browser tab needs anyway.
- A main-process feature that needs a new Electron API now adds it to `HostPlatform` first, with a
  statement of what the agent and the server do without it; that is a small cost paid on every such
  feature, and it is what keeps the three hosts honest.

## What the move taught

Built in two pull requests: #779 put main behind `HostPlatform` as `createHost(platform)` inside the
app, and #780 moved it into `packages/host`, with the shared wire code in `packages/wire`. Where the
build differs from the decision above:

- **Two exports, not one.** The package root exports `createHost`, `Host`, `HostPlatform`, `Caller`,
  `Capability`, `HandlerTable`, and the `HostOptions`, `HostWindows` and `AttachOptions` that
  `createHost` takes (Electron-only hooks: windows, menu, updater, device keys). The Electron shell also
  needs a handful of internals (registration helpers, the event emitter, `runAsCaller`, security and
  Kerberos setup), which `@wirebench/host/desktop` exports by name. Only the desktop shell may import
  it. Nothing enforces that yet; the gate belongs to slice 2, whose server host is the first second
  embedder.
- **`createHost` is async** and must be called after Electron is ready, because preferences are read
  before channels register.
- **Optional capabilities are gated per registration function**, by whether the platform provides the
  member (dialogs, shell, power), not per channel.
- **Callers carry a reset signal** (`onReset`, on navigation start or commit), because per-window
  services reset at different moments today and each keeps its own.
- **Both packages are source-only and bundled.** `@wirebench/wire` and `@wirebench/host` are
  `devDependencies` of the desktop app, so electron-vite bundles them into main and preload. `ipc.ts`'s
  channel registry is too large an inferred type for a `.d.ts` (TS7056), so neither package emits.
  Third-party packages the host imports stay desktop `dependencies`, so the asar still carries them. A
  test (`scripts/host-dependencies.test.ts`) keeps every third-party host dependency a desktop one.
- **A plain-Node embedder must bundle, or the packages must emit.** The server and the CLI build with
  `tsc -b` and run under Node, which cannot load a package that ships only TypeScript sources: `tsc`
  refuses files outside `rootDir` (TS6059) and Node finds no `./x.js`. Slice 2's first task therefore
  either bundles the server entry, as electron-vite bundles the desktop's, or gives `@wirebench/host`
  and `@wirebench/wire` an emitting build, which first means fixing the TS7056 error on `ipc.ts`.
- **The gate is a script, not the import-graph gate.** `scripts/check-host-boundary.ts` refuses
  Electron imports, relative imports that leave `packages/host`, and top-level mutable state (with a
  short named allowlist). The platform supplies the app version, so the host reads no desktop file.
- **Left for later:** host tests still run on jsdom and some still carry dead `electron` mocks. A few
  test helpers are shared across the two packages by relative path.
