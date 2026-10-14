import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMobaXterm } from '../../../src/host-import/mobaxterm.js';

const FIXTURE = new URL('../../fixtures/host-import/mobaxterm-sessions.mobaconf', import.meta.url);
const text = readFileSync(FIXTURE, 'utf8');

describe('parseMobaXterm', () => {
  const source = parseMobaXterm(text);

  it('reads every SSH bookmark with its folder', () => {
    expect(source.format).toBe('mobaxterm');
    expect(source.sessions.map((s) => [s.folder.join('/'), s.name])).toEqual([
      ['', 'bastion'],
      ['Production/Web', 'web1'],
      ['Lab', 'db 01'],
    ]);
  });

  it('maps host, port, user, key file and the SSH gateway', () => {
    expect(source.sessions[0]).toEqual({
      name: 'bastion',
      line: 7,
      folder: [],
      address: 'bastion.example.com',
      port: 2222,
      user: 'ops',
    });
    expect(source.sessions[1]).toEqual({
      name: 'web1',
      line: 12,
      folder: ['Production', 'Web'],
      address: 'web1.example.com',
      port: 22,
      user: 'deploy',
      keyFile: 'C:\\Users\\alex\\.ssh\\id_ed25519',
      jump: 'ops@bastion.example.com:2222',
    });
    expect(source.sessions[2]).toMatchObject({ address: 'db.lab.example.com', keyFile: '_ProfileDir_\\.ssh\\lab_key' });
  });

  it('reports a non-SSH bookmark and a gateway chain it cannot carry', () => {
    expect(source.skipped).toEqual([
      { line: 13, keyword: 'router', why: 'not an SSH session' },
      {
        line: 18,
        keyword: 'gateway',
        why: 'db 01: several gateways in a row are not imported; imported without a jump',
      },
    ]);
  });

  it('counts saved passwords and never keeps them', () => {
    expect(source.passwords).toBe(1);
    expect(JSON.stringify(source)).not.toContain('not-a-real-password');
  });

  it('refuses a file with no bookmark section', () => {
    expect(() => parseMobaXterm('[Misc]\nfoo=bar\n')).toThrow(/not a MobaXterm session file/);
  });
});
