/**
 * `wirebench mock` as a real process (#61): it serves until a signal, which is how `docker stop` and a
 * CI job's teardown end it, and exits 0. Windows has no SIGTERM to deliver, so the test runs elsewhere.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnCli } from './helpers.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mock-project');

describe.skipIf(process.platform === 'win32')('wirebench mock process', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('serves until %s, then exits 0', async (signal) => {
    const child = spawnCli(['mock', FIXTURE, 'orders', '--port', '0']);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const found = /^listening Orders (\S+)$/m.exec(stdout)?.[1];
        if (found !== undefined) resolve(found);
      });
      child.on('close', () => reject(new Error(`exited before listening: ${stderr}`)));
    });
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

    const response = await fetch(`${url}/orders`);
    expect(response.status).toBe(200);
    child.kill(signal);

    expect(await exited).toBe(0);
    expect(stdout).toMatch(/ Orders GET \/orders-api\/orders 200 get \/orders → Default \d+ms\n/);
    expect(stderr).toBe('');
  });
});
