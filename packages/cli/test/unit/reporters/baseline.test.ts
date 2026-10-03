import { PassThrough } from 'node:stream';
import type { RequestResult, RunResult } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { createCliReporter } from '../../../src/reporters/cli.js';
import { toJsonReport } from '../../../src/reporters/json.js';
import { maskRequestResult } from '../../../src/reporters/mask.js';

const differs: RequestResult = {
  path: 'demo/ok',
  group: 'demo',
  name: 'ok',
  protocol: 'rest',
  outcome: 'failed',
  status: 200,
  durationMs: 3,
  unasserted: false,
  assertions: [
    {
      type: 'baseline',
      label: '1 difference from the baseline',
      outcome: 'failed',
      message: 'changed /token: s3cret-value → x',
    },
  ],
  baseline: {
    status: 'differs',
    format: 'json',
    ignored: 0,
    changes: [{ kind: 'changed', path: '/token', expected: 's3cret-value', actual: 'x' }],
  },
};

const matched: RequestResult = {
  ...differs,
  outcome: 'passed',
  assertions: [{ type: 'baseline', label: 'matches the baseline', outcome: 'passed' }],
  baseline: { status: 'matched', format: 'json', ignored: 0 },
};

const missing: RequestResult = { ...differs, outcome: 'passed', assertions: [], baseline: { status: 'missing' } };

function cliText(result: RequestResult): string {
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk: Buffer) => (text += chunk.toString()));
  createCliReporter(out, { color: false, quiet: false, verbose: false }).onRequestDone?.(result);
  return text;
}

describe('baseline in reports', () => {
  it('cli: prints the change list indented under the label', () => {
    const text = cliText(differs);
    expect(text).toContain('    1 difference from the baseline\n');
    expect(text).toContain('      changed /token: s3cret-value → x\n');
  });

  it('cli: marks a match and a missing golden on the request line', () => {
    expect(cliText(matched)).toContain('baseline: matches');
    expect(cliText(missing)).toContain('(no baseline)');
  });

  it('json: carries the baseline field and the summary counts', () => {
    const run: RunResult = {
      startedAt: 's',
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        errored: 0,
        skipped: 0,
        durationMs: 3,
        baseline: { matched: 0, differs: 1, missing: 0 },
      },
      requests: [differs],
    };
    const report = toJsonReport(run, { name: 'wirebench', version: '0' });
    expect(report.formatVersion).toBe(1);
    expect(report.requests[0]?.baseline).toEqual(differs.baseline);
    expect(report.summary.baseline).toEqual({ matched: 0, differs: 1, missing: 0 });
  });

  it('mask: hides a secret in the baseline changes and the assertion message', () => {
    const masked = maskRequestResult(differs, (text) => text.replaceAll('s3cret-value', '****'));
    expect(JSON.stringify(masked)).not.toContain('s3cret-value');
    expect(masked.baseline?.changes?.[0]?.expected).toBe('****');
  });

  it('mask: hides a secret in the baseline parse note, with and without changes', () => {
    const hide = (text: string): string => text.replaceAll('s3cret-value', '****');
    const note = 'Unexpected token s3cret-value in JSON at position 4';
    const alone = maskRequestResult({ ...missing, baseline: { status: 'unreadable', error: note } }, hide);
    expect(alone.baseline?.error).toBe('Unexpected token **** in JSON at position 4');
    const withChanges = maskRequestResult({ ...differs, baseline: { ...differs.baseline!, error: note } }, hide);
    expect(JSON.stringify(withChanges)).not.toContain('s3cret-value');
    expect(withChanges.baseline?.error).toContain('****');
  });
});
