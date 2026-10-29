/**
 * `wirebench agent …` (hosted edition spec §18.6): its help and parsing. The agent lets a browser tab at a
 * team's Wirebench Server send through this machine.
 */
import { parseArgs } from 'node:util';
import { UsageError } from './usage-error.js';

export const AGENT_HELP = `wirebench agent
wirebench agent pair <code> --server <url> [--ssh]
wirebench agent unpair [--server <url>]
wirebench agent status
wirebench agent allow-env <NAME…> | disallow-env <NAME…> | allowed-env

Lets a browser tab at your team's Wirebench Server send requests from this machine, to hosts only this
machine reaches (localhost, the office network, a VPN). Run it on your own machine, not in a container:
a container's 127.0.0.1 is its own, and the browser cannot reach it.

(no subcommand)        Starts the agent on 127.0.0.1 (port 47615, or the next free one up to 47634),
                       prints the port and serves until Ctrl+C. It starts without pairings too and picks
                       up a pairing made later from another terminal.
pair <code>            Pairs this machine with the server: the code is the one the browser shows under
  --server <url>       Pair this machine… (https://, or http:// for a server on this machine).
  --ssh                Let that server's tabs open SSH sessions through this machine.
unpair                 Unpairs every server, at the server and here.
  --server <url>       Only that server.
status                 The pairings, the allowed environment variables, and whether the agent runs.
allow-env <NAME…>      Lets a paired server's requests read these environment variables as
                       \${#System#NAME}. None is readable by default. Needs a pairing first: the list is
                       kept with the pairings.
disallow-env <NAME…>   Takes names off that list.
allowed-env            Prints the list.

The agent keeps its pairings and key in ~/.wirebench/agent (or $WIREBENCH_AGENT_HOME), sealed under
agent.key. That folder must be yours alone (mode 700, the key 600); the agent refuses to start otherwise.
Requests that read a team secret are sent through the desktop app, not this agent.

Exit 0 when done, 2 for a usage problem, 3 when the agent, a server or the folder refuses.`;

export type AgentArgs =
  | { readonly command: 'agent-run' }
  | { readonly command: 'agent-pair'; readonly code: string; readonly server: string; readonly ssh: boolean }
  | { readonly command: 'agent-unpair'; readonly server?: string }
  | { readonly command: 'agent-status' }
  | { readonly command: 'agent-allow-env'; readonly names: readonly string[] }
  | { readonly command: 'agent-disallow-env'; readonly names: readonly string[] }
  | { readonly command: 'agent-allowed-env' };

export function parseAgent(argv: readonly string[]): AgentArgs | { readonly command: 'help'; readonly topic: 'agent' } {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        server: { type: 'string' },
        ssh: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError(error.message);
    throw error;
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { command: 'help', topic: 'agent' };
  const [sub, ...rest] = positionals;
  const verb = `wirebench agent${sub === undefined ? '' : ` ${sub}`}`;
  if (values.ssh === true && sub !== 'pair') throw new UsageError(`--ssh applies to wirebench agent pair only`);
  if (values.server !== undefined && sub !== 'pair' && sub !== 'unpair') {
    throw new UsageError(`--server does not apply to ${verb}`);
  }
  const none = (): void => {
    if (rest.length > 0) throw new UsageError(`${verb} takes no argument, got "${rest.join(' ')}"`);
  };
  switch (sub) {
    case undefined:
      return { command: 'agent-run' };
    case 'pair': {
      const [code, ...extra] = rest;
      if (code === undefined) throw new UsageError('wirebench agent pair <code> --server <url>: the code is required');
      if (extra.length > 0) throw new UsageError(`wirebench agent pair: unexpected "${extra.join(' ')}"`);
      if (values.server === undefined) throw new UsageError('wirebench agent pair: --server <url> is required');
      return { command: 'agent-pair', code, server: values.server, ssh: values.ssh === true };
    }
    case 'unpair':
      none();
      return { command: 'agent-unpair', ...(values.server !== undefined ? { server: values.server } : {}) };
    case 'status':
      none();
      return { command: 'agent-status' };
    case 'allow-env':
    case 'disallow-env':
      if (rest.length === 0) throw new UsageError(`${verb} <NAME…>: at least one name is required`);
      return { command: sub === 'allow-env' ? 'agent-allow-env' : 'agent-disallow-env', names: rest };
    case 'allowed-env':
      none();
      return { command: 'agent-allowed-env' };
    default:
      throw new UsageError(
        `wirebench agent: unknown subcommand "${sub}" (pair, unpair, status, allow-env, disallow-env, allowed-env)`,
      );
  }
}
