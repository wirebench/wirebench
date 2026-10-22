/**
 * Entry point run inside a `node:worker_threads` Worker by {@link createWorkerFrameChecker}. Its
 * `workerData` is the channel's messages and the in-check time budget; each message in is one frame
 * (`{ id, frame }`) and each message out its result (`{ id, contract }`, `null` for a frame no
 * contract speaks to). Frames are checked one at a time, in the order they arrive.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { WsFrame, WsFrameContract } from '../ws/model.js';
import { checkFrame, type ChannelMessages } from './frame-check.js';

/** What the host passes as `workerData`. */
export interface FrameCheckWorkerData {
  readonly messages: ChannelMessages;
  readonly budgetMs?: number;
}

/* v8 ignore start -- runs only inside a real worker thread; covered end to end by
   frame-check-worker.test.ts, which coverage instrumentation does not follow across the thread. */
if (parentPort !== null) {
  const port = parentPort;
  const data = workerData as FrameCheckWorkerData;
  port.on('message', ({ id, frame }: { id: number; frame: WsFrame }) => {
    let contract: WsFrameContract | undefined;
    try {
      contract = checkFrame(
        frame,
        data.messages[frame.direction],
        data.budgetMs !== undefined ? { budgetMs: data.budgetMs } : {},
      );
    } catch (error) {
      contract = { status: 'not-checked', reason: error instanceof Error ? error.message : String(error) };
    }
    port.postMessage({ id, contract: contract ?? null });
  });
}
/* v8 ignore stop */
