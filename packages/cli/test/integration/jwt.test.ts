/**
 * A client-signed JWT (#348) from `wirebench run` and from the MCP `send` tool: the built CLI signs
 * the token with the HMAC secret it reads from `WIREBENCH_SECRET_<name>`, sends it, and masks it in
 * everything it prints — the echo server sends it straight back in the response body.
 */
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createApi, createProject, createRestRequest, saveProject, withRestApis } from '@wirebench/engine';
import { startTestRestServer } from '@wirebench/engine/test-helpers';
import type { TestRestServer } from '@wirebench/engine/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, spawnCli } from './helpers.js';

const SECRET = 'cli-jwt-secret-0123456789-abcdefghijklmnop';
const ENV = { WIREBENCH_SECRET_JWT_SECRET: SECRET };

let server: TestRestServer;
const temps: string[] = [];

beforeAll(async () => {
  server = await startTestRestServer();
});
afterAll(async () => {
  await server.close();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-jwt-'));
  temps.push(dir);
  return dir;
}

async function writeProject(dir: string): Promise<void> {
  await saveProject(
    withRestApis({ ...createProject('Jwt', { id: 'p-jwt' }) }, [
      {
        ...createApi('Svc', {
          id: 'api-svc',
          slug: 'svc',
          baseUrl: server.url,
          auth: {
            type: 'jwt',
            algorithm: 'HS256',
            secretRef: 'sec_jwt',
            secretEnv: 'JWT_SECRET',
            claims: '{"sub":"cli"}',
            issuedAt: true,
            expiresInSeconds: 300,
            jwtId: false,
            in: 'header',
          },
        }),
        requests: [createRestRequest('Call', { id: 'r1', slug: 'call', url: '/echo' })],
      },
    ]),
    dir,
  );
}

/** The bearer token the server received last, checked against the secret. */
function lastToken(): string {
  const header = server.requests.at(-1)?.headers['authorization'];
  const token = (typeof header === 'string' ? header : '').replace(/^Bearer /u, '');
  const [head = '', body = '', signature = ''] = token.split('.');
  expect(createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')).toBe(signature);
  expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toMatchObject({ sub: 'cli' });
  return token;
}

describe('wirebench run — a client-signed JWT', () => {
  it('signs with the secret from the environment and masks the token in its report', async () => {
    const project = await tempDir();
    await writeProject(project);
    const json = join(await tempDir(), 'r.json');

    const { code, stdout } = await runCli(['run', project, '--reporter', `json=${json}`], ENV);

    expect(code).toBe(0);
    const token = lastToken();
    expect(stdout).not.toContain(token);
    expect(await readFile(json, 'utf8')).not.toContain(token);
  });

  it('refuses the request when the secret is not supplied', async () => {
    const project = await tempDir();
    await writeProject(project);
    const before = server.requests.length;
    const { code, stdout, stderr } = await runCli(['run', project]);
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain('JWT_SECRET');
    expect(server.requests.length).toBe(before);
  });
});

describe('wirebench mcp — send with a client-signed JWT', () => {
  it('sends the signed token and masks it in the tool result', async () => {
    const project = await tempDir();
    const historyDir = await tempDir();
    await writeProject(project);
    const child = spawnCli(['mcp', '--project', project, '--allow-send', '--history-dir', historyDir], ENV);
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

    expect(result.isError).not.toBe(true);
    const token = lastToken();
    expect(result.content.map((part) => part.text).join('\n')).not.toContain(token);
  });
});
