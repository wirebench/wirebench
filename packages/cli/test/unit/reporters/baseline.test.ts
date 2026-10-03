import { PassThrough } from 'node:stream';
import type { RequestResult, RunResult, RunSummary } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { createCliReporter } from '../../../src/reporters/cli.js';
import { renderHtml } from '../../../src/reporters/html.js';
import { renderJunit } from '../../../src/reporters/junit.js';
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

  it('cli: prints the compared-as-text note as the first line under the label', () => {
    const noted: RequestResult = {
      ...differs,
      assertions: [
        {
          type: 'baseline',
          label: '1 difference from the baseline',
          outcome: 'failed',
          message: 'compared as text: Unexpected token o\nchanged /: a → b',
        },
      ],
    };
    const text = cliText(noted);
    expect(text).toContain('      compared as text: Unexpected token o\n      changed /: a → b\n');
  });

  it('cli: onRunDone prints the baseline summary line', async () => {
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => (text += chunk.toString()));
    await createCliReporter(out, { color: false, quiet: false, verbose: false }).onRunDone?.({
      startedAt: 's',
      summary: {
        total: 3,
        passed: 1,
        failed: 1,
        errored: 0,
        skipped: 0,
        durationMs: 3,
        baseline: { matched: 1, differs: 1, missing: 1 },
      },
      requests: [matched, differs, missing],
    });
    expect(text).toContain('baseline: 1 matched, 1 differ, 1 missing\n');
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

const updated: RequestResult = {
  ...differs,
  outcome: 'passed',
  assertions: [{ type: 'baseline', label: 'baseline updated', outcome: 'passed' }],
  baseline: {
    status: 'updated',
    format: 'json',
    ignored: 0,
    file: 'apis/demo/requests/ok.golden.yaml',
    changes: [{ kind: 'changed', path: '/ok', expected: 'false', actual: 'true' }],
  },
};
const created: RequestResult = {
  ...updated,
  assertions: [{ type: 'baseline', label: 'baseline created', outcome: 'passed' }],
  baseline: { status: 'created', file: 'apis/demo/requests/new.golden.yaml' },
};
const skipped: RequestResult = { ...differs, assertions: [], baseline: { status: 'skipped', reason: 'failed' } };
const refused: RequestResult = {
  ...differs,
  outcome: 'errored',
  assertions: [
    {
      type: 'baseline',
      label: 'baseline not written',
      outcome: 'errored',
      message: 'The response holds a secret value, so its baseline was not written.',
    },
  ],
  baseline: { status: 'refused', reason: 'secret' },
};

const ONE: RunSummary = { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 1 };
const TOOL = { name: 'wirebench', version: '0.0.0' };

async function runText(requests: RequestResult[]): Promise<string> {
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk: Buffer) => (text += chunk.toString()));
  await createCliReporter(out, { color: false, quiet: false, verbose: false }).onRunDone?.({
    startedAt: 's',
    requests,
    summary: {
      total: requests.length,
      passed: 2,
      failed: 1,
      errored: 1,
      skipped: 0,
      durationMs: 10,
      baselineUpdate: { updated: 1, created: 1, matched: 0, skipped: 1, refused: 1 },
    },
  });
  return text;
}

describe('baseline updates in reports', () => {
  it('cli: names what happened on the request line', () => {
    expect(cliText(updated)).toContain('baseline: updated');
    expect(cliText(created)).toContain('baseline: created');
    expect(cliText(skipped)).toContain('(baseline not written: failed)');
    expect(cliText(refused)).toContain('baseline not written — The response holds a secret value');
  });

  it('cli: sums the update and lists the written files', async () => {
    const text = await runText([updated, created, skipped, refused]);
    expect(text).toContain('baseline: 1 updated, 1 created, 0 matched, 1 not written, 1 refused\n');
    expect(text).toContain('written:\n  apis/demo/requests/ok.golden.yaml\n  apis/demo/requests/new.golden.yaml\n');
  });

  it('junit: notes the written file in system-out', () => {
    const xml = renderJunit({ startedAt: 's', requests: [updated], summary: ONE });
    expect(xml).toContain('<system-out>baseline updated: apis/demo/requests/ok.golden.yaml</system-out>');
  });

  it('html: shows the written file and what moved', () => {
    const html = renderHtml({ startedAt: 's', requests: [updated], summary: ONE }, TOOL);
    expect(html).toContain('Baseline updated: apis/demo/requests/ok.golden.yaml');
    expect(html).toContain('<td>/ok</td>');
  });

  it('json: carries the update fields as they are', () => {
    const report = toJsonReport({ startedAt: 's', requests: [updated], summary: ONE }, TOOL);
    expect(report.requests[0]?.baseline).toMatchObject({
      status: 'updated',
      file: 'apis/demo/requests/ok.golden.yaml',
    });
  });
});
