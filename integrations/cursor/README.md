# Wirebench for Cursor

Two files connect Cursor's agent to a Wirebench project:

| File            | Copy it to                                                                       | What it does                                                                  |
| --------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `mcp.json`      | `.cursor/mcp.json` in your repository, or `~/.cursor/mcp.json` for every project | Starts the `wirebench` MCP server on your project.                            |
| `wirebench.mdc` | `.cursor/rules/wirebench.mdc` in your repository                                 | Teaches the agent the Wirebench vocabulary and which tool fits which request. |

No model runs inside Wirebench. Nothing leaves the machine except the requests the agent sends
under the environments you allow. See
[Use Wirebench from your coding agent](https://wirebench.github.io/wirebench/docs/guides/coding-agents/)
for what the server can and cannot do.

## Set up

1. Install Node.js 24 or later, so `npx` can start the server.
2. Copy `mcp.json` and replace `/absolute/path/to/project` with your project folder, the one holding
   `wirebench.yaml`. Replace `local` with the environment the agent may send under.
3. Copy `wirebench.mdc` to `.cursor/rules/`. It is an agent-requested rule: Cursor attaches it
   when a request is about Wirebench work. Set `alwaysApply: true` in its front matter to attach
   it to every request instead.
4. Open Cursor's MCP settings and check that the `wirebench` server is on.

Cursor asks before each tool call by default. Open the arrow beside the tool's name to read its
arguments before you approve.

## Change what the agent may do

The flags in `args` are Wirebench's own gates:

- Remove `--allow-send` to let the agent read, generate, validate and query, but not send.
- Add `--allow-write` to let `import` add WSDL and OpenAPI documents to the project.
- Remove `-e` and its value to allow any environment that is not protected. A project without
  environments needs this, because `-e` refuses a send with no environment.
