import { describe, expect, it } from 'vitest';
import { renderJson } from '../../../src/reporters/json.js';
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
});
