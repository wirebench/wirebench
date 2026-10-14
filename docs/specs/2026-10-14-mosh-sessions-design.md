# Mosh sessions (#419)

Status: accepted 2026-10-14. Builds on: `2026-10-08-ssh-area-design.md` (its non-goals kept room for a
`protocol` field), ADR-0026 (the prebuilt pty binding).

## Why

On a flaky or roaming link (trains, tethering, high latency) an SSH session drops or lags. Mosh keeps the session
alive across network and address changes, and echoes keystrokes locally.

## Ruling: Wirebench drives an installed `mosh-client`

Owner ruling, 2026-10-14. Wirebench does the SSH half itself and runs the user's own `mosh-client` for the UDP
half, in a pseudo-terminal, inside the same terminal tab.

| Option                                        | Verdict                                                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-process client (SSP, AES-OCB, framebuffer) | Works with nothing installed, but is a terminal emulator plus a state-sync protocol: many thousands of lines and subtle sync bugs. Not taken.                                                                    |
| Bundle `mosh-client`                          | GPL-3: notices and a source offer, protobuf + ncurses builds per platform/arch in CI, and no native Windows build anyway. Not taken.                                                                              |
| **System `mosh-client`**                      | **Taken.** Nothing GPL ships. The pty binding is already vendored (#410). Works on macOS and Linux with mosh installed; on Windows only when a `mosh-client` is on `PATH`. A missing client is a clear error. |

## Model

Two optional settings under `ssh:` on a host or a group; the nearest level wins, as with every other setting.

```yaml
ssh:
  protocol: mosh # ssh (default) | mosh
  mosh: # optional, taken whole from the nearest level that sets it
    server: /opt/mosh/bin/mosh-server # default: mosh-server (found on the remote PATH)
    ports: 60000:60010 # one port or LOW:HIGH; default: mosh-server's own choice
```

- `ports` is a string, `N` or `LOW:HIGH`, each 1–65535, `LOW <= HIGH` (mosh's own `-p` syntax).
- `server` is a command name or path, not blank. It runs on the remote host only.
- `ResolvedHost.ssh` gains `protocol: Provenance<'ssh' | 'mosh'>` and `mosh: Provenance<MoshSettings | undefined>`.

## Connecting

1. Dial the hop chain exactly as for SSH (host key, auth, jump hosts, the connection screen's stages).
2. Exec on the target: `<server> new -s -c 256 -l LANG=C.UTF-8 [-l NAME=VALUE…] [-p PORTS]`, values
   shell-quoted. The host's environment variables go as `-l` pairs (mosh has no `env` request) and are masked
   like SSH's. Unlike SSH's `env` requests, they appear on the remote command line.
3. Parse `MOSH CONNECT <port> <key>` from stdout. When it is missing: exit 127 or "not found" in stderr →
   `mosh-server-missing`; anything else → `mosh-bootstrap-failed` with the server's last stderr line. The key
   is a secret: never logged, never in an error.
4. Close the SSH connection. Spawn `mosh-client <ip> <port>` in a pty with `MOSH_KEY` in its environment, a
   UTF-8 `LANG` (mosh refuses to run without one), and `TERM=xterm-256color`. `<ip>` is the target's address
   resolved on this machine. UDP goes straight to the target, never through a jump host; the connection log
   says so when the host has a jump.
5. The pty's output is the terminal's data, and its exit is the session's end (`exit`). Resize goes to the pty.

`mosh-client` is looked up on `PATH`, then in `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`,
`/usr/bin`, `/snap/bin` and `~/.nix-profile/bin`, because an app started from the Dock gets a short `PATH`. Not
found → `mosh-client-missing`, whose message says to install mosh.

Unchanged: the masker, session logs, snippets, find, the connection screen and reconnect (#407) all act on the
`SshSession` interface, which the mosh session implements. Agent forwarding does not apply. The host OS probe
needs an exec channel, which a mosh session no longer has, so the label stays as last known.

## Form and details

- Host dialog → Advanced: a **Connection** block with Protocol (SSH / Mosh, inherited like the other fields)
  and, for Mosh, the server command and UDP ports.
- Host details: a Protocol row. The copied `ssh` command stays SSH.

## Out of scope

- The CLI's `wirebench ssh` keeps SSH whatever the protocol says (it has no pty dependency).
- Bundling a client, an in-process client, Mosh through a proxy.

## Testing

- Unit: model parse/serialise/refusals, resolve provenance, command building and quoting, `MOSH CONNECT`
  parsing, missing-server classification, client lookup, the session wrapper over a fake pty.
- Integration (`packages/ssh`): bootstrap against the in-process SSH fixture with a fake `mosh-server` script.
- e2e (Docker, headless): a container with `mosh-server` and `mosh-client`; connect a Mosh host and run a command
  in the tab; a host whose server command does not exist shows the missing-server error.
