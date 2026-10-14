import { describe, expect, it } from 'vitest';
import { moshBootstrapError, moshServerCommand, parseMoshConnect, shellWord } from '../../src/index.js';

const KEY = 'abcdefghijklmnopqrstuv';

describe('moshServerCommand', () => {
  it('starts mosh-server with a UTF-8 locale by default', () => {
    expect(moshServerCommand(undefined)).toBe('mosh-server new -s -c 256 -l LANG=C.UTF-8');
  });
  it('adds the variables, the port range and a custom server, quoted', () => {
    expect(
      moshServerCommand({ server: '/opt/my mosh/mosh-server', ports: '60000:60010' }, { STAGE: 'blue sky', A: "it's" }),
    ).toBe(
      `'/opt/my mosh/mosh-server' new -s -c 256 -l LANG=C.UTF-8 -l 'STAGE=blue sky' -l 'A=it'\\''s' -p 60000:60010`,
    );
  });
});

describe('shellWord', () => {
  it('leaves a plain word alone and quotes the rest', () => {
    expect(shellWord('mosh-server')).toBe('mosh-server');
    expect(shellWord('$(rm -rf ~)')).toBe(`'$(rm -rf ~)'`);
    expect(shellWord('')).toBe(`''`);
  });
});

describe('parseMoshConnect', () => {
  it('reads the port and key among the other lines', () => {
    const out = `\r\nMOSH CONNECT 60001 ${KEY}\r\n\nmosh-server (mosh 1.4.0) [build mosh 1.4.0]\n[mosh-server detached, pid = 42]\n`;
    expect(parseMoshConnect(out)).toEqual({ port: 60001, key: KEY });
  });
  it('is undefined without a well-formed line', () => {
    expect(parseMoshConnect('')).toBeUndefined();
    expect(parseMoshConnect('MOSH CONNECT 60001 short')).toBeUndefined();
    expect(parseMoshConnect(`MOSH CONNECT 99999 ${KEY}`)).toBeUndefined();
  });
});

describe('moshBootstrapError', () => {
  it('is mosh-server-missing for exit 127', () => {
    const error = moshBootstrapError({ code: 127, stdout: '', stderr: 'sh: 1: mosh-server: not found\n' }, 'h:22');
    expect(error.code).toBe('mosh-server-missing');
    expect(error.message).toMatch(/mosh-server was not found/);
  });
  it('is mosh-server-missing when the shell says so under another status', () => {
    const error = moshBootstrapError(
      { code: 1, stdout: '', stderr: 'bash: /opt/x/mosh-server: No such file or directory' },
      'h:22',
      '/opt/x/mosh-server',
    );
    expect(error.code).toBe('mosh-server-missing');
  });
  it('is mosh-bootstrap-failed with the server’s last line otherwise, never the key', () => {
    const error = moshBootstrapError(
      {
        code: 1,
        stdout: `MOSH CONNECT 1 ${KEY}`,
        stderr: "mosh-server: invalid option\nThe locale requested by LANG=C.UTF-8 isn't available here.\n",
      },
      'h:22',
    );
    expect(error.code).toBe('mosh-bootstrap-failed');
    expect(error.message).toMatch(/locale requested/);
    expect(JSON.stringify([error.message, error.details])).not.toContain(KEY);
  });
  it('says when the server did not answer in time', () => {
    const error = moshBootstrapError({ code: null, stdout: '', stderr: '', timedOut: true }, 'h:22');
    expect(error.code).toBe('mosh-bootstrap-failed');
    expect(error.message).toMatch(/did not answer in time/);
  });
});
