/**
 * The CI token in `WIREBENCH_SERVER_TOKEN` is a secret the run holds: an error that quotes it, from
 * anywhere, comes out masked, and it is on no other output.
 */
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ExitCode } from '../../src/exit-codes.js';
import { main } from '../../src/main.js';

const CI_TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';

vi.mock('@wirebench/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wirebench/engine')>()),
  runRequests: () => Promise.reject(new Error(`read failed, Authorization: Bearer ${CI_TOKEN}`)),
}));

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'runner-project');

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

describe('wirebench run — the CI token', () => {
  it('never appears in stdout or stderr', async () => {
    const stdout = sink();
    const stderr = sink();
    const code = await main(['run', FIXTURE, '-e', 'local'], {
      stdout: stdout.stream,
      stderr: stderr.stream,
      env: { WIREBENCH_SERVER_URL: 'https://wb.example.test', WIREBENCH_SERVER_TOKEN: CI_TOKEN },
    });
    expect(code).toBe(ExitCode.RunError);
    expect(stderr.text()).toContain('internal-error: read failed');
    expect(stderr.text()).not.toContain(CI_TOKEN);
    expect(stdout.text()).not.toContain(CI_TOKEN);
  });
});
