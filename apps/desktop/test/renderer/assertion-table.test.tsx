import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { AssertionTable, REQUEST_KINDS } from '../../src/renderer/features/assertions/assertion-table.js';
import type { RequestAssertionWire } from '../../src/shared/wire-types.js';

afterEach(cleanup);

describe('AssertionTable', () => {
  it('offers only the kinds it is given, under its own test ids', () => {
    const onChange = vi.fn();
    render(
      <TooltipPrimitive.Provider>
        <AssertionTable<RequestAssertionWire>
          assertions={[{ type: 'status', equals: 101 }]}
          onChange={onChange}
          kinds={REQUEST_KINDS}
          testIdPrefix="request"
          emptyText="No assertions."
        />
      </TooltipPrimitive.Provider>,
    );
    const kind = within(screen.getByTestId('request-assertion-row')).getByTestId('request-assertion-kind');
    const offered = [...kind.querySelectorAll('option')].map((option) => option.getAttribute('value'));
    expect(offered).toEqual(['status', 'match', 'sla', 'callback']);
    fireEvent.click(screen.getByTestId('request-add-assertion'));
    expect(onChange).toHaveBeenCalledWith([
      { type: 'status', equals: 101 },
      { type: 'status', equals: 200 },
    ]);
  });

  it('says its empty text when there are none', () => {
    render(
      <TooltipPrimitive.Provider>
        <AssertionTable assertions={[]} onChange={() => undefined} testIdPrefix="request" emptyText="No assertions." />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.getByTestId('request-assertions').textContent).toContain('No assertions.');
  });
});
