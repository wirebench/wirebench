import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelSendToEnvironments,
  currentBlocker,
  openEnvPicker,
  sendToEnvironments,
  useMultiEnvStore,
} from '../../src/renderer/features/multi-env/multi-env-actions.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const SELECTION = { ticked: ['dev', 'test'], baseline: 'dev' };

/** A `request.sendToEnvironments` whose answer the test releases by hand. */
function deferredSend() {
  const pending: ((value: unknown) => void)[] = [];
  const send = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  const cancel = vi.fn().mockResolvedValue({ ok: true, value: undefined });
  installWirebenchApi({ request: { sendToEnvironments: send, cancel } });
  const answer = (index: number) => pending[index]?.({ ok: true, value: { results: [] } });
  return { send, cancel, answer };
}

describe('multi-environment send actions', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ workspace: null });
    useProjectStore.setState({
      projects: {
        p1: {
          id: 'p1',
          name: 'Demo',
          environments: [
            { id: 'dev', name: 'Dev', order: 0 },
            { id: 'test', name: 'Test', order: 1 },
          ],
          activeEnvironmentId: 'dev',
        } as unknown as ProjectWire,
      },
      projectOf: { r1: 'p1' },
    });
    useMultiEnvStore.setState({ picker: undefined, remembered: {}, running: {} });
  });

  afterEach(() => {
    useMultiEnvStore.setState({ picker: undefined, remembered: {}, running: {} });
  });

  it('will not open the picker while a batch is running for the request', () => {
    useMultiEnvStore.setState({ running: { r1: 'batch-1' } });
    expect(currentBlocker('r1')).toBe('Already comparing environments');
    openEnvPicker('r1', 'rest');
    expect(useMultiEnvStore.getState().picker).toBeUndefined();
  });

  it('cancels a running batch before starting another for the same request', async () => {
    const { cancel, answer } = deferredSend();
    const first = sendToEnvironments('r1', 'rest', SELECTION);
    const firstId = useMultiEnvStore.getState().running.r1;
    const second = sendToEnvironments('r1', 'rest', SELECTION);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith({ sendId: firstId }));
    answer(0);
    answer(1);
    await Promise.all([first, second]);
  });

  it('does not open the compare tab when the batch was cancelled', async () => {
    const openOrReplace = vi.fn();
    useEditorsStore.setState({ openOrReplace } as never);
    const { cancel, answer } = deferredSend();
    const sending = sendToEnvironments('r1', 'rest', SELECTION);
    await cancelSendToEnvironments('r1');
    expect(cancel).toHaveBeenCalled();
    expect(useMultiEnvStore.getState().running.r1).toBeUndefined();
    answer(0);
    await sending;
    expect(openOrReplace).not.toHaveBeenCalled();
  });
});
