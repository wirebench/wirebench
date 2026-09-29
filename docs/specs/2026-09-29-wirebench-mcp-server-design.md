# Wirebench: MCP server over the engine, with CLI parity — design

Date: 2026-09-29 · Status: design approved by the owner in conversation 2026-09-29 · Issue #32
(roadmap item 4, milestone 2.3). #33 (a contract's operations as MCP tools) builds on this server
later.

- Builds on:
  - The engine's entry points:
    - `importDefinition` (`packages/engine/src/import.ts`)
    - `summarizeOperations` (`operations.ts`)
    - `generateRequest` (`generate.ts`)
    - the runner's `prepare` and `run` (`packages/engine/src/run/`)
    - `validateMessage` (`validate/index.ts`)
    - `evaluate` and `evaluateJson` (`xpath/evaluate.ts`)
    - the snapshot diff (`snapshot/`), the redactor (`redact/`) and History (`project/history.ts`)
  - The CLI (`packages/cli`): argument parsing, exit codes, environment-only secrets
    (`env-secrets.ts`) and the masker that `wirebench run` uses.
- Decisions recorded here (owner, 2026-09-29):
  - **One core, two faces.** Each capability is one function in `packages/cli/src/ops/`. A CLI verb
    prints the result, and `wirebench mcp` exposes the same function as a tool. Parity is
    structural.
  - **Writes are gated.** Read tools are always on. `import` needs `--allow-write`. `send` needs
    `--allow-send`, which `--env` can narrow.
  - **Agent sends reach the desktop's History**, through a History file made safe for two writers.
  - **Secrets resolve locally and are redacted on the way out.** No secret is a tool input, and every
    result is redacted before an agent sees it.
  - **SOAP and REST** in this cut. gRPC, WebSocket and SSE items are listed, but `send` refuses them.
  - **stdio and streamable HTTP.** stdio is the default. `--http <port>` serves localhost only,
    behind a bearer token.

## 1. Goal

A coding agent working on a service that talks SOAP or REST can use Wirebench to:

- import the service's contract and see its operations;
- build a valid request and send it through a configured environment;
- validate the response, query it, and compare it with an earlier one.

It can do all this without Wirebench running any model or sending its data anywhere. A developer can
do the same from a terminal, command for command.

### 1.1 In scope

- An ops layer in the CLI package: one function per capability, with JSON-safe input and output.
- A CLI verb for each op, with human-readable output by default and `--json` on request.
- `wirebench mcp`: an MCP server over the same ops, on stdio and streamable HTTP.
- History: safe concurrent writes in the engine, and a desktop that refreshes when the file changes.
- Docs: the CLI reference, an "Agents (MCP)" guide, security notes, the changelog and the roadmap
  status.

### 1.2 Not in scope

- One tool per contract operation (#33).
- gRPC, WebSocket and SSE sends.
- Sequences and collection runs as tools. `wirebench run` stays the CLI's way to run them.
- Keychain secrets in the CLI. The CLI reads secrets from the environment only, as `wirebench run`
  does today. The desktop's safe-storage secrets stay the desktop's.
- MCP resources and prompts. The server offers tools only.
- Any desktop UI change beyond the History refresh.

## 2. The ops layer (`packages/cli/src/ops/`)

Each op has the shape `(input, context) => Promise<Result>`:

- `input` is a plain object validated by a zod schema.
- `context` carries the project directory, the History directory, the process environment and the
  gates.
- `Result` is JSON-safe.

The zod schema is the single source for both the CLI's argument checks and the MCP tool's
`inputSchema`, converted to JSON Schema.

| Op / tool | CLI verb | Input | Output | Gate |
| --- | --- | --- | --- | --- |
| `import` | `wirebench import <source>` | a path or URL; an optional name | what was added (interfaces, APIs, item counts), and what the importer reported it could not map | `--allow-write` |
| `operations` | `wirebench operations` | an optional interface or API name filter | SOAP operations (interface, binding, operation, SOAP action) and REST endpoints (API, method, path, operationId), each with its project item name | — |
| `generate` | `wirebench generate <operation>` | an operation or endpoint reference; `optional: all \| required` | a sample request body (a SOAP envelope from the XSD, or JSON from the JSON Schema), plus method, path and headers for REST | — |
| `send` | `wirebench send <item>` | a project item (by path or name); an environment; an optional body override | status, timing, headers, body (redacted), the item's assertion results if it has any, and the History id | `--allow-send`, `--env` list |
| `validate` | `wirebench validate <item \| file>` | a History id, a file, or inline text, plus the operation it belongs to | valid, or a list of problems with line, column and path | — |
| `query` | `wirebench query <expression>` | an expression; a History id, a file or inline text | the results as strings, using XPath 3.1 for XML or JSONPath for JSON, chosen by the content | — |
| `history_list` | `wirebench history list` | an optional item filter; a limit (default 20, max 200) | id, time, item, status and duration | — |
| `history_diff` | `wirebench history diff <a> <b>` | two History ids; optional ignore paths | the engine's semantic XML or JSON diff of the two responses | — |

- `send` refuses gRPC, WebSocket and SSE items with `unsupported-kind`. The message says the MCP
  server sends SOAP and REST only.
- `send` refuses an environment outside the `--env` list with `environment-not-allowed`.
- The project is read fresh for every op, so the next call sees a change saved in the desktop.

### 2.1 Errors

An op throws a typed error with an engine-style `code` and a message.

- **CLI:** the error maps to the existing exit codes: 2 for usage, 3 for a run error, 1 for an
  assertion failure.
- **MCP:** the server returns the error as a tool result with `isError: true` and `{ code, message }`,
  never as a protocol error, so the agent can read it and act on it.
- **Gates:** a refusal is `write-not-allowed` or `send-not-allowed`, and names the flag that would
  allow it.

### 2.2 Secrets and redaction

- Secrets resolve from the environment exactly as `wirebench run` resolves them
  (`WIREBENCH_SECRET_<name>`), through `createEnvSecrets`.
- No op accepts a secret value as input.
- Every result passes through one redaction step before it leaves an op:
  1. The engine's header, URL, XML and structured-body redactors run first.
  2. Then every secret value resolved during the call is masked, using the same masker as
     `wirebench run`.
- CLI output and MCP results are redacted alike.
- History stores what the desktop stores. The History file is not an agent-facing surface.

## 3. History shared by two writers (`packages/engine/src/project/history.ts`)

Today `appendHistory` and `openHistory` rewrite the whole file from memory, so the next write loses a
second writer's entry. Both change in the engine:

- **Lock.** Every write (`append` or `clear`) takes `<file>.lock`, created with `O_EXCL`.
  - A lock older than 5 s is stale and is broken.
  - A waiting writer retries every 25 ms for up to 2 s, then fails with `history-busy`.
- **Reload before write.** Under the lock, the handle rereads the file if its size or mtime differs
  from what the handle last read. It then appends, caps the entries and writes the file atomically,
  as it does now.
- **Desktop refresh.** `history-service.ts` watches the file. On a change it reloads the handle and
  notifies the renderer, so an open History panel updates.

The CLI finds the desktop's History file at `<userData>/history/<projectId>.jsonl`. `--history-dir`
overrides the location. By default `userData` is the desktop's directory for the OS:

- macOS: `~/Library/Application Support/Wirebench`
- Windows: `%APPDATA%\Wirebench`
- Linux: `$XDG_CONFIG_HOME/Wirebench`, or `~/.config/Wirebench`

The plan checks these against Electron's `userData` for the app name.

## 4. `wirebench mcp`

- The server is built on the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`), added to
  `@wirebench/cli`.
- Usage: `wirebench mcp --project <dir> [--allow-write] [--allow-send] [--env a,b]
  [--history-dir <dir>] [--http <port>]`.
- The tool list is fixed. Gated tools are always listed and refuse when their gate is off, so the
  agent learns which flag the user would need to pass.
- Each tool description says what the tool does, what it changes and which gate it needs. Tool names
  use snake_case (`history_list`, `history_diff`).
- Logs go to stderr only. In stdio mode, stdout belongs to the protocol.

### 4.1 Streamable HTTP

- `--http <port>` binds `127.0.0.1` only. There is no flag to bind anywhere else.
- Every request needs `Authorization: Bearer <token>`.
  - The token comes from `WIREBENCH_MCP_TOKEN`. If that is unset, the server generates one at start
    (32 random bytes, base64url) and prints it once to stderr.
  - A missing or wrong token gets 401.
- A request with an `Origin` other than `http://localhost:<port>` or `http://127.0.0.1:<port>` gets
  403. This guards against DNS rebinding. A request with no `Origin` is not refused on this ground.
- Sessions follow the SDK's streamable HTTP transport. One process serves several agents, all with
  the same gates.

## 5. CLI verbs

- Output is human-readable by default: short tables and bodies. `--json` prints the op's result
  exactly.
- `--project <dir>` defaults to the current directory, as it does for `wirebench run`.
- The gates apply to `wirebench mcp` only, because on the CLI the user typed the command:
  - `send` from the CLI is not gated.
  - `import` from the CLI writes the project, as the user asked.
- `wirebench --help` lists the new verbs, and each verb has its own `--help`.

## 6. Testing

- **Ops:** one unit test per op against fixture projects (one SOAP, one REST). Each covers:
  - results, errors and gates;
  - redaction of headers, bodies and resolved secret values;
  - `unsupported-kind` for a gRPC item.
- **History:**
  - Two handles on one file append concurrently, and both entries survive.
  - A stale lock is broken.
  - A held lock times out with `history-busy`.
  - A handle reloads after an external write.
- **Desktop:** `history-service` reloads and notifies on an external write, in a unit test with a
  fake watcher.
- **MCP:** an in-process client over the SDK's in-memory transport:
  - lists the tools and calls each one;
  - sees gate refusals as `isError` results;
  - finds nothing but protocol frames on stdout.
- **HTTP:**
  - The server binds 127.0.0.1.
  - A request with no token or a wrong token gets 401.
  - A request with a foreign `Origin` gets 403.
  - A call with the token succeeds.
- **CLI:** each verb's human and `--json` output, and its exit codes.
- No e2e. Nothing in the desktop UI changes beyond the History refresh.

## 7. Docs

- `docs/cli.md`: the new verbs, and `wirebench mcp` with every flag.
- `docs-site`: an "Agents (MCP)" guide with a generic MCP client configuration for stdio and for
  HTTP, and what each tool does.
- `docs/security.md`: the gates, redaction, localhost-only HTTP with a bearer token, and the fact
  that no model runs in Wirebench.
- `CHANGELOG.md`, and the item 4 status in `docs/roadmap.md`.
