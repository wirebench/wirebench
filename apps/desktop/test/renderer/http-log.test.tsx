import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpLog } from '../../src/renderer/features/console/http-log.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useSecretsVisibilityStore } from '../../src/renderer/state/secrets-visibility.js';
import { b64, makeExchange } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('HttpLog', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, log: [] });
    useSecretsVisibilityStore.setState({ show: false });
    installWirebenchApi();
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

  it('breaks the selected exchange down into a timings bar with a total', async () => {
    useExchangesStore.setState({ log: [makeExchange()] });
    render(<HttpLog />);

    await userEvent.click(screen.getByRole('button', { name: /POST/ }));

    expect(screen.getByTestId('timings-total').textContent).toBe('total 143 ms');
    expect(screen.getByTestId('timings-legend').textContent).toContain('ttfb 100 ms');
    expect(screen.getByTestId('timings-legend').textContent).toContain('dns n/a');
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

  it('re-fetches the open detail through exchanges.get when show-secrets is toggled', async () => {
    const redacted = makeExchange({
      sendId: 'a',
      http: {
        ...makeExchange().http,
        rawRequestBase64: b64('POST /calc HTTP/1.1\r\nAuthorization: <redacted>\r\n\r\n<request/>'),
      },
    });
    const revealed = makeExchange({
      sendId: 'a',
      http: {
        ...makeExchange().http,
        rawRequestBase64: b64('POST /calc HTTP/1.1\r\nAuthorization: Basic YWxpY2U6\r\n\r\n<request/>'),
      },
    });
    const get = vi.fn().mockResolvedValue({ ok: true, value: redacted });
    installWirebenchApi({
      exchanges: { get },
      secrets: { setShowSecrets: vi.fn().mockResolvedValue({ ok: true, value: { show: true } }) },
    });
    useExchangesStore.setState({ log: [redacted] });

    render(<HttpLog />);
    await userEvent.click(screen.getAllByTestId('http-log-row')[0]!);
    expect(screen.getByLabelText('Raw request').textContent).toContain('Authorization: <redacted>');

    // Main re-redacts the cached exchange against the new flag; the log swaps in its answer.
    get.mockResolvedValue({ ok: true, value: revealed });
    await userEvent.click(screen.getByRole('button', { name: 'Show secrets' }));

    expect(get).toHaveBeenLastCalledWith({ sendId: 'a' });
    expect(screen.getByLabelText('Raw request').textContent).toContain('Authorization: Basic YWxpY2U6');
  });
});
