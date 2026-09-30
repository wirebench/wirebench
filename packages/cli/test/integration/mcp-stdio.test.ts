/**
 * The one thing only a real process shows: in stdio mode stdout carries protocol frames and
 * nothing else, while the startup line and every warning go to stderr.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, spawnCli } from './helpers.js';

let historyDir: string;

beforeAll(async () => {
  historyDir = await mkdtemp(join(tmpdir(), 'wirebench-mcp-history-'));
});

afterAll(async () => {
  await rm(historyDir, { recursive: true, force: true });
});

describe('wirebench mcp on stdio', () => {
  it('writes only JSON-RPC frames to stdout, and exits 0 when stdin ends', async () => {
    const child = spawnCli(['mcp', '--project', FIXTURE, '--history-dir', historyDir]);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const answered = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('"id":3')) {
          resolve();
        }
      });
    });
    const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));

    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'history_list', arguments: {} } });
    await answered;
    child.stdin.end();

    expect(await exited).toBe(0);
    const frames = stdout.trim().split('\n');
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const frame of frames) {
      expect(JSON.parse(frame)).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(stderr).toContain('wirebench mcp: serving');
  });

  it('refuses a folder that is not a project before serving anything', async () => {
    const child = spawnCli(['mcp', '--project', historyDir]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number>((resolve) => child.on('close', (exit) => resolve(exit ?? -1)));
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^project-not-found: .+/m);
  });
});
