# ADR-0033: one host package serves the desktop, the agent and the server

Date: 2026-10-24 · Status: proposed (design
`docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.1, §5.1, §5.2) · Issue: none yet

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
  encryption, optional dialogs, optional shell, app facts, and the set of capabilities the platform has.
  The Electron app implements it with Electron; the agent with Node and the OS keychain; the server with
  per-tenant directories and sealed secrets.
- Handlers receive a `Caller` (an id, `send`, a close signal) instead of a `WebContents`. An Electron
  window, a paired browser socket on the agent, and a browser socket on the server are all callers.
- The wire does not change: the channel registry, the zod schemas and the `IpcResult` envelope are the
  contract over IPC and over both sockets alike.
- A capability the platform lacks means the handler is not registered and the renderer hides the feature
  through the area and feature switches it already has; the renderer never names a host.
- The import-graph gate of ADR-0030 refuses an `electron` import inside `@wirebench/host`.

## Consequences

- One codebase runs as the desktop app, as a headless agent and inside the server; a fix in a handler
  lands in all three.
- The desktop app is unchanged for its users; the refactor is proven by the existing tests passing
  against a fake platform and by the desktop serving its own renderer over the socket transport.
- Per-window services become per-caller services, which is what a browser tab needs anyway.
- A main-process feature that needs a new Electron API now adds it to `HostPlatform` first, with a
  statement of what the agent and the server do without it; that is a small cost paid on every such
  feature, and it is what keeps the three hosts honest.
