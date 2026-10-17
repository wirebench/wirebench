import { describe, expect, it } from 'vitest';
import { parseHostsFile, resolveHost, serializeHostsFile } from '../../src/index.js';

const FILE = parseHostsFile(`
version: 1
groups:
  - id: switches
    name: Switches
    ssh: { protocol: telnet }
    hosts:
      - { id: core, name: core, address: 10.0.0.2 }
      - { id: edge, name: edge, address: 10.0.0.3, ssh: { port: 2323, user: admin, auth: { password: '\${secret:edge}' } } }
      - { id: modern, name: modern, address: 10.0.0.4, ssh: { protocol: ssh } }
hosts:
  - { id: plain, name: plain, address: 10.0.0.1 }
`);

describe('protocol: telnet', () => {
  it('inherits from a group, and a nearer ssh turns it off', () => {
    expect(resolveHost(FILE, 'core').ssh.protocol).toEqual({ value: 'telnet', from: { group: 'switches' } });
    expect(resolveHost(FILE, 'modern').ssh.protocol).toEqual({ value: 'ssh', from: 'host' });
  });

  it('defaults the port to 23, and a set port wins', () => {
    expect(resolveHost(FILE, 'core').ssh.port).toEqual({ value: 23, from: 'default' });
    expect(resolveHost(FILE, 'edge').ssh.port).toEqual({ value: 2323, from: 'host' });
    expect(resolveHost(FILE, 'modern').ssh.port).toEqual({ value: 22, from: 'default' });
  });

  it('is never incomplete: a Telnet host may be signed in to by hand', () => {
    expect(resolveHost(FILE, 'core').incomplete).toBeUndefined();
    expect(resolveHost(FILE, 'modern').incomplete).toEqual({ field: 'user' });
    expect(resolveHost(FILE, 'plain').incomplete).toEqual({ field: 'user' });
  });

  it('round-trips', () => {
    const text = serializeHostsFile(FILE);
    expect(parseHostsFile(text)).toEqual(FILE);
    expect(text).toMatch(/protocol: telnet/);
  });
});
