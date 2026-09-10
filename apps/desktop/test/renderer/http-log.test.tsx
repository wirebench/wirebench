import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpLog } from '../../src/renderer/features/console/http-log.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { b64, makeExchange } from '../mocks/exchange-fixtures.js';

describe('HttpLog', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, log: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('invites a first send when the log is empty', () => {
    render(<HttpLog />);
    expect(screen.getByText(/Sent requests appear here/)).toBeDefined();
  });

  it('renders one row per exchange, newest last', () => {
    useExchangesStore.setState({
      log: [makeExchange({ sendId: 'a' }), makeExchange({ sendId: 'b', durationMs: 12 })],
    });
    render(<HttpLog />);

    const rows = screen.getAllByRole('button').filter((button) => button.textContent?.includes('POST') === true);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('143 ms');
    expect(rows[1]?.textContent).toContain('12 ms');
    expect(rows[0]?.textContent).toContain('https://example.test/calc.asmx');
  });

  it('colours a failing status red', () => {
    const base = makeExchange();
    useExchangesStore.setState({
      log: [makeExchange({ http: { ...base.http, status: 500, statusText: 'Internal Server Error' } })],
    });
    render(<HttpLog />);

    expect(screen.getByText('500').className).toContain('text-status-danger');
  });

  it('shows the raw request and response of the row that is clicked', async () => {
    useExchangesStore.setState({ log: [makeExchange()] });
    render(<HttpLog />);

    expect(screen.queryByLabelText('Raw request')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /POST/ }));

    expect(screen.getByLabelText('Raw request').textContent).toContain('POST /calc HTTP/1.1');
    expect(screen.getByLabelText('Raw response').textContent).toContain('<AddResult>7</AddResult>');
  });

  it('summarises a binary payload by size instead of dumping bytes', async () => {
    const base = makeExchange();
    useExchangesStore.setState({
      log: [makeExchange({ http: { ...base.http, rawResponseBase64: b64('\u0000\u0001\u0002\u0003') } })],
    });
    render(<HttpLog />);

    await userEvent.click(screen.getByRole('button', { name: /POST/ }));
    expect(screen.getByLabelText('Raw response').textContent).toContain('<4 bytes>');
  });

  it('empties the log on Clear', async () => {
    useExchangesStore.setState({ log: [makeExchange()] });
    render(<HttpLog />);

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(useExchangesStore.getState().log).toHaveLength(0);
    expect(screen.getByText(/Sent requests appear here/)).toBeDefined();
  });
});
