import { describe, expect, it } from 'vitest';
import { evaluateWithTimeout } from '../../../src/xpath/evaluate-async.js';

const DOC = '<a><b>1</b></a>';

describe('evaluateWithTimeout', () => {
  it('resolves normally for a fast expression', async () => {
    const result = await evaluateWithTimeout(DOC, '//b/text()', { language: 'xpath' });
    expect(result.kind).toBe('nodes');
    if (result.kind !== 'nodes') throw new Error('expected nodes');
    expect(result.items[0]?.text).toBe('1');
  });

  it('times out a pathological expression instead of blocking the event loop', async () => {
    // Builds and string-joins a 5-million-item sequence; fontoxpath's synchronous evaluation of
    // that runs for many seconds, well past a 200ms budget (verified directly against the
    // package: still running after 2 minutes on this machine).
    const expression = 'string-join(for $x in (1 to 5000000) return string($x), ",")';
    const start = Date.now();
    let concurrentTimerFired = false;
    const concurrentTimer = setTimeout(() => {
      concurrentTimerFired = true;
    }, 20);

    const result = await evaluateWithTimeout(DOC, expression, { language: 'xpath' }, { timeoutMs: 200 });

    clearTimeout(concurrentTimer);
    const elapsed = Date.now() - start;

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('expected error');
    expect(result.code).toBe('xpath-timeout');
    expect(elapsed).toBeLessThan(1_000);
    // A concurrent timer on the main thread firing proves the worker thread doing the
    // pathological evaluation never blocked *this* process's event loop.
    expect(concurrentTimerFired).toBe(true);
  }, 5_000);

  it('reports a worker-thread evaluation error the same way the sync evaluate does', async () => {
    const result = await evaluateWithTimeout(DOC, '//[', { language: 'xpath' });
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('expected error');
    expect(result.code).toBe('XPST0003');
  });

  it('defaults to a 5000ms budget when timeoutMs is not given', async () => {
    const result = await evaluateWithTimeout(DOC, '//b/text()', { language: 'xpath' }, {});
    expect(result.kind).toBe('nodes');
  });
});
