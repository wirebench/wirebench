import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StatusBar } from '../../src/renderer/shell/status-bar.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { makeExchange } from '../mocks/exchange-fixtures.js';

describe('StatusBar', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'wirebench', {
      configurable: true,
      value: { app: { version: vi.fn().mockResolvedValue({ ok: false, error: { code: 'x', message: 'x' } }) } },
    });
    useExchangesStore.setState({ byRequest: {}, log: [] });
    useProblemsStore.setState({ items: [] });
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
  it('counts the problems and opens the Problems panel when clicked', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'validation:req-1:request',
          source: 'validation',
          severity: 'error',
          requestId: 'req-1',
          problem: { code: 'schema-invalid', message: 'bad', source: 'schema', line: 2 },
        },
      ],
    });
    render(<StatusBar />);

    const button = screen.getByTestId('status-bar-problems');
    expect(button.textContent).toBe('1 problem');
    fireEvent.click(button);
    expect(useUiStore.getState().console.activeTab).toBe('problems');
    expect(useUiStore.getState().console.visible).toBe(true);
  });

  it('pluralises an empty problem count', () => {
    render(<StatusBar />);
    expect(screen.getByTestId('status-bar-problems').textContent).toBe('0 problems');
  });

  it('colours the problems button danger only when there is at least one error', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'validation:req-1:request',
          source: 'validation',
          severity: 'warning',
          requestId: 'req-1',
          problem: { code: 'content-type-mismatch', message: 'meh', source: 'structure' },
        },
      ],
    });
    render(<StatusBar />);

    const button = screen.getByTestId('status-bar-problems');
    expect(button.className).not.toContain('text-status-danger');
    expect(button.className).toContain('text-status-warning');
  });

  it('colours the problems button danger when at least one problem is an error', () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'validation:req-1:request',
          source: 'validation',
          severity: 'warning',
          requestId: 'req-1',
          problem: { code: 'content-type-mismatch', message: 'meh', source: 'structure' },
        },
        {
          groupId: 'validation:req-1:request',
          source: 'validation',
          severity: 'error',
          requestId: 'req-1',
          problem: { code: 'schema-invalid', message: 'bad', source: 'schema' },
        },
      ],
    });
    render(<StatusBar />);

    expect(screen.getByTestId('status-bar-problems').className).toContain('text-status-danger');
  });
});
