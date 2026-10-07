import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardWorkerOutput, routeWorkerOutput, workerOutputOptions } from '../../src/worker-output.js';

const WRITES_TO_STDOUT = `process.stdout.write('stray line\\n');`;

async function run(sink: PassThrough, expected: string): Promise<void> {
  const worker = new Worker(WRITES_TO_STDOUT, { eval: true, ...workerOutputOptions() });
  forwardWorkerOutput(worker);
  let seen = '';
  sink.on('data', (chunk: Buffer) => (seen += chunk.toString()));
  const deadline = Date.now() + 5000;
  while (!seen.includes(expected) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await worker.terminate();
}

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('routeWorkerOutput', () => {
  it('leaves workers alone until a sink is set', () => {
    expect(workerOutputOptions()).toEqual({});
  });

  it('sends a worker thread stdout to the sink instead of the process stdout', async () => {
    const sink = new PassThrough();
    restore = routeWorkerOutput(sink);
    expect(workerOutputOptions()).toEqual({ stdout: true });
    let seen = '';
    sink.on('data', (chunk: Buffer) => (seen += chunk.toString()));
    await run(sink, 'stray line\n');
    expect(seen).toBe('stray line\n');
  });

  it('goes back to the default when restored', () => {
    routeWorkerOutput(new PassThrough())();
    expect(workerOutputOptions()).toEqual({});
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('every engine worker host', () => {
  it('starts its workers through the output helpers', () => {
    const src = join(import.meta.dirname, '../../src');
    const offenders = sourceFiles(src).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return (
        text.includes('new Worker(') &&
        !(text.includes('workerOutputOptions(') && text.includes('forwardWorkerOutput('))
      );
    });
    expect(offenders).toEqual([]);
  });
});
