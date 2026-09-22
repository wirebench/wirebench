// A stand-in for the frame-check worker, for tests only: it speaks the same protocol, answers `ok`
// for every frame, and never answers (spinning the thread, as a runaway regex would) for a frame
// whose text is `hang`.
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', ({ id, frame }) => {
  if (frame.text === 'hang') {
    for (;;) {
      // Spin: nothing on this thread can interrupt it; only terminate() can.
    }
  }
  parentPort.postMessage({ id, contract: { status: 'ok', message: 'stub' } });
});
