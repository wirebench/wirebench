/**
 * An MCP request through the registry as a run and a host send it (#79): an API run against the stdio
 * fixture and the Streamable HTTP helper with assertions and the "MCP result" check, the approval
 * gate, live message events, credentials on every call, and a sequence step.
 */
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../../../src/index.js';
import type { McpLiveEvent } from '#protocol-mcp/mcp/events';
import { commandFingerprint } from '#protocol-mcp/mcp/approval';
import { createMcpRequest, createMcpServer } from '#protocol-mcp/mcp/model';
import type { McpOperation, McpRequestDef, McpServer, McpTransport } from '#protocol-mcp/mcp/model';
import { mcpItemFor } from '#protocol-mcp/mcp/run';
import type { Project } from '#core/project/model';
import type { RunContext } from '#core/run/context';
import type { CommandApprovalRequest, SendFailure, SendHost } from '#core/run/host';
import { openExchange } from '#core/run/open';
import { createRunSender, runRequests } from '#core/run/run';
import { createRunScope } from '#core/run/scope';
import { selectRequests } from '#core/run/select';
import { createSequence, createSequenceStep } from '#core/sequence/model';
import { runSequence } from '#core/sequence/run';
import { startTestMcpHttpServer } from '../../helpers/mcp-http-server.js';
import type { TestMcpHttpServer } from '../../helpers/mcp-http-server.js';
import { testHost } from '../../helpers/send-host.js';

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/mcp/stdio-server.mjs');
const PROJECT_DIR = resolve(import.meta.dirname, '../../fixtures');

let http: TestMcpHttpServer;

beforeAll(async () => {
  http = await startTestMcpHttpServer({ json: true });
});

afterAll(async () => {
  await http.close();
});

const stdio = (mode = 'sdk', extra: Partial<Extract<McpTransport, { type: 'stdio' }>> = {}): McpTransport => ({
  type: 'stdio',
  command: process.execPath,
  args: [FIXTURE, mode],
  cwd: 'mcp',
  env: [],
  ...extra,
});

const echo = (text: string): McpOperation => ({
  method: 'tools/call',
  tool: 'echo',
  arguments: JSON.stringify({ text }),
});

function request(name: string, operation: McpOperation, extra: Partial<McpRequestDef> = {}): McpRequestDef {
  return createMcpRequest(name, { id: `r-${name.toLowerCase().replace(/\s+/g, '-')}`, operation, ...extra });
}

function project(servers: readonly McpServer[], properties: Record<string, string> = {}): Project {
  return { ...createProject('MCP', { id: 'p-mcp' }), properties, containers: { mcp: servers } };
}

/** A host that approves every command and records what it was asked. */
function approving(secrets: Record<string, string> = {}): { host: SendHost; asked: CommandApprovalRequest[] } {
  const asked: CommandApprovalRequest[] = [];
  return {
    asked,
    host: testHost(secrets, {
      approveCommand: (req) => {
        asked.push(req);
        return Promise.resolve(true);
      },
    }),
  };
}

function context(p: Project, host: SendHost): RunContext {
  return { project: p, projectDir: PROJECT_DIR, overrides: {}, host };
}

describe('an MCP API run', () => {
  it('runs every request against the stdio fixture, with assertions and the MCP result check', async () => {
    const server = createMcpServer('Local', {
      id: 's-local',
      order: 1,
      transport: stdio(),
      requests: [
        request(
          'List',
          { method: 'tools/list' },
          {
            order: 0,
            assertions: [{ type: 'match', language: 'jsonpath', expression: '$.tools[0].name', exists: true }],
          },
        ),
        request('Echo', echo('hello ${who}'), {
          order: 1,
          assertions: [
            { type: 'match', language: 'jsonpath', expression: '$.content[0].text', equals: 'hello "world"' },
          ],
        }),
        request('Fail', { method: 'tools/call', tool: 'fail', arguments: '' }, { order: 2 }),
      ],
    });
    const p = project([server], { who: '"world"' });
    const { host } = approving();
    const result = await runRequests(selectRequests(p, []).selected, context(p, host));
    const rows = result.requests.map((row) => ({
      name: row.name,
      protocol: row.protocol,
      outcome: row.outcome,
      checks: row.assertions.map((a) => [a.label, a.outcome]),
    }));
    expect(rows[0]).toMatchObject({ name: 'List', protocol: 'mcp', outcome: 'passed' });
    expect(rows[0]!.checks).toContainEqual(['MCP result', 'passed']);
    // The quotes in the property were JSON-escaped into the arguments, so the server got them back.
    expect(rows[1]).toMatchObject({ name: 'Echo', outcome: 'passed' });
    expect(rows[2]).toMatchObject({ name: 'Fail', outcome: 'failed' });
    expect(result.requests[2]!.assertions).toContainEqual(
      expect.objectContaining({ label: 'MCP result', outcome: 'failed', actual: 'it went wrong' }),
    );
  }, 30_000);

  it('runs against the Streamable HTTP helper with the server headers and a bearer token on every call', async () => {
    const before = http.requests.length;
    const server = createMcpServer('Remote', {
      id: 's-remote',
      transport: {
        type: 'http',
        url: http.url,
        headers: [{ name: 'X-Trace', value: '${trace}', enabled: true }],
        auth: { type: 'bearer', tokenRef: 'ref-mcp-token' },
      },
      requests: [
        request('Echo', echo('over http'), {
          assertions: [
            { type: 'status', equals: 200 },
            { type: 'match', language: 'jsonpath', expression: '$.content[0].text', equals: 'over http' },
          ],
        }),
      ],
    });
    const p = project([server], { trace: 't-1' });
    const result = await runRequests(
      selectRequests(p, []).selected,
      context(p, testHost({ 'ref-mcp-token': 'tok-abc' })),
    );
    expect(result.requests[0]).toMatchObject({ protocol: 'mcp', outcome: 'passed' });
    const posts = http.requests.slice(before).filter((one) => one.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const post of posts) {
      expect(post.headers['authorization']).toBe('Bearer tok-abc');
      expect(post.headers['x-trace']).toBe('t-1');
    }
  });

  it('a run against a server that exits fails rather than passes', async () => {
    const server = createMcpServer('Crash', {
      id: 's-crash',
      transport: stdio('crash'),
      requests: [request('List', { method: 'tools/list' })],
    });
    const p = project([server]);
    const result = await runRequests(selectRequests(p, []).selected, context(p, approving().host));
    expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'mcp-server-exited' } });
  });
});

describe('the stdio approval', () => {
  const built = () => {
    const server = createMcpServer('Local', {
      id: 's-local',
      transport: stdio('sdk', {
        args: [FIXTURE, 'sdk', '--token', '${secret:arg_token}'],
        env: [
          { name: 'B_VAR', value: 'two', enabled: true },
          { name: 'A_VAR', value: '${secret:env_token}', enabled: true },
          { name: 'OFF', value: 'x', enabled: false },
        ],
      }),
      requests: [request('List', { method: 'tools/list' })],
    });
    return { p: project([server]), item: mcpItemFor(project([server]), 'r-list')! };
  };

  it('refuses a stdio send when the host lends no approveCommand, naming the command, and spawns nothing', async () => {
    const { p, item } = built();
    const failures: SendFailure[] = [];
    const host = testHost(
      { 'secret:arg_token': 'argsecret1', 'secret:env_token': 'envsecret1' },
      { events: { onFailed: (_item, failure) => failures.push(failure) } },
    );
    const handle = openExchange(item, host, { scope: createRunScope(context(p, host)), interactive: false });
    const error = await handle.result.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'mcp-command-unapproved', details: { server: 'Local' } });
    expect((error as Error).message).toContain(process.execPath);
    expect((error as Error).message).not.toContain('argsecret1');
    expect(failures).toMatchObject([{ stage: 'prepare' }]);
  });

  it('refuses when the host answers false', async () => {
    const { p, item } = built();
    const host = testHost(
      { 'secret:arg_token': 'argsecret1', 'secret:env_token': 'envsecret1' },
      { approveCommand: () => Promise.resolve(false) },
    );
    const handle = openExchange(item, host, { scope: createRunScope(context(p, host)), interactive: false });
    await expect(handle.result).rejects.toMatchObject({ code: 'mcp-command-unapproved' });
  });

  it('asks once per send, with the fingerprint of the expanded command line and the env names only', async () => {
    const { p, item } = built();
    const { host, asked } = approving({ 'secret:arg_token': 'argsecret1', 'secret:env_token': 'envsecret1' });
    const sent = await openExchange(item, host, { scope: createRunScope(context(p, host)), interactive: false }).result;
    expect(sent.exchange?.kind).toBe('mcp');
    expect(asked).toHaveLength(1);
    const cwd = resolve(PROJECT_DIR, 'mcp');
    expect(asked[0]).toEqual({
      fingerprint: commandFingerprint({
        command: process.execPath,
        args: [FIXTURE, 'sdk', '--token', 'argsecret1'],
        cwd,
        envNames: ['A_VAR', 'B_VAR'],
      }),
      display: `${process.execPath} ${FIXTURE} sdk --token '\${secret:arg_token}'`,
      cwd,
      envNames: ['A_VAR', 'B_VAR'],
      serverName: 'Local',
    });
    expect(JSON.stringify(asked)).not.toContain('envsecret1');
    expect(JSON.stringify(asked)).not.toContain('argsecret1');
  }, 20_000);

  it('never asks for an HTTP server', async () => {
    const server = createMcpServer('Remote', {
      id: 's-remote',
      transport: { type: 'http', url: http.url, headers: [] },
      requests: [request('List', { method: 'tools/list' })],
    });
    const p = project([server]);
    const asked: CommandApprovalRequest[] = [];
    const host = testHost({}, { approveCommand: (req) => (asked.push(req), Promise.resolve(false)) });
    const sent = await openExchange(mcpItemFor(p, 'r-list')!, host, {
      scope: createRunScope(context(p, host)),
      interactive: false,
    }).result;
    expect(sent.subject.status).toBe(200);
    expect(asked).toEqual([]);
  });
});

describe('an MCP send through openExchange', () => {
  it('reports each message as a live event, in order', async () => {
    const server = createMcpServer('Local', {
      id: 's-local',
      transport: stdio(),
      requests: [request('Echo', echo('hi'))],
    });
    const p = project([server]);
    const { host } = approving();
    const handle = openExchange(mcpItemFor(p, 'r-echo')!, host, {
      scope: createRunScope(context(p, host)),
      interactive: false,
      live: true,
    });
    const events: McpLiveEvent[] = [];
    for await (const event of handle.events) events.push(event as McpLiveEvent);
    const sent = await handle.result;
    expect(events.map((e) => [e.message.direction, e.message.method])).toEqual([
      ['sent', 'initialize'],
      ['received', 'initialize'],
      ['sent', 'notifications/initialized'],
      ['sent', 'tools/call'],
      ['received', 'tools/call'],
    ]);
    expect(new TextDecoder().decode(sent.raw.rawRequest)).toContain('"tools/call"');
    expect(new TextDecoder().decode(sent.raw.rawResponse)).toContain('"hi"');
    expect(sent.checks).toEqual([expect.objectContaining({ label: 'MCP result', outcome: 'passed' })]);
  }, 20_000);

  it('refuses a reference nothing resolves before anything runs', async () => {
    const server = createMcpServer('Local', {
      id: 's-local',
      transport: stdio(),
      requests: [request('Echo', echo('${nowhere}'))],
    });
    const p = project([server]);
    const { host, asked } = approving();
    const handle = openExchange(mcpItemFor(p, 'r-echo')!, host, {
      scope: createRunScope(context(p, host)),
      interactive: false,
    });
    await expect(handle.result).rejects.toMatchObject({ code: 'mcp-unresolved-properties' });
    expect(asked).toEqual([]);
  });

  it("a host's own send keeps a session that could not finish as its result", async () => {
    const server = createMcpServer('Crash', {
      id: 's-crash',
      transport: stdio('crash'),
      requests: [request('List', { method: 'tools/list' })],
    });
    const p = project([server]);
    const { host } = approving();
    const sent = await openExchange(mcpItemFor(p, 'r-list')!, host, {
      scope: createRunScope(context(p, host)),
      interactive: false,
    }).result;
    const mcp = sent.exchange?.kind === 'mcp' ? sent.exchange.mcp : undefined;
    expect(mcp?.failure?.code).toBe('mcp-server-exited');
    expect(mcp?.stderr).toContain('cannot open the database');
    expect(sent.checks).toEqual([expect.objectContaining({ label: 'MCP result', outcome: 'failed' })]);
  });

  it('the run timeout wins over the request timeout, which wins over the server timeout', async () => {
    const server = createMcpServer('Silent', {
      id: 's-silent',
      transport: stdio('silent'),
      settings: { timeoutMs: 60_000 },
      requests: [request('List', { method: 'tools/list' }, { settings: { timeoutMs: 300 } })],
    });
    const p = project([server]);
    const { host } = approving();
    const started = Date.now();
    const result = await runRequests(selectRequests(p, []).selected, context(p, host));
    expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'mcp-timeout' } });
    expect(Date.now() - started).toBeLessThan(10_000);
    const resolved = (await import('#core/run/open')).resolveExchange(
      mcpItemFor(p, 'r-list')!,
      host,
      createRunScope({ ...context(p, host), timeoutMs: 1234 }),
    );
    await expect(resolved).resolves.toMatchObject({ input: { timeoutMs: 1234 } });
  }, 20_000);
});

describe('an MCP sequence step', () => {
  it('sends the step and lifts a value from its result', async () => {
    const server = createMcpServer('Local', {
      id: 's-local',
      transport: stdio(),
      requests: [request('Echo', echo('step one'))],
    });
    const p = project([server]);
    const { host } = approving();
    const sender = createRunSender(context(p, host));
    const sequence = createSequence('Flow', {
      id: 'q',
      steps: [
        createSequenceStep('r-echo', {
          id: 'step-1',
          transfers: [{ name: 'said', from: 'body', language: 'jsonpath', expression: '$.content[0].text' }],
        }),
      ],
    });
    const run = await runSequence(sequence, p, async (step, scope) => {
      const sent = await sender(step.selected, { sequence: scope });
      return { subject: sent.subject, ...(sent.checks !== undefined ? { checks: sent.checks } : {}) };
    });
    expect(run.steps[0]).toMatchObject({ protocol: 'mcp', outcome: 'passed' });
    expect(run.steps[0]!.assertions).toContainEqual(
      expect.objectContaining({ label: 'MCP result', outcome: 'passed' }),
    );
    expect(run.steps[0]!.transfers).toEqual([expect.objectContaining({ name: 'said', outcome: 'set' })]);
  }, 20_000);
});
