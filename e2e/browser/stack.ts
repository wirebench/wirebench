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

/** `container_name` in `compose.yaml`: the admin CLI runs in it. */
export const SERVER_CONTAINER = 'wirebench-browser-e2e-server';

/** The echo service's address as the server sees it, on the compose network. */
export const ECHO_URL = 'http://echo:8080';

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
}

export const SEED_ENV = 'WIREBENCH_E2E_BROWSER_SEED';

/** The seed global setup wrote, read in a worker. */
export function readSeed(): Seed {
  const raw = process.env[SEED_ENV];
  if (raw === undefined) throw new Error(`${SEED_ENV} is not set: the browser suite's global setup did not run`);
  return JSON.parse(raw) as Seed;
}
