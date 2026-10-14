import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeSessionFile } from '../../../src/host-import/decode.js';
import { parsePuttyReg } from '../../../src/host-import/putty.js';

const FIXTURE = new URL('../../fixtures/host-import/putty-sessions.reg', import.meta.url);
const text = readFileSync(FIXTURE, 'utf8');

describe('parsePuttyReg', () => {
  const source = parsePuttyReg(text);

  it('reads every SSH session, decoding the session name, and leaves Default Settings out', () => {
    expect(source.format).toBe('putty');
    expect(source.sessions.map((s) => s.name)).toEqual(['bastion', 'Prod Web', 'legacy']);
  });

  it('maps host, port, user and key file', () => {
    expect(source.sessions[0]).toEqual({
      name: 'bastion',
      line: 10,
      folder: [],
      address: 'bastion.example.com',
      port: 22,
      user: 'ops',
      keyFile: 'C:\\Users\\alex\\.ssh\\bastion.ppk',
    });
  });

  it('takes the user from user@host, and an SSH proxy as the jump host', () => {
    expect(source.sessions[1]).toMatchObject({
      address: 'web1.example.com',
      port: 2222,
      user: 'deploy',
      keyFile: 'C:\\Users\\alex\\.ssh\\id_ed25519',
      jump: 'bastion',
    });
  });

  it('reads port forwards: local, remote with an address family, dynamic, and a bind address', () => {
    expect(source.sessions[1]?.forwards).toEqual([
      { type: 'local', port: 8080, target: 'localhost:80' },
      { type: 'remote', port: 9000, target: '127.0.0.1:9000' },
      { type: 'dynamic', port: 1080 },
      { type: 'local', port: 5432, bind: '127.0.0.2', target: 'db.internal:5432' },
    ]);
  });

  it('reports a non-SSH session, a session with no host and a proxy it cannot use, never their values', () => {
    expect(source.skipped).toEqual([
      { line: 34, keyword: 'router', why: 'a telnet session, not SSH' },
      { line: 43, keyword: 'ProxyMethod', why: 'legacy: only an SSH proxy becomes a jump host; imported without it' },
      { line: 48, keyword: 'empty', why: 'has no host name' },
    ]);
    expect(JSON.stringify(source)).not.toContain('socks.example.com');
  });

  it('counts the sessions that held a password and never keeps it', () => {
    expect(source.passwords).toBe(1);
    expect(JSON.stringify(source)).not.toContain('not-a-real-password');
  });

  it('reads a UTF-16 export the way the registry editor writes it', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    expect(parsePuttyReg(decodeSessionFile(bytes)).sessions).toHaveLength(3);
  });

  it('reads an export with no session as empty', () => {
    expect(parsePuttyReg('Windows Registry Editor Version 5.00\r\n').sessions).toEqual([]);
  });
});

describe('decodeSessionFile', () => {
  it('drops a UTF-8 byte order mark and reads UTF-16 big-endian', () => {
    expect(decodeSessionFile(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
    expect(decodeSessionFile(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toBe('a');
  });
});
