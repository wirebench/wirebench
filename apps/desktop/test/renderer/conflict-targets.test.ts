import { describe, expect, it } from 'vitest';
import { conflictTargets, type ConflictTargetRequest } from '../../src/renderer/features/sync/conflict-targets.js';
import type { SyncConflictWire } from '../../src/shared/wire-types.js';

function conflict(patch: Partial<SyncConflictWire> = {}): SyncConflictWire {
  return { path: 'projects/Demo/interfaces/Calc/operations/Add/Request 1.request.yaml', ...patch };
}

describe('conflictTargets', () => {
  it("collects every conflict's projectId, ignoring one that has none yet", () => {
    const targets = conflictTargets(
      [conflict({ projectId: 'p1' }), conflict({ projectId: 'p2' }), conflict({ projectId: undefined })],
      [],
    );
    expect(targets.projectIds).toEqual(new Set(['p1', 'p2']));
  });

  it('matches a request conflict to the request whose slugified name and project agree', () => {
    const requests: readonly ConflictTargetRequest[] = [
      { id: 'req-1', projectId: 'p1', name: 'Request 1' },
      { id: 'req-2', projectId: 'p1', name: 'Other request' },
      // Same name, different project — must not match the p1 conflict below.
      { id: 'req-3', projectId: 'p2', name: 'Request 1' },
    ];
    const targets = conflictTargets(
      [conflict({ projectId: 'p1', entity: { kind: 'request', name: 'Request 1' } })],
      requests,
    );
    expect(targets.requestIds).toEqual(new Set(['req-1']));
  });

  it('never matches a non-request entity kind, even with a matching name', () => {
    const requests: readonly ConflictTargetRequest[] = [{ id: 'req-1', projectId: 'p1', name: 'interface-a' }];
    const targets = conflictTargets(
      [conflict({ projectId: 'p1', entity: { kind: 'interface', name: 'interface-a' } })],
      requests,
    );
    expect(targets.requestIds.size).toBe(0);
  });

  it('slugifies illegal path characters the same way the tree layout does', () => {
    const requests: readonly ConflictTargetRequest[] = [{ id: 'req-1', projectId: 'p1', name: 'Get: Weather?' }];
    const targets = conflictTargets(
      [conflict({ projectId: 'p1', entity: { kind: 'request', name: 'Get_ Weather_' } })],
      requests,
    );
    expect(targets.requestIds).toEqual(new Set(['req-1']));
  });

  it('returns empty sets for no conflicts', () => {
    const targets = conflictTargets([], []);
    expect(targets.projectIds.size).toBe(0);
    expect(targets.requestIds.size).toBe(0);
  });
});
