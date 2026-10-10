// @vitest-environment node
/**
 * A REST send's History entry is written redacted whatever the session's show-secrets toggle says.
 * The send's summary is masked for the toggle (with it on, the URL an API key travels in shows the
 * key), and History is written to disk, so the endpoint is masked again before it is stored — the
 * same way its headers and bodies already are.
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

const KEY = 'good-key-9f3a';

let server: TestRestServer;
let userDataDir: string;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-rest-history-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

/** One API whose key travels in the query as `keyName`, holding request `req-1` at `url`. */
function seeded(keyName: string, url: string): Project {
  const api = createApi('Petstore', {
    id: 'api-1',
    baseUrl: server.url,
    auth: { type: 'api-key', name: keyName, in: 'query', valueRef: 'sec_key' },
    requests: [createRestRequest('Echo', { id: 'req-1', url, query: [entry('x', '1')] })],
  });
  return { ...createProject('Demo', { id: 'p1' }), containers: { rest: [api] } };
}

/** Sends `req-1` of `model` through main's REST path with show-secrets on, into a real History. */
async function sendShowingSecrets(model: Project): Promise<{ entry: HistoryEntryWire; onDisk: HistoryEntryWire }> {
  const history = new HistoryService(userDataDir);
  await history.open('p1');
  const appended: HistoryEntryWire[] = [];
  const deps = sendDepsFor(model, {
    getSecret: (ref) => Promise.resolve(ref === 'sec_key' ? KEY : undefined),
    history,
    showSecrets: { get: () => true },
    onHistoryAppended: (wire) => appended.push(wire),
  });

  const summary = await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });

  // With the toggle on, the live summary does show the key: that is the toggle's job.
  expect(summary.url).toContain(KEY);
  expect(appended).toHaveLength(1);
  // The line as written to disk, not just the wire shape handed back to the renderer.
  const line = (await readFile(historyFilePath(userDataDir, 'p1'), 'utf8')).trim();
  return { entry: appended[0]!, onDisk: JSON.parse(line) as HistoryEntryWire };
}

describe('a REST History entry sent with show-secrets on', () => {
  it('stores the endpoint with a query API key masked', async () => {
    const { entry: stored, onDisk } = await sendShowingSecrets(seeded('api_key', '/echo'));

    expect(stored.endpoint).toContain('api_key=%3Credacted%3E');
    expect(stored.endpoint).toContain('x=1');
    expect(stored.endpoint).not.toContain(KEY);
    expect(onDisk.endpoint).toBe(stored.endpoint);
    expect(JSON.stringify(onDisk.request)).not.toContain(KEY);
  });

  it('masks a key under a name no rule knows, by the name its auth is configured with', async () => {
    const { entry: stored, onDisk } = await sendShowingSecrets(seeded('sub', '/echo'));

    expect(stored.endpoint).toContain('sub=%3Credacted%3E');
    expect(stored.endpoint).not.toContain(KEY);
    expect(onDisk.endpoint).toBe(stored.endpoint);
  });
});
