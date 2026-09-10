import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusBar } from '../../src/renderer/shell/status-bar.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { makeExchange } from '../mocks/exchange-fixtures.js';

describe('StatusBar', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'wirebench', {
      configurable: true,
      value: { app: { version: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } }) } },
    });
    useExchangesStore.setState({ byRequest: {}, log: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('says nothing has been sent yet', () => {
    render(<StatusBar />);
    expect(screen.getByText('no requests sent')).toBeDefined();
  });

  it('summarises the last exchange', () => {
    useExchangesStore.setState({ log: [makeExchange()] });
    render(<StatusBar />);

    const summary = screen.getByTestId('status-bar').textContent ?? '';
    expect(summary).toContain('last:');
    expect(summary).toContain('200');
    expect(summary).toContain('143 ms');
  });

  it('colours a failing last exchange red', () => {
    const base = makeExchange();
    useExchangesStore.setState({
      log: [makeExchange({ http: { ...base.http, status: 503, statusText: 'Unavailable' } })],
    });
    render(<StatusBar />);

    expect(screen.getByText('503').className).toContain('text-status-danger');
  });
});
