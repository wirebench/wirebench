/**
 * The environment picker's state, pure: which environments are ticked for a multi-environment
 * send and which of them is the baseline the others are compared against.
 */

/** What the picker lists: an environment's id and the name it shows. */
export interface PickerEnvironment {
  readonly id: string;
  readonly name: string;
}

export interface EnvSelection {
  /** Ticked environment ids, in the order the project lists them (or as remembered). */
  readonly ticked: readonly string[];
  /** The environment the others are diffed against; `''` when nothing is ticked. */
  readonly baseline: string;
}

/**
 * The baseline for `ticked`: `preferred` while it is ticked, else the active environment when
 * ticked, else the first ticked; `''` when nothing is.
 */
export function pickBaseline(
  ticked: readonly string[],
  preferred: string | undefined,
  activeId: string | undefined,
): string {
  if (preferred !== undefined && ticked.includes(preferred)) {
    return preferred;
  }
  if (activeId !== undefined && ticked.includes(activeId)) {
    return activeId;
  }
  return ticked[0] ?? '';
}

/**
 * The picker's opening state: the selection remembered for this request (minus environments the
 * project no longer has), or else the active environment ticked and made the baseline.
 */
export function initialSelection(
  envs: readonly PickerEnvironment[],
  activeId: string | undefined,
  remembered?: EnvSelection,
): EnvSelection {
  const known = new Set(envs.map((env) => env.id));
  const ticked =
    remembered !== undefined
      ? remembered.ticked.filter((id) => known.has(id))
      : activeId !== undefined && known.has(activeId)
        ? [activeId]
        : [];
  return { ticked, baseline: pickBaseline(ticked, remembered?.baseline, activeId) };
}

/** Send is allowed with two or more environments ticked and the baseline among them. */
export function canSend(selection: EnvSelection): boolean {
  return selection.ticked.length >= 2 && selection.ticked.includes(selection.baseline);
}
