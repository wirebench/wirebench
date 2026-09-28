import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';
import { matchRegexWithTimeout } from '../../../src/xpath/evaluate-async.js';

const rest: AssertionSubject = {
  protocol: 'rest',
  status: 200,
  durationMs: 1,
  bodyText: `{"name":"${'a'.repeat(40)}!"}`,
  bodyKind: 'json',
};

describe('matchRegexWithTimeout', () => {
  it('matches and misses like RegExp.test', async () => {
    expect(await matchRegexWithTimeout('^ab+c$', 'abbbc')).toEqual({ kind: 'matched', matched: true });
    expect(await matchRegexWithTimeout('^ab+c$', 'abd')).toEqual({ kind: 'matched', matched: false });
  });

  it('reports an invalid pattern instead of throwing', async () => {
    const result = await matchRegexWithTimeout('(unclosed', 'x');
    expect(result).toMatchObject({ kind: 'error', code: 'regex-invalid' });
  });

  it('times out a catastrophic pattern without blocking the calling thread', async () => {
    // `(a+)+$` against forty `a`s and a `!` backtracks through 2^40 splits: minutes of work that
    // nothing can interrupt on the thread running it.
    let concurrentTimerFired = false;
    const concurrentTimer = setTimeout(() => {
      concurrentTimerFired = true;
    }, 20);
    const start = Date.now();

    const result = await matchRegexWithTimeout('(a+)+$', `${'a'.repeat(40)}!`, { timeoutMs: 200 });

    clearTimeout(concurrentTimer);
    expect(result).toMatchObject({ kind: 'error', code: 'regex-timeout' });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(concurrentTimerFired).toBe(true);
  });
});

describe('match assertion with matches:', () => {
  it('passes and fails through the worker as before', async () => {
    const [passed, failed] = await evaluateAssertions(rest, [
      { type: 'match', language: 'jsonpath', expression: '$.name', matches: '^a+!$' },
      { type: 'match', language: 'jsonpath', expression: '$.name', matches: '^b' },
    ]);
    expect(passed?.outcome).toBe('passed');
    expect(failed).toMatchObject({ outcome: 'failed', expected: '/^b/' });
  });

  it('is errored, not thrown, for a pattern that does not compile', async () => {
    const [result] = await evaluateAssertions(rest, [
      { type: 'match', language: 'jsonpath', expression: '$.name', matches: '(unclosed' },
    ]);
    expect(result?.outcome).toBe('errored');
    expect(result?.message).toMatch(/regular expression/i);
  });
});
