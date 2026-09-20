/**
 * The pure geometry behind the HTTP Log's Waterfall column: each row's start offset and duration
 * as fractions of the span covered by the rows shown, and the phase segments inside its bar.
 *
 * Segments run connect → TLS → wait (time to first byte) → download, each sized by its share of
 * the measured phases, the same relative-weight rule `TimingsBar` uses. DNS is never drawn (the
 * transport never measures it), and a failure is one unsegmented bar.
 */

import type { LogEntry } from '../../state/exchanges.js';
import { durationOf, startedAtOf } from './log-filter.js';
import { PHASES } from './timings-bar.js';

export interface WaterfallSpan {
  readonly start: number;
  readonly end: number;
}

export interface WaterfallSegment {
  readonly id: 'connect' | 'tls' | 'wait' | 'download';
  /** Fractions of the bar. */
  readonly left: number;
  readonly width: number;
  readonly className: string;
  readonly ms: number;
}

export interface WaterfallBar {
  /** Fractions of the span. */
  readonly left: number;
  readonly width: number;
  readonly failed: boolean;
  readonly ms: number;
  readonly segments: readonly WaterfallSegment[];
}

/** A bar is never narrower than this, so a 0 ms row stays visible. */
export const MIN_BAR_FRACTION = 0.004;

const SEGMENT_PHASES = [
  { id: 'connect', phase: 'connect' },
  { id: 'tls', phase: 'tls' },
  { id: 'wait', phase: 'ttfb' },
  { id: 'download', phase: 'download' },
] as const;

function classOf(phase: (typeof SEGMENT_PHASES)[number]['phase']): (typeof PHASES)[number] {
  const found = PHASES.find((p) => p.id === phase);
  if (found === undefined) throw new Error(`no timing phase ${phase}`);
  return found;
}

/** The first start to the last end of `entries`, or undefined when there are none. */
export function spanOf(entries: readonly LogEntry[]): WaterfallSpan | undefined {
  if (entries.length === 0) return undefined;
  let start = Infinity;
  let end = -Infinity;
  for (const entry of entries) {
    const at = Date.parse(startedAtOf(entry));
    if (Number.isNaN(at)) continue;
    start = Math.min(start, at);
    end = Math.max(end, at + durationOf(entry));
  }
  if (!Number.isFinite(start)) return undefined;
  return { start, end: end === start ? start + 1 : end };
}

export function barOf(entry: LogEntry, span: WaterfallSpan): WaterfallBar {
  const total = span.end - span.start;
  const at = Date.parse(startedAtOf(entry));
  const ms = durationOf(entry);
  const left = Number.isNaN(at) ? 0 : Math.min(Math.max((at - span.start) / total, 0), 1);
  const width = Math.max(ms / total, MIN_BAR_FRACTION);
  if (entry.kind === 'failure') {
    return { left, width, failed: true, ms, segments: [] };
  }
  if ('protocol' in entry.exchange) {
    // A handshake row has no phase timings to break down; show it as a plain bar, not a failure.
    return { left, width, failed: false, ms, segments: [] };
  }

  const timings = entry.exchange.http.timings;
  const measured: { id: WaterfallSegment['id']; className: string; ms: number }[] = [];
  for (const { id, phase } of SEGMENT_PHASES) {
    const def = classOf(phase);
    const value = timings[def.key];
    if (value !== undefined) measured.push({ id, className: def.className, ms: value });
  }
  const sum = measured.reduce((acc, s) => acc + s.ms, 0);
  const segments: WaterfallSegment[] = [];
  if (sum > 0) {
    let offset = 0;
    for (const s of measured) {
      const w = s.ms / sum;
      segments.push({ id: s.id, left: offset, width: w, className: s.className, ms: s.ms });
      offset += w;
    }
  }
  return { left, width, failed: false, ms, segments };
}
