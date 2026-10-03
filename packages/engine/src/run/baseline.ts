/**
 * The runner's `--baseline` check (#36): one response against the golden saved beside its request,
 * compared as the desktop's Snapshot tab compares them. Pure; the run reads the golden.
 */

import type { AssertionResult, AssertionSubject } from '../assert/model.js';
import { diffSnapshot } from '../snapshot/diff.js';
import type { SnapshotChange, SnapshotFormat } from '../snapshot/diff.js';
import { detectSnapshotFormat } from '../snapshot/format.js';
import type { GoldenRead } from '../snapshot/golden-file.js';
import { parseIgnoreRules } from '../snapshot/ignore.js';

/** Past this many UTF-8 bytes on either side, no semantic diff is attempted (as the Snapshot tab). */
export const BASELINE_MAX_BYTES = 2 * 1024 * 1024;
/** Changes kept in a result's `baseline.changes`. */
export const BASELINE_REPORT_CHANGES = 100;
/** Changes listed in the failed assertion's message. */
export const BASELINE_MESSAGE_CHANGES = 20;
/** The protocols a golden can be saved for. */
export const BASELINE_PROTOCOLS: ReadonlySet<string> = new Set(['soap', 'rest']);

export type BaselineStatus = 'matched' | 'differs' | 'missing' | 'unreadable' | 'too-large' | 'unsupported';

export interface BaselineReport {
  readonly status: BaselineStatus;
  readonly format?: SnapshotFormat;
  readonly changes?: readonly SnapshotChange[];
  readonly ignored?: number;
  readonly truncated?: boolean;
  readonly error?: string;
}

export interface BaselineCheck {
  readonly report: BaselineReport;
  readonly assertion?: AssertionResult;
  /** Set only for a missing golden under `require`: the request errors with it. */
  readonly error?: { readonly code: 'baseline-missing'; readonly message: string };
}

const encoder = new TextEncoder();

function tooLarge(text: string): boolean {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so only a borderline string needs encoding.
  if (text.length > BASELINE_MAX_BYTES) return true;
  return text.length * 3 > BASELINE_MAX_BYTES && encoder.encode(text).length > BASELINE_MAX_BYTES;
}

function contentTypeOf(subject: AssertionSubject): string | undefined {
  return subject.headers?.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

function changeLine(change: SnapshotChange): string {
  if (change.kind === 'added') return `added ${change.path}: ${change.actual ?? ''}`;
  if (change.kind === 'removed') return `removed ${change.path}: ${change.expected ?? ''}`;
  return `changed ${change.path}: ${change.expected ?? ''} → ${change.actual ?? ''}`;
}

const errored = (status: BaselineStatus, message: string): BaselineCheck => ({
  report: { status },
  assertion: { type: 'baseline', label: 'baseline', outcome: 'errored', message },
});

/** One response against the golden read for its request; `require` makes a missing golden an error. */
export function checkBaseline(golden: GoldenRead, subject: AssertionSubject, require: boolean): BaselineCheck {
  if (golden.status === 'none') {
    return require
      ? {
          report: { status: 'missing' },
          error: { code: 'baseline-missing', message: 'No baseline is saved for this request.' },
        }
      : { report: { status: 'missing' } };
  }
  if (golden.status === 'unreadable') {
    return errored('unreadable', `The saved baseline cannot be read (${golden.reason}).`);
  }
  const { body, contentType, ignore } = golden.golden;
  if (tooLarge(body) || tooLarge(subject.bodyText)) {
    return errored('too-large', 'Too large to compare semantically.');
  }
  // The same calls the Snapshot tab makes, so CI and the app agree.
  const format = detectSnapshotFormat(body, contentType ?? contentTypeOf(subject));
  const diff = diffSnapshot(body, subject.bodyText, { format, ignore: parseIgnoreRules(ignore.join('\n')) });
  const shared = {
    format: diff.format,
    ignored: diff.ignored,
    ...(diff.error !== undefined ? { error: diff.error } : {}),
  };
  if (diff.changes.length === 0) {
    return {
      report: { status: 'matched', ...shared },
      assertion: {
        type: 'baseline',
        label: diff.ignored > 0 ? `matches the baseline (${diff.ignored} ignored)` : 'matches the baseline',
        outcome: 'passed',
      },
    };
  }
  const count = diff.changes.length;
  const lines = diff.changes.slice(0, BASELINE_MESSAGE_CHANGES).map(changeLine);
  if (count > BASELINE_MESSAGE_CHANGES) lines.push(`… and ${count - BASELINE_MESSAGE_CHANGES} more`);
  // Every reporter prints the message, so the fallback note reaches them all (and the masker).
  if (diff.error !== undefined) lines.unshift(`compared as text: ${diff.error}`);
  return {
    report: {
      status: 'differs',
      ...shared,
      changes: diff.changes.slice(0, BASELINE_REPORT_CHANGES),
      ...(count > BASELINE_REPORT_CHANGES ? { truncated: true } : {}),
    },
    assertion: {
      type: 'baseline',
      label: `${count} ${count === 1 ? 'difference' : 'differences'} from the baseline`,
      outcome: 'failed',
      message: lines.join('\n'),
    },
  };
}
