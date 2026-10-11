import type { RequestResult } from '@wirebench/engine';

/**
 * The path a sequence step took (#347), in one line: `→ repeat (2 of 10)`, `→ 4. Fallback (1 of 1)`,
 * `→ skip next`, or `limit reached: repeat 10 of 10`. Undefined for a step whose branches did nothing.
 */
export function branchText(result: RequestResult): string | undefined {
  const branch = result.branch;
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
