/**
 * Toasts: each one gets an id, so a caller whose message stopped being true can take it down before
 * its time (#632).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { dismissToast, showToast, ToastViewport } from '../../src/renderer/components/toast.js';

afterEach(() => {
  act(() => {
    vi.runOnlyPendingTimers();
  });
  vi.useRealTimers();
  cleanup();
});

describe('toasts', () => {
  it('takes down the one toast whose id is dismissed', () => {
    vi.useFakeTimers();
    render(<ToastViewport />);

    let first = 0;
    act(() => {
      first = showToast('Method changed to POST', { label: 'Undo', onClick: () => undefined });
      showToast('Saved');
    });
    expect(screen.getByTestId('toast-viewport').textContent).toContain('Method changed to POST');

    act(() => {
      dismissToast(first);
    });

    const text = screen.getByTestId('toast-viewport').textContent;
    expect(text).not.toContain('Method changed to POST');
    expect(text).toContain('Saved');
  });

  it('gives every toast its own id and ignores one already gone', () => {
    vi.useFakeTimers();
    render(<ToastViewport />);

    let ids: number[] = [];
    act(() => {
      ids = [showToast('One'), showToast('Two')];
    });
    expect(ids[0]).not.toBe(ids[1]);

    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(screen.getByTestId('toast-viewport').textContent).toBe('');
    expect(() => {
      dismissToast(ids[0] ?? 0);
    }).not.toThrow();
  });
});
