// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineChannel } from '@wirebench/wire/ipc-contract';
import { HandlerTable } from '../../src/main/ipc/register.js';
import { Redactor } from '../../src/main/host/redactor.js';
import { callerId } from '../../src/main/window-scope.js';
import { fakeCaller } from '../helpers/fake-platform.js';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
}));
vi.mock('electron', () => electron);

const { registerHandler } = await import('../../src/main/ipc/register.js');
const { bindIpc } = await import('../../src/main/electron/ipc-binding.js');
const { callerForWebContents } = await import('../../src/main/electron/electron-platform.js');

const echo = defineChannel('test.echo', z.object({ text: z.string() }), z.object({ text: z.string() }));

/** An Electron `WebContents` as far as `callerForWebContents` looks at it. */
function fakeContents(id: number) {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: vi.fn() });
}

type Bound = (event: unknown, raw: unknown) => Promise<unknown>;
function bound(channel: string): Bound {
  const call = electron.ipcMain.handle.mock.calls.find((c) => c[0] === channel);
  if (call === undefined) throw new Error(`${channel} was never bound`);
  return call[1] as Bound;
}

beforeEach(() => {
  electron.ipcMain.handle.mockReset();
});

describe('registerHandler', () => {
  it('records the wrapped handler in the table under the channel name, binding nothing itself', () => {
    const table = new HandlerTable(new Redactor());
    registerHandler(table, echo, (request) => Promise.resolve(request));
    expect([...table.keys()]).toEqual(['test.echo']);
    expect(electron.ipcMain.handle).not.toHaveBeenCalled();
  });

  it('gives the handler the caller and the validated request, with the envelope wrapHandler produces', async () => {
    const table = new HandlerTable(new Redactor());
    const seen: unknown[] = [];
    registerHandler(table, echo, (request, caller) => {
      seen.push(request, caller);
      return Promise.resolve({ text: request.text.toUpperCase() });
    });
    const caller = fakeCaller(4);
    const run = table.get('test.echo');
    await expect(run?.({ text: 'a' }, caller)).resolves.toEqual({ ok: true, value: { text: 'A' } });
    expect(seen).toEqual([{ text: 'a' }, caller]);
    await expect(run?.({ text: 1 }, caller)).resolves.toMatchObject({
      ok: false,
      error: { code: 'ipc-invalid-request' },
    });
  });

  it('refuses a second handler for the same channel', () => {
    const table = new HandlerTable(new Redactor());
    registerHandler(table, echo, (request) => Promise.resolve(request));
    expect(() => {
      registerHandler(table, echo, (request) => Promise.resolve(request));
    }).toThrow(/second handler for 'test\.echo'/);
  });

  it('wraps a thrown error in the error envelope', async () => {
    const table = new HandlerTable(new Redactor());
    registerHandler(table, echo, () => Promise.reject(new Error('nope')));
    await expect(table.get('test.echo')?.({ text: 'a' }, fakeCaller())).resolves.toEqual({
      ok: false,
      error: { code: 'internal-error', message: 'nope' },
    });
  });
});

describe('bindIpc', () => {
  it('installs every entry on ipcMain and hands the handler the caller for the sender', async () => {
    const table = new HandlerTable(new Redactor());
    let received: unknown;
    registerHandler(table, echo, (request, caller) => {
      received = caller;
      return Promise.resolve(request);
    });
    bindIpc(table);
    expect(electron.ipcMain.handle).toHaveBeenCalledTimes(1);
    const sender = fakeContents(21);
    await expect(bound('test.echo')({ sender }, { text: 'hi' })).resolves.toEqual({
      ok: true,
      value: { text: 'hi' },
    });
    expect(received).toBe(callerForWebContents(sender as never));
    expect((received as { id: number }).id).toBe(21);
  });

  it('runs the handler as a call from the sender window', async () => {
    const table = new HandlerTable(new Redactor());
    let inside: number | undefined;
    registerHandler(table, echo, (request) => {
      inside = callerId();
      return Promise.resolve(request);
    });
    bindIpc(table);
    const sender = fakeContents(22);
    await bound('test.echo')({ sender }, { text: 'x' });
    expect(inside).toBe(22);
    expect(callerId()).toBeUndefined();
  });
});
