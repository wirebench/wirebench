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

/** A command that serves until `stop()`: the test's own stop, never a signal sent to the whole process. */
function serving(...[args, io]: Parameters<typeof mcpCommand>): {
  readonly done: Promise<ExitCode>;
  readonly stop: () => Promise<void>;
} {
  const controller = new AbortController();
  const done = mcpCommand(args, io, { stop: controller.signal });
  return {
    done,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

describe('wirebench mcp --http', () => {
  it.each(['short', 'has spaces inside the token value'])(
    'refuses the unusable token %j with exit 2, before listening',
    async (bad) => {
      const fixture = await soapProject();
      const stdout = capture();
      const stderr = capture();
      const code = await mcpCommand(
        { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, httpPort: 0 },
        { stdout: stdout.stream, stderr: stderr.stream, env: { WIREBENCH_MCP_TOKEN: bad } },
      );
      expect(code).toBe(ExitCode.Usage);
      expect(stderr.text()).toBe('WIREBENCH_MCP_TOKEN must be at least 16 characters with no spaces\n');
      expect(stdout.text()).toBe('');
    },
  );

  it('makes a token when the variable is only whitespace', async () => {
    const fixture = await soapProject();
    const stdout = capture();
    const stderr = capture();
    const { done, stop } = serving(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, httpPort: 0 },
      { stdout: stdout.stream, stderr: stderr.stream, env: { WIREBENCH_MCP_TOKEN: '   ' } },
    );
    try {
      await until(() => stderr.text().includes('bearer token'));
    } finally {
      await stop();
    }
    expect(await done).toBe(ExitCode.Ok);
  });

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
    const { done, stop } = serving(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, httpPort: 0 },
      { stdout: stdout.stream, stderr: stderr.stream, env: { WIREBENCH_MCP_TOKEN: token } },
    );
    try {
      await until(() => stderr.text().includes('serving'));
      expect(stderr.text()).toMatch(/at http:\/\/127\.0\.0\.1:\d+\/mcp \(write off, send off\)/);
      expect(stderr.text()).not.toContain(token);
      expect(stderr.text()).not.toContain('bearer token');
    } finally {
      await stop();
    }
    expect(await done).toBe(ExitCode.Ok);
    expect(stdout.text()).toBe('');
  });

  it('prints a generated token once, to stderr, and never to stdout', async () => {
    const fixture = await soapProject();
    const stdout = capture();
    const stderr = capture();
    const { done, stop } = serving(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, httpPort: 0 },
      { stdout: stdout.stream, stderr: stderr.stream, env: {} },
    );
    try {
      await until(() => stderr.text().includes('bearer token'));
      const [, token] = /bearer token \(set WIREBENCH_MCP_TOKEN to choose your own\): (\S+)/.exec(stderr.text()) ?? [];
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(stderr.text().split(token ?? '?')).toHaveLength(2);
    } finally {
      await stop();
    }
    expect(await done).toBe(ExitCode.Ok);
    expect(stdout.text()).toBe('');
  });
});
