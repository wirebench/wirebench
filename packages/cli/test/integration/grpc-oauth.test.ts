/**
 * `wirebench run` over the fixture's unary gRPC API and its OAuth2-protected REST API: both sit
 * behind the same client-credentials configuration, so a run fetches one token for all of them,
 * and neither the client secret nor the token it bought may reach stdout, stderr or any report.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestGrpcServer } from '@wirebench/engine/test-helpers';
import type { TestGrpcServer } from '@wirebench/engine/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_TOKEN, CLIENT_SECRET, FIXTURE, runCli, startDemoServer } from './helpers.js';
import type { DemoServer } from './helpers.js';

let demo: DemoServer;
let grpc: TestGrpcServer;
const temps: string[] = [];

beforeAll(async () => {
  demo = await startDemoServer();
  grpc = await startTestGrpcServer();
});

afterAll(async () => {
  await demo.close();
  await grpc.close();
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-grpc-'));
  temps.push(dir);
  return dir;
}

const secretEnv = { WIREBENCH_SECRET_OAUTH_SECRET: CLIENT_SECRET };

async function runWithReports(selectors: readonly string[]): Promise<{
  code: number;
  outputs: string[];
  json: { requests: readonly { path: string; protocol: string; outcome: string; status?: number }[] };
}> {
  const dir = await tempDir();
  const files = { junit: join(dir, 'r.xml'), json: join(dir, 'r.json'), html: join(dir, 'r.html') };
  const { code, stdout, stderr } = await runCli(
    [
      'run',
      FIXTURE,
      '-e',
      'local',
      '--var',
      `baseUrl=${demo.url}`,
      '--var',
      `grpcTarget=${grpc.target}`,
      '--verbose',
      '--reporter',
      'cli',
      '--reporter',
      `junit=${files.junit}`,
      '--reporter',
      `json=${files.json}`,
      '--reporter',
      `html=${files.html}`,
      ...selectors,
    ],
    secretEnv,
  );
  const reports = await Promise.all([files.junit, files.json, files.html].map((file) => readFile(file, 'utf8')));
  return {
    code,
    outputs: [stdout, stderr, ...reports],
    json: JSON.parse(reports[1] ?? '') as Awaited<ReturnType<typeof runWithReports>>['json'],
  };
}

function expectNoCredential(outputs: readonly string[]): void {
  for (const output of outputs) {
    expect(output).not.toContain(ACCESS_TOKEN);
    expect(output).not.toContain(CLIENT_SECRET);
  }
}

describe('wirebench run — gRPC and OAuth2 client credentials', () => {
  it('exits 0 when the gRPC call and the protected REST request pass, on one token', async () => {
    const issuedBefore = demo.tokensIssued();
    const callsBefore = grpc.calls.length;
    const { code, outputs, json } = await runWithReports(['greeter/hello', 'oauth/profile']);
    expect(code).toBe(0);
    expect(outputs[0]).toContain('✓ greeter/hello');
    expect(outputs[0]).toContain('✓ oauth/profile');
    expect(json.requests.map((r) => [r.path, r.protocol, r.outcome])).toEqual([
      ['greeter/hello', 'grpc', 'passed'],
      ['oauth/profile', 'rest', 'passed'],
    ]);
    expect(json.requests[0]?.status).toBe(0);
    expect(demo.tokensIssued() - issuedBefore).toBe(1);
    expect(grpc.calls.slice(callsBefore).map((call) => call.headers['authorization'])).toEqual([
      `Bearer ${ACCESS_TOKEN}`,
    ]);
    expectNoCredential(outputs);
  });

  it('exits 1 on a failing gRPC status assertion and names the status, still leaking nothing', async () => {
    const { code, outputs, json } = await runWithReports(['greeter/missing']);
    expect(code).toBe(1);
    expect(json.requests[0]).toMatchObject({ protocol: 'grpc', outcome: 'failed', status: 5 });
    expect(outputs[0]).toContain('NOT_FOUND');
    expectNoCredential(outputs);
  });

  it('errors the protected request, naming the variable, when the client secret is not set', async () => {
    const { code, stdout } = await runCli([
      'run',
      FIXTURE,
      '-e',
      'local',
      '--var',
      `baseUrl=${demo.url}`,
      'oauth/profile',
    ]);
    expect(code).toBe(3);
    expect(stdout).toContain('WIREBENCH_SECRET_OAUTH_SECRET');
  });
});
