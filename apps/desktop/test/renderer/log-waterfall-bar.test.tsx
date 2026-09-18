import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LogWaterfallBar } from '../../src/renderer/features/console/log-waterfall-bar.js';

describe('LogWaterfallBar', () => {
  afterEach(cleanup);

  it('draws positioned segments and a breakdown tooltip', () => {
    render(
      <LogWaterfallBar
        bar={{
          left: 0.25,
          width: 0.5,
          failed: false,
          ms: 25,
          segments: [
            { id: 'connect', left: 0, width: 0.4, className: 'bg-accent', ms: 10 },
            { id: 'wait', left: 0.4, width: 0.6, className: 'bg-status-warning', ms: 15 },
          ],
        }}
      />,
    );
    const bar = screen.getByTestId('waterfall-bar');
    expect(bar.style.left).toBe('25%');
    expect(bar.style.width).toBe('50%');
    expect(bar.getAttribute('title')).toBe('connect 10 ms · wait 15 ms');
    expect(screen.getAllByTestId('waterfall-segment').map((s) => s.dataset['phase'])).toEqual(['connect', 'wait']);
  });

  it('a failure is one danger bar', () => {
    render(<LogWaterfallBar bar={{ left: 0, width: 0.1, failed: true, ms: 3, segments: [] }} />);
    expect(screen.getByTestId('waterfall-bar').className).toMatch(/bg-status-danger/);
    expect(screen.getByTestId('waterfall-bar').getAttribute('title')).toBe('failed after 3 ms');
  });
});
