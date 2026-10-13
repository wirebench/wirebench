import { describe, expect, it } from 'vitest';
import { parseHostsFile, resolveHost, resolveSettings, serializeHostsFile } from '../../src/index.js';

const FILE = parseHostsFile(`
version: 1
groups:
  - id: ops
    name: Ops
    ssh: { user: ops, auth: { agent: true }, forwardAgent: true }
    groups:
      - id: locked
        name: Locked
        ssh: { forwardAgent: false }
        hosts:
          - { id: vault, name: vault, address: 10.0.0.9 }
          - { id: builder, name: builder, address: 10.0.0.8, ssh: { forwardAgent: true } }
    hosts:
      - { id: git-box, name: git-box, address: 10.0.0.5 }
hosts:
  - { id: plain, name: plain, address: 10.0.0.1, ssh: { user: u, auth: { agent: true } } }
`);

describe('forwardAgent', () => {
  it('is off by default', () => {
    expect(resolveHost(FILE, 'plain').ssh.forwardAgent).toEqual({ value: false, from: 'default' });
  });
  it('is inherited from the nearest group that sets it; a nearer false turns it off', () => {
    expect(resolveHost(FILE, 'git-box').ssh.forwardAgent).toEqual({ value: true, from: { group: 'ops' } });
    expect(resolveHost(FILE, 'vault').ssh.forwardAgent).toEqual({ value: false, from: { group: 'locked' } });
    expect(resolveHost(FILE, 'builder').ssh.forwardAgent).toEqual({ value: true, from: 'host' });
  });
  it('is part of the merged settings', () => {
    expect(resolveSettings(FILE, 'git-box').forwardAgent).toBe(true);
    expect(resolveSettings(FILE, 'plain').forwardAgent).toBeUndefined();
  });
  it('round-trips, false included', () => {
    const again = parseHostsFile(serializeHostsFile(FILE));
    expect(again).toEqual(FILE);
    expect(serializeHostsFile(FILE)).toMatch(/forwardAgent: false/);
  });
  it('refuses anything but a boolean', () => {
    expect(() =>
      parseHostsFile(`version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { forwardAgent: 'yes' } }\n`),
    ).toThrow(/forwardAgent/);
  });
});
