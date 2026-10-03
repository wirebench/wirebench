// @vitest-environment node
/**
 * What a send through the engine tells the audit log (desktop audit events spec §2.2): one
 * `desktop.request_sent` per saved request's send, with the URL masked, successful or failed on the
 * wire. A run's step, a send that failed while it was prepared and an ad-hoc send report nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import { createApi, createProject, createRestRequest, entry } from '@wirebench/engine';
import type { DesktopAuditEvent, Environment, Project } from '@wirebench/engine';
import { sendThroughEngine } from '../src/main/send/exchange.js';
import { sendDepsFor } from './helpers/send-deps.js';

const KEY = 'audit-key-5b1e77';
const secrets = (ref: string): Promise<string | undefined> => Promise.resolve(ref === 'sec_key' ? KEY : undefined);

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

const QA: Environment = {
  id: 'env-qa',
  name: 'QA',
  slug: 'qa',
  order: 0,
  endpoints: {},
  properties: {},
  disabledProperties: [],
};

/** One API whose key travels in the query, holding `req-1` at `/echo`. */
function seeded(baseUrl = server.url): Project {
  const api = createApi('Petstore', {
    id: 'api-1',
    baseUrl,
    auth: { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' },
    requests: [createRestRequest('Echo', { id: 'req-1', url: '/echo', query: [entry('x', '1')] })],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api], environments: [QA] };
}

function audited(model: Project, extra: Parameters<typeof sendDepsFor>[1] = {}) {
  const events: DesktopAuditEvent[] = [];
  const deps = sendDepsFor(model, {
    getSecret: secrets,
    audit: (event) => events.push(event),
    ...extra,
  });
  return { deps, events };
}

describe('the audit hook of a send through the engine', () => {
  it('reports a saved request once, with the URL masked, its status and the environment', async () => {
    const model = seeded();
    const { deps, events } = audited(model, {
      project: {
        runContextFor: () => ({ project: model, projectDir: '/tmp/none', environmentId: 'env-qa', globals: {} }),
      },
    });

    await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' }, envId: 'env-qa' });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      action: 'desktop.request_sent',
      details: {
        protocol: 'rest',
        method: 'GET',
        status: 200,
        outcome: 'ok',
        environment: 'QA',
        requestId: 'req-1',
        requestName: 'Echo',
      },
    });
    const details = event!.details as { url: string; durationMs: number; sentAt: string };
    expect(details.url.startsWith(`${server.url}/echo?x=1&api_key=`)).toBe(true);
    expect(details.url).not.toContain(KEY);
    expect(Number.isInteger(details.durationMs)).toBe(true);
    expect(Number.isNaN(Date.parse(details.sentAt))).toBe(false);
  });

  it('names no environment when none is active', async () => {
    const { deps, events } = audited(seeded());
    await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });
    expect(events[0]?.details).toMatchObject({ environment: null });
  });

  it('reports a send that failed on the wire as failed, with no status', async () => {
    // Nothing listens on port 1: the send fails on the wire, after it was prepared.
    const { deps, events } = audited(seeded('http://127.0.0.1:1'));

    await expect(sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } })).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'desktop.request_sent',
      details: { protocol: 'rest', method: 'GET', status: null, outcome: 'failed', requestId: 'req-1' },
    });
    const { url } = events[0]!.details as { url: string };
    // Where it was going, with the auth's query rows applied as a successful send's URL has them.
    expect(url.startsWith('http://127.0.0.1:1/echo?x=1&api_key=')).toBe(true);
    expect(url).not.toContain(KEY);
  });

  it('reports nothing for a send that failed while it was prepared', async () => {
    const { deps, events } = audited(seeded(), {
      project: { proxyFor: () => Promise.reject(new Error('no proxy today')) },
    });
    await expect(sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } })).rejects.toThrow('no proxy today');
    expect(events).toEqual([]);
  });

  it("reports nothing for a run's step: the run's own event covers it", async () => {
    const { deps, events } = audited(seeded());
    await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' }, run: true });
    expect(events).toEqual([]);
  });

  it('reports nothing for a request no project owns', async () => {
    const { deps, events } = audited(seeded(), { project: { projectId: () => undefined } });
    await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });
    expect(events).toEqual([]);
  });

  it('hands the hook the workspace that was open when the send started', async () => {
    const reported: (string | undefined)[] = [];
    let open = 'ws-A';
    const deps = sendDepsFor(seeded(), {
      getSecret: secrets,
      audit: (_event, workspaceId) => reported.push(workspaceId),
      auditWorkspace: () => {
        const now = open;
        // Another workspace is open by the time the send ends.
        open = 'ws-B';
        return now;
      },
    });
    await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });
    expect(reported).toEqual(['ws-A']);
  });

  it('a hook that throws never fails the send', async () => {
    const deps = sendDepsFor(seeded(), {
      getSecret: secrets,
      audit: vi.fn(() => {
        throw new Error('outbox gone');
      }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const summary = await sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } });
    expect(summary.http.status).toBe(200);
    vi.restoreAllMocks();
  });
});
