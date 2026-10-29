// @vitest-environment node
/**
 * What the server host keeps of an agent send (hosted edition spec §18.4): History, trimmed as History trims
 * a body; the audit log's `desktop.request_sent`, as for a send of its own; and, for a send that failed on the
 * agent, the same History entry and HTTP Log row a failed send of its own leaves.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApi,
  createProject,
  createRestRequest,
  resolveScopes,
  type DesktopAuditEvent,
  type Project,
} from '@wirebench/engine';
import { HISTORY_BODY_MAX_CHARS, historyBody } from '@wirebench/wire/history-body';
import { channels } from '@wirebench/wire/ipc';
import type { FailedExchangeWire } from '@wirebench/wire/wire-base';
import { createHostState } from '../src/host/host-state.js';
import { HistoryService } from '../src/history-service.js';
import { HandlerTable } from '../src/ipc/register.js';
import type { RequestChannelDeps } from '../src/ipc/request.js';
import { registerSendRouteChannels } from '../src/ipc/send-route.js';
import { RoutePins, routePinsPath } from '../src/send-route.js';
import { sendDepsFor } from './helpers/send-deps.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wirebench-records-'));
  dirs.push(dir);
  return dir;
}

function model(): Project {
  const api = createApi('Pets', {
    id: 'api-1',
    baseUrl: 'http://127.0.0.1:9',
    requests: [createRestRequest('Get pet', { id: 'req-1', url: '/pets/1' })],
  });
  return {
    ...createProject('Demo', { id: 'p1' }),
    environments: [
      { id: 'env-1', name: 'Dev', slug: 'dev', order: 0, endpoints: {}, properties: {}, disabledProperties: [] },
    ],
    activeEnvironmentId: 'env-1',
    containers: { rest: [api] },
  };
}

function restResult(text: string, rawBody = text) {
  return {
    sendId: 'send-1',
    durationMs: 12,
    http: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/plain' },
      rawHeaders: [['content-type', 'text/plain']] as [string, string][],
      bodyBase64: '',
      rawBodyBase64: '',
      rawRequestBase64: Buffer.from('GET /pets/1 HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n').toString('base64'),
      rawResponseBase64: Buffer.from(`HTTP/1.1 200 OK\r\n\r\n${rawBody}`).toString('base64'),
      truncated: false,
      httpVersion: '1.1' as const,
      timings: { startedAt: new Date().toISOString(), totalMs: 12 },
      redirects: [],
      request: { url: 'http://127.0.0.1:9/pets/1?api_key=k-1', method: 'GET', headers: {} },
    },
    url: 'http://127.0.0.1:9/pets/1?api_key=k-1',
    method: 'GET',
    text,
    language: 'text' as const,
    cookies: [],
    methodChanged: false,
    problems: [],
    sentFrom: 'agent' as const,
  };
}

function failure(stage?: 'prepare'): FailedExchangeWire {
  return {
    sendId: 'tab-send-1',
    protocol: 'rest',
    requestId: 'req-1',
    request: {
      url: 'http://127.0.0.1:9/pets/1',
      method: 'POST',
      // Masked on the agent already; masked again here all the same.
      headers: { authorization: 'Bearer tok-plain', 'x-trace': 'abc' },
    },
    rawRequestBase64: Buffer.from('POST /pets/1 HTTP/1.1\r\nx-trace: abc\r\n\r\n{"a":1}').toString('base64'),
    startedAt: new Date().toISOString(),
    durationMs: 7,
    error: { code: 'connection-refused', message: 'connect ECONNREFUSED 127.0.0.1:9' },
    ...(stage !== undefined ? { stage } : {}),
  };
}

async function serverHost() {
  const project = model();
  const hostState = createHostState();
  const history = new HistoryService(tempDir(), hostState.redactor, undefined, { sendOrigin: 'server' });
  await history.open('p1');
  const table = new HandlerTable(hostState.redactor);
  const send = sendDepsFor(project, {
    project: {
      runContextFor: () => ({ project, projectDir: '/tmp/none', environmentId: 'env-1', globals: {} }),
      scopesFor: () => resolveScopes(project, 'env-1', {}, {}),
    },
  });
  const audited: [DesktopAuditEvent, string | undefined][] = [];
  const rows: FailedExchangeWire[] = [];
  const deps = {
    hostState,
    project: send.project,
    history,
    audit: (event: DesktopAuditEvent, workspaceId: string | undefined) => audited.push([event, workspaceId]),
    auditWorkspace: () => 'ws_1',
    onSendFailed: (row: FailedExchangeWire) => rows.push(row),
  } as unknown as RequestChannelDeps;
  registerSendRouteChannels(table, deps, {
    send,
    pins: new RoutePins(routePinsPath(tempDir())),
    serverWorkspaceId: () => 'ws_1',
  });
  const call = (name: string, request: unknown) => table.get(name)!(request, { id: 1 } as never);
  return { history, call, audited, rows };
}

describe('an agent send recorded on the server host', () => {
  it('keeps a body the tab trimmed as History cut it, and the response size the tab names', async () => {
    const { call, history } = await serverHost();
    const whole = 'x'.repeat(HISTORY_BODY_MAX_CHARS + 5000);
    const answer = await call(channels.exchanges.recordAgentSend.name, {
      projectId: 'p1',
      itemId: 'req-1',
      kind: 'rest',
      result: restResult(historyBody(whole), ''),
      responseBytes: 30 * 1024 * 1024,
    });
    expect(answer).toMatchObject({ ok: true });
    const entry = history.list({ projectId: 'p1' }).entries[0];
    expect(entry?.response?.envelopeXml).toBe(historyBody(whole));
    expect(entry?.response?.envelopeXml?.endsWith('… truncated, 5000 more characters')).toBe(true);
    expect(entry?.sizeBytes).toBe(30 * 1024 * 1024);
  });

  it('refuses an untrimmed body over the cap, so no frame of one is ever built for the server socket', async () => {
    const { call } = await serverHost();
    const answer = await call(channels.exchanges.recordAgentSend.name, {
      projectId: 'p1',
      itemId: 'req-1',
      kind: 'rest',
      result: restResult('x'.repeat(3 * 1024 * 1024), ''),
    });
    expect(answer).toMatchObject({ ok: false, error: { code: 'ipc-invalid-request' } });
  });

  it('tells the audit log of it as of a send of its own: `desktop.request_sent`, the URL masked', async () => {
    const { call, audited } = await serverHost();
    await call(channels.exchanges.recordAgentSend.name, {
      projectId: 'p1',
      itemId: 'req-1',
      kind: 'rest',
      result: restResult('{}'),
    });
    expect(audited).toHaveLength(1);
    const [event, workspaceId] = audited[0]!;
    expect(workspaceId).toBe('ws_1');
    expect(event).toMatchObject({
      action: 'desktop.request_sent',
      details: {
        protocol: 'rest',
        method: 'GET',
        status: 200,
        outcome: 'ok',
        durationMs: 12,
        environment: 'Dev',
        requestId: 'req-1',
        requestName: 'Get pet',
      },
    });
    expect((event.details as { url: string }).url).not.toContain('k-1');
  });
});

describe('a failed agent send recorded on the server host', () => {
  it('leaves the History entry, the HTTP Log row (under the tab’s send id) and the audit event a failed send leaves', async () => {
    const { call, history, rows, audited } = await serverHost();
    const answer = await call(channels.exchanges.recordAgentFailure.name, {
      projectId: 'p1',
      itemId: 'req-1',
      kind: 'rest',
      failure: failure(),
    });
    expect(answer).toMatchObject({ ok: true, value: { entry: { sentFrom: 'agent', ok: false } } });
    expect(history.list({ projectId: 'p1' }).entries[0]).toMatchObject({
      requestId: 'req-1',
      method: 'POST',
      endpoint: 'http://127.0.0.1:9/pets/1',
      ok: false,
      sentFrom: 'agent',
      error: { code: 'connection-refused' },
      request: { envelopeXml: '{"a":1}' },
    });
    expect(rows).toEqual([expect.objectContaining({ sendId: 'tab-send-1', error: failure().error })]);
    expect(rows[0]?.request.headers['authorization']).not.toContain('tok-plain');
    expect(rows[0]?.request.headers['x-trace']).toBe('abc');
    expect(audited.map(([event]) => event.details)).toEqual([
      expect.objectContaining({ outcome: 'failed', status: null, method: 'POST' }),
    ]);
  });

  it('leaves the HTTP Log row alone for a send that failed while it was prepared, as on the server', async () => {
    const { call, history, rows, audited } = await serverHost();
    const answer = await call(channels.exchanges.recordAgentFailure.name, {
      projectId: 'p1',
      itemId: 'req-1',
      kind: 'rest',
      failure: failure('prepare'),
    });
    expect(answer).toEqual({ ok: true, value: {} });
    expect(history.list({ projectId: 'p1' }).entries).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(audited).toEqual([]);
  });
});
