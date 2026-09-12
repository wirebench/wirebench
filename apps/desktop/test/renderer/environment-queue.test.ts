import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  queueEndpointOverride,
  queueEnvironmentPatch,
} from '../../src/renderer/features/environments/environment-queue.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const dev = {
  id: 'e1',
  name: 'dev',
  slug: 'dev',
  order: 0,
  properties: {},
  endpoints: { 'demo/calculator': 'http://dev.test/soap' },
  disabled: [],
};

afterEach(() => {
  useWorkspaceStore.setState({ workspace: null });
});

describe('queueEnvironmentPatch', () => {
  it('queues two quick edits of one environment so neither is lost', async () => {
    let resolveFirst: (() => void) | undefined;
    const mutate = vi.fn().mockImplementation(async () => {
      if (resolveFirst === undefined) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return {};
    });
    useWorkspaceStore.setState({
      workspace: workspaceWire({ environments: [dev] }),
      mutate,
    });

    // Fired before the first round trip resolves: the second must build on what the first wrote,
    // not on the map as it stood when it was queued.
    const first = queueEndpointOverride('e1', 'demo/calculator', 'http://one.test/soap');
    const second = queueEndpointOverride('e1', 'demo/weather', 'http://two.test/soap');

    await vi.waitFor(() => {
      expect(resolveFirst).toBeDefined();
    });
    expect(mutate).toHaveBeenCalledTimes(1);

    // Main answers the first edit; the store now holds it, as the real store would.
    useWorkspaceStore.setState({
      workspace: workspaceWire({
        environments: [{ ...dev, endpoints: { 'demo/calculator': 'http://one.test/soap' } }],
      }),
      mutate,
    });
    resolveFirst?.();
    await first;
    await second;

    expect(mutate).toHaveBeenLastCalledWith({
      kind: 'update-workspace-environment',
      environmentId: 'e1',
      patch: {
        endpoints: { 'demo/calculator': 'http://one.test/soap', 'demo/weather': 'http://two.test/soap' },
      },
    });
  });

  it('sends nothing when the build function reports a no-op', async () => {
    const mutate = vi.fn().mockResolvedValue({});
    useWorkspaceStore.setState({ workspace: workspaceWire({ environments: [dev] }), mutate });

    await queueEnvironmentPatch('e1', () => undefined);

    expect(mutate).not.toHaveBeenCalled();
  });
});
