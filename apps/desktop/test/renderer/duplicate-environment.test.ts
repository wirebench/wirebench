import { afterEach, describe, expect, it, vi } from 'vitest';
import { duplicateEnvironment } from '../../src/renderer/features/environments/environment-actions.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceEnvironmentWire } from '../../src/shared/wire-base.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const prod: WorkspaceEnvironmentWire = {
  id: 'e1',
  name: 'prod',
  slug: 'prod',
  order: 0,
  endpoints: { 'a/b': 'https://prod.test' },
  properties: { region: 'eu' },
  disabled: [],
};

function setUp(environment: WorkspaceEnvironmentWire) {
  const mutate = vi.fn((change: { kind: string }) =>
    Promise.resolve(change.kind === 'add-workspace-environment' ? { createdEnvironmentId: 'e2' } : {}),
  );
  useWorkspaceStore.setState({
    workspace: workspaceWire({ environments: [environment] }),
    mutate: mutate as unknown as ReturnType<typeof useWorkspaceStore.getState>['mutate'],
  });
  return mutate;
}

afterEach(() => {
  useWorkspaceStore.setState({ workspace: null });
});

describe('duplicateEnvironment', () => {
  it('carries the colour and protection over, so a copy of production stays protected', async () => {
    const mutate = setUp({ ...prod, color: 'red', protected: true });
    expect(await duplicateEnvironment('e1')).toBe('e2');
    expect(mutate).toHaveBeenLastCalledWith({
      kind: 'update-workspace-environment',
      environmentId: 'e2',
      patch: { endpoints: prod.endpoints, properties: prod.properties, color: 'red', protected: true },
    });
  });

  it('leaves behind a colour this build does not know', async () => {
    const mutate = setUp({ ...prod, color: 'chartreuse' });
    await duplicateEnvironment('e1');
    expect(mutate).toHaveBeenLastCalledWith({
      kind: 'update-workspace-environment',
      environmentId: 'e2',
      patch: { endpoints: prod.endpoints, properties: prod.properties },
    });
  });
});
