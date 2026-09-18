import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogFilterBar } from '../../src/renderer/features/console/log-filter-bar.js';
import { EMPTY_FILTER, useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { logExchange, makeExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('LogFilterBar', () => {
  beforeEach(() => {
    installWirebenchApi();
    useExchangesStore.setState({
      byRequest: {},
      restByRequest: {},
      filter: EMPTY_FILTER,
      log: [logExchange(makeExchange()), logExchange(makeRestExchange()), { kind: 'failure', failure: makeFailure() }],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('offers the methods present in the log, the status classes and the protocols as chips', () => {
    render(<LogFilterBar shown={3} total={3} />);

    const method = screen.getByRole('group', { name: 'Method' });
    expect(
      within(method)
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual(['GET', 'POST']);
    const status = screen.getByRole('group', { name: 'Status' });
    expect(
      within(status)
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual(['2xx', '3xx', '4xx', '5xx', 'failed']);
    const protocol = screen.getByRole('group', { name: 'Protocol' });
    expect(
      within(protocol)
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual(['SOAP', 'REST', 'gRPC']);
    expect(screen.getByTestId('http-log-count').textContent).toBe('3 of 3');
  });

  it('toggles a chip into and out of the filter and reflects it as aria-pressed', async () => {
    render(<LogFilterBar shown={3} total={3} />);
    const rest = within(screen.getByRole('group', { name: 'Protocol' })).getByRole('button', { name: 'REST' });

    await userEvent.click(rest);
    expect(useExchangesStore.getState().filter.protocols).toEqual(['rest']);
    expect(rest.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'failed' }),
    );
    await userEvent.click(within(screen.getByRole('group', { name: 'Method' })).getByRole('button', { name: 'GET' }));
    expect(useExchangesStore.getState().filter).toEqual({
      text: '',
      regex: false,
      matchCase: false,
      methods: ['GET'],
      statuses: ['failed'],
      protocols: ['rest'],
    });

    await userEvent.click(rest);
    expect(useExchangesStore.getState().filter.protocols).toEqual([]);
    expect(rest.getAttribute('aria-pressed')).toBe('false');
  });

  it('debounces the URL text into the filter', async () => {
    render(<LogFilterBar shown={3} total={3} />);

    await userEvent.type(screen.getByLabelText('Filter URL'), 'pet');

    expect(useExchangesStore.getState().filter.text).toBe('');
    await waitFor(() => {
      expect(useExchangesStore.getState().filter.text).toBe('pet');
    });
  });

  it('Reset clears the whole filter, including the text field', async () => {
    useExchangesStore.setState({
      filter: { text: 'pet', regex: false, matchCase: false, methods: ['GET'], statuses: ['4xx'], protocols: ['rest'] },
    });
    render(<LogFilterBar shown={0} total={3} />);
    expect(screen.getByLabelText<HTMLInputElement>('Filter URL').value).toBe('pet');

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(useExchangesStore.getState().filter).toEqual(EMPTY_FILTER);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Filter URL').value).toBe('');
    });
  });
});
