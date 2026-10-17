import { describe, expect, it } from 'vitest';
import { TELNET_OPTION, TELNET_SIGN_IN_MS, TelnetCodec, TelnetSignIn } from '../../src/index.js';

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const { binary: BINARY, echo: ECHO, sga: SGA, ttype: TTYPE, naws: NAWS } = TELNET_OPTION;

const codec = (cols = 80, rows = 24): TelnetCodec => new TelnetCodec('xterm-256color', { cols, rows });
const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const text = (data: Uint8Array): string => Buffer.from(data).toString('latin1');

describe('TelnetCodec', () => {
  it('offers terminal type and window size, and asks the server to suppress go-ahead', () => {
    expect([...codec().start()]).toEqual([IAC, WILL, TTYPE, IAC, WILL, NAWS, IAC, DO, SGA]);
  });

  it('accepts echo, go-ahead suppression and binary from the server, and refuses the rest', () => {
    const c = codec();
    expect([...c.receive(bytes(IAC, WILL, ECHO)).reply]).toEqual([IAC, DO, ECHO]);
    expect([...c.receive(bytes(IAC, WILL, BINARY)).reply]).toEqual([IAC, DO, BINARY]);
    expect([...c.receive(bytes(IAC, WILL, 34)).reply]).toEqual([IAC, DONT, 34]);
    expect([...c.receive(bytes(IAC, DO, 39)).reply]).toEqual([IAC, WONT, 39]);
    expect(c.serverDoes(ECHO)).toBe(true);
  });

  it('never answers an answer: an offer it made is acknowledged silently, a repeat is ignored', () => {
    const c = codec();
    c.start();
    expect([...c.receive(bytes(IAC, WILL, SGA)).reply]).toEqual([]);
    expect([...c.receive(bytes(IAC, WILL, SGA)).reply]).toEqual([]);
    expect([...c.receive(bytes(IAC, DO, TTYPE)).reply]).toEqual([]);
    expect([...c.receive(bytes(IAC, DO, TTYPE)).reply]).toEqual([]);
    expect([...c.receive(bytes(IAC, WONT, ECHO)).reply]).toEqual([]);
    expect([...c.receive(bytes(IAC, DONT, 39)).reply]).toEqual([]);
  });

  it('turns an option off when told, answering once', () => {
    const c = codec();
    c.receive(bytes(IAC, WILL, ECHO));
    expect([...c.receive(bytes(IAC, WONT, ECHO)).reply]).toEqual([IAC, DONT, ECHO]);
    expect([...c.receive(bytes(IAC, WONT, ECHO)).reply]).toEqual([]);
    c.receive(bytes(IAC, DO, BINARY));
    expect([...c.receive(bytes(IAC, DONT, BINARY)).reply]).toEqual([IAC, WONT, BINARY]);
  });

  it('sends the window size once NAWS is agreed, and again on resize', () => {
    const c = codec(80, 24);
    expect(c.resize(100, 30)).toHaveLength(0);
    c.start();
    expect([...c.receive(bytes(IAC, DO, NAWS)).reply]).toEqual([IAC, SB, NAWS, 0, 100, 0, 30, IAC, SE]);
    expect([...c.resize(255, 300)]).toEqual([IAC, SB, NAWS, 0, IAC, IAC, 1, 44, IAC, SE]);
  });

  it('answers the terminal type when asked', () => {
    const c = codec();
    c.start();
    const { reply } = c.receive(bytes(IAC, SB, TTYPE, 1, IAC, SE));
    expect([...reply.slice(0, 4)]).toEqual([IAC, SB, TTYPE, 0]);
    expect(text(reply.slice(4, -2))).toBe('xterm-256color');
    expect([...reply.slice(-2)]).toEqual([IAC, SE]);
  });

  it('holds a command split across reads, and keeps the data around it', () => {
    const c = codec();
    const first = c.receive(bytes(104, IAC));
    const second = c.receive(bytes(WILL));
    const third = c.receive(bytes(ECHO, 105));
    expect(text(first.data) + text(second.data) + text(third.data)).toBe('hi');
    expect([...third.reply]).toEqual([IAC, DO, ECHO]);
  });

  it('reads IAC IAC as 0xFF, CR NUL as CR, and drops other commands and subnegotiations', () => {
    const c = codec();
    expect([...c.receive(bytes(IAC, IAC, 13, 0, 65, IAC, 241, IAC, SB, 39, 1, 2, IAC, SE, 66)).data]).toEqual([
      255, 13, 65, 66,
    ]);
    // A CR NUL split across reads is still a bare CR.
    expect([...c.receive(bytes(13)).data]).toEqual([13]);
    expect([...c.receive(bytes(0, 67)).data]).toEqual([67]);
  });

  it('doubles IAC and sends Enter as CR LF, once even when pasted as CR LF; binary both ways sends CR', () => {
    const c = codec();
    expect([...c.encode(bytes(255, 97, 13, 98, 13, 10, 99))]).toEqual([IAC, IAC, 97, 13, 10, 98, 13, 10, 99]);
    c.receive(bytes(IAC, WILL, BINARY, IAC, DO, BINARY));
    expect([...c.encode(bytes(13))]).toEqual([13]);
  });
});

describe('TelnetSignIn', () => {
  it('types the user at the login prompt, then the password at the password prompt, then stops', () => {
    const s = new TelnetSignIn({ user: 'admin', password: 's3cret' });
    expect(s.feed('Welcome to core-sw\r\n')).toBeUndefined();
    expect(s.feed('\u001b[1mUsername:\u001b[0m ')).toEqual({ answer: 'admin\r', field: 'user' });
    expect(s.feed('admin\r\n')).toBeUndefined();
    expect(s.feed('Password: ')).toEqual({ answer: 's3cret\r', field: 'password' });
    expect(s.done).toBe(true);
    expect(s.feed('login: ')).toBeUndefined();
  });

  it('answers a password-only prompt; a prompt it has nothing for ends the watch', () => {
    expect(new TelnetSignIn({ password: 'p' }).feed('User Access Verification\r\n\r\nPassword:')).toEqual({
      answer: 'p\r',
      field: 'password',
    });
    const noUser = new TelnetSignIn({ password: 'p' });
    expect(noUser.feed('login: ')).toBeUndefined();
    expect(noUser.done).toBe(true);
    expect(noUser.feed('Password: ')).toBeUndefined();
  });

  it('with neither set is done at once; typing or 30 s ends it', () => {
    expect(new TelnetSignIn({}).done).toBe(true);
    const typed = new TelnetSignIn({ user: 'u' });
    typed.stop();
    expect(typed.feed('login: ')).toBeUndefined();
    let now = 0;
    const late = new TelnetSignIn({ user: 'u' }, () => now);
    now = TELNET_SIGN_IN_MS + 1;
    expect(late.feed('login: ')).toBeUndefined();
  });

  it('matches a prompt split across reads', () => {
    const s = new TelnetSignIn({ user: 'u' });
    expect(s.feed('log')).toBeUndefined();
    expect(s.feed('in: ')).toEqual({ answer: 'u\r', field: 'user' });
  });
});
