import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_KINDS } from '../../src/renderer/features/assertions/assertion-table.js';
import { AssertionsTab, assertionsBadge } from '../../src/renderer/features/assertions/assertions-tab.js';
import { useProjectStore } from '../../src/renderer/state/project.js';

const setRequestAssertions = vi.fn<(requestId: string, assertions: unknown[]) => Promise<void>>();

afterEach(cleanup);

beforeEach(() => {
  setRequestAssertions.mockReset().mockResolvedValue(undefined);
  useProjectStore.setState({ setRequestAssertions } as never);
});

describe('AssertionsTab', () => {
  it('saves an added assertion through the store', async () => {
    render(<AssertionsTab requestId="ws-1" assertions={[]} kinds={REQUEST_KINDS} />);
    await act(() => {
      fireEvent.click(screen.getByTestId('request-add-assertion'));
      return Promise.resolve();
    });
    expect(setRequestAssertions).toHaveBeenCalledWith('ws-1', [{ type: 'status', equals: 200 }]);
  });

  it('shows a refused save under the table', async () => {
    setRequestAssertions.mockRejectedValue(new Error('The assertions are not valid: 0: bad regex'));
    render(<AssertionsTab requestId="ws-1" assertions={[]} kinds={REQUEST_KINDS} />);
    await act(() => {
      fireEvent.click(screen.getByTestId('request-add-assertion'));
      return Promise.resolve();
    });
    expect(screen.getByTestId('request-assertions-error').textContent).toContain('bad regex');
  });

  it('badges the count', () => {
    expect(assertionsBadge([])).toBeUndefined();
    expect(
      assertionsBadge([
        { type: 'status', equals: 200 },
        { type: 'sla', maxMs: 1 },
      ]),
    ).toBe('2');
  });
});
