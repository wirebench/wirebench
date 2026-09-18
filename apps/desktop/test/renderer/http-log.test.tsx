import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpLog } from '../../src/renderer/features/console/http-log.js';
import { EMPTY_FILTER, useExchangesStore } from '../../src/renderer/state/exchanges.js';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import { useSecretsVisibilityStore } from '../../src/renderer/state/secrets-visibility.js';
import { b64, logExchange, makeExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { formatClockTime } from '../../src/renderer/lib/format-size.js';

const failure: LogEntry = { kind: 'failure', failure: makeFailure() };

function rows(): HTMLElement[] {
  return screen.getAllByTestId('http-log-row');
}

function logTab(name: string): HTMLElement {
  return within(screen.getByRole('tablist', { name: 'Log detail' })).getByRole('tab', { name });
}

describe('HttpLog', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [], filter: EMPTY_FILTER });
    useSecretsVisibilityStore.setState({ show: false });
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
  });

  it('invites a first send when the log is empty', () => {
    render(<HttpLog />);
    expect(screen.getByText(/Sent requests appear here/)).toBeDefined();
    expect(screen.queryByTestId('http-log-filter')).toBeNull();
  });

  it('renders one row per entry, newest last, with time · proto · method · URL · status · ms · size', () => {
    useExchangesStore.setState({
      log: [logExchange(makeExchange({ sendId: 'a' })), logExchange(makeRestExchange({ sendId: 'b', durationMs: 12 }))],
    });
    render(<HttpLog />);

    expect(rows()).toHaveLength(2);
    const first = rows()[0]!;
    const cells = [...first.querySelectorAll('span')].map((cell) => cell.textContent);
    // Clock time is local, so derive it rather than pin a timezone.
    expect(cells).toEqual([
      formatClockTime(makeExchange().http.timings.startedAt),
      'soap',
      'POST',
      'https://example.test/calc.asmx',
      '200',
      '143 ms',
      expect.stringMatching(/B$/),
    ]);
    expect(rows()[1]?.textContent).toContain('rest');
    expect(rows()[1]?.textContent).toContain('12 ms');
    const header = screen.getByTestId('http-log-header');
    expect(header.textContent).toBe(['time', 'proto', 'method', 'URL', 'status', 'ms', 'size'].join(''));
  });

  it('colours a failing status red', () => {
    const base = makeExchange();
    useExchangesStore.setState({
      log: [logExchange(makeExchange({ http: { ...base.http, status: 500, statusText: 'Internal Server Error' } }))],
    });
    render(<HttpLog />);

    expect(screen.getByTestId('http-log-status').className).toContain('text-status-danger');
    expect(screen.getByTestId('http-log-status').textContent).toBe('500');
  });

  it('renders a failure row: error code in the danger tone, duration to failure, empty size, message as title', () => {
    useExchangesStore.setState({ log: [failure] });
    render(<HttpLog />);

    const row = rows()[0]!;
    expect(row.getAttribute('data-kind')).toBe('failure');
    expect(row.getAttribute('title')).toBe('Connection refused.');
    const status = within(row).getByTestId('http-log-status');
    expect(status.textContent).toBe('connection-refused');
    expect(status.className).toContain('text-status-danger');
    expect(row.textContent).toContain('GET');
    expect(row.textContent).toContain('rest');
    expect(row.textContent).toContain('http://127.0.0.1:1/nope');
    expect(row.textContent).toContain('3.0 ms');
    const cells = [...row.querySelectorAll('span')];
    expect(cells.at(-1)?.textContent).toBe('');
  });

  it('opens the detail on click, on the Headers tab, and shows the raw bytes on Request/Response', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange())] });
    render(<HttpLog />);

    expect(screen.queryByTestId('log-detail')).toBeNull();
    await userEvent.click(rows()[0]!);

    expect(logTab('Headers').getAttribute('aria-selected')).toBe('true');
    await userEvent.click(logTab('Request'));
    expect(screen.getByLabelText('Raw request').textContent).toContain('POST /calc HTTP/1.1');
    await userEvent.click(logTab('Response'));
    expect(screen.getByLabelText('Raw response').textContent).toContain('<AddResult>7</AddResult>');
  });

  it('remembers the selected tab across row selections', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange({ sendId: 'a' })), failure] });
    render(<HttpLog />);

    await userEvent.click(rows()[0]!);
    await userEvent.click(logTab('Response'));
    await userEvent.click(rows()[1]!);

    expect(logTab('Response').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('log-detail-error').textContent).toContain('connection-refused');
  });

  it('breaks the selected exchange down into a timings bar with a total on the Timing tab', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange())] });
    render(<HttpLog />);

    await userEvent.click(rows()[0]!);
    await userEvent.click(logTab('Timing'));

    expect(screen.getByTestId('timings-total').textContent).toBe('total 143 ms');
    expect(screen.getByTestId('timings-legend').textContent).toContain('ttfb 100 ms');
    expect(screen.getByTestId('timings-legend').textContent).toContain('dns n/a');
  });

  it('summarises a binary payload by size instead of dumping bytes', async () => {
    const base = makeExchange();
    useExchangesStore.setState({
      log: [logExchange(makeExchange({ http: { ...base.http, rawResponseBase64: b64('\u0000\u0001\u0002\u0003') } }))],
    });
    render(<HttpLog />);

    await userEvent.click(rows()[0]!);
    await userEvent.click(logTab('Response'));
    expect(screen.getByLabelText('Raw response').textContent).toContain('<4 bytes>');
  });

  it('selects with ArrowDown/ArrowUp while the table has focus, clamped at the ends', async () => {
    useExchangesStore.setState({
      log: [logExchange(makeExchange({ sendId: 'a' })), logExchange(makeExchange({ sendId: 'b' })), failure],
    });
    render(<HttpLog />);

    const table = screen.getByLabelText('HTTP log');
    table.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(rows()[0]?.getAttribute('aria-pressed')).toBe('true');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(rows()[2]?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('log-detail')).toBeDefined();
    await userEvent.keyboard('{ArrowUp}');
    expect(rows()[1]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('empties the log on Clear', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange())] });
    render(<HttpLog />);

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(useExchangesStore.getState().log).toHaveLength(0);
    expect(screen.getByText(/Sent requests appear here/)).toBeDefined();
  });

  it('narrows the rows through the filter bar, counts n of m, and Reset restores them', async () => {
    const base = makeRestExchange();
    useExchangesStore.setState({
      log: [
        logExchange(makeExchange({ sendId: 'soap-ok' })),
        logExchange(makeRestExchange({ sendId: 'rest-404', http: { ...base.http, status: 404 } })),
        failure,
      ],
    });
    render(<HttpLog />);
    expect(screen.getByTestId('http-log-count').textContent).toBe('3 of 3');

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Protocol' })).getByRole('button', { name: 'REST' }),
    );
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId('http-log-count').textContent).toBe('2 of 3');

    await userEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: '4xx' }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('404');

    await userEvent.type(screen.getByLabelText('Filter URL'), 'nowhere');
    await waitFor(() => {
      expect(screen.getByText('No rows match the filter.')).toBeDefined();
    });
    expect(screen.getByTestId('http-log-count').textContent).toBe('0 of 3');

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    expect(screen.getByTestId('http-log-count').textContent).toBe('3 of 3');
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
    useExchangesStore.setState({ log: [logExchange(redacted)] });

    render(<HttpLog />);
    await userEvent.click(rows()[0]!);
    await userEvent.click(logTab('Request'));
    expect(screen.getByLabelText('Raw request').textContent).toContain('Authorization: <redacted>');

    // Main re-redacts the cached exchange against the new flag; the log swaps in its answer.
    get.mockResolvedValue({ ok: true, value: revealed });
    await userEvent.click(screen.getByRole('button', { name: 'Show secrets' }));

    expect(get).toHaveBeenLastCalledWith({ sendId: 'a' });
    expect(screen.getByLabelText('Raw request').textContent).toContain('Authorization: Basic YWxpY2U6');
  });

  it('shows a failure row redacted with the toggle on or off, and never asks main for it', async () => {
    const get = vi.fn().mockResolvedValue({ ok: false, error: { code: 'unknown-exchange', message: 'gone' } });
    installWirebenchApi({
      exchanges: { get },
      secrets: { setShowSecrets: vi.fn().mockResolvedValue({ ok: true, value: { show: true } }) },
    });
    useExchangesStore.setState({ log: [failure] });
    render(<HttpLog />);

    await userEvent.click(rows()[0]!);
    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('<redacted>');
    await userEvent.click(screen.getByRole('button', { name: 'Show secrets' }));

    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('<redacted>');
    expect(get).not.toHaveBeenCalled();
  });

  it('closes the detail when a filter hides the selected row, and reopens it when the filter is cleared', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange({ sendId: 'a' })), failure] });
    render(<HttpLog />);

    await userEvent.click(rows()[0]!);
    expect(screen.getByTestId('log-detail')).toBeDefined();

    act(() => {
      useExchangesStore.getState().setFilter({ protocols: ['rest'] });
    });
    expect(screen.queryByTestId('log-detail')).toBeNull();

    act(() => {
      useExchangesStore.getState().resetFilter();
    });
    expect(screen.getByTestId('log-detail')).toBeDefined();
  });

  it('opens the detail on the right of the table and closes it with × or Escape', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange({ sendId: 'a' }))] });
    render(<HttpLog />);

    await userEvent.click(screen.getAllByTestId('http-log-row')[0]!);
    const detail = screen.getByTestId('log-detail');
    expect(detail.className).toContain('border-l');
    expect(detail.previousElementSibling?.contains(screen.getByLabelText('HTTP log'))).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    expect(screen.queryByTestId('log-detail')).toBeNull();

    await userEvent.click(screen.getAllByTestId('http-log-row')[0]!);
    screen.getByLabelText('HTTP log').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('log-detail')).toBeNull();
  });

  it('puts the secrets toggle and Clear in the filter toolbar, not the column header', () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange({ sendId: 'a' }))] });
    render(<HttpLog />);

    const toolbar = screen.getByTestId('http-log-filter');
    expect(within(toolbar).getByRole('button', { name: 'Clear' })).toBeDefined();
    expect(within(toolbar).getByRole('button', { name: 'Show secrets' })).toBeDefined();
    const header = screen.getByTestId('http-log-header').parentElement!;
    expect(within(header).queryByRole('button')).toBeNull();
  });

  it('sheds the time, ms and size columns while a detail pane shares the width', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange({ sendId: 'a' }))] });
    render(<HttpLog />);

    const header = screen.getByTestId('http-log-header');
    expect(header.textContent).toBe(['time', 'proto', 'method', 'URL', 'status', 'ms', 'size'].join(''));

    await userEvent.click(rows()[0]!);
    expect(header.textContent).toBe(['proto', 'method', 'URL', 'status'].join(''));
    expect(rows()[0]?.textContent).not.toContain('143 ms');
    expect(screen.getByTestId('http-log-status').textContent).toBe('200');

    await userEvent.click(screen.getByRole('button', { name: 'Close detail' }));
    expect(header.textContent).toBe(['time', 'proto', 'method', 'URL', 'status', 'ms', 'size'].join(''));
  });
});

describe('HttpLog — prepare-stage failures', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [], filter: EMPTY_FILTER });
    useSecretsVisibilityStore.setState({ show: false });
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows a prepare failure as "Failed · before send" and says it never went on the wire', async () => {
    useExchangesStore.setState({
      log: [
        {
          kind: 'failure',
          failure: makeFailure({ stage: 'prepare', error: { code: 'invalid-url', message: 'Invalid URL' } }),
        },
      ],
    });
    render(<HttpLog />);
    expect(within(rows()[0]!).getByTestId('http-log-status').textContent).toBe('Failed · before send');
    await userEvent.click(rows()[0]!);
    await userEvent.click(logTab('Response'));
    expect(screen.getByTestId('log-detail-error').textContent).toMatch(/never went on the wire/);
    expect(screen.getByTestId('log-detail-error').textContent).toMatch(/invalid-url/);
  });
});
