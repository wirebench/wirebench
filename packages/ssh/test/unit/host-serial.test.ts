import { describe, expect, it } from 'vitest';
import {
  SERIAL_DEFAULTS,
  parseHostsFile,
  resolveHost,
  serialLineOf,
  serialLineText,
  serializeHostsFile,
} from '../../src/index.js';

const FILE = parseHostsFile(`
version: 1
groups:
  - id: lab
    name: Lab consoles
    ssh: { protocol: serial, serial: { baud: 9600 } }
    hosts:
      - { id: router, name: Router console }
      - { id: board, name: Dev board, ssh: { serial: { baud: 115200, parity: even, dataBits: 7, stopBits: 2, flowControl: rtscts } } }
      - { id: box, name: Box, address: 10.0.0.9, ssh: { protocol: ssh, user: u, auth: { agent: true } } }
`);

describe('protocol: serial', () => {
  it('inherits the protocol and takes the line settings whole from the nearest level', () => {
    expect(resolveHost(FILE, 'router').ssh.protocol).toEqual({ value: 'serial', from: { group: 'lab' } });
    expect(resolveHost(FILE, 'router').ssh.serial).toEqual({ value: { baud: 9600 }, from: { group: 'lab' } });
    expect(resolveHost(FILE, 'board').ssh.serial.value).toEqual({
      baud: 115200,
      parity: 'even',
      dataBits: 7,
      stopBits: 2,
      flowControl: 'rtscts',
    });
  });

  it('needs no address, user or way in', () => {
    const router = resolveHost(FILE, 'router');
    expect(router.address).toBe('');
    expect(router.incomplete).toBeUndefined();
  });

  it('round-trips, writing no address for a serial console', () => {
    const text = serializeHostsFile(FILE);
    expect(parseHostsFile(text)).toEqual(FILE);
    expect(text).toMatch(/protocol: serial/);
    expect(text).not.toMatch(/address: ""/);
  });

  it('still needs an address on every other host', () => {
    expect(() => parseHostsFile('version: 1\nhosts:\n  - { id: a, name: a }\n')).toThrow(/host "a" needs an address/);
    expect(() =>
      parseHostsFile(
        'version: 1\ngroups:\n  - { id: g, name: g, ssh: { protocol: serial }, hosts: [{ id: a, name: a, ssh: { protocol: telnet } }] }\n',
      ),
    ).toThrow(/needs an address/);
  });

  it('refuses line settings it cannot open', () => {
    const host = (serial: string): string =>
      `version: 1\nhosts:\n  - { id: a, name: a, ssh: { protocol: serial, serial: ${serial} } }\n`;
    for (const bad of [
      '{ baud: 0 }',
      '{ baud: 9600.5 }',
      '{ dataBits: 9 }',
      '{ parity: maybe }',
      '{ stopBits: 3 }',
      '{ flowControl: dtr }',
      '{ other: 1 }',
    ]) {
      expect(() => parseHostsFile(host(bad)), bad).toThrow(/serial/);
    }
  });
});

describe('serial line helpers', () => {
  it('fill the defaults per field and label the line', () => {
    expect(serialLineOf(undefined)).toEqual(SERIAL_DEFAULTS);
    expect(serialLineText(serialLineOf({ baud: 9600 }))).toBe('9600 8N1');
    expect(serialLineText(serialLineOf({ dataBits: 7, parity: 'even', stopBits: 2, flowControl: 'xonxoff' }))).toBe(
      '115200 7E2 · XON/XOFF',
    );
  });
});
