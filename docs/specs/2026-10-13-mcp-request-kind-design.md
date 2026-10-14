# MCP request kind: testing MCP servers from Wirebench (design)

Issue: #79 · Date: 2026-10-13 · Status: approved to build (owner's answers, 2026-10-13)

## Objective

A developer points Wirebench at an MCP server and tests it the way they test any API. The server can be
a local process (stdio) or an HTTP endpoint. Wirebench fetches the server's tools, resources and prompts
into the project. It calls a tool with arguments checked against the tool's input schema, and records
every JSON-RPC message of the exchange. The result can be asserted on in a run in CI.

This is the other direction from `wirebench mcp` (#32). There, Wirebench *is* an MCP server that agents
drive. Here, Wirebench is an MCP *client*. No model runs in the app (roadmap, "Deliberately not").

## Decisions (owner, 2026-10-13)

1. **A protocol kind of its own, `mcp`.** #184 already says so: "The MCP request kind (#79) is a
   protocol." It does not ride on REST, as GraphQL (#77) did. One of its three transports is not HTTP, and
   the conversation is a JSON-RPC session rather than one request and one response. It is a fifth
   `ProtocolModule` (ADR-0017) in `packages/engine/src/mcp/`, plus a fifth desktop kind (ADR-0023).
2. **Three transports:** stdio, Streamable HTTP, and the legacy HTTP+SSE transport (protocol
   2024-11-05) for servers that have not moved on.
3. **Tools, resources and prompts.** One request is one operation: `tools/list`, `tools/call`,
   `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list` or `prompts/get`.
   There are no free-form JSON-RPC methods.
4. **A stdio command is approved per machine.** The command line lives in the project, so a `git pull`
   can change what *Send* runs. The desktop asks once per command line and again after any change. The
   CLI and `wirebench mcp` refuse a stdio send unless `--allow-commands` is passed.
5. **Runs, sequences, assertions and scripts.** An MCP request is runnable everywhere a REST request
   is. It has pre- and post-request scripts under ADR-0016.
6. **Auth over HTTP is the existing auth.** The auth types a REST request has, plus headers, proxy, TLS
   and client certificates. (As built: the types that answer a challenge and resend — NTLM, Digest, AWS
   Signature v4 and Kerberos — are refused with `mcp-auth-unsupported`, since a session's calls carry
   their credentials up front; Basic is sent on every call.) MCP's own authorization discovery (protected-resource metadata and dynamic
   client registration) is a follow-up issue.
7. **The catalogue is kept in the project.** *Refresh catalogue* stores the server's lists as a
   committed, diffable file beside the server, as a GraphQL schema is. The file drives the tool picker
   and argument checking, and a diff of it shows contract drift.
8. **One session per send**, in the desktop and in runs alike: connect, initialize, run one operation,
   close. Each exchange is self-contained, and the desktop behaves as CI does.
9. **Server requests are refused and recorded.** Wirebench declares no client capabilities. A request
   the server sends, such as `sampling/createMessage`, `elicitation/create` or `roots/list`, is answered
   with JSON-RPC `-32601` (method not found). Both messages appear in the exchange.

## Model and format

An MCP server is a container under `apis/`, beside REST, gRPC and WebSocket APIs (ADR-0007).

```
apis/<slug>/api.yaml                       kind: mcp, the server's connection
apis/<slug>/catalogue.json                 the fetched catalogue (optional)
apis/<slug>/requests/**/<slug>.request.yaml
apis/<slug>/requests/**/<slug>.args.json   a call's arguments (optional)
```

- **`api.yaml`** holds `kind: mcp`, `id`, `name`, `order`, `description` and `transport`. A
  `transport` is one of these:
  - `{ type: stdio, command, args: [..], cwd?, env: [entries] }`. `cwd` is relative to the project
    folder. When it is absent, the server runs in the project folder.
  - `{ type: http, url, headers: [entries], auth }`, for Streamable HTTP.
  - `{ type: sse, url, headers: [entries], auth }`, for legacy HTTP+SSE. `url` is the SSE endpoint.

  The file also holds `settings: { timeoutMs?, protocolVersion? }` and, after a refresh, `catalogue:
  { fetchedAt, serverInfo: { name, version }, protocolVersion }`. Every string expands `${…}`
  references, `${secret:…}` included.
- **A request** holds `kind: mcp`, `id`, `name`, `order`, `description` and `operation`. An `operation`
  is one of these:
  - `{ method: tools/list | resources/list | resources/templates/list | prompts/list }`
  - `{ method: tools/call, tool, arguments: { file: <slug>.args.json } }`
  - `{ method: resources/read, uri }`
  - `{ method: prompts/get, prompt, arguments: [entries] }`, since prompt arguments are strings

  Beside the operation it holds `assertions`, `scripts` and `settings: { timeoutMs? }`. Requests nest
  in folders through the shared `folder.yaml`. A `tools/call` with no arguments writes no sibling file
  and sends `{}`.
- **`catalogue.json`** is the server's `tools`, `resources`, `resourceTemplates` and `prompts`, each
  sorted by name (or URI), pretty-printed with stable key order so that a refresh with no change saves
  byte-identical. It holds only the lists the server advertised in its capabilities. Pages are followed
  through `nextCursor`, up to 50 pages per list.
- **Format 10.** Format 10 has not shipped, so the `mcp` kind joins it, as GraphQL did. An older build
  meets an unknown kind, so it loads the server as a placeholder and does not rewrite it (ADR-0017). The
  v10 JSON Schemas gain the `mcp` arms.
- **Feature:** `{ id: 'mcp', title: 'MCP', default: true, stage: 'experimental', requires: [] }`.
  `WIREBENCH_KINDS=mcp=off` switches it off like any other kind.

## The session

One send runs these steps:

1. Connect.
2. `initialize`, with `protocolVersion` set to the setting or the latest version the bundled SDK knows,
   `capabilities: {}`, and `clientInfo: { name: 'wirebench', version }`.
3. Check the server's answer: a protocol version the client supports, and the capability the operation
   needs. A server that did not advertise `tools` fails a `tools/call` with `mcp-capability-missing`
   before the call is sent.
4. Send `notifications/initialized`.
5. Run the operation.
6. Close.

The whole session has one deadline, `timeoutMs`. The request's value wins over the server's, and the
default is 30 s. When the deadline passes, the client sends `notifications/cancelled` for the request
still waiting and closes the session.

- **The client is Wirebench's own**, written against the protocol types and schemas of
  `@modelcontextprotocol/sdk` (MIT). The SDK is already in the CLI, and it moves into the engine's
  dependencies. The SDK's `Client` and transports are not used. They throw where a test tool must
  report, and they hide the wire. Every message is validated against the SDK's schemas. A message that
  does not match is a warning in the exchange, and is not dropped.
- **stdio.** The server is spawned with `spawn`, with no shell, as `command` with `args`, from `cwd`.
  Its environment is the parent's `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR` and `SYSTEMROOT` (where
  set), plus the expanded `env`. On Windows it also inherits the profile and system folders a
  launcher such as `npx` needs (`APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `PATHEXT`, `TEMP` and the
  like), matched without regard to case. Messages are newline-delimited JSON. stderr is kept as text, capped at
  64 KiB. On close, stdin is ended. The process gets `SIGTERM` after 2 s and `SIGKILL` 2 s after that.
  A process that exits early fails the send with `mcp-server-exited`, which gives the exit code and the
  tail of stderr.
- **Streamable HTTP.** Every client message is a `POST` through the engine's HTTP client (`sendHttp`),
  so it gets the proxy, TLS, client certificates and timings. Each `POST` carries `Accept:
  application/json, text/event-stream`. After `initialize`, it also carries `Mcp-Session-Id` (when the
  server gave one) and `MCP-Protocol-Version`. A response can be `application/json` or an event stream,
  read message by message through the SSE parser. A `202` answers a notification. On close, a session
  that has an id is ended with `DELETE`. A `405` there is fine. The optional `GET` stream for
  unsolicited server messages is not opened, because one operation needs only what comes back on its
  own `POST`.
- **Legacy SSE.** A `GET` to `url` opens the event stream. Its first `endpoint` event names the URL
  that client messages are `POST`ed to, and that URL must have the same origin (`mcp-endpoint-origin`).
  Answers arrive on the stream.
- **Auth** is applied to every HTTP call of the session, as REST applies it. An OAuth2 token is fetched
  once per send. Basic is encoded on every call rather than after a challenge. NTLM, Digest, AWS
  Signature v4 and Kerberos cannot be applied up front, so a send with one fails with
  `mcp-auth-unsupported` before anything is sent.
- **The SSE parser moves into core** (`rest/sse.ts` to `http/sse.ts`). ADR-0017 rule 1 forbids `mcp/`
  from importing `rest/`.
- **Limits.** A message is capped at 4 MiB (`mcp-message-too-large`). The exchange keeps 1,000 messages
  at most, and History caps it as WebSocket frames are capped (the first 400 and the last 100, 1 MB); a
  result over 256 KiB is left out of the History entry and flagged.
- **Error codes** (as built). Besides those above: `mcp-spawn-failed`, `mcp-connection-closed`,
  `mcp-timeout`, `mcp-cancelled`, `mcp-initialize-failed`, `mcp-protocol-unsupported`,
  `mcp-transport-failed`, `mcp-bad-url`, `mcp-http-status`, `mcp-http-failed`, `mcp-stream-expected`,
  `mcp-endpoint-missing`, `mcp-endpoint-invalid`, `mcp-arguments-invalid` (a tool call's arguments are
  not one JSON object), `mcp-auth-unsupported` and `mcp-unresolved-properties`; a refresh adds
  `mcp-catalogue-failed` and `mcp-catalogue-invalid`.

## The stdio approval

- The **fingerprint** of a command line is the SHA-256 of the expanded `command`, `args` and `cwd`,
  plus the *names* of the `env` entries. The values are left out, so rotating a secret does not ask
  again. Changing the command, an argument, the folder or the set of variables does ask again.
- **Desktop:** approvals are kept per machine in the app's data folder (`mcp-approvals.json`), never in
  the project. A send whose fingerprint is not approved opens a dialog. The dialog shows the command line
  as it will run (with secrets shown as their `${secret:…}` reference), the folder, and the variable
  names. In the displayed command line an argument is bare when plain, a Windows path reads as written
  (backslashes not doubled), any other argument a reader could misread is single-quoted, and one holding
  a single quote is shown as a JSON string. Its buttons are *Run once*, *Always allow* and *Cancel*.
  Dismissing the dialog, closing the window, or leaving the prompt unanswered for five minutes counts as
  *Cancel*. In a run, the dialog is asked once per fingerprint before the first send. *Refresh catalogue*
  goes through the same gate. The dialog is mounted by the shell, so a prompt from a run or a refresh
  started anywhere is answered; main asks through the `mcp.approval` event and the window answers with
  `app.mcpApprove`.
- **CLI and `wirebench mcp`:** a stdio send without `--allow-commands` fails with
  `mcp-command-unapproved`. The error names the command, and the CLI's advice names the flag.
  `wirebench mcp --allow-commands` passes the permission to every tool call of that server process.
  HTTP transports need no approval.
- The engine holds the rule: a send asks its host's `approveCommand(request)`, a
  `CommandApprovalRequest` carrying the fingerprint, the masked display, the folder, the variable names
  and the server's name. A host that gives none refuses, so a new host cannot skip the gate by accident.

## Results and checks

- **The exchange** (`McpExchange`) records:
  - the transport, and the server's `initialize` result;
  - every message, with its direction, time, size, JSON-RPC id and method, and any schema warnings;
  - for HTTP, each HTTP call: method, URL, status, headers and timings;
  - for stdio, the stderr text and the exit code;
  - the operation's `result` or `error`, and the duration.
- **The subject assertions see.** The body is the operation's `result` as JSON, or `{"error": {…}}`.
  The headers are those of the operation's HTTP response (none for stdio). The status is the HTTP status
  of the operation's `POST` for Streamable HTTP, and `0` otherwise. The existing JSONPath, contains,
  duration and schema assertions work on it unchanged.
- **The "MCP result" check.** A run, or a sequence step, adds a check named "MCP result". The check
  fails on a JSON-RPC error. It also fails on a `tools/call` result with `isError: true`, and its
  `actual` holds the first text content. Like the GraphQL errors check, it does not count as an
  assertion for `--require-assertions`.
- **Against the catalogue.** When the catalogue has the tool, the arguments are validated against its
  `inputSchema` before the call. A mismatch is a warning and does not refuse the send, because sending
  bad input on purpose is a test. A `structuredContent` that does not match the tool's `outputSchema` is
  a warning as well. Both use the engine's existing JSON Schema validator (`json/schema-validate.ts`).

## Scripts

- The **pre-request** snapshot is the operation, and the script may change it: tool, arguments, URI,
  prompt and prompt arguments. A script may not change the method (it is fixed, through `inspect`) or the
  transport. For the HTTP transports the origin rule holds (`script-origin-change`). For stdio, the
  command line is not in the snapshot at all, so a script cannot change what is approved.
- The **post-response** snapshot is the result or error, `isError`, the server's `serverInfo`, the
  message count and the duration. `tests` and `vars` behave as they do for REST.
- `scripts.secrets` and every other rule of ADR-0016 apply unchanged. `script/apply.ts` runs them through
  the module's `inspect`.

## Desktop

- **Explorer.** A project's menu gains *New MCP server…*. The dialog asks for a name, the transport, and
  the command and arguments or the URL. A server's row shows its requests and folders. Its menu offers
  *New request*, *Refresh catalogue* and *New request from tool…*. Requests show their method's short
  form as a badge: `CALL`, `READ`, `GET` or `LIST`.
- **Server tab.**
  - Connection: transport; command, arguments, folder and environment, or URL, headers and auth.
  - Settings.
  - Catalogue: the tools, resources, templates and prompts with their descriptions, the
    "Fetched <date> from <server> <version>" line, and *Refresh*. A tool row offers *New request*.
- **Request tab.**
  - An operation bar: method, tool or prompt picker (from the catalogue, free text allowed), URI, and
    *Send*.
  - Tabs: Arguments, Assertions, Scripts, Settings. The Arguments tab is a JSON editor that takes the
    tool's `inputSchema` for completion and markers. It uses Monaco's JSON language, which the REST body
    editor already loads, so no new renderer code is eager. Completion walks the schema in the
    renderer's mirror of the catalogue. Markers come from main, as the GraphQL editor's do: once typing
    pauses the editor asks `request.mcpArgumentsCheck`, which parses the text (an error where the parse
    stopped) and validates it against the `inputSchema` with the engine's validator (warnings, since a
    send only warns on a mismatch). Prompt arguments are a key-value table.
- **Response pane.**
  - A status line: "OK", "Tool error (isError)" or "Error −32602 Invalid params", or why the session
    stopped with the tail of stderr, plus the duration, the message count and the warnings count.
  - *Result*: content blocks rendered by type. Text is shown as text. Images are shown from base64.
    Audio shows as a labelled block. Resource links and embedded resources show their URI, MIME type and
    text. `structuredContent` is shown as pretty JSON.
  - *Messages*: the JSON-RPC timeline in both directions, with the HTTP calls or the stderr beside it.
- **Runs.** A sequence step can name an MCP request (badged MCP, placed by server and the tool, prompt
  or resource it names), and *Run…* on a server row runs its requests in the Runner.
- **History** keeps each send, with its messages capped. A History entry can be opened but not re-sent
  in this slice: a re-send would also need the approval. MCP sends are not written to the HTTP Log,
  because History is their record.
- Main holds the session, the approval store and the catalogue refresh. A refresh writes nothing to
  History; main saves `catalogue.json` and the metadata through the host. The renderer gets summaries over
  IPC and loads no MCP SDK code: the CSP trap, and the 14 MB budget.

## CLI and the MCP server

- `wirebench send` and `wirebench run` (sequences included) take MCP requests; `send` prints the result,
  or the JSON-RPC error, as JSON in `body`, the way assertions read it. `--allow-commands` is new on
  `send`, `run` (it covers sequence steps; there is no separate `sequence` verb) and `mcp`; every other
  verb refuses the flag rather than ignore it. A `--body` override is refused for an MCP request, as for
  WebSocket: it has no envelope or body to replace. `wirebench operations` lists the saved MCP requests.
- The MCP server's `send` tool sends an MCP request like any other. History records CLI sends as it
  records the others.

## Out of scope (follow-ups)

- MCP authorization discovery and dynamic client registration (decision 6).
- A session held open across sends. Subscriptions (`resources/subscribe`) and the unsolicited `GET`
  stream.
- Answering server requests: sampling, elicitation and roots.
- `completion/complete`, `logging/setLevel`, `ping` as an operation, and tasks.
- Importing servers from an MCP client's config file (`mcpServers` JSON).
- A CLI command that refreshes the catalogue and fails on drift.
- Re-sending from History, and MCP in exports (Postman, OpenCollection), cURL and code generation.

## Testing

- **Engine unit tests:**
  - the model round-trip, storage (byte-identical saves, the args sibling, the catalogue file);
  - the SSE parser after its move;
  - each transport against the SDK's `McpServer`. Streamable HTTP and SSE run in process on a local
    port. stdio runs a fixture script.
  - the session's steps, server requests refused, schema warnings, the deadline and cancellation, and
    the size caps;
  - the fingerprint, the approval gate in the run facet, the subject and the "MCP result" check;
  - scripts, secret needs and redaction, History capping, and the catalogue refresh with pages.
- **Engine integration test:** a run of an MCP API against a stdio and an HTTP fixture, with
  assertions.
- **CLI tests:** `send` with and without `--allow-commands`, and the MCP server's `send` tool.
- **Desktop unit tests:** the mutations, the host, the channels, the approval store and dialog, the
  explorer rows, the request editor, the response pane, and the guard tests that list kinds.
- **One e2e spec** (CI only), against a fixture server in `e2e/fixtures/mcp-stdio/` written as plain
  newline-delimited JSON-RPC, so the app can spawn it without resolving the SDK from there:
  1. Create a stdio server pointing at the fixture.
  2. Approve it and refresh the catalogue.
  3. Create a request from a tool, send it, and see the result.
  4. Call the tool that sets `isError` and see the error status.
