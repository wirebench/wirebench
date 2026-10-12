/**
 * A sequence step's branch (#347) in every report: the cli line names the path taken, json carries it
 * as data, html as a Path line, and a retried attempt is reported as one that does not count.
 */
import { PassThrough } from 'node:stream';
import type { RequestResult, RunResult } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { branchText } from '../../../src/reporters/branch-text.js';
import { createCliReporter } from '../../../src/reporters/cli.js';
import { renderHtml } from '../../../src/reporters/html.js';
import { renderJson } from '../../../src/reporters/json.js';

const sequence = { id: 'S', name: 'Jobs', stepId: 'T2' };

const step = (overrides: Partial<RequestResult>): RequestResult => ({
  path: 'Jobs/2. Poll',
  group: 'Jobs',
  name: '2. Poll',
  protocol: 'rest',
  outcome: 'passed',
  assertions: [],
  unasserted: true,
  sequence,
  transfers: [],
  ...overrides,
});

const POLL = { index: 1, stepId: 'T2', name: 'Poll' };

const RESULT: RunResult = {
  startedAt: '2026-10-11T10:00:00.000Z',
  summary: { total: 3, passed: 1, failed: 0, errored: 0, skipped: 2, durationMs: 10 },
  requests: [
    step({
      outcome: 'skipped',
      status: 200,
      durationMs: 3,
      retried: true,
      unasserted: false,
      branch: { rule: 0, action: 'repeat', to: POLL, count: 1, max: 3 },
    }),
    step({
      path: 'Jobs/2. Poll (attempt 2)',
      outcome: 'passed',
      status: 200,
      durationMs: 3,
      unasserted: false,
      attempt: 2,
      branch: { rule: 1, action: 'goto', to: { index: 3, stepId: 'T4', name: 'Report' }, count: 1, max: 1 },
    }),
    step({ path: 'Jobs/3. Fallback', name: '3. Fallback', outcome: 'skipped' }),
  ],
};

async function cliText(): Promise<string> {
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk: Buffer) => (text += chunk.toString()));
  const reporter = createCliReporter(out, { color: false, quiet: false, verbose: false });
  for (const request of RESULT.requests) reporter.onRequestDone?.(request);
  await reporter.onRunDone(RESULT);
  return text;
}

describe('a branching step in the reports', () => {
  it('describes each kind of path in one line', () => {
    const start = { index: 0, stepId: 'T1', name: 'Start' };
    const fallback = { index: 3, stepId: 'T4', name: 'Fallback' };
    expect(branchText(step({ branch: { rule: 0, action: 'repeat', to: POLL, count: 2, max: 10 } }))).toBe(
      '→ repeat (2 of 10)',
    );
    expect(branchText(step({ branch: { rule: 0, action: 'skip-next', count: 1 } }))).toBe('→ skip next');
    expect(branchText(step({ branch: { rule: 0, action: 'goto', to: fallback, count: 1, max: 1 } }))).toBe(
      '→ 4. Fallback (1 of 1)',
    );
    expect(
      branchText(step({ branch: { rule: 0, action: 'repeat', to: POLL, count: 10, max: 10, limitReached: true } })),
    ).toBe('limit reached: repeat 10 of 10');
    expect(
      branchText(step({ branch: { rule: 0, action: 'goto', to: start, count: 3, max: 3, limitReached: true } })),
    ).toBe('limit reached: go to 1 3 of 3');
    expect(branchText(step({}))).toBeUndefined();
  });

  it('prints the path on the step’s line, and marks a retried attempt', async () => {
    const text = await cliText();
    expect(text).toContain('- Jobs/2. Poll  200  3 ms  → repeat (1 of 3)  (retried)\n');
    expect(text).toContain('✓ Jobs/2. Poll (attempt 2)  200  3 ms  → 4. Report (1 of 1)\n');
  });

  it('carries attempt, retried and branch in the json report', () => {
    const json = JSON.parse(renderJson(RESULT, { name: 'wirebench', version: '0' })) as {
      requests: Record<string, unknown>[];
    };
    expect(json.requests[0]).toMatchObject({ retried: true, branch: { action: 'repeat', count: 1, max: 3 } });
    expect(json.requests[1]).toMatchObject({ attempt: 2, branch: { action: 'goto', to: { index: 3 } } });
    expect(json.requests[2]).not.toHaveProperty('branch');
    expect(json.requests[2]).not.toHaveProperty('attempt');
    expect(json.requests[2]).not.toHaveProperty('retried');
  });

  it('shows the path in the html report', () => {
    const html = renderHtml(RESULT, { name: 'wirebench', version: '0' });
    expect(html).toContain('Path: → repeat (1 of 3) (retried)');
    expect(html).toContain('Path: → 4. Report (1 of 1)');
  });
});
