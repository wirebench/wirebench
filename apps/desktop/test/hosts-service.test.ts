// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceError } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { HostsService, windowHosts } from '../src/main/hosts-service.js';

const dir = () => mkdtempSync(join(tmpdir(), 'wb-hosts-'));

describe('windowHosts (multi-window)', () => {
  const HOST = 'version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1 }\n';

  it("each window reads its own workspace's hosts.yaml and notifies only itself", async () => {
    const dirA = dir();
    const dirB = dir();
    writeFileSync(join(dirA, 'hosts.yaml'), HOST);
    const notifyA = vi.fn();
    const notifyB = vi.fn();
    const a = windowHosts(() => dirA, notifyA);
    const b = windowHosts(() => dirB, notifyB);
    expect((await a.list()).file.hosts.map((h) => h.id)).toEqual(['a']);
    expect((await b.list()).file.hosts).toEqual([]);
    await b.save({ version: 1, groups: [], hosts: [{ id: 'b', name: 'b', address: 'x', tags: [], ssh: {} }] });
    expect(notifyB).toHaveBeenCalledTimes(1);
    expect(notifyA).not.toHaveBeenCalled();
    // A's cache is still A's file, not the one B just wrote.
    expect(a.current()?.hosts.map((h) => h.id)).toEqual(['a']);
    expect(readFileSync(join(dirA, 'hosts.yaml'), 'utf8')).toBe(HOST);
  });

  it('a window with no workspace open is refused as workspace-not-open', async () => {
    const hosts = windowHosts(() => {
      throw new WorkspaceError('workspace-not-found', 'No workspace is open');
    }, vi.fn());
    await expect(hosts.list()).rejects.toMatchObject({ code: 'workspace-not-open' });
  });
});

describe('HostsService', () => {
  it('a missing hosts.yaml is the empty file with no problems', async () => {
    expect(await new HostsService({ treeDir: () => dir() }).list()).toEqual({
      file: { version: 1, groups: [], hosts: [] },
      resolved: [],
      problems: [],
    });
  });
  it('a hosts.yaml that cannot be read is a WirebenchError naming the errno, not an internal error', async () => {
    const d = dir();
    mkdirSync(join(d, 'hosts.yaml')); // reading a directory fails with EISDIR
    await expect(new HostsService({ treeDir: () => d }).list()).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'ssh-hosts-invalid',
      details: { file: 'hosts.yaml', errno: 'EISDIR' },
    });
  });
  it('a malformed file is a problem, not a throw, and never echoes the literal', async () => {
    const d = dir();
    writeFileSync(
      join(d, 'hosts.yaml'),
      'version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { auth: { password: oops } } }\n',
    );
    const result = await new HostsService({ treeDir: () => d }).list();
    expect(result.problems).toEqual([
      {
        code: 'ssh-literal-secret',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
        message: expect.stringContaining('${secret:NAME}'),
        path: 'hosts[0].ssh.auth.password',
      },
    ]);
    expect(result.resolved).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('oops');
  });
  it('save writes the file, re-reads it, reports secrets by name and notifies', async () => {
    const d = dir();
    let changed = 0;
    const service = new HostsService({
      treeDir: () => d,
      onChanged: () => {
        changed += 1;
      },
    });
    const result = await service.save({
      version: 1,
      groups: [],
      hosts: [
        {
          id: 'a',
          name: 'A',
          address: '10.0.0.1',
          tags: [],
          ssh: { user: 'me', auth: { kind: 'password', secret: 'a_pw' } },
        },
      ],
    });
    expect(readFileSync(join(d, 'hosts.yaml'), 'utf8')).toContain('password: ${secret:a_pw}');
    expect(result.resolved[0]?.ssh.auth).toEqual({ value: { kind: 'password', secret: 'a_pw' }, from: 'host' });
    expect(changed).toBe(1);
    expect(service.current()?.hosts).toHaveLength(1);
  });
  it('save refuses a secret name that is not a NAME', async () => {
    await expect(
      new HostsService({ treeDir: () => dir() }).save({
        version: 1,
        groups: [],
        hosts: [
          { id: 'a', name: 'A', address: 'x', tags: [], ssh: { auth: { kind: 'password', secret: 'has space' } } },
        ],
      }),
    ).rejects.toMatchObject({ name: 'WirebenchError', code: 'ssh-literal-secret' });
  });
  it('no open workspace is workspace-not-open', async () => {
    await expect(new HostsService({ treeDir: () => undefined }).list()).rejects.toMatchObject({
      code: 'workspace-not-open',
    });
  });
  it('invalidate makes the next list read the disk again', async () => {
    const d = dir();
    const service = new HostsService({ treeDir: () => d });
    expect((await service.list()).file.hosts).toEqual([]);
    writeFileSync(join(d, 'hosts.yaml'), 'version: 1\nhosts:\n  - { id: a, name: a, address: a }\n');
    expect((await service.list()).file.hosts).toEqual([]);
    service.invalidate();
    expect((await service.list()).file.hosts).toHaveLength(1);
  });
});
