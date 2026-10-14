import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSecureCrtXml } from '../../../src/host-import/securecrt.js';

const FIXTURE = new URL('../../fixtures/host-import/securecrt-sessions.xml', import.meta.url);
const text = readFileSync(FIXTURE, 'utf8');

describe('parseSecureCrtXml', () => {
  const source = parseSecureCrtXml(text);

  it('reads every SSH2 session with its folder path, leaving the Default session out', () => {
    expect(source.format).toBe('securecrt');
    expect(source.sessions.map((s) => [s.folder.join('/'), s.name])).toEqual([
      ['Production/Web', 'web1'],
      ['Production', 'bastion'],
      ['Lab & Test', 'db'],
    ]);
  });

  it('maps host, port, user, the key file without its suffix, and a session firewall as the jump', () => {
    expect(source.sessions[0]).toMatchObject({
      line: 10,
      address: 'web1.example.com',
      port: 22,
      user: 'deploy',
      keyFile: 'C:\\Users\\alex\\.ssh\\id_rsa',
      jump: 'Production/bastion',
    });
    expect(source.sessions[1]).toMatchObject({ port: 2222, user: 'ops' });
    expect(source.sessions[1]?.jump).toBeUndefined();
  });

  it('reads the local and reverse forward tables', () => {
    expect(source.sessions[0]?.forwards).toEqual([
      { type: 'local', port: 8080, bind: '127.0.0.1', target: 'localhost:80' },
      { type: 'remote', port: 9100, target: '127.0.0.1:9100' },
    ]);
  });

  it('reports what it left out without the values', () => {
    expect(source.skipped).toEqual([
      { line: 18, keyword: 'Port Forward Table V2', why: 'web1: 1 port forward could not be read' },
      {
        line: 39,
        keyword: 'Firewall Name',
        why: 'db: only a session firewall becomes a jump host; imported without it',
      },
      { line: 42, keyword: 'switch', why: 'a Telnet session, not SSH2' },
    ]);
    expect(JSON.stringify(source)).not.toContain('corp-socks');
  });

  it('counts saved passwords and never keeps them', () => {
    expect(source.passwords).toBe(1);
    expect(JSON.stringify(source)).not.toContain('not-a-real-password');
  });

  it('refuses a file that is not a session export', () => {
    expect(() => parseSecureCrtXml('<html><body/></html>')).toThrow(/not a SecureCRT session export/);
    expect(() => parseSecureCrtXml('<VanDyke><key name="Sessions">')).toThrow(/not a SecureCRT session export/);
  });
});
