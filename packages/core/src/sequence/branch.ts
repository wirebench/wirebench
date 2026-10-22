/**
 * Choosing a step's branch (#347): the first rule whose condition holds and whose `max` is not yet
 * reached. A condition reuses the step checks, so it means exactly what the same assertion would.
 */

import { evaluateAssertions } from '../assert/index.js';
import type { AssertionSubject } from '../assert/model.js';
import type { BranchCondition, BranchOutcome, BranchRule, SequenceStep } from './model.js';

/** What a step's branches decided, for its result. `to` is filled in by the run, which knows the steps. */
export interface BranchDecision {
  /** The rule's index in the step's `branches`. */
  readonly rule: number;
  readonly action: BranchRule['then'];
  /** How many times the rule has fired in this run, this one included; its max when `limitReached`. */
  readonly count: number;
  readonly max?: number;
  /** The rule matched, but had already fired `max` times: the run went on as if it had not. */
  readonly limitReached?: true;
}

/**
 * Whether `when` holds. A check that errors (a JSONPath over an XML body), or one with no response to
 * look at, does not hold, and `not` does not turn that into a match: a rule fires on what was seen.
 */
async function holds(
  when: BranchCondition,
  subject: AssertionSubject | undefined,
  outcome: BranchOutcome,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { not: _not, ...check } = when;
  const invert = when.not === true;
  if (check.type === 'outcome') {
    const wanted: readonly BranchOutcome[] = Array.isArray(check.equals) ? check.equals : [check.equals];
    return wanted.includes(outcome) !== invert;
  }
  if (subject === undefined) {
    return false;
  }
  const [result] = await evaluateAssertions(subject, [check]);
  if (result === undefined || result.outcome === 'errored') {
    return false;
  }
  return (result.outcome === 'passed') !== invert;
}

/**
 * The rule that fires for this run of `step`, counted in `fired` (keyed by step id and rule index), or
 * the first matching rule that was at its limit, or `undefined` when no rule matched.
 */
export async function chooseBranch(
  step: SequenceStep,
  subject: AssertionSubject | undefined,
  outcome: BranchOutcome,
  fired: Map<string, number>,
): Promise<BranchDecision | undefined> {
  let atLimit: BranchDecision | undefined;
  for (const [rule, branch] of (step.branches ?? []).entries()) {
    if (!(await holds(branch.when, subject, outcome))) {
      continue;
    }
    const key = `${step.id}#${rule}`;
    const count = fired.get(key) ?? 0;
    const max = branch.then === 'skip-next' ? undefined : branch.max;
    if (max !== undefined && count >= max) {
      atLimit ??= { rule, action: branch.then, count, max, limitReached: true };
      continue;
    }
    fired.set(key, count + 1);
    return { rule, action: branch.then, count: count + 1, ...(max !== undefined ? { max } : {}) };
  }
  return atLimit;
}

/** Resolves after `ms`, or at once when `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
