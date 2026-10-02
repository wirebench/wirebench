/**
 * `wirebench run` over streams: a WebSocket request sends its saved messages and waits for a reply,
 * a server-streaming gRPC call reads every message to its end, and both pass, the call on a `match`
 * over the messages it received. A stream the `--timeout` cuts errors with `timeout`, never passes.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestGrpcServer, startTestWsServer } from '@wirebench/engine/test-helpers';
import type { TestGrpcServer, TestWsServer } from '@wirebench/engine/test-helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './helpers.js';
import { writeStreamsProject } from './streams-project.js';
import type { StreamCall } from './streams-project.js';

let grpc: TestGrpcServer;
let ws: TestWsServer;
/** Never answers a text, nor the client's close. */
let deaf: TestWsServer;
const temps: string[] = [];

beforeAll(async () => {
  grpc = await startTestGrpcServer();
  ws = await startTestWsServer();
  deaf = await startTestWsServer({ onText: () => undefined, ignoreClose: true });
});

afterAll(async () => {
  await Promise.all([grpc.close(), ws.close(), deaf.close()]);
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wirebench-streams-'));
  temps.push(dir);
  return dir;
}

interface JsonReport {
  readonly requests: readonly {
    readonly path: string;
    readonly protocol: string;
    readonly outcome: string;
    readonly unasserted: boolean;
    readonly assertions: readonly { readonly type: string; readonly outcome: string }[];
    readonly error?: { readonly code: string };
  }[];
}

async function run(
  options: { wsUrl: string; calls: readonly StreamCall[] },
  extra: readonly string[] = [],
): Promise<{ code: number; stdout: string; report: JsonReport }> {
  const project = await tempDir();
  await writeStreamsProject(project, { wsUrl: options.wsUrl, grpcTarget: grpc.target, calls: options.calls });
  const json = join(await tempDir(), 'r.json');
  const { code, stdout } = await runCli(['run', project, '--reporter', 'cli', '--reporter', `json=${json}`, ...extra]);
  return { code, stdout, report: JSON.parse(await readFile(json, 'utf8')) as JsonReport };
}

describe('wirebench run — streams', () => {
  it('passes a WebSocket request and a server-streaming gRPC call, the call on a match', async () => {
    const { code, stdout, report } = await run({
      wsUrl: ws.url,
      calls: [
        {
          name: 'replies',
          method: 'LotsOfReplies',
          kind: 'server-streaming',
          message: { count: 3 },
          assertions: [{ type: 'match', language: 'jsonpath', expression: '$[2].message', equals: 'Hello #3' }],
        },
      ],
    });
    expect(report.requests.map((r) => [r.path, r.protocol, r.outcome])).toEqual([
      ['Chat/Echo', 'websocket', 'passed'],
      ['Greeter/replies', 'grpc', 'passed'],
    ]);
    expect(report.requests[0]?.unasserted).toBe(true);
    expect(report.requests[1]?.assertions).toEqual([expect.objectContaining({ type: 'match', outcome: 'passed' })]);
    expect(code).toBe(0);
    expect(stdout).toContain('Chat/Echo');
  });

  it('errors a WebSocket session and a gRPC stream the --timeout cuts, with timeout', async () => {
    const { code, report } = await run(
      {
        wsUrl: deaf.url,
        calls: [
          {
            name: 'slow',
            method: 'LotsOfReplies',
            kind: 'server-streaming',
            message: { count: 5, delay_ms: 1000 },
            assertions: [{ type: 'match', language: 'jsonpath', expression: '$[0].message', equals: 'Hello #1' }],
          },
        ],
      },
      ['--timeout', '300'],
    );
    expect(report.requests.map((r) => [r.path, r.outcome, r.error?.code])).toEqual([
      ['Chat/Echo', 'errored', 'timeout'],
      ['Greeter/slow', 'errored', 'timeout'],
    ]);
    expect(code).toBe(3);
  });
});
