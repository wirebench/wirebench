import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mcpStdioEnv,
  mcpStdioParentEnvNames,
  openStdioTransport,
  resolveMcpCwd,
  type McpStdioTransport,
} from '#protocol-mcp/mcp/stdio';
import { runMcpSession, type McpOperationCall } from '#protocol-mcp/mcp/session';

const FIXTURE = resolve(import.meta.dirname, '../../fixtures/mcp/stdio-server.mjs');
const FIXTURE_DIR = resolve(import.meta.dirname, '../../fixtures/mcp');

const opened: McpStdioTransport[] = [];

function transport(mode: string, extra: Partial<Parameters<typeof openStdioTransport>[0]> = {}): McpStdioTransport {
  const t = openStdioTransport({
    command: process.execPath,
    args: [FIXTURE, mode],
    cwd: FIXTURE_DIR,
    env: {},
    ...extra,
  });
  opened.push(t);
  return t;
}

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const send = (t: McpStdioTransport, operation: McpOperationCall, timeoutMs = 10_000) =>
  runMcpSession({ transport: t, operation, clientVersion: '1.0.0', timeoutMs });

afterEach(async () => {
  // No test may leave a child behind, whatever it asserted.
  await Promise.all(opened.splice(0).map((t) => t.close({ force: true })));
});

describe('mcpStdioEnv and resolveMcpCwd', () => {
  it('passes only the allowlisted parent variables, then the transport’s own', () => {
    const env = mcpStdioEnv(
      { PATH: '/bin', HOME: '/h', SECRET_TOKEN: 'no', LANG: 'C', USERPROFILE: '/u' },
      { LANG: 'fr', API_KEY: 'k' },
      'linux',
    );
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LANG: 'fr', API_KEY: 'k' });
  });

  it('adds the Windows profile variables on Windows, matching names in any case', () => {
    const env = mcpStdioEnv(
      { Path: 'C:\\bin', USERPROFILE: 'C:\\u', AppData: 'C:\\a', SECRET_TOKEN: 'no' },
      {},
      'win32',
    );
    expect(env).toEqual({ Path: 'C:\\bin', USERPROFILE: 'C:\\u', AppData: 'C:\\a' });
  });

  it('runs in the project folder, or cwd against it', () => {
    expect(resolveMcpCwd('/p', undefined)).toBe(resolve('/p'));
    expect(resolveMcpCwd('/p', 'tools/srv')).toBe(join(resolve('/p'), 'tools', 'srv'));
  });
});

describe('stdio transport against the fixture', () => {
  it('lists tools from the SDK server', async () => {
    const t = transport('sdk');
    const outcome = await send(t, { method: 'tools/list', capability: 'tools' });
    expect(outcome.failure).toBeUndefined();
    const result = (outcome.response as { result: { tools: { name: string }[] } }).result;
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'env', 'fail']);
    expect(outcome.initialize).toMatchObject({ serverInfo: { name: 'fixture', version: '1.2.3' } });
    expect(outcome.messages.every((m) => m.warnings.length === 0)).toBe(true);
    expect(t.exitCode).toBe(0);
    expect(alive(t.pid)).toBe(false);
  });

  it('calls a tool', async () => {
    const outcome = await send(transport('sdk'), {
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    });
    expect(outcome.response).toEqual({ result: { content: [{ type: 'text', text: 'hi' }] } });
  });

  it('calls a tool that answers isError, which is a result and not a failure', async () => {
    const outcome = await send(transport('sdk'), { method: 'tools/call', params: { name: 'fail', arguments: {} } });
    expect(outcome.failure).toBeUndefined();
    expect(outcome.response).toMatchObject({ result: { isError: true } });
  });

  it('gives the server only the allowlisted variables and its own, in its folder', async () => {
    const outcome = await send(
      transport('sdk', { env: { FIXTURE_FLAG: 'on' }, parentEnv: { ...process.env, SHOULD_NOT_LEAK: 'x' } }),
      { method: 'tools/call', params: { name: 'env', arguments: {} } },
    );
    const text = (outcome.response as { result: { content: { text: string }[] } }).result.content[0]!.text;
    const seen = JSON.parse(text) as { env: Record<string, string>; cwd: string };
    expect(seen.env['FIXTURE_FLAG']).toBe('on');
    expect(seen.env['SHOULD_NOT_LEAK']).toBeUndefined();
    // macOS itself adds __CF_USER_TEXT_ENCODING to every process; nothing else may appear.
    const allowed = [...mcpStdioParentEnvNames(), 'FIXTURE_FLAG'];
    const extra = Object.keys(seen.env).filter((k) => !allowed.includes(k.toUpperCase()) && !k.startsWith('__CF_'));
    expect(extra).toEqual([]);
    expect(seen.cwd).toBe(FIXTURE_DIR);
  });

  it('refuses a tools call to a server without tools before sending it', async () => {
    const outcome = await send(transport('sdk-prompts'), {
      method: 'tools/call',
      capability: 'tools',
      params: { name: 'echo' },
    });
    expect(outcome.failure?.code).toBe('mcp-capability-missing');
    expect(outcome.messages.some((m) => m.method === 'tools/call')).toBe(false);
  });

  it('answers a roots/list request with -32601 and records both', async () => {
    const outcome = await send(transport('roots'), { method: 'tools/list' });
    expect(outcome.failure).toBeUndefined();
    expect((outcome.response as { result: { reply: unknown } }).result.reply).toMatchObject({
      id: 'roots-1',
      error: { code: -32601 },
    });
    expect(outcome.messages.filter((m) => m.id === 'roots-1').map((m) => [m.direction, m.kind])).toEqual([
      ['received', 'request'],
      ['sent', 'error'],
    ]);
  });

  it('times out on a server that never answers, and kills it', async () => {
    const t = transport('silent');
    const outcome = await send(t, { method: 'tools/list' }, 300);
    expect(outcome.failure?.code).toBe('mcp-timeout');
    expect(alive(t.pid)).toBe(false);
  });

  it('fails with mcp-server-exited and the stderr tail on a crash at start', async () => {
    const t = transport('crash');
    const outcome = await send(t, { method: 'tools/list' });
    expect(outcome.failure?.code).toBe('mcp-server-exited');
    expect(outcome.failure?.message).toMatch(/code 3.*cannot open the database/);
    expect(outcome.failure?.details).toMatchObject({ exitCode: 3 });
    expect(outcome.failure?.details?.['stderrTail']).toContain('fixture: starting');
    expect(t.stderr).toContain('cannot open the database');
  });

  it('fails with mcp-server-exited when the server exits during the operation', async () => {
    const outcome = await send(transport('exit-mid'), { method: 'tools/list' });
    expect(outcome.failure?.code).toBe('mcp-server-exited');
    expect(outcome.failure?.details).toMatchObject({ exitCode: 2 });
  });

  it('fails with mcp-spawn-failed for a command that does not exist', async () => {
    const t = transport('sdk', { command: join(FIXTURE_DIR, 'no-such-command') });
    const outcome = await send(t, { method: 'tools/list' });
    expect(outcome.failure?.code).toBe('mcp-spawn-failed');
  });

  it('keeps an invalid message with a warning', async () => {
    const outcome = await send(transport('invalid'), { method: 'tools/list' });
    expect(outcome.failure).toBeUndefined();
    const invalid = outcome.messages.filter((m) => m.kind === 'invalid' || m.warnings.length > 0);
    expect(invalid.map((m) => m.text)).toEqual(['this is not json', '{"jsonrpc":"2.0","method":42}']);
    expect(invalid.every((m) => m.warnings.length > 0)).toBe(true);
  });

  it('fails with mcp-message-too-large for a line over 4 MiB', async () => {
    const outcome = await send(transport('big'), { method: 'tools/list' });
    expect(outcome.failure?.code).toBe('mcp-message-too-large');
  });

  it('fails with mcp-protocol-unsupported for an unknown version', async () => {
    const outcome = await send(transport('old-version'), { method: 'tools/list' });
    expect(outcome.failure?.code).toBe('mcp-protocol-unsupported');
  });

  it.skipIf(process.platform === 'win32')(
    'escalates to SIGKILL for a server that ignores stdin and SIGTERM',
    async () => {
      const t = transport('stubborn', { termGraceMs: 100, killGraceMs: 100 });
      await t.start({ onMessage: () => undefined, onClose: () => undefined, onError: () => undefined });
      // Let the fixture install its SIGTERM handler before the close starts.
      await new Promise((done) => setTimeout(done, 300));
      await t.close();
      expect(t.exitSignal).toBe('SIGKILL');
      expect(alive(t.pid)).toBe(false);
    },
  );
});
