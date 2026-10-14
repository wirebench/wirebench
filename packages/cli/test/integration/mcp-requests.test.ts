/**
 * MCP requests through the built CLI (#79): `send` on the stdio fixture with and without
 * `--allow-commands`, the body override refused, `run` against the Streamable HTTP helper, and the
 * `wirebench mcp` server's `send` tool on an MCP request. Each send that answers is in History.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createMcpRequest, createMcpServer, createProject, saveProject } from '@wirebench/engine';
import { MCP_STDIO_FIXTURE, startTestMcpHttpServer } from '@wirebench/engine/test-helpers';
import type { TestMcpHttpServer } from '@wirebench/engine/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, spawnCli } from './helpers.js';

let http: TestMcpHttpServer;
const temps: string[] = [];

beforeAll(async () => {
  http = await startTestMcpHttpServer({ json: true });
});

afterAll(async () => {
  await http.close();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-mcp-requests-'));
  temps.push(dir);
  return dir;
}

/** A project with a stdio server `Local` (`Echo` calls the echo tool) and an HTTP server `Remote` (`List`). */
async function writeMcpProject(): Promise<string> {
  const dir = await tempDir();
  const project = {
    ...createProject('MCP', { id: 'p-mcp' }),
    containers: {
      mcp: [
        createMcpServer('Local', {
          id: 's-local',
          order: 0,
          transport: { type: 'stdio', command: process.execPath, args: [MCP_STDIO_FIXTURE, 'sdk'], env: [] },
          requests: [
            createMcpRequest('Echo', {
              id: 'r-echo',
              operation: { method: 'tools/call', tool: 'echo', arguments: JSON.stringify({ text: 'hello' }) },
              assertions: [{ type: 'match', language: 'jsonpath', expression: '$.content[0].text', equals: 'hello' }],
            }),
          ],
        }),
        createMcpServer('Remote', {
          id: 's-remote',
          order: 1,
          transport: { type: 'http', url: http.url, headers: [] },
          requests: [
            createMcpRequest('List', {
              id: 'r-list',
              operation: { method: 'tools/list' },
              assertions: [{ type: 'match', language: 'jsonpath', expression: '$.tools[0].name', equals: 'echo' }],
            }),
          ],
        }),
      ],
    },
  };
  await saveProject(project, dir);
  return dir;
}

async function historyLines(historyDir: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(historyDir, 'p-mcp.jsonl'), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('wirebench send — an MCP request', () => {
  it('refuses a stdio server without --allow-commands, naming the command and the flag', async () => {
    const project = await writeMcpProject();
    const historyDir = await tempDir();
    const { code, stderr } = await runCli(['send', 'Local/Echo', '--project', project, '--history-dir', historyDir]);
    expect(code).toBe(3);
    expect(stderr).toContain('mcp-command-unapproved');
    expect(stderr).toContain('stdio-server.mjs');
    expect(stderr).toContain('--allow-commands');
    await expect(readFile(join(historyDir, 'p-mcp.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('sends with --allow-commands, prints the result as JSON and records History', async () => {
    const project = await writeMcpProject();
    const historyDir = await tempDir();
    const { code, stdout, stderr } = await runCli([
      'send',
      'Local/Echo',
      '--allow-commands',
      '--json',
      '--project',
      project,
      '--history-dir',
      historyDir,
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const sent = JSON.parse(stdout) as {
      kind: string;
      outcome: string;
      method: string;
      body: string;
      historyId: string;
    };
    expect(sent).toMatchObject({ kind: 'mcp', outcome: 'passed', method: 'tools/call' });
    expect(JSON.parse(sent.body)).toMatchObject({ content: [{ type: 'text', text: 'hello' }] });
    const [entry] = await historyLines(historyDir);
    expect(entry).toMatchObject({
      id: sent.historyId,
      kind: 'mcp',
      requestName: 'Echo',
      interfaceName: 'Local',
      method: 'tools/call',
      ok: true,
      tags: ['cli'],
    });
  });

  it('refuses a body override', async () => {
    const project = await writeMcpProject();
    const { code, stderr } = await runCli(['send', 'Remote/List', '--body', '{}', '--project', project]);
    expect(code).toBe(2);
    expect(stderr).toContain('is an MCP request; the body override');
  });

  it('refuses --allow-commands on a verb that sends nothing', async () => {
    const { code, stderr } = await runCli(['operations', '--allow-commands']);
    expect(code).toBe(2);
    expect(stderr).toContain('--allow-commands does not apply to wirebench operations');
  });
});

describe('wirebench run — MCP requests', () => {
  it('runs an HTTP server, which needs no approval, and passes its assertions', async () => {
    const project = await writeMcpProject();
    const json = join(await tempDir(), 'r.json');
    const { code } = await runCli(['run', project, 'Remote', '--reporter', `json=${json}`]);
    const report = JSON.parse(await readFile(json, 'utf8')) as {
      requests: { path: string; protocol: string; outcome: string }[];
    };
    expect(report.requests).toEqual([expect.objectContaining({ protocol: 'mcp', outcome: 'passed' })]);
    expect(code).toBe(0);
  });

  it('errors a stdio request without --allow-commands, with the flag in the advice, and runs it with it', async () => {
    const project = await writeMcpProject();
    const refused = await runCli(['run', project, 'Local', '--reporter', 'cli']);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).toContain('--allow-commands');
    const allowed = await runCli(['run', project, 'Local', '--allow-commands', '--reporter', 'cli']);
    expect(allowed.code).toBe(0);
  });
});

interface ToolResult {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
}

/** Starts `wirebench mcp` with `flags` on `project`, calls `send` once with `args`, and returns its result. */
async function callSend(
  project: string,
  historyDir: string,
  flags: readonly string[],
  args: object,
): Promise<ToolResult> {
  const child = spawnCli(['mcp', '--project', project, '--history-dir', historyDir, ...flags]);
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
  const answered = new Promise<ToolResult>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        if (line.includes('"id":2')) {
          resolve((JSON.parse(line) as { result: ToolResult }).result);
        }
      }
    });
    void exited.then(() => reject(new Error(`wirebench mcp exited before answering: ${stderr}`)));
  });
  const send = (message: object): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  send({
    id: 1,
    method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'send', arguments: args } });
  const result = await answered;
  child.stdin.end();
  await exited;
  return result;
}

describe('wirebench mcp — send on an MCP request', () => {
  it('sends a stdio request under --allow-commands and records History tagged mcp', async () => {
    const project = await writeMcpProject();
    const historyDir = await tempDir();
    const result = await callSend(project, historyDir, ['--allow-send', '--allow-commands'], { item: 'Local/Echo' });
    expect(result.isError).toBeUndefined();
    const sent = JSON.parse(result.content[0]?.text ?? '{}') as { kind: string; outcome: string; body: string };
    expect(sent).toMatchObject({ kind: 'mcp', outcome: 'passed' });
    expect(JSON.parse(sent.body)).toMatchObject({ content: [{ text: 'hello' }] });
    const [entry] = await historyLines(historyDir);
    expect(entry).toMatchObject({ kind: 'mcp', requestName: 'Echo', tags: ['mcp'] });
  });

  it('refuses a stdio request when the server was started without --allow-commands', async () => {
    const project = await writeMcpProject();
    const historyDir = await tempDir();
    const result = await callSend(project, historyDir, ['--allow-send'], { item: 'Local/Echo' });
    expect(result.isError).toBe(true);
    const refusal = JSON.parse(result.content[0]?.text ?? '{}') as { code: string; message: string };
    expect(refusal.code).toBe('mcp-command-unapproved');
    expect(refusal.message).toContain('--allow-commands');
  });
});
