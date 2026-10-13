# ADR-0026: The local terminal uses a prebuilt pty binding, vendored per architecture

- Status: accepted
- Date: 2026-10-13
- Context: issue #410 (local terminal tab), [ADR-0019](0019-kerberos-uses-an-optional-native-module.md)

## Context

A local terminal tab runs the user's shell on this machine. A shell only behaves as a terminal (line editing,
colours, full-screen programs, resize) inside a pseudo-terminal, and Node has no pseudo-terminal of its own:
it takes native code on every OS (`forkpty` on macOS and Linux, ConPTY on Windows). Four options were weighed:

1. `node-pty` itself (MIT). It ships prebuilt binaries for macOS and Windows inside one package, but builds from
   source with `node-gyp` on Linux at install time. The release job packs the Linux arm64 app from an x64
   runner, which would carry an x64 binary.
2. `@lydell/node-pty` (MIT), a republish of `node-pty`'s own source with one prebuilt N-API binary package
   per platform and CPU (`darwin`, `linux`, `win32` × `x64`, `arm64`), installed as optional dependencies. The
   JavaScript is `node-pty`'s.
3. Running the shell through `script(1)` or a pipe, with no native code. No resize, no ConPTY on Windows, and
   programs that check for a terminal behave differently.
4. Not building it, and pointing users at their own terminal app.

## Decision

- **Option 2**, pinned to an exact version in `apps/desktop`'s `dependencies` and loaded lazily by main
  (`local-terminal-service.ts`) at the first local terminal. N-API means the binary built for Node loads in
  Electron without a rebuild.
- **A binding that does not load is a state.** The tab says the local terminal is not available, with the
  reason; nothing else in the app changes.
- **Packaging vendors the bindings, as for Kerberos.** pnpm installs only the runner's own binding and the
  release jobs pack several architectures from one install with `npmRebuild: false`. `scripts/vendor-node-pty.ts`
  downloads each binding package of the target platform from the npm registry and refuses any whose sha512
  differs from the integrity `pnpm-lock.yaml` records for it, so an upgrade of the package and of the pins is
  one lockfile change. `electron-builder.yml` excludes the installed binding, maps the vendored ones into
  `node_modules/@lydell/`, and unpacks them from the asar so the OS can load them and they are signed with
  the app.

## Consequences

- Wirebench now has two native modules; `docs/release.md` describes both.
- Every mac build carries both darwin bindings, named in `mac.x64ArchFiles` because they are thin and
  identical in the x64 and arm64 apps the universal merge combines.
- `THIRD-PARTY-LICENSES.md` lists `@lydell/node-pty`; the per-platform binding packages, built from the same
  source under the same license, are left out so the file is the same on every OS.
- Upstream fixes reach Wirebench when the republish follows `node-pty`. Moving to `node-pty` later is a change
  of package name and of the vendoring script, not of the service.
