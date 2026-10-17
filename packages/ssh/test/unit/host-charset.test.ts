import { describe, expect, it } from 'vitest';
import {
  CHARSETS,
  jumpChain,
  parseHostsFile,
  resolveHost,
  resolveSettings,
  serializeHostsFile,
  terminalCodec,
  withCharset,
} from '../../src/index.js';
import type { SshSession } from '../../src/index.js';
import { HIGH_HALVES } from '../../src/charset-tables.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('terminalCodec (#427)', () => {
  it('passes UTF-8 through both ways, untouched', () => {
    const codec = terminalCodec('utf-8');
    const bytes = utf8('héllo €');
    expect(codec.decode(bytes)).toBe(bytes);
    expect(codec.encode(bytes)).toBe(bytes);
  });

  it('decodes each single-byte set to UTF-8', () => {
    expect(text(terminalCodec('iso-8859-1').decode(Uint8Array.of(0x63, 0x61, 0x66, 0xe9)))).toBe('café');
    expect(text(terminalCodec('iso-8859-15').decode(Uint8Array.of(0xa4)))).toBe('€');
    expect(text(terminalCodec('windows-1252').decode(Uint8Array.of(0x80, 0x93, 0x94)))).toBe('€“”');
    expect(text(terminalCodec('iso-8859-9').decode(Uint8Array.of(0xdd, 0xfe)))).toBe('İş');
    expect(text(terminalCodec('cp850').decode(Uint8Array.of(0x82, 0xc9, 0xcd, 0xbb)))).toBe('é╔═╗');
    expect(text(terminalCodec('windows-1251').decode(Uint8Array.of(0xcf, 0xf0, 0xe8)))).toBe('При');
    expect(text(terminalCodec('koi8-r').decode(Uint8Array.of(0xf0, 0xd2, 0xc9)))).toBe('При');
  });

  it('keeps C1 controls in ISO-8859-1, so an 8-bit CSI reaches the terminal', () => {
    expect(text(terminalCodec('iso-8859-1').decode(Uint8Array.of(0x9b, 0x41)))).toBe('\u009bA');
  });

  it('marks a byte the set leaves undefined', () => {
    expect(text(terminalCodec('iso-8859-7').decode(Uint8Array.of(0xae)))).toBe('�');
  });

  it('encodes UTF-8 input in the set; a character it lacks is sent as ?', () => {
    expect([...terminalCodec('iso-8859-15').encode(utf8('é€'))]).toEqual([0xe9, 0xa4]);
    expect([...terminalCodec('cp850').encode(utf8('é'))]).toEqual([0x82]);
    expect([...terminalCodec('iso-8859-1').encode(utf8('a€😀'))]).toEqual([0x61, 0x3f, 0x3f]);
  });

  it('joins a UTF-8 character split across two writes', () => {
    const codec = terminalCodec('windows-1252');
    const euro = utf8('€');
    expect([...codec.encode(euro.subarray(0, 1))]).toEqual([]);
    expect([...codec.encode(euro.subarray(1))]).toEqual([0x80]);
  });

  it('round-trips every defined byte of every set', () => {
    for (const charset of CHARSETS) {
      const codec = terminalCodec(charset);
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i).filter((b) =>
        charset === 'utf-8' ? b < 0x80 : b < 0x80 || HIGH_HALVES[charset][b - 0x80] !== '�',
      );
      expect([...codec.encode(codec.decode(bytes))], charset).toEqual([...bytes]);
    }
  });

  it('has 128 characters for the high half of every set', () => {
    for (const [charset, high] of Object.entries(HIGH_HALVES)) expect([...high].length, charset).toBe(128);
  });
});

const FILE = parseHostsFile(`
version: 1
groups:
  - id: legacy
    name: Legacy
    ssh: { user: ops, auth: { agent: true }, charset: iso-8859-15, term: vt220 }
    hosts:
      - { id: switch, name: switch, address: 10.0.0.2 }
      - { id: router, name: router, address: 10.0.0.3, ssh: { charset: cp850, term: vt100 } }
hosts:
  - { id: plain, name: plain, address: 10.0.0.1, ssh: { user: u, auth: { agent: true }, jump: switch } }
`);

describe('charset and term on hosts and groups (#427)', () => {
  it('are UTF-8 and xterm-256color by default', () => {
    const ssh = resolveHost(FILE, 'plain').ssh;
    expect(ssh.charset).toEqual({ value: 'utf-8', from: 'default' });
    expect(ssh.term).toEqual({ value: 'xterm-256color', from: 'default' });
  });

  it('come from the nearest level, then Preferences', () => {
    expect(resolveHost(FILE, 'switch').ssh.charset).toEqual({ value: 'iso-8859-15', from: { group: 'legacy' } });
    expect(resolveHost(FILE, 'switch').ssh.term).toEqual({ value: 'vt220', from: { group: 'legacy' } });
    expect(resolveHost(FILE, 'router').ssh.charset).toEqual({ value: 'cp850', from: 'host' });
    expect(resolveSettings(FILE, 'router')).toMatchObject({ charset: 'cp850', term: 'vt100' });
    const prefs = { charset: 'windows-1252', term: 'xterm' } as const;
    expect(resolveHost(FILE, 'plain', prefs).ssh.charset).toEqual({ value: 'windows-1252', from: 'preferences' });
    expect(resolveHost(FILE, 'plain', prefs).ssh.term).toEqual({ value: 'xterm', from: 'preferences' });
    expect(resolveHost(FILE, 'switch', prefs).ssh.term).toEqual({ value: 'vt220', from: { group: 'legacy' } });
  });

  it('are the target’s own on a jump chain: each hop resolves its own', () => {
    const [jump, target] = jumpChain(FILE, 'plain');
    expect(jump?.ssh.charset.value).toBe('iso-8859-15');
    expect(target?.ssh.charset.value).toBe('utf-8');
  });

  it('round-trip', () => {
    const text = serializeHostsFile(FILE);
    expect(parseHostsFile(text)).toEqual(FILE);
    expect(text).toMatch(/charset: cp850/);
    expect(text).toMatch(/term: vt100/);
  });

  it('refuse a set not on the list and a terminal type that is not a name', () => {
    const host = (ssh: string): string => `version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: ${ssh} }\n`;
    expect(() => parseHostsFile(host('{ charset: ebcdic }'))).toThrow(/charset/);
    expect(() => parseHostsFile(host('{ charset: UTF-8 }'))).toThrow(/charset/);
    expect(() => parseHostsFile(host('{ term: "xterm 256" }'))).toThrow(/term/);
    expect(() => parseHostsFile(host('{ term: "-x" }'))).toThrow(/term/);
    expect(() => parseHostsFile(host(`{ term: ${'x'.repeat(65)} }`))).toThrow(/term/);
  });
});

describe('withCharset (#427)', () => {
  it('decodes what a session hands out and encodes what is written to it; UTF-8 leaves it as is', () => {
    const written: Uint8Array[] = [];
    let listener: ((data: Uint8Array) => void) | undefined;
    const raw: SshSession = {
      id: 's1',
      agentForwarding: 'off',
      write: (data) => written.push(data),
      resize: () => undefined,
      close: () => undefined,
      exec: () => Promise.resolve(''),
      onData: (l) => {
        listener = l;
        return () => undefined;
      },
      onExit: () => () => undefined,
    };
    expect(withCharset(raw, 'utf-8')).toBe(raw);
    const session = withCharset(raw, 'cp850');
    expect(session.id).toBe('s1');
    const seen: string[] = [];
    session.onData((data) => seen.push(text(data)));
    listener?.(Uint8Array.of(0x82));
    expect(seen).toEqual(['é']);
    session.write(utf8('é'));
    expect([...(written[0] ?? [])]).toEqual([0x82]);
  });
});
