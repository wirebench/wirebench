import { describe, expect, it } from 'vitest';
import type { AssertionSubject } from '../../../src/assert/model.js';
import { BASELINE_MAX_BYTES, checkBaseline } from '../../../src/run/baseline.js';
import type { GoldenRead } from '../../../src/snapshot/golden-file.js';

const subject = (bodyText: string, contentType = 'application/json'): AssertionSubject => ({
  protocol: 'rest',
  status: 200,
  durationMs: 5,
  bodyText,
  bodyKind: 'json',
  headers: [['Content-Type', contentType]],
});

const present = (body: string, ignore: string[] = [], contentType?: string): GoldenRead => ({
  status: 'present',
  golden: { ...(contentType !== undefined ? { contentType } : {}), savedAt: '2026-10-03T10:00:00.000Z', ignore, body },
});

describe('checkBaseline', () => {
  it('passes a semantically equal body', () => {
    const check = checkBaseline(present('{"a":1,"b":[1,2]}'), subject('{ "b": [1, 2], "a": 1.0 }'), false);
    expect(check.report).toEqual({ status: 'matched', format: 'json', ignored: 0 });
    expect(check.assertion).toEqual({ type: 'baseline', label: 'matches the baseline', outcome: 'passed' });
  });

  it('counts ignored changes in the label', () => {
    const check = checkBaseline(present('{"id":1,"ts":"a"}', ['/ts']), subject('{"id":1,"ts":"b"}'), false);
    expect(check.report.status).toBe('matched');
    expect(check.assertion?.label).toBe('matches the baseline (1 ignored)');
  });

  it('fails a difference, listing it', () => {
    const check = checkBaseline(present('{"a":1,"c":3}'), subject('{"a":2,"b":2}'), false);
    expect(check.report.status).toBe('differs');
    expect(check.report.changes).toHaveLength(3);
    expect(check.assertion).toMatchObject({
      type: 'baseline',
      outcome: 'failed',
      label: '3 differences from the baseline',
    });
    expect(check.assertion?.message?.split('\n').sort()).toEqual(['added /b: 2', 'changed /a: 1 → 2', 'removed /c: 3']);
    expect(check.assertion?.expected).toBeUndefined();
  });

  it('says "1 difference" in the singular', () => {
    expect(checkBaseline(present('{"a":1}'), subject('{"a":2}'), false).assertion?.label).toBe(
      '1 difference from the baseline',
    );
  });

  it('keeps 100 changes and lists 20', () => {
    const golden = JSON.stringify(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i])));
    const check = checkBaseline(present(golden), subject('{}'), false);
    expect(check.report.changes).toHaveLength(100);
    expect(check.report.truncated).toBe(true);
    expect(check.assertion?.label).toBe('150 differences from the baseline');
    const lines = check.assertion?.message?.split('\n') ?? [];
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe('… and 130 more');
  });

  it('takes the format from the golden content type first', () => {
    // Were the response's JSON header used, the XML would fail to parse and fall back to text.
    const check = checkBaseline(
      present('<a>1</a>', [], 'application/xml'),
      subject('<a>2</a>', 'application/json'),
      false,
    );
    expect(check.report.format).toBe('xml');
    expect(check.report.status).toBe('differs');
    expect(check.report.error).toBeUndefined();
  });

  it('reports a missing golden without an assertion, or as an error under require', () => {
    expect(checkBaseline({ status: 'none' }, subject('{}'), false)).toEqual({ report: { status: 'missing' } });
    const required = checkBaseline({ status: 'none' }, subject('{}'), true);
    expect(required.report).toEqual({ status: 'missing' });
    expect(required.assertion).toBeUndefined();
    expect(required.error).toEqual({ code: 'baseline-missing', message: 'No baseline is saved for this request.' });
  });

  it('errors on an unreadable golden', () => {
    const check = checkBaseline({ status: 'unreadable', reason: 'malformed' }, subject('{}'), false);
    expect(check.report).toEqual({ status: 'unreadable' });
    expect(check.assertion).toMatchObject({ type: 'baseline', outcome: 'errored', label: 'baseline' });
    expect(check.assertion?.message).toBe('The saved baseline cannot be read (malformed).');
  });

  it('errors when either side is too large', () => {
    const big = 'x'.repeat(BASELINE_MAX_BYTES + 1);
    const check = checkBaseline(present('{}'), subject(big, 'text/plain'), false);
    expect(check.report).toEqual({ status: 'too-large' });
    expect(check.assertion?.message).toBe('Too large to compare semantically.');
  });

  it('passes a parse failure note through with the differences', () => {
    const check = checkBaseline(present('{"a":1}', [], 'application/json'), subject('{oops'), false);
    expect(check.report.status).toBe('differs');
    expect(check.report.error).toBeDefined();
  });
});
