/**
 * The comment lines a converted script gains: the header naming where it came from (spec §5.3) and
 * the TODO above each statement left as written (§5.2).
 */
import type { ScriptPhase } from '../model.js';

/** A call the converter did not rewrite, at its TODO line. */
export interface ConvertTodo {
  readonly phase: ScriptPhase;
  /** 1-based, in the converted file. */
  readonly line: number;
  /** As the layer names it, e.g. `pm.sendRequest`. */
  readonly call: string;
  /** `unsupported`: the layer refuses it; `not-mapped`: the layer runs it but no mapping exists yet; `shadowed`: a root the script declares. */
  readonly kind: 'unsupported' | 'not-mapped' | 'shadowed';
  readonly reason: string;
}

/** The reason for a call the layer runs and no mapping converts. */
export const NOT_CONVERTED = 'not converted yet';

/** The reason for a root the script declares itself, whose uses are left as written. */
export const shadowedReason = (root: string): string =>
  `the script declares its own ${root}, so its uses were not converted`;

/** One TODO comment, without indentation or line end. */
export const todoComment = (call: string, reason: string): string => `// TODO(convert): ${call} — ${reason}`;

/** The first line of a converted file: the dialect, and the backup of the original when there is one. */
export function headerComment(dialect: string, backup: string | undefined): string {
  const article = /^[aeiou]/i.test(dialect) ? 'an' : 'a';
  return backup === undefined
    ? `// Converted from ${article} ${dialect} script.`
    : `// Converted from ${article} ${dialect} script; the original is in ${backup}.`;
}
