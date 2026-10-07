import { PassThrough } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardWorkerOutput, routeWorkerOutput, workerOutputOptions } from '../../src/worker-output.js';

const WRITES_TO_STDOUT = `process.stdout.write('stray line\\n'); require('node:worker_threads').parentPort.postMessage('done');`;

function run(): Promise<void> {
  const worker = new Worker(WRITES_TO_STDOUT, { eval: true, ...workerOutputOptions() });
  forwardWorkerOutput(worker);
  return new Promise((resolve, reject) => {
    worker.once('message', () => {
      // Output ahead of the message has been queued; let the stream deliver it.
      setTimeout(() => void worker.terminate().then(() => resolve()), 50);
    });
    worker.once('error', reject);
  });
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
    let seen = '';
    sink.on('data', (chunk: Buffer) => (seen += chunk.toString()));
    restore = routeWorkerOutput(sink);
    expect(workerOutputOptions()).toEqual({ stdout: true });
    await run();
    expect(seen).toBe('stray line\n');
  });

  it('goes back to the default when restored', () => {
    routeWorkerOutput(new PassThrough())();
    expect(workerOutputOptions()).toEqual({});
  });
});
