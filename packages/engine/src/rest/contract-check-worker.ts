/**
 * Entry point run inside a `node:worker_threads` Worker by {@link createRestContractChecker}. Each
 * message in is one response (`{ id, input }`, the input carrying only the selected operation's
 * responses) and each message out its result (`{ id, result }`). Responses are checked one at a
 * time, in the order they arrive.
 */

import { parentPort } from 'node:worker_threads';
import { checkRestResponse, type RestContractInput, type RestContractResult } from './contract-check.js';

/* v8 ignore start -- runs only inside a real worker thread; covered end to end by
   contract-check-worker.test.ts, which coverage instrumentation does not follow across the thread. */
if (parentPort !== null) {
  const port = parentPort;
  port.on('message', ({ id, input }: { id: number; input: RestContractInput }) => {
    let result: RestContractResult;
    try {
      result = checkRestResponse(input);
    } catch (error) {
      result = {
        status: 'not-checked',
        problems: [],
        notes: [error instanceof Error ? error.message : String(error)],
      };
    }
    port.postMessage({ id, result });
  });
}
/* v8 ignore stop */
