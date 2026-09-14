// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fillConflictProjectIds, planPull, projectSlugOfTreePath } from '../../src/main/sync/pull-plan.js';

describe('planPull', () => {
  it('splits workspace-level files from per-project files, relative to each project folder', () => {
    const plan = planPull([
      'workspace.yaml',
      'environments/dev.yaml',
      'projects/calc/wirebench.yaml',
      'projects/calc/interfaces/Calc/operations/Add/Request-1.request.yaml',
      'projects/other/environments/local.yaml',
      '.gitattributes',
    ]);

    expect(plan.workspacePaths).toEqual(['workspace.yaml', 'environments/dev.yaml']);
    expect([...plan.projects.entries()]).toEqual([
      ['calc', ['wirebench.yaml', 'interfaces/Calc/operations/Add/Request-1.request.yaml']],
      ['other', ['environments/local.yaml']],
    ]);
  });

  it('counts entities, not files: a request’s yaml and xml are one change', () => {
    const plan = planPull([
      'projects/calc/interfaces/Calc/operations/Add/Request-1.request.yaml',
      'projects/calc/interfaces/Calc/operations/Add/Request-1.xml',
      'environments/dev.yaml',
    ]);
    expect(plan.entityCount).toBe(2);
  });

  it('ignores files nested deeper than environments/<name>.yaml at the root and a bare projects/ entry', () => {
    const plan = planPull(['environments/nested/dev.yaml', 'projects/', 'projects/calc']);
    expect(plan.workspacePaths).toEqual([]);
    expect(plan.projects.size).toBe(0);
  });

  it('is empty for no paths', () => {
    expect(planPull([])).toEqual({ workspacePaths: [], projects: new Map(), entityCount: 0 });
  });
});

describe('projectSlugOfTreePath', () => {
  it('returns the slug under projects/ and undefined elsewhere', () => {
    expect(projectSlugOfTreePath('projects/calc/wirebench.yaml')).toBe('calc');
    expect(projectSlugOfTreePath('environments/dev.yaml')).toBeUndefined();
    expect(projectSlugOfTreePath('projects/calc')).toBeUndefined();
  });
});

describe('fillConflictProjectIds', () => {
  it('fills projectId from the projects/<slug>/ prefix and leaves the rest untouched', () => {
    const ids = new Map([['calc', 'proj-1']]);
    const filled = fillConflictProjectIds(
      [
        { path: 'projects/calc/wirebench.yaml', entity: { kind: 'project', name: 'calc' } },
        { path: 'projects/gone/wirebench.yaml' },
        { path: 'environments/dev.yaml', entity: { kind: 'environment', name: 'dev' } },
      ],
      (slug) => ids.get(slug),
    );
    expect(filled).toEqual([
      { path: 'projects/calc/wirebench.yaml', projectId: 'proj-1', entity: { kind: 'project', name: 'calc' } },
      { path: 'projects/gone/wirebench.yaml' },
      { path: 'environments/dev.yaml', entity: { kind: 'environment', name: 'dev' } },
    ]);
  });
});
