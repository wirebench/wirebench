# Wirebench plugin for Claude Code

This folder is a local plugin marketplace holding one plugin, `wirebench`. The plugin gives Claude
Code two things:

- **The `wirebench` MCP server**, started with `npx -y @wirebench/cli mcp` on the project you name,
  with sends allowed under one environment.
- **The `wirebench` skill**, which teaches the agent the Wirebench vocabulary (send, run, baseline,
  contract diff, history, environments) and which tool fits which request.

No model runs inside Wirebench. Nothing leaves the machine except the requests the agent sends under
the environment you allow. See
[Use Wirebench from your coding agent](https://wirebench.github.io/wirebench/docs/guides/coding-agents/)
for what the server can and cannot do.

## Requirements

- Claude Code with plugin support.
- Node.js 24 or later on the path, for `npx`.
- A Wirebench project folder, the one holding `wirebench.yaml`.

## Install from a clone

From the root of a clone of this repository:

```sh
claude plugin marketplace add ./integrations/claude-code
claude plugin install wirebench@wirebench
```

Claude Code then asks for two values:

| Option            | What to give                                           |
| ----------------- | ------------------------------------------------------ |
| Wirebench project | The project folder, as an absolute path.               |
| Environment       | The one environment the agent may send under, by name. |

Start `claude` and run `/mcp` to see the server connected. Change the values later from `/config`.

To try the plugin for one session without installing it:

```sh
claude --plugin-dir ./integrations/claude-code/wirebench
```

## Change what the agent may do

The plugin starts the server with `--allow-send -e <environment>`. For other gates, add the server
yourself instead of through the plugin and keep only the skill:

```sh
claude mcp add --transport stdio wirebench -- npx -y @wirebench/cli mcp --project /absolute/path/to/project --allow-write
```

- No `--allow-send`: the agent can read, generate, validate and query, but not send.
- `--allow-write`: `import` may add WSDL and OpenAPI documents to the project.
- No `-e`: sends may use any environment that is not protected.

A project without environments cannot use the plugin's server, because `-e` refuses a send with no
environment. Add the server by hand without `-e` for such a project.

## Check the plugin

```sh
claude plugin validate ./integrations/claude-code/wirebench
claude plugin validate ./integrations/claude-code
```

## Remove it

```sh
claude plugin uninstall wirebench@wirebench
claude plugin marketplace remove wirebench
```
