/**
 * The runner's `--update-baseline` decision (#217): whether one response replaces, creates or
 * leaves its golden, compared as `--baseline` compares. Pure; the run reads and writes the file.
 */

import type { AssertionResult, AssertionSubject } from '../assert/model.js';
import { diffSnapshot } from '../snapshot/diff.js';
import { detectSnapshotFormat } from '../snapshot/format.js';
import type { GoldenFile, GoldenRead, GoldenWrite } from '../snapshot/golden-file.js';
import { parseIgnoreRules } from '../snapshot/ignore.js';
import { BASELINE_REPORT_CHANGES, contentTypeOf, tooLarge } from './baseline.js';
import type { BaselineCheck, BaselineReason, BaselineReport } from './baseline.js';

export interface BaselineUpdateInput {
  readonly read: GoldenRead;
  readonly subject: AssertionSubject;
  /** The request's own assertions failed: nothing is written. */
  readonly failed: boolean;
  readonly containsKnownSecret?: (value: string) => boolean;
  readonly now: () => Date;
}

export type BaselineUpdatePlan =
  | { readonly kind: 'done'; readonly check: BaselineCheck }
  | { readonly kind: 'write'; readonly golden: GoldenFile; readonly report: BaselineReport };

/** What the sink answered; `failed` when it threw. */
export type SinkOutcome = GoldenWrite | { readonly status: 'failed'; readonly message: string };

type Refusal = Exclude<BaselineReason, 'failed' | 'not-text'>;

const REFUSED: Record<Refusal, string> = {
  secret: 'The response holds a secret value, so its baseline was not written.',
  malformed: 'The saved baseline cannot be read (malformed), so it was not replaced.',
  'not-a-file': 'The baseline file is not a regular file, so it was not replaced.',
  unsaved: 'The request file is not on disk, so no baseline was written.',
  'write-failed': 'The baseline could not be written',
};

function refused(reason: Refusal, detail?: string): BaselineCheck {
  const assertion: AssertionResult = {
    type: 'baseline',
    label: 'baseline not written',
    outcome: 'errored',
    message: detail === undefined ? REFUSED[reason] : `${REFUSED[reason]}: ${detail}`,
  };
  return { report: { status: 'refused', reason }, assertion };
}

const done = (check: BaselineCheck): BaselineUpdatePlan => ({ kind: 'done', check });

/** A NUL, or U+FFFD where the decoder met bytes that are not UTF-8: the Snapshot tab keeps no such body either. */
const isText = (body: string): boolean => !body.includes('\u0000') && !body.includes('�');

/**
 * Own assertions first, then the golden read, then the comparison. Only a golden about to be
 * written is checked for a secret and for text, so a matching golden is never refused.
 */
export function planBaselineUpdate(input: BaselineUpdateInput): BaselineUpdatePlan {
  const { read, subject } = input;
  if (input.failed) return done({ report: { status: 'skipped', reason: 'failed' } });
  if (read.status === 'unreadable') return done(refused(read.reason));
  const body = subject.bodyText;
  let report: BaselineReport;
  if (read.status === 'present') {
    const old = read.golden;
    if (tooLarge(old.body) || tooLarge(body)) {
      // No semantic diff past the limit (#36); exact text decides.
      if (old.body === body) return done({ report: { status: 'matched' } });
      report = { status: 'updated' };
    } else {
      // The same calls `--baseline` and the Snapshot tab make.
      const format = detectSnapshotFormat(old.body, old.contentType ?? contentTypeOf(subject));
      const diff = diffSnapshot(old.body, body, { format, ignore: parseIgnoreRules(old.ignore.join('\n')) });
      const shared = {
        format: diff.format,
        ignored: diff.ignored,
        ...(diff.error !== undefined ? { error: diff.error } : {}),
      };
      if (diff.changes.length === 0) return done({ report: { status: 'matched', ...shared } });
      report = {
        status: 'updated',
        ...shared,
        changes: diff.changes.slice(0, BASELINE_REPORT_CHANGES),
        ...(diff.changes.length > BASELINE_REPORT_CHANGES ? { truncated: true } : {}),
      };
    }
  } else {
    report = { status: 'created' };
  }
  if (input.containsKnownSecret?.(body) === true) return done(refused('secret'));
  if (!isText(body)) return done({ report: { status: 'skipped', reason: 'not-text' } });
  const contentType = contentTypeOf(subject);
  return {
    kind: 'write',
    report,
    golden: {
      ...(contentType !== undefined ? { contentType } : {}),
      savedAt: input.now().toISOString(),
      ignore: read.status === 'present' ? [...read.golden.ignore] : [],
      body,
    },
  };
}

/** The check for a planned write, once the sink has answered. */
export function finishBaselineUpdate(report: BaselineReport, outcome: SinkOutcome): BaselineCheck {
  if (outcome.status === 'written') {
    return {
      report: { ...report, file: outcome.file },
      assertion: { type: 'baseline', label: `baseline ${report.status}`, outcome: 'passed' },
    };
  }
  if (outcome.status === 'refused') return refused(outcome.reason);
  return refused('write-failed', outcome.message);
}
