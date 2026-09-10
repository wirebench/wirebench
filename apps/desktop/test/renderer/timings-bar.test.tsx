import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TimingsBar } from '../../src/renderer/features/console/timings-bar.js';

describe('TimingsBar', () => {
  afterEach(() => {
    cleanup();
  });

  it('sizes each segment by its share of the reported phases', () => {
    render(
      <TimingsBar
        timings={{ startedAt: '2026-09-10T08:30:05.000Z', totalMs: 100, connectMs: 20, ttfbMs: 60, downloadMs: 20 }}
      />,
    );

    const segments = screen.getAllByTestId('timings-segment');
    expect(segments.map((segment) => segment.getAttribute('data-phase'))).toEqual(['connect', 'ttfb', 'download']);
    expect(segments.map((segment) => segment.style.width)).toEqual(['20%', '60%', '20%']);
  });

  it('reports phases the transport could not measure as n/a', () => {
    render(<TimingsBar timings={{ startedAt: '2026-09-10T08:30:05.000Z', totalMs: 42, ttfbMs: 40, downloadMs: 2 }} />);

    const legend = screen.getByTestId('timings-legend').textContent ?? '';
    expect(legend).toContain('dns n/a');
    expect(legend).toContain('connect n/a');
    expect(legend).toContain('tls n/a');
    expect(legend).toContain('ttfb 40 ms');
    expect(legend).toContain('download 2 ms');
  });

  it('ends with the total', () => {
    render(<TimingsBar timings={{ startedAt: '2026-09-10T08:30:05.000Z', totalMs: 143.6, ttfbMs: 100 }} />);
    expect(screen.getByTestId('timings-total').textContent).toBe('total 144 ms');
  });

  it('renders no segments at all when only the total is known', () => {
    render(<TimingsBar timings={{ startedAt: '2026-09-10T08:30:05.000Z', totalMs: 5 }} />);
    expect(screen.queryAllByTestId('timings-segment')).toHaveLength(0);
    expect(screen.getByTestId('timings-total').textContent).toBe('total 5 ms');
  });
});
