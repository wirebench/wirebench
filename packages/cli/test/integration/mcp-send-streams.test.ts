/**
 * The MCP `send` tool on a WebSocket request, over a real `wirebench mcp` on stdio: it sends the
 * saved messages, waits for a reply, closes, returns the frames it collected and appends a History
 * entry tagged `mcp`. A dead endpoint is refused with `ws-handshake-refused`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { startTestWsServer } from '@wirebench/engine/test-helpers';
import type { TestWsServer } from '@wirebench/engine/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnCli } from './helpers.js';
import { writeStreamsProject } from './streams-project.js';

let ws: TestWsServer;
const temps: string[] = [];

beforeAll(async () => {
  ws = await startTestWsServer();
});

afterAll(async () => {
  await ws.close();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-mcp-streams-'));
  temps.push(dir);
  return dir;
}

interface ToolResult {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text: string }[];
}

/** Starts `wirebench mcp --allow-send` on `project`, calls `send` once with `args`, and returns its result. */
async function callSend(project: string, historyDir: string, args: object): Promise<ToolResult> {
  const child = spawnCli(['mcp', '--project', project, '--allow-send', '--history-dir', historyDir]);
  let stdout = '';
  const answered = new Promise<ToolResult>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of stdout.split('\n')) {
        if (line.includes('"id":2')) {
          resolve((JSON.parse(line) as { result: ToolResult }).result);
        }
      }
    });
  });
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
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

describe('wirebench mcp — send on a WebSocket request', () => {
  it('returns the collected frames and appends a History entry', async () => {
    const project = await tempDir();
    const historyDir = await tempDir();
    await writeStreamsProject(project, { wsUrl: ws.url });

    const result = await callSend(project, historyDir, { item: 'Chat/Echo' });

    expect(result.isError).toBeUndefined();
    const sent = JSON.parse(result.content[0]?.text ?? '{}') as {
      kind: string;
      outcome: string;
      status: number;
      body: string;
      historyId: string;
      frames: readonly { direction: string; opcode: string; text?: string }[];
    };
    expect(sent).toMatchObject({ kind: 'websocket', outcome: 'passed', status: 101 });
    const texts = sent.frames.filter((frame) => frame.opcode === 'text').map((frame) => [frame.direction, frame.text]);
    expect(texts.slice(0, 3)).toEqual([
      ['sent', 'one'],
      ['sent', 'two'],
      ['received', 'one'],
    ]);
    expect((JSON.parse(sent.body) as string[])[0]).toBe('one');

    const lines = (await readFile(join(historyDir, 'p-streams.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      id: sent.historyId,
      kind: 'websocket',
      requestName: 'Echo',
      interfaceName: 'Chat',
      ok: true,
      tags: ['mcp'],
    });
  });

  it('refuses a dead endpoint with ws-handshake-refused, and writes no History', async () => {
    const project = await tempDir();
    const historyDir = await tempDir();
    await writeStreamsProject(project, { wsUrl: 'ws://127.0.0.1:1' });

    const result = await callSend(project, historyDir, { item: 'Chat/Echo' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ code: 'ws-handshake-refused' });
    await expect(readFile(join(historyDir, 'p-streams.jsonl'), 'utf8')).rejects.toThrow();
  });
});
