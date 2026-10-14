/**
 * Scripts on MCP requests in a run (#79), against the stdio fixture and the Streamable HTTP helper:
 * a pre-request script changes a tool call's arguments and the server gets the change; a
 * post-response script's `tests` and `vars` work, a later request sending what it set; a script that
 * moves an HTTP server to another origin, or gives a stdio server a URL, is refused before anything
 * is dialled or spawned; and a secret in the server URL stays behind its placeholder for the script.
 */
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../../../src/index.js';
import { createMcpRequest, createMcpServer } from '../../../src/mcp/model.js';
import type { McpOperation, McpRequestDef, McpServer, McpTransport } from '../../../src/mcp/model.js';
import type { Project } from '../../../src/project/model.js';
import type { RunContext } from '../../../src/run/context.js';
import type { CommandApprovalRequest } from '../../../src/run/host.js';
import { runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { createScriptChecker } from '../../../src/script/check/host.js';
import type { RequestScripts } from '../../../src/script/model.js';
import { RequestScripting } from '../../../src/script/request-scripts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { startTestMcpHttpServer } from '../../helpers/mcp-http-server.js';
import type { TestMcpHttpServer } from '../../helpers/mcp-http-server.js';
import { testHost } from '../../helpers/send-host.js';

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/mcp/stdio-server.mjs');
const PROJECT_DIR = resolve(import.meta.dirname, '../../fixtures');
const KEY = 'mcp-key-7731';

let http: TestMcpHttpServer;
const sandbox = createScriptSandbox();
const checker = createScriptChecker();

beforeAll(async () => {
  http = await startTestMcpHttpServer({ json: true });
});

afterAll(async () => {
  await http.close();
  await sandbox.dispose();
  await checker.dispose();
});

const stdio: McpTransport = { type: 'stdio', command: process.execPath, args: [FIXTURE, 'sdk'], cwd: 'mcp', env: [] };

const echo = (text: string): McpOperation => ({
  method: 'tools/call',
  tool: 'echo',
  arguments: JSON.stringify({ text }),
});

const scripts = (extra: Partial<RequestScripts>): RequestScripts => ({
  api: 'wirebench',
  enabled: true,
  secrets: [],
  ...extra,
});

function request(name: string, order: number, operation: McpOperation, extra: Partial<McpRequestDef> = {}) {
  return createMcpRequest(name, { id: `r-${String(order)}`, order, operation, ...extra });
}

function project(server: McpServer): Project {
  return { ...createProject('MCP', { id: 'p-mcp-scripts' }), containers: { mcp: [server] } };
}

async function run(server: McpServer) {
  const asked: CommandApprovalRequest[] = [];
  const p = project(server);
  const context: RunContext = {
    project: p,
    projectDir: PROJECT_DIR,
    overrides: {},
    host: testHost({ 'secret:mcp_key': KEY }, { approveCommand: (req) => (asked.push(req), Promise.resolve(true)) }),
    scripting: new RequestScripting({ sandbox, checker }),
  };
  const result = await runRequests(selectRequests(p, []).selected, context);
  return { result, asked };
}

const echoed = { type: 'match', language: 'jsonpath', expression: '$.content[0].text' } as const;

describe('scripts on MCP requests', () => {
  it('a pre-request script changes the arguments, and a post-response one tests and sets vars', async () => {
    const server = createMcpServer('Local', {
      id: 's-local',
      transport: stdio,
      requests: [
        request('Changed', 0, echo('as saved'), {
          assertions: [{ ...echoed, equals: 'changed by the script' }],
          scripts: scripts({
            pre: {
              text: "if (request.method === 'tools/call') request.arguments = { text: 'changed by the script' };\n",
            },
            post: {
              text: [
                "test('answered', () => expect(response.isError).toBe(false));",
                "test('the fixture', () => expect(response.serverInfo?.name ?? '').toBe('fixture'));",
                'const first = response.result?.content?.[0] as { text: string } | undefined;',
                "vars.set('said', first?.text ?? '');",
                '',
              ].join('\n'),
            },
          }),
        }),
        request('Next', 1, echo('${#Sequence#said}'), { assertions: [{ ...echoed, equals: 'changed by the script' }] }),
      ],
    });
    const { result } = await run(server);
    expect(result.requests.map((row) => [row.name, row.outcome])).toEqual([
      ['Changed', 'passed'],
      ['Next', 'passed'],
    ]);
    expect(result.requests[0]!.assertions).toEqual(
      expect.arrayContaining([
        { type: 'script', label: 'answered', outcome: 'passed' },
        { type: 'script', label: 'the fixture', outcome: 'passed' },
      ]),
    );
  }, 30_000);

  it('refuses a script that moves an HTTP server to another origin, before any call', async () => {
    const before = http.requests.length;
    const server = createMcpServer('Remote', {
      id: 's-remote',
      transport: { type: 'http', url: http.url, headers: [] },
      requests: [
        request('Moved', 0, echo('x'), {
          scripts: scripts({ pre: { text: "request.url = 'http://evil.test/mcp';\n" } }),
        }),
      ],
    });
    const { result } = await run(server);
    expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'script-origin-change' } });
    expect(http.requests.length).toBe(before);
  });

  it('refuses a script that gives a stdio server a URL, and spawns nothing', async () => {
    const server = createMcpServer('Local', {
      id: 's-local',
      transport: stdio,
      requests: [
        request('Moved', 0, echo('x'), {
          scripts: scripts({ pre: { text: "request.url = 'http://evil.test/mcp';\n" } }),
        }),
      ],
    });
    const { result, asked } = await run(server);
    expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'script-origin-change' } });
    expect(asked).toEqual([]);
  });

  it('a secret in the server URL stays behind its placeholder for the script, and goes on the wire', async () => {
    const before = http.requests.length;
    const server = createMcpServer('Remote', {
      id: 's-remote',
      transport: { type: 'http', url: `${http.url}?k=\${secret:mcp_key}`, headers: [] },
      requests: [
        request('Keyed', 0, echo('x'), {
          scripts: scripts({
            pre: { text: "request.url = request.url + '&trace=1';\n" },
            post: { text: `test('hidden', () => expect(request.url.indexOf('${KEY}')).toBe(-1));\n` },
          }),
        }),
      ],
    });
    const { result } = await run(server);
    expect(result.requests[0]).toMatchObject({ outcome: 'passed' });
    expect(result.requests[0]!.assertions).toContainEqual({ type: 'script', label: 'hidden', outcome: 'passed' });
    const posts = http.requests.slice(before).filter((one) => one.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.url).toBe(`/mcp?k=${KEY}&trace=1`);
  });
});
