/**
 * The stdio approval (#79): a local command runs only once the host has approved its command line.
 *
 * The command line lives in the project, so a `git pull` can change what *Send* runs. The engine
 * holds the rule: before a stdio server is spawned, the send asks its host's `approveCommand` with
 * the command line's fingerprint. A host that lends no `approveCommand`, or answers false, refuses
 * the send with `mcp-command-unapproved`, so a new host cannot skip the gate by accident. HTTP
 * transports never ask.
 *
 * The fingerprint is the SHA-256 of the expanded command, arguments and folder, and the *names* of
 * the variables. Their values are left out, so rotating a secret does not ask again; changing the
 * command, an argument, the folder or the set of variables does.
 */
import { createHash } from 'node:crypto';
import { McpError } from '../errors.js';
import type { CommandApprovalRequest, SendHost } from '../run/host.js';

export type { CommandApprovalRequest } from '../run/host.js';

/** What a command line's fingerprint is made of. Every string is expanded; `cwd` is absolute. */
export interface CommandFingerprintInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The variables' names; their order and repeats do not count. */
  readonly envNames: readonly string[];
}

/** The variable names as the fingerprint and the prompt see them: unique and sorted. */
export function sortedEnvNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/** The fingerprint of a command line: SHA-256, hex, over a canonical JSON of its parts. */
export function commandFingerprint(input: CommandFingerprintInput): string {
  const canonical = JSON.stringify({
    command: input.command,
    args: [...input.args],
    cwd: input.cwd,
    envNames: sortedEnvNames(input.envNames),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** An argument as a reader of the command line sees it: bare when plain, else double-quoted. */
function displayArg(arg: string): string {
  // Backslashes are left alone, so a Windows path reads as written; only quotes are escaped.
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * A command line to show a person: the command and each argument, quoted where a reader would
 * otherwise misread it. Built from text whose secrets are still masked, never from what runs.
 */
export function commandDisplay(command: string, args: readonly string[]): string {
  return [command, ...args].map(displayArg).join(' ');
}

/**
 * Asks the host to approve a command line. Resolves when it does.
 *
 * @throws McpError `mcp-command-unapproved` when the host has no `approveCommand`, or refuses
 */
export async function approveMcpCommand(host: SendHost, request: CommandApprovalRequest): Promise<void> {
  const approved = host.approveCommand !== undefined && (await host.approveCommand(request));
  if (approved) return;
  throw new McpError(
    'mcp-command-unapproved',
    `The MCP server "${request.serverName}" runs the command "${request.display}", which has not been approved`,
    {
      details: {
        server: request.serverName,
        command: request.display,
        cwd: request.cwd,
        fingerprint: request.fingerprint,
        asked: host.approveCommand !== undefined,
      },
    },
  );
}
