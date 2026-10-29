# ADR-0035: a paired agent serves a browser only send bundles

Date: 2026-10-29 · Status: accepted (design `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.8, §3.10,
§18) · Issue: #776, slice 3 #790

## Context

The local agent is the desktop app's main process, or a headless `wirebench agent`, listening on `127.0.0.1` for a
browser tab at the team's server. Its own Electron window may call nearly every channel, because that window is
inside a signed app. A page on the server's address is not. The pairing's origin check and the server-issued nonce
prove the page came from that server; they do not prove the server is honest. A compromised server, or one script
injected into the page, must not become file access or a shell on every paired machine.

The design (§2, §3.10) named a browser subset of capabilities: private sends, secret sources, team secrets,
keystores, Kerberos, the agent's cookie jars, and SSH by opt-in. Serving those as the desktop's own channels would not
work as they are: the desktop's request channels address a project that a window has open, and the agent opens no
workspace, because the one working copy lives on the server.

## Decision

**A browser caller on the agent reaches one channel group, `agent.*`, whose only working channel runs a send
bundle.** Precisely:

- `agent.send` takes the bundle the server host built: one request item, its folder chain's scripts, non-secret
  values, the cookie-jar policy, secret references by name and the files the request reads. The agent runs the
  engine's one send path on it, in a fresh temporary directory, and returns the kind's ordinary result.
- The subset's capabilities are what that send may use on the machine. None is a channel the page can call: the page
  cannot list files, open a dialog, start a process, read a secret back, or reach the agent's own windows.
- Every other channel answers `host-capability-missing` for a browser caller. A test classifies every registry
  channel, so a new channel is refused until someone decides otherwise.
- The renderer-gated capabilities of slice 2 (`listen`, `windows`, `accounts`, `reveal-secrets`) are refused on the
  agent for a browser caller by the same allowlist, not only hidden.
- SSH stays recorded as an opt-in at pairing and is served by nothing yet.

## Consequences

- A paired agent does send whatever request its server hands it, including to the person's `localhost` and private
  network. That is the agent's purpose, and it is why pairing is always a code typed on the machine (decision 9) and
  can be undone from either side; the docs say plainly that pairing trusts that server with sends from this machine.
- Scripts in a bundle run in the capability-free sandbox of ADR-0016, as every script does.
- The agent keeps no copy of a workspace. A bundle's directory is deleted after its send.
- A later feature that needs the machine from a browser (SSH, a file pick) adds its own `agent.*` channel with its own
  decision, rather than opening a desktop channel to browser callers.
