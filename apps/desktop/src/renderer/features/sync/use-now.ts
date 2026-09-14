import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every `intervalMs` — so a relative-time label ("3 min ago") keeps
 * advancing while its component stays mounted, instead of freezing at whatever it read on the
 * render that happened to be showing. `intervalMs <= 0` disables the timer (the value returned
 * is still whatever `now` was at mount): callers that only want the clock ticking in some
 * states (e.g. only while a dialog is open) pass `0` for the rest, rather than skipping the
 * hook call — hooks cannot be called conditionally.
 */
export function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (intervalMs <= 0) {
      return;
    }
    const id = setInterval(() => {
      setNow(new Date());
    }, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [intervalMs]);

  return now;
}
