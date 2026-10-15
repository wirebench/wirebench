/**
 * `wirebench ssh forward` as a real process (#460): a local rule from a workspace's hosts.yaml, its password
 * from `WIREBENCH_SECRET_*` and its host key from a known-hosts file, carries bytes to a server behind the
 * SSH fixture, and SIGTERM ends it with 0. Windows has no SIGTERM to deliver, so the test runs elsewhere.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, saveWorkspace } from '@wirebench/engine';
import { freePort, startEchoServer, startSshFixture } from '@wirebench/ssh/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnCli } from './helpers.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** Sends `text` through the forwarded port and resolves with what comes back. */
function roundTrip(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString();
      if (received.length >= text.length) {
        socket.end();
        resolve(received);
      }
    });
    socket.on('error', reject);
  });
}

describe.skipIf(process.platform === 'win32')('wirebench ssh forward process', () => {
  it('forwards a local port through the host until SIGTERM, then exits 0', async () => {
    const fixture = await startSshFixture({
      password: { user: 'tester', password: 'fixture-password' },
      allowForwardOut: true,
    });
    cleanups.push(() => fixture.close());
    const echo = await startEchoServer();
    cleanups.push(() => echo.close());
    const dir = await mkdtemp(join(tmpdir(), 'wb-ssh-fwd-int-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await saveWorkspace(createWorkspace('W'), dir);
    const local = await freePort();
    await writeFile(
      join(dir, 'hosts.yaml'),
      `version: 1
hosts:
  - id: fixture
    name: Fixture
    address: 127.0.0.1
    ssh:
      user: tester
      port: ${fixture.port}
      auth:
        password: \${secret:fixture_pw}
    forwards:
      - id: echo
        type: local
        port: ${local}
        target: 127.0.0.1:${echo.port}
`,
    );
    const knownHosts = join(dir, 'known-hosts.json');
    await writeFile(knownHosts, JSON.stringify([fixture.hostKey]));

    const child = spawnCli(['ssh', 'forward', 'fixture', '--workspace', dir, '--known-hosts', knownHosts], {
      WIREBENCH_SECRET_FIXTURE_PW: 'fixture-password',
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('\n')) resolve();
      });
      void exited.then(() => reject(new Error(`exited before listening: ${stderr}`)));
    });

    expect(stdout).toBe(`echo  127.0.0.1:${local} → 127.0.0.1:${echo.port} via fixture\n`);
    expect(await roundTrip(local, 'through the tunnel')).toBe('through the tunnel');

    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(stderr).toBe('');
  });

  it('--group forwards the rules of two hosts at once until SIGTERM (#583)', async () => {
    const fixture = await startSshFixture({
      password: { user: 'tester', password: 'fixture-password' },
      allowForwardOut: true,
    });
    cleanups.push(() => fixture.close());
    const echo = await startEchoServer();
    cleanups.push(() => echo.close());
    const dir = await mkdtemp(join(tmpdir(), 'wb-ssh-fwd-group-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await saveWorkspace(createWorkspace('W'), dir);
    const first = await freePort();
    const second = await freePort();
    // Two host entries for the one fixture: the group dials one connection per host.
    const hostYaml = (id: string, port: number): string => `  - id: ${id}
    name: ${id}
    address: 127.0.0.1
    ssh:
      user: tester
      port: ${fixture.port}
      auth:
        password: \${secret:fixture_pw}
    forwards:
      - id: echo
        type: local
        port: ${port}
        target: 127.0.0.1:${echo.port}
`;
    await writeFile(
      join(dir, 'hosts.yaml'),
      `version: 2
hosts:
${hostYaml('one', first)}${hostYaml('two', second)}forwardGroups:
  - id: dev
    name: Dev
    rules:
      - { host: one, rule: echo }
      - { host: two, rule: echo }
`,
    );
    const knownHosts = join(dir, 'known-hosts.json');
    await writeFile(knownHosts, JSON.stringify([fixture.hostKey]));

    const child = spawnCli(['ssh', 'forward', '--group', 'dev', '--workspace', dir, '--known-hosts', knownHosts], {
      WIREBENCH_SECRET_FIXTURE_PW: 'fixture-password',
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.split('\n').length > 2) resolve();
      });
      void exited.then(() => reject(new Error(`exited before listening: ${stderr}`)));
    });

    expect(stdout).toBe(
      `one/echo  127.0.0.1:${first} → 127.0.0.1:${echo.port} via one\n` +
        `two/echo  127.0.0.1:${second} → 127.0.0.1:${echo.port} via two\n`,
    );
    expect(await roundTrip(first, 'through the first')).toBe('through the first');
    expect(await roundTrip(second, 'through the second')).toBe('through the second');

    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(stderr).toBe('');
  });
});
