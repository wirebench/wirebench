---
name: wirebench
description: Works with a local Wirebench API project through its MCP tools and the wirebench CLI. Use when the user asks to send or replay a SOAP, REST, WebSocket or MCP request, check a response against its baseline (golden), compare responses from History, validate a message against a WSDL or OpenAPI contract, diff two versions of a contract, run a sequence, or pick an environment.
---

# Wirebench

Wirebench is a local API workbench. A project is a folder of YAML files holding saved requests,
environments, sequences and goldens. You reach it through the `wirebench` MCP server, whose tools
are listed below, and through the `wirebench` CLI in a terminal. No model runs inside Wirebench.

## Vocabulary

- **Project.** The folder with `wirebench.yaml`. The MCP server serves exactly one.
- **Item.** A saved request, named by its path as `operations` lists it, such as `Pets/pets/List pets`.
- **Operation reference.** `Interface/Operation` for SOAP, `API/operationId` or `API/METHOD /path`
  for REST. `generate` and `validate` take it.
- **Environment.** A named set of properties and secrets, such as `local` or `staging`. Every send
  names one when the project defines any. The server may be limited to some with `-e`.
- **Protected environment.** One the user marked as dangerous. Sends to it are refused unless the
  call passes `allowProtected: true`. Pass it only when the user asked for that environment.
- **Send.** One request, once, with its assertions. It lands in History.
- **Run.** Many requests or a sequence, from the CLI: `wirebench run`.
- **Sequence.** Ordered steps with transfers between them. Runs from the CLI only.
- **Baseline (golden).** The saved expected response beside a request, `<slug>.golden.yaml`.
  Comparison is by meaning and honours the golden's ignore rules.
- **History.** Every send from the app, the CLI and agents, newest first, each with an id.
- **Contract diff.** Breaking and compatible changes between two versions of a WSDL or OpenAPI
  document, from the CLI.

## Which tool to use

| The user wants to                        | Use                                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Know what can be sent                    | `operations` first, always. It gives the item paths and references.                                            |
| See what a request body should look like | `generate` with an operation reference. Saves nothing.                                                         |
| Send a saved request                     | `send` with `item` and `environment`.                                                                          |
| Try a changed body without saving it     | `send` with `body`. Write the body literally; `${…}` placeholders are refused.                                 |
| Check a response has not drifted         | `send` with `baseline: true`. Read `baseline.status`: `matched`, `differs` (see `changes`) or `missing`.       |
| Call one contract operation with JSON    | The operation's own tool, such as `calculator_service_add`. `operations` shows each tool name.                 |
| See recent sends                         | `history_list`, optionally with `item` and `limit`.                                                            |
| Compare two responses                    | `history_diff` with `from` (older) and `to` (newer) ids. Put volatile paths such as `//timestamp` in `ignore`. |
| Check a message against the contract     | `validate` with exactly one of `historyId`, `file` or `text`.                                                  |
| Pull a value out of a response           | `query` with an XPath or JSONPath `expression` and one of `historyId`, `file` or `text`.                       |
| Add a WSDL or OpenAPI document           | `import` with an absolute path or an http(s) URL.                                                              |
| Run every request against its golden     | Terminal: `wirebench run <project> --baseline -e <env>`.                                                       |
| Run a sequence                           | Terminal: `wirebench run <project> --sequence <name> -e <env>`. It cannot take `--baseline`.                   |
| Diff two versions of a contract          | Terminal: `wirebench diff-contract project:<api> <new-file>`. Exit 1 means a breaking change.                  |

## Rules

- Start with `operations`. Never guess an item path or a reference.
- Use absolute paths for `import` sources and `file` arguments. The client chose the server's
  working directory, not you.
- A refusal comes back as a result with `code` and `message`, not a crash. `send-not-allowed` and
  `write-not-allowed` name the flag the user must add to the server's command. Tell the user; do
  not retry.
- Secrets are never inputs. They come from `WIREBENCH_SECRET_<NAME>` variables where the server was
  started. A missing secret is for the user to set.
- Results are redacted. `<redacted>` in a result is masking, not the real value.
- gRPC requests are listed but cannot be sent.
