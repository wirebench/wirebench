/**
 * The one output path the integration leak tests cannot reach: `runRequests` itself throwing after
 * the run has obtained an access token. `main` prints the error's message to stderr, so the
 * message must come out masked with that token, not just with the environment's secrets.
 */
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { RunContext } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { ExitCode } from '../../src/exit-codes.js';
import { main } from '../../src/main.js';

const TOKEN = 'access-token-fetched-mid-run-9d2a';

vi.mock('@wirebench/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wirebench/engine')>()),
  runRequests: (_selected: unknown, context: RunContext) => {
    context.onSecretValue?.(TOKEN);
    return Promise.reject(new Error(`socket closed while sending Authorization: Bearer ${TOKEN}`));
  },
}));

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'runner-project');

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('wirebench run — an unexpected error after a token was fetched', () => {
  it('prints the error with the token masked', async () => {
    const stdout = sink();
    const stderr = sink();
    const code = await main(['run', FIXTURE, '-e', 'local'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: {},
    });
    expect(code).toBe(ExitCode.RunError);
    expect(stderr.text()).toContain('internal-error: socket closed while sending Authorization: Bearer');
    expect(stderr.text()).not.toContain(TOKEN);
    expect(stdout.text()).not.toContain(TOKEN);
  });
});
