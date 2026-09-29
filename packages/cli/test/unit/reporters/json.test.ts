import type { RunResult } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { renderJson } from '../../../src/reporters/json.js';
import { maskRunResult } from '../../../src/reporters/mask.js';
import { SAMPLE_RESULT } from './sample-result.js';

const TOOL = { name: 'wirebench', version: '9.9.9' };

describe('renderJson', () => {
  const parsed = JSON.parse(renderJson(SAMPLE_RESULT, TOOL)) as Record<string, unknown>;

  it('parses, with exactly the top-level keys and formatVersion 1', () => {
    expect(Object.keys(parsed).sort()).toEqual(
      ['environment', 'formatVersion', 'requests', 'startedAt', 'summary', 'tool'].sort(),
    );
    expect(parsed['formatVersion']).toBe(1);
    expect(parsed['tool']).toEqual(TOOL);
    expect(parsed['startedAt']).toBe(SAMPLE_RESULT.startedAt);
    expect(parsed['environment']).toBe('local');
    expect(parsed['summary']).toEqual(SAMPLE_RESULT.summary);
  });

  it('gives each request the documented fields, absent optionals omitted rather than null', () => {
    const requests = parsed['requests'] as readonly Record<string, unknown>[];
    expect(requests).toHaveLength(4);

    const smoke = requests[0]!;
    expect(Object.keys(smoke).sort()).toEqual(
      ['assertions', 'durationMs', 'group', 'name', 'outcome', 'path', 'protocol', 'status', 'unasserted'].sort(),
    );
    expect(smoke['path']).toBe('Orders/PlaceOrder/Smoke');
    expect(smoke).not.toHaveProperty('error');
    expect(smoke).not.toHaveProperty('exchange');

    const bulk = requests[1]!;
    expect(bulk['outcome']).toBe('failed');
    expect(bulk).toHaveProperty('exchange');
    expect((bulk['exchange'] as Record<string, unknown>)['request']).toContain('<Envelope/>');

    const list = requests[2]!;
    expect(list['outcome']).toBe('errored');
    expect(list).toHaveProperty('error');
    expect(list).not.toHaveProperty('exchange');
    expect(list).not.toHaveProperty('status');
    expect(list).not.toHaveProperty('durationMs');

    const create = requests[3]!;
    expect(create['outcome']).toBe('skipped');
    expect(create['unasserted']).toBe(true);
    expect(create).not.toHaveProperty('error');
    expect(create).not.toHaveProperty('exchange');
  });

  it('keeps a matched callback’s capture through the mask', () => {
    const capture = { hookId: '01K000000000000000000000H1', captureId: '01K00000000000000000000002' };
    const result: RunResult = {
      startedAt: '2026-09-29T10:00:00.000Z',
      summary: { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 10 },
      requests: [
        {
          path: 'Shop/Pay',
          group: 'Shop',
          name: 'Pay',
          protocol: 'rest',
          outcome: 'passed',
          status: 201,
          durationMs: 5,
          assertions: [
            {
              type: 'callback',
              label: 'callback orders-hook',
              outcome: 'passed',
              message: 'matched capture 01K00000000000000000000002 after 2.0 s',
              capture,
            },
          ],
          unasserted: false,
        },
      ],
    };
    const masked = maskRunResult(result, (text) => text.split('orders-hook').join('***'));
    const report = JSON.parse(renderJson(masked, TOOL)) as {
      requests: { assertions: Record<string, unknown>[] }[];
    };
    expect(report.requests[0]?.assertions[0]).toEqual({
      type: 'callback',
      label: 'callback ***',
      outcome: 'passed',
      message: 'matched capture 01K00000000000000000000002 after 2.0 s',
      capture,
    });
  });
});
