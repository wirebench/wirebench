# ADR-0020: Secret sources run the manager's own CLI

- Status: accepted
- Date: 2026-10-05
- Context: `docs/specs/2026-10-05-secret-sources-design.md`, issue #37, roadmap item 6.

## Context

A `${secret:name}` can now come from a vault, a cloud secret manager, a password manager or the operating
system's keychain. Wirebench has to fetch the value at send time, in the desktop main process and in the CLI.
Three options were weighed:

1. Run each manager's own command-line tool (`vault`, `aws`, `gcloud`, `az`, `op`, `security`, `secret-tool`)
   with `execFile` and no shell, building the arguments from structured, validated fields.
2. Call each manager's HTTP API, directly or through its SDK.
3. Option 1 plus a generic source whose command line the user writes.

## Decision

- **Option 1.** The tools already hold the user's login, including SSO and MFA sessions, so Wirebench stores no
  manager tokens, cloud keys or sessions, and adds no SDKs to the install. It is the same pattern as
  `sync/git-cli.ts`: fixed binaries found on `PATH`, no shell, bounded time and output.
- **Fixed kinds, not a command template.** The mapping lives in a shared `workspace.yaml`, so whatever it can
  express runs on every teammate's machine. A kind fixes the binary and the argument shape; the shared file
  supplies only validated values, none of which may start with `-`.
- **Approval before use.** A shared mapping resolves nothing on a machine until that machine approves it, and
  any change needs approval again, because the mapping decides which of the user's secrets a shared request
  can read.

## Consequences

- A user needs the manager's CLI installed and logged in. A missing tool or login is a clear, send-blocking
  error rather than a prompt inside Wirebench.
- Each value costs one process spawn, paid once per cache period (desktop) or once per run (CLI).
- The Windows credential store has no stock CLI that reads a generic credential, so `keychain` is macOS and
  Linux only until a way is chosen.
- A manager not covered by a kind needs a new kind, which is an ask-first change.
