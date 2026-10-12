/**
 * `wirebench run` and the MCP `send` tool with Digest and AWS Signature v4 (#339): credentials come
 * from `WIREBENCH_SECRET_*` under the names the project declares, the SigV4 region is a property
 * reference, and none of the values reaches a report.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createApi, createProject, createRestRequest, saveProject, withRestApis } from '@wirebench/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, spawnCli } from './helpers.js';

const PASSWORD = 'digest-password-long-339';
const KEY_ID = 'AKIDCLI339EXAMPLE';
const SECRET_KEY = 'secret-access-key-long-339';
/** MD5 of `admin:wb:<PASSWORD>`, Digest's HA1, written out so the test server never hashes the password. */
const HA1 = 'b9a72a78e21a40db6833a5a8504c990f';
const ENV = {
  WIREBENCH_SECRET_DIGEST_PW: PASSWORD,
  WIREBENCH_SECRET_AWS_KEY: KEY_ID,
  WIREBENCH_SECRET_AWS_SECRET: SECRET_KEY,
};

let server: Server;
let base: string;
const authorizations: string[] = [];
const temps: string[] = [];

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? '';
    authorizations.push(authorization);
    if (request.url === '/digest') {
      const response_ = /response="([0-9a-f]+)"/.exec(authorization)?.[1];
      const nc = /nc=([0-9a-f]+)/.exec(authorization)?.[1] ?? '';
      const cnonce = /cnonce="([^"]+)"/.exec(authorization)?.[1] ?? '';
      const expected = md5(`${HA1}:n339:${nc}:${cnonce}:auth:${md5('GET:/digest')}`);
      if (response_ === expected) {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      } else {
        response.writeHead(401, { 'www-authenticate': 'Digest realm="wb", qop="auth", nonce="n339"' }).end();
      }
      return;
    }
    const signed =
      authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${KEY_ID}/`) &&
      authorization.includes('/eu-west-1/execute-api/aws4_request') &&
      typeof request.headers['x-amz-date'] === 'string';
    response.writeHead(signed ? 200 : 403, { 'content-type': 'application/json' }).end('{"signed":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-339-'));
  temps.push(dir);
  return dir;
}

async function writeProject(dir: string): Promise<void> {
  await saveProject(
    withRestApis({ ...createProject('Auth339', { id: 'p-339' }), properties: { region: 'eu-west-1' } }, [
      {
        ...createApi('Svc', { id: 'api-svc', slug: 'svc', baseUrl: base }),
        requests: [
          createRestRequest('Digest', {
            id: 'r-digest',
            slug: 'digest',
            url: '/digest',
            auth: { type: 'digest', username: 'admin', passwordRef: 'ref-digest', passwordEnv: 'DIGEST_PW' },
          }),
          createRestRequest('Signed', {
            id: 'r-signed',
            slug: 'signed',
            url: '/signed',
            auth: {
              type: 'aws-sigv4',
              region: '${#Project#region}',
              service: 'execute-api',
              accessKeyIdRef: 'ref-key',
              accessKeyIdEnv: 'AWS_KEY',
              secretAccessKeyRef: 'ref-secret',
              secretAccessKeyEnv: 'AWS_SECRET',
            },
          }),
        ],
      },
    ]),
    dir,
  );
}

describe('wirebench run — Digest and AWS Signature v4', () => {
  it('sends both from WIREBENCH_SECRET_* and keeps the values out of the report', async () => {
    const project = await tempDir();
    await writeProject(project);
    const json = join(await tempDir(), 'r.json');

    const { code, stdout, stderr } = await runCli(['run', project, '--reporter', `json=${json}`], ENV);

    expect(stderr).not.toContain(PASSWORD);
    expect(code, stdout + stderr).toBe(0);
    const text = await readFile(json, 'utf8');
    const report = JSON.parse(text) as { requests: { name: string; outcome: string; status?: number }[] };
    expect(report.requests.map((request) => request.outcome)).toEqual(['passed', 'passed']);
    for (const secret of [PASSWORD, KEY_ID, SECRET_KEY]) expect(text + stdout).not.toContain(secret);
    expect(authorizations.some((value) => value.startsWith('Digest '))).toBe(true);
  });

  it('refuses the signed request when its secret is not supplied', async () => {
    const project = await tempDir();
    await writeProject(project);
    const json = join(await tempDir(), 'r.json');

    const { code } = await runCli(['run', project, 'Svc/Signed', '--reporter', `json=${json}`], {
      WIREBENCH_SECRET_AWS_KEY: KEY_ID,
    });

    expect(code).not.toBe(0);
    const report = JSON.parse(await readFile(json, 'utf8')) as { requests: { error?: { code: string } }[] };
    expect(report.requests[0]?.error?.code).toBe('secret-missing');
  });
});

describe('wirebench mcp — send with AWS Signature v4', () => {
  it('signs the request', async () => {
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
    send({ id: 2, method: 'tools/call', params: { name: 'send', arguments: { item: 'Svc/Signed' } } });
    const result = await answered;
    child.stdin.end();
    await exited;

    expect(result.isError, result.content[0]?.text).not.toBe(true);
    const text = result.content.map((part) => part.text).join('\n');
    expect(text).toContain('200');
    expect(text).not.toContain(KEY_ID);
    expect(text).not.toContain(SECRET_KEY);
  });
});
