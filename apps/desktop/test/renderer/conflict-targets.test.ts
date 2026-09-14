import { describe, expect, it } from 'vitest';
import {
  conflictTargets,
  type ConflictTargetProject,
  type ConflictTargetRequest,
} from '../../src/renderer/features/sync/conflict-targets.js';
import type { SyncConflictWire } from '../../src/shared/wire-types.js';

function conflict(patch: Partial<SyncConflictWire> = {}): SyncConflictWire {
  return { path: 'projects/Demo/interfaces/Calc/operations/Add/Request 1.request.yaml', ...patch };
}

const PROJECTS: readonly ConflictTargetProject[] = [{ id: 'p1', slug: 'Demo' }];

describe('conflictTargets', () => {
  it("matches a project by the conflict's path prefix, even with no projectId", () => {
    const targets = conflictTargets([conflict({ projectId: undefined })], PROJECTS, []);
    expect(targets.projectIds).toEqual(new Set(['p1']));
  });

  it('falls back to projectId when no loaded project slug prefixes the path', () => {
    const targets = conflictTargets([{ path: 'projects/Unknown/x.yaml', projectId: 'p9' }], PROJECTS, []);
    expect(targets.projectIds).toEqual(new Set(['p9']));
  });

  it('adds nothing when neither a path prefix nor a projectId is available', () => {
    const targets = conflictTargets([{ path: 'projects/Unknown/x.yaml' }], PROJECTS, []);
    expect(targets.projectIds.size).toBe(0);
  });

  it('matches a request by its exact on-disk path, never by display name or a re-slugified one', () => {
    const requests: readonly ConflictTargetRequest[] = [
      { id: 'req-1', projectId: 'p1', interfaceSlug: 'Calc', operationSlug: 'Add', slug: 'Request 1' },
    ];
    const targets = conflictTargets([conflict()], PROJECTS, requests);
    expect(targets.requestIds).toEqual(new Set(['req-1']));
  });

  it('marks only the request under the conflicted operation, leaving a same-named sibling in another operation unmarked', () => {
    const requests: readonly ConflictTargetRequest[] = [
      { id: 'req-1', projectId: 'p1', interfaceSlug: 'Calc', operationSlug: 'Add', slug: 'Request 1' },
      // Same display name and slug, but a different operation — must never match the Add conflict.
      { id: 'req-2', projectId: 'p1', interfaceSlug: 'Calc', operationSlug: 'Subtract', slug: 'Request 1' },
    ];
    const targets = conflictTargets(
      [conflict({ path: 'projects/Demo/interfaces/Calc/operations/Add/Request 1.request.yaml' })],
      PROJECTS,
      requests,
    );
    expect(targets.requestIds).toEqual(new Set(['req-1']));
  });

  it('matches a request whose on-disk slug carries a uniqueSlug suffix', () => {
    const requests: readonly ConflictTargetRequest[] = [
      { id: 'req-1', projectId: 'p1', interfaceSlug: 'Calc', operationSlug: 'Add', slug: 'Add' },
      { id: 'req-2', projectId: 'p1', interfaceSlug: 'Calc', operationSlug: 'Add', slug: 'Add-2' },
    ];
    const targets = conflictTargets(
      [conflict({ path: 'projects/Demo/interfaces/Calc/operations/Add/Add-2.request.yaml' })],
      PROJECTS,
      requests,
    );
    expect(targets.requestIds).toEqual(new Set(['req-2']));
  });

  it('matches the .xml envelope path the same as the .request.yaml metadata path', () => {
    const requests: readonly ConflictTargetRequest[] = [
      { id: 'req-1', projectId: 'p1', interfaceSlug: 'Calc', operationSlug: 'Add', slug: 'Request 1' },
    ];
    const targets = conflictTargets(
      [conflict({ path: 'projects/Demo/interfaces/Calc/operations/Add/Request 1.xml' })],
      PROJECTS,
      requests,
    );
    expect(targets.requestIds).toEqual(new Set(['req-1']));
  });

  it('never matches a request whose project has not loaded (no entry in `projects`)', () => {
    const requests: readonly ConflictTargetRequest[] = [
      { id: 'req-1', projectId: 'missing-project', interfaceSlug: 'Calc', operationSlug: 'Add', slug: 'Request 1' },
    ];
    const targets = conflictTargets([conflict()], PROJECTS, requests);
    expect(targets.requestIds.size).toBe(0);
  });

  it('returns empty sets for no conflicts', () => {
    const targets = conflictTargets([], PROJECTS, []);
    expect(targets.projectIds.size).toBe(0);
    expect(targets.requestIds.size).toBe(0);
  });
});
