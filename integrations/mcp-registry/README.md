# Registry metadata

This folder holds what MCP server catalogs need to list Wirebench. Nothing here is submitted
automatically. Each listing is a manual step for a maintainer, described below.

| File                                         | For                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.json`                                | The official MCP Registry at `registry.modelcontextprotocol.io`. It describes the server as the npm package `@wirebench/cli`, started with `npx` over stdio. |
| `packages/cli/package.json`, field `mcpName` | The registry's proof that the npm package belongs to this server name. It must match `name` in `server.json`.                                                |

The Claude Code plugin in [`integrations/claude-code`](../claude-code/) is its own listing, in
Anthropic's directory. The Cursor files in [`integrations/cursor`](../cursor/) need no listing.

## Official MCP Registry

The server name is `io.github.wirebench/wirebench`. A name under `io.github.wirebench/` is proven by
a GitHub login with access to the `wirebench` organization.

1. **Publish a CLI release that carries `mcpName`.** The registry checks the published
   `package.json` of the exact version `server.json` names. Releases from before this folder was
   added do not carry the field. After the next tagged release, confirm it:

   ```sh
   npm view @wirebench/cli@<version> mcpName
   ```

   It must print `io.github.wirebench/wirebench`.

2. **Set the version.** In `server.json`, set both the top-level `version` and `packages[0].version`
   to that release. The file ships with `6.2.0` as a placeholder for the next minor release. Commit
   the change.

3. **Install the publisher.**

   ```sh
   brew install mcp-publisher
   ```

4. **Log in with GitHub.** It opens a device-code flow in the browser. Your membership of the
   `wirebench` organization must be visible to the publisher; make it public on
   `github.com/orgs/wirebench/people` if the login is refused.

   ```sh
   mcp-publisher login github
   ```

5. **Publish from this folder.**

   ```sh
   cd integrations/mcp-registry
   mcp-publisher publish
   ```

6. **Check the listing.**

   ```sh
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.wirebench/wirebench"
   ```

Each later release repeats steps 2, 5 and 6 with the new version.

`server.json` validates against the registry's schema,
`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`. Its `description`
is limited to 100 characters.

A client builds this command from it:

```sh
npx @wirebench/cli mcp --project <folder> --allow-send --env <environments>
```

`--project` is required. `--env` is optional; without it, sends may use any environment that is not
protected. A user who wants a read-only server removes `--allow-send` in their client's settings.

## Anthropic's directory (the Claude Code plugin)

Anthropic's directory lists plugins for claude.ai, Cowork and Claude Code. Submitting needs a paid
claude.ai plan; on a Team or Enterprise plan an Owner submits.

1. **Validate the plugin.**

   ```sh
   claude plugin validate --strict ./integrations/claude-code/wirebench
   ```

2. **Install it from the local marketplace and start a session** to see the server connect and the
   skill load. See [`integrations/claude-code/README.md`](../claude-code/README.md).

3. **Run the pre-submission checklist** at
   `https://claude.com/docs/plugins/pre-submission-checklist`. The portal applies rules the local
   validator does not.

4. **Add the listing fields** the directory reads from `plugin.json`: `icon` (an image file in the
   plugin), `documentationUrl`, `supportUrl`, `privacyPolicyUrl` and `termsOfServiceUrl` (each an
   `https://` URL). They are left out today because no privacy policy or terms page exists yet.

5. **Submit** in the developer portal at `https://claude.ai/directory/manage`, following
   `https://claude.com/docs/plugins/submit`.

## Smithery

Smithery lists a local stdio server only as an MCPB bundle: a `.mcpb` archive that carries the
server and its `manifest.json`. Wirebench does not build one yet. The bundle has to hold the CLI with
its dependencies, native ones included, for each platform. Until it exists there is nothing to
submit.

With a bundle, the Smithery CLI publishes it, and the publishing flow finishes on `smithery.ai`:

```sh
smithery mcp publish ./wirebench.mcpb -n wirebench/wirebench
```

See `https://smithery.ai/docs/build/publish`.
