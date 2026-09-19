import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../../src/reporters/html.js';
import { SAMPLE_RESULT } from './sample-result.js';

const html = renderHtml(SAMPLE_RESULT, { name: 'wirebench', version: '0.0.0' });

describe('renderHtml', () => {
  it('is one offline document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\s(?:src|href)\s*=/i);
    expect(html).not.toMatch(/@import|url\(/i);
  });
  it('summarises the four counts', () => {
    for (const label of ['1 passed', '1 failed', '1 errored', '1 skipped']) {
      expect(html).toContain(label);
    }
  });
  it('opens failed and errored requests, and only those', () => {
    expect(html.match(/<details open/g)?.length).toBe(2);
    expect(html.match(/<details/g)?.length).toBe(4);
  });
  it('shows the exchange for failed and errored requests only', () => {
    expect(html.match(/<pre/g)?.length).toBe(SAMPLE_RESULT.requests.filter((r) => r.exchange !== undefined).length * 2);
  });
  it('escapes a hostile response body', () => {
    const hostile = {
      ...SAMPLE_RESULT,
      requests: SAMPLE_RESULT.requests.map((r) =>
        r.exchange === undefined ? r : { ...r, exchange: { ...r.exchange, response: '<script>alert(1)</script>' } },
      ),
    };
    expect(renderHtml(hostile, { name: 'wirebench', version: '0.0.0' })).not.toMatch(/<script/i);
  });
  it('supports a dark scheme', () => expect(html).toContain('prefers-color-scheme: dark'));
});
