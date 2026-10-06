import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpCommand } from '../../../src/commands/mcp.js';
import { ExitCode } from '../../../src/exit-codes.js';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import { emptyProject, manyOperationsOpenApi, removeTempDirs, soapProject } from '../ops/helpers.js';
import { DEFAULT_CLI_SECRET_SOURCES } from '../../../src/source-secrets.js';

afterEach(removeTempDirs);

const ARGS = {
  command: 'mcp',
  allowWrite: false,
  allowSend: false,
  secretSources: DEFAULT_CLI_SECRET_SOURCES,
} as const;

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

describe('wirebench mcp and the contract tools', () => {
  it('writes the contract tool count after the serving line, on stderr', async () => {
    const fixture = await soapProject();
    const stdout = capture();
    const stderr = capture();
    const { done, stop } = serving(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, httpPort: 0 },
      { stdout: stdout.stream, stderr: stderr.stream, env: { WIREBENCH_MCP_TOKEN: 'abc123def456ghi789' } },
    );
    try {
      await until(() => stderr.text().includes('contract tools'));
      expect(stderr.text()).toMatch(/wirebench mcp: serving .+\nwirebench mcp: 1 contract tools\n/);
    } finally {
      await stop();
    }
    expect(await done).toBe(ExitCode.Ok);
    expect(stdout.text()).toBe('');
  });

  it('writes no count line with --tools none', async () => {
    const fixture = await soapProject();
    const stdout = capture();
    const stderr = capture();
    const { done, stop } = serving(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, httpPort: 0, tools: [] },
      { stdout: stdout.stream, stderr: stderr.stream, env: { WIREBENCH_MCP_TOKEN: 'abc123def456ghi789' } },
    );
    try {
      await until(() => stderr.text().includes('serving'));
    } finally {
      await stop();
    }
    expect(await done).toBe(ExitCode.Ok);
    expect(stderr.text()).not.toContain('contract tools');
  });

  it('refuses to start above the cap with exit 2, naming --tools, before serving', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await manyOperationsOpenApi(130) }, fixture.base());
    const stdout = capture();
    const stderr = capture();
    const code = await mcpCommand(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, httpPort: 0 },
      { stdout: stdout.stream, stderr: stderr.stream, env: { WIREBENCH_MCP_TOKEN: 'abc123def456ghi789' } },
    );
    expect(code).toBe(ExitCode.Usage);
    expect(stderr.text()).toMatch(/^too-many-tools: 130 contract operations .*--tools/);
    expect(stderr.text()).not.toContain('serving');
    expect(stdout.text()).toBe('');
  });

  it('refuses an unknown --tools name with exit 2', async () => {
    const fixture = await soapProject();
    const stderr = capture();
    const code = await mcpCommand(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir, tools: ['Nope'] },
      { stdout: capture().stream, stderr: stderr.stream, env: {} },
    );
    expect(code).toBe(ExitCode.Usage);
    expect(stderr.text()).toMatch(/^container-not-found: /);
  });

  it('in stdio mode writes the count line to stderr and nothing to stdout', async () => {
    const fixture = await soapProject();
    const stdin = new PassThrough();
    const stdout = capture();
    const stderr = capture();
    const done = mcpCommand(
      { ...ARGS, project: fixture.dir, historyDir: fixture.historyDir },
      { stdout: stdout.stream, stderr: stderr.stream, env: {} },
      { stdin },
    );
    await until(() => stderr.text().includes('contract tools'));
    expect(stderr.text()).toMatch(/on stdio \(write off, send off\)\nwirebench mcp: 1 contract tools\n/);
    stdin.end();
    expect(await done).toBe(ExitCode.Ok);
    expect(stdout.text()).toBe('');
  });
});
