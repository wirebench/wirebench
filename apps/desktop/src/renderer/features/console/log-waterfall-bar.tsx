import type { WaterfallBar } from './log-waterfall.js';

function pct(fraction: number): string {
  return `${String(fraction * 100)}%`;
}

function ms(value: number): string {
  return `${String(Math.round(value))} ms`;
}

/** The hover text: each measured phase with its milliseconds, or how long a failure took. */
function breakdownOf(bar: WaterfallBar): string {
  if (bar.failed) return `failed after ${ms(bar.ms)}`;
  if (bar.segments.length === 0) return `total ${ms(bar.ms)}`;
  return bar.segments.map((segment) => `${segment.id} ${ms(segment.ms)}`).join(' · ');
}

/**
 * One row's cell in the Waterfall column: a bar placed by its start offset and duration across
 * the rows shown, split into its phases, with the breakdown in the native tooltip. Spans rather
 * than divs, since the cell sits inside the row's button.
 */
export function LogWaterfallBar({ bar }: { readonly bar: WaterfallBar }) {
  return (
    <span className="relative block h-2 w-full overflow-hidden">
      <span
        data-testid="waterfall-bar"
        title={breakdownOf(bar)}
        className={`absolute top-0 flex h-full overflow-hidden rounded-sm ${
          bar.failed ? 'bg-status-danger' : 'bg-surface-raised'
        }`}
        style={{ left: pct(bar.left), width: pct(bar.width) }}
      >
        {bar.segments.map((segment) => (
          <span
            key={segment.id}
            data-testid="waterfall-segment"
            data-phase={segment.id}
            className={`absolute top-0 h-full ${segment.className}`}
            style={{ left: pct(segment.left), width: pct(segment.width) }}
          />
        ))}
      </span>
    </span>
  );
}
