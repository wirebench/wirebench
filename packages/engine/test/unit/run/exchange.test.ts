import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import { exchangeController } from '../../../src/run/exchange.js';
import type { SentRequest } from '../../../src/run/run.js';
import { createRunScope } from '../../../src/run/scope.js';
import { testHost } from '../../helpers/send-host.js';

const sent: SentRequest = {
  subject: { protocol: 'x', status: 200, durationMs: 1, bodyText: '', bodyKind: 'other' },
  raw: { rawRequest: new Uint8Array(), rawResponse: new Uint8Array() },
};
const scopeWithSignal = (signal?: AbortSignal) =>
  createRunScope({
    project: createProject('P'),
    projectDir: '/x',
    overrides: {},
    host: testHost(),
    ...(signal !== undefined ? { signal } : {}),
  });

describe('exchangeController', () => {
  it('settles result with the run, ends events, and refuses a push on an exchange with no streaming side', async () => {
    const controller = exchangeController<{ protocol: 'x'; kind: 'tick' }>('x', {
      scope: scopeWithSignal(),
      interactive: false,
      live: true,
    });
    const handle = controller.handle(() => {
      controller.queue.push({ protocol: 'x', kind: 'tick' });
      return Promise.resolve(sent);
    });
    const events: string[] = [];
    for await (const event of handle.events) events.push(event.kind);
    expect(events).toEqual(['tick']);
    expect((await handle.result).subject.status).toBe(200);
    await expect(handle.push({ text: 'm' })).rejects.toMatchObject({ code: 'exchange-not-streaming' });
    expect(() => handle.halfClose()).toThrow(expect.objectContaining({ code: 'exchange-not-streaming' }));
  });

  it('cancel aborts this exchange only', async () => {
    const outer = new AbortController();
    const controller = exchangeController('x', { scope: scopeWithSignal(outer.signal), interactive: false });
    const handle = controller.handle(
      () =>
        new Promise<SentRequest>((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    expect(handle.cancel()).toBe(true);
    await expect(handle.result).rejects.toThrow('aborted');
    expect(outer.signal.aborted).toBe(false);
    expect(handle.cancel()).toBe(false);
  });

  it('follows the run signal', () => {
    const outer = new AbortController();
    const controller = exchangeController('x', { scope: scopeWithSignal(outer.signal), interactive: false });
    outer.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});
