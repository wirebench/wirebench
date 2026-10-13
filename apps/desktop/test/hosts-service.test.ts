// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceError } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { HostsService, windowHosts } from '../src/main/hosts-service.js';
import { sshListHostsResponseSchema } from '../src/shared/ssh-wire.js';

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
  describe('forwarding rules', () => {
    const RULES = `version: 1
groups:
  - id: prod
    name: Production
    forwards:
      - id: grafana
        type: local
        port: 3000
        target: localhost:3000
      - id: socks
        type: dynamic
        port: 1080
        bind: 0.0.0.0
    hosts:
      - id: db-1
        name: db-1
        address: 10.0.1.7
        forwards:
          - id: hook
            type: remote
            port: 8080
            target: "[::1]:3000"
            autoStart: true
          - id: socks
            enabled: false
`;

    it('list carries the resolved rules of each type through the channel schema', async () => {
      const d = dir();
      writeFileSync(join(d, 'hosts.yaml'), RULES);
      const listed = sshListHostsResponseSchema.parse(await new HostsService({ treeDir: () => d }).list());
      expect(listed.problems).toEqual([]);
      expect(listed.resolved[0]?.forwards).toEqual([
        {
          rule: {
            id: 'grafana',
            type: 'local',
            port: 3000,
            bind: '127.0.0.1',
            target: { host: 'localhost', port: 3000 },
            autoStart: false,
          },
          from: { group: 'prod' },
          enabled: true,
        },
        {
          rule: { id: 'socks', type: 'dynamic', port: 1080, bind: '0.0.0.0', autoStart: false },
          from: { group: 'prod' },
          enabled: false,
          offBy: 'host',
        },
        {
          rule: {
            id: 'hook',
            type: 'remote',
            port: 8080,
            bind: 'localhost',
            target: { host: '::1', port: 3000 },
            autoStart: true,
          },
          from: 'host',
          enabled: true,
        },
      ]);
    });

    it('saving the listed file writes the rules back unchanged', async () => {
      const d = dir();
      writeFileSync(join(d, 'hosts.yaml'), RULES);
      const service = new HostsService({ treeDir: () => d });
      const { file } = sshListHostsResponseSchema.parse(await service.list());
      await service.save(file);
      expect(readFileSync(join(d, 'hosts.yaml'), 'utf8')).toBe(RULES);
    });

    it('save refuses an invalid rule as ssh-forward-invalid', async () => {
      const service = new HostsService({ treeDir: () => dir() });
      await expect(
        service.save({
          version: 1,
          groups: [],
          hosts: [
            { id: 'a', name: 'a', address: 'a', tags: [], ssh: {}, forwards: [{ id: 'x', type: 'local', port: 1 }] },
          ],
        }),
      ).rejects.toMatchObject({ name: 'WirebenchError', code: 'ssh-forward-invalid', details: { field: 'target' } });
    });
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
  it('protected crosses the wire both ways and is resolved with its source', async () => {
    const d = dir();
    const service = new HostsService({ treeDir: () => d });
    const saved = await service.save({
      version: 1,
      groups: [
        {
          id: 'prod',
          name: 'prod',
          tags: [],
          protected: true,
          ssh: {},
          groups: [],
          hosts: [{ id: 'a', name: 'a', address: 'x', tags: [], ssh: {} }],
        },
      ],
      hosts: [{ id: 'b', name: 'b', address: 'y', tags: [], protected: false, ssh: {} }],
    });
    expect(saved.file.groups[0]?.protected).toBe(true);
    expect(saved.file.hosts[0]?.protected).toBe(false);
    expect(saved.resolved.map((h) => [h.id, h.protected])).toEqual([
      ['a', { value: true, from: { group: 'prod' } }],
      ['b', { value: false, from: 'host' }],
    ]);
    expect(readFileSync(join(d, 'hosts.yaml'), 'utf8')).toContain('protected: true');
  });
});

describe('HostsService env', () => {
  const ENV = `version: 1
groups:
  - id: prod
    name: Production
    env:
      LANG: en_US.UTF-8
      TOKEN: \${secret:prod_token}
    hosts:
      - id: api
        name: api
        address: 10.0.1.5
        env:
          LANG: C.UTF-8
`;

  it('list carries a variable as text or a secret name, never a token, with its source', async () => {
    const d = dir();
    writeFileSync(join(d, 'hosts.yaml'), ENV);
    const listed = sshListHostsResponseSchema.parse(await new HostsService({ treeDir: () => d }).list());
    expect(listed.problems).toEqual([]);
    expect(listed.file.groups[0]?.env).toEqual([
      { name: 'LANG', value: 'en_US.UTF-8' },
      { name: 'TOKEN', secret: 'prod_token' },
    ]);
    expect(listed.resolved[0]?.env).toEqual([
      { name: 'LANG', value: 'C.UTF-8', from: 'host' },
      { name: 'TOKEN', secret: 'prod_token', from: { group: 'prod' } },
    ]);
    expect(JSON.stringify(listed)).not.toContain('${secret:');
  });

  it('saving the listed file writes the variables back unchanged', async () => {
    const d = dir();
    writeFileSync(join(d, 'hosts.yaml'), ENV);
    const service = new HostsService({ treeDir: () => d });
    const { file } = sshListHostsResponseSchema.parse(await service.list());
    await service.save(file);
    expect(readFileSync(join(d, 'hosts.yaml'), 'utf8')).toBe(ENV);
  });

  const withEnv = (env: { name: string; value: string }[] | { name: string; secret: string }[]) => ({
    version: 1 as const,
    groups: [],
    hosts: [{ id: 'a', name: 'a', address: 'a', tags: [], ssh: {}, env }],
  });

  it('save refuses text holding a secret token, without echoing it', async () => {
    const error: unknown = await new HostsService({ treeDir: () => dir() })
      .save(withEnv([{ name: 'P', value: 'u:hunter2@${secret:pw}' }]))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'WirebenchError', code: 'ssh-hosts-invalid' });
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('save refuses a name listed twice, a bad name and a bad secret name', async () => {
    const service = new HostsService({ treeDir: () => dir() });
    await expect(
      service.save(
        withEnv([
          { name: 'A', value: '1' },
          { name: 'A', value: '2' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'ssh-hosts-invalid' });
    await expect(service.save(withEnv([{ name: 'BAD-NAME', value: '1' }]))).rejects.toMatchObject({
      code: 'ssh-hosts-invalid',
    });
    await expect(service.save(withEnv([{ name: 'A', secret: 'has space' }]))).rejects.toMatchObject({
      code: 'ssh-literal-secret',
    });
  });

  it('an empty list writes no env key', async () => {
    const d = dir();
    await new HostsService({ treeDir: () => d }).save(withEnv([]));
    expect(readFileSync(join(d, 'hosts.yaml'), 'utf8')).not.toContain('env');
  });
});
