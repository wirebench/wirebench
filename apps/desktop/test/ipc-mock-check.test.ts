// @vitest-environment node
/**
 * `mock.check` (#325): checks a mock's stubs in the project the mock belongs to, whether or not it
 * runs, and answers with the engine's findings.
 */
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '@wirebench/engine';
import type { CheckMockStubsInput, MockStubCheck } from '@wirebench/engine';
import { registerMockChannels } from '../src/main/ipc/mock.js';
import { MockRunner } from '../src/main/mock-runner.js';
import type { MockCheckResponse } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

function invoke<T>(channel: string, payload: unknown): Promise<Result<T>> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} was never registered`);
  return handler({ sender: { id: 1 } }, payload) as Promise<Result<T>>;
}

describe('mock.check', () => {
  it('checks the stubs of the project that holds the mock', async () => {
    const project = createProject('Shop', { id: 'p1' });
    const found: MockStubCheck = {
      checked: 2,
      findings: [
        {
          operationId: 'o1',
          operationName: 'createOrder',
          operation: 'post /orders',
          responseId: 'r1',
          responseName: 'Created',
          status: 500,
          problems: [{ code: 'mock-stub-invalid', message: 'The contract declares no 500 response', in: 'status' }],
        },
      ],
    };
    const checkStubs = vi.fn<(input: CheckMockStubsInput) => Promise<MockStubCheck>>().mockResolvedValue(found);
    registerMockChannels(new MockRunner(), {
      locate: () => ({ projectId: 'p1', project, dir: '/tmp/shop' }),
      host: () => '127.0.0.1',
      owns: () => true,
      checkStubs,
    });
    const result = await invoke<MockCheckResponse>('mock.check', { mockId: 'm1' });
    expect(result).toEqual({ ok: true, value: found });
    expect(checkStubs).toHaveBeenCalledWith({ project, root: '/tmp/shop', mockId: 'm1' });
  });
});
