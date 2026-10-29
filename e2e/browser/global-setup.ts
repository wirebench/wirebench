/**
 * The browser suite's global setup: makes sure the stack in `compose.yaml` answers, starts this machine's
 * side (`agent.ts`: an echo server on `127.0.0.1` and the headless `wirebench agent`, unpaired), then seeds
 * the server (`seed.ts`) and hands the seed and the agent's folder to the workers through the environment.
 * Teardown stops the agent and the echo server, and removes the agent's folder.
 *
 * CI starts the stack itself before the suite (`.github/workflows/ci.yml`, `browser-e2e`). Run locally
 * with nothing on the port, this starts it with a freshly generated secrets key and takes it down
 * (with its volumes) afterwards; `WIREBENCH_E2E_KEEP=1` leaves it up for the next run.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAgent, startLocalEcho } from './agent.js';
import { seedServer } from './seed.js';
import { AGENT_HOME_ENV, BASE_URL, COMPOSE_FILE, SEED_ENV } from './stack.js';

async function healthy(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

function compose(args: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], { stdio: 'inherit', env });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  /** Run last to first at teardown, or at once when setup fails part way. */
  const undo: (() => void | Promise<void>)[] = [];
  const teardown = async (): Promise<void> => {
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch (error) {
        console.error('browser suite teardown:', error);
      }
    }
  };
  if (!(await healthy())) {
    // 32 random bytes, base64: what WIREBENCH_SERVER_SECRETS_KEY takes. Made per run, never written down.
    const env = {
      ...process.env,
      WIREBENCH_E2E_SECRETS_KEY: process.env['WIREBENCH_E2E_SECRETS_KEY'] ?? randomBytes(32).toString('base64'),
    };
    compose(['up', '-d', '--build', '--wait'], env);
    if (process.env['WIREBENCH_E2E_KEEP'] !== '1') {
      undo.push(() => {
        compose(['down', '-v'], env);
      });
    }
  }
  try {
    if (!(await healthy())) throw new Error(`The server does not answer on ${BASE_URL}/healthz`);
    const echo = await startLocalEcho();
    undo.push(() => echo.close());
    // A fresh folder per run: a new agent key, no pairings, no status file from an earlier run.
    const home = await mkdtemp(join(tmpdir(), 'wirebench-browser-agent-'));
    undo.push(() => rm(home, { recursive: true, force: true }));
    const agent = await startAgent(home);
    undo.push(() => agent.stop());
    process.env[AGENT_HOME_ENV] = home;
    process.env[SEED_ENV] = JSON.stringify(await seedServer(echo.url));
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
