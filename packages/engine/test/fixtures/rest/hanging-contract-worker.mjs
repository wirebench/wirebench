// A stand-in for the REST contract-check worker, for tests only: it speaks the same protocol,
// answers `ok` for every response, and never answers (spinning the thread, as a runaway regex
// would) for a response whose body is `hang`.
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', ({ id, input }) => {
  if (input.bodyText === 'hang') {
    for (;;) {
      // Spin: nothing on this thread can interrupt it; only terminate() can.
    }
  }
  parentPort.postMessage({ id, result: { status: 'ok', problems: [], notes: ['stub'] } });
});
