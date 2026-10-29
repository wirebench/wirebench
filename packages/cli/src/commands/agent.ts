/**
 * `wirebench agent` (hosted edition spec §18.6): the headless local agent, and the subcommands that pair this
 * machine with a team's Wirebench Server, unpair it, show its state and keep its `${#System#…}` allowlist.
 * The agent itself is in `dist/agent/bundle.js`, loaded only here (`src/agent/agent-runtime.ts`).
 */
import {
  loadAgentBundle,
  type AgentBundle,
  type AgentBundleFetch,
  type AgentPairingRow,
} from '../agent/agent-runtime.js';
import { agentHome } from '../agent/node-platform.js';
import { AGENT_FIRST_PORT, clearRunStatus, readRunStatus, writeRunStatus } from '../agent/status-file.js';
import type { AgentArgs } from '../args-agent.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { cliVersion } from '../version.js';
import { stopped } from './mcp.js';

export interface AgentCommandOptions {
  /** Ends `wirebench agent` when it aborts; without one, SIGINT or SIGTERM does. */
  readonly stop?: AbortSignal;
  /** The ports `wirebench agent` tries; 47615–47634 when absent. */
  readonly ports?: readonly number[];
  readonly fetch?: AgentBundleFetch;
  /** The bundle; the built one when absent. */
  readonly bundle?: AgentBundle;
  /** Hears the running agent's port once it listens. */
  readonly onListening?: (port: number) => void;
}

/** A refusal whose message is safe to show: the agent's folder, a server's answer, a name the allowlist refuses. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pairingLine(pairing: AgentPairingRow): string {
  const ssh = pairing.sshOptIn ? ', SSH allowed' : '';
  return `  ${pairing.origin}  ${pairing.email}  paired ${pairing.createdAt.slice(0, 10)}${ssh}`;
}

export async function agentCommand(args: AgentArgs, io: CliIo, options: AgentCommandOptions = {}): Promise<number> {
  const home = agentHome(io.env);
  const input = {
    home,
    env: io.env,
    version: cliVersion(),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  };
  const out = (line: string): void => {
    io.stdout.write(`${line}\n`);
  };
  try {
    const bundle = options.bundle ?? (await loadAgentBundle());
    switch (args.command) {
      case 'agent-run': {
        const agent = await bundle.startHeadlessAgent({
          ...input,
          ...(options.ports !== undefined ? { ports: options.ports } : {}),
          log: (message, error) => {
            io.stderr.write(`wirebench agent: ${message}: ${describe(error)}\n`);
          },
        });
        try {
          await writeRunStatus(home, { pid: process.pid, port: agent.port });
          out(`Wirebench agent listening on 127.0.0.1:${String(agent.port)}`);
          if (agent.pairings.length === 0) {
            out('No pairings yet: run wirebench agent pair <code> --server <url> in another terminal.');
          }
          for (const pairing of agent.pairings) out(pairingLine(pairing));
          out('Stop it with Ctrl+C.');
          options.onListening?.(agent.port);
          await stopped(options.stop);
        } finally {
          await agent.close();
          await clearRunStatus(home);
        }
        out('Wirebench agent stopped.');
        return ExitCode.Ok;
      }
      case 'agent-pair': {
        // A running agent's port, so the server knows where to find it; otherwise the port it will take.
        const running = await readRunStatus(home);
        const result = await bundle.pairAgent({
          ...input,
          code: args.code,
          serverUrl: args.server,
          sshOptIn: args.ssh,
          port: running?.port ?? AGENT_FIRST_PORT,
        });
        out(`Paired with ${result.origin} as ${result.email}.`);
        if (running === undefined) out('Start the agent with: wirebench agent');
        return ExitCode.Ok;
      }
      case 'agent-unpair': {
        const removed = await bundle.unpairAgent({
          ...input,
          ...(args.server !== undefined ? { serverUrl: args.server } : {}),
        });
        if (removed.length === 0) out(args.server === undefined ? 'No pairings.' : `Not paired with ${args.server}.`);
        for (const pairing of removed) out(`Unpaired from ${pairing.origin} (${pairing.email}).`);
        return ExitCode.Ok;
      }
      case 'agent-status': {
        const status = await bundle.agentStatus(input);
        const running = await readRunStatus(home);
        out(
          running === undefined
            ? 'Agent: not running'
            : `Agent: running on 127.0.0.1:${String(running.port)} (pid ${String(running.pid)})`,
        );
        out(`Folder: ${home}`);
        out(status.pairings.length === 0 ? 'Pairings: none' : 'Pairings:');
        for (const pairing of status.pairings) out(pairingLine(pairing));
        out(`Allowed environment variables: ${status.allowedEnv.length === 0 ? 'none' : status.allowedEnv.join(', ')}`);
        return ExitCode.Ok;
      }
      case 'agent-allow-env':
      case 'agent-disallow-env': {
        const change = args.command === 'agent-allow-env' ? { add: args.names } : { remove: args.names };
        const now = await bundle.changeAllowedEnv({ ...input, ...change });
        out(`Allowed environment variables: ${now.length === 0 ? 'none' : now.join(', ')}`);
        return ExitCode.Ok;
      }
      case 'agent-allowed-env': {
        const { allowedEnv } = await bundle.agentStatus(input);
        for (const name of allowedEnv) out(name);
        return ExitCode.Ok;
      }
    }
  } catch (error) {
    io.stderr.write(`wirebench agent: ${describe(error)}\n`);
    return error instanceof Error && error.name === 'AgentNotPairedError' ? ExitCode.Usage : ExitCode.RunError;
  }
}
