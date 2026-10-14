import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHostsCsv } from '../../../src/host-import/csv.js';

const FIXTURE = new URL('../../fixtures/host-import/hosts.csv', import.meta.url);
const text = readFileSync(FIXTURE, 'utf8');

describe('parseHostsCsv', () => {
  const source = parseHostsCsv(text);

  it('reads one session per row, naming a nameless row by its address', () => {
    expect(source.format).toBe('csv');
    expect(source.sessions.map((s) => s.name)).toEqual(['bastion', 'web 1', '10.0.0.5']);
  });

  it('maps every documented column', () => {
    expect(source.sessions[0]).toEqual({
      name: 'bastion',
      line: 2,
      folder: ['Edge'],
      address: 'bastion.example.com',
      port: 2222,
      user: 'ops',
      tags: ['edge', 'prod'],
    });
    expect(source.sessions[1]).toEqual({
      name: 'web 1',
      line: 3,
      folder: ['Production', 'Web'],
      address: 'web1.example.com',
      user: 'deploy',
      tags: ['prod'],
      keyFile: '/home/alex/.ssh/id_ed25519',
      jump: 'bastion',
    });
    expect(source.sessions[2]).toMatchObject({ line: 5, port: 22, user: 'root', tags: ['lab'] });
  });

  it('reports rows it cannot use and columns it does not know, never a value', () => {
    expect(source.skipped).toEqual([
      { line: 4, keyword: 'port', why: 'db, primary: the port is not a number from 1 to 65535' },
      { line: 7, keyword: 'address', why: 'missing-address: has no address' },
    ]);
    expect(source.ignored).toEqual([{ keyword: 'notes', count: 2 }]);
  });

  it('counts the rows with a password and never keeps it', () => {
    expect(source.passwords).toBe(1);
    expect(JSON.stringify(source)).not.toContain('not-a-real-password');
  });

  it('accepts columns in any order and case, and semicolon-separated files', () => {
    const s = parseHostsCsv('Address;User;Name\r\nh.example.com;me;h\r\n');
    expect(s.sessions).toEqual([{ name: 'h', line: 2, folder: [], address: 'h.example.com', user: 'me' }]);
  });

  it('refuses a file whose header has no address column', () => {
    expect(() => parseHostsCsv('host,port\nx,22\n')).toThrow(/needs an address column/);
    expect(() => parseHostsCsv('')).toThrow(/needs an address column/);
  });
});
