/**
 * Overview's setup list (team overview landing): what a team admin of a new team still has to do. Pure, so when
 * the list shows and which steps are done are tested without a page.
 */

export type SetupStepId = 'name' | 'people' | 'workspace';

export interface SetupStep {
  readonly id: SetupStepId;
  readonly done: boolean;
}

export interface TeamCounts {
  readonly members: number;
  /** Open invitations; the server lists them to team admins only. */
  readonly invitations: number;
  readonly workspaces: number;
}

/**
 * The three steps, or `undefined` once the team has a second person (joined or invited) and a workspace. The
 * name is done from the start: a team cannot be made without one.
 */
export function setupSteps(counts: TeamCounts): readonly SetupStep[] | undefined {
  const people = counts.members > 1 || counts.invitations > 0;
  const workspace = counts.workspaces > 0;
  if (people && workspace) return undefined;
  return [
    { id: 'name', done: true },
    { id: 'people', done: people },
    { id: 'workspace', done: workspace },
  ];
}

/** `3 joined · 1 waiting`, or `3 joined` when nothing is waiting. */
export function peopleDetail(counts: TeamCounts): string {
  const joined = `${String(counts.members)} joined`;
  return counts.invitations > 0 ? `${joined} · ${String(counts.invitations)} waiting` : joined;
}

/** `today`, or the date in the reader's locale. */
export function createdLabel(createdAt: string, now: Date): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return '';
  if (created.toDateString() === now.toDateString()) return 'today';
  return created.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
