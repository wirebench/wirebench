/**
 * Each reporter shows the path a run's scripts took (#335): a request its script skipped, the request
 * the run went on at, and a run its script ended.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { RequestResult, RunResult } from '@wirebench/engine';
import { validateAgainstXsd } from '@wirebench/engine/test-helpers';
import { describe, expect, it } from 'vitest';
import { createCliReporter } from '../../../src/reporters/cli.js';
import { renderHtml } from '../../../src/reporters/html.js';
import { renderJson } from '../../../src/reporters/json.js';
import { renderJunit } from '../../../src/reporters/junit.js';
import { controlLine } from '../../../src/reporters/run-control.js';

const base = (name: string): Omit<RequestResult, 'outcome'> => ({
  path: `Shop/${name}`,
  group: 'Shop',
  name,
  protocol: 'rest',
  assertions: [],
  unasserted: true,
});

const RESULT: RunResult = {
  startedAt: '2026-10-11T10:00:00.000Z',
  summary: { total: 4, passed: 2, failed: 0, errored: 0, skipped: 2, durationMs: 100 },
  requests: [
    { ...base('Poll'), outcome: 'passed', status: 200, durationMs: 10, control: { next: 'Poll' } },
    { ...base('Gate'), outcome: 'skipped', control: { skipped: true } },
    { ...base('Done'), outcome: 'passed', status: 200, durationMs: 10, control: { next: null } },
    { ...base('After'), outcome: 'skipped' },
  ],
};

describe('controlLine', () => {
  it('names what the scripts asked for, and nothing when they asked for nothing', () => {
    expect(RESULT.requests.map(controlLine)).toEqual([
      '↳ next: "Poll"',
      '↳ skipped by its script',
      '↳ ended the run',
      undefined,
    ]);
  });

  it('names a jump from the script that skipped', () => {
    expect(controlLine({ ...base('A'), outcome: 'skipped', control: { skipped: true, next: 'C' } })).toBe(
      '↳ skipped by its script, next: "C"',
    );
  });
});

describe('the reporters', () => {
  it('cli prints the line under its request', () => {
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => (text += chunk.toString()));
    const reporter = createCliReporter(out, { color: false, quiet: false, verbose: false });
    for (const request of RESULT.requests) reporter.onRequestDone?.(request);
    expect(text).toBe(
      [
        '✓ Shop/Poll  200  10 ms  (no assertions)',
        '    ↳ next: "Poll"',
        '- Shop/Gate',
        '    ↳ skipped by its script',
        '✓ Shop/Done  200  10 ms  (no assertions)',
        '    ↳ ended the run',
        '- Shop/After',
        '',
      ].join('\n'),
    );
  });

  it('json carries control as the run reported it', () => {
    const parsed = JSON.parse(renderJson(RESULT, { name: 'wirebench', version: '0.0.0' })) as {
      requests: { control?: unknown }[];
    };
    expect(parsed.requests.map((r) => r.control)).toEqual([
      { next: 'Poll' },
      { skipped: true },
      { next: null },
      undefined,
    ]);
  });

  it('junit puts the line in system-out, and still validates', async () => {
    const xml = renderJunit(RESULT);
    expect(xml).toContain('<skipped/><system-out>↳ skipped by its script</system-out>');
    expect(xml).toContain('<system-out>↳ next: &quot;Poll&quot;</system-out>');
    const xsd = await readFile(join(import.meta.dirname, '..', '..', 'fixtures', 'junit.xsd'), 'utf8');
    expect((await validateAgainstXsd(xml, xsd)).errors).toEqual([]);
  });

  it('html shows the line, escaped', () => {
    const html = renderHtml(
      { ...RESULT, requests: [{ ...base('X'), outcome: 'passed', control: { next: '<b>x</b>' } }] },
      { name: 'wirebench', version: '0.0.0' },
    );
    expect(html).toContain('<p class="control">↳ next: &quot;&lt;b&gt;x&lt;/b&gt;&quot;</p>');
  });
});
