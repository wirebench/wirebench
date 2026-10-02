import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssertionResults, assertionResultsBadge } from '../../src/renderer/features/assertions/assertion-results.js';
import type { RequestAssertionResultWire } from '../../src/shared/wire-types.js';

afterEach(cleanup);

const RESULTS: RequestAssertionResultWire[] = [
  { type: 'status', label: 'status 101', outcome: 'passed' },
  { type: 'match', label: '$[0].type', outcome: 'failed', expected: 'gone', actual: 'ready' },
  { type: 'callback', label: 'callback orders', outcome: 'not-checked', message: 'checked in runs' },
];

describe('AssertionResults', () => {
  it('badges passed of checked, failing when any failed or errored', () => {
    expect(assertionResultsBadge(RESULTS)).toEqual({ text: '1/2', failed: true });
    expect(assertionResultsBadge(RESULTS.slice(0, 1))).toEqual({ text: '1/1', failed: false });
    expect(assertionResultsBadge(undefined)).toBeUndefined();
  });

  it('lists each with its outcome and details', () => {
    render(<AssertionResults assertions={RESULTS} />);
    const rows = screen.getAllByTestId('assertion-result');
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain('expected gone');
    expect(rows[1]?.textContent).toContain('actual ready');
    expect(rows[2]?.textContent).toContain('checked in runs');
  });

  it('says so when the request has none', () => {
    render(<AssertionResults assertions={undefined} />);
    expect(screen.getByTestId('assertion-results-empty').textContent).toContain('No assertions');
  });
});
