// @vitest-environment node
/**
 * A server may echo a credential back: `/echo` reflects the query and the request headers in its
 * body, and a redirect can carry a key in its `Location`. The header and parameter rules only mask
 * a credential where it was sent, so main records the one each send's auth resolves to — in the form
 * it travels, never a bare password — and every redaction helper masks it wherever it turns up. The
 * HTTP log follows the show-secrets toggle; History, written to disk, is masked either way.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import { createApi, createProject, createRestRequest, entry, resolveApiBaseUrl } from '@wirebench/engine';
import type { AuthConfig, Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { buildRestHistoryEntry, HistoryService, historyFilePath } from '../src/main/history-service.js';
import { sendRestRequest, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { resolveRestSend } from '../src/main/rest-send.js';
import type { HistoryEntryWire, RestExchangeSummary } from '../src/shared/wire-types.js';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

const KEY = 'echoed-key-4c1e';
const TOKEN = 'echoed-token-7b2d';

let server: TestRestServer;
let userDataDir: string;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-rest-echo-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

/** One API authenticating with `auth`, holding request `req-1`: `/echo?x=<x>`. */
function seeded(auth: AuthConfig, x = '1'): Project {
  const api = createApi('Petstore', {
    id: 'api-1',
    baseUrl: server.url,
    auth,
    requests: [createRestRequest('Echo', { id: 'req-1', url: '/echo', query: [entry('x', x)] })],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api] };
}

const SECRETS: Readonly<Record<string, string>> = { sec_key: KEY, sec_token: TOKEN, sec_pass: 'admin' };

interface Sent {
  /** What the send resolved with: the HTTP log's row, masked for the toggle. */
  readonly summary: RestExchangeSummary;
  /** The History line as written to disk. */
  readonly line: string;
  readonly stored: HistoryEntryWire;
}

/** Sends `req-1` of `model` through main's REST path, into a real History. */
async function send(model: Project, showSecrets: boolean): Promise<Sent> {
  const engine = new EngineService((ref) => Promise.resolve(SECRETS[ref]));
  const history = new HistoryService(userDataDir);
  await history.open('p1');
  const deps: RequestChannelDeps = {
    project: {
      projectId: () => 'p1',
      restSend: (requestId: string) =>
        resolveRestSend({
          project: model,
          requestId,
          scopes: { project: {}, global: {}, system: {} },
          resolveBaseUrl: (api) => resolveApiBaseUrl(model, undefined, api),
        }),
    } as unknown as RequestChannelDeps['project'],
    history,
    showSecrets: { get: () => showSecrets },
  };

  const summary = await sendRestRequest(engine, deps, { sendId: 's1', requestId: 'req-1' });
  const line = (await readFile(historyFilePath(userDataDir, 'p1'), 'utf8')).trim();
  return { summary, line, stored: JSON.parse(line) as HistoryEntryWire };
}

/** The raw response as the HTTP log shows it. */
function rawResponse(summary: RestExchangeSummary): string {
  return Buffer.from(summary.http.rawResponseBase64, 'base64').toString('utf8');
}

describe('a credential a server echoes back', () => {
  it('masks a query API key echoed in the body, in History and in the HTTP log', async () => {
    const { summary, line, stored } = await send(
      seeded({ type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' }),
      false,
    );

    // The server did echo it: the response pane shows the body as it arrived.
    expect(summary.text).toContain(KEY);
    expect(stored.response?.envelopeXml).toContain('"api_key":"<redacted>"');
    expect(stored.response?.envelopeXml).toContain('"x":"1"');
    expect(line).not.toContain(KEY);
    expect(rawResponse(summary)).not.toContain(KEY);
    expect(rawResponse(summary)).toContain('<redacted>');
  });

  it('keeps History masked with show-secrets on, while the HTTP log shows the key', async () => {
    const { summary, line } = await send(
      seeded({ type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' }),
      true,
    );

    expect(rawResponse(summary)).toContain(KEY);
    expect(line).not.toContain(KEY);
  });

  it('masks a key in a response header value, such as a redirect Location', async () => {
    const { summary } = await send(
      seeded({ type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' }),
      true,
    );
    const redirected: RestExchangeSummary = {
      ...summary,
      http: {
        ...summary.http,
        rawHeaders: [...summary.http.rawHeaders, ['Location', `${server.url}/next?api_key=${KEY}&page=2`]],
      },
    };

    const history = buildRestHistoryEntry('p1', {
      requestId: 'req-1',
      requestName: 'Echo',
      apiName: 'Petstore',
      folderPath: '',
      method: 'GET',
      url: summary.url,
      requestHeaders: {},
      requestBody: '',
      exchange: redirected,
      durationMs: 1,
    });

    const location = history.response?.rawHeaders.find(([name]) => name === 'Location');
    expect(location?.[1]).toBe(`${server.url}/next?api_key=<redacted>&page=2`);
    expect(JSON.stringify(history)).not.toContain(KEY);
  });

  it('masks a bearer token echoed with the request headers', async () => {
    const { line, stored } = await send(seeded({ type: 'bearer', tokenRef: 'sec_token' }), true);

    expect(stored.response?.envelopeXml).toContain('Bearer <redacted>');
    expect(line).not.toContain(TOKEN);
  });

  it("masks Basic's encoded pair, not the password as ordinary text", async () => {
    // The password `admin` is also a query value here, and stays one: only the encoded pair the
    // Authorization header carried is recorded.
    const { line, stored } = await send(
      seeded({ type: 'basic', username: 'root', passwordRef: 'sec_pass' }, 'admin'),
      true,
    );
    const pair = Buffer.from('root:admin', 'utf-8').toString('base64');

    expect(stored.response?.envelopeXml).toContain('Basic <redacted>');
    expect(stored.response?.envelopeXml).toContain('"x":"admin"');
    expect(stored.endpoint).toContain('x=admin');
    expect(line).not.toContain(pair);
  });
});
