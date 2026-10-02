// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const pickSaveFile = vi.fn<() => Promise<string | undefined>>();
vi.mock('electron', () => ({ ipcMain: { handle: (n: string, h: never) => handlers.set(n, h) } }));
vi.mock('../src/main/native-dialogs.js', () => ({
  pickSaveFile: (...args: unknown[]) => pickSaveFile(...(args as [])),
}));

const { registerAuditChannels, auditFileName } = await import('../src/main/ipc/audit.js');
const invoke = (channel: string, payload: unknown) => handlers.get(channel)!({ sender: {} }, payload);

const TOKEN = 'wbs_test';
const accounts = (signedIn: boolean) => ({
  tokenFor: () => Promise.resolve(signedIn ? TOKEN : undefined),
  markSignedOut: vi.fn(),
});
const dir = mkdtempSync(join(tmpdir(), 'audit-'));
const register = (client: object, signedIn = true) =>
  registerAuditChannels({ client: client as never, accounts: accounts(signedIn), picks: {} as never });

describe('audit.* channels (audit-log spec §3.6, §5.3)', () => {
  beforeEach(() => {
    handlers.clear();
    pickSaveFile.mockReset();
  });

  it('names the default file after the day', () => {
    expect(auditFileName(new Date('2026-10-02T12:00:00Z'))).toBe('wirebench-audit-2026-10-02.ndjson');
  });

  it('audit.query forwards url, token and query and returns the page', async () => {
    const page = { events: [] };
    const client = { queryAudit: vi.fn().mockResolvedValue(page), streamAuditExport: vi.fn() };
    register(client);
    expect(await invoke('audit.query', { url: 'https://s.example', query: { limit: 10 } })).toEqual({
      ok: true,
      value: page,
    });
    expect(client.queryAudit).toHaveBeenCalledWith('https://s.example', TOKEN, { limit: 10 });
  });

  it('audit.export with the dialog cancelled saves nothing and never calls the server', async () => {
    pickSaveFile.mockResolvedValue(undefined);
    const client = { queryAudit: vi.fn(), streamAuditExport: vi.fn() };
    register(client);
    expect(await invoke('audit.export', { url: 'https://s.example', query: {} })).toEqual({
      ok: true,
      value: { saved: false },
    });
    expect(client.streamAuditExport).not.toHaveBeenCalled();
  });

  it('audit.export writes the chunks to the picked file and counts the lines', async () => {
    const path = join(dir, 'audit.ndjson');
    pickSaveFile.mockResolvedValue(path);
    const client = {
      queryAudit: vi.fn(),
      streamAuditExport: vi.fn((_u: string, _t: string, _q: unknown, open: () => (c: Uint8Array) => void) => {
        const sink = open();
        sink(new TextEncoder().encode('{"a":1}\n{"a":'));
        sink(new TextEncoder().encode('2}\n'));
        return Promise.resolve();
      }),
    };
    register(client);
    expect(await invoke('audit.export', { url: 'https://s.example', query: { action: 'auth.' } })).toEqual({
      ok: true,
      value: { saved: true, path, count: 2 },
    });
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"a":2}\n');
  });

  it('a signed-out account, or a refusal before any 2xx, writes no file', async () => {
    const path = join(dir, 'none.ndjson');
    pickSaveFile.mockResolvedValue(path);
    register({ queryAudit: vi.fn(), streamAuditExport: vi.fn() }, false);
    expect(await invoke('audit.export', { url: 'https://s.example', query: {} })).toMatchObject({
      ok: false,
      error: { code: 'account-signed-out' },
    });
    handlers.clear();
    register({
      queryAudit: vi.fn(),
      streamAuditExport: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('no'), { code: 'licensing-feature-required' })),
    });
    expect(await invoke('audit.export', { url: 'https://s.example', query: {} })).toMatchObject({ ok: false });
    expect(existsSync(path)).toBe(false);
  });
});
