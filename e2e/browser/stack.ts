/**
 * Where the browser suite's stack (`compose.yaml` here) answers, and what global setup hands the spec.
 * Shared by the config, global setup and the spec, so the port and origin are spelled once.
 */
import { fileURLToPath } from 'node:url';

/** The host port the server is published on; the public URL and the browser's origin follow it. */
export const PORT = process.env['WIREBENCH_E2E_PORT'] ?? '18080';

/**
 * The server's public URL, which is also the only origin the browser may use: the sign-in form and
 * sign-out compare Origin with it exactly, so `127.0.0.1` in place of `localhost` would be refused.
 */
export const BASE_URL = `http://localhost:${PORT}`;

export const COMPOSE_FILE = fileURLToPath(new URL('./compose.yaml', import.meta.url));

/** The compose service the admin CLI runs in (`docker compose exec`). */
export const SERVER_SERVICE = 'server';

/** The echo service's address as the server sees it, on the compose network. */
export const ECHO_URL = 'http://echo:8080';

/**
 * The built CLI, whose `wirebench agent` runs on this machine beside the browser (spec §18.7), outside
 * Docker: `pnpm --filter @wirebench/cli build` makes it, with the agent's bundle.
 */
export const CLI_BIN = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));

/** The headless agent's folder (`WIREBENCH_AGENT_HOME`), made per run by global setup and handed to the workers. */
export const AGENT_HOME_ENV = 'WIREBENCH_E2E_AGENT_HOME';

/** The agent's home, read in a worker. */
export function readAgentHome(): string {
  const home = process.env[AGENT_HOME_ENV];
  if (home === undefined) throw new Error(`${AGENT_HOME_ENV} is not set: the browser suite's global setup did not run`);
  return home;
}

/** What global setup seeded, passed to the workers in {@link SEED_ENV}. */
export interface Seed {
  readonly email: string;
  readonly password: string;
  readonly teamName: string;
  readonly workspaceName: string;
  readonly projectName: string;
  readonly apiName: string;
  /** A GET to the echo service. */
  readonly echoRequest: string;
  /** A GET to `127.0.0.1`, which the egress rule refuses on the server. */
  readonly loopbackRequest: string;
  /**
   * A GET to the echo server global setup starts on this machine's `127.0.0.1`: only the paired agent can
   * reach it, since the server's loopback is its container's.
   */
  readonly agentRequest: string;
  /** The path {@link agentRequest} asks for, which its echo answers with. */
  readonly agentPath: string;
}

export const SEED_ENV = 'WIREBENCH_E2E_BROWSER_SEED';

/** The seed global setup wrote, read in a worker. */
export function readSeed(): Seed {
  const raw = process.env[SEED_ENV];
  if (raw === undefined) throw new Error(`${SEED_ENV} is not set: the browser suite's global setup did not run`);
  return JSON.parse(raw) as Seed;
}
