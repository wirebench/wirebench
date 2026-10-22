import { describe, expect, it, vi } from 'vitest';
import { planLintRules } from '#protocol-rest/rest/openapi/lint/ruleset';
import { lintWithRules } from '#protocol-rest/rest/openapi/lint/run';
import { fixture, recordingFetch } from './helpers.js';

const calls = vi.hoisted(() => ({ batches: [] as { pattern: string; texts: readonly string[] }[] }));

vi.mock('#core/xpath/evaluate-async', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#core/xpath/evaluate-async')>();
  return {
    ...actual,
    matchRegexManyWithTimeout: (pattern: string, texts: readonly string[], options?: { timeoutMs?: number }) => {
      calls.batches.push({ pattern, texts });
      return actual.matchRegexManyWithTimeout(pattern, texts, options);
    },
  };
});

describe('pattern batching', () => {
  it('tests every value of one pattern in one worker job', async () => {
    const rules = planLintRules([
      {
        name: 'lint/ids.yaml',
        text: 'builtin: []\nrules:\n  ids: { target: operation, field: operationId, check: pattern, value: "^[a-z]" }\n',
      },
    ]);
    await lintWithRules(await fixture('clean-3.1.yaml'), rules, { fetchDocument: recordingFetch().fetchDocument });
    expect(calls.batches).toEqual([{ pattern: '^[a-z]', texts: ['getPet', 'putPet', 'health'] }]);
  });
});
