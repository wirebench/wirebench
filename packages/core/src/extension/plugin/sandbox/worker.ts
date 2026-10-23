/**
 * Entry point run inside a `node:worker_threads` Worker by {@link createPluginSandbox}. It loads the
 * QuickJS WebAssembly module once, then runs each call it is sent (`{ kind: 'run', id, job }`) in a
 * fresh runtime, one at a time. A `net.fetch` is asked of the host (`{ kind: 'fetch' }`) and answered
 * (`{ kind: 'fetched' }`); the call's result is `{ kind: 'done', id, result, recycle }`.
 */
import { parentPort } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executePluginJob } from './execute.js';
import type { PluginFetchAnswer, PluginJob } from './model.js';

/* v8 ignore start -- runs only inside a real worker thread; covered end to end by plugin-sandbox.test.ts. */
if (parentPort !== null) {
  const port = parentPort;
  const module = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-wasmfile-release-sync'));
  let nextFetch = 0;
  const answers = new Map<number, (answer: PluginFetchAnswer) => void>();
  let queue = Promise.resolve();
  port.on('message', (message: { kind: 'run'; id: number; job: PluginJob } | PluginFetchAnswer) => {
    if (message.kind === 'fetched') {
      answers.get(message.fetchId)?.(message);
      answers.delete(message.fetchId);
      return;
    }
    const { id, job } = message;
    queue = queue.then(async () => {
      const fetch = (request: string): Promise<{ ok: boolean; text: string }> =>
        new Promise((resolve) => {
          nextFetch += 1;
          answers.set(nextFetch, (answer) => {
            resolve({ ok: answer.ok, text: answer.text });
          });
          port.postMessage({ kind: 'fetch', id, fetchId: nextFetch, request });
        });
      const { result, recycle } = await executePluginJob(module, job, fetch);
      port.postMessage({ kind: 'done', id, result, recycle });
    });
  });
}
/* v8 ignore stop */
