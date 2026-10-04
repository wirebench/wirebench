import { describe, expect, it } from 'vitest';
import type { AssertionSubject } from '../../../src/assert/model.js';
import { BASELINE_MAX_BYTES } from '../../../src/run/baseline.js';
import { finishBaselineUpdate, planBaselineUpdate } from '../../../src/run/baseline-update.js';
import type { BaselineUpdateInput } from '../../../src/run/baseline-update.js';
import type { GoldenRead } from '../../../src/snapshot/golden-file.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const subject = (
  bodyText: string,
  headers: [string, string][] = [['Content-Type', 'application/json']],
): AssertionSubject => ({
  protocol: 'rest',
  bodyKind: 'json',
  status: 200,
  durationMs: 1,
  headers,
  bodyText,
});
const present = (body: string, ignore: string[] = []): GoldenRead => ({
  status: 'present',
  golden: { contentType: 'application/json', savedAt: 'old', ignore, body },
});
const input = (read: GoldenRead, body: string, extra: Partial<BaselineUpdateInput> = {}): BaselineUpdateInput => ({
  read,
  subject: subject(body),
  failed: false,
  now: () => NOW,
  ...extra,
});

describe('planBaselineUpdate', () => {
  it('leaves a matching golden alone, with no assertion', () => {
    const plan = planBaselineUpdate(input(present('{"a": 1}'), '{"a":1}'));
    expect(plan).toEqual({ kind: 'done', check: { report: { status: 'matched', format: 'json', ignored: 0 } } });
  });

  it('treats a difference under an ignore rule as matched', () => {
    const plan = planBaselineUpdate(input(present('{"a": 1}', ['/a']), '{"a": 2}'));
    expect(plan.kind === 'done' && plan.check.report).toMatchObject({ status: 'matched', ignored: 1 });
  });

  it('writes a differing golden with its old ignore rules, and reports what moved', () => {
    const plan = planBaselineUpdate(input(present('{"a": 1, "b": 1}', ['/b']), '{"a": 2, "b": 2}'));
    expect(plan.kind).toBe('write');
    if (plan.kind !== 'write') return;
    expect(plan.golden).toEqual({
      contentType: 'application/json',
      savedAt: NOW.toISOString(),
      ignore: ['/b'],
      body: '{"a": 2, "b": 2}',
    });
    expect(plan.report).toMatchObject({ status: 'updated', format: 'json', ignored: 1 });
    expect(plan.report.changes).toHaveLength(1);
    expect(plan.report.changes?.[0]).toMatchObject({ kind: 'changed', path: '/a' });
  });

  it('creates a missing golden with no ignore rules', () => {
    const plan = planBaselineUpdate(input({ status: 'none' }, '{"a": 1}'));
    expect(plan.kind === 'write' && plan.golden.ignore).toEqual([]);
    expect(plan.kind === 'write' && plan.report).toEqual({ status: 'created' });
  });

  it('omits the content type when the response has none', () => {
    const plan = planBaselineUpdate({ ...input({ status: 'none' }, 'x'), subject: subject('x', []) });
    expect(plan.kind === 'write' && 'contentType' in plan.golden).toBe(false);
  });

  it('skips a request whose own assertions failed, whatever the golden', () => {
    const plan = planBaselineUpdate(input({ status: 'unreadable', reason: 'malformed' }, 'x', { failed: true }));
    expect(plan).toEqual({ kind: 'done', check: { report: { status: 'skipped', reason: 'failed' } } });
  });

  it('refuses an unreadable golden with an errored assertion', () => {
    for (const reason of ['malformed', 'not-a-file'] as const) {
      const plan = planBaselineUpdate(input({ status: 'unreadable', reason }, 'x'));
      expect(plan.kind === 'done' && plan.check.report).toEqual({ status: 'refused', reason });
      expect(plan.kind === 'done' && plan.check.assertion).toMatchObject({ type: 'baseline', outcome: 'errored' });
    }
  });

  it('refuses a body holding a known secret, naming no value', () => {
    const plan = planBaselineUpdate(
      input({ status: 'none' }, '{"token": "hunter2-long"}', {
        containsKnownSecret: (value) => value.includes('hunter2-long'),
      }),
    );
    expect(plan.kind === 'done' && plan.check.report).toEqual({ status: 'refused', reason: 'secret' });
    expect(plan.kind === 'done' && plan.check.assertion?.message).not.toContain('hunter2');
  });

  it('never refuses a matching golden for a secret', () => {
    const plan = planBaselineUpdate(input(present('"k"'), '"k"', { containsKnownSecret: () => true }));
    expect(plan.kind === 'done' && plan.check.report.status).toBe('matched');
  });

  it('skips a body with no text form', () => {
    for (const body of ['a\u0000b', 'a�b']) {
      const plan = planBaselineUpdate(input({ status: 'none' }, body));
      expect(plan).toEqual({ kind: 'done', check: { report: { status: 'skipped', reason: 'not-text' } } });
    }
  });

  it('compares an oversize body as exact text', () => {
    const big = 'x'.repeat(BASELINE_MAX_BYTES + 1);
    const same = planBaselineUpdate(input(present(big), big));
    expect(same.kind === 'done' && same.check.report).toEqual({ status: 'matched' });
    const changed = planBaselineUpdate(input(present(big), `${big}y`));
    expect(changed.kind === 'write' && changed.report).toEqual({ status: 'updated' });
  });
});

describe('finishBaselineUpdate', () => {
  it('passes a written golden and records its file', () => {
    expect(finishBaselineUpdate({ status: 'created' }, { status: 'written', file: 'apis/a/x.golden.yaml' })).toEqual({
      report: { status: 'created', file: 'apis/a/x.golden.yaml' },
      assertion: { type: 'baseline', label: 'baseline created', outcome: 'passed' },
    });
  });

  it('errors a refused or failed write', () => {
    expect(finishBaselineUpdate({ status: 'updated' }, { status: 'refused', reason: 'not-a-file' }).report).toEqual({
      status: 'refused',
      reason: 'not-a-file',
    });
    const failed = finishBaselineUpdate({ status: 'updated' }, { status: 'failed', message: 'disk full' });
    expect(failed.report).toEqual({ status: 'refused', reason: 'write-failed' });
    expect(failed.assertion).toMatchObject({
      outcome: 'errored',
      message: 'The baseline could not be written: disk full',
    });
  });
});
