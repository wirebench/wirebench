import { describe, expect, it } from 'vitest';
import { parseHostsFile, parseMoshPorts, resolveHost, resolveSettings, serializeHostsFile } from '../../src/index.js';

const FILE = parseHostsFile(`
version: 1
groups:
  - id: roaming
    name: Roaming
    ssh: { user: ops, auth: { agent: true }, protocol: mosh, mosh: { server: /opt/mosh/bin/mosh-server, ports: '60000:60010' } }
    groups:
      - id: pinned
        name: Pinned
        ssh: { mosh: { ports: '61000' } }
        hosts:
          - { id: laptop, name: laptop, address: 10.0.0.9 }
    hosts:
      - { id: train, name: train, address: 10.0.0.5 }
      - { id: office, name: office, address: 10.0.0.6, ssh: { protocol: ssh } }
hosts:
  - { id: plain, name: plain, address: 10.0.0.1, ssh: { user: u, auth: { agent: true } } }
`);

describe('protocol and mosh settings', () => {
  it('are ssh and unset by default', () => {
    const plain = resolveHost(FILE, 'plain');
    expect(plain.ssh.protocol).toEqual({ value: 'ssh', from: 'default' });
    expect(plain.ssh.mosh).toEqual({ value: undefined, from: 'default' });
  });

  it('inherit from the nearest level; a nearer ssh turns mosh off', () => {
    expect(resolveHost(FILE, 'train').ssh.protocol).toEqual({ value: 'mosh', from: { group: 'roaming' } });
    expect(resolveHost(FILE, 'office').ssh.protocol).toEqual({ value: 'ssh', from: 'host' });
  });

  it('take the mosh block whole from the nearest level, never merged', () => {
    expect(resolveHost(FILE, 'train').ssh.mosh).toEqual({
      value: { server: '/opt/mosh/bin/mosh-server', ports: '60000:60010' },
      from: { group: 'roaming' },
    });
    expect(resolveHost(FILE, 'laptop').ssh.mosh).toEqual({ value: { ports: '61000' }, from: { group: 'pinned' } });
    expect(resolveSettings(FILE, 'laptop').mosh).toEqual({ ports: '61000' });
    expect(resolveSettings(FILE, 'laptop').protocol).toBe('mosh');
  });

  it('round-trip', () => {
    const text = serializeHostsFile(FILE);
    expect(parseHostsFile(text)).toEqual(FILE);
    expect(text).toMatch(/protocol: mosh/);
    expect(text).toMatch(/ports: "?60000:60010"?/);
  });

  it('refuse an unknown protocol, a bad port range and a blank server', () => {
    const host = (ssh: string): string => `version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: ${ssh} }\n`;
    expect(() => parseHostsFile(host('{ protocol: rlogin }'))).toThrow(/protocol/);
    expect(() => parseHostsFile(host("{ mosh: { ports: '61000:60000' } }"))).toThrow(/ports/);
    expect(() => parseHostsFile(host("{ mosh: { ports: '70000' } }"))).toThrow(/ports/);
    expect(() => parseHostsFile(host("{ mosh: { server: '  ' } }"))).toThrow(/server/);
    expect(() => parseHostsFile(host('{ mosh: { server: "a\\nb" } }'))).toThrow(/server/);
    expect(() => parseHostsFile(host('{ mosh: { other: 1 } }'))).toThrow(/mosh/);
  });
});

describe('parseMoshPorts', () => {
  it('reads one port or a range', () => {
    expect(parseMoshPorts('60001')).toEqual([60001, 60001]);
    expect(parseMoshPorts('60000:60010')).toEqual([60000, 60010]);
  });
  it('refuses anything else', () => {
    for (const bad of ['', '0', '65536', '2:1', '1-2', ' 1', '1:', 'a']) expect(parseMoshPorts(bad)).toBeUndefined();
  });
});
