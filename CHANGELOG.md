# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Colour themes.** Seven colour themes beside Default — Field kit, Sandstone, Dusk, Seed, Pith,
  Rind and Plume — each in dark and light, chosen in Settings → Appearance or with **Theme: choose colour theme…**,
  which previews them as you move through the list; the mode (Dark, Light, System) stays a separate choice.
- **An overview of every REST API.** The API's page opens on General: its name and base URL, its
  description rendered as formatted text and edited in place, a summary of how many requests and folders it holds, its auth,
  where its requests go and where its definition came from, and Recent changes, the commits that
  touched this API in a git-shared workspace. An imported description's raw HTML is left out, its
  images are not loaded, and only web links stay links.
- **A page for every folder.** Clicking a folder in the explorer opens its page and unfolds it:
  **General** (its name, its description shown and edited in place, and how many requests and folders
  it holds), **Authentication** and, for REST and gRPC folders, **Scripts**. Auth… and Scripts… in its
  menu open those tabs; they replace the folder's credentials and scripts dialogs.
- **Where a page sits.** API and folder pages show their path above the tabs (project › API ›
  folders); each part before the last opens its page.
- **Complete documentation for a REST API.** View complete documentation opens a tab with every
  folder and request, their descriptions, URLs, parameters, bodies and examples, and exports it as
  one self-contained HTML page or a Markdown file. Values stay as written; nothing is filled in.
- **Preview updates.** **Settings → Updates → Update channel** picks Stable (the default) or Preview.
  On Preview, **Check for Updates…** also offers release candidates such as `6.2.0-rc.1`, marked
  "(preview)" in the download prompt. Going back to Stable never downgrades: a preview build waits for
  the next stable release that is newer. A managed-preferences policy can lock the channel.
- **Server: the app in a browser tab (#783).** With `WIREBENCH_SERVER_BROWSER_CLIENT=true` and
  `WIREBENCH_SERVER_SECRETS_KEY` set, the server serves the app at its public URL: a teammate signs in at
  `/sign-in` (email and password, OpenID Connect or SAML), opens the team's server workspaces and sends
  requests from the server, under the same egress rule as scheduled runs. Each user's secrets are sealed
  under their own key, never shown again and audited by name. Anything that needs the user's machine —
  SSH, terminals, file dialogs, mock services, Kerberos, the keychain — is absent. OIDC and SAML need one
  more redirect URI and ACS URL at the identity provider; see the _Browser client_ guide. Off by default.
- **Server: send from your own machine through a local agent (#790).** A browser tab can now send to
  `localhost`, to hosts only your network knows, and with team secrets: Settings → This machine →
  Pair this machine shows a code, which the desktop app (Pair this machine…) or
  `wirebench agent pair <code> --server <url>` trades for a pairing. Before each REST or SOAP send the tab
  asks the server where it goes; a send that needs your machine goes through the agent, or fails with
  `send-needs-agent` and an offer to pair. The chip beside Send says Server or Agent, a request or
  workspace can be pinned to the agent, and History tags each entry with the host that sent it. A paired
  server can send requests from your machine on your behalf, including to addresses on its network, and
  nothing more: no files, shell, SSH or SFTP. `${#System#…}` reads only the names on the agent's own
  allowlist, empty by default. Chrome, Edge and Firefox; Safari users use the desktop app. A send under a
  protected environment now asks in the tab before it goes, whichever host sends it; before, such a send
  could not be made from a browser tab at all.
- **Desktop: Settings → Paired browsers.** The servers whose browser tabs may send from this machine, with
  Unpair and Remove here only, the port the agent listens on, and the `${#System#…}` allowlist. A paired
  desktop app resolves team secrets for a tab's send from the values its approved machine has imported,
  and refuses one the server holds a newer version of (`team-secret-stale`).
- **CLI: `wirebench agent` (#790).** The local agent without a window: `wirebench agent` serves on
  `127.0.0.1:47615` (or the next free port up to 47634) until Ctrl+C, with `pair`, `unpair [--server]
  [--local]`, `status`, and `allow-env`, `disallow-env`, `allowed-env` for the allowlist. Its secrets are
  sealed under `~/.wirebench/agent/agent.key`, protected only by its file mode (on macOS and Linux the
  agent refuses to start when the folder or key is open to others). It has no team secrets: use the
  desktop app for those. It is a separate agent from the desktop app's, with its own pairings and allowlist.
- **Server: a database role of its own for the server's queries (#798).** Set
  `WIREBENCH_SERVER_MIGRATION_DATABASE_URL` to the role that owns the schema, and
  `WIREBENCH_SERVER_DATABASE_URL` to an app role that owns nothing. The server migrates as the owner,
  creates the app role on first start when it is missing (its password stored only as a SCRAM-SHA-256
  verifier), grants it what it needs at every start, and runs every query as it. The migration URL must be
  a direct connection; the app URL may go through a pooler. `wirebench-server admin tenancy role` does the
  same outside a start, and `--print-sql` prints the statements for an owner that may not create roles. The
  contributors' `packages/server/compose.yaml` now uses `wirebench_app`.

### Changed
- **Default's editor colours match the rest of the window (#803).** Monaco's comment, hint and
  line-number greys, and in light mode its accent, success and warning colours, now equal the
  Default tokens the app's chrome already uses; they had kept older values.
- **Server: PostgreSQL 15 or later (#798).** Start-up and `migrate` refuse an older database with
  `server-postgres-too-old`. The compose files already run PostgreSQL 16.
- **Server: a start-up warning when one role does everything (#798).** A server whose one database URL is a
  superuser, has `BYPASSRLS`, or owns the schema's tables still starts and upgrades as before, and logs a
  warning that row-level security does not apply to that role, pointing at "Database roles" in the server
  README.
- **Server: the migration to tenants (#798).** The first start migrates the database to the multi-tenant
  layout (migration `0020`): a single default tenant holds everything, and nothing users see changes. Large
  databases take longer to start once; measure it on a copy first.
- **Server: a lost `server_identity` row stops start-up with its advice again (#798).** Start-up fails with
  `server-identity-missing` and says to restore the row from a backup rather than insert a new one, which
  would mint a new server id that no license is bound to. `wirebench-server admin` exits with code 2 for it,
  as start-up does.
- **Server: a database restart no longer leaves the server running blind (#798).** The server holds a
  lock for its whole life. When the database goes away it takes the lock back as soon as the database
  returns, for up to about two minutes, and then exits with code 3 for its supervisor to restart.
- **The open editor tab stands out.** It carries an accent bar along its bottom edge, and the editor
  tab strip is taller, so the tab you are on is easy to pick out at a glance.
- **Project and API pages use tabs.** The project page (General, Settings, Properties) and every API
  page — REST, WebSocket, gRPC and MCP — show one section at a time behind a tab instead of one long
  page, and the Scripts tab's editor fills the page. Each page remembers the tab it was on.
- **A send in flight replaces the old response.** While a REST request is out, the response pane shows
  Sending… with the elapsed time and a Cancel button instead of the previous response dimmed.
- **Runner and shortcut tables.** The Runner's delay field reads "Delay (ms)" with a tooltip, and the
  Keyboard shortcuts table keeps a minimum width (it scrolls sideways in a narrow window) with Reset all on one line.
- **Comment toggle in a JSON body keeps the indent.** Ctrl+/ puts `//` at the indent of the selected
  lines instead of at column 1, and toggling again restores the text exactly.
- **Server: scheduled runs and alerts no longer reach the server's own machine (behaviour change for
  existing servers).** A request in a scheduled run, and a Slack, Teams or webhook alert, whose host
  resolves to a loopback, link-local, unspecified or cloud-metadata address is now refused with
  `egress-refused`, so a schedule that sent to `localhost`, `127.0.0.1` or a sidecar on the same host
  fails after the upgrade. Address an internal service by a name that resolves to a non-loopback address
  instead. Private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) stay reachable unless
  `WIREBENCH_SERVER_EGRESS_DENY_PRIVATE=true`, which refuses them too.

## [6.1.0] - 2026-10-23

### Added
- **`@wirebench/engine/plugin`, the plugin API's types (#765).** A types-only subpath for writing an
  importer, a reporter or a code generator, with the `wirebench-plugin.json` manifest. It is versioned
  on its own (`PLUGIN_API_VERSION` 1.0.0) and its surface is a committed report a check compares, so a
  change to it is a reviewed, versioned change.
- **Plugins for the CLI (#765).** `wirebench plugin install <folder | .tgz>`, `list` and `remove`
  manage this user's plugins in the app's data folder; a project can never bring one. A plugin's
  reporter is `--reporter <plugin>/<reporter>=<file>`, and `wirebench import` offers a file no
  built-in format claims to the plugin importers. Plugins run in the script sandbox; only an importer
  may fetch, from the origins its manifest lists, through the engine's network path. `--no-plugins`,
  `WIREBENCH_PLUGINS=off` and the `plugins` / `plugin:<id>` switches turn them off (ADR-0031).
- **Plugins in the app (#765).** **Settings → Plugins** lists the plugins installed for you, with what
  each contributes and which origins it may reach, and installs one from a folder or a `.tgz` after
  showing that, or removes one; either applies at the next start. A plugin's importer is offered by the
  Import dialog for a file no built-in format claims, and its code generators join the Code panel's
  languages, each marked _(plugin)_. **Settings → Features** has a **Plugins** group with the switch
  for all of them and one per plugin, which a team policy can turn off. No plugin code runs in the
  window; a new **Plugins** guide covers installing and writing one.

- **An organisation can switch a desktop area off (#360).** The managed `policy.yaml` takes an `areas`
  section (`ssh: false`, or `local-terminal`, `telnet`, `serial` on their own) that removes the area's
  activity-bar item, commands, views, tabs and IPC channels on that machine and wins over
  `WIREBENCH_AREAS`; a policy entry can only switch off. **Settings → Features** gains an **Areas** group
  that shows each area's state and why (_Set by your organisation_, marked Managed).
- **GraphQL is a switch (#760).** **Settings → Features** lists **GraphQL** under Protocols, marked
  experimental and on by default, so 6.1.0 projects keep sending it; it needs REST. With it off,
  **New GraphQL request** and the body's **GraphQL** option are gone, a request that already has a
  GraphQL body still opens, and its send is refused with `feature-disabled` in the app, `wirebench run`
  (`--features graphql=off`, `WIREBENCH_FEATURES`) and the MCP server alike. A team policy can switch it
  off for a workspace. No project file changes.

- **Feature switches.** Every protocol and optional feature can be turned off: **Settings → Features**
  lists SOAP, REST, gRPC, WebSocket, MCP requests, Scripts, Sequences, Webhooks, Shared workspaces,
  Team secrets and the MCP server, with the stage of each and why one is off (_Requires REST_, _Off by
  team policy for Payments_); a change applies at the next start. The CLI and `wirebench mcp` take
  `--features grpc=off,scripts=off` and `WIREBENCH_FEATURES`; `tools/list` omits the tools of what is
  off and a call to one is refused with `feature-disabled`. A workspace admin sets a restrict-only
  policy per shared workspace (**Team → Workspaces → Features**), carried on every sync (ADR-0029). A
  feature that is off is refused by the engine, not only hidden, and its files are never rewritten
  (#735, phase 4 of #184).
- **The Explorer selects like a desktop tree (#681).** Shift-click selects a range and Ctrl/⌘-click adds
  or removes a row. A selection of several rows gets a menu of its own — **Move to…**, **Duplicate** and
  **Delete 3 requests…** — and Delete, ⌘⌫ (Ctrl+Backspace) and Backspace delete it through one confirm. F2
  starts an inline rename. The palette gains **Explorer: Collapse All**, **Expand All**, **Reveal Active
  Tab**, **Focus Explorer**, **Rename**, **Duplicate**, **Delete** and **New Folder**, acting on the
  selection or the active tab, and the new keys are listed under Settings → Keyboard shortcuts.
- **A Projects panel for an environment.** Which projects a workspace environment applies to is chosen in
  its own panel on the right of the environment's page, opened from the rail's **Projects** icon or
  **Choose projects…** in Environment details: **All projects** at the top (projects added later
  included), then one checkbox per project. Clearing a box narrows the environment to the others, and a
  narrowed environment stays narrowed until **All projects** is ticked again. Environment details reads
  the choice. The workspace environment file has a published JSON Schema of its own, under
  `schemas/workspace/v<format>/`, that covers `projects` (#393).
- **Closing live sessions asks first.** Closing tabs that hold a connected SSH, Telnet or serial session,
  or a running local terminal, asks once for the whole batch (**Close 2 sessions on web-1?**); **Cancel**
  keeps every tab. **Don't ask again** turns it off, and **Settings → Terminal → Confirm closing live
  sessions** turns it back on (S53).
- **Undeclared snippet variables can be declared on the spot.** A `${name}` the snippet does not declare
  is listed when it runs (it goes to the shell as is, for the shell to expand), with **Ask for it** to
  declare it; saving a snippet with undeclared names asks once, and **Save anyway** keeps them (#717).
- **Move an API to another project.** API rows of every kind (REST, gRPC, WebSocket, MCP) offer
  **Move to project…**, and dragging an API onto another project's row moves it there, the row
  highlighted as the drop target. Folders, requests, scripts, mocks and the cached definition go with it
  and keep their ids, so open tabs and History still resolve. Before the move it lists what the API uses
  that the target lacks: project variables and this computer's `${secret:…}` values are copied, and
  environment-only variables, unset secrets, keystores and sequences that run its requests are named.
  Both projects are saved; a failure leaves both as they were, and the toast's **Undo** moves it back
  (#701).
- **Reorder APIs by dragging.** An API row dragged up or down among its project's APIs changes their
  order (#701).
- **Preview tabs, a tab menu and a question before unsaved edits are lost.** A single click in the
  Explorer opens one preview tab, its name in italics, that the next single click replaces, so reading
  through requests no longer leaves a tab per click. A double-click, the first edit, **Send** or
  double-clicking the tab's name keeps it; **Settings ▸ Behaviour ▸ Preview tabs** turns previews off.
  Right-clicking a tab offers **Close**, **Close others**, **Close to the right**, **Close saved**,
  **Close all**, **Reveal in Explorer** and **Copy name**, for SSH and terminal tabs too; a middle-click
  closes a tab, and the palette has **Close Other Tabs**, **Close Tabs to the Right**, **Close Saved
  Tabs** and **Close All Tabs**. Closing a tab with unsaved edits, however it is closed, asks **Save**,
  **Don't save** or **Cancel** (#679).
- **Comments in a JSON body.** <kbd>Cmd/Ctrl+/</kbd> toggles `//` on the selected lines of a Raw JSON
  body and <kbd>Shift+Alt+A</kbd> toggles `/* */`; comments are coloured as comments and saved with the
  request. They are removed before the body is sent, with any comma a commented-out last field leaves
  behind, so the server still receives valid JSON; slashes inside strings stay, and a `${…}` inside a
  comment is never resolved. Desktop and CLI sends, MCP, runs, **Copy as cURL**, generated code,
  History and the HTTP log all use the body without comments. GraphQL variables accept them too.
  **Format** and the JSON form refuse a body with comments instead of dropping them (#702).
- **Terminal sessions in the audit log.** In a workspace that records desktop activity, every SSH, Mosh,
  Telnet or serial session that ends is reported to the team server as `desktop.ssh_session`: the host id,
  address, port and login name, when it started and ended, why it ended and the exit code. Never a
  password, key, passphrase or secret value; the **Recorded** notice names sessions too (#355).

- **SSH connection defaults in Settings.** Settings → Workspace → **SSH** sets a default user, keep-alive
  and connect timeout (`ssh.user`, `ssh.keepAlive`, `ssh.connectTimeout`) for every host that does not
  set its own, directly, through a group or through an identity. The host and group forms show such a
  value as "from Preferences" with the same override switch as a group's, and the host details say so
  too. A default user completes a host that has a way to sign in. `wirebench ssh forward` does not read
  these per-machine settings and keeps the built-in values (#571).
- **Connect to a server that isn't saved.** Typing `user@host:port` in **Connect to Host…** offers
  **Connect to …**, a terminal signed in with the SSH agent that writes nothing to `hosts.yaml`, and
  **Save as host…**, which opens New host filled in from it (#537).
- **Terminal tab marks.** A terminal tab behind another one shows when it printed something new, when
  it waits for input (a password, passphrase or verification code prompt, or a yes/no question), and
  when its session failed or dropped. Each mark has its own shape as well as its own colour, split
  panes show theirs on the pane header, and screen readers hear each new mark. Going to the tab or
  pane clears it (#422).
- **Highlighted errors, warnings and addresses in terminals.** SSH and local terminals colour error and
  warning words, `info`, `notice` and `debug`, and IPv4 and IPv6 addresses in the scheme's red, yellow,
  blue and cyan, drawn over the output without changing it. Only whole words in the default colours
  count, so a program's own colours win, and full-screen programs are left alone. **Highlight output**
  (`terminal.highlightOutput`, on by default) in Preferences → Terminal turns it off and lists the rules
  (#424).
- **Identities: one user and sign-in for hosts in any group.** `hosts.yaml` can name identities
  (`identities: [{ id, name, user, auth }]`, credentials as `${secret:}` only) and a host or group
  picks one with `identity:`. A user or sign-in set on a nearer level still wins, one field at a
  time, and an unknown identity is refused when the file is read. **Keychain** lists identities with
  the hosts that use them, adds and edits them, and asks before deleting one in use; the host form
  has an **Identity** select above **User**, and the connection screen saves a typed password or user
  to the identity the host signs in through (#416).
- **FIDO2 security keys for SSH.** A host can sign in with a security key stored in the keychain
  (`sk-ssh-ed25519@openssh.com` or `sk-ecdsa-sha2-nistp256@openssh.com`): the connection screen says
  when to touch the key, and asks for its PIN when the key needs one, without storing it. **Generate
  key…** makes a non-resident security key on the key plugged in, Ed25519 or ECDSA, optionally asking
  for the PIN at every sign-in. A host that signs in with the SSH agent now also uses security keys the
  agent holds, which it skipped before. Not available on Windows yet (#420).
- **Mosh sessions.** A host or group can set `protocol: mosh`: Wirebench signs in over SSH, starts
  `mosh-server` there, and runs the session over UDP with the `mosh-client` installed on your computer,
  in the same terminal tab, so it survives dropped packets and network changes. An optional `mosh` block
  sets the server command and the UDP port or range. **Protocol** is under the host form's Advanced
  section, the details panel shows it, and the connection screen says plainly when `mosh-client` or
  `mosh-server` is missing (#419).
- **Empty places offer the next step.** A project with nothing in it shows **New REST API**,
  **Import definition…** and **Import cURL…** on the Start tab; once there is an API, Start offers
  **New request**, **Import…** and **Switch workspace…**. The empty Environments view has a
  **New environment** button, and opening Search puts the caret in its input. They use the same
  empty-state card as the SSH views (#565).
- **Findable requests.** Quick Open (`Ctrl+P`/`⌘P`) lists saved requests of every protocol as
  `METHOD name` with project › API › folder under it, and finds a REST request by its URL path too.
  The tree follows the active tab, unfolding to its request and selecting it, and a new request
  starts in rename mode in the tree. In the palette a search naming a group (**REST**, **History**)
  lists that group first, a protocol's commands also act on its open tab, and a command that
  can't run stays listed, greyed, with the reason. **History: Re-send Last Request** re-sends the
  newest entry of any protocol. A REST request's menu gains **Send**, **Copy as cURL**,
  **Copy URL**, **Run…** (the Runner on that one request) and **Move to…** (#543).
- **Data columns in autocomplete, honest runner marks and visible inherited settings.** While a
  Runner tab with a data file is open, its columns are offered as `${#Data#column}` when you type `${`
  in a request it runs, and `${#Data#…}` is no longer marked unresolved. A column is still read only
  as `${#Data#column}`, never as `${column}` (#569). In the Runner's results a request with no checks shows a grey ring instead of a green tick, and an amber
  mark when it got a 4xx or 5xx. A REST request's Settings tab shows each inherited value in its empty
  field, with a **from …** link to where it is set and **Inherit** on a changed checkbox; the timeout
  now names the project's Default timeout, which is what a send uses. Swagger 2.0 path parameters are
  filled from `x-example` on import (#560).
- **One frame for the SSH views, and New rule… in Port forwarding.** Hosts, Snippets, Layouts, Port
  forwarding, Keychain and Known hosts open on the same header: the view's name and count, a search
  (<kbd>⌘F</kbd>), its main action at the right and one line on what it is for, all at one width. An
  empty view says what it is for and offers its first step, and a search that hides everything offers
  **Clear search**. **New rule…** in the Port forwarding view picks a host and adds a rule to it without
  opening the host's settings. The SSH area's first tab is named after the view it shows, with its icon,
  instead of always saying Hosts (#535).
- **SSH through a SOCKS5 or HTTP proxy.** A host or a group can name a SOCKS5 or HTTP CONNECT proxy (host
  form → Advanced → Proxy), with an optional user and a password kept as a secret. The first hop of a
  connection, the host or its outermost jump host, is dialled through it, and the proxy resolves the
  host's name. Groups pass it down; **None** on a host under a group's proxy connects directly. The
  connection screen logs the proxy hop and says plainly when the proxy cannot be reached, refuses the
  sign-in or will not open the tunnel. Terminals, Files, port forwarding and `wirebench ssh forward` all
  use it, and the `ssh_config` importer maps `ProxyCommand nc -X 5` and `nc -X connect` lines (#417).

- **Terminal right-click menu, docked find bar and recording dot.** Right-clicking a terminal offers
  Copy, Paste, Select all, Find…, Clear, Split right, Split down, Run snippet…, Open files and
  Reconnect, each with its shortcut; on Windows and Linux Ctrl+Shift+C, V and A copy, paste and select
  all, leaving Ctrl+C to the shell. The find bar is now a strip above its pane that moves the terminal
  down instead of covering it or the reconnect notice, and closes when the pane's session ends or
  drops. A red dot on the tab and the pane header shows a session is being written to a session log.
  **Session Logs…** in the palette, or **All hosts…** in a host's details, lists every host's logs,
  and log rows now read like *11:09 · 16 B · exit 0* under the day they started (#534).

- **Connection screen for SSH terminals and Files.** Until the shell opens, a pane shows the steps of
  the connect: Resolving address, Connecting, Checking host key, Authenticating and Starting shell (or
  Starting SFTP). Each shows what it is doing, then a tick and how long it took, and the screen ends
  with **Connected in N ms** before fading into the terminal. A failed step turns red with one plain
  sentence, such as a refused port, no answer in time, a changed host key or a refused sign-in naming
  the methods the server allows, and offers **Retry**, **Edit host** and **Close**. **Show log**
  unfolds a timestamped handshake log that opens on its own when a connect fails, shows the lines that
  say what failed in red, and never holds a password, passphrase or key. A dropped session's reconnect shows its countdown on the same screen,
  with **Reconnect now** and **Stop**. Reduced motion shows no spinner or moving line (#528).
- **Fix a sign-in on the connection screen.** A host with no user starts no step: the screen reports it
  as a host setting and asks **Sign in as**, for this pane only or, with **Save to host**, into the
  host's settings. A refused password shows **Password for** *user* with **Save and retry**, which stores
  it as the host's password secret and connects again. **Retry** stays the main button for network
  failures only; after a refused sign-in or a host setting the fix comes first. A failed connect's log
  opens at its end with the failing line highlighted (#532).
- **Test MCP servers.** An MCP server is a fifth container beside SOAP interfaces and REST, gRPC and
  WebSocket APIs: a local process over stdio, Streamable HTTP, or the legacy HTTP+SSE transport.
  **New MCP server…** on a project creates one; its tab edits the connection (command, arguments,
  folder and environment, or URL, headers and auth) and shows its catalogue. **Refresh catalogue**
  fetches the server's tools, resources, templates and prompts into `catalogue.json` beside
  `api.yaml`, sorted so a refresh with nothing new saves the same bytes and a diff shows contract drift.
  A request runs one operation (`tools/call`, `resources/read`, `prompts/get` or a list) in its own
  session; a tool call's arguments are completed and marked from the tool's `inputSchema`. The response
  shows OK, a tool error or a JSON-RPC error, the content blocks by type, and every JSON-RPC message with
  the HTTP calls or the server's stderr. A stdio command runs only once this machine approves it (**Run
  once**, **Always allow** or **Cancel**, asked again when the command line changes); `wirebench run`,
  `send` and `mcp` refuse one unless given `--allow-commands`. MCP requests run in the Runner, sequences
  and the CLI with assertions, an "MCP result" check and scripts, and are kept in History. Servers that
  need NTLM, Digest, AWS Signature v4 or Kerberos are refused (`mcp-auth-unsupported`); MCP's own
  authorization discovery, long-lived sessions and answering server requests are not in this release (#79).

- **Import hosts from PuTTY, SecureCRT, MobaXterm and CSV.** **Hosts: Import Hosts…** (was **Import
  from SSH Config…**) now also reads a PuTTY registry export (`.reg`), a SecureCRT XML settings export, a
  MobaXterm `.mobaconf` or `.mxtsessions` file, and a CSV with the columns `name, address, port, user,
  group, tags, key, jump`. Each goes through the same preview, key choices and duplicate check as an SSH
  config, into one new group; the source's folders become subgroups inside it. Host, port, user, key
  file and jump host come across, PuTTY and SecureCRT port forwards become forwarding rules, and CSV
  tags become tags. Passwords are never imported, and the notes say how many were left behind. The
  registry itself is never read (#423).

- **SAML sign-in and SCIM provisioning on Wirebench Server (Enterprise).** With
  `WIREBENCH_SERVER_SAML_IDP_METADATA` set, the Sign in dialog offers **Continue with SSO** (the label is
  `WIREBENCH_SERVER_SAML_DISPLAY_NAME`), which signs in through the identity provider in the browser. The
  server checks the assertion's signature (SHA-256 or stronger), issuer, audience, recipient, validity
  window and that it answers the app's own request, once. SCIM 2.0 at `/scim/v2` creates, updates and
  deactivates accounts and stores groups; deactivating disables the account and revokes its devices,
  keeping its data. A server admin links IdP groups to teams, and SCIM removes only the members it added.
  The Team dialog gains a **Provisioning** tab for SCIM tokens, the values to give the identity provider
  and the group links; the server gains `admin scim-token` and `admin scim-group` commands. Neither
  creates an account at sign-in: accounts come from SCIM or an invitation (#344).

- **Scheduled runs on Wirebench Server (Enterprise).** A workspace's admins can schedule a project's
  requests or suites to run on the server, on a cron expression, `@daily` or `every 15m`, in a time zone
  and against an environment, with the run's secrets kept sealed on the server. Every role in the
  workspace reads the runs and their results. A run uses the workspace as last pushed and the same
  engine as `wirebench run`; it never overlaps the schedule's previous run, a server that was down runs
  each schedule once when it is back, and servers sharing a database never fire twice. A schedule that
  starts failing alerts by email, Slack, Teams or a signed webhook, mutes after a set number of
  failures and alerts again when it passes. Changes to schedules are audited, and
  `wirebench-server admin schedules` lists, enables and disables them on any edition (#343).
- **SSH certificates.** A key sign-in in `hosts.yaml` can carry its OpenSSH user certificate:
  `auth: { key, certificate, passphrase? }`, the certificate being a `${secret:NAME}`, inherited with
  the rest of `auth`. On connect the certificate is offered first, then the key alone; an expired or
  not-yet-valid certificate fails before connecting with `ssh-cert-expired` and its validity window.
  The keychain gains **Attach certificate…** on a key, stores it as `<key>_cert`, and shows its key ID,
  principals and validity, with a badge when it has expired or belongs to another key. The host form
  picks up a key's certificate with the key, `wirebench ssh forward` signs in with it too, and importing
  an SSH config maps `CertificateFile` (#421).
- **Import trusted keys from known_hosts.** The Known hosts view (and **Hosts: Import Known Hosts…**)
  reads `~/.ssh/known_hosts` or a chosen file and trusts its keys for the hosts in `hosts.yaml` they
  name: plain and `[host]:port` names, comma lists, wildcard patterns with `!` negation, and hashed
  names, which are matched against each host's address and port. The preview lists the keys to trust,
  the keys that differ from one already trusted (kept unless you tick **Replace**, which then needs the
  same changed-key confirmation as a connect) and what is not imported: `@cert-authority` and
  `@revoked` lines, lines that name no host, a second key of a type a host already has, and lines that
  cannot be read (#418).
- **Add hosts from known_hosts.** A server a plain known_hosts line names that `hosts.yaml` does not
  have is listed under **Not in hosts.yaml** with its address, port and keys. Ticking it adds it as a
  host named after its address, with no user (so it shows "needs user"), at the top level or in the
  group picked in the dialog, and trusts its keys. Nothing is added unless ticked, and hashed lines
  still name no host to add (#572).

- **Session logs for SSH terminals.** A host's details gain **Session logs**: a **Log sessions** switch
  (also on a group's menu, inherited by the hosts inside) and the logs this machine kept, newest first,
  which can be searched, opened and filtered, revealed in the file manager or deleted. A log is the
  session's output as plain text with escape sequences removed, beside a `.json` file with the host,
  user, start, end and exit code; what a full-screen program draws is left out. Passwords, keys and
  passphrases used to connect, and secrets typed by a snippet, are masked, and only output is written.
  Logs and switches stay on this machine. Settings › Terminal sets the size limit for all logs (500 MB
  by default; the oldest go first) and can keep the raw stream too (#414).
- **Local terminal.** **Terminal: New Local Terminal** (<kbd>⌘⌥T</kbd> / <kbd>Ctrl+Alt+T</kbd>, or
  **New local terminal** in the SSH sidebar) opens a tab with a shell on this machine, beside the SSH
  terminals: your login shell on macOS and Linux, PowerShell 7 (else Windows PowerShell) on Windows,
  or the program **Preferences → Terminal → Local shell** names. It starts in a shared workspace's
  own folder, otherwise in your home folder. It keeps the SSH terminal's theme, paste guard, copy on
  select and find, and shows **Shell ended (code N)** with **Restart**. `WIREBENCH_AREAS=ssh=off`
  removes it with the SSH area, and `WIREBENCH_AREAS=local-terminal=off` removes it alone (#410).
- **GraphQL requests.** A REST request's body can be **GraphQL**: a query or mutation, its variables
  and, for a document with several operations, the one to run. It goes out as the JSON body a
  GraphQL server reads, with the API's auth, environments, History, scripts, runs and sequences. An
  API's menu gains **New GraphQL request**, and the explorer shows `GQL` for one. **Fetch schema**
  sends the introspection query through the request itself, and **Import schema…** reads SDL or an
  introspection result. Either way the schema is stored in the project as
  `apis/<api>/graphql/schema.graphql`. With a schema, the query editor completes, validates and
  documents on hover, and the variables editor completes and type-checks the operation's variables.
  A response's `errors` show on a chip, on the body and in Problems, and fail a run's **GraphQL
  errors** check, even on HTTP 200. `data` that does not match the schema is a warning. Postman,
  OpenCollection and `.http` GraphQL requests now import as GraphQL, and a Postman export writes them
  back as GraphQL (#77).

- **Terminal font, size and colour scheme, per host or group.** Settings → Terminal gains
  **Appearance**: the font family, picked from the machine's monospaced fonts, the size, the line
  height and a colour scheme. **Follow app theme** stays the default. The built-in schemes are three
  tinted backgrounds (red, amber, green) and the open palettes Solarized Dark and Light, Dracula,
  Nord, Gruvbox Dark, One Dark and Tomorrow Night. `hosts.yaml` takes `terminal: { scheme,
  fontSize }` on hosts and groups, inherited per field, and the host form shows what a level
  inherits and from where. Open terminals restyle when a setting changes. **⌘+** / **⌘−** / **⌘0**
  resize the focused terminal only, until it closes (#411).

- **Environment variables per host or group.** `hosts.yaml` takes `env: { NAME: value }` on hosts
  and groups, merged by name down the tree so a nearer level wins for each variable; a value is
  text or a `${secret:NAME}` token. They are sent as SSH `env` requests when a terminal opens (the
  server keeps the names its `AcceptEnv` allows), and a value read from a secret is masked on
  screen. The host form edits them and shows the inherited ones with their group, the details panel
  lists where each comes from, and importing an SSH config now maps `SetEnv` (#412).

- **SSH agent forwarding per host or group.** `hosts.yaml` takes `ssh.forwardAgent: true`, inherited
  down the tree and off by default. A terminal on such a host forwards your local agent, so `git pull`
  or another `ssh` on the remote can use your keys; a jump host never gets it. The host form shows the
  inherited value and a warning while it is on, the terminal tab shows a key while the agent is
  forwarded (and says why when the server refused or no agent runs), the details panel and its `ssh`
  command show it, and importing an SSH config now maps `ForwardAgent` (#413).

- **Environments can apply to selected projects.** A workspace environment's page has **Applies to:
  All projects | Selected projects**, with a project list that starts with every project ticked. A
  project is offered only the environments that apply to it, in the title-bar switcher (grouped as
  **All projects** and the current project), in **Send to environments…** and on the command line,
  and the Environments view shows the projects as chips. Each project now keeps its own active
  environment: moving to a tab of another project shows that project's choice. Removing a project
  drops it from every scope and deletes its endpoint overrides; an environment left with no
  project is kept as **No project**. `wirebench run`, `call` and MCP refuse an environment that
  does not apply to the project with exit code 2 (`environment-out-of-scope`), listing the ones
  that do, and `--env` is required only when one applies (#468). Opening the workspace in an older
  build afterwards resets this machine's local state for it: the active environment and the local
  secret-source overrides.

- **Snippets in the SSH area.** The SSH menu gains **Snippets**: the workspace's `snippets.yaml`, beside
  `hosts.yaml`, shown as packages of snippets with a filter (⌘F) and tag chips. A snippet opens in the right
  panel to edit its name, package, tags, description and script, whose `${…}` tokens are marked as declared
  variables, secrets or shell text; a `${name}` the script uses can be declared as a variable in one click,
  and **Insert secret** puts `${secret:NAME}` at the cursor (the value never enters the file). Snippets
  duplicate, move between packages and delete; packages are created, renamed and deleted once empty. A file
  that does not parse shows in the view and in the Problems tab (#450).
- **Run a snippet in a terminal.** **Run** and **Insert** (Insert leaves the line at the prompt) on a
  snippet's row, in its menu and in its editor, or a double-click on the row. A run asks for the snippet's
  variable values (remembered on this machine) and shows the terminal it will type into and the script as
  typed; it runs at once in the terminal in front when there is nothing to ask. A value with a line break or
  a control key is refused. `${secret:…}` values are typed by the app itself, never shown: the line starts
  with a space so most shells keep it out of history, and the value shows as `••••` in that terminal for the
  rest of its session. A snippet changed on disk since it was shown is not run (#451).
- **Run a snippet on several hosts.** The run dialog lists the open terminals with checkboxes and adds
  hosts, groups and tags as chips that show the hosts they stand for; the button reads **Run on N hosts**,
  counting each host once, and every protected host is named with the group it inherits that from. A host
  reuses its most recently used open terminal, or gets a new tab that is written to once the shell has
  printed its prompt (or after 10 s). Hosts run in parallel: one waiting on a host key or a sign-in holds
  back none of the others, and one toast sums the run up ("Ran on 3 of 4 hosts · api-4: …"). The last
  targets are remembered per snippet (#452).
- **Snippet suggestions in the terminal.** Typing the start of a snippet's first line (three characters or
  more, case exact) shows the rest of that line dimmed after the cursor, with the snippet's name and `Tab`
  at the right edge; when several match, the one run most recently wins. **Tab** completes it without
  pressing Enter, asking for the snippet's variables first (and in the run dialog for a protected host or a
  snippet that asks to confirm); Tab without a suggestion reaches the shell as before. Nothing is suggested
  after cursor or editing keys, history recall or a paste until the next Enter, on the alternate screen
  (an editor or pager), or while disconnected. **Settings › Terminal › Suggest snippets**
  (`terminal.snippetSuggestions`, on by default) turns it off (#454).
- **Snippets from the palette.** ⌘K **Run Snippet…** lists the snippets, matched on name, package, tags and
  first line; Enter runs the one picked into the terminal tab in front (through the run dialog when the run
  must ask), or opens the run dialog when no terminal is in front. ⌘P lists them under a **Snippets**
  heading. Inside a terminal, ⌘; (Ctrl+; on Windows and Linux) opens a snippet picker over it without the
  shell seeing the key: Enter runs the snippet there, ⌥Enter inserts it without pressing Enter, Escape returns
  to the shell. New commands: **Show Snippets**, **Snippets: New Snippet…**, **Snippets: Edit Snippet…**,
  **Snippets: Run Snippet** and **Terminal: Snippets…** (#453).
- **A Files tab for SFTP.** **Open files** on a host card, **Files** in a host's details or on a terminal
  tab, or ⌘K **Open Files on Host…** opens a Files tab with two panes: this machine on the left and the
  host on the right. Each pane's header switches it to this machine or to any host, so a copy can also
  go from one host to another. Drag a selection onto the other pane, or drop files from the desktop on a
  host's pane, to copy them. A name that already exists asks whether to replace, skip or keep both, and
  every copy is written to a part file first, so a cancelled or failed one leaves the target as it was. A
  strip lists the transfers with their progress and speed, Cancel and Retry. A pane renames (F2),
  deletes, makes folders, changes permissions and shows hidden files on request. Opening a host's file
  edits it in the system's editor and uploads each save, asking first when the file changed on the host
  in the meantime (#357, #439–#445).
- **Port forwarding.** Hosts and groups in `hosts.yaml` take `forwards`: local, remote and dynamic
  (SOCKS5) rules, inherited down the groups, which a nearer level replaces by id or switches off. The
  host and group forms edit them. The SSH menu's **Port forwarding** view, and a section of the host's
  details, list every rule with its state and start, stop or retry it, and the status bar shows `⇄ N`
  while N forwards run, red when one has failed. A rule set to start with the host's terminals starts
  with its first terminal and stops with its last. A rule bound to an address other machines can reach
  asks once before it opens. A port already in use is refused, naming the forward that holds it, and
  **Start on another port…** offers a free one. A dropped connection reconnects with the port kept
  (#358, #456–#459).
- **`wirebench ssh forward`.** `wirebench ssh forward <host> [rule…]` opens a host's forwarding rules from
  the workspace's `hosts.yaml` and keeps them open until it is stopped. It reads secrets as
  `wirebench run` does and host keys from the app's known hosts, and `--host-key` accepts a new key for
  one run. `--json` prints each status change as a line of JSON (#460).
- **Split terminals.** **Split right** (⌘D) and **Split down** (⌘⇧D) on a terminal tab open another pane
  on any host, up to 12 in a tab. ⌘⌥ and an arrow move to the next pane, a divider drags and evens out on
  a double-click, and ⌘W closes the focused pane only. **Open in new tab** in a host's menu always opens
  another tab. On Windows and Linux Ctrl+D now splits rather than reaching the shell; Shortcuts can
  rebind it (#462).
- **Broadcast input to several panes.** **Broadcast** on a split terminal tab sends what is typed in a
  ticked pane to every ticked pane that is connected. A red banner says how many panes receive it and
  whether one missed input, ticked panes get a red border, and a paste into them always asks first
  (#464).
- **Saved terminal layouts.** **Save layout…** on a terminal tab's toolbar (or ⌘K **Terminal: Save Layout…**)
  keeps the tab's panes, hosts and split ratios as a named layout; a tab opened from a layout offers **Update**
  or **Save as new…**. The SSH menu gains **Layouts**, listing each layout's hosts and pane count with **Open**,
  **Rename** and **Delete**, and ⌘K **Open Layout…** and ⌘P list them too. Opening one connects every pane in
  one tab titled by the layout. A pane whose host has left `hosts.yaml` says so and offers **Remove pane**, and
  saving again leaves it out. Layouts are kept on this machine per workspace (`ssh-layouts.json` in the app's
  data folder), never in the workspace, sync or a team (#463).
- **Protected hosts.** A host or a group can be marked **Protected** in its form, inherited like the other
  settings; a protected host shows a shield on its card and in its details (#450).
- **Recent SSH connections.** The Hosts tab shows the hosts you connected to lately in a **Recent** strip
  (when, and whether the last connect failed) with a connect button and **Clear**, and gains a
  **Recently connected** sort; **Connect to Host…** and quick-open list recent hosts first. The list is
  kept on this machine per workspace with only the host id, time and outcome; deleted hosts drop out and
  renamed ones show by their new name (#408).
- **Generate an SSH key and install it on a host.** The Keychain's **Generate key…** makes an Ed25519
  (default), ECDSA (P-256, P-384, P-521) or RSA (4096, 3072, 2048 bits) key with an optional passphrase,
  and stores the private key as a workspace secret (the passphrase as `NAME_passphrase`); the private key
  never leaves the main process. A key's row shows its type and fingerprint, copies its public key in
  OpenSSH format, and **Install on host…** (also on a host's menu as **Install public key…**) signs in as the
  host does now and appends the key to `~/.ssh/authorized_keys`, creating `~/.ssh` (700) and the file (600)
  when missing and skipping a key already there. It then offers to switch the host's sign-in to the key
  (#409).
- **Find in a terminal's scrollback.** ⌘F (Ctrl+F on Windows and Linux) in a focused SSH terminal opens a
  find bar over the output: next and previous match, match case, whole word and regular expression, and a
  match count. Matches are highlighted in the theme's colours; Escape closes the bar and returns the keys
  to the terminal. The shortcut never reaches the remote shell, and other tabs keep their own ⌘F (#406).
- **A terminal session the network drops reconnects on its own.** After a reset, a timeout or a jump
  host's connection ending, the tab keeps its scrollback and tries again after 1, 2, 4, 8 and 16
  seconds, then every 30 seconds, showing "Reconnecting… attempt 2 of 10" with a countdown, **Retry
  now** and **Cancel**. Waking from sleep or the network coming back tries every waiting tab at once. A
  shell that exited, a sign-in failure or a changed host key never reconnects. Preferences → Terminal
  turns it off (`terminal.autoReconnect`) and sets the attempt limit (`terminal.reconnectAttempts`, 1 to
  100, default 10) (#407).

- **Client-signed JWT auth.** A REST, gRPC or WebSocket request, folder or API can send a JWT that
  Wirebench signs itself, with HS, RS, ES or PS at 256, 384 or 512 bits. The claims and extra header
  fields are JSON whose strings take `${…}` properties, and `iat`, `exp` and `jti` can be generated.
  The HMAC secret is a secret-store reference and the private key comes from a keystore, never from
  the project file; a PEM keystore may now hold just a private key. The token goes in a header with a
  configurable name and prefix, or in a query parameter, and is reused until 30 seconds before it
  expires. It works in the app, `wirebench run` and MCP `send`; the headers preview, **Copy as** and
  generated code show a freshly signed token while secrets are shown (#348).
- **AWS Signature v4 and Digest auth.** A REST or SOAP request, folder, API, interface or endpoint can
  sign with **AWS Signature v4**: region and service, which take property references, an access key
  ID, a secret key and an optional session token, all kept in the secret store, in an
  `Authorization` header or as a presigned URL with its own expiry. The body is always hashed, and S3
  also gets `X-Amz-Content-Sha256`. The Headers tab shows the signature headers before you send, and
  the HTTP log shows each signed send's canonical request and string to sign. The signer matches
  AWS's published test suite. **Digest** answers the server's 401 challenge with MD5 or SHA-256 (and
  the `-sess` forms) and `qop=auth`, or the older form without `qop`. The nonce is remembered per
  origin for the session, so later requests skip the 401 and count `nc` up, and a stale nonce is
  answered once. cURL import reads `--digest` and `--aws-sigv4`, storing every value as a secret, and
  the cURL export writes them. `wirebench run` and the MCP `send` read the credentials from
  `WIREBENCH_SECRET_*`. gRPC and WebSocket refuse both schemes by name (#339).

- **`wirebench lint` checks an OpenAPI 2.0, 3.0, 3.1 or 3.2 document.** A built-in hygiene rule set
  checks descriptions, examples, `operationId`s and reusable schemas. A built-in OWASP API Top 10 rule
  set checks for no security scheme, credentials or OAuth endpoints over plain HTTP, and undefined
  security schemes and OAuth scopes. A project's `lint/` folder (and `--ruleset <file>`) switches
  rules off, changes their severity, or adds rules as a target and a check. Findings print as
  `file:line:column`; `--reporter json=<file>` and `--reporter sarif=<file>` (SARIF 2.1.0, for code
  scanning) write reports, and `--fail-severity` sets the exit code. `$ref`s stay inside the document's
  folder, and a local document reaches the network only with `--allow-remote-refs`. In the desktop
  app, **Lint Definition** on a REST API puts the same findings in Problems, and so does an OpenAPI
  import or a definition update (#342).
- **More OAuth 2 grants and client authentication.** The password grant (a username and a password
  from the secret store) and the device-code grant (RFC 8628: **Get token** shows the code and opens
  the verification page) join client credentials and authorization code. The client can now
  authenticate with a signed assertion, `client_secret_jwt` (HMAC) or `private_key_jwt` (a keystore's
  key, RS, PS or ES, the algorithm following the key unless chosen), or with the keystore's
  certificate (`tls_client_auth`). `wirebench run` runs the password grant and refreshes tokens
  headless, and starts an authorization-code or device-code configuration from a refresh token in
  `WIREBENCH_SECRET_<refreshTokenEnv>`. OpenAPI, Postman and OpenCollection imports map the password
  flow, OpenAPI 3.2's device flow maps to device code, and exports write the password grant (#338).

- **Forwarding groups.** Name a set of port forwarding rules, from any hosts, and start or stop them
  together. The Port forwarding view shows each group as a section with its rules and a count such as
  "2 of 3 running · 1 failed", then the rules in no group under **Ungrouped**. **Start group** connects to
  each host as needed, and a rule that fails doesn't stop the others. Each rule still starts and stops on
  its own. Groups are kept in `hosts.yaml` (`forwardGroups`, file version 2 while there is one), so a
  team shares them; version 1 files load unchanged. The palette has **Start Forwarding Group…** and
  **Stop Forwarding Group…**, and `wirebench ssh forward --group <id>` opens a group from the command
  line (#583).

- **Install files for Homebrew, winget and the team server.** Each release's draft carries
  `wirebench-package-manifests-<version>.zip`: a Homebrew cask that picks the Apple silicon or Intel
  `.dmg`, and a winget manifest set for the per-user setup files, both hashed from the signed installers.
  The repository keeps the files for the latest published release under `packaging/`. A root
  `docker-compose.yml` runs the published Wirebench Server image beside PostgreSQL 16, and a new Getting
  started page walks a team through it (#601).

- **Run imported Thunder Client scripts.** A Thunder Client export's pre-request and post-request scripts
  are attached to their requests, folders and API, switched off, instead of being saved as text. Once
  switched on they run against `tc` (`tc.test`, `expect`, `tc.getVar` and `setVar`, `tc.replaceVars`,
  `tc.request`, `tc.response`, `tc.info` and `tc.skipRequest()`); `tc.runRequest`, the cookie calls,
  `tc.loadModule`, `require`, the global `assert` and the rest fail with `script-unsupported`, and the
  import report lists them. `tc.request.url` is a plain string, so `url.getParam` and `setParam` are a
  known gap. `wirebench import` attaches them too.
- **Scripts on a dropped collection or folder are kept.** In every client's import, the scripts of a
  collection the import drops for having no HTTP request (and, for Insomnia, of a dropped folder) are
  saved as text under `imported-scripts/`, with a note naming the file.
- **Run imported Hoppscotch scripts.** A Hoppscotch export's pre-request and test scripts are attached
  to their requests, folders and API, switched off, instead of being saved as text. Once switched on
  they run against `pw`, `hopp` and `pm`, with Jest-style matchers on `hopp.expect`; `hopp.fetch`,
  `hopp.cookies`, `hopp.request.setAuth`, `require` and a top-level `import` fail with
  `script-unsupported` (an `import` is refused before the script runs), and the import report lists
  them per request. `wirebench import` attaches them too.
- **Run imported Bruno scripts.** A Bruno collection's pre-request, post-response and `tests` scripts are
  attached to their requests, folders and APIs, switched off, instead of being saved as text. Once
  switched on they run against `bru`, `req`, `res`, `test` and an `expect` with `.jsonSchema`;
  `bru.sendRequest`, `bru.sleep`, `bru.cookies`, `require` and the request-settings calls fail with
  `script-unsupported`, and the import report lists them. An API's new **Post-response order** setting
  (Outermost first or Innermost first) takes `bruno.json`'s `scripts.flow`. Module `.js` files and
  scripts on a level that cannot hold one stay under `imported-scripts/`. OpenCollection imports attach
  their scripts the same way, as `bruno`, switched off. `wirebench import` attaches them too.
- **Run imported Insomnia scripts.** An Insomnia export's pre-request and after-response scripts are
  attached to their requests and folders, switched off, instead of being saved as text. Once switched on
  they run against an `insomnia` object (`insomnia.test`, `insomnia.expect`, `insomnia.response`,
  `insomnia.request` and the variable scopes); `sendRequest`, `require`, cookie writes and the vault fail
  with `script-unsupported`, and the import report lists them. `wirebench import` attaches them too.
- **Share a live terminal.** On an Enterprise server, **Share session** in an SSH terminal's menu lets
  members of the shared workspace watch it: they join from an invite link with **Terminal: Join Shared
  Terminal…** and see the screen as it is, masked the same way. A viewer can ask for control; the owner
  approves, takes it back or stops sharing in one click. The server relays the screen and stores
  nothing but audit rows (#429).
- **Team session logs.** A workspace admin on an Enterprise server can turn on **Record SSH
  sessions** for a shared workspace: every member's SSH sessions on its hosts are then logged, masked
  as local session logs are, and streamed to the server while they run. **Terminal: Team Session
  Logs…** lists and reads them, filtered by host or member; each read is audited, logs are kept as long
  as audit events, and an admin can delete one sooner (#430).
- **Device keys.** **Generate key…** can make an SSH key in this machine's secure hardware: the Secure
  Enclave on macOS (`ecdsa-sha2-nistp256`), or Windows Hello on Windows (RSA, experimental). The keychain
  stores only a handle that this device alone can use, and every sign-in asks for Touch ID or your password
  (Windows Hello on Windows). Its public key installs on hosts like any other. On another machine the key is
  marked "other device" and a connect says where it was made. The key cannot be copied or recovered, so the
  dialog suggests keeping a second way into the same hosts. The CLI cannot use device keys (#428).
- **App lock.** **Settings → Secrets → App lock** asks for biometrics or your password before the first SSH
  secret is used after launch, again after a set idle time (15 minutes by default) and after the screen
  locks. It is off by default. Turning it on asks once, and the rest of the app stays usable while it is
  locked (#428).
- **Terminal type and character set per host.** A host or group's `ssh` settings take `term`, the
  terminal type the shell is opened with (`xterm-256color` by default, for example `vt100` or
  `vt220`), and `charset`, the character set its text is read and written in: UTF-8 by default, or
  one of ISO-8859-1/2/5/7/9/15, Windows-1250/1251/1252/1253/1254/1257, CP850 and KOI8-R. Both
  inherit like the other host settings and fall back to new **Settings → SSH** defaults; the host
  form shows them under **Advanced**. They apply to SSH shells and Telnet; a serial console
  uses the character set; Mosh stays UTF-8 (#427).
- **Telnet hosts.** A host or group can set `protocol: telnet` to open a Telnet session in the same
  terminal tab, with panes, find, snippets and session logs. Wirebench negotiates the terminal type and
  window size, and types the host's user and password at the device's login and password prompts when they
  are set. It connects straight, through the host's proxy, or through an SSH jump host. The form, the
  details panel and the terminal all say the session is not encrypted, and Files, port forwarding, agent
  forwarding and keys are hidden for these hosts. `WIREBENCH_AREAS=telnet=off` switches Telnet off for a
  build (#425).
- **Serial consoles.** A host or group can set `protocol: serial` to open a serial port on this computer
  (a USB serial adapter or a built-in port) in the same terminal tab, with panes, find, snippets and session
  logs. The line settings (baud, data bits, parity, stop bits and flow control) live in `hosts.yaml`; the
  device each console opens is remembered per computer, picked in the host form from this computer's ports
  or on the connection screen the first time. Address, sign-in, jump host, proxy and the SSH-only features
  are hidden for these hosts. `WIREBENCH_AREAS=serial=off` switches serial consoles off for a build (#426).
- **Make secret on credential-like variables.** A variable named like a credential (`token`,
  `password`, `apiKey`…) with a plain value now offers **Make secret** in its row: the value is stored
  as a project secret on this machine and the row keeps `${secret:name}`. On a workspace scope it is
  stored for every project the scope applies to. A name the project already has is refused, never
  overwritten (#634).
- **Scheduled runs in the app.** A workspace shared on a server that runs schedules shows a
  **Schedules** node in the Explorer: each schedule with a green, red or grey dot and, while failing,
  how many runs failed in a row. Opening one shows its runs, newest first, and each run's results as
  the Runner shows them, with the exchange of a failed request and how its alerts were delivered; a run
  that ends appears without a refresh. **Schedule…** on a project, API, folder, request or sequence
  opens a new schedule that runs it, picked from the open workspace. Workspace admins create, edit,
  pause, run now, set secrets, test alerts and delete; everyone else reads (#517).
- **Import Insomnia exports.** **Import…** reads Insomnia's export formats 4 (JSON or YAML) and 5
  (YAML), and detects a picked file by its content. Each workspace becomes a REST, a gRPC and a
  WebSocket API in the chosen project, in Insomnia's order, with folder headers and auth. The base and
  folder environments become project properties and the sub-environments workspace environments,
  never made active; an environments file goes to the workspace, its base into Globals. Vault secrets
  become secrets with no value, scripts are attached to their requests and folders switched off, and
  template tags Wirebench cannot run are kept and listed. `wirebench import` reads the same files.
  Postman collections now bring Digest, AWS Signature and JWT auth across as well (#588).
- **Import Bruno collections.** **Import…** reads a Bruno collection from its folder (**Folder…**),
  its `bruno.json` or a JSON export, in Bruno's order. Its requests become a REST, a gRPC and a
  WebSocket API in the chosen project, with collection and folder headers, auth and variables; each
  environment becomes a workspace environment, never made active, its `vars:secret` names secrets
  with no value. `assert` lines become assertions where they fit, scripts and tests are attached to
  their requests switched off, and a `.env` file is never read. `wirebench import` reads the same sources. The
  OpenCollection import now also maps Digest and AWS Signature v4 auth, `omitHeaders`, descriptions
  and lists of WebSocket messages (#588).
- **Import Hoppscotch exports.** **Import…** reads Hoppscotch collections and environments files at
  every schema version, each collection, folder and request at its own. Each top-level collection
  becomes a REST API in the chosen project, GraphQL requests with a GraphQL body, saved responses as
  examples; collection and folder variables become project properties, a secret one with no value.
  An environments file goes to the workspace, never made active, its `Global` environment into
  Globals. Scripts are attached to their requests, folders and API switched off, so they run
  once you read and switch them on. `wirebench import` reads collections files (#588).
- **Import Thunder Client exports.** **Import…** reads Thunder Client collection and environment
  exports, a `thunder-tests` folder (picked with **Folder…**) and the older four-file folder. Each
  collection becomes a REST API with its base URL as the server, its folders and requests in order;
  status, response-time and JSON-path tests become assertions. Environments go to the workspace,
  never made active, the global one into Globals; encrypted values and `.env` files are listed, not
  read. Scripts are attached to their requests, folders and API switched off, so they run once you
  read and switch them on, and request chaining is reported. A folder that keeps one file per
  request is refused. `wirebench import` reads exports and folders (#588).

### Breaking

- **Project format 11.** A `scripts` key can name the script API of another API client (`insomnia`,
  `bruno`, `hoppscotch` or `thunder-client`) and carry `postResponseOrder`. A project saved by this
  version cannot be opened by an older one, which refuses it as made by a newer Wirebench. A
  version-10 project opens unchanged.

- **Project format 10.** Auth can be a client-signed JWT (`type: jwt`), Digest (`type: digest`) or
  AWS Signature v4 (`type: aws-sigv4`), and OAuth 2 gains the password and device-code grants and the
  assertion and certificate client authentications. A REST request's body can be GraphQL
  (`kind: graphql`, with its query in `<Request>.body.graphql`), and an API can record its GraphQL
  schema (`graphqlSchema`). A project saved by this version cannot be opened by an older one, which
  refuses it as made by a newer Wirebench. A version-9 project opens unchanged (#338, #339, #348,
  #77).

### Changed
- **`wirebench import` refuses every format whose protocol is off (#765).** An Insomnia, Hoppscotch,
  Thunder Client or Bruno export and a folder collection are refused with `feature-disabled` when REST
  is off, as a WSDL was with SOAP off and an OpenAPI document with REST off; the app's Import dialog
  already left those formats out. `--reporter` ids are now looked up in one registry of importers,
  reporters and code generators, the groundwork for plugins (ADR-0031); the ids and the files they
  write are unchanged.

- **Wirebench Server is under the Elastic License 2.0.** The server package, `packages/server`, moves from
  Apache-2.0 to the Elastic License 2.0: free to run for your own company and to modify, not to offer to
  third parties as a hosted or managed service, and not to run with the license file check circumvented.
  The desktop app, the engine, the CLI, the SSH package, the integrations, the site and the docs stay
  Apache-2.0. Community, Team and Enterprise are unchanged: a server with no license file is still Community
  with five enabled accounts, and nothing shipped as free becomes paid
  ([ADR-0028](docs/adr/0028-the-server-is-licensed-under-the-elastic-license-2-0.md)).
- The developer variable `WIREBENCH_KINDS` is gone; `WIREBENCH_FEATURES="grpc=off"` takes its place in a
  development build, and the `features` preference in a shipped one (#735).
- **Remove from workspace keeps the project folder unless asked.** The **Move the project folder to
  the trash** box in **Remove project?** starts unchecked, so tidying the workspace list never moves
  files on its own; tick it to trash the folder as before (#684).
- **SOAP, after a daily-use review (#725–#732).** Imported requests are named after their operation
  ("Add", or "Add (SOAP 1.2)" when a 1.1 and a 1.2 binding offer it) instead of "Request 1" (#726).
  Importing a WSDL already in the project asks **Update Definition…** or **Import as a copy**, a copy
  named "Calculator (2)" (#727). The request tabs fit: Details folds into Properties, SSL stays on the
  response, and Headers, Attachments and Assertions carry counts that a **More · Assertions 1** button
  repeats when they are hidden. Properties keeps what has no other home, with a line of help on each
  row: the MTOM flags moved under Attachments and the WSS password type and time to live under Auth.
  Auth says what an inheriting request sends and from where ("Inherits None from Calculator"), and the
  WSS pickers gain **New…** and **Edit…**; WS-A inherit says whether WS-A is on and shows the values a
  send would carry. The tree drops the **Operations** folder, lists a 1.1 and 1.2 binding's operation
  once ("SOAP 1.1 · 1.2") with icons for operations, requests and endpoints, and a request's menu gains
  **Send**, **Copy as cURL** and one **Recreate from definition** submenu. **soap** in the palette
  leads with Import, New Request, Update Definition, Send and Validate, and a command whose name matches
  ranks above one only its group matches. WS-Security configurations open in the right panel, where
  every label and each password field's name fit, marked unsaved and asked about on close (#730, #731,
  #732).

- **A password left empty is asked for as a sign-in step, and used once.** Connecting to a host whose
  password was left to be asked shows **Sign in to box** with the password field and **Connect**, instead
  of a red missing-secret error; the password is used for that connection only, and **Remember on this
  machine** stores it. When the SSH agent cannot sign in (none runs, or the server takes none of its keys),
  the connection screen offers the same password field, for quick connects too (#721, #722).
- **Snippet Run reaches every pane.** In a split tab, the Run dialog lists each connected pane
  (**Box pair · box**, **Box pair · box-2**) and types into the one picked (#723).
- **SSH polish.** The host form's footer line wraps instead of being cut; the SSH menu keeps its labels in
  a narrow sidebar; a card's full target shows on hover; with an identity, the sign-in choices sit two by
  two and the inherited note reads **Inherited from identity Tester: password tester_password**. A forward
  rule in the host panel stacks its fields, and **New rule…** names the rule after its target
  (**localhost-6000**). **Generate key** fills in the real `user@host` comment. The serial port field gives
  this platform's example, and the form drops the line summary that repeated its fields. The share strip
  says **has control**, host details say **not detected** for an OS the host never gave, and Keychain says
  **No identities yet.** Files and **Save layout…** wait for a connected pane, the terminal scrollbar is
  faint on light schemes, and a pane that reconnected loses its error mark (#723).
- **Palette: SSH commands come first in the SSH area, and protocols find New host.** Typing in the
  palette ranks the area's lead commands (**Connect…**, **New Host…**) above the area's other commands
  that match only by area, a shorter name wins a tie, and "telnet", "serial" or "mosh" find New host and
  Connect (#714, S40, S68).
- **Host forms say which fields are missing, beside them.** Each empty required field reads what it needs
  under its label, and the footer counts them (**2 fields need a value**). An SSH or Mosh password left
  empty is asked for when connecting, as the form now says, instead of blocking Save; a Telnet password
  stays as before. The Telnet sign-in note sits under the sign-in fields, and the Mosh server command and
  UDP ports moved under **Advanced** (S59–S62).
- **Host cards and details.** A host card no longer repeats its OS in the subtitle; the icon still names
  it (#715). A connected host's details lead with **Go to terminal** and **New session**, and long values
  wrap instead of being cut (S50, S51). The New card stays first in its group and names the protocol until
  an address is typed (S45, S46). An empty group offers **Add host** inline (S49). The SSH sidebar's
  button reads **Local terminal** (S69).
- **SFTP toolbar and dates.** The Files toolbar shows labels when there is room and icons with tooltips
  when there is not, and **Modified** shows the time for today and a short date otherwise (S66).
- **New host opens in the right panel, with a draft card in Hosts.** New host (the Hosts button and its
  menu, a group's Add host, the empty state, **Hosts: New Host…** and **Save as host…**) opens its form in
  the right panel, where Edit host already was, instead of a dialog over the hosts. While it is open, a
  dashed **New** card stands in the group the form names, picked, and shows the name and address or
  serial line as they are typed; Save turns it into the host's card. **Duplicate** now opens the same form
  filled in from the host and writes nothing until Save. Leaving a New host or Edit host form with changes
  in it (Cancel, <kbd>Esc</kbd>, closing the panel, picking another host) asks first. **Protocol** moves up
  under **Name** in the host and group forms, since it changes the fields below it (#674).

- **A REST response viewer that shows what each view is for.** Preview is offered only where it
  renders something, an image or an HTML page; a separate **Hex** view dumps the bytes of any body,
  and a binary body opens on it. The response tab that shows both directions' wire bytes is now
  **Exchange**, so it no longer shares the name of the body's **Raw** view. **Pretty** formats HTML
  as well as JSON and XML, one tag per line with script, style and pre content kept as it came, and
  its **Wrap lines** toggle holds for the rest of the session. The Query tab opens a JSON body on
  JSONPath and an XML one on XPath, and its Run button shows Ctrl+Enter on Linux and Windows (#574).
- **SSH area polish.** The Hosts cards keep the name on the first line and put "needs user" under it;
  group chips give way to a ⋯ menu on each group heading with **Show only this group**; the SSH menu
  hides zero counts and shows running forwards as a green dot; Recent shows only with more than six
  hosts; a key's Copy public key, Attach certificate… and Set value… sit in its ⋯ menu; forwarding rows
  say Local, Remote or Dynamic and "from this host" or "from group X", and the rule form's Id is Name;
  the split picker puts the current pane's host first and marks hosts that need a user; the Files tab has
  a toolbar and one selection style; a snippet run with an empty variable asks first; Settings search
  finds Terminal under "ssh"; <kbd>Ctrl+Shift+P</kbd> opens the palette from a terminal, and the title
  bar says so; and the status bar shows the focused session instead of the request items, without
  counting failed SSH connects as request problems (#537).
- **A quieter console on a first run.** A fresh workspace starts with the console collapsed, and the
  first send opens it on the HTTP Log; after that it stays open, closed or at the height you leave it.
  The WS-I Report tab shows only when the workspace has a SOAP interface. The HTTP Log's method,
  status and protocol choices move into a **Filters ▾** menu that shows how many are on, and Export
  HAR and Clear become icon buttons, so search, Reset and Preserve log stay in view in a narrow
  console (#575).
- **Tab strips that fit, and a REST editor that fits a 1024×700 window.** A tab strip never grows
  wider than its pane any more: the tabs that don't fit move into a **More ▾** menu at its end, which
  shows the selected tab's name when that tab is one of them. Picking Assertions or Snapshot no longer
  slides the response pane sideways. Below 800px wide the REST editor puts the response under the
  request, and a window under 720px tall starts with the console collapsed. **Save response** and
  **Copy path** are icon buttons with tooltips, so the status line keeps its room. Generated header
  values and the HTTP Log's columns cut to one line with the full text in a tooltip, instead of
  wrapping a character per line or overlapping their headers; a narrow HTTP Log shows its four main
  columns (#542).
- **Pasting control characters into a terminal asks first.** A paste holding an escape or another
  control character (apart from tabs and line breaks), such as an embedded end of bracketed paste,
  now waits for a yes even on one line and with the multi-line question turned off. The dialog shows
  the characters escaped (`\x1b`) and offers no "Don't ask again" (#361).

- **Keys typed while a terminal connects reach the shell.** What you type, or paste, while the
  connection screen shows a connect under way is kept (up to 4 KB) and sent to the shell as soon as
  it opens; the screen says so. A connect that fails drops it, and keys typed after a failure or
  after a session ends still go nowhere (#361).

- **Import and lint findings read as places, not pointers.** The Import dialog labels its URL field by
  the picked format (**Definition URL or file**, or **WSDL URL** only for WSDL), with a placeholder for
  each format; the WSDL authentication select has a visible label, and the OpenAPI face says
  **Authentication** once. An OpenAPI import's summary counts the lint findings it filed, linked to
  **Problems**. A lint finding there reads `GET /json › 200 › application/json` instead of a JSON
  pointer (the pointer and position stay in its tooltip), shows its rule id as small text after the
  message, and a click opens the request for that operation, or the API when there is none (#561).

- **A steadier REST request editor.** Send and Cancel take the same width, so the method and URL no
  longer jump when a send starts. While a send is out the response bar reads **Sending… 2.4 s** with a
  running timer, once, and the last response stays on screen, dimmed, until the new one arrives.
  Params, Headers and the response Headers tab show how many rows they hold, as Assertions does.
  Choosing a GraphQL body on a GET says **Method changed to POST** with an Undo, and switching the body
  back puts the old method back. The first Escape in a header cell closes the variable list and keeps
  what was typed (#559).

- **A failed REST send says what happened and offers Retry.** In place of "Send the request to see its
  response", the response pane names the failure in plain words (**Connection refused**, **Host not
  found**, **Timed out**, **Unresolved variables**), shows the whole message and one hint, and offers
  **Retry**; the code stays as small text under it. A timeout names the limit it hit and links the
  request's Settings tab; each unresolved `${name}` links to the field it was written in. Your own
  Cancel reads as a neutral **Cancelled**, and neither a cancel nor a declined protected-environment
  prompt adds a Problem. The status bar's **last:** now shows the latest send, failures included. A
  URL with `://` but no valid scheme or host (`ht!tp:// bad url`) is refused before sending, with the
  reason under the URL field, where it used to go out as a path under the base URL (#541).

- **History rows read on two lines, and a click opens.** A row shows the method, name and a status
  chip, then the time, host and duration, so the name is never squeezed out at narrow widths.
  Re-send, Compare, Compare with current and a new **Delete** (one entry) are in a **⋯** menu at the
  row's right edge; a click anywhere else on the row opens the entry and never re-sends it. The arrow keys move
  between rows and Enter opens one. An entry's tab is titled with its name and send time, a send with
  no request body gives the tab to the response, and the footer says "1 entry" (#544).

- **New host asks for the essentials first.** The host form shows Name, Address, Group, User, Port and
  how to sign in; OS, tags, Protected, jump host, keep-alive, timeout, agent forwarding, environment,
  terminal and forwarding rules wait under a closed **Advanced** section. With no group supplying a
  user, User is a plain field prefilled with this machine's login name; the inherit switch shows only
  when a group supplies the value, and every inheritable row has one switch with its source as text
  ("22 · default", "deploy · from Production"). **Password** takes the password inline and stores it
  on Save as the workspace secret `<host>_password` (the hosts file holds only the name); **Choose a
  stored secret** picks an existing one instead. A **Group** select starts on the group the dialog was
  opened from or the active group chip, and moves an edited host. A disabled Save lists what is
  missing. The host edit panel has the same form (#531).
- **HTTP/2 is offered by default.** Every HTTPS send offers `h2` and `http/1.1` in the TLS handshake,
  through a proxy too, and the server picks, so a stack that speaks only HTTP/1.1 stays on it. The
  **Offer HTTP/2** preference is now on by default and is stored as `http.offerH2`. The old
  `http.allowH2` key is dropped, since every saved file carried it as `false` although it never
  turned HTTP/2 off. Turn the preference off for a server that asks for a client certificate
  mid-connection (#80, ADR-0024).

- **Host details opens and closes only when asked.** Clicking a host selects it without opening or
  closing the Host details panel; an open panel shows the selected host. The right rail's icon (and
  Edit) opens it; its close icon, Escape and the rail's icon close it. Whether it is open is remembered
  on this machine and restored after a restart, where it asks for a host until one is picked (#582).
- **One calm state for a lost connection.** While a dropped terminal reconnects it stays in view, dimmed,
  under one bar with the countdown, **Reconnect now**, **Stop** and **Show log**; the connection screen
  comes back only once the attempts give up, with its log folded. A Files pane whose connection ends
  says so ("Connection to box lost · 21:31") with **Reconnect** as the main button, over its last
  listing, dimmed. The connection log pins its one-sentence summary above the lines and shows them in
  time order (#590).
- **Host groups and forwarding groups are told apart.** A forwarding rule says where it is defined:
  "defined on this host" or "defined on host group Production". The palette's **Hosts: New Host
  Group…**, the Hosts menu's **New host group** and the New rule dialog say "host group" too, so "group"
  alone means a forwarding group. A rule that **Start group** started says "Started with group Dev" in
  Forward details, which now shows one list: the rule's values, with the live one only where it differs
  (#592).
- **SSH polish, round 2.** The first host picked says once where Host details are, and Host details say
  "1 forward running" (opening Port forwarding) when a forward runs through the host. Grid cards show up to
  two tags. New host and New identity name a missing field only after **Save** or once a required field is
  left empty. In Advanced, Keep-alive and Connect timeout keep their labels on one line, with the source
  under the input. known_hosts rows say which saved hosts use the key, and **Forget**, a layout's
  **Delete** and **Delete group** end in a toast with **Undo**. Deleting a host can also delete its own
  password secret. **New rule…** is headed "Rule", hints at the port only when it is wrong, and has a
  **Forwarding group** select; each group's menu has **New rule…** too. Quick connect lists the saved hosts
  a typed server matches above the one-off entry. A running session log says "running" without a size,
  Files gives names more room with a short Modified column, the snippet picker's **New snippet** stays on
  one line, and a Settings search for "ssh" lists the SSH page first. A snippet suggestion typed fast no
  longer starts over the last typed character: it waits for the shell's echo of the last key (#594).

- **Environment details in the right panel.** With an environment open, the right slide-over shows its
  name, scope and variable count, and holds **Protected**, **Colour** and **Applies to**, which move there
  from the page. The right rail offers no Code panel in Environments, as in SSH. Escape in a text field of
  a slide-over cancels the edit instead of closing the panel (#585).

- **History and Environments keep your request tabs.** Opening History or Environments no longer swaps
  the editor to that area's own tabs: History entries, History's Compare and environments open as tabs
  beside the requests, so a request stays in view while you browse its history or edit its variables.
  SSH keeps its own strip. The right rail shows an environment's details while its tab is in front
  (#607).
- **Copy as cURL and Generate code… under Send ▾.** The menu under a SOAP or REST request's Send
  button, which offered only **Send to environments…**, now also has **Copy as cURL** (the same as
  the request's palette command) and **Generate code…**, which opens the Code panel (#632).
- **A send the network failed is not a Problem.** A refused connection, an unknown host, a timeout, a
  failed TLS handshake, a proxy or network failure no longer adds a red Problem: the response pane
  already says what happened, with a hint and Retry, and the status bar's `last:` shows it. Failures
  the project can fix (unresolved variables, an incomplete URL, an untrusted certificate, script type
  errors) stay in Problems, now worded by their title ("Incomplete URL: …") rather than their code
  (#635).

### Fixed
- **Danger is no longer told by colour alone (#803).** A logged terminal shows a record glyph
  rather than a red dot, a failing schedule in the explorer shows a cross, an invalid search pattern
  in the HTTP log shows a cross beside the red border, a too-short password hint gains a cross, and
  conversion problems read **Error** or **Warning** with their own icon. A pane receiving broadcast
  input has a dashed outline, so it differs from the focused pane by more than its colour.
- **The project menu is shorter (#686).** A project's six creators sit under one **New ▸** submenu,
  named alike: **New REST API…** (as on the Start page), **New gRPC API…**, **New WebSocket API…**,
  **New MCP server…**, **New Webhook…** and **New Sequence…**.
- **The environment switcher asks for a project instead of saying "No project" (#686).** With
  several projects open and no request focused yet, it reads **Pick a project**: the menu lists the
  workspace's projects, and the one picked shows its environments straight away.
- **The Start page and the Explorer agree in an empty workspace (#686).** Both offer **New project**
  first, then **Import…**.
- **Two projects of one name tell apart (#686).** When another project shares a project's name (in
  any case), its Explorer row shows its folder's name faint after the name.
- **A short drag no longer snaps the sidebar shut (#686).** Dragging its edge inward stops at the
  minimum width; the sidebar collapses only when the drag carries on well past it.
- **Deep breadcrumbs stay readable (#686).** A request's path line with four or more segments keeps
  the project and the request's name whole and folds the segments between them into **…**, whose
  menu lists them in order.
- **History rows say where a send went (#748).** A REST row leads with its path, the host faint beside
  it, so sends to `/pets` and `/pets/1` on one host tell apart; the request's name moves to the second
  line. A click opens the entry as the preview tab, which the next click replaces, and a double-click or
  Enter keeps it. An entry with no request body says so under a **Request** label, apart from the
  response.
- **The empty palette leads with what you use (#748).** With nothing typed, ⌘K lists the commands run
  from it lately under **Recently used**, and the Account commands sit at the end instead of opening
  the list with Sign in. **Preferences: Keyboard Shortcuts** opens the shortcuts page, and "keys" or
  "bindings" find it.
- **Escape leaves Settings opened from the rail (#748).** After a click on the Settings button the
  focus stayed on it with its tooltip open, and Escape only closed the tooltip. Escape now leaves
  Settings whatever has focus, unless a menu, dialog or text field is open.
- **The console stays out of the way until something goes wrong (#748).** A workspace's console starts
  collapsed and a send that works leaves it so. It opens itself on the HTTP log for a failed send (no
  response, a fault, a 4xx or 5xx) and on Problems for a new problem, until you open, close or resize
  it yourself. Each workspace remembers its own console.
- **Make secret no longer covers the value (#748).** It is a key button beside the row's **Remove**
  button, so a long value stays readable to its end.
- **Params tells path parameters and variables apart (#748).** An empty path table reads "No path
  parameters like {id} in this URL." instead of "No {placeholders}", and a **Variables in this URL**
  list names each `${…}` the URL uses, where it resolves and its value (masked for a secret).
- **Imported array parameters carry their values (#748).** An OpenAPI query or path parameter that
  takes an array now imports with its example, or its items' default or first enum value, instead of
  an empty cell: a required `status` arrives as `status=available`, not `status=`. An exploded
  form-style query parameter gets one row per item (`tags=a&tags=b`); other styles join the items with
  commas. A required parameter the document gives no value at all arrives as a `${name}` reference
  (`tags=${tags}`), so the URL marks it and a send names what is missing instead of sending `tags=`.
  Optional parameters still arrive switched off.
- **A new POST body is ready to type into (#748).** Switching a request with no body from GET (or any
  method without one) to POST, PUT or PATCH sets the body to Raw · JSON. A body you set to None on a
  POST stays None.
- **A missing variable is explained once (#747).** A send refused because a `${name}` has no value now
  shows one heading and one sentence naming each variable, linked to the field it sits in, instead of
  the heading, the engine's sentence and the code `rest-unresolved-properties` one under the other.
  There is no **Retry** for an error that cannot change on its own (the same for an unclosed `${` or a
  URL that is not one), and the code and the engine's message sit behind **Details**. Like a refused
  connection or a timeout, it is no longer counted as a problem, so the status bar stays calm.
- **A new environment is ready in one step (#746).** **Add environment** puts the new row straight
  into rename with the focus in it, and once the name is in (Enter, or a click away) the environment
  becomes the current project's active environment, so the switcher and the next send already use it.
  Escape keeps "Environment N" and leaves the choice of environment as it was.
- **The Problems tab counts what the status bar counts (#745).** The console's Problems tab no longer
  badges lint findings: with a freshly imported definition the status bar read "0 problems · 57 lint
  findings" while the tab beside it read "Problems 57". Lint now has its own **Lint** chip in the
  Problems view, off by default, and **All**, **Errors** and **Warnings** list only the problems; the
  status bar's lint item and **Lint definition** open the lint list directly.

- **Explorer, after a daily-use review (#685).** A SOAP operation with no request is a leaf, and a click on
  it creates the first request; **Expand all** unfolds down to the operations and Endpoints and leaves
  those folded, so a tree of many operations stays readable. A failed import names the HTTP status and
  the host ("The server answered 404 Not Found from api.example.test") and says what to check: the URL,
  the authentication or the format. **New gRPC API**, **New WebSocket API**, **New Sequence** and **New
  Webhook** put the new row into rename mode, as New Folder does. A linked project whose folder is gone
  says so on two lines, with the folder's path and the **Locate…** and **Remove** buttons below it, and
  the toolbar's disabled Refresh button is gone: the banner that reports a project changed on disk offers
  Reload.
- **A click in the Explorer no longer folds the row it opens (#680).** Clicking a project or API row opens
  its tab and leaves its children where they are; folding is the chevron's, the arrow keys' and a
  double-click's job. The row a context menu was opened on is outlined while the menu is up, and an item
  from the menu selects that row before acting on it, so the dialog it opens names the row under the
  pointer.
- **The desktop package drops the last of ssh2's native-binding tree.** `nan`, the C++ headers only
  ssh2's never-built cipher binding compiles against, no longer ships inside the app; the binding's
  build folder and `cpu-features` were already left out, and the packaged app runs ssh2's pure-JS
  ciphers on every platform (#362).
- **SOAP, after a daily-use review (#725–#732).** A response's status and a send error have a line of
  their own above the tabs, never pushed out of view (#725). A template **?** shows in the Form view as
  a marked placeholder, Validate warns about each one, the first send of a request still holding them
  asks, and the Runner counts them (#728). A new mock answers with schema-typed sample values its own
  contract accepts, not **?** (#729). A failed WSDL fetch names the HTTP status, sign-in, certificate or
  network cause and what to try. History's chip names a failed send's kind ("refused", "DNS"), and an
  endpoint picked in the editor marks the tab unsaved and is sent before it is saved (#732).

- **Duplicate from a host card's ⋯ menu opens the copy.** It did nothing: the menu's click also picked the
  card, which dropped the form Duplicate had just opened. The right-click menu was not affected (#719).
- **Closing a split tab names every host.** A tab split across box and box-2 asks **Close 2 sessions on
  box and box-2?**, not only the first host's name (#720).
- **The connection screen names the user it connects as.** A quick host shows `user@address:port`, the
  user typed at the prompt wins over the saved one, and a failed attempt with nothing logged no longer
  shows an empty log box (#716, S67).
- **SSH round-5 polish.** The snippet editor keeps Run, Insert and Save in a footer while its body
  scrolls (S63); the Keychain names the identities that use a secret ("Used by identity Tester") and
  refreshes when secrets change (S64); the import dialog's first step has **Cancel** (S65); the host
  details hint goes once Hosts is not in front (S41); an ended team session log with nothing recorded says
  so, its dialog has a close button and opens large (S42); the status bar no longer starts with a
  separator in Settings (S54).
- **Device keys and the app lock say what they need.** Where they cannot be used, **Generate key** reads
  **Device keys need macOS with a Secure Enclave or Windows Hello.** and Settings → Secrets reads **App
  lock needs Touch ID, Windows Hello or the system password prompt.**, inside the App lock row under its
  description, followed by the computer's own reason when there is one (such as **This Mac has no Secure
  Enclave**). **Lock again after idle** is disabled while the app lock is off or unavailable, and the
  Secrets page's subtitle now mentions the app lock (#691).
- **Quick Open finds requests by name.** <kbd>⌘P</kbd> lists the requests and operations whose name
  matches above those that match only by their project, API or folder, so "pet" puts Find pets first,
  not every request in Swagger Petstore. A row listed by its path alone needs every typed word to be
  missing from its name: "pet user" no longer lists Delete user because its API is Petstore (#683).
- **Search heads each group with the request.** A group of Search results starts with the REST method
  and the request name, with the project and API faint underneath, instead of a breadcrumb that cut
  every group to the same "PAYMENTS › SWAGGER P…" (#683).
- **Lint findings no longer count as Problems.** After importing an OpenAPI definition, its lint findings
  get their own status bar item (**57 lint findings**, with errors and warnings named in the tooltip),
  which is never coloured and opens the Problems panel. The **Problems** item and the **Console** badge
  count only what went wrong, so a clean import of a real-world spec no longer turns the status bar red.
  The import summary names the findings by severity (**Lint: 2 errors, 55 warnings**) and links to them
  (#682).
- **Save stays in view in the New host and Edit host forms.** Cancel and Save sit in a footer bar at the
  bottom of the right panel and the form scrolls above it, so a short window or an open **Advanced**
  section no longer scrolls them away. <kbd>Enter</kbd> in a field still saves. The panel is titled
  **Edit host** while editing, and **Group** moves below the sign-in fields so it no longer sits between
  **Address** and **User** (#689).
- **A shared terminal's viewer counts themself.** Right after joining, the viewer's header reads
  **1 watching** with their own chip, as the owner's strip does, instead of **0 watching**. Once the share
  has ended the count and chips go, and the notice offers **Close tab**. A new share of the same session
  has a new link, so there is no rejoin from the ended tab (#690).
- **Telnet and serial terminals no longer offer Files.** The terminal tab's toolbar shows **Files** only
  when the focused pane's host is reached over SSH or Mosh, as the pane's own menu already did (#688).
- **Telnet and serial connects list their own steps.** A serial console's connection screen shows
  **Opening /dev/ttyUSB0 at 9600 8N1** then **Ready**, and a Telnet host's shows **Resolving address**,
  **Connecting** and, when a user is set, **Signing in at the prompt**, instead of SSH's host-key,
  authentication and shell steps (#688).
- **A serial console with no port yet asks for one calmly.** The first connect on a computer where no
  port was picked shows **Choose the port for** the host, with the ports and **Use and connect**, instead
  of a red failure with Retry, the log and a **Host settings** heading. A port that was set and has gone
  is still shown as a failure (#688).
- **Telnet hosts say so in the host list.** A Telnet host's card, its list row and the New host draft
  card read **Telnet · admin@10.1.1.1** with the not-encrypted mark the Telnet tab already shows, and the
  draft no longer shows a bare `:23` (#688).
- **A large REST response scrolls smoothly in Raw.** Scrolling the Raw view of a multi-megabyte body
  draws the new lines in the next frame and moves them without a layout pass, so it no longer drops
  frames on a slower machine.
- **The split-pane host picker opens the host you type.** Typing another host's name in Split right's
  picker now selects that host, from either group, and Enter connects the new pane to it. Before, the
  current host stayed selected (its id matched the typed digits), so the new pane opened on the wrong
  machine. The picker matches on name, address, group path and tags only (#687).
- **A script test with an async callback now fails.** `test(name, async () => …)` used to record a pass
  whatever the callback did, because a script cannot wait for the promise. It now fails with "the test
  callback is async, and a test cannot wait: make it synchronous", in the typed API and in every imported
  script layer.

- **Cancelling Import cURL in an empty project leaves no empty API.** The API made to hold the
  request is removed again when the dialog closes without importing (#575).
- **SSH quick wins.** Deleting a host asks first, naming how many open sessions will close, and those
  terminal panes and its Files tab close with it; Delete is drawn as a danger item. Dialogs share one
  layer scale (menus, then dialogs, then toasts), so a split divider no longer draws through the Save
  layout dialog and the trust prompt shows over a pane's connection screen. Shortcuts in the SSH views and
  Terminal settings read in the platform's notation (Alt+Enter, Ctrl++ off a Mac). The palette lists one
  Connect to Host…, and every SSH command starts with its area: Hosts, Terminal, Files, Forwarding,
  Layouts or Snippets, with Forwarding in a category of its own (#536).
- **Revealing secrets in the HTTP log asks first.** The palette command is now **Reveal Secrets in HTTP
  Log…** and, like the log's lock, asks before Authorization headers, cookies and passwords show;
  hiding them never asks. A new **Show HTTP Log** command is what a search for "HTTP Log" lands on,
  the palette now puts the category with the best match first, and the lock is an icon rather than an
  emoji that showed as a box on Linux (#545).
- **`${name}` in a REST URL is no longer a path parameter.** `/pets/${petId}` used to add an empty
  `petId` row to the path-parameter table although the send expands the variable; only `{name}` adds
  a row now, in the editor and in a cURL import (#545).
- **Import cURL takes only curl commands.** Text that does not start with `curl` (after an optional
  `$ ` prompt) is refused with the reason, and Import stays disabled; `wget http://example.com` used to
  import as a GET to `{base}wget`. An imported REST request is named from its method and path, such
  as `GET /pets/{petId}` (#545).
- **Renaming a project environment no longer unlinks it from its workspace environment.** Inside a
  workspace a project environment applies through the workspace environment with the same slug; a
  rename re-derived the slug, so its properties, endpoint overrides and protection silently stopped
  applying. A rename now keeps the slug, as a workspace environment's rename already did (#475).
- **A sequence run inside a workspace names its environment in the report.** `wirebench run
  --sequence -e <environment>` looked the name up only among the project's environments, so the
  json, html and console reports left it out when the environment was the workspace's (#476).
- **Renaming an API keeps its environment endpoint overrides.** Overrides are keyed by the API's
  slug (`<projectSlug>/<apiSlug>` in a workspace environment), and a rename re-derives the slug, so
  the override stopped applying and sends went to the API's own base URL. A rename of a REST,
  WebSocket or gRPC API now moves its keys in the project's environments and in every workspace
  environment (#477).
- **The SSH area fits a small window.** At 1024×700 the Files panes showed sizes and dates but no
  names, and scrolled sideways. Each pane now keeps the Name column at least 10rem wide, drops
  **Modified** below 560 pixels and **Permissions** below 440, and never scrolls sideways. A split
  terminal tab no longer slides under the sidebar, and its find bar stays inside its pane. A split right
  is refused with a toast when either half would be narrower than 40 columns (was 20). Host details
  scroll only downwards, putting each label above its value in a panel narrower than 360 pixels. The SSH
  menu cuts long labels short and turns into a column of icons, each named in its tooltip, when the sidebar
  is too narrow for them (#533).
- **NTLM and Kerberos could negotiate HTTP/2** on a direct HTTPS connection, and fail against a
  server that answers `HTTP_1_1_REQUIRED`. Both now always use HTTP/1.1. **Offer HTTP/2** switched
  off now does keep a direct send on HTTP/1.1 (#80).

- **SSH small fixes.** Typing "ssh" in the command palette lists every SSH-area command (hosts,
  terminals, files, forwarding, snippets) above anything that only matches the letters. The SSH menu's
  Keychain count updates as soon as a key is generated or a secret stored, wherever that happens.
  **Generate key** starts with a real, selected name (`id_ed25519`, or the next free `id_ed25519_2`) that
  follows the key type until you type your own, and says "Name is required" beside Generate when the
  field is empty. The menu entry is now **Forwarding**, so it fits with its running count at the default
  sidebar width. A view's search hides its <kbd>Ctrl+F</kbd> hint while it holds text, so the field's
  clear button no longer draws over it (#593).
- **Nothing in an SSH side panel is cut off at the right.** In the Snippet panel, a variable's row puts
  its name and remove button on one line and Label and Default below them when the panel is under 360px,
  so every field can be reached at 1024×700. Edit host's password field says "•••• stored · type to
  replace", with the secret's name on its own line under it, and key sign-in's three secret pickers wrap
  onto more lines in a narrow panel. Host details, Edit host, Snippet and Forward details all fit a panel
  from 280 to 400px wide (#591).

- **Deleting a host cleans up its forwarding groups.** The delete confirm names the rules that leave
  each group ("Its rule redis leaves forwarding group Backend."), and the delete takes them out of their
  groups. A group member whose rule or host has gone offers **Remove from group** rather than **Stop**,
  and is no longer counted as failed in its group's header or the status bar (#592).

- **Start group asks every prompt.** When a group's rules need hosts trusted or network binds confirmed,
  each question is asked in turn instead of the second replacing the first, and every rule then starts.
  Rules on the same new host share one trust prompt. A rule isn't shown as failed while its prompt waits,
  and cancelling a prompt leaves that rule stopped. The group header follows the group: an empty group
  says "No rules" with no Start, a partly running one offers **Start N more** beside **Stop group**, and
  the failed count shows the Failed rows (#589).

- **A failing assertion is never hidden.** Once a send has run assertions, the response's
  **Assertions** tab stays in the strip however narrow it is, with its count in red when one failed, and
  the status line adds "· 1 assertion failed". Any other tab with a failure that moves into **More** puts
  a red dot and count on the More button (#606).

- **Search finds REST requests by name.** The Search view matches a REST request's name and the folders
  it sits in ("Sales › Orders › List orders"), as it already did for WebSocket requests (#611).

- **History's search box keeps its width.** Search sits on its own row above the project filter and
  **Delete all**, so a narrow sidebar no longer crushes it or clips **Delete all**; the project filter
  shows only when more than one project is open (#608).

- **A History entry shows what came back.** Its meta line leads with the status ("404 Not Found",
  coloured by class), and a **Headers** tab lists the response's headers and the request's, as History
  recorded them (#609).

- **A fresh OpenAPI import no longer turns the status bar red.** The built-in rule
  `owasp-security-defined` (no security scheme defined) is a warning instead of an error, so the Console
  and Problems counters read amber unless a real error is found (#610).

- **Assertions chained after `.property(...)` in imported scripts now fail when they should.** In
  imported Postman scripts, `expect(x).to.have.property('a').that.equals(5)` passed whatever `a` held,
  because the check after `.property(...)` could not fail.
- **A file part with no file yet no longer breaks the project.** Importing an OpenAPI document with a
  multipart upload (the petstore's "Uploads an image"), or saving a file part or binary body before
  picking its file, wrote `path: ""`, and the project then refused to load. It now loads.
- **An imported form-data file part with no file no longer stops the project from opening.** A
  collection whose multipart body has a file part without a file, from Postman, Insomnia, Thunder
  Client or Hoppscotch, now keeps that row as a switched-off text part, and the import report names
  the request and tells you to pick the file again on the Body tab.
- **An imported file body with no file no longer stops the project from opening.** A request whose
  whole body is a file but carries no file, from Postman, Insomnia or Thunder Client, now imports with
  no body, and the import report names the request and tells you to pick the file on the Body tab.
  Hoppscotch file bodies now get the same warning.
- **No orphan warning for a saved golden.** Opening a project, or `wirebench run`, no longer warns
  `"<request>.golden.yaml" does not belong to any request` for a golden saved beside its request, in
  any protocol. A golden whose request is gone is still reported.
- **Environment rows show colour and protection.** The Environments list now shows each
  environment's colour dot and, for a protected one, its lock, as the title-bar switcher does. The
  Environment details panel stays as you left it, open or put away, when you come back to an
  environment and after a restart (#634).
- **The mock tab explains port 0 and shows methods uppercase.** A mock on port 0 now shows an empty
  Port field reading *any free port*, and clearing the field asks for one. An operation's header reads
  `GET /json` rather than `get /json` (#634).
- **The environment switcher names your only project.** In a workspace of one project the title
  bar's switcher now names that project and can be used straight away, instead of reading "No
  project" until a request is opened. With several projects it still waits for a request tab to say
  which (#634).
- **API tabs read cleanly.** The REST, gRPC and WebSocket API tabs no longer show an issue number or
  repeat when an API's scripts run, and their authentication fields line up with Name and Description
  (#634).
- **The Body tab shows when there is a body.** Like Scripts, the REST request's Body tab carries a dot
  while the request would send a body (#637).
- **The Runner counts requests without checks apart.** Its summary and Past runs now say "3 passed,
  9 without checks" instead of counting a request that tested nothing as passed, and a request that
  errored reads like the send error panel ("Incomplete URL: …", the code in small text) (#637).
- **REST fits a 1024×700 window better.** Shrinking the window below 720px collapses an open console,
  and growing it back reopens it; the first send in a short window leaves the console collapsed. The
  HTTP Log toolbar wraps instead of scrolling sideways when the code panel narrows the console, and
  **Preserve log** is now a pin icon beside the other actions. The response's status line wraps
  between its parts instead of cutting the last one short (#636).
- **WSDL import goes through your proxy and CA bundle.** Importing a WSDL by URL, re-fetching it when a
  project reopens, and fetching a definition a legacy SOAP project file holds no copy of now use the
  proxy and CA bundle from Settings, as sends and OpenAPI imports already did, with Basic or Kerberos
  definition authentication too. On a corporate network, a WSDL reachable only through the proxy, or
  served with a corporate-CA certificate, now imports.
- **A refused proxy tunnel no longer reads as Cancelled.** When an HTTPS request goes through a proxy
  that refuses the tunnel (a 407 for a wrong or missing proxy password), the send now fails with
  "Proxy connection failed" and the proxy's status, instead of showing as if you had cancelled it.
- **A failed send says what happened once, and where.** The error panel names the host and port a
  refused connection was aimed at ("Couldn't connect to 127.0.0.1:9") and the host that did not
  resolve, and leaves out a message that only repeats its title. The HTTP Log names a failed row the
  way the panel does ("Connection refused", not `connection-refused`), with the code in its tooltip.
  A `${` that is never closed is reported as such, naming the field it is in with a link to it,
  instead of as a variable missing from the environment. Cancelling a send keeps the response you
  were looking at, under a one-line "Cancelled after … · Retry" bar (#631).
- **Imported requests no longer show their method twice.** An OpenAPI operation with no summary or
  operation id, and a request from **Import cURL…**, is now named by its path alone (`/pets/{id}`), since
  the method badge beside it already says GET or POST. A request imported earlier as `GET /pets/{id}`
  shows without the repeated method in the explorer, the Runner's list and History; its stored name is
  unchanged (#633).
- **Method badges in the explorer line up.** Every method badge in the tree has the same width and
  starts in the same column, so POST no longer sits further left than GET and DEL (#633).
- **The explorer no longer scrolls sideways.** In a narrow sidebar a long name such as
  `DELETE /pets/{id}` is cut with an ellipsis instead of running past the edge behind a horizontal
  scrollbar; hover it to read it in full (#633).
- **The command palette lists what you can run first.** Within each group, commands that cannot run
  here (greyed, with the reason) now come after the ones that can, so typing "REST" no longer puts
  **REST: Lint Definition** and **REST: Update Definition…** above the commands you can use (#633).
- **History's Compare… shows what it is waiting for.** After **Compare…**, the picked row is tinted
  and a banner names it ("Comparing with List pets · 22:06:50 — pick another entry") with **Cancel**;
  a click on another row then opens the comparison. A right-click on a History row now opens the same
  menu as its **⋯** button (#633).
- **The "Method changed to POST" toast goes when it stops being true.** Switching a REST body to
  GraphQL and back, or to another kind, now takes the toast and its **Undo** down at once instead of
  leaving it up for its full eight seconds (#632).
- **Query examples match the language picked.** The example chips in an empty Query view now follow
  the query language: JSONPath offers only JSONPath expressions, XPath and XQuery their own, instead
  of mixing XPath 3.1 map lookups in with JSONPath (#632).
- **HTML Pretty reads like the page.** Inline elements such as `<b>`, `<a>`, `<span>`, `<code>` and
  `<title>` stay on one line with their text instead of taking three, and the content of `<pre>`,
  `<textarea>`, `<script>` and `<style>` is shown exactly as it arrived (#632).
- **Key/value checkboxes use the accent colour.** The checkboxes in Params, Headers and the other
  key/value tables, and in an environment's variables, are tinted like the ones in Settings instead
  of the system blue (#632).
- **The default User-Agent names the real version.** Requests sent from the app now carry
  `User-Agent: Wirebench/<version>` (for example `Wirebench/6.1.0`) instead of the stale
  `Wirebench/0.1`, and it follows each update; a User-Agent you set yourself is kept. The CLI, which
  sends without the app's preferences, sends `Wirebench`. The **Accept compressed responses** hint now
  names what is sent: `gzip, deflate, br` on REST requests, `gzip, deflate` on SOAP ones (#632).
- **A response with no body says so.** A 204, a `HEAD` answer or any other empty response now shows
  "No body (204 No Content)" in the Body tab, with the response's own status, instead of an empty
  editor showing line 1. A saved example and a captured webhook request with no body say the same
  (#632).
- **Override sits on the row in the generated headers.** In a REST request's **Generated** headers,
  **Override** is now a small text-sized control on the row's baseline instead of a full-height
  button standing off it, and the row checkboxes use the accent colour (#632).
- **Credential headers stay out of imported Postman requests.** A literal `Authorization` header in a
  Postman collection becomes the request's bearer or basic auth (the user name only) and is dropped;
  any other credential-looking header with a literal value, such as `X-Api-Key` or `Cookie`, is
  dropped and named in the import report. A value made only of variables stays. The Insomnia,
  Hoppscotch and Thunder Client imports, which share this mapper, follow the same rule, as the
  `.http`, OpenCollection and HAR imports already did (#588).

## [6.0.0] - 2026-10-12

### Added

- **`wirebench run --data <file>` runs a selection or a sequence once per row of a CSV or JSON file.**
  Each column is read as `${#Data#column}`, substituted literally, and scripts read the row with
  `iteration.data.get()`. `--iterations` sets the count (`--data-overrun stop|wrap|repeat-last` when it
  exceeds the rows), `--delay` waits between requests, and `--bail` stops every later iteration. Every
  reporter names each request's iteration; a run without data reports as before (#336).
- **Branching in sequences.** A sequence step can repeat itself, go to another step or skip the next
  one, depending on its response: the status, a header, a body expression, a SOAP fault, or whether the
  step passed, failed or errored. Every repeat and go-to has a maximum (at most 100) and can wait before
  it jumps, and a run stops after 1000 step runs, so no loop is unbounded. Only the last run of a step
  counts towards the result, and a branch that fires goes ahead even under Stop on first failure. The
  sequence tab has a **Branches** list per step; the run panel shows each run of a step and the path it
  took, and `wirebench run --sequence` names the path on each step's line and in the json and html
  reports. A sequence with branches is saved as sequence file version 2, which an older build refuses and
  leaves as it is; one without stays version 1 (#347).
- **Scripts steer a run.** `execution.setNextRequest(name)` sends an API or folder run on at another
  selected request by name, to skip ahead or to poll in a loop, and `setNextRequest(null)` ends it.
  `execution.skipRequest()` in a pre-request script skips its request without sending it. The
  `pm.execution.setNextRequest`, `postman.setNextRequest` and `pm.execution.skipRequest` calls of
  imported scripts now work through the same calls. A run is capped at 1 000 jumps, and a name the run
  did not select errors the request (`script-next-unknown`). A single send and a sequence step ignore
  these calls and log that they did. Every reporter shows the path the run took. `pm.sendRequest`
  stays unsupported, and the import summary now says what to use instead. ADR-0016 records the
  decision (#335).
- **Environment colour and a production guard.** An environment can have a colour: one of eight
  palette swatches or a custom `#rrggbb`. The switcher shows it as a dot, and the active
  environment's colour bands the editor tab strip. An environment can also be marked
  **Protected**. Every send under it then asks first, with Cancel as the default: editor sends,
  History re-sends and HTTP Log resends. A sequence run asks once, and **Send to environments…**
  asks once per batch. `wirebench run` warns before sending under a protected environment, and
  `--refuse-protected` exits 2 instead. `wirebench mcp` refuses one unless the call passes
  `allowProtected: true`. Both settings are new optional keys in the environment file (`color`,
  `protected`), which older builds still read (#345).
- **The REST Headers tab lists the headers a send adds, before you send.** Under your own rows it
  shows each generated header with its source: `User-Agent`, `Accept`, `Accept-Encoding` and
  `Connection` from the preferences, the auth header, the body's `Content-Type`, the cookie jar's
  `Cookie`, and the connection's `Host` and `Content-Length`. It is worked out the way the send works
  it out, from the unsaved edits and the active environment. A checkbox leaves a header out through
  the request's new `settings.omitHeaders`, which the CLI and runs honour too, as do the cURL export
  and code generation. **Override** adds a typed header of the same name. Credentials and cookies stay
  masked, and unread, unless Show secrets is on (#346).
- **Scripts on APIs, interfaces and folders.** An API, a SOAP interface and each REST or gRPC folder
  can have a pre-request and a post-response script, which run around every request inside it: the
  API's, then each folder's outermost first, then the request's own, in both phases. A pre-request
  failure stops the send; a post-response failure lets the later scripts run and reports the first.
  Each level lists its own secrets, is typed from its protocol's request and response, and is
  type-checked by `wirebench run` before anything is sent. The API tab has a **Scripts** section, the
  interface viewer a **Scripts** tab, and a folder **Scripts…** in its explorer menu; the response's
  **Script** tab lists each script that ran under its level. The Postman importer puts a collection's
  and its folders' scripts on the API and folders instead of copying them into each request. Project
  format 9 (#334).
- **Dynamic values.** `${$guid}` (or `${#Dynamic#guid}`) sends a fresh value with every request: UUIDs,
  Unix and ISO timestamps with offsets (`${$isoTimestamp(+1d)}`), random numbers
  (`${$randomInt(1,100)}`), and fake names, emails, addresses, phone numbers, companies, lorem text,
  dates, IP and MAC addresses, URLs, colours, currencies, file names and MIME types. Each reference is
  generated once per send, so a value used twice matches, and the HTTP Log and History show what was
  sent. The desktop app, `wirebench run` and the MCP `send` resolve them alike. Imported `{{$guid}}`,
  `{{$timestamp}}`, `{{$randomInt}}` and the other common names now map onto them; a name with no
  generator keeps the import warning. Type `${$` in a body editor, or use **Get Data…**, to list them
  (#333).
- **Variables in the editor.** Typing `${` in a request's URL, parameters, headers, auth fields or
  body completes the names in scope, with each one's scope, and `${$` completes the dynamic values.
  Hovering a reference shows its value (masked when it reads a secret) and scope, with a link to
  edit it. A name that resolves to nothing is underlined where it is written. **Set as Variable…**
  on text selected in a request or a response creates a variable in the scope you pick; in a
  request, the selection becomes the reference (#340).
- **The Code panel writes a request as code.** Besides `curl`, a SOAP or REST request can be shown
  as JavaScript fetch, Node.js axios, Python requests, Go net/http, Java HttpClient, Java OkHttp,
  C# HttpClient, PHP cURL, Ruby Net::HTTP, PowerShell Invoke-RestMethod or HTTPie, or as the
  `wirebench run` line that sends the saved request. Each snippet is built from the resolved send, so
  it matches the wire. A credential is read from the `WIREBENCH_SECRET_*` variable the CLI reads,
  never written out, unless Show secrets is on. Indent, redirects and timeout are set per language,
  and the language picked last is remembered (#337).
- **The Runner: Run… on a folder, an API, a project or a sequence.** A Runner tab sets the iterations,
  a delay between requests, the order (reorder, leave out), a CSV or JSON data file, what happens past
  the last row, and stop on first failure. Results fill in per request, grouped by iteration, and the
  last 20 runs of each target are kept with the app, outside the project. The data file's path never
  leaves the main process (#336).
- **Postman Collection v3 folders import.** In **Import…**, pick a collection's folder with the new
  **Folder…** button, or its `.resources/definition.yaml`; a workspace folder (`collections/`,
  `environments/`, `globals/`) imports every collection with its environments and globals.
  `wirebench import <folder>` and the MCP `import` tool take the same paths, adding the APIs and plain
  variables and reporting secrets and environments. HTTP requests map as a v2.1 collection's do;
  gRPC and WebSocket requests become their own APIs. GraphQL, Socket.IO, MQTT, MCP and LLM requests,
  and every field Wirebench does not read, are listed in the report. The folder is read without
  following links or leaving it (#349).
- **A Postman collection's saved responses import as request examples**, masked as recorded
  responses are, and its `followRedirects` / `maxRedirects` settings carry over (#349).
- **A container of a kind this build cannot open stays in the explorer.** It shows as a dimmed row,
  at its place among the project's containers, whose tooltip and only menu item say why: the kind
  is switched off, or this version of Wirebench does not know it. Its files are never rewritten, a
  tab of it reopens as a panel saying the same, and History and the HTTP Log keep its entries
  without a re-send (#184).
- **`WIREBENCH_KINDS` switches a protocol off in the desktop** (`grpc=off,websocket=off`), as
  `WIREBENCH_AREAS` does an area: its channels and commands are not registered and its containers
  load as placeholders. What the kind keeps for the whole project goes with it: with REST off the
  webhook collection, and with SOAP off the WS-Security configurations, show as switched off and
  stay on disk untouched. A change through a kind that is off is refused (`feature-disabled`). It is
  a developer switch (#184).

### Changed

- **Settings is a full-window page.** A left sidebar groups the sections under General, Requests,
  Network, Workspace and Account, with a search that covers every setting's label and description.
  Each setting shows its description under the label. A changed value is marked, with a Reset on the
  row, and a row locked by policy shows a "Managed" pill. While Settings is open, the title bar and
  status bar hide the controls that act on the workbench behind it (#396, #399).
- **Settings inputs check the limits the app enforces as you type.** A number field takes only
  digits, shows an inline message such as "Enter a whole number from 1 to 65535", and never saves an
  invalid value. An invalid change is refused whole instead of silently dropping its section, and an
  out-of-range number in an older preferences file is clamped on load (#400).
- **One Import… command (`Mod+I`) for every format.** The dialog detects the format, or lets you
  pick it; the ten per-format import commands are gone (#378).
- **Send leads every request bar.** In SOAP and REST it is one split button whose ▾ menu holds
  *Send to environments…*; gRPC and WebSocket keep a plain button (#374).
- **The SOAP editor's request and response tabs sit along the top**, as in the REST editor, with
  Body as the first tab of each pane (#375).
- **Each sidebar area shows its own editor tabs.** Explorer, Environments, History and Hosts each
  keep their own set and their own active tab. Opening a tab from another set brings its area into
  view (#379).
- **The key/value table** (REST params, headers and form fields, gRPC metadata, SOAP headers):
  - typing in the add row makes one row, not one per keystroke;
  - new rows sit above the computed ones;
  - long values wrap, and fold to two lines until focused;
  - columns can be resized by dragging or with the arrow keys (#376, #377).
- **SSH hosts.** The SSH sidebar is a menu (Hosts, Keychain, Known hosts) opening into a fixed first
  tab:
  - Hosts shows compact cards grouped by host group, with group filter chips and an icon for the
    host's operating system, which is detected on connect and can be overridden.
  - Keychain lists the secrets hosts sign in with and which hosts use them.
  - Known hosts lists trusted host keys, each with Forget.

  A card no longer has a hover Connect button: double-click or Enter connects, and clicking the
  picked card hides its details (#382, #387, #394).
- **Panel widths are kept per area.** Each sidebar area and the right slide-over (Code, Host
  details) remember their own width. The SSH sidebar opens narrow, and the slide-over opens at
  294px instead of 420px (#391, #392).

### Fixed

- **Saved cookie jars load and save again on macOS.** Their folder clashed with the runtime's own
  `Cookies` file on case-insensitive volumes, so persistent cookies were lost on every restart.
  Jars now live in `<userData>/cookie-jars/`, and a jar in the old `cookies/` folder moves there
  the first time its workspace opens (#385).

### Breaking

- **Project format 9.** `api.yaml`, `interface.yaml` and `folder.yaml` can carry `scripts`; a project
  saved by this version cannot be opened by an older one, which would drop them and send without
  them (#334).
- **`@wirebench/engine`: a protocol's scripting facet has `levelTypes()`,** the generic types an API's,
  interface's or folder's script is checked against. `ScriptedRequest` gains `outer` (its levels'
  scripts, outermost first) and its own `scripts` is optional; `SentScripts` gains `levels` (#334).
- **`@wirebench/engine`: `SendHost.issuedTokens` is `SendHost.protocols.soap.issuedTokens`.** A host
  lends each protocol what only it reads under its kind; `soapHostOf` and `withSoapHost` read and
  set SOAP's entry. History's WebSocket frames, event-stream rows and contract results are typed with
  History's own `HistoryWsFrame`, `HistorySseRow` and `HistoryContract`, with the same fields as
  before. The engine README's "Migrating to 6.0" lists each change (#184).
- **`@wirebench/engine`: a project's containers are one map.** `Project.interfaces`, `apis`,
  `grpcApis`, `wsApis` and `extraContainers` are replaced by `Project.containers`, keyed by kind;
  each protocol reads and replaces its own with a typed pair such as `restApisOf` and
  `withRestApis` (#184).
- **`@wirebench/engine`: the webhook collection and the WS-Security configurations belong to their
  protocols.** `Project.webhooks` and `Project.wss.outgoing` / `incoming` move into
  `Project.protocols`, read with `webhooksOf` and `wssConfigsOf`; `Project.wss.keystores` is
  `Project.keystores`. REST loads and saves `webhooks/` and SOAP `wss/outgoing/` and
  `wss/incoming/` through a new project-files facet, so a switched-off protocol's files are left on
  disk untouched (#184).

## [5.0.0] - 2026-10-10

### Added

- **Contract diff and breaking-change report.** `wirebench diff-contract <old> <new>` compares two
  versions of a WSDL or of an OpenAPI document operation by operation: operations added or removed,
  fields added, removed, made required or optional, types narrowed or widened, enumerations changed,
  constraints tightened, endpoints moved. Each change is classified breaking or compatible for an
  existing client, the report is written as Markdown, HTML or JSON, and the exit code fails a CI job
  on a breaking change. Either side can be a file, a URL, or the project's cached definition
  (`project:<name>`) (#56).
- **Several workspaces open at once.** **New Window** (<kbd>⌘⌥N</kbd> / <kbd>Ctrl+Alt+N</kbd>) opens another
  window at the workspace picker, and each window holds its own workspace: its edits, sync, environment,
  cookie jar, current values, secret sources, team secrets, History and audit reporting stay its own. A
  workspace is open in one window at a time; opening it from another brings that window forward. Closing a
  window keeps its unsaved changes as quitting does (#72).
- **JSON Schemas for project files.** Every kind of YAML file in a project folder has a published JSON
  Schema, generated from the schemas Wirebench reads the files with, so an editor can validate a project
  as you type. They are served from the documentation site, one folder per project format version, and
  attached to each release. The project-format reference shows the editor settings (#66).
- **Mock services (engine).** A project can hold mock services under `mocks/`, one reviewable file per
  canned response with its body beside it. A mock is generated from a SOAP interface or a REST API,
  validates each request against the contract (answering a SOAP fault or a 4xx when it does not
  conform), picks a response by sequence, random, XPath/JSONPath/query match or a sandboxed script, keeps
  scenario state, and serves its WSDL. It listens on loopback unless told otherwise and runs without the
  desktop, for the CLI to build on (#59).
- **Mock services in the app.** **New Mock** on an interface, a binding or an imported REST API makes a
  mock from the cached definition, listed under **Mocks** in the project. Its tab edits the port, the
  path, the validation mode and every operation's dispatch, responses, match conditions, scenarios and
  script; starts and stops the mock and copies its URL; and logs each request it answers, with the
  problems found in it. A mock listens on this machine only unless **Preferences → Mock services** says
  otherwise (#59).
- **Record a mock from live traffic.** `wirebench mock record <path> <mock> --target <url>` stands in
  front of a real system. Each request passes through to the system, and each response that reaches a
  contract operation is kept as a stub of the mock, saved when the recording stops. Credentials are
  masked in what is kept, requests are never saved, and the upstream comes only from the command line
  (#60).
- **`wirebench mock`.** Serves a project's mocks from the command line until SIGINT or SIGTERM, for a
  pipeline or a container: pick mocks by name, slug or id, override the port of one, and read the request
  log as text or JSON lines. It listens on loopback unless `--host` or `WIREBENCH_MOCK_HOST` says
  otherwise; the CLI image sets the latter to `0.0.0.0` (#61).

- **Export to Postman Collection v2.1 and OpenCollection.** A whole project, or one REST, gRPC or
  WebSocket API or SOAP interface, exports as a Postman Collection v2.1 folder (the collection plus one
  environment file per environment) or one OpenCollection 1.0 YAML document, from the project, API and
  interface menus, the command palette, or `wirebench export <postman|opencollection>`. A SOAP request
  becomes an HTTP POST of its envelope. Auth and `${secret:…}` values are always left empty, credentials
  typed as plain text are blanked too, and every export ends with a report of what was blanked, changed
  or left out (#65).
- **Portable Windows build.** `Wirebench-<version>-windows-<arch>-portable.zip` unpacks to a folder
  holding `Wirebench.exe` and a `data` folder, which the app uses for its profile while it is there.
  It cannot update itself, so **Check for Updates…** points to the release page instead (#68).
- **SSH hosts and terminals.** A new Hosts area keeps SSH hosts in `hosts.yaml`, with nested groups,
  per-field inheritance and `${secret:NAME}` credentials, and opens an interactive terminal tab per
  session, with a host-key trust prompt and a guard on multi-line paste. The area can be switched off
  with `WIREBENCH_AREAS="ssh=off"` (#316).
- **Mock response templates.** A mock response can echo values from the request — a body value by XPath or JSONPath, a query
  parameter, a header or a REST path parameter — into its body and header values with `{{name}}`. Each
  value is escaped for the body's language, may only land inside a string in a JSON body, and never
  reads a property, a secret or the environment. A mock that uses it is saved as mock `version: 2`; a
  build that knows only version 1, such as 5.0.0-rc.1, refuses it rather than serving or re-saving it
  (#323, ADR-0022).
- **Mock stubs checked against the contract.** The mock tab lists each stub whose status, headers or
  body the WSDL or OpenAPI document does not allow, by the checks a received response gets, and puts
  the same findings in the Problems view; `wirebench mock check` runs the check in a pipeline and exits
  1 when a stub does not conform (#325).
- **Type-checked dispatch scripts.** A mock operation's `dispatch.ts` gets completion, hover and type
  errors in the mock tab as a request script does: a misspelt name, a wrong `request` field, or a
  `respond` with a name that is not one of the operation's responses shows under the editor instead of
  failing the first request the mock answers. The script API reference documents the dispatch API
  beside the request-script one (#352).
- **A REST mock serves its OpenAPI document.** `GET <mock>/openapi.json` (or `.yaml`) returns the API's
  cached document with its server URL pointing at the mock, and each file it references is served under
  `<mock>/openapi/` with the references rewritten, as a SOAP mock serves its WSDL and imports. A client
  that discovers the contract from the service can now do so against a mock (#324).
- **Import SSH hosts from an OpenSSH config.** **Hosts: Import from SSH Config…**, the Hosts toolbar's
  **Import…** and the empty Hosts view read `~/.ssh/config` or a chosen file, `Include`s too, and preview
  the hosts before adding them as one new group: effective user, port, jump host and auth, duplicates
  you can import anyway, and the lines Wirebench does not use. A key file defaults to the SSH agent;
  storing it as a secret is the user's choice (#364).

### Changed

- **A same-host `http://` → `https://` redirect is followed with the request intact.** When a server answers
  `http://host/path` with a 301, 302, 307 or 308 to `https://host/path` (same host, path and query, default
  ports), a send follows it even with Follow Redirects off, and resends the same method, body and
  credentials there, rather than returning the redirect page (SOAP) or turning a `POST` into a bodyless
  `GET`. A SOAP response carries an `https-upgrade` Problem saying to change the endpoint; the redirect list
  marks the hop. NTLM and Kerberos handshakes continue on the `https://` URL (#71).
- **One grid convention for keyboard and screen-reader users.** The Environments view, an environment's
  variables table and its endpoint overrides now work like History and Keystores: one tab stop per grid,
  Up/Down/Home/End between rows, and rows and cells announced with their position (#84).

### Fixed

- **Generated REST response stubs keep read-only properties.** A REST mock generated from a response
  schema without an example now includes `readOnly` properties such as `id` and leaves out `writeOnly`
  ones. The JSON and XML sample generators take a `direction` option (`request`, the default, or
  `response`); request samples are unchanged (#327).

## [4.0.0] - 2026-10-08

### Added

- **WS-Security debugger.** The response's **WSS** inspector now says why a signature, decryption or
  timestamp failed. It shows the part that changed, with its expected and computed digest and the
  transforms used, or a SignatureValue that fails while every part matches. It names the signer token
  or decryption certificate the message asked for and did not find, and the clock skew against the
  timestamp. It also lists the Security header step by step. **Preview secured request** shows a
  request's secured envelope and its steps before Send (#57).
- **WS-Security from the WSDL's policy.** When a WSDL attaches a WS-SecurityPolicy to an operation, the
  request's Auth inspector shows the tokens, the signed and encrypted parts, the algorithm suite and
  whether TLS is required. **Apply policy** turns it into an outgoing WS-Security configuration in one
  click, and a badge says whether the request satisfies the policy or lists what is still missing (#58).
- **Managed preferences.** On a managed machine, a `policy.yaml` in a system location
  (`%ProgramData%\Wirebench`, `/Library/Application Support/Wirebench` or `/etc/wirebench`) locks the
  proxy, the minimum TLS version, the CA bundle and update checks. Locked settings are read-only in
  **Preferences** and marked **Locked by policy**; the user's own values come back if the policy is
  removed (#67).
- **Certificate expiry warnings.** Problems warns before a certificate in the workspace expires:
  keystores and the CA bundle are checked on their own, and **Check Certificate Expiry** also reads
  the chain every TLS endpoint of the open projects presents, from a verified handshake alone; an
  endpoint whose chain doesn't verify is an error. The window is
  **Preferences → SSL → Expiry warning** (30 days); the SSL inspector uses it too (#70).
- **Secrets from external managers.** Map a `${secret:name}` to a Vault, AWS, Google Cloud or Azure
  secret, a 1Password item or the keychain, from **Secret Sources…** in the command palette. Wirebench
  fetches the value at send time with the manager's own CLI and your login, keeps it in memory only
  (**Preferences → Secrets**, **Clear Secret Source Cache**) and masks it like any other secret, so
  **Toggle Show Secrets in HTTP Log** reveals it too. A shared mapping
  is used only after you approve it on this machine, and again after any change; the Problems list
  also flags a request that isn't approved. `wirebench run`, `send`, `call` and `mcp` fetch the same mappings with
  `--trust-secret-sources` or `--trust-secret-sources-hash`, and `wirebench secrets list` shows each
  secret's source and the mapping's hash (#37).
- **Kerberos authentication.** A request, an API, a SOAP interface or endpoint, and a definition
  fetch can authenticate with your Windows sign-in or `kinit` ticket over HTTP Negotiate, with an
  optional SPN and, on Windows, another account. Kerberos only: nothing falls back to NTLM. The
  WebSocket upgrade and gRPC calls send it preemptively; the CLI and MCP send it too (#40).
- **WS-Trust.** Request SAML tokens from a security token service with a username or a client
  certificate, cached for their lifetime; each token request shows in the HTTP Log. `wirebench run
  --verbose` reports each token request by host and status, never the token. A token service can
  also be asked with a Kerberos ticket (#41).
- **SAML tokens in outgoing WS-Security.** Built from a form (SAML 1.1 or 2.0, optionally signed as
  issuer) or supplied as XML. Token signatures in the HTTP Log are masked (#41).
- Signatures can refer to a SAML token (holder-of-key) and cover it through the STR-Transform (#41).
- **License binding.** A license can be bound to one server. The server mints an id when its database
  is first migrated, and a license that carries a different `serverId` is refused as `wrong-server`
  with a message naming both ids. Licenses without the field keep working on any server. The id shows
  as the first line of `wirebench-server admin license show` and as *Server id*, with a *Copy* button,
  on the License tab (#203).
- **Postman environments and globals.** **Import…** reads Postman environment and globals exports
  (**Import Postman Environment…**, **Import Postman Globals…**). An environment becomes a workspace
  environment, renamed when the name is taken and never made active; globals merge into Globals.
  Secret-typed values go to the secret store, and nothing that already exists is overwritten. A
  Postman collection's own variables now arrive as project properties instead of being dropped (#64).
- **HAR import.** **Import…** reads HAR 1.1 and 1.2 captures (**Import HAR…**): one REST API per
  origin, one request per method, path and set of query names. CORS preflights, non-HTTP URLs and,
  unless **Include static assets** is ticked, static assets are skipped. Recorded responses can be
  left out, written to History at the time they were recorded, or saved as examples. Recorded
  credentials and cookies are never imported: credential-named values are emptied from request
  bodies and masked in examples, in JSON, form and XML alike (#64).
- **`.http` files.** **Import…** reads `.http` and `.rest` request files (**Import .http File…**)
  into a REST API, with a WebSocket API for `WEBSOCKET` requests. `@variables` become project
  properties, response handlers are kept as text under `imported-scripts/` and never run, and
  `GRAPHQL` and `GRPC` requests are skipped with a warning. When a picked file has
  `http-client.env.json` or `http-client.private.env.json` beside it, the dialog offers to import
  those environments too; **Import HTTP Client Environments…** imports them on their own. Private
  values and credential-named literals become secrets, and an imported environment is never made
  active. Credential-named literals in JSON, form and XML bodies are emptied (#64).
- **OpenCollection.** **Import…** reads OpenCollection 1.x YAML (**Import OpenCollection…**), as one
  document or as a folder picked by its `opencollection.yml`. HTTP and GraphQL items become a REST
  API, gRPC items a gRPC API and WebSocket items a WebSocket API, with their folders. Variables
  become project properties and environments workspace environments, never made active; secret and
  credential-named values become secrets. Scripts are kept as text under `imported-scripts/` and
  never run, status, response-time and JSON body assertions become request assertions, and a folder
  collection's gRPC API gets the `.proto` files it names. A folder is read without following links,
  up to 5,000 files and 50 MB. Literal credentials are emptied from bodies, XML included, and from
  the OAuth 2 URLs; a folder's root dropped on its own is refused with a message saying to pick it
  from its folder (#64).
- **Response examples.** A REST request can keep recorded responses as examples, up to 5 from a HAR
  import, one per status. The response pane's **Examples** menu shows one read-only under a banner,
  and **Delete example** removes it (#64).

### Changed

- **Project format 7.** Response examples are saved with the project, so the project format is now 7:
  an older Wirebench cannot open a project saved by this one.

### Fixed

- **Import cURL warns about a `--negotiate` account with no password.** The preview now notes that the
  Kerberos account needs a password on Windows and is refused on macOS and Linux until you use **Clear
  account** (#272).
- **Update Definition from another host** no longer reuses the interface's Kerberos SPN or Basic credentials: a URL on a different origin is fetched with the SPN defaulted to that host, and without the interface's username and password (#271).
- **A REST contract tool no longer asks for a query API key.** When the API's auth is a query API
  key, the tool's `query` argument leaves that parameter out, so the request carries the key once
  instead of `key=<argument>&key=<secret>` (#225).
- **`wirebench mcp` on stdio keeps worker output off the protocol stream.** A line written to stdout
  by one of the engine's worker threads now goes to stderr with the rest of the server's output, so it
  can no longer corrupt the frames (#182).
- **A partly masked XML value no longer leaves the message unparseable.** Where a secret is only part
  of an element's text (`<Auth>Bearer <redacted></Auth>`), `send`, `call`, `query`, `validate` and
  `history_diff` now write the marker as escaped text, so the body and its History entry still parse (#183).
- **Issued-token status while typing.** The cached-token line under an issued-token entry reads
  again once you stop editing, not on every keystroke (#279).
- **A WebSocket upgrade refused with 401 drops the OAuth2 token.** The next connect fetches a new
  one instead of reusing the stale token until it expires, as a REST `401` already did. A server that
  cannot be reached, a `403`, a timeout and a cancel keep the token (#193).
- **gRPC deadline in a run.** A unary gRPC call that passes its deadline in a run now errors with
  `timeout`, as a REST request or a stream does, instead of reporting `DEADLINE_EXCEEDED` as a result
  that an unasserted call passed with. A status 4 the server returns before the deadline is still a
  result, and sending a call from the app still shows status 4 (#194).
- **Kerberos ticket wait.** A slow or unreachable Kerberos server no longer holds a send or a
  Cancel: the wait counts against the request's timeout (the handshake timeout for a WebSocket, the
  deadline for gRPC), Cancel stops it at once, and it fails with `timeout` and a message naming the
  SPN (#267). A WS-Trust token request with a Kerberos credential does the same: the ticket wait and
  the call to the token service share the request's timeout, and Cancel stops either (#278).
- **OpenCollection proto imports.** A folder collection's gRPC API now arrives with its definition
  when its `.proto` files import other files from the collection's folder: each import is read,
  under the folder first and then beside the importing file. An import that is not there still
  leaves the API with no definition, and the warning now names the import and the file that imports
  it (#247).
- **Imported legacy-project scripts.** Importing a legacy SOAP project no longer overwrites a script
  that already exists under `imported-scripts/`: a clash is saved as `-2`, `-3`, … and the import
  report says so (#64).
- **One XML redaction marker.** History, the HTTP log and copied commands now write a masked XML
  value, such as a WS-Security password or a secret value found in an XML body, as
  `&lt;redacted&gt;`, as a masked XML example already did, so a redacted XML document stays well
  formed. Other redaction keeps `<redacted>`. An XML History entry recorded before this change still
  shows `<redacted>`, so a diff against a newer entry shows that line as changed (#252).
- **`${` from a contract is sent as written.** Wirebench now copies a `${…}` from a WSDL or an
  OpenAPI document as `$${…}`, so it goes on the wire literally and never reads a property, a
  secret or an environment variable. That covers:
  - an XSD `fixed` or `default` value, in a generated request or inserted from the form view
  - the SOAP action
  - a WSDL `soap:address` and its endpoint
  - an OpenAPI path, server and base URL, example or default
  - an OAuth2 token URL, authorization URL or scope, and an API key's name

  This holds in the desktop, `send` and the contract tools. **Validate** checks the escaped text as
  the literal value it sends. `wirebench generate` shows the definition's text unescaped. Anything
  made before this change keeps the unescaped text. Regenerate a request to fix it. Re-import the
  definition to fix an interface's endpoints or an API's servers, base URL and credentials (#223).
- **AsyncAPI text is sent as written.** An AsyncAPI import no longer lets a document choose a
  reference. A `{name}` server variable or channel parameter with no default or enum value now stays
  the literal text `{name}` instead of becoming the property `${name}`, so a document's `{token}`,
  `{secret:token}` or `{#System#NAME}` never reads a property, a stored secret or an environment
  variable and sends it to a host the document chose. The import report lists each such slot for you
  to map yourself. Every `${` the document's own text holds is copied as `$${`: server URLs, channel
  addresses, variable and parameter values, WebSocket binding query and header samples,
  subprotocols, and message examples and samples. **Update definition…** does not repair an API
  imported before this change, since it keeps the old text as your own edit: import the document
  again (#287).

## [3.1.0] - 2026-10-04

The first release since 2.2.1, carrying both the 3.0 and 3.1 milestones; there is no 3.0.0. The major
version is `@wirebench/engine`'s public exports: the names that
dated from the SOAP-only engine are renamed, and what the new protocol registry replaces is removed,
with no deprecated aliases. Existing projects and workspaces open unchanged, and the `wirebench`
command line keeps its flags and report shape; the behaviour changes this release does make are listed
under Changed and Fixed. The project format version does move, to `formatVersion: 6`, because of request
scripts (see Added): a project this build saves opens only in a build that has them. The protocol
modules themselves do not change the project folder format.

### Breaking

- **`@wirebench/engine`: SOAP-era names renamed.** `importDefinition` is `importWsdl`; `ImportSource`,
  `ImportOptions`, `ImportCacheOptions`, `ImportProgress`, `ImportProblem` and `ImportResult` gain a
  `Wsdl` prefix (`WsdlImportSource`, …); `summarizeOperations` and `OperationSummary` are
  `summarizeSoapOperations` and `SoapOperationSummary`; `generateRequest` and `generateEmptyRequest`
  are `generateSoapRequest` and `generateEmptySoapRequest`; `toSendInput`, `ToSendInputArgs` and
  `SendRequestInput` are `toSoapSendInput`, `ToSoapSendInputArgs` and `SoapSendRequestInput`;
  `SendAttachmentOptions` is `SoapAttachmentOptions`. Signatures are unchanged.
- **`@wirebench/engine`: exports removed.** `prepareSend` and `PreparedSend` (send through
  `createRunSender`); `assertSupportedKind` and `apiKindOf` (ask `ProtocolRegistry.status`);
  `RequestDef` (it was an alias of `SoapRequestDef`); `scriptTypesFor`; `ScriptProtocol` (it is
  `string`); and `RequestScriptTypes.soap`, which is now the opaque `binding`.
- **`@wirebench/engine`: `protocol` is a `string`.** `RequestResult.protocol`,
  `AssertionSubject.protocol` and `ScriptedRequest.protocol` were the union `'soap' | 'rest' | 'grpc'`.
  The JSON report's `protocol` field is typed the same way; the values a run writes are unchanged.
- **`@wirebench/engine`: one send path.** `ProtocolRun.send` is replaced by `open`, which starts a send
  and hands back an exchange (its events, `push`, `halfClose`, `close`, `cancel` and `result`), and
  `resolve`, which gives what a send would send with nothing connected. `RunContext.host`, a `SendHost`,
  replaces `getSecret`, `proxyFor`, `onSecretValue`, `fetchToken` and `tokenSource`, and also carries
  what a host can lend a send: TLS anchors and identities, preferences, cookies, a contract check and
  gRPC schemas. `prepareRest`, `prepareSoap` and `prepareGrpc`, the modules' own prepare functions (never exports of
  the main entry), are removed. `openExchange`,
  `resolveExchange` and `SendHost` are added, with the types around them (`ExchangeHandle`,
  `ExchangeOptions`, `SendFailure`). The desktop, the command line and MCP all send through them.

[`packages/engine/README.md`](packages/engine/README.md#migrating-to-31) has the full tables and a
before and after for the two changes that need more than a rename. The package's subpaths (`./xml`,
`./rest`, `./json`, `./grpc`, `./asyncapi`, `./snapshot`, `./detect`) are unchanged.

### Added

- **`send` baseline check.** `send` (the MCP tool, and `wirebench send --baseline`) compares the
  response with the request's golden and returns the differences (#218).
- **`wirebench run --update-baseline`** saves each changed response as its request's golden, keeping
  its ignore rules, and lists the files it wrote (#217).
- **Cookie jar.** Cookies responses set go into a jar per workspace, kept across restarts (encrypted
  with the system keychain) except session cookies. A REST request with *Send cookies* on sends the
  matching ones, per redirect hop. **View → Show Cookies** opens a manager to view, add, edit and
  delete them, and the response's Cookies tab says what was stored or ignored. `wirebench run`
  keeps a jar for the run (#44).
- **Current values.** Every variables table has a **Current** column: a session-only value that
  replaces the committed one for sends and previews. The store is memory only; a request that is
  sent records what it sent, as for a committed value, so keep credentials in `${secret:…}` (#44).
- **HTML preview.** The Preview tab renders an HTML response or webhook capture as a static page in a
  sandboxed frame: no scripts, forms, navigation or network (#48).
- **`wirebench run --baseline`** compares each response with its committed golden and fails on a
  semantic difference; `--require-baseline` makes a missing golden an error (#36).
- **Contract operations as MCP tools (#33).** `wirebench mcp` lists every imported SOAP operation and
  OpenAPI endpoint as a tool of its own, with a JSON Schema built from the XSD or the OpenAPI schemas.
  An agent calls it with JSON; Wirebench builds the envelope or request, sends it under the interface's
  or API's endpoint, auth and secrets, records it in History, and returns the response as JSON. The
  list follows the project as it changes, at most 128 tools are served, and `--tools` picks the
  interfaces and APIs. `wirebench call` runs the same from a terminal, and `operations` rows show each
  operation's tool name.
- **An Assertions tab on every editor.** The REST, SOAP, gRPC and WebSocket editors have an Assertions tab.
  Every editor Send checks the request's assertions and shows the result in the response pane's
  Assertions tab; callback assertions are still checked in runs and sequences only (#192).
- **A WebSocket request carries `assertions:`** (part of `formatVersion: 6`). Runs, `send` and MCP `send`
  check them, and `--require-assertions` sends a WebSocket request that has them (#192).
- **A landing site.** https://wirebench.github.io/wirebench/ now has a home page, a features page and a
  download page built from the latest release; the user guide moved to
  https://wirebench.github.io/wirebench/docs/.
- **Protocol modules in the engine.** SOAP, REST, gRPC and WebSocket each sit behind one interface,
  held in a registry, so the loader, the writer, the run loop and the script host no longer branch on
  the protocol ([ADR-0017](docs/adr/0017-a-protocol-is-a-module-behind-one-interface.md), #184). Two
  things follow for a project. An interface or API of a kind this build does not know no longer stops
  the project from opening: it is reported as a `container-unsupported` problem, the rest of the
  project loads, and a save leaves that container's files exactly as they were. And `wirebench send`
  names such a container, with the reason, where it answered that no request matched. The registry
  also carries feature switches for each protocol and for scripts; every one is on, and nothing in the
  app or the command line turns one off yet. `@wirebench/engine` exports the module interface for
  Wirebench's own use, tagged `@internal`: it is not a plugin API.
- **Agents over MCP, and the same verbs in the terminal.** `wirebench mcp` serves one project to a
  coding agent as MCP tools — `import`, `operations`, `generate`, `send`, `validate`, `query`,
  `history_list`, `history_diff` — over stdio, or over Streamable HTTP on 127.0.0.1 behind a bearer
  token. `send` needs `--allow-send` (and `--env` limits where it goes), `import` needs
  `--allow-write`, and every result is redacted, secrets included. The same capabilities are CLI verbs
  (`wirebench import`, `operations`, `generate`, `send`, `validate`, `query`, `history list|diff`),
  with `--json` for the exact result. A send from the terminal or an agent lands in the desktop's
  History, and an open History panel refreshes when another process writes the file (#32).
- **`send` takes WebSocket requests.** `wirebench send` and the MCP `send` tool send a saved WebSocket
  request as `wirebench run` does: open the socket, send the saved messages, wait for a reply, close,
  and return the frames collected, masked. A session with no reply before the timeout fails with
  `timeout`, returning no frames and writing no History; a server that refuses or cannot be reached
  fails with `ws-handshake-refused`. The send lands in the desktop's History as the app's own
  WebSocket sessions do, tagged `cli` or `mcp`. `operations` lists saved WebSocket requests by path. A name a REST and a WebSocket request
  share is now ambiguous where it used to resolve to the REST request; gRPC requests are still refused.
  A saved WebSocket request without assertions errors under `--require-assertions` in a run (#184).
- **Streaming requests run.** `wirebench run` with no selector, `wirebench run --sequence`, and a
  sequence in the app now send WebSocket, streaming gRPC and Server-Sent Events requests, which a run
  used to skip or refuse. A gRPC client or bidirectional stream sends its saved messages in order and
  half-closes; a WebSocket request sends its saved messages and closes after the last reply; an event
  stream is read until it ends. The run's timeout bounds every one of them, and a stream it cuts fails
  with `timeout` instead of passing. Everything received is what the request's assertions and a
  sequence's transfers read. A new error code, `exchange-not-streaming`, answers a message pushed to,
  or a half-close asked of, a send that takes none (#184).
- **Request scripts.** A SOAP, REST or gRPC request can have a pre-request script, which runs just
  before the send and can change it (sign the body, add a header, fill in a field), and a
  post-response script, which checks the response with tests and keeps values for later requests.
  Scripts are TypeScript typed from the request's own contract — the operation's XSD elements, its
  OpenAPI schemas or its `.proto` messages — so the **Scripts** tab completes the message and a wrong
  path is an error before anything is sent. The response's **Script** tab shows the tests and the log.
  A value a script keeps is read by later requests as `${#Sequence#name}`: in a sequence run, in
  `wirebench run`, and — new — by the app's single sends, from the project's session values, listed
  under **Values** in the explorer. Scripts run in a sandbox with no network, files or keychain, under
  time and memory limits; they can't change where a request goes, never see its configured
  credentials, and read a secret only when the request file lists it. `wirebench run` type-checks every
  script before it sends anything. Postman collections now bring their pre-request and test scripts,
  run through a `pm` layer and switched off until someone switches them on. Request files move to
  `formatVersion: 6`; an older build refuses a project this one has saved.

- **Wirebench Server.** A self-hosted server gives a team sign-in (local accounts, OpenID Connect or
  both, invite-only), teams with viewer, editor and admin roles, workspaces shared over HTTP with no git
  on members' machines, and live updates of pushes, role changes and who else has a workspace open. It
  is one process with one PostgreSQL database and one data directory, run behind TLS. Each release
  publishes it as the container image `ghcr.io/wirebench/wirebench-server` (`linux/amd64` +
  `linux/arm64`), and `packages/server/compose.yaml` runs it beside PostgreSQL for a local try. See
  [Wirebench Server](https://wirebench.github.io/wirebench/docs/guides/wirebench-server/).

- **Webhook capture.** A workspace shared on Wirebench Server gets catch URLs. Each is a public address
  that records every request sent to it, with a configurable fixed response. Captures appear live in a
  tab under the Explorer's new *Webhooks* node, read with the same body and header viewers as a response,
  with a per-device badge for the ones not yet seen. Editors create, rotate, clear and delete catch URLs;
  viewers read them. The server bounds captures by count, age, body size and rate, and the app never
  writes them to disk.

- **Server editions and licenses.** Wirebench Server runs as Community, Team or Enterprise. A server with
  no license is Community, with five seats, and keeps everything it did before. A signed license file,
  checked offline and installed from the new License tab or with `wirebench-server admin license install`,
  raises the seats and turns on enterprise features. An expired license has 30 days of grace, and a lapse
  never disables an account or locks data. See
  [Editions and licenses](https://wirebench.github.io/wirebench/docs/guides/server-licensing/).
- **Server audit log.** Wirebench Server records sign-ins, user, team and workspace changes, pushes,
  team-secret changes, catch URLs, CI tokens and license changes as immutable events, on every edition.
  Server admins on Enterprise read and export them in the new Audit tab, as newline-delimited JSON, and
  team admins read and export their own team's events the same way, from the app or the API. Whoever
  runs the server can also export with `wirebench-server admin audit export`. Retention is by age
  (`WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS`, default a year). A workspace admin can also switch on
  **Record desktop activity** for a workspace: the app then reports each request sent and each test-suite
  run to the server's log (the masked URL and a few details, never headers or bodies), keeps them in a
  queue while offline, and shows **Recorded** in the status bar. Delivery honours `Retry-After`, stops
  on a `403` or `404` until the person's role in the workspace changes, the workspace is reopened, or the desktop restarts, and the switch appears only on servers
  that support it.
  Enterprise servers can also forward every audit event to one collector, as RFC 5424 syslog over TCP or
  TLS or as JSON batches over HTTPS (`WIREBENCH_SERVER_AUDIT_FORWARD_URL`, with an optional token and CA
  bundle), at least once (for syslog, a batch counts as delivered once it is in the OS socket buffer).
  Setting `WIREBENCH_SERVER_AUDIT_CHAIN_KEY` makes the log tamper-evident: events are sealed into a keyed
  hash chain a few seconds after they are recorded, and `wirebench-server admin audit verify` finds
  edited, deleted or reordered events, and the removal of the newest ones with a head from the server log.
  See
  [Audit log](https://wirebench.github.io/wirebench/docs/guides/server-audit-log/).

- **Sequences.** A sequence sends saved SOAP, REST, gRPC and WebSocket requests one after another (a
  streaming gRPC call and a WebSocket request can be steps too), and is declared in its own file,
  `sequences/<name>.sequence.yaml`, with no code. A step can lift a value from its response (a body
  expression, a header, a cookie or the status) for later steps to use as `${#Sequence#name}`, and check
  the response with assertions, a header included. Build and run one from the explorer and its tab,
  where the run panel fills in step by step; each step is logged and kept in History like any other
  send. `wirebench run --sequence <name>` runs one in CI, one test per step. A value from a response is
  data, never a template: it is used exactly as it arrived, escaped for the body it lands in, can't
  choose the scheme, host or port of the next request, can't carry a line break into a URL or header,
  and is masked everywhere once marked secret.

- **Team secrets.** A shared workspace can share secret values, not just references: each value is
  encrypted for every approved machine and travels with the workspace, so a teammate's next send uses it
  with nothing typed. Joining machines ask for access; an admin approves after checking a fingerprint.
  Removing a machine re-encrypts every value and marks the ones it could read for rotation. Two machines
  changing one value keep the newer, with a way back to your own. Needs the system keychain. Members of a
  server workspace should update before an admin turns team secrets on.

- **Definitions behind authentication.** Importing an OpenAPI or AsyncAPI document by URL offers an
  **Authentication** section: Basic, a bearer token, or an API key in a header or the query string.
  The secret is kept in the keychain and the project records only a reference, so Update Definition
  reads the document again later without asking. The credentials go only to the document's own
  origin, never to a redirect or a `$ref` elsewhere, and a query key never shows in the recorded
  source, progress or errors. A 401 or 403 says the definition needs authentication, or that the
  credentials were refused. **Choose another file or URL…** in the REST update offers the stored
  credentials for a URL on the same origin only; applying from a file clears them. Every OpenAPI and
  AsyncAPI fetch now uses the proxy and CA bundle from the preferences.

- **Re-send and compare REST entries from History.** A REST entry's **↻** (or **Re-send** on its
  tab) sends its method, URL, headers and body again through the request it came from, with that
  request's current auth, TLS, proxy and settings. The result is a new History entry, and the request
  isn't changed. A redacted header or query value is filled from the request as typed, and a query API
  key is sent once. An entry that can't be re-sent faithfully is refused with a reason: a redacted
  value with nothing to fill it, a body History cut short, an event stream, a deleted request, or an
  entry that ended on another host than the request's current one (a redirect or another
  environment). Recorded text is sent literally: a `${…}` in it is never expanded.
  Comparing two REST entries, or a REST entry with its request's latest response, opens **Response**
  and **Request** tabs that diff the status or request line, the headers and the body.

- **Update Definition for a REST API.** A REST API imported from an OpenAPI document can re-read that
  document instead of being imported a second time — from the API tab, the API row's context menu or
  **REST: Update Definition…** in the command palette. A preview lists the added, removed and changed
  operations (each change with its reasons) and what changed API-wide, and **Apply** carries a
  fingerprint of what the preview read, so a source that changed in between is refused with
  **Preview again** rather than applied. Nothing is deleted: a request whose operation is gone is kept
  and badged *orphaned* until that operation returns, and a field — a URL, a parameter row, a body, an
  auth, the base URL — is rewritten only while it still equals what the old document generated, so
  edited values, rows you added and requests you made by hand survive. One exception, so a request
  stays sendable: a query parameter the new document makes **required** has its row switched on, even
  when you edited it — your value is kept, only the tick box changes. The dialog names the source it
  read, whether you chose it or it is the one the import recorded. Another file or URL can be chosen
  as the source; an API imported from pasted text asks for one.

- **Bearer, API-key and OAuth2 auth for SOAP.** A SOAP interface, endpoint or request can now use any
  of the auth schemes a REST owner can: Basic, NTLM, a Bearer token, an API key in a header or the
  query string, or OAuth2 (client credentials, or authorization code with PKCE), with the token
  status panel under the fields. Tokens and header keys go on the HTTP request beside the SOAP
  headers, and an explicit `Authorization` header still wins. A query key is appended to the endpoint
  URL and masked in History, the HTTP log and HAR. Secrets stay references into the keychain, as
  for REST. `wirebench run` resolves the new schemes too, including a client-credentials token. The
  request's Auth inspector is now the shared form, so a request holding a token scheme opens as that
  scheme. See [`docs/specs/2026-09-22-soap-owner-auth-design.md`](docs/specs/2026-09-22-soap-owner-auth-design.md).

  **Project format moves to version 5.** A Basic/NTLM-only project loads, sends and saves exactly as
  before, apart from the version stamp. But because this format drops unknown keys on save,
  **saving a project with this version writes `formatVersion: 5`, and an older Wirebench refuses
  to open it** (`format-too-new`).

- **Snapshot regression.** A SOAP or REST response can be saved as a snapshot, a golden file
  (`<Request>.golden.yaml`) beside the request. The response pane's new **Snapshot** tab compares every later
  response with it by meaning: JSON by key and index with numbers by value, XML by namespace and local name
  with prefixes, attribute order, comments and whitespace-only text left out, and anything else as exact
  text. Each difference is listed with its path and expected → actual values, and **Ignore rules** (slash
  paths, `*` for one segment, a leading `//` for any depth) leave volatile fields out; each difference has an
  **Ignore** button that adds its path. **Update snapshot**, **Compare side by side** and **Delete snapshot**
  round it out. Bodies over 2 MB aren't compared, and renaming a request leaves its golden behind.

- **CLI runner: unary gRPC and OAuth2 client credentials.** `wirebench run` now runs unary gRPC
  requests from an API's cached definition, with `status` (gRPC code or name), JSONPath `match` and
  `sla` assertions, and an API without a cached definition errors
  with `grpc-definition-missing`. A REST or gRPC request behind OAuth2 client credentials fetches its
  token headlessly, once per configuration per run, with the client secret from
  `WIREBENCH_SECRET_<NAME>`; the token is masked in every report and output like any other secret.
  A token a server refuses (a `401`, or gRPC `UNAUTHENTICATED`) is dropped so the next request fetches
  a new one; the refused request is not sent again. The authorization-code grant is still refused. The JSON report's `protocol` can be `"grpc"`. gRPC
  requests may now carry `assertions:` in their file. See [`docs/cli.md`](docs/cli.md).

- **AsyncAPI import for WebSocket.** Import… detects AsyncAPI 2.0–2.6 and 3.0.x documents (YAML or JSON,
  from a URL, file or paste) and makes a WebSocket API: a request per WebSocket channel with its URL, query,
  headers, subprotocol and a saved sample for each outgoing message, and the API's auth from the first
  security scheme it can map (secrets are never taken from the document or stored in project files). With
  more than one `ws`/`wss` server the dialog asks which to dial; Kafka, MQTT, AMQP and other non-WebSocket
  servers, channels and bindings, non-JSON-Schema messages and unmappable schemes are listed as skipped.
  The document and its `$ref` files are cached with the project. Every text frame of a linked session is
  checked against the channel's messages for its direction, off the main thread with a 1 000 ms deadline
  per frame; a violation, a frame the contract has no message for, and a check that ran too long are marked
  on the timeline, the detail lists each problem with its path, and *Contract problems only* filters to
  the first two. **Update definition…** previews added, removed and changed operations and applies them without
  deleting anything: a request whose channel is gone is badged orphaned, and only values still equal to
  what the old contract generated are rewritten.

- **Server-Sent Events responses.** A REST response of type `text/event-stream` renders event by event —
  name, id, data and arrival time — while the connection is open, rather than showing nothing until it
  closes. *Stop* (the same button as Cancel, relabelled) ends it as a normal completion, not an error, and
  the events received so far are kept; a dropped connection is recorded the same way, with its error.
  Comment lines and `retry:` fields appear as their own rows, hidden by one toggle. The Body tab is
  replaced by an Events tab; the Query view evaluates XPath 3.1 and JSONPath over the kept events as one
  JSON document. History and the HTTP Log record the exchange as a capped, multi-message entry; its HAR
  export re-serialises the kept rows as event-stream text, redacted like any other response body; History
  search matches event names and data. *Copy as cURL* adds `-N` when the request's enabled `Accept` asks
  for `text/event-stream`. Re-send from the HTTP Log is refused for a row whose response streamed.
  Reconnecting with `Last-Event-ID`, honouring `retry:`, and the CLI runner are out of scope.

- **Sending webhooks.** Each project gets a **Webhooks** collection, alongside its APIs: outbound
  requests that play a provider calling your own receiver, built by hand, imported from an OpenAPI
  document, or saved from a captured request. A webhook item is an ordinary REST request — edited in
  the same editor, with the same auth, params, body, assertions and history — sent to a **target** set
  on the collection or overridden per folder, itself an ordinary project property (`webhookTarget`)
  that an environment or the workspace can override. Importing an OpenAPI 3.1+ document's root
  `webhooks`, or an OpenAPI 3.0+ operation's `callbacks`, offers an **Import webhooks & callbacks**
  checkbox; **Import webhooks…** on an API brings in items an earlier import left out, or ones the
  document has grown since; **Update Definition** keeps imported items in step without ever deleting
  a hand-made one. A callback's URL is resolved from the standard's runtime expressions against the
  parent request's last recorded exchange, falling back to the target when it does not resolve to an
  absolute URL — the editor's URL bar shows which and why. **Save as webhook…**, on a catch URL
  capture, turns a real delivery into a webhook item, dropping hop-by-hop headers and any header whose
  name mentions a signature. The collection is part of `formatVersion: 6`, with request scripts. See
  [Sending webhooks](https://wirebench.github.io/wirebench/docs/guides/sending-webhooks/).

- **Webhook signatures.** Webhook items, their folders and the Webhooks collection can sign what they
  send — *HMAC of body*, *Timestamped HMAC* or *Standard Webhooks* — with a secret from the keychain,
  or from `WIREBENCH_SECRET_<name>` in `wirebench run`. A catch URL can check the same schemes: each
  capture shows ✓ verified or ✗ with the reason, and **Reject unverified requests** answers 401 while
  still keeping the capture. The server keeps catch URL secrets encrypted under
  `WIREBENCH_SERVER_HOOKS_SECRET_KEY`.

- **Callback assertions.** A sequence step or a CI run waits for the webhook its request causes and
  checks it; CI tokens in Preferences → Devices & tokens, with `WIREBENCH_SERVER_URL` and
  `WIREBENCH_SERVER_TOKEN` for `wirebench run`. See
  [Callback assertions](https://wirebench.github.io/wirebench/docs/guides/callback-assertions/). A
  `callback` assertion is part of `formatVersion: 6`.

### Changed

- **Requests share the workspace cookie jar.** The per-request cookie memory is gone: every REST
  request now reads from and stores into the workspace jar. The *Send cookies* inherited default now
  shows off, matching what is sent (#44).
- **A WebSocket assertion reads a received message that is JSON as its value, not its text.** (#192)

  ```text
  received:  {"type":"ready"}   then   pong
  before:    ["{\"type\":\"ready\"}", "pong"]
  after:     [{"type":"ready"}, "pong"]
  ```
- **The catch-URL root is now Webhook inbox.** The Explorer node for a shared workspace's catch URLs,
  previously labelled *Webhooks*, is now **Webhook inbox** — the new per-project *Webhooks* node is
  for the webhook items described above. Nothing about catch URLs themselves changes.
- **Script refusals, reworded and a little stricter.** The rules that refuse a script's changes to a
  request (#63) are now applied in one place for every protocol, so five refusal messages read
  differently, and a script result that breaks two REST rules at once may report the other of the two.
  A destination that is not a URL with a host, such as a gRPC target `host:443`, must stay identical
  (a URL keeps its scheme, host and port). A REST body handed back as uneditable when it was
  editable is refused. With the `scripts` feature off, a request with active scripts is refused with
  `feature-disabled` and nothing is sent. Where a gRPC request with active scripts has no cached
  definition, the error is the script host's (`script-unavailable` or `script-type-error`) and no
  longer `grpc-definition-missing`: still an error, and nothing is sent.
- **A status assertion on an HTTP response.** One that names an all-capitals word which is not a status
  name now errors instead of failing. A request file cannot hold one, because its schema
  refuses it.
- **A webhook item's target is checked on the command line too.** `wirebench run` and the MCP `send`
  refuse a webhook item whose target is empty (`webhook-target-missing`) or is not an `http(s)` URL
  (`webhook-target-invalid`), before anything is sent, as the app always has. They used to try the
  send and fail later with another code.
- **One order for every send.** Each protocol now resolves the request, runs its pre-request script,
  then obtains the OAuth2 token and the proxy, applies TLS and connects. A SOAP send used to fetch its
  token and proxy before the script ran. The
  OAuth2 token request now uses the proxy chosen for the token URL, not the one chosen for the
  request's base URL. A cancel that lands while a send is still being prepared stops the send, for
  every protocol.
- **A send of any protocol takes the preferences a host lends.** The desktop's REST, SOAP, gRPC and
  WebSocket sends honour the user's preferences, as each applies: the user agent, compression, the
  timeouts, HTTP/2 and the TLS floor. The command line and MCP lend none, so their output is unchanged.
- **`wirebench run` includes WebSocket and streaming gRPC requests.** With no selector a run now sends
  them (see Added). A saved WebSocket request without assertions errors under `--require-assertions`.
  A sequence in `wirebench run --sequence` may have them as steps too.
- **A response read by an assertion or a transfer from an event stream is a JSON array.** For any send
  that is not live, which covers `wirebench run`, `send` and a desktop sequence step, the subject of an
  assertion over a Server-Sent Events response is a JSON array of each event's `data`, where it was the
  raw stream text. A saved `contains` or regular-expression assertion, or a transfer, written against
  that text needs rewriting: `contains: "data: ok"` becomes `contains: "ok"`, or a `match` on `$[0]`.
- **A sequence step on the desktop honours the step timeout**, and closing a project, or quitting,
  now stops the re-sends, multi-environment sends and sequence REST and WebSocket sends still in
  flight.
- **A send refused for an unresolved reference is logged.** A REST or SOAP send with a `${…}` reference
  nothing resolves is refused before anything is sent, and the HTTP Log now shows it as a row that
  never went out (`rest-unresolved-properties`, `unresolved-properties`), with no History entry. A SOAP
  send with such a reference used to go out with the reference left in it, on the desktop; it is
  refused there now, as the command line always refused it. The command line and MCP report the same
  codes. A gRPC call with such a
  reference (`grpc-unresolved-properties`), or with no method chosen (`grpc-method-unset`), is logged
  the same way, and so is a WebSocket connection with one (`ws-unresolved-properties`).
- **A send whose credential secret is missing is refused before the call.** The HTTP Log shows a
  prepare row and History records nothing (`secret-missing`).
- **An interactive gRPC call's request side.** A push after the half-close is refused with
  `grpc-stream-closed`. A half-close made before the call opens answers `{ closed: true }`, and the
  request side closes once the call opens.
- **A WebSocket connection's sending side.** A message sent or a disconnect asked for while the
  handshake is still under way waits for it, rather than being refused as `ws-session-unknown`; a
  message after the disconnect is refused with `ws-session-closed`. Cancelling a handshake the server
  has not answered fails the connection with `aborted`, and the HTTP Log shows it as a failed row;
  History still records the attempt as a session closed by an error. Closing a project, or quitting,
  ends a handshake still under way at once rather than waiting for its timeout. A message sent with
  its `${…}` references expanded is escaped as the request was when the connection opened, unsaved
  edits included, where it used to follow the saved request; its values are still read as they are
  when it is sent, so switching the environment mid-connection changes them.

### Fixed

- **A response cut short reports why.** A body that the deadline, a cancel or a dropped connection cut
  off reported `internal-error`. It now reports `timeout`, `aborted` or `network`. Exit codes are
  unchanged.
- **A scripted SOAP request re-sent from History runs its scripts**, and a SOAP re-send uses the
  request's TLS settings, as the original send did.
- **A sequence's Cancel stops the step in flight**, not only the steps after it.
- **An error message no longer shows a secret from the request when secrets are hidden.** A failure
  whose message quotes the URL it could not reach, with a `${secret:…}` value in its query, showed the
  value in the HTTP Log row, its HAR export and the error the app reported. The value is masked there
  now, for every protocol, as it is everywhere else.
- **A new SOAP interface no longer takes the folder name of a REST, gRPC or WebSocket API.** Adding an
  interface in the app, importing a legacy project and `wirebench import` of a WSDL could give the new
  interface the folder name an API already used. The next load then skipped that API, and the next save
  deleted its folder. Every API kind now avoids the folder names of the other API kinds, and a new
  interface avoids those of every API.

- **A request file can't read a file outside its project.** The body file a REST request names, and
  the message file a gRPC request names, must now be a file beside the request, as a WebSocket
  request's message files already had to be. A name such as `../../secret.txt` — from a pull, a shared
  folder or an import — refuses the project with `project-path-invalid` instead of loading that file
  into the request, where the next send would have carried it to the server.

- **A `matches:` assertion can't hang a run.** Its regular expression now runs off the main thread
  with a time budget, as XPath and JSONPath already did, so a pattern that backtracks badly fails
  the assertion instead of freezing the app or the CLI.

- **A REST request's API key stays on its own origin across redirects.** A key in a custom header
  such as `X-Api-Key` was sent on to a server on another origin when a redirect led there, and a key
  in the query string went with it when the server echoed it into the `Location`. On a hop to another
  origin the configured key's header is now dropped and its query parameter stripped. On a hop back to
  the request's own origin the key is sent again, as a definition read does.

- **The CA bundle adds to the default roots, as documented.** A CA bundle set in the preferences
  replaced the default trust roots instead of adding to them, so with a bundle holding only a private
  CA every public HTTPS site failed verification. The bundle's certificates are now trusted in
  addition to the default roots, for requests and definition reads alike.

- **A failed re-send from History says why.** Re-sending a SOAP, gRPC or REST entry that can't be
  re-sent showed an internal code such as `history-resend-origin` in the toast. It now shows the
  reason in words, for example that the entry was sent to another host and should be re-sent from
  its request.

- **An API's Base URL field follows a change made under it.** The field kept the value it was opened
  with, so a base URL rewritten while its tab stayed open — as Update Definition rewrites it — showed
  the old one until the tab was closed and opened again. It now follows the project, and still
  commits your own typing on blur or Enter as before.

- **A query typed into a REST URL is sent once.** `/echo?x=1` in the URL field is mirrored into the
  Params table, and the send added the table's rows to the URL that already carried them, so the
  server got `/echo?x=1&x=1`. The table is the request's query: a URL parameter with the same name and
  value as an enabled row is now that row, sent once. Requests already saved with both need no change.

## [2.2.1] - 2026-09-21

### Fixed

- **The update check no longer offers an older release.** A build newer than the latest published
  release — 2.2.0 while 1.1.0 was still the newest public one — was offered that older release as an
  "update", and **Download** would have installed it over the running version. An update is now
  offered only when the release is newer than the one running.

## [2.2.0] - 2026-09-20

### Added

- **WebSocket request kind.** A fourth container beside SOAP, REST and gRPC, in the same project, workspace,
  environments, history and search. *New WebSocket API…* takes a `ws://` or `wss://` URL; a request under it
  connects with headers, query parameters, subprotocols, the shared auth kinds that are a header or query
  value, the resolved proxy, a client certificate and the custom CA bundle. Every frame — sent or received,
  text or binary, control or data — appears on a live timeline as it arrives, with a pretty-printed view for
  JSON or XML text one toggle from the raw bytes. While connected, the composer sends a typed or saved
  message (`${…}` properties expand at send time); *Disconnect* closes with a chosen code (1000 or
  3000–4999) and reason, and the close frame and every ping/pong show as control rows. The handshake is one
  HTTP Log entry (`GET`, its headers, the `101` or the refusal, timing and TLS); the session appears in
  History when it closes, capped to its first 400 and last 100 frames within 1 MB — History's own re-send
  stays offered for a SOAP entry only. `kind: websocket` writes under the existing `formatVersion: 3`; a
  project without a WebSocket API is byte-identical to before. See
  [`docs/specs/2026-09-19-websocket-request-kind-design.md`](docs/specs/2026-09-19-websocket-request-kind-design.md)
  and the update to [ADR-0007](docs/adr/0007-apis-beside-interfaces.md).

- **Fleet-ready releases.** An MSI installer for Windows x64 and arm64, for Intune and other fleet
  tools (`msiexec /qn`); a CycloneDX SBOM with every release; build and SBOM attestations on tagged
  releases, checked with `gh attestation verify`. Windows signing through SignPath Foundation is wired
  into the release workflow and switches on with its secrets. Silent installs and download
  verification are on the install page, and the site has a code-signing policy.
- **User guide.** A documentation site at https://wirebench.github.io/wirebench/: install and first run on
  macOS, Windows and Linux, a ten-minute walkthrough, a guide for every feature area, a command and
  shortcut reference generated from the app, troubleshooting and an FAQ. It is published from `main` on
  every push, and its screenshots are shot from the app by the e2e suite.
- **Switching guide.** A Switching section on the site, one page per source — Postman collections,
  legacy SOAP projects, OpenAPI and Swagger, and cURL commands — each saying what carries over, what
  does not, and where the equivalent lives in Wirebench.
- **cURL import reads `--json`, `-G` and `-I`.** `--json` becomes a JSON body with its two headers,
  `-G` moves the data into query rows, and `-I` asks for HEAD.
- **CLI runner: `wirebench run` and `wirebench secrets list`.** A new package, `@wirebench/cli`
  (binary `wirebench`), runs the requests already saved in a project from a pipeline: `status`,
  `soap-fault`, `match` (XPath/XQuery/JSONPath), `schema` and `sla` assertions declared per request;
  `cli`, `junit`, `json` and `html` reports; secrets resolved from `WIREBENCH_SECRET_<NAME>` /
  `WIREBENCH_SECRET_<REF>` environment variables, never from the desktop's keychain-backed store;
  and exit codes a pipeline can branch on (0 pass, 1 assertion failed, 2 usage/load, 3 run error,
  130 interrupted). See
  [`docs/cli.md`](docs/cli.md) and
  [`docs/specs/2026-09-18-cli-runner-design.md`](docs/specs/2026-09-18-cli-runner-design.md).

  **Project format moves to version 4.** Saving a request now carries an optional `assertions:`
  list and an optional `…Env` name beside a `passwordRef`/`tokenRef`/`valueRef`/`clientSecretRef`.
  Both are additive, and a version-3 project migrates in memory without any data moving — but
  because this format drops unknown keys on save, **saving a project with this version writes
  `formatVersion: 4`, and an older Wirebench refuses to open it** (`format-too-new`). Everyone
  working on a project a 2.2+ build has saved needs to be on 2.2 or later too.
- **CI recipes for the runner.** `@wirebench/cli` and `@wirebench/engine` are published to npm; a
  container image is published to `ghcr.io/wirebench/wirebench-cli` (`linux/amd64` +
  `linux/arm64`); a GitHub Action (`wirebench/wirebench/action@<tag>`) and a GitLab template
  (`templates/gitlab/wirebench.gitlab-ci.yml`) wrap them. All four ways to run in CI map secrets
  to `WIREBENCH_SECRET_<NAME>` the caller sets — none of them holds or asks for one itself. See
  ["Run in CI"](docs/cli.md#run-in-ci) and
  [`docs/specs/2026-09-19-ci-recipes-design.md`](docs/specs/2026-09-19-ci-recipes-design.md).
  Publishing itself waits on the first tagged release after the npm organisation and the GHCR
  package's visibility are set up (see ["Before the first publishing
  release"](docs/release.md#before-the-first-publishing-release)).
- **HTTP Log: rows kept and Preserve log.** The number of rows kept is a setting (Preferences › Behaviour,
  100–5000, default 500). Preserve log keeps the rows in memory across closing or switching a workspace;
  it is never written to disk and is off again at every launch.
- **HTTP Log: compare two rows.** Cmd/Ctrl+click a second row to compare the two — a summary of each,
  request and response headers marked added/removed/changed, and request and response bodies side by
  side (pretty-printed when both are JSON or both XML). Escape goes back to one row.
- **HTTP Log: waterfall.** A Waterfall column shows each row's start and duration across the rows shown,
  split into connect, TLS, wait and download (hover for the breakdown; hidden while a row is selected); the
  Timing tab notes a reused connection.
- **HTTP Log: search, a Name column and sort.** Search matches headers, bodies (first 256 KiB) and the
  request name, with regex and match-case toggles; a Name column shows the saved request; click Time,
  Name, Status, ms or Size to sort.
- **HTTP Log: Export HAR.** Saves the rows the filter shows, in display order, as a HAR 1.2 file;
  headers, URL parameters, WS-Security passwords and JSON/form secrets are always masked, whatever
  the show-secrets toggle says. Failed sends carry an `_error`, truncated bodies `_truncated`.
- **HTTP Log row menu.** Right-click a row, press its detail's ⋯ button or press Shift+F10 on the selected
  row to copy it as cURL (POSIX or PowerShell) from what was sent, copy its URL, request or response headers
  or response body, resend the saved request as it is now, or open the request.
- **HTTP Log: failures before the request is built.** A send that fails before the request is built (invalid URL,
  proxy lookup, OAuth2 token fetch) now appears as a "Failed · before send" row, and its detail says the request
  never went on the wire.
- **Importing a legacy single-XML SOAP project.** _Import Legacy SOAP Project…_ (or _Legacy SOAP project_ in
  _Import…_, which also detects the file) brings a whole project file from an older SOAP workbench into a
  Wirebench project. It carries across the SOAP interfaces with their endpoints, every saved request (envelope
  unchanged, and gzip-compressed envelopes decoded), usernames, timeouts, encodings, project properties, and
  environments with their endpoint overrides. Each interface resolves from the definition the file carried, so
  the import works offline and the project reopens offline. What does not come across is listed in a report you
  can copy: passwords (to be re-entered), test suites, mock services, REST services, WS-Security and auth
  profiles. Scripts are kept, never run, under `imported-scripts/`. Picking such a file as a plain WSDL now says
  which format to choose instead of failing partway through.

- **Completion in the gRPC message editor.** Typing a key in the Message tab offers the fields of the message
  the cursor is in — not just the method's request type, so a nested field's own fields are offered inside it,
  and a repeated field's items are offered like the field itself. Accepting one writes the key with an empty
  value of the right JSON shape, and the suggestion carries the declared type, the field's `.proto` comment and,
  for an enum, its values. A key the object already holds is not offered, nor is the rest of a `oneof` whose
  member is already written. Other JSON editors in the app are unchanged. See
  [`docs/specs/2026-09-18-grpc-message-completion-design.md`](docs/specs/2026-09-18-grpc-message-completion-design.md).
- **gRPC live streaming and interactive bidirectional send.** A streaming call now shows itself while it runs:
  the response pane raises its tabs as soon as the call opens, the server's initial metadata appears when its
  headers arrive, and each reply is appended as it is decoded rather than all of them at the end. For a method
  whose client streams, *Open stream* starts the call and leaves the request side open — a composer under the
  response pane sends one more message at a time and *Half-close* stops sending without ending the call, so a
  bidirectional method can be held as a conversation. Every message pushed by hand is part of the exchange that
  is recorded, in `requestMessages` and in the raw request bytes. See
  [`docs/specs/2026-09-18-grpc-live-streaming-design.md`](docs/specs/2026-09-18-grpc-live-streaming-design.md).
- **gRPC server reflection.** Point Wirebench at a running gRPC server and it describes itself: the Import
  dialog's gRPC format gains a *Server* tab taking an address, the reflection version (automatic by default —
  `grpc.reflection.v1`, falling back to `v1alpha`) and whether to ask a server whose certificate does not verify.
  What comes back builds the same folder-per-service, request-per-method API a `.proto` import builds, and is
  cached with the project as the descriptor set the server sent. The gRPC API tab's Definition card gains
  *Refresh from server*: asking again adds a request for a method the server has gained and badges one whose
  method is gone, never deleting anything. The `grpcurl` line for a discovered API names no `.proto` files, since
  grpcurl asks the server itself. See
  [`docs/specs/2026-09-17-grpc-server-reflection-design.md`](docs/specs/2026-09-17-grpc-server-reflection-design.md).
- **gRPC.** A third protocol beside SOAP and REST, in the same project, workspace, environments, history and
  search. Import a `.proto` set (URL, file or paste; imports resolve from beside the root and the bundled
  `google/protobuf/*` types are built in) and get a gRPC API with a folder per service and a request per method,
  each seeded with a sample message; or start from *New gRPC API…* and a target. The editor picks the method from
  the definition, edits the message as JSON in the protobuf JSON mapping, carries metadata, auth and settings
  (deadline, size cap, TLS trust, bind address), and sends every streaming shape over HTTP/2; the response pane
  leads with the gRPC status and lists every reply with its initial and trailing metadata, timing, TLS and the raw
  exchange. Environments override a target the way they override a base URL; the Code slide-over and *Copy as
  Command* produce a `grpcurl`-style line. See
  [`docs/specs/2026-09-16-wirebench-grpc-client-design.md`](docs/specs/2026-09-16-wirebench-grpc-client-design.md)
  and the update to [ADR-0007](docs/adr/0007-apis-beside-interfaces.md).

- **HTTP Log: failed sends, a filter bar and detail tabs.** A send that fails before a response
  arrives (DNS, refused connection, TLS, proxy, timeout, abort, too many redirects) now gets a row
  in the console's HTTP Log, with the error code in the status column, the time it took to fail,
  and the request as it was about to go on the wire (final URL, headers with auth applied, raw
  request) — redacted when recorded and kept so. The log gained a
  *proto* column, a filter bar (URL text; method, status-class and protocol chips, with *failed*
  among the classes; an "n of m" count; *Reset*), ↑/↓ row selection, and a detail pane in five
  tabs: Headers, Request, Response, Timing (each unmeasured phase says why) and Connection
  (redirect hops and the TLS peer). The response pane header and Problems behave as before.

### Changed

- The HTTP Log's fixed 500-row limit is replaced by that setting.
- **Dependencies.** The engine now depends on `protobufjs` (BSD-3-Clause) for `.proto` parsing and message
  encoding; every JSON-mapping rule the editor relies on is applied in-house on top of it.

### Fixed

- **Postman import says what it left behind.** The summary lists the scripts, variables, credentials
  and auth types a collection could not bring across, with **Copy report**; before, they were computed
  and never shown. An OAuth 2 password or implicit grant is reported instead of silently becoming
  client credentials, and `{{var}}` in auth fields is translated like every other field.
- **A pasted `curl -u user:password` keeps the password**, stored as a secret, so the request
  authenticates on its first send instead of asking for the password again.
- **cURL flags no longer swallow the URL.** Value-less flags such as `--ntlm`, `--digest` and `-O` left
  the REST import without a URL, and a flag with a value such as `-o out.xml` made the file the SOAP
  endpoint. Bundled flags (`-sSL`, `-XPUT`, `-uada:pw`) are read as curl reads them.
- **The cURL preview follows its target.** A REST import previews the method, URL, headers, body kind
  and Basic user, without the SOAP-only warnings about `-u` and `-d @file`; the toast after an import
  names each ignored flag instead of counting them.

- **HTTP Log: a REST row follows the show-secrets toggle.** Turning _show secrets_ on or off now
  re-renders the selected REST row too, as it already did for SOAP; before, a REST row kept the
  redaction it had at send time (#50).
- Redaction masks `password`, `token`, `client_secret` and similar keys in JSON and form bodies, not only in XML.
- HTTP Log: ↑/↓ keep the selected row in view when fewer than 200 rows are shown.

## [2.1.1] - 2026-09-16

### Changed

- **Documentation.** The README's screenshots are re-shot against 2.1.0: the explorer as it looks
  now (fold chevrons, the method column, the tighter nesting) and the unified *Import…* dialog in
  place of the retired *Import WSDL…* entry. The capture spec dismisses the folder watcher's
  "changed on disk" banner first, so a picture no longer documents a bar the reader will not see.

## [2.1.0] - 2026-09-16

### Added

- **Shared workspaces.** A workspace can now be shared with a team: *Share this workspace…* turns
  it into a git repository (remote optional, branch default `main`) or moves it into a synced
  folder; *Join shared workspace…* clones one from a URL or opens an existing clone or synced
  folder. Every save becomes a commit with a generated message; a status-bar Sync badge and panel
  pull, push, fetch and show recent commits; a conflict resolver lists each conflicted entity with
  *Keep mine* / *Keep theirs* / *Open file*. Environments now travel with the workspace like
  everything else. See [`docs/collaborate.md`](docs/collaborate.md) and
  [ADR-0008](docs/adr/0008-shared-workspaces-are-git-repositories.md).

- **Not on this machine.** In a shared workspace, a request field whose secret ref has no value on
  this machine shows *Not on this machine* with an *Enter…* button; the value you type is stored
  locally under the same ref, so the shared files and your teammates' files never change.

- **Git preferences.** Preferences → Git shows the git executable Wirebench will run and its
  version, with *Locate…* to pick a specific binary and *Clear* to return to automatic discovery.

### Changed

- **Workspace format `3`.** `activeEnvironmentId` moves out of `workspace.yaml` into a
  machine-local `local.yaml` (it was never meant to be shared between members), and `writtenBy` is
  dropped from the manifest entirely. A version-2 workspace still opens and lifts its active
  environment on first open; a version-3 workspace is refused by an earlier build with the existing
  "created by a newer version of Wirebench" error. A shared workspace also gains a machine-local
  `share.yaml` (remote, branch and sync settings) alongside it, never written into the shared tree.

### Known limitations

- **Line-level merges.** Two edits to the same request's envelope (or any other single file) can
  still conflict at the line level even though one file is one entity; the conflict resolver
  covers this today, a YAML-aware merge driver is a listed follow-up.

- **No shared secret values.** Secret refs travel with a shared workspace; the values behind them
  stay per member. Shared, encrypted secret values are a follow-up for Wirebench Server.

- **Not every missing secret raises the named error.** A missing endpoint password or WSDL-import
  password fails at send time with a message naming the field; a missing keystore passphrase,
  proxy password, or WS-Security secret fails silently instead — check the field for *Not on this
  machine*.

- **Synced folders have no merge.** A `folder` share has no Sync control; two members saving the
  same file race on whatever the folder's own sync tool does about it, usually last-write-wins.

## [2.0.0] - 2026-09-14

The major version is the project format: a project this release has saved carries
`formatVersion: 3`, which a 1.1.0 build refuses to open. Everything a 1.1.0 project holds is
still read and rewritten in place.

### Added

- **REST client.** A project can now hold **APIs** beside its SOAP interfaces, each with folders and
  requests of its own, and the whole shell works the same for both: one explorer, one set of
  environments, one History, one search, one HTTP stack.
  - **Import an OpenAPI document** — *Import OpenAPI…* (`Mod+Shift+I`), from a URL or a file, 3.0 and
    3.1, YAML or JSON, with `$ref`s followed across documents. Operations become requests grouped
    into folders by their first tag, with path and query parameters as tables (required ones on,
    optional ones off), a request body sampled from the schema, and the document's security schemes
    recorded as the API's auth. The import summary lists what it could not map, and the document is
    cached beside the API byte for byte so *View document* and *Export…* give back exactly what was
    fetched. Or skip the document entirely: **New API** takes a name and a base URL, **New Request**
    a method and a path.
  - **Send anything.** Every method; JSON, XML, text, form, multipart and binary bodies; `{param}`
    path parameters; per-request headers and cookies; redirects followed and listed. The response
    pane shows status, duration and size, a pretty and a raw body, headers, cookies, the redirect
    chain, a timing breakdown and the TLS details — and the raw bytes of both directions.
  - **Auth per API, folder or request, inherited down the tree.** Basic, NTLM, Bearer token, API key
    (header or query) and OAuth2 — authorization code with PKCE through a loopback listener, or
    client credentials — with refresh handled for you. Nothing secret is written into a project:
    every credential is a reference to the OS keychain, and a token is redacted everywhere unless
    *show secrets* is on.
  - **Everything the SOAP side already had.** `${…}` property expansion in the URL, tables, headers
    and body; environment endpoint overrides that repoint an API's base URL; unresolved references
    and unfilled path parameters blocked before Send with a Problem; every send in History with its
    method badge; workspace search over URLs, tables and bodies; *Copy as cURL* and **Import cURL**
    both ways; and the response **Query** view, now over JSON as well as XML.
- **Query a JSON response.** The response Query view offers **XPath 3.1**, **XQuery 3.1** and
  **JSONPath** over a JSON body (the parsed document is the context item for the first two; `$` for
  the third). A JSONPath result shows the path each match was found at. An XML response is
  unchanged — XPath and XQuery, with the namespace table.
- **Reorder editor tabs.** Drag a tab to a new place in the strip, or move the active tab with
  *Move Tab Left* / *Move Tab Right* (`Mod+Shift+PageUp` / `Mod+Shift+PageDown`, or
  `Mod+Shift+←` / `→` on a focused tab). The order is kept with the workspace's tabs.
- **Explorer fold state is remembered per workspace.** Which projects, interfaces, bindings and
  operations are expanded or collapsed survives a workspace switch and a relaunch.
- **Request path.** The request editor shows where the request lives — *Project / Interface /
  Operation / Request* — above its toolbar, with the SOAP version badge (SOAPAction on hover) at
  its right. Double-click the request's name there to rename it in place.
- **Tab strip without a scrollbar.** When the open tabs do not fit, chevrons at either end page
  the strip along, the mouse wheel scrolls it sideways, and a menu at the far right lists every
  open tab. Long tab names are truncated, with the full name on hover.

### Changed

- **Project format version 3 — this is a one-way door.** A project gains an `apis/` tree beside
  `interfaces/`, so `formatVersion` moved to `3`. A version-1 or version-2 project opens unchanged
  and is rewritten at version 3 the next time it is saved. After that, **a 1.1.0 build can no longer
  open it** — it sees the newer version and refuses with "created by a newer version of Wirebench" —
  and that applies whether or not the project actually holds an API. Keep a copy if you need to go
  back.
- **Unsaved changes are never written behind your back, and never lost.** Quitting, or
  switching to another workspace, no longer saves your projects. Everything unsaved — request
  edits in tabs as well as properties, auth, endpoints, settings and renames — is kept with the
  workspace and comes back, still marked unsaved, the next time it opens; it is kept current while
  the app runs, so it also survives a crash or a force-quit. If a project changed on disk in the
  meantime, your unsaved changes are restored on top and a notice names the files that changed
  (or were deleted and so dropped). Only Save, Save All or autosave write a project.
- The explorer tree now starts collapsed below the project level, so a newly imported WSDL
  arrives as a single folded interface row; its project is unfolded so the row is visible.
- The request pane's right-click menu is shorter. *Validate request* stays on the toolbar and
  *Show code* in the right rail; *Recreate*, *Create empty*, *Clone* and *Copy as cURL* are still
  in the explorer's request menu and the command palette.
- The request toolbar's *Show code* icon is gone; the right rail's Code icon opens the same panel.
- The request toolbar no longer shows the operation's name or SOAP version; both are in the
  request path above it.

### Fixed

- *Recreate* run from the command palette now keeps an edit typed a moment before, instead of
  rebuilding the envelope without it.
- *Copy as cURL* now describes what is on screen, not the last-saved request: an unsaved edit to the
  URL, tables, headers or body is in the command it gives you.
- A redacted value in an exported cURL command is readable again; it used to arrive
  percent-encoded as `%3Credacted%3E` inside the URL.
- *Remember the refresh token* now responds to the click immediately instead of waiting for a round
  trip, so a quick tick no longer looked ignored.
- A REST send now appears in the console's HTTP Log and in the status bar's *last:* indicator. Both
  are shared with SOAP and both used to keep saying nothing had been sent while a REST response sat
  on screen.
- Durations read as `16 ms` rather than `15.645407999999861 ms` in the status bar, the HTTP Log, the
  response header line and History.
- *Save attachment as…*, *Save response as…*, *Open attachment* and *Save as…* for text now write the
  way every project file already did: to a temp file renamed into place. A crash mid-write no
  longer leaves a truncated file at the path you chose, and nothing watching that path can see it
  before it is whole.

### Dependencies

- Added `jsonpath-plus` (MIT), for the Query view's JSONPath language — with `jsep` and two of its
  plugins (all MIT) beneath it. It runs only in the main process; the renderer bundles neither it nor
  `fontoxpath`. Filter expressions are evaluated by `jsep`, never by the platform's `eval`.

## [1.1.0] - 2026-09-12

### Added

- **Workspaces.** Wirebench now groups any number of projects into a workspace stored under
  Electron's `userData`, with no folder to manage — the launch picker creates or opens one by
  name. A workspace holds its own environments, shared by every project it contains, with a
  `${#Workspace#…}` property scope; an interface's effective endpoint is the workspace
  environment's override, falling back to a linked project's own (name-matched) environment,
  then the interface's default. *Link existing project folder…* and *Import project folder…*
  bring an external project in for teams that keep it in git; *Export project…* writes it back
  out. Removing a project is trash-only and confirmed; a linked project's folder is never
  touched. Tabs, the explorer, and History span every project in the open workspace, and the
  last-open workspace (with its tab set) reopens on launch.

- **Environments view.** Environments moved out of the right panel into their own left-menu view
  (activity bar → *Environments*, `view.showEnvironments`), listing Globals, the workspace and
  every environment; opening one shows a variables table and an endpoint-overrides table, Postman
  style, instead of a grid.
- **Per-variable enabled checkbox.** Every property scope — project, environment, workspace,
  workspace environment, and globals — can now disable one variable without deleting it; an
  unticked variable's value stays on disk but is skipped during resolution, falling through to
  the next scope down.
- **Project tab.** Selecting a project row opens it as a normal pinned tab instead of a side
  panel, showing the project's own settings and properties.
- **Code slide-over.** A right icon rail replaces the old right panel; its one icon today opens a
  slide-over showing the active request as `curl` (`view.toggleCode`, `Mod+Alt+B`, the shortcut
  freed by the removed Details-panel toggle), closed by Escape or the rail icon again.
- **Collapsible, resizable panels.** The sidebar, console and Code slide-over can each be
  collapsed and resized by dragging their handle, by the chevron in the panel's own header or its
  status-bar toggle, or by double-clicking the handle to snap collapsed or restored. Dragging the
  sidebar's or the console's handle past the panel's minimum closes it, and dragging the same
  handle back out reopens it; sizes and collapsed state persist across a relaunch.
- **Environment selector in the title bar.** The active-environment switcher moved from the status
  bar to the top-right of the title bar, beside the theme toggle.
- **Preferences dialog.** Settings open as a modal dialog from the activity bar's foot (or
  `preferences.open`) instead of a sidebar list plus an editor tab.
- **Per-tab save.** `Mod+S` saves the request tab in front of you, and each tab shows its own
  unsaved dot; *Save All* (`Mod+Alt+S`) saves every open project. The project tab shows
  *Unsaved changes* / *Saving…* / *Saved* beside the project name.
- **Autosave preference.** *Preferences → Editor → Autosave projects* turns autosave back on;
  turning it on mid-session writes any outstanding edit straight away.
- **Code panel highlighting.** The `curl` / PowerShell preview is rendered as highlighted code,
  with flags, strings and heredoc bodies told apart.

### Changed

- **Saving is manual by default.** Edits stay in the open project until you save; closing a
  project or quitting still writes it. Enable the autosave preference above for the old
  behaviour.
- **One click opens.** Explorer requests and environments open on a single click; the environment
  being edited is highlighted in the Environments list. *Open* is gone from their context menus.
- **Context menus are grouped** with separators, and *Clone* sits with *Rename* and *Delete*.
- **Release artifact names** carry the OS and architecture (for example
  `Wirebench-1.1.0-mac-universal.dmg`, `Wirebench-1.1.0-windows-x64-setup.exe`); macOS ships
  universal, Intel and Apple-silicon builds, and Linux gains a `.snap`. See `docs/release.md`.
- **Project and workspace format, `formatVersion: 2`.** The per-variable enabled flag above is an
  additive format change: `properties` stays a plain `name -> value` map, and a sibling
  `disabled:` list of names sits beside it, sorted, deduplicated, and omitted entirely when
  empty. A version-1 file (no `disabled` key) still opens and migrates as "all enabled". **A
  1.0.0 build cannot open a project or workspace saved by this version** — it refuses
  `formatVersion: 2` with its existing "created by a newer version of Wirebench" error.
- **Global properties file, `version: 2`.** The same `disabled:` list, for the global scope's
  properties file in app data.

### Removed

- **Opening or creating a project by picking a folder.** The Welcome-screen "Open Project…" and
  folder-picker "New Project" flows are gone; a project is now created by name inside a
  workspace, and a folder dialog only appears for linking, importing or exporting a project.
- **The right panel.** Its contents moved, each to where it belongs: the request's interface,
  operation, SOAPAction, resolved endpoint (and which layer it came from) and project are now the
  request editor's *Details* inspector — one of the strip's inspectors, alongside the *Auth*,
  *WS-A*, *Attachments*, *Headers*, *Properties* and *SSL* inspectors that already existed;
  interface-level settings are in the interface tab, project settings and properties in the
  project tab, environments in the Environments view, and the Code view in the right-rail
  slide-over above. `view.toggleDetails` is gone.

### Fixed

- `Mod+S` pressed straight after typing saved the envelope as it was before the last keystrokes,
  and *Save All* could report success while staged request edits stayed unsaved.
- `Mod+S` with the caret in the request editor kept saving the first tab opened after switching
  tabs; go-to-definition had the same stale-tab lookup.

## [1.0.0] - 2026-09-11

First release: **Explore & Send**. Import a WSDL, understand it, build a request from the
contract, send it with whatever the service demands, and read the answer.

### Added

**WSDL and XSD**

- WSDL 1.1 parsing with `wsdl:import`, `xs:import` and `xs:include` resolved recursively from
  URLs or the filesystem, with a byte-exact local cache and a manifest recording origin and
  sha256.
- Schema sets over the imported documents: type resolution, substitution groups, element and
  attribute lookup, and position-aware queries used by editing and completion.
- Interface viewer, generated documentation, definition export, and Update Definition — which
  re-fetches a contract, reports what changed per operation, and can keep edited values.

**Request generation**

- A sample request for every operation: document/literal (wrapped and bare), rpc/literal and
  rpc/encoded, SOAP 1.1 and 1.2, header parts, `xsi:type` for abstract types, enumeration
  comments, optional-element and sample-value toggles, and the correct SOAPAction spelling per
  version.
- A form model over the same schema, so a request can be filled in as fields instead of XML and
  round-trips back to the envelope.
- `curl` import and export.

**Sending**

- HTTP over undici with raw request and response bytes captured, a timing breakdown, redirects,
  compression, encodings, per-request timeouts and mid-flight cancellation.
- Authentication: HTTP Basic (preemptive and on challenge) and NTLMv2, per request or per
  endpoint, with override/complement semantics.
- TLS: custom trust anchors and client certificates per endpoint, an SSL Info inspector, and a
  per-endpoint (never global) option to send to an endpoint whose certificate does not verify,
  badged permanently in the UI.
- Proxy support, including proxy authentication.

**WS-Security, WS-Addressing, attachments**

- Outgoing: Timestamp, UsernameToken (text and digest), Signature with the full key-identifier
  matrix (RSA-SHA256 and legacy options), and Encryption (AES-256-GCM with RSA-OAEP, plus legacy
  CBC). Verified against `xmlsec1` in CI.
- Incoming: signature verification and decryption, with a WSS inspector showing the result.
- PKCS#12 and PEM keystores, with passphrases held in the OS keychain.
- WS-Addressing headers for both versions, auto-enabled from `wsaw:UsingAddressing`.
- MTOM/XOP and SwA attachments, inline `file:` and `cid:` references, and response attachments
  listed and openable.

**Validation**

- XSD validation of requests and responses via libxml2 (WASM), with problems mapped to exact
  line and column markers.
- A WS-I Basic Profile subset check for both WSDLs and messages, with assertion ids, an HTML
  report export, and the implemented list published in `docs/ws-i-assertions.md`.

**Projects, environments, history**

- Folder-based project format (`formatVersion: 1`): YAML for configuration, XML for envelopes,
  one concept per file, stable key order — renaming a request touches exactly two files.
- Environments with per-environment endpoints and properties; property expansion across global,
  project, environment and request scopes, with unresolved expansions surfaced in Problems.
- History of every send, outside the project folder, with re-send and diff, surviving restart.
- Secrets in `safeStorage` behind `secretRef` ids; no secret ever reaches a project file, a log,
  an export or the renderer.

**The IDE shell**

- Sidebar with explorer, search, history, trust and settings views; editor tabs; a details panel;
  a console with HTTP log, problems, WS-I report and errors; a status bar.
- Monaco everywhere text is edited, with XML, Form, Outline and Raw views for requests and an
  additional Query view (XPath 3.1 and XQuery 3.1) for responses.
- A command palette listing every command, full keyboard navigation of the import→send flow, and
  dark and light themes with a contrast-checked token palette.

**Quality and release**

- `pnpm check` (lint, typecheck, docs check, contrast check, tests, performance budgets) on
  macOS, Windows and Linux in CI, with the engine held at ≥ 85% coverage.
- A Playwright suite driving the built app — and, in `packaged.spec.ts`, the packaged one.
- An `xmlsec1` cross-check job, and a nightly interop suite against four live public services.
- electron-builder packaging for all three platforms with six hardened Electron fuses, an opt-in
  consent-gated update check, and a tag-driven draft-release workflow.
- Documentation: quick start with screenshots, architecture overview, security model, ADR-0001 to
  ADR-0005, and a success-criteria evidence table.

### Known limitations

- The theme screenshot comparison runs on macOS only; the rest of the e2e suite runs on all three
  platforms.
- The `xmlsec1` cross-check needs `xmlsec1` installed, so locally it is skipped unless
  `WIREBENCH_REQUIRE_XMLSEC=1`; CI always runs it.
- The interop suite covers four public services, not five: crcind's SOAP.Demo was unreachable both
  when fixtures were captured and when the suite was written.
- Keystores are PKCS#12 and PEM; JKS is planned. NTLM is NTLMv2 only; SPNEGO/Kerberos is planned.
- English only.

<!-- 1.0.0 was never published; its tag and draft release were withdrawn in favour of 1.1.0. The links resolve once `v1.1.0` is pushed (see docs/release.md). -->
[Unreleased]: https://github.com/wirebench/wirebench/compare/v6.1.0-rc.7...HEAD
[6.1.0]: https://github.com/wirebench/wirebench/compare/v6.0.0-rc.1...v6.1.0-rc.7
[6.0.0]: https://github.com/wirebench/wirebench/compare/v5.0.0...v6.0.0
[5.0.0]: https://github.com/wirebench/wirebench/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/wirebench/wirebench/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/wirebench/wirebench/compare/v2.2.1...v3.1.0
[2.2.1]: https://github.com/wirebench/wirebench/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/wirebench/wirebench/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/wirebench/wirebench/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/wirebench/wirebench/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/wirebench/wirebench/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/wirebench/wirebench/releases/tag/v1.1.0
