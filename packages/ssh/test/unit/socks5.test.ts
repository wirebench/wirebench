import { describe, expect, it } from 'vitest';
import { createSocks5Parser, socks5Reply } from '../../src/index.js';

const bytes = (...values: number[]) => Uint8Array.from(values);
const port = (n: number) => [n >> 8, n & 0xff];
const GREETING = [0x05, 0x01, 0x00];
const connect = (atyp: number, address: number[], dstPort: number) => [
  0x05,
  0x01,
  0x00,
  atyp,
  ...address,
  ...port(dstPort),
];

describe('createSocks5Parser', () => {
  it('answers a no-auth greeting with 05 00', () => {
    const parser = createSocks5Parser();
    expect(parser.push(bytes(...GREETING))).toEqual({ kind: 'reply', bytes: bytes(0x05, 0x00), close: false });
  });

  it('answers a greeting without method 00 with 05 FF and closes', () => {
    const parser = createSocks5Parser();
    expect(parser.push(bytes(0x05, 0x02, 0x01, 0x02))).toEqual({
      kind: 'reply',
      bytes: bytes(0x05, 0xff),
      close: true,
    });
  });

  it('closes on version 4', () => {
    const step = createSocks5Parser().push(bytes(0x04, 0x01, 0x00, 0x50, 1, 2, 3, 4, 0));
    expect(step).toMatchObject({ kind: 'reply', close: true });
    if (step.kind === 'reply') expect(step.bytes).toHaveLength(0);
  });

  it('reads a CONNECT to IPv4', () => {
    const parser = createSocks5Parser();
    parser.push(bytes(...GREETING));
    expect(parser.push(bytes(...connect(0x01, [10, 0, 0, 5], 5432)))).toEqual({
      kind: 'connect',
      host: '10.0.0.5',
      port: 5432,
      rest: bytes(),
    });
  });

  it('reads a CONNECT to a domain name, unresolved', () => {
    const name = [...Buffer.from('db.internal')];
    const parser = createSocks5Parser();
    parser.push(bytes(...GREETING));
    expect(parser.push(bytes(...connect(0x03, [name.length, ...name], 5432)))).toEqual({
      kind: 'connect',
      host: 'db.internal',
      port: 5432,
      rest: bytes(),
    });
  });

  it('reads a CONNECT to IPv6 ::1', () => {
    const parser = createSocks5Parser();
    parser.push(bytes(...GREETING));
    const v6 = [...new Array<number>(15).fill(0), 1];
    expect(parser.push(bytes(...connect(0x04, v6, 22)))).toMatchObject({ kind: 'connect', host: '::1', port: 22 });
  });

  it.each([
    ['BIND', 0x02],
    ['UDP ASSOCIATE', 0x03],
  ])('answers %s with 07 and closes', (_name, command) => {
    const parser = createSocks5Parser();
    parser.push(bytes(...GREETING));
    expect(parser.push(bytes(0x05, command, 0x00, 0x01, 127, 0, 0, 1, ...port(80)))).toEqual({
      kind: 'reply',
      bytes: socks5Reply(0x07),
      close: true,
    });
  });

  it('reads a greeting and a request split across three chunks', () => {
    const all = [...GREETING, ...connect(0x01, [10, 0, 0, 5], 5432)];
    const parser = createSocks5Parser();
    expect(parser.push(bytes(...all.slice(0, 2)))).toEqual({ kind: 'need-more' });
    expect(parser.push(bytes(...all.slice(2, 6)))).toEqual({
      kind: 'reply',
      bytes: bytes(0x05, 0x00),
      close: false,
    });
    expect(parser.push(bytes(...all.slice(6)))).toMatchObject({ kind: 'connect', host: '10.0.0.5', port: 5432 });
  });

  it('returns bytes after the request in rest', () => {
    const parser = createSocks5Parser();
    parser.push(bytes(...GREETING));
    expect(parser.push(bytes(...connect(0x01, [10, 0, 0, 5], 80), 0x47, 0x45, 0x54))).toMatchObject({
      kind: 'connect',
      rest: bytes(0x47, 0x45, 0x54),
    });
  });

  it('waits when the domain length is longer than the bytes given', () => {
    const parser = createSocks5Parser();
    parser.push(bytes(...GREETING));
    expect(parser.push(bytes(0x05, 0x01, 0x00, 0x03, 20, ...Buffer.from('short')))).toEqual({ kind: 'need-more' });
  });

  it('closes on an unknown address type', () => {
    const parser = createSocks5Parser();
    parser.push(bytes(...GREETING));
    expect(parser.push(bytes(0x05, 0x01, 0x00, 0x09, 0, 0))).toMatchObject({ kind: 'reply', close: true });
  });
});

describe('socks5Reply', () => {
  it('carries the code and BND.ADDR 0.0.0.0:0', () => {
    expect(socks5Reply(0x05)).toEqual(bytes(0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
  });
});
