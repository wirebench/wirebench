/**
 * The schedules menus (#517): everyone can open a schedule; only a workspace admin can run, pause,
 * edit or delete one, or offer **Schedule…** on a runnable row — and never on a linked project.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explorerMenuItems } from '../../src/renderer/features/explorer/context-menu.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';
import { useSchedulesStore } from '../../src/renderer/state/schedules.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';

const initialSync = useSyncStore.getState().status;

function asRole(role: 'admin' | 'viewer', available = true): void {
  useSchedulesStore.setState({ available });
  useSyncStore.setState({ status: { ...initialSync, role } });
}

const labels = (node: ExplorerNode): string[] => explorerMenuItems(node).map((item) => item.label);

describe('the schedules menus', () => {
  beforeEach(() => asRole('admin'));
  afterEach(() => {
    useSchedulesStore.setState({ available: undefined });
    useSyncStore.setState({ status: initialSync });
  });

  it('gives an admin every schedule action and a viewer only Open', () => {
    const node: ExplorerNode = {
      id: 'schedule:S1',
      kind: 'schedule',
      label: 'Smoke',
      scheduleId: 'S1',
      scheduleState: 'paused',
      canEdit: true,
    };
    expect(labels(node)).toEqual(['Open', 'Run now', 'Resume', 'Edit…', 'Secrets…', 'Delete']);
    expect(labels({ ...node, canEdit: false })).toEqual(['Open']);
  });

  it('offers New schedule… on the root to an admin only', () => {
    const root: ExplorerNode = { id: 'schedules', kind: 'schedules', label: 'Schedules', canEdit: true };
    expect(labels(root)).toEqual(['New schedule…']);
    expect(labels({ ...root, canEdit: false })).toEqual([]);
  });

  it('offers Schedule… next to Run… on a project an admin can schedule', () => {
    const project: ExplorerNode = { id: 'proj:p1', kind: 'project', label: 'Shop', projectId: 'p1' };
    expect(labels(project)).toContain('Schedule…');
    expect(labels({ ...project, linked: true })).not.toContain('Schedule…');
    asRole('viewer');
    expect(labels(project)).not.toContain('Schedule…');
    asRole('admin', false);
    expect(labels(project)).not.toContain('Schedule…');
  });
});
