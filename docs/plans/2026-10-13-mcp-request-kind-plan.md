# MCP request kind: Implementation Plan

> Steps use `- [ ]`. One commit per task, after `WIREBENCH_SKIP_PERF=1 pnpm check` is green.

**Goal:** a fifth protocol kind, `mcp`, which tests an MCP server over stdio, Streamable HTTP or legacy
SSE. It keeps the server's catalogue in the project, records every JSON-RPC message, and is runnable,
assertable and scriptable.

**Spec:** docs/specs/2026-10-13-mcp-request-kind-design.md

## Global constraints

- **New engine dependency:** `@modelcontextprotocol/sdk`, at the CLI's pinned version. Import only
  `@modelcontextprotocol/sdk/types.js` (schemas, types, version constants). Never import its `Client`
  or transports. After adding it, run `pnpm licenses:third-party`.
- **The SSE parser stays in core.** ADR-0017 rule 1: `mcp/` imports core only. Add `mcp: ['mcp']` to
  `GROUP_FOLDERS` in `scripts/engine-import-graph.mjs`.
- **No eager value imports in the renderer** of the engine root, the SDK or zod wire modules (the CSP
  trap). Lazy-load the editors (renderer JS has a 14 MB budget).
- **Persisted fields:** new ones are optional and omitted when unset. Saves stay byte-identical.
- **Format** stays 10 (unreleased). Run `tsc -b` before `pnpm schemas:project`.
- **IPC names** are pinned in `apps/desktop/test/fixtures/ipc-names.json`.
- **Main-process strings:** after touching them, run `pnpm --filter @wirebench/desktop build`. A string
  ending in "import" truncates the bundle.
- **Commits** are made as Mohammed Naami, with no trailers. Never name another product as the
  inspiration.

## Order and status

Tasks 1 to 10 are the engine, 11 is the CLI, 12 to 17 are the desktop, and 18 and 19 are e2e and docs.
Each task leaves `pnpm check` green.

---

### Task 1: Move the SSE parser into core

**Files:** `packages/engine/src/rest/sse.ts` → `http/sse.ts`, importers, tests.

- [x] Move `createSseParser`, `isEventStream` and `SseRow`. REST imports them from `http/`.
  `project/history.ts`'s type import follows.
- [x] Engine-layers check green. No behaviour change. The existing SSE tests move with the file.

### Task 2: Model, storage and the registered module

**Files:** new `mcp/{model,files,storage,shape,module}.ts`, `protocols.ts`, `project/schema-parts.ts`
(`SUPPORTED_KINDS`), `project-files.ts`, `index.ts` (model exports), `scripts/engine-import-graph.mjs`,
tests.

- [x] `McpServer` (the container, `kind: 'mcp'`), the `McpTransport` union (stdio, http and sse),
  `McpRequestDef`, the `McpOperation` union, folders, settings, and the `catalogue` metadata.
  `mcpServersOf` / `withMcpServers`.
- [x] File schemas for `api.yaml` and `*.request.yaml`. The `tools/call` arguments go in the sibling
  `<slug>.args.json`, written only when it is not empty. `catalogue.json` uses a stable sort and key
  order. A missing args file is a problem, and the arguments load as `{}`. An args file name that leaves
  the request's folder is refused.
- [x] `mcpProtocol` with the storage facet only, feature `mcp` (experimental, default on), added to
  `BUILTIN_PROTOCOLS` and `AnyRequestDef`.
- [x] Regenerate the v10 JSON Schemas. Add a format-10 history note.
- [x] Tests:
  - a round trip for each transport and each operation;
  - byte-identical re-save;
  - the args sibling, the catalogue file, path traversal;
  - with the feature off, the server is a placeholder;
  - default-registry, public-exports and schema-split updates.

### Task 3: JSON-RPC session core and the stdio transport

**Files:** new `mcp/{jsonrpc,session,transport,stdio,limits}.ts`, test fixture
`test/fixtures/mcp/stdio-server.mjs` (SDK `McpServer` over stdio), tests.

- [x] `McpWireTransport` interface (`McpTransport` is the saved configuration in `model.ts`): `start`, `send(message)`, `close`, and `onMessage` / `onClose` /
  `onError`. A recorder wraps it and records each message: direction, `at`, size, id, method, and any
  warnings from the SDK's `JSONRPCMessageSchema`.
- [x] stdio:
  - `spawn` with no shell, under the env allowlist, from `cwd` resolved against the project folder;
  - newline-delimited JSON;
  - stderr capped at 64 KiB;
  - shutdown: end stdin, then `SIGTERM` after 2 s, then `SIGKILL` 2 s later;
  - an early exit fails with `mcp-server-exited`, giving the code and the stderr tail.
- [x] Session steps:
  - `initialize`, then the version and capability check (`mcp-capability-missing`,
    `mcp-protocol-unsupported`);
  - `notifications/initialized`, then the operation, then close;
  - one deadline, with `notifications/cancelled` when it passes (`mcp-timeout`);
  - a server request is answered `-32601` and recorded;
  - messages over 4 MiB fail (`mcp-message-too-large`), and the exchange keeps at most 1,000 messages.
- [x] Tests against the fixture:
  - list tools, call a tool, and call a tool with `isError`;
  - the server sends a `roots/list` request;
  - a server that never answers (the timeout);
  - a crash on start;
  - an invalid message gives a warning.

### Task 4: Streamable HTTP transport

**Files:** new `mcp/http-transport.ts`, test helper `test/helpers/mcp-http-server.ts` (the SDK's
`McpServer` with `StreamableHTTPServerTransport` on a local port), tests.

- [x] Each message is a `POST` through `sendHttp`, with the `Accept` header, and the session-id and
  protocol-version headers after `initialize`. A JSON response and an event-stream response (through
  `http/sse.ts`) are both read. `202` is accepted. On close, `DELETE` (a `405` is fine).
- [x] Each HTTP call is recorded: method, URL, status, headers, timings. TLS, proxy and client
  certificates come from the settings, as REST's do.
- [x] Tests: a JSON-response server, an SSE-response server, a session id carried over, an HTTP 4xx or
  5xx on initialize (`mcp-http-status`), and `DELETE` on close.

### Task 5: Legacy HTTP+SSE transport

**Files:** new `mcp/sse-transport.ts`, a test helper using the SDK's `SSEServerTransport`, tests.

- [x] A `GET` opens the stream, and the `endpoint` event gives the POST URL. An endpoint with another
  origin fails (`mcp-endpoint-origin`). Answers arrive on the stream. On close, the stream is aborted.
- [x] Tests: a round trip, a cross-origin endpoint, a stream that closes before `endpoint`.

### Task 6: Operations, the exchange and the result check

**Files:** new `mcp/operation.ts`, `mcp/exchange.ts`, `mcp/check.ts`, tests.

- [x] Build each operation's params, and validate each result against the SDK's schema for it. A
  mismatch is a warning.
- [x] `McpExchange` as the spec gives it. `mcpSubject(exchange)` gives the body, headers and status.
- [x] `checkMcpResult` (the "MCP result" check): fails on a JSON-RPC error or `isError: true`.
- [x] Catalogue checks:
  - the arguments against `inputSchema` (warning);
  - `structuredContent` against `outputSchema` (warning), through `json/schema-validate.ts`.
- [x] Tests for each operation, each failure, and each warning.

### Task 7: Run facet: expansion, auth, approval and send

**Files:** new `mcp/run.ts`, `mcp/expand.ts`, `mcp/approval.ts`, `mcp/secrets.ts`, `mcp/module.ts`,
`protocols.ts` (`SelectedRequest`, `SentExchange`, `LiveEvent`), `run/run.ts` if needed, tests.

- [x] `groups`, `whyNotRunnable`, `open` → `ExchangeHandle` with live message events, `resolve`, and
  `secretNeeds`.
- [x] Expansion:
  - `${…}` references expand in the transport fields, the operation's strings and the arguments (with
    JSON escaping);
  - auth goes through `http/auth`, with one token per send;
  - the request's timeout wins over the server's.
- [x] `commandFingerprint` (SHA-256 of the expanded command, args and cwd, plus the env names).
  `SendHost.approveCommand?(fingerprint, display)`. When the host has none, or refuses, the send fails
  with `mcp-command-unapproved`.
- [x] The secrets facet: scan targets and moves over the transport env and headers, the operation
  strings and the arguments.
- [x] Tests:
  - an MCP API run against the stdio and HTTP fixtures, with assertions and the "MCP result" check;
  - an unapproved stdio send;
  - secret needs;
  - a sequence step.

### Task 8: History entry and redaction

**Files:** new `mcp/history-entry.ts`, `project/history.ts` (the `mcp` kind and a restated `HistoryMcp`
shape), `server-api/audit.ts`, `index.ts`, tests (`history-shapes`, redaction).

- [x] `buildMcpHistoryEntry`, `historyMcpOf` (caps the messages, as `capFrames` caps frames) and
  `redactMcpExchange` (masks secrets in messages, env, headers and stderr).
- [x] Tests: capping, masking, the shapes stay equal.

### Task 9: Scripting facet

**Files:** new `mcp/scripting.ts`, `mcp/script-types.ts`, `protocols.ts` (snapshot unions), tests in
the scripting suites.

- [x] The pre-request snapshot: the operation (the method fixed through `inspect`), and the origin for
  the HTTP transports. The command line is not in it.
- [x] The post-response snapshot: the result or error, `isError`, `serverInfo`, the message count and
  the duration. Declarations and prelude for both phases.
- [x] Tests: a script changes the arguments, a method change is refused, an origin change is refused,
  `tests` and `vars` work, and the per-module rule tests cover `mcp`.

### Task 10: Catalogue refresh and the engine's public surface

**Files:** new `mcp/catalogue.ts`, `index.ts`, `public-exports` test, `packages/engine/README.md`.

- [x] `refreshMcpCatalogue(server, scope, host)`: initialize, then each advertised list, with pages
  followed up to 50. It returns the sorted catalogue and its metadata. It goes through the approval
  gate. It records nothing to History.
- [x] Export the model, the storage helpers, `refreshMcpCatalogue`, `commandFingerprint`, the History
  helpers and the types the desktop needs.
- [x] Tests: pages, an absent capability skipped, a stable result.

### Task 11: CLI and `wirebench mcp`

**Files:** `packages/cli/src/ops/{items,send,history-entry,history,operations}.ts`,
`commands/ops-output.ts`, `args*.ts` (`--allow-commands` on `send`, `run`, `sequence` and `mcp`),
`send-host.ts`, `mcp/server.ts`, tests, `docs` CLI reference (in Task 19).

- [x] MCP items are sendable, and the output is the result JSON. History records them. A body override
  is refused.
- [x] `--allow-commands` sets the host's `approveCommand` to approve everything. Without it, an
  `mcp-command-unapproved` failure names the command and says to pass the flag.
- [x] Tests: `send` with and without the flag, `run` against the HTTP helper, the MCP server's `send`
  tool.

### Task 12: Desktop shared half

**Files:** new `apps/desktop/src/shared/kinds/mcp/{kind,wire,channels}.ts`,
`shared/kinds/kind-module.ts`, `shared/ipc.ts`, `shared/wire-types.ts`, `shared/wire-base.ts`,
`shared/commands.ts`, `shared/command-catalog.ts`, `test/fixtures/ipc-names.json`, the kind tests.

- [x] `mcpKind` with the tabs `mcp-request` / `mcp-api`. Wire schemas for the server, request, patch,
  exchange summary, live event and catalogue. Add the `ProjectWire` fields and the `ProjectChange`
  members (add, update, delete and move, for servers, folders and requests).
- [x] Channels:
  - `request.sendMcp`, `request.cancelMcp`;
  - `api.refreshMcpCatalogue`;
  - `app.mcpApprovals` (list and revoke), `app.mcpApprove`, the approval prompt event;
  - `mcp.live`.

  All pinned.
- [x] The guard tests (`kind-modules`, `kind-literals` and the others) know `mcp`.

### Task 13: Desktop main half

**Files:** new `apps/desktop/src/main/kinds/mcp/{kind,host,router,mutations,ipc,send,search}.ts`,
`main/mcp-approvals.ts`, `kind-main.ts`, `kind-send.ts`, `kind-routes.ts`, `send/{draft,record,host,
exchange}.ts`, `project-wire.ts`, `project-request-map.ts`, `search.ts`, `workspace-service.ts`,
`unsaved-store.ts`, `sequence-runner.ts`, `history-service.ts`, tests.

- [x] Mutations and the host, with the catalogue written through the host.
- [x] The send facet: summarise, record History, audit, key masks. The live event.
- [x] The approval store: per machine, in userData `mcp-approvals.json`, atomic writes. The prompt is
  a round trip to the renderer: *Run once*, *Always allow* or *Cancel*. In a run, it is asked once per
  fingerprint.
- [x] `api.refreshMcpCatalogue` writes `catalogue.json` and the metadata.
- [x] Tests: the mutations, host round trip, the approval store, the prompt round trip (a mock
  renderer), send recording History, refresh, and the switched-off kind refused.

### Task 14: Renderer: kind registration, explorer, new-server dialog

**Files:** new `apps/desktop/src/renderer/kinds/mcp/{index.tsx,explorer.tsx,explorer-tree.ts,
commands.ts,history-body.tsx}`, `renderer/kinds/index.ts`, `explorer-trees.ts`,
`features/explorer/{context-menu.tsx,explorer-actions.ts,tree-nodes.ts}`,
`state/{editors,ui,project,drafts,exchanges}.ts`, the new `features/mcp-api/new-server-dialog.tsx`,
tests.

- [x] The project menu gains *New MCP server…*. Server rows have *New request*, *Refresh catalogue* and
  *New request from tool…*. Request rows show the method badge.
- [x] The kind's commands. The History body for an MCP entry, read-only.
- [x] Tests: the explorer rows, the menu items, the dialog, `renderer-kinds`.

### Task 15: Renderer: server tab

**Files:** new `features/mcp-api/{mcp-api-tab,connection-section,catalogue-section}.tsx`, tests.

- [x] Connection editing for each transport: the env and header tables, and auth through the shared
  auth editor.
- [x] The catalogue list, with *Refresh* and *New request* on a tool row.
- [x] Tests for each transport's form, refresh, and creating a request from a tool.

### Task 16: Renderer: request editor and approval dialog

**Files:** new `features/mcp-editor/{mcp-editor,operation-bar,arguments-tab,settings-tab}.tsx`, the
`approval-dialog.tsx`, tests.

- [x] The operation bar: method, tool or prompt picker (from the catalogue, free text allowed), URI,
  *Send* and *Cancel*.
- [x] The arguments JSON editor, given the tool's `inputSchema`. Prompt arguments in a table. The
  Assertions and Scripts tabs reuse the shared ones.
- [x] The approval dialog: the command line (masked), the folder, the env names, and the three buttons.
- [x] Tests: picking an operation, the schema passed to the editor, the dialog answers.

### Task 17: Renderer: response pane

**Files:** new `features/mcp-editor/response/{response-pane,result-view,messages-view,status-line}.tsx`,
tests.

- [x] The status line. The result content blocks (text, image, audio, resource link, embedded
  resource) and `structuredContent`. The messages timeline, with the HTTP calls or stderr. Warnings
  are shown.
- [x] Tests for each block type, an error, `isError`, and the warnings.

### Task 17a: Renderer: Arguments markers

**Files:** new `apps/desktop/src/main/kinds/mcp/arguments-check.ts`, `main/kinds/mcp/ipc.ts`,
`shared/kinds/mcp/{wire,channels}.ts`, new `features/mcp-editor/arguments-markers.ts`,
`arguments-tab.tsx`, `test/fixtures/ipc-names.json`, tests.

- [x] `request.mcpArgumentsCheck` in main: the text as typed checked as JSON (an error, where the
  parse stopped; text a `${…}` makes JSON only once expanded is let be), then against the tool's
  `inputSchema` with the engine's `validateJsonSchema` (warnings, at each problem's pointer, as a send
  only warns). Blank text is checked as the `{}` it sends.
- [x] The Arguments editor shows the answer as Monaco markers, once typing pauses, as the GraphQL
  editor's diagnostics are; an answer for text the editor no longer holds is dropped.
- [x] Tests: the channel (valid, a type mismatch, a missing required property, a parse error), the
  marker mapping, and the editor's debounced check.

### Task 18: e2e

**Files:** new `e2e/specs/mcp-request.spec.ts`, and an e2e fixture server (stdio) under `e2e/fixtures/`.

- [ ] Create a stdio server pointing at the fixture, then approve it and refresh the catalogue.
- [ ] Create a request from a tool, send it, and see the result.
- [ ] Call the tool that sets `isError` and see the error status.
- [ ] Run it in CI only.

### Task 19: Docs and changelog

**Files:**
- new `docs-site/src/content/docs/guides/mcp-servers.mdx`, `astro.config.mjs`;
- `reference/project-format.md`, the CLI reference (`--allow-commands`), `docs/security.md` (stdio
  commands and their approval);
- `docs/architecture/overview.md` if it lists the kinds, `docs/roadmap.md`, `CHANGELOG.md`.

- [ ] The guide: the three transports, the catalogue, operations, approval, runs, scripts, limits.
- [ ] `pnpm check:banned-terms` passes.
