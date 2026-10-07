import { PassThrough } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { forwardWorkerOutput, workerOutputOptions } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpCommand } from '../../../src/commands/mcp.js';
import { ExitCode } from '../../../src/exit-codes.js';
import { DEFAULT_CLI_SECRET_SOURCES } from '../../../src/source-secrets.js';
import { removeTempDirs, soapProject } from '../ops/helpers.js';

afterEach(removeTempDirs);

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { stream, text: () => text };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(done()).toBe(true);
}

describe('wirebench mcp on stdio: engine worker output', () => {
  it('sends a worker thread stdout to stderr, never into the frame stream', async () => {
    const fixture = await soapProject();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const running = mcpCommand(
      {
        command: 'mcp',
        allowWrite: false,
        allowSend: false,
        secretSources: DEFAULT_CLI_SECRET_SOURCES,
        project: fixture.dir,
        historyDir: fixture.historyDir,
      },
      { stdout: stdout.stream, stderr: stderr.stream, env: {} },
      { stdin },
    );
    await until(() => stderr.text().includes('serving'));

    const worker = new Worker("process.stdout.write('stray worker line\\n');", {
      eval: true,
      ...workerOutputOptions(),
    });
    forwardWorkerOutput(worker);
    await until(() => stderr.text().includes('stray worker line'));
    await worker.terminate();

    stdin.end();
    expect(await running).toBe(ExitCode.Ok);
    expect(stdout.text()).toBe('');
  });
});
