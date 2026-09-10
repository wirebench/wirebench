import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResponseHeadersInspector } from '../../src/renderer/features/request-editor/inspectors/response-headers-inspector.js';
import { makeExchange } from '../mocks/exchange-fixtures.js';

function renderInspector(exchange?: ReturnType<typeof makeExchange>): void {
  render(<ResponseHeadersInspector exchange={exchange} />);
}

describe('ResponseHeadersInspector', () => {
  afterEach(() => {
    cleanup();
  });

  it('invites a send when nothing has been sent yet', () => {
    renderInspector(undefined);
    expect(screen.getByText(/No response yet/i)).toBeDefined();
  });

  it('lists the raw headers in order, keeping duplicates', () => {
    const base = makeExchange();
    renderInspector(
      makeExchange({
        http: {
          ...base.http,
          rawHeaders: [
            ['content-type', 'text/xml'],
            ['set-cookie', 'a=1'],
            ['set-cookie', 'b=2'],
          ],
        },
      }),
    );

    const rows = screen.getAllByTestId('response-header-row');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.textContent)).toEqual(['content-typetext/xml', 'set-cookiea=1', 'set-cookieb=2']);
  });

  it('copies the whole header block to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText } });
    const base = makeExchange();
    renderInspector(
      makeExchange({
        http: {
          ...base.http,
          rawHeaders: [
            ['content-type', 'text/xml'],
            ['x-b', '2'],
          ],
        },
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Copy response headers' }));

    expect(writeText).toHaveBeenCalledWith('content-type: text/xml\nx-b: 2');
  });
});
