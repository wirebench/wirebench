/**
 * Entry point run inside a `node:worker_threads` Worker by {@link createScriptChecker}. Each message
 * is one request (`{ id, request }`) answered with `{ id, result }` or `{ id, error }`, one at a time.
 */
import { parentPort } from 'node:worker_threads';
import {
  checkOnce,
  completionsAt,
  diagnosticsOf,
  quickInfoAt,
  removeModel,
  signatureHelpAt,
  updateModel,
} from './service.js';
import type { CheckerRequest } from './host.js';

function answer(request: CheckerRequest): unknown {
  switch (request.op) {
    case 'check':
      return checkOnce(request.model);
    case 'remove':
      removeModel(request.modelId);
      return null;
    case 'diagnostics':
      updateModel(request.modelId, request.model);
      return diagnosticsOf(request.modelId);
    case 'completions':
      updateModel(request.modelId, request.model);
      return completionsAt(request.modelId, request.line, request.column);
    case 'quickInfo':
      updateModel(request.modelId, request.model);
      return quickInfoAt(request.modelId, request.line, request.column) ?? null;
    case 'signatureHelp':
      updateModel(request.modelId, request.model);
      return signatureHelpAt(request.modelId, request.line, request.column) ?? null;
  }
}

/* v8 ignore start -- runs only inside a real worker thread; covered end to end by check.test.ts. */
if (parentPort !== null) {
  const port = parentPort;
  port.on('message', ({ id, request }: { id: number; request: CheckerRequest }) => {
    try {
      port.postMessage({ id, result: answer(request) });
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
/* v8 ignore stop */
