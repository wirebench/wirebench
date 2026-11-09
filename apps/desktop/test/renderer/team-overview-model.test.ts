import { describe, expect, it } from 'vitest';
import { createdLabel, peopleDetail, setupSteps } from '../../src/renderer/features/team/settings/overview.js';

describe('Overview’s setup list and labels (team overview landing)', () => {
  it('a new team has the name done and two steps to go', () => {
    expect(setupSteps({ members: 1, invitations: 0, workspaces: 0 })).toEqual([
      { id: 'name', done: true },
      { id: 'people', done: false },
      { id: 'workspace', done: false },
    ]);
  });

  it('an invitation counts as adding people; a workspace ticks its step', () => {
    expect(setupSteps({ members: 1, invitations: 1, workspaces: 0 })?.map((step) => step.done)).toEqual([
      true,
      true,
      false,
    ]);
    expect(setupSteps({ members: 1, invitations: 0, workspaces: 2 })?.map((step) => step.done)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('goes away once the team has a second person and a workspace', () => {
    expect(setupSteps({ members: 2, invitations: 0, workspaces: 1 })).toBeUndefined();
    expect(setupSteps({ members: 1, invitations: 3, workspaces: 1 })).toBeUndefined();
  });

  it('says how many joined and how many wait', () => {
    expect(peopleDetail({ members: 3, invitations: 0, workspaces: 0 })).toBe('3 joined');
    expect(peopleDetail({ members: 3, invitations: 1, workspaces: 0 })).toBe('3 joined · 1 waiting');
  });

  it('says today for a team made today, else the date, and nothing for a date it cannot read', () => {
    const now = new Date('2026-11-09T15:00:00');
    expect(createdLabel(new Date('2026-11-09T08:00:00').toISOString(), now)).toBe('today');
    expect(createdLabel('2026-11-07T08:00:00.000Z', now)).toBe(
      new Date('2026-11-07T08:00:00.000Z').toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    );
    expect(createdLabel('not a date', now)).toBe('');
  });
});
