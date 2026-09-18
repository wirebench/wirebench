// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { b64, makeRestExchange } from './mocks/wire-fixtures.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const pickSaveFile = vi.fn<() => Promise<string | undefined>>();
vi.mock('electron', () => ({ ipcMain: { handle: (n: string, h: never) => handlers.set(n, h) } }));
vi.mock('../src/main/native-dialogs.js', () => ({
  pickSaveFile: (...args: unknown[]) => pickSaveFile(...(args as [])),
}));

const { registerLogChannels } = await import('../src/main/ipc/log.js');
const invoke = (channel: string, payload: unknown) => handlers.get(channel)!({ sender: {} }, payload);

function secretEntry() {
  const exchange = makeRestExchange();
  return {
    kind: 'exchange',
    exchange: {
      ...exchange,
      http: {
        ...exchange.http,
        request: {
          url: 'https://h/x?api_key=k-placeholder',
          method: 'POST',
          headers: { Authorization: 'Bearer plain-token' },
        },
        rawRequestBase64: b64(
          'POST /x HTTP/1.1\r\nAuthorization: Bearer plain-token\r\nContent-Type: application/json\r\n\r\n{"password":"s3cr3t-placeholder"}',
        ),
      },
    },
  };
}

describe('log.exportHar', () => {
  beforeEach(() => {
    handlers.clear();
    pickSaveFile.mockReset();
    registerLogChannels({
      showSecrets: { get: () => true },
      service: {} as never,
      request: {} as never,
      picks: { rememberWrite: vi.fn() },
      appVersion: '1.2.3',
    });
  });

  it('writes a redacted HAR even with show-secrets on, and returns the path', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'har-')), 'out.har');
    pickSaveFile.mockResolvedValue(path);
    const reply = (await invoke('log.exportHar', { entries: [secretEntry()] })) as {
      ok: true;
      value: { saved: boolean; path: string };
    };
    expect(reply.value).toEqual({ saved: true, path });
    const text = readFileSync(path, 'utf8');
    for (const secret of ['plain-token', 'k-placeholder', 's3cr3t-placeholder']) expect(text).not.toContain(secret);
    expect((JSON.parse(text) as { log: { creator: unknown } }).log.creator).toEqual({
      name: 'Wirebench',
      version: '1.2.3',
    });
    const [call] = pickSaveFile.mock.calls as unknown as [unknown, unknown, { defaultPath: string }][];
    expect(call?.[0]).toEqual({});
    expect(call?.[2].defaultPath).toMatch(/^wirebench-\d{8}-\d{6}\.har$/);
  });

  it('a cancelled dialog returns saved:false and writes nothing', async () => {
    pickSaveFile.mockResolvedValue(undefined);
    const reply = (await invoke('log.exportHar', { entries: [secretEntry()] })) as {
      ok: true;
      value: { saved: boolean };
    };
    expect(reply.value).toEqual({ saved: false });
  });
});
