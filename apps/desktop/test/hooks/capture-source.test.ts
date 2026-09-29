// @vitest-environment node
import type { Capture, CaptureSummary, CatchUrl } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_READ_TIMEOUT_MS,
  UNLINKED_WORKSPACE_MESSAGE,
  desktopCaptureSource,
  linkedServerOf,
} from '../../src/main/hooks/capture-source.js';
import type { WorkspaceWire } from '../../src/shared/wire-types.js';

const SERVER = 'https://wb.example.test';
const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const WS = '01K000000000000000000000W1';
const HOOK = '01K000000000000000000000H1';
const capId = (n: number): string => `01K${String(n).padStart(23, '0')}`;

const summary = (n: number): CaptureSummary => ({
  id: capId(n),
  receivedAt: '2026-09-29T10:00:00.000Z',
  method: 'POST',
  subpath: '/events',
  bodySize: 17,
  truncated: false,
  sourceIp: '127.0.0.1',
  signature: null,
});

function deps(signedIn = true) {
  const client = {
    listHooks: vi.fn<(url: string, token: string, ws: string) => Promise<CatchUrl[]>>(() =>
      Promise.resolve([{ id: HOOK, name: 'orders-hook' } as CatchUrl]),
    ),
    listCaptures: vi.fn(
      (_url: string, _token: string, _ws: string, _hook: string, page: { after?: string; limit?: number }) =>
        Promise.resolve(
          page.after === undefined ? [summary(3)] : [summary(3), summary(2)].filter((c) => c.id > page.after!),
        ),
    ),
    getCapture: vi.fn((_url: string, _token: string, _ws: string, _hook: string, id: string) =>
      Promise.resolve({
        ...summary(2),
        id,
        query: '',
        headers: [],
        body: Buffer.from('{"status":"paid"}').toString('base64'),
      } as Capture),
    ),
  };
  const accounts = {
    tokenFor: vi.fn<(url: string) => Promise<string | undefined>>(() => Promise.resolve(signedIn ? TOKEN : undefined)),
    markSignedOut: vi.fn(),
  };
  return { client, accounts };
}

describe('desktopCaptureSource (callback-assertion §5)', () => {
  it('reads the linked server only', () => {
    const linked = {
      share: { kind: 'server', managed: true, server: { url: SERVER, workspaceId: WS, teamName: 'QA' } },
    };
    expect(linkedServerOf(linked as unknown as WorkspaceWire)).toEqual({ url: SERVER, workspaceId: WS });
    expect(linkedServerOf({ share: { kind: 'git', managed: true } } as unknown as WorkspaceWire)).toBeUndefined();
    expect(linkedServerOf(null)).toBeUndefined();
  });

  it('errors every callback in an unlinked workspace', async () => {
    const { client, accounts } = deps();
    await expect(desktopCaptureSource({ client, accounts }, undefined).resolve('orders-hook')).rejects.toMatchObject({
      message: UNLINKED_WORKSPACE_MESSAGE,
    });
    expect(client.listHooks).not.toHaveBeenCalled();
  });

  it('asks for a sign-in when the account is signed out', async () => {
    const { client, accounts } = deps(false);
    await expect(
      desktopCaptureSource({ client, accounts }, { url: SERVER, workspaceId: WS }).resolve('orders-hook'),
    ).rejects.toMatchObject({ code: 'account-signed-out', message: `Sign in to ${SERVER} first.` });
  });

  it('resolves, pages oldest first and reads details with the account token', async () => {
    const { client, accounts } = deps();
    const source = desktopCaptureSource({ client, accounts }, { url: SERVER, workspaceId: WS });
    expect(await source.resolve('ORDERS-HOOK')).toEqual({ hookId: HOOK });
    expect(client.listHooks).toHaveBeenCalledWith(SERVER, TOKEN, WS);
    expect(await source.cursor(HOOK)).toBe(capId(3));
    expect((await source.after(HOOK, capId(1))).map((c) => c.id)).toEqual([capId(2), capId(3)]);
    expect(client.listCaptures).toHaveBeenLastCalledWith(SERVER, TOKEN, WS, HOOK, { after: capId(1), limit: 200 });
    expect((await source.detail(HOOK, capId(2))).bodyText).toBe('{"status":"paid"}');
  });

  it('gives up on a read that hangs, so it cannot outlast the wait', async () => {
    vi.useFakeTimers();
    try {
      const { client, accounts } = deps();
      client.listCaptures.mockImplementation(() => new Promise<CaptureSummary[]>(() => undefined));
      const source = desktopCaptureSource({ client, accounts }, { url: SERVER, workspaceId: WS });
      const read = source.after(HOOK, capId(1));
      const settled = expect(read).rejects.toMatchObject({
        code: 'server-unreachable',
        message: `Could not reach ${SERVER}`,
      });
      await vi.advanceTimersByTimeAsync(CAPTURE_READ_TIMEOUT_MS);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
