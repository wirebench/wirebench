# Headless `wirebench mock` — design

Issue: [#61](https://github.com/wirebench/wirebench/issues/61). Roadmap item 11.
Builds on: `2026-10-08-mock-services-design.md` (#59, the engine's `startMock`) and the CLI runner (#30).

## Goal

Run a project's mocks without the app: in a pipeline, beside the tests that call them, or in a container.
The command starts the engine's mock server for each selected mock and serves until it is stopped.

## Command

```
wirebench mock <path> [mock…] [--port <n>] [--host <addr>] [--json] [-q]
```

- **`<path>`** is a project folder, as for `run`. A workspace folder is exit 2 with its projects listed.
- **`[mock…]`** selects mocks by name, folder slug or id. None selects every mock in the project. An
  unknown or ambiguous name is exit 2, with the project's mocks listed. A project with no mocks is exit 2.
- **`--port <n>`** (0 to 65535) overrides the mock's own port. It takes exactly one selected mock; with
  several, each listens on its own `mock.yaml` port. Port 0 is any free port, and the start line names it.
- **`--host <addr>`** is the address to listen on. The default is `WIREBENCH_MOCK_HOST` when set, else
  `127.0.0.1`. Anything other than loopback prints a warning to stderr, since the mock then answers any
  client that can reach the port. The host is never read from the project (spec #59 §Running a mock).
- **`--json`** writes one JSON object per line instead of text: `{"type":"listening",…}` for each mock at
  start and `{"type":"exchange",…}` for each request, carrying the engine's `MockExchangeEvent` (headers
  masked, bodies cut to 64 KiB) plus the mock's id and name.
- **`-q`** prints the start lines and nothing per request.

## Output

stdout carries the start lines and the request log; stderr carries warnings and errors. A text start line
is `listening <name> <url>`; a text request line is
`<time> <name> <method> <url> <status> <operation> → <response> <ms>ms`, followed by one indented line per
validation problem and by the error, if any. Bodies are not printed in text mode.

Mock-file problems the loader reported (an invalid or too-new file) and the engine's start warnings
(`mock-operation-unknown`) go to stderr and do not stop the mock.

## Lifecycle and exit codes

- Every selected mock starts before the first start line is printed; when one fails to start, those
  already started are stopped and the command exits 3 with the engine's code and message
  (`mock-port-in-use`, `mock-definition-missing`, `mock-protocol-unsupported`, …).
- SIGINT and SIGTERM stop every mock (closing open connections) and exit 0. This is how `docker stop`,
  a CI job's teardown and Ctrl+C end it.
- Exit 2 for a usage error or a project that does not load (as for `run`), exit 3 for a mock that does
  not start.

## Containers

The CLI image sets `WIREBENCH_MOCK_HOST=0.0.0.0`: inside a container, loopback is unreachable from the
host and from sibling containers, and the container's own network is the boundary. The port is published
with `-p` as usual. Outside the image nothing changes. The process handles SIGTERM itself, so it stops
promptly as PID 1 without `--init`.

## Not in scope

- Hot reload when stub files change; restart the command.
- A GitHub Action input or GitLab template job for mocks; the guide shows the step for each.
- TLS, recording (#60), and the desktop tab (#59 part 2).

## Tests

- In process, against a fixture project with two REST mocks: argument parsing (port range, refusing
  flags of other verbs), selection by id, slug and name, the text and JSON lines, `-q`, the host from
  `WIREBENCH_MOCK_HOST`, `--port` with several mocks, port in use is exit 3.
- Against the built CLI: SIGTERM and SIGINT stop it with exit 0 (not on Windows, which has no SIGTERM).
