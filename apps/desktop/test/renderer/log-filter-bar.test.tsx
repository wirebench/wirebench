import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogFilterBar } from '../../src/renderer/features/console/log-filter-bar.js';
import { EMPTY_FILTER, useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { logExchange, makeExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { logFilterItem, openLogFilters, toggleLogFilter } from '../helpers/log-filters.js';

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

  it('offers the methods present in the log, the status classes and the protocols in the Filters menu', async () => {
    render(<LogFilterBar shown={3} total={3} />);
    expect(screen.queryByRole('group', { name: 'Method' })).toBeNull();

    await openLogFilters();
    const labels = (group: string) =>
      within(screen.getByRole('group', { name: group }))
        .getAllByRole('menuitemcheckbox')
        .map((item) => item.textContent);
    expect(labels('Method')).toEqual(['GET', 'POST']);
    expect(labels('Status')).toEqual(['2xx', '3xx', '4xx', '5xx', 'failed']);
    expect(labels('Protocol')).toEqual(['SOAP', 'REST', 'gRPC', 'WS']);
    expect(screen.getByTestId('http-log-count').textContent).toBe('3 of 3');
  });

  it('filters to WebSocket handshakes with the WS choice', async () => {
    render(<LogFilterBar shown={3} total={3} />);
    await toggleLogFilter('Protocol', 'WS');
    expect(useExchangesStore.getState().filter.protocols).toEqual(['websocket']);
  });

  it('toggles a choice into and out of the filter, keeps the menu open, and counts what is on', async () => {
    render(<LogFilterBar shown={3} total={3} />);
    expect(screen.queryByTestId('http-log-filters-count')).toBeNull();

    await toggleLogFilter('Protocol', 'REST');
    expect(useExchangesStore.getState().filter.protocols).toEqual(['rest']);
    expect(logFilterItem('Protocol', 'REST').getAttribute('aria-checked')).toBe('true');

    await toggleLogFilter('Status', 'failed');
    await toggleLogFilter('Method', 'GET');
    expect(useExchangesStore.getState().filter).toEqual({
      text: '',
      regex: false,
      matchCase: false,
      methods: ['GET'],
      statuses: ['failed'],
      protocols: ['rest'],
    });
    expect(screen.getByTestId('http-log-filters-count').textContent).toBe('3');
    expect(screen.getByTestId('http-log-filters').getAttribute('aria-label')).toBe('Filters, 3 on');

    await toggleLogFilter('Protocol', 'REST');
    expect(useExchangesStore.getState().filter.protocols).toEqual([]);
    expect(logFilterItem('Protocol', 'REST').getAttribute('aria-checked')).toBe('false');
  });

  it('debounces the URL text into the filter', async () => {
    render(<LogFilterBar shown={3} total={3} />);

    await userEvent.type(screen.getByLabelText('Search the log'), 'pet');

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
    expect(screen.getByLabelText<HTMLInputElement>('Search the log').value).toBe('pet');

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(useExchangesStore.getState().filter).toEqual(EMPTY_FILTER);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Search the log').value).toBe('');
    });
  });

  it('the .* and Aa toggles set regex and matchCase; an invalid regex outlines the field', async () => {
    render(<LogFilterBar shown={1} total={1} />);
    await userEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await userEvent.click(screen.getByRole('button', { name: 'Match case' }));
    expect(useExchangesStore.getState().filter).toMatchObject({ regex: true, matchCase: true });
    await userEvent.type(screen.getByRole('searchbox'), '([[');
    await waitFor(() => {
      expect(screen.getByRole('searchbox').getAttribute('aria-invalid')).toBe('true');
    });
    expect(screen.getByRole('searchbox').className).toMatch(/border-status-danger/);
  });

  it('an invalid regex also shows an icon and says so in words, not by the red border alone (#803)', async () => {
    render(<LogFilterBar shown={1} total={1} />);
    expect(screen.queryByTestId('http-log-filter-invalid')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    await userEvent.type(screen.getByRole('searchbox'), '([[');
    const mark = await screen.findByTestId('http-log-filter-invalid');
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('searchbox', { description: 'Invalid pattern' })).toBeDefined();
    await userEvent.clear(screen.getByRole('searchbox'));
    await waitFor(() => {
      expect(screen.queryByTestId('http-log-filter-invalid')).toBeNull();
    });
    expect(screen.getByRole('searchbox').getAttribute('aria-describedby')).toBeNull();
  });
});
