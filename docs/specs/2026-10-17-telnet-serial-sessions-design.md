# Telnet and serial console sessions (#425, #426)

Status: accepted 2026-10-17. Builds on: `2026-10-08-ssh-area-design.md` (its non-goals kept room for a
`protocol` field), `2026-10-14-mosh-sessions-design.md` (the first protocol beside SSH), ADR-0026 (the
prebuilt pty binding, whose packaging the serial binding follows).

## Why

Network gear, old appliances and lab equipment are still managed over Telnet, and switches, routers and
embedded boards are set up over a serial console cable. Both are terminals: they belong in the same tab, with
panes, find, snippets and session logs, not in a separate tool.

## Rulings

Owner rulings, 2026-10-17:

| Question                       | Ruling                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telnet allowed?                | Yes. An enterprise build switches it off with `WIREBENCH_AREAS=telnet=off`, as it does the local terminal.                                                                 |
| Serial off switch              | `WIREBENCH_AREAS=serial=off`, the same way.                                                                                                                                |
| Where a serial session lives   | In `hosts.yaml`, like any host: name, group, tags and line settings are shared. The device it opens is picked and remembered **per machine**, never written to the file. |
| Telnet through a jump or proxy | Yes. The jump hosts are reached over SSH, and the last one opens a channel to the Telnet port; a proxy is used for the first network hop, as for SSH.                     |
| Telnet sign-in                 | Wirebench types the host's user and password at the device's login and password prompts, once each, then hands over. With neither set, you sign in yourself.             |

## Model

`ssh.protocol` gains two values. Everything else about a host (name, group, tags, protected, terminal
appearance) works as before.

```yaml
hosts:
  - id: core-sw
    name: Core switch
    address: 10.0.0.2
    ssh:
      protocol: telnet # ssh (default) | mosh | telnet | serial
      port: 23 # Telnet's default when unset
      user: admin # optional: typed at the login prompt
      auth: { password: '${secret:core_sw}' } # optional: typed at the password prompt
      jump: bastion # optional: SSH to the bastion, then a channel to 10.0.0.2:23
  - id: lab-console
    name: Lab router console
    ssh:
      protocol: serial
      serial: # optional; taken whole from the nearest level that sets it
        baud: 9600 # default 115200
        dataBits: 8 # 5 | 6 | 7 | 8, default 8
        parity: none # none | even | odd | mark | space, default none
        stopBits: 1 # 1 | 1.5 | 2, default 1
        flowControl: none # none | rtscts | xonxoff, default none
```

- `address` is required on every host whose protocol (its own or inherited) is not `serial`; a serial host
  writes none. A serial host given an address keeps it (a group may switch protocols back).
- The protocol is inherited like every other setting, so a group "Switches" can say `protocol: telnet` once.
- `ResolvedHost.ssh.port` defaults to 23 when the protocol is `telnet`, 22 otherwise.
- `ResolvedHost.ssh.serial: Provenance<SerialSettings | undefined>`; the connect fills the defaults per field.
- `incomplete` (no user, no auth) is reported only for SSH and Mosh targets: a Telnet host signs in by hand
  when it has neither, and a serial line has no sign-in.
- Telnet types only a password (`auth: { password }`); a key or the agent, say inherited from a group, is
  not used for Telnet, and the connection log says so. A user from Preferences → SSH is not typed either:
  only one set on the host, a group or an identity.
- A jump host must itself be an SSH (or Mosh) host: a Telnet or serial host named as `jump` is refused at
  connect (`ssh-jump-not-ssh`). A serial host ignores `jump` and `proxy`, and the form does not show them.
- No version bump: like `protocol: mosh`, the new values read as an invalid protocol in an older build,
  which says so instead of guessing.

The device a serial host opens on this machine is kept in `<userData>/serial-devices.json`, keyed by the
workspace's id and the host id (the id, not the folder, so moving a workspace keeps its devices), as the
saved terminal layouts are:

```json
{ "version": 1, "devices": { "4f1c…\nlab-console": "/dev/tty.usbserial-A10KJ3" } }
```

Three channels serve it: `ssh.serialPorts` lists this machine's ports, `ssh.serialDevice` reads a host's
device and `ssh.setSerialDevice` sets or (with `null`) forgets it, each for the calling window's workspace.

## Telnet

Connecting:

1. With a jump: dial the jump chain over SSH exactly as for an SSH host (host keys, auth, the connection
   screen's stages), then open a `direct-tcpip` channel from the last jump to `address:port`. Without one:
   a TCP connection, through the host's proxy when it has one. Failures are `ssh-connect-failed` with the
   same `reason` values, so the connection screen explains them as it does for SSH.
2. Negotiate options (RFC 854/855). Wirebench offers `WILL TTYPE`, `WILL NAWS` and `DO SGA` at once, and
   answers the server: it accepts the server's `WILL ECHO`, `WILL SGA` and `WILL BINARY` (`DO`), and its
   `DO TTYPE`, `DO NAWS`, `DO SGA` and `DO BINARY` (`WILL`); every other option is refused (`DONT` / `WONT`).
   Each side of each option is tracked, so an answer is never answered again (no negotiation loops).
3. Terminal type (RFC 1091): `SB TTYPE SEND` is answered with `xterm-256color`. Window size (RFC 1073):
   sent once `NAWS` is agreed and again on every resize.
4. Data: an outgoing `0xFF` is doubled; Enter (CR from the terminal) goes out as CR LF, the Telnet newline,
   unless both directions are binary. Incoming `IAC IAC` is `0xFF`, CR NUL is CR, and every other command
   is consumed. A command split across reads is held until it is whole.
5. Sign-in: for the first 30 seconds, until the user types, the output is watched for a login prompt
   (`login:`, `username:`, `user name:`) and a password prompt (`password:`), ignoring case, colours and
   trailing space. Each is answered once with the value and CR LF. A prompt with nothing to answer ends the
   watch. The password is a secret: it is masked like any secret should the device echo it, and no log line
   or error ever holds it.
6. The server closing the connection ends the session (`exit`); a reset, a timeout or a jump host's
   connection going is `lost`, so reconnect (#407) offers itself as for SSH.

**Not encrypted.** The host form's protocol note, the details panel and the terminal tab all say so: a lone
Telnet pane shows a "Not encrypted" strip over the terminal for as long as it is open, a pane of a split tab a
mark in its header, and the connection log says what is plain text (the whole session, or only the leg after
the jump host).

## Serial

Connecting:

1. The device is this machine's choice for the host. None yet → `serial-device-unset`: the connection
   screen lists this machine's serial ports and connects with the one picked, which it remembers.
2. Open it with the host's line settings (`@serialport/stream` over `@serialport/bindings-cpp`, loaded on
   first use). A device that is not there → `serial-device-missing` (the picker again); in use →
   `serial-device-busy`; no permission → `serial-permission` (on Linux, the `dialout` group hint).
3. Bytes in and out unchanged. Resize does nothing (a serial line has no window size). Close closes the port;
   the cable or adapter going away mid-session is `lost`.

The port list (`SerialPort.list()`) shows each port's path with its maker and serial number when the OS knows
them (`/dev/tty.usbserial-A10KJ3 — FTDI`, `COM3 — USB Serial Device`). The host form has a **Device on this
computer** field with the same list, a Refresh button and free text for a path the list does not show.

**Native binding.** `@serialport/bindings-cpp` ships N-API prebuilds inside its npm package for every
platform the app is built for, like node-hid: packaged as is, unpacked from the asar (the OS loader maps the
`.node`), its C++ sources left out, and both darwin prebuilds in every mac build (`x64ArchFiles`). A platform
without a prebuild shows serial as unavailable (`serial-unavailable`) and nothing else changes.

## What a Telnet or serial host does not have

Hidden for these kinds, in the form, the menus and the details panel: SFTP (Open files), port forwarding,
agent forwarding, Install public key, environment variables (no `env` request), the Mosh block, and the OS
probe (no exec channel; the OS label is chosen by hand). Serial also hides address, port, user, password,
jump and proxy. The copied `ssh` command and `wirebench ssh` stay SSH only.

Unchanged for them: the terminal tab, panes and layouts, find, snippets (typed into the line), session logs,
the masker, the connection screen and reconnect: all act on the `SshSession` interface, which both sessions
implement.

## Out of scope

- Telnet encryption (`START_TLS`), Kerberos Telnet authentication, LINEMODE.
- Serial BREAK, modem-line toggles (DTR/RTS) and file transfer (XMODEM and friends); follow-ups if asked for.
- A per-host terminal type and charset, which #427 adds for every kind; Telnet's `TTYPE` then sends it.
- The CLI: `wirebench ssh` refuses a Telnet or serial host and says so.

## Testing

- Unit (`packages/ssh`): parse, serialise and refuse the new values, the address rule, port and serial
  defaults, resolve provenance; the Telnet codec (split commands, `IAC IAC`, CR NUL, newline translation,
  every option answer, no loops, TTYPE and NAWS bytes); the prompt watcher.
- Integration (`packages/ssh`): a Telnet fixture server inside the tests (`startTelnetFixture`) checks the
  negotiation, sign-in, resize and exit; the same through the in-process SSH fixture as a jump host, and
  through the SOCKS5 fixture.
- Desktop: the serial session over `@serialport/binding-mock`; the device store; the connector's Telnet
  and serial branches; the off switches; the form and the connection screen's port picker.
- e2e (Docker, headless): a Telnet host signs in at the fixture's prompts and runs a command. A serial
  console opens one end of a virtual serial line (`socat` linking two pseudo-terminals, the test playing the
  device on the other end), is asked for its port on the connection screen and talks over the line; it skips
  where `socat` is not installed. A manual test with a USB serial adapter is recorded in the PR.
