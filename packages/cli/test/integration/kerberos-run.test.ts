/**
 * `wirebench run` and the MCP `send` tool on a Kerberos request. Both start the built CLI as a child
 * process, so a fake provider cannot be configured in-process: only the unavailable case is covered
 * here, with the binding made unloadable in the child (`NODE_OPTIONS=--require=<fixture>`, which
 * makes `kerberos/package.json` throw MODULE_NOT_FOUND). The available path is covered in the engine.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { startNegotiateServer } from '@wirebench/engine/test-helpers';
import type { NegotiateServer } from '@wirebench/engine/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, spawnCli } from './helpers.js';
import { NO_KERBEROS_ENV, writeKerberosProject } from './kerberos-project.js';

let server: NegotiateServer;
const temps: string[] = [];

beforeAll(async () => {
  server = await startNegotiateServer({ expectedToken: 'unused' });
});
afterAll(async () => {
  await server.close();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-krb-'));
  temps.push(dir);
  return dir;
}

describe('wirebench run — Kerberos unavailable', () => {
  it('errors the request with kerberos-unavailable and exits 3', async () => {
    const project = await tempDir();
    await writeKerberosProject(project, new URL(server.url).origin);
    const json = join(await tempDir(), 'r.json');

    const { code } = await runCli(['run', project, '--reporter', `json=${json}`], NO_KERBEROS_ENV);

    expect(code).toBe(3);
    const report = JSON.parse(await readFile(json, 'utf8')) as {
      requests: { outcome: string; error?: { code: string } }[];
    };
    expect(report.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'kerberos-unavailable' } });
    // The challenge round trip happens; no token is ever sent.
    expect(server.requests.every((entry) => entry.authorization === undefined)).toBe(true);
  });
});

describe('wirebench mcp — send with Kerberos unavailable', () => {
  it('returns a tool error carrying kerberos-unavailable', async () => {
    const project = await tempDir();
    const historyDir = await tempDir();
    await writeKerberosProject(project, new URL(server.url).origin);
    const child = spawnCli(['mcp', '--project', project, '--allow-send', '--history-dir', historyDir], NO_KERBEROS_ENV);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
    const answered = new Promise<{ isError?: boolean; content: { text: string }[] }>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        for (const line of stdout.split('\n')) {
          if (line.includes('"id":2')) resolve((JSON.parse(line) as { result: never }).result);
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
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'send', arguments: { item: 'Svc/Call' } } });
    const result = await answered;
    child.stdin.end();
    await exited;

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({ code: 'kerberos-unavailable' });
    // The challenge round trip happens; no token is ever sent.
    expect(server.requests.every((entry) => entry.authorization === undefined)).toBe(true);
  });
});
