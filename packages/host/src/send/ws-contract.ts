/**
 * A WebSocket session's frames checked against its contract on a worker thread (see
 * `createWorkerFrameChecker`), fed by the session's live `frame` events: each result is reported
 * after the frame's own event, and kept by index for the session's summary.
 */
import { createWorkerFrameChecker, DEFAULT_FRAME_CHECK_DEADLINE_MS } from '@wirebench/engine';
import type {
  ChannelMessages,
  WorkerFrameChecker,
  WorkerFrameCheckerOptions,
  WsExchange,
  WsFrame,
  WsFrameContract,
} from '@wirebench/engine';

/** One session's checks, from its first frame to its summary. */
export interface WsContractChecks {
  /** Checks `frame`; its result is reported once the worker answers. */
  check(frame: WsFrame): void;
  /** Waits (one deadline at most) for what is still being checked, then ends the worker. */
  settle(): Promise<Map<number, WsFrameContract>>;
  /** Ends the worker however the session ended; a check still waiting reports `not-checked`. */
  dispose(): Promise<void>;
}

/**
 * The checks of the session `sendId`, or `undefined` when it has no contract. A contract that fails
 * to load turns checking off for the session with one console line. `checkers` holds the session's
 * worker while it runs, so whoever owns the sessions can see it.
 */
export function wsContractChecks(
  sendId: string,
  contract: Promise<ChannelMessages | undefined> | undefined,
  options: WorkerFrameCheckerOptions | undefined,
  onContract: (index: number, contract: WsFrameContract) => void,
  checkers: Map<string, WorkerFrameChecker>,
): WsContractChecks | undefined {
  if (contract === undefined) {
    return undefined;
  }
  const results = new Map<number, WsFrameContract>();
  const pending = new Set<Promise<void>>();
  let checker: WorkerFrameChecker | undefined;
  let ended = false;
  const ready: Promise<WorkerFrameChecker | undefined> = contract.then(
    (messages) => {
      if (messages === undefined || ended) {
        return undefined;
      }
      checker = createWorkerFrameChecker(messages, options);
      checkers.set(sendId, checker);
      return checker;
    },
    (error: unknown) => {
      console.warn(
        `[ws] the contract for send "${sendId}" could not be loaded, so its frames are not checked: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    },
  );
  const stop = async (): Promise<void> => {
    ended = true;
    if (checker !== undefined && checkers.get(sendId) === checker) {
      checkers.delete(sendId);
    }
    await checker?.dispose();
  };
  return {
    check: (frame) => {
      const job = ready
        .then((ready) => ready?.check(frame))
        .then((result) => {
          if (result === undefined) {
            return;
          }
          results.set(frame.index, result);
          onContract(frame.index, result);
        });
      pending.add(job);
      void job.finally(() => pending.delete(job));
    },
    // One overall deadline for everything still waiting, not one per frame: a backed-up queue
    // must not hold the summary (History, a quit, a workspace close) for minutes. Whatever has
    // not been answered by then is ended by `dispose`, which reports it `not-checked`.
    settle: async () => {
      const deadlineMs = options?.deadlineMs ?? DEFAULT_FRAME_CHECK_DEADLINE_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...pending]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deadlineMs);
        }),
      ]);
      clearTimeout(timer);
      await stop();
      // The checks `dispose` just answered land their results a few microtasks later.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return results;
    },
    dispose: () => stop(),
  };
}

/** The exchange with each frame's check result on it, as History and the summary keep them. */
export function withContracts(exchange: WsExchange, results: ReadonlyMap<number, WsFrameContract>): WsExchange {
  if (results.size === 0) {
    return exchange;
  }
  return {
    ...exchange,
    frames: exchange.frames.map((frame) => {
      const contract = results.get(frame.index);
      return contract === undefined ? frame : { ...frame, contract };
    }),
  };
}
