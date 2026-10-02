/** What a protocol module is given for one run: the run's context and its one cache (spec §3.3). */
import type { RunScope } from '../protocol/module.js';
import type { RunContext } from './context.js';

/**
 * A scope for one run. `memo` keeps one value per key for the scope's lifetime: a compiled WSDL, a
 * proto set, an OpenAPI document. A load that rejects is remembered too, since nothing in a run can
 * fix a cache, and every later request behind the key reports the same error.
 */
export function createRunScope(context: RunContext): RunScope {
  const loads = new Map<string, Promise<unknown>>();
  return {
    context,
    memo<T>(key: string, load: () => Promise<T>): Promise<T> {
      const known = loads.get(key) as Promise<T> | undefined;
      if (known !== undefined) {
        return known;
      }
      const loading = load();
      // Observed here so a rejection nobody awaits yet is never reported as unhandled.
      loading.catch(() => undefined);
      loads.set(key, loading);
      return loading;
    },
  };
}

/** `scope` with another context and the same cache: what one request of the run is sent with. */
export function scopeWith(scope: RunScope, context: RunContext): RunScope {
  return { context, memo: (key, load) => scope.memo(key, load) };
}
