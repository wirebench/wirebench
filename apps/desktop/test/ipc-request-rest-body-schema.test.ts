// @vitest-environment node
/**
 * `request.restBodySchema`: the project's answer, or `null` when there is none, for the method and
 * URL a send would use — the editor's draft laid over the saved request, properties expanded.
 */
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

function setup(
  restBodySchema?: (requestId: string, sent?: { method: string; url: string }) => Promise<unknown>,
  restSend?: (requestId: string, draft?: unknown) => unknown,
): void {
  handlers.clear();
  registerRequestChannels(new EngineService(), {
    project: {
      ...(restBodySchema !== undefined ? { restBodySchema } : {}),
      ...(restSend !== undefined ? { restSend } : {}),
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
    expect(lookup).toHaveBeenCalledWith('rest-1', undefined);
  });

  it('looks the operation up by the method and URL a send would use, draft included', async () => {
    const lookup = vi.fn().mockResolvedValue(undefined);
    const restSend = vi.fn().mockReturnValue({
      input: { request: { method: 'PUT', url: 'https://pets.example.test/v1/pets/7' } },
    });
    setup(lookup, restSend);
    const draft = { method: 'PUT', url: '${base}/pets/7' };
    await invoke({ requestId: 'rest-1', draft });
    expect(restSend).toHaveBeenCalledWith('rest-1', draft);
    expect(lookup).toHaveBeenCalledWith('rest-1', { method: 'PUT', url: 'https://pets.example.test/v1/pets/7' });
  });

  it('falls back to the saved request when the send cannot be resolved', async () => {
    const lookup = vi.fn().mockResolvedValue(undefined);
    setup(lookup, () => undefined);
    await invoke({ requestId: 'rest-1', draft: { method: 'PUT' } });
    expect(lookup).toHaveBeenCalledWith('rest-1', undefined);
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
