/**
 * The path a step's branches took (#347), in the words the CLI report uses: `→ repeat (2 of 10)`,
 * `→ 4. Fallback (1 of 1)`, `→ skip next`, or `limit reached: repeat 10 of 10`.
 */
import type { SequenceStepResultWire } from '@shared/wire-base.js';

/** One line for the step's branch, or `undefined` when its branches did nothing. */
export function branchText(step: SequenceStepResultWire): string | undefined {
  const branch = step.branch;
  if (branch === undefined) {
    return undefined;
  }
  if (branch.limitReached === true) {
    const what = branch.action === 'goto' && branch.to !== undefined ? `go to ${branch.to.index + 1}` : branch.action;
    return `limit reached: ${what} ${branch.count} of ${branch.max ?? branch.count}`;
  }
  const of = branch.max !== undefined ? ` (${branch.count} of ${branch.max})` : '';
  switch (branch.action) {
    case 'repeat':
      return `→ repeat${of}`;
    case 'skip-next':
      return '→ skip next';
    case 'goto':
      return `→ ${branch.to !== undefined ? `${branch.to.index + 1}. ${branch.to.name}` : 'go to'}${of}`;
  }
}
