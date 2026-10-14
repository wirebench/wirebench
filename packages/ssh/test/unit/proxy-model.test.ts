import { describe, expect, it } from 'vitest';
import { jumpChain, parseHostsFile, resolveHost, resolveSettings, serializeHostsFile } from '../../src/index.js';

const FILE = parseHostsFile(`
version: 1
groups:
  - id: corp
    name: Corp
    ssh:
      user: ops
      auth: { agent: true }
      proxy: { type: socks5, host: proxy.corp, port: 1080, user: me, password: '\${secret:corp_proxy}' }
    groups:
      - id: dmz
        name: DMZ
        ssh: { proxy: false }
        hosts:
          - { id: gate, name: gate, address: 10.1.0.1 }
    hosts:
      - { id: build, name: build, address: build.corp }
      - id: web
        name: web
        address: web.corp
        ssh: { proxy: { type: http, host: 10.0.0.3, port: 3128 } }
      - { id: inner, name: inner, address: 10.2.0.2, ssh: { jump: gate } }
hosts:
  - { id: plain, name: plain, address: 10.0.0.1, ssh: { user: u, auth: { agent: true } } }
`);

describe('proxy', () => {
  it('is unset by default', () => {
    expect(resolveHost(FILE, 'plain').ssh.proxy).toEqual({ value: undefined, from: 'default' });
  });
  it('is inherited from the nearest group that sets it, whole', () => {
    expect(resolveHost(FILE, 'build').ssh.proxy).toEqual({
      value: { type: 'socks5', host: 'proxy.corp', port: 1080, user: 'me', password: '${secret:corp_proxy}' },
      from: { group: 'corp' },
    });
    expect(resolveHost(FILE, 'web').ssh.proxy).toEqual({
      value: { type: 'http', host: '10.0.0.3', port: 3128 },
      from: 'host',
    });
  });
  it('a nearer false connects directly, keeping the level that said so', () => {
    expect(resolveHost(FILE, 'gate').ssh.proxy).toEqual({ value: undefined, from: { group: 'dmz' } });
    expect(resolveSettings(FILE, 'gate').proxy).toBe(false);
  });
  it('each hop of a jump chain carries its own setting', () => {
    const [first, target] = jumpChain(FILE, 'inner');
    expect(first?.ssh.proxy.value).toBeUndefined();
    expect(target?.ssh.proxy.value).toMatchObject({ type: 'socks5' });
  });
  it('round-trips, false included', () => {
    const text = serializeHostsFile(FILE);
    expect(parseHostsFile(text)).toEqual(FILE);
    expect(text).toMatch(/proxy: false/);
  });
  it('refuses a literal password, naming the path, never the value', () => {
    const bad = `version: 1\nhosts:\n  - id: a\n    name: a\n    address: a\n    ssh: { proxy: { type: http, host: p, port: 8080, user: me, password: MARKER-hunter2 } }\n`;
    let caught: unknown;
    try {
      parseHostsFile(bad);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'ssh-literal-secret' });
    expect(JSON.stringify(caught)).not.toContain('MARKER');
    expect((caught as Error).message).not.toContain('MARKER');
    expect((caught as Error).message).toContain('proxy.password');
  });
  it('refuses an unknown type, a bad port and extra fields', () => {
    const at = (proxy: string) => `version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { proxy: ${proxy} } }\n`;
    expect(() => parseHostsFile(at('{ type: socks4, host: p, port: 1 }'))).toThrow(/proxy/);
    expect(() => parseHostsFile(at('{ type: http, host: p, port: 70000 }'))).toThrow(/proxy/);
    expect(() => parseHostsFile(at('{ type: http, host: p, port: 1, via: x }'))).toThrow(/proxy/);
    expect(() => parseHostsFile(at('true'))).toThrow(/proxy/);
  });
});
