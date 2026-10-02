// @vitest-environment node
/** `editorAssertionResults`: a check that throws becomes one masked `errored` row, callbacks stay. */
import { describe, expect, it, vi } from 'vitest';
import type { Assertion, AssertionSubject } from '@wirebench/engine';
import { recordSecretValue } from '../src/main/redact.js';

vi.mock('@wirebench/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wirebench/engine')>()),
  checkRequestAssertions: vi.fn(() => Promise.reject(new Error('boom with leak-secret-55aa'))),
}));

const { editorAssertionResults } = await import('../src/main/send/assertions.js');

describe('editorAssertionResults', () => {
  it('reports a throwing check as one masked errored row, then the not-checked callbacks', async () => {
    recordSecretValue('leak-secret-55aa');
    const assertions: Assertion[] = [
      { type: 'status', equals: 200 },
      { type: 'callback', catchUrl: 'orders', withinMs: 1000, match: {}, expect: [] },
    ];
    const results = await editorAssertionResults(assertions, {} as AssertionSubject);
    expect(results?.map((r) => [r.type, r.label, r.outcome])).toEqual([
      ['check', 'assertions', 'errored'],
      ['callback', expect.any(String), 'not-checked'],
    ]);
    expect(results?.[0]?.message).toContain('boom');
    expect(results?.[0]?.message).not.toContain('leak-secret-55aa');
  });
});
