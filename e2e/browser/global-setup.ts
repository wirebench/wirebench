/**
 * The browser suite's global setup: makes sure the stack in `compose.yaml` answers, then seeds it
 * (`seed.ts`) and hands the seed to the workers through the environment.
 *
 * CI starts the stack itself before the suite (`.github/workflows/ci.yml`, `browser-e2e`). Run locally
 * with nothing on the port, this starts it with a freshly generated secrets key and takes it down
 * (with its volumes) afterwards; `WIREBENCH_E2E_KEEP=1` leaves it up for the next run.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { seedServer } from './seed.js';
import { BASE_URL, COMPOSE_FILE, SEED_ENV } from './stack.js';

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

export default async function globalSetup(): Promise<(() => void) | undefined> {
  let teardown: (() => void) | undefined;
  if (!(await healthy())) {
    // 32 random bytes, base64: what WIREBENCH_SERVER_SECRETS_KEY takes. Made per run, never written down.
    const env = {
      ...process.env,
      WIREBENCH_E2E_SECRETS_KEY: process.env['WIREBENCH_E2E_SECRETS_KEY'] ?? randomBytes(32).toString('base64'),
    };
    compose(['up', '-d', '--build', '--wait'], env);
    if (process.env['WIREBENCH_E2E_KEEP'] !== '1') {
      teardown = () => {
        compose(['down', '-v'], env);
      };
    }
  }
  try {
    if (!(await healthy())) throw new Error(`The server does not answer on ${BASE_URL}/healthz`);
    process.env[SEED_ENV] = JSON.stringify(await seedServer());
  } catch (error) {
    teardown?.();
    throw error;
  }
  return teardown;
}
