import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpCommand } from '../../../src/commands/mcp.js';
import { ExitCode } from '../../../src/exit-codes.js';
import { removeTempDirs, soapProject } from '../ops/helpers.js';

afterEach(removeTempDirs);

const ARGS = { command: 'mcp', allowWrite: false, allowSend: false } as const;

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { stream, text: () => text };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(done()).toBe(true);
}

describe('wirebench mcp --http', () => {
  it('says so and exits 3 when the port is taken', async () => {
    const fixture = await soapProject();
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    try {
      const stdout = capture();
      const stderr = capture();
      const code = await mcpCommand(
        {
          ...ARGS,
          project: fixture.dir,
          historyDir: fixture.historyDir,
          httpPort: (taken.address() as AddressInfo).port,
        },
        { stdout: stdout.stream, stderr: stderr.stream, env: {} },
      );
      expect(code).toBe(ExitCode.RunError);
      expect(stderr.text()).toContain('cannot listen on 127.0.0.1:');
      expect(stderr.text()).not.toContain('bearer token');
      expect(stdout.text()).toBe('');
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it('serves on a chosen port with WIREBENCH_MCP_TOKEN and prints no token when it was given', async () => {
    const fixture = await soapProject();
    const stdout = capture();
    const stderr = capture();
    const token = 'abc123def456ghi789abc123def456ghi789';
    const done = mcpCommand(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, httpPort: 0 },
      { stdout: stdout.stream, stderr: stderr.stream, env: { WIREBENCH_MCP_TOKEN: token } },
    );
    await until(() => stderr.text().includes('serving'));
    expect(stderr.text()).toMatch(/at http:\/\/127\.0\.0\.1:\d+\/mcp \(write off, send off\)/);
    expect(stderr.text()).not.toContain(token);
    expect(stderr.text()).not.toContain('bearer token');
    process.emit('SIGINT');
    expect(await done).toBe(ExitCode.Ok);
    expect(stdout.text()).toBe('');
  });

  it('prints a generated token once, to stderr, and never to stdout', async () => {
    const fixture = await soapProject();
    const stdout = capture();
    const stderr = capture();
    const done = mcpCommand(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, httpPort: 0 },
      { stdout: stdout.stream, stderr: stderr.stream, env: {} },
    );
    await until(() => stderr.text().includes('bearer token'));
    const [, token] = /bearer token \(set WIREBENCH_MCP_TOKEN to choose your own\): (\S+)/.exec(stderr.text()) ?? [];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stderr.text().split(token ?? '?')).toHaveLength(2);
    process.emit('SIGINT');
    expect(await done).toBe(ExitCode.Ok);
    expect(stdout.text()).toBe('');
  });
});
