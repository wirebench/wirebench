# Telnet and serial sessions: plan

Spec: `docs/specs/2026-10-17-telnet-serial-sessions-design.md`. Two pull requests: Telnet (#425) first, then
serial (#426) on top of it. One commit per task, each after `WIREBENCH_SKIP_PERF=1 pnpm check` is green.

## PR 1: Telnet (#425)

1. **Model.** `protocol: telnet` in `packages/ssh` (`host-mosh.ts` → the protocol enum), port 23 by default,
   no `incomplete` for Telnet targets. Unit tests for parse, serialise and resolve.
2. **Telnet session.** `packages/ssh/src/telnet.ts`: the option codec, the prompt watcher, and
   `openTelnetSession` (direct, proxy, or a channel from the last SSH jump host) answering an `SshSession`.
   `startTelnetFixture` in the test helpers; unit tests for the codec, integration tests through the fixture,
   the SSH fixture as a jump host and the SOCKS5 fixture.
3. **Desktop main.** The connector's Telnet branch (jump credentials only, sign-in secrets for the masker,
   `ssh-jump-not-ssh`), the service opening it with no OS probe, the `telnet=off` switch (`telnet-off`) and
   the `app.areas` answer saying which kinds are on. Tests.
4. **Desktop renderer.** Telnet in the Protocol select with the plain-text note; SSH-only fields, menu items
   and details rows hidden; the "Not encrypted" badge in the pane header; connect errors. Tests.
5. **Docs and e2e.** Guide section, CHANGELOG, `wirebench ssh` refusing a Telnet host, and an e2e test
   against the Telnet fixture.

## PR 2: Serial (#426)

6. **Model.** `protocol: serial`, the `serial` block with its defaults, `address` optional for serial hosts.
   Unit tests.
7. **Native binding and packaging.** `@serialport/stream` and `@serialport/bindings-cpp` in the desktop app,
   loaded lazily; `electron-builder.yml` (unpack, exclusions, `x64ArchFiles`), the asar check, third-party
   licences.
8. **Desktop main.** `serial-devices.json` store, `ssh.serialPorts` and `ssh.setSerialDevice` channels, the
   serial session over the binding (tests with `@serialport/binding-mock`), the connector's serial branch,
   the `serial=off` switch, and its errors.
9. **Desktop renderer.** Serial in the Protocol select, the line settings and device picker in the form, the
   connection screen's port picker for an unset or missing device, SSH-only parts hidden. Tests.
10. **Docs.** Guide section, CHANGELOG, the manual test with a USB serial adapter recorded in the PR.
