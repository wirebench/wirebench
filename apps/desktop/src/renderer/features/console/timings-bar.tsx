import type { ExchangeSummary } from '../../../shared/wire-types.js';

type Timings = ExchangeSummary['http']['timings'];

/** The phases the transport reports, in the order they happen on the wire. */
export const PHASES = [
  { id: 'dns', key: 'dnsMs', className: 'bg-status-info' },
  { id: 'connect', key: 'connectMs', className: 'bg-accent' },
  { id: 'tls', key: 'tlsMs', className: 'bg-status-success' },
  { id: 'ttfb', key: 'ttfbMs', className: 'bg-status-warning' },
  { id: 'download', key: 'downloadMs', className: 'bg-accent-muted' },
] as const satisfies readonly { id: string; key: keyof Timings; className: string }[];

/** Milliseconds as whole numbers — sub-millisecond precision is noise at this scale. */
function ms(value: number): string {
  return `${String(Math.round(value))} ms`;
}

export interface TimingsBarProps {
  readonly timings: Timings;
}

/**
 * A proportional breakdown of one exchange's timings: a segment per phase the transport
 * managed to measure, sized by its share of the measured total, with a legend giving exact
 * milliseconds and `n/a` for the phases it could not measure (`dnsMs` always, and
 * `connectMs`/`tlsMs` whenever the exchange reused a keep-alive connection).
 *
 * Widths are shares of the *reported* phases rather than of `totalMs`: the engine's phases are
 * best-effort and can overlap (`tlsMs` is measured from the same start as `connectMs`), so the
 * bar shows relative weight, and the legend carries the numbers that are exact.
 */
export function TimingsBar({ timings }: TimingsBarProps) {
  const measured = PHASES.map((phase) => ({ ...phase, value: timings[phase.key] })).filter(
    (phase): phase is (typeof PHASES)[number] & { value: number } => phase.value !== undefined,
  );
  const sum = measured.reduce((total, phase) => total + phase.value, 0);

  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      <div
        role="img"
        aria-label={`Timings: ${measured.map((phase) => `${phase.id} ${ms(phase.value)}`).join(', ')}`}
        className="flex h-2 w-full overflow-hidden rounded-sm bg-surface-raised"
      >
        {sum > 0 &&
          measured.map((phase) => (
            <span
              key={phase.id}
              data-testid="timings-segment"
              data-phase={phase.id}
              className={phase.className}
              style={{ width: `${String((phase.value / sum) * 100)}%` }}
            />
          ))}
      </div>
      <p className="flex flex-wrap gap-x-3 font-mono text-xs text-fg-subtle">
        <span data-testid="timings-legend" className="flex flex-wrap gap-x-3">
          {PHASES.map((phase) => {
            const value = timings[phase.key];
            return (
              <span key={phase.id} data-phase={phase.id}>
                <span aria-hidden="true" className={`mr-1 inline-block size-2 rounded-sm ${phase.className}`} />
                {phase.id} {value === undefined ? 'n/a' : ms(value)}
              </span>
            );
          })}
        </span>
        <span data-testid="timings-total" className="text-fg-default">
          total {ms(timings.totalMs)}
        </span>
      </p>
    </div>
  );
}
