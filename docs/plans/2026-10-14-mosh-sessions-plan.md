# Mosh sessions — plan (#419)

Spec: `docs/specs/2026-10-14-mosh-sessions-design.md`. One commit per task, each after
`WIREBENCH_SKIP_PERF=1 pnpm check`.

## T1 — model and resolve (`packages/ssh`)

- `model.ts`: `protocol` (`ssh` | `mosh`) and `mosh` (`{ server?, ports? }`) in the settings schema; serialise
  both; `ports` refinement (`N` or `LOW:HIGH`, LOW <= HIGH).
- `resolve.ts`: `ssh.protocol` (default `ssh`) and `ssh.mosh` (taken whole) with provenance.
- Tests: parse, round trip, bad ports refused, inheritance and provenance.

## T2 — bootstrap (`packages/ssh/src/mosh.ts`)

- `moshServerCommand(settings, env)`: quoting, `-l` pairs, `-p`.
- `parseMoshConnect(stdout)`: port + key, or undefined.
- `bootstrapMosh(options)`: dials the chain, execs, classifies failure (`mosh-server-missing`,
  `mosh-bootstrap-failed`), reports progress stages, ends the chain, answers `{ port, key }`.
- Unit tests for the pure parts; integration test against the SSH fixture with a fake server script.

## T3 — desktop main

- `mosh-client.ts`: `findMoshClient` (PATH + fallback folders), `moshClientEnv`.
- `mosh-session.ts`: `openMoshSession` → `SshSession` over a pty (resolve address, spawn, wrap data/exit/resize).
- `ssh-connect.ts`: `prepareShell` returns `mosh` when the target's protocol is mosh; `ssh-service.ts` opens the
  mosh session for it. Wire: `ResolvedHostWire.ssh.protocol/mosh`, the settings wire, new error codes.
- Tests: client lookup, session wrapper over a fake pty, service picks the mosh opener.

## T4 — renderer

- `mosh-section.tsx` in the host dialog's Advanced section; host details Protocol row; connection screen copy for
  the new errors.
- Tests: form model, section, error copy.

## T5 — docs and e2e

- User docs (SSH hosts page), CHANGELOG.
- e2e in Docker: a Mosh host connects and runs a command; a missing server shows its error.
