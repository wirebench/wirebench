// @vitest-environment node
/**
 * A `${#System#NAME}` reference reads the process environment, and nothing marks what it reads as a
 * secret. Once a send expands one, main records the value as it records a resolved secret, so the
 * response view and History mask it as they mask a recorded secret (#181). A short value is left alone.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import { createApi, createProject, createRestRequest, entry } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { HistoryService, historyFilePath } from '../src/main/history-service.js';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

const LONG = 'WB_DESKTOP_181_LONG';
const SHORT = 'WB_DESKTOP_181_SHORT';
const LONG_VALUE = 'desktop-system-value-181';
const SHORT_VALUE = 'dsk7chr';

let server: TestRestServer;
let userDataDir: string;
const saved = { [LONG]: process.env[LONG], [SHORT]: process.env[SHORT] };

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-system-value-'));
  process.env[LONG] = LONG_VALUE;
  process.env[SHORT] = SHORT_VALUE;
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function seeded(): Project {
  const api = createApi('Echo', {
    id: 'api-1',
    baseUrl: server.url,
    requests: [
      createRestRequest('Echo', {
        id: 'req-1',
        url: '/echo',
        query: [entry('short', `\${#System#${SHORT}}`)],
        headers: [entry('X-Sys', `\${#System#${LONG}}`)],
      }),
    ],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api] };
}

describe('a ${#System#…} value a desktop send expands', () => {
  it('is masked in the response view and in History, while a short one is not', async () => {
    const history = new HistoryService(userDataDir);
    await history.open('p1');
    const appended: HistoryEntryWire[] = [];
    const deps = sendDepsFor(seeded(), {
      history,
      showSecrets: { get: () => false },
      onHistoryAppended: (wire) => appended.push(wire),
    });

    const summary = await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });

    // As for a recorded secret: the sent headers and the raw exchange, where the echo server wrote
    // the header back, are masked in the response view; the short value is left as it is.
    const decode = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8');
    expect(summary.http.request?.headers['X-Sys']).toBe('<redacted>');
    const raw = decode(summary.http.rawRequestBase64 ?? '') + decode(summary.http.rawResponseBase64 ?? '');
    expect(raw).toContain('"x-sys":"<redacted>"');
    expect(raw).not.toContain(LONG_VALUE);
    expect(summary.url).toContain(SHORT_VALUE);
    expect(appended).toHaveLength(1);
    const onDisk = await readFile(historyFilePath(userDataDir, 'p1'), 'utf8');
    expect(onDisk).not.toContain(LONG_VALUE);
    expect(onDisk).toContain(SHORT_VALUE);
  });
});
