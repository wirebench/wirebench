/**
 * A `setTimer` the test fires by hand (Global Constraints: inject timers, never sleep). The live module
 * arms three kinds through it — the 10 s auth timer, the 30 s heartbeat and each session's max-age
 * deadline — each with its own delay, so a test fires one kind by naming its delay.
 */
export interface ManualTimers {
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  /** Runs, oldest first, every armed timer whose delay is exactly `ms`; one armed while firing waits. Returns how many ran. */
  fire(ms: number): number;
  /** How many timers with delay `ms` are armed and not cancelled. */
  pending(ms: number): number;
}

export function manualTimers(): ManualTimers {
  const armed = new Set<{ readonly fn: () => void; readonly ms: number }>();
  return {
    setTimer(fn, ms) {
      const timer = { fn, ms };
      armed.add(timer);
      return {
        cancel: () => {
          armed.delete(timer);
        },
      };
    },
    fire(ms) {
      const due = [...armed].filter((timer) => timer.ms === ms);
      for (const timer of due) {
        armed.delete(timer);
        timer.fn();
      }
      return due.length;
    },
    pending(ms) {
      return [...armed].filter((timer) => timer.ms === ms).length;
    },
  };
}
