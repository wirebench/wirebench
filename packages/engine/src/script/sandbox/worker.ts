/**
 * Entry point run inside a `node:worker_threads` Worker by {@link createScriptSandbox}. It loads the
 * QuickJS WebAssembly module once, then runs each job it is sent (`{ id, job }`) in a fresh runtime,
 * one at a time, and answers `{ id, result, recycle }`.
 */
import { parentPort } from 'node:worker_threads';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { executeJob } from './execute.js';
import type { SandboxJob } from './model.js';

/* v8 ignore start -- runs only inside a real worker thread; covered end to end by sandbox.test.ts,
   which coverage instrumentation does not follow across the thread. */
if (parentPort !== null) {
  const port = parentPort;
  // Messages that arrive while the module loads wait in the port until the listener is attached.
  const module = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-wasmfile-release-sync'));
  port.on('message', ({ id, job }: { id: number; job: SandboxJob }) => {
    const { result, recycle } = executeJob(module, job);
    port.postMessage({ id, result, recycle });
  });
}
/* v8 ignore stop */
