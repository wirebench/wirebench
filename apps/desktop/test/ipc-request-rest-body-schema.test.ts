// @vitest-environment node
/** `request.restBodySchema`: the project's answer, or `null` when there is none. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

async function invoke(payload: unknown): Promise<{ ok: boolean; value?: unknown }> {
  const handler = handlers.get('request.restBodySchema');
  if (handler === undefined) throw new Error('request.restBodySchema was never registered');
  return (await handler({ sender: {} }, payload)) as { ok: boolean; value?: unknown };
}

function setup(restBodySchema?: (requestId: string) => Promise<unknown>): void {
  handlers.clear();
  registerRequestChannels(new EngineService(), {
    project: {
      ...(restBodySchema !== undefined ? { restBodySchema } : {}),
    } as unknown as RequestChannelDeps['project'],
    adHocScopes: () => ({ project: {}, global: {}, system: {} }),
  });
}

beforeEach(() => handlers.clear());

describe('request.restBodySchema', () => {
  it("passes the project's schema through", async () => {
    const found = { mediaType: 'application/json', schema: { type: 'object', required: ['name'] } };
    const lookup = vi.fn().mockResolvedValue(found);
    setup(lookup);
    const result = await invoke({ requestId: 'rest-1' });
    expect(result).toEqual({ ok: true, value: found });
    expect(lookup).toHaveBeenCalledWith('rest-1');
  });

  it('answers null when the project has none', async () => {
    setup(() => Promise.resolve(undefined));
    expect(await invoke({ requestId: 'rest-1' })).toEqual({ ok: true, value: null });
  });

  it('answers null when the project cannot look one up', async () => {
    setup();
    expect(await invoke({ requestId: 'rest-1' })).toEqual({ ok: true, value: null });
  });
});
