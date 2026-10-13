import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authorizedKeysCommand, generateKey, shellQuote } from '../../src/index.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const newHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'wb-keys-'));
  homes.push(home);
  return home;
};

/** Runs the command as an SSH server would: the login shell's `-c`, from the home folder. */
const run = (home: string, command: string) =>
  spawnSync('/bin/sh', ['-c', command], {
    cwd: home,
    env: { HOME: home, PATH: process.env['PATH'] },
    encoding: 'utf8',
  });

const mode = (path: string): number => statSync(path).mode & 0o777;

describe.skipIf(process.platform === 'win32')('authorizedKeysCommand', { timeout: 30_000 }, () => {
  let line = '';
  let other = '';
  beforeAll(async () => {
    // A comment with quotes and shell syntax: it must reach the file as written and run nothing.
    line = (await generateKey({ algorithm: 'ed25519', comment: `o'brien "$(touch pwned)" ; echo` })).publicKey;
    other = (await generateKey({ algorithm: 'ecdsa' })).publicKey;
  });

  it('shellQuote keeps every character literal, single quotes included', () => {
    const tricky = `it's $HOME \`id\` "x" \\ ; rm -rf /`;
    const out = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(tricky)}`], { encoding: 'utf8' });
    expect(out.stdout).toBe(tricky);
  });

  it('creates ~/.ssh (700) and authorized_keys (600) and appends the key once', () => {
    const home = newHome();
    const first = run(home, authorizedKeysCommand(line));
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe('wirebench:added');
    expect(mode(join(home, '.ssh'))).toBe(0o700);
    expect(mode(join(home, '.ssh', 'authorized_keys'))).toBe(0o600);
    expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(`${line}\n`);
    expect(readdirSync(home)).toEqual(['.ssh']);

    const again = run(home, authorizedKeysCommand(line));
    expect(again.stdout.trim()).toBe('wirebench:present');
    expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(`${line}\n`);
  });

  it('counts a line with options or another comment as present, but not a commented-out one', () => {
    const home = newHome();
    const [type, blob] = line.split(' ');
    mkdirSync(join(home, '.ssh'), { mode: 0o700 });
    const file = join(home, '.ssh', 'authorized_keys');
    writeFileSync(file, `# ${type} ${blob}\n`, { mode: 0o600 });
    expect(run(home, authorizedKeysCommand(line)).stdout.trim()).toBe('wirebench:added');

    writeFileSync(file, `from="10.0.0.0/8",no-pty ${type} ${blob} renamed\n`, { mode: 0o600 });
    expect(run(home, authorizedKeysCommand(line)).stdout.trim()).toBe('wirebench:present');
  });

  it('keeps existing keys, adds a missing final newline, and takes group and other write off', () => {
    const home = newHome();
    mkdirSync(join(home, '.ssh'));
    chmodSync(join(home, '.ssh'), 0o775);
    const file = join(home, '.ssh', 'authorized_keys');
    writeFileSync(file, other); // no trailing newline
    chmodSync(file, 0o664);
    expect(run(home, authorizedKeysCommand(line)).stdout.trim()).toBe('wirebench:added');
    expect(readFileSync(file, 'utf8')).toBe(`${other}\n${line}\n`);
    expect(mode(join(home, '.ssh'))).toBe(0o755);
    expect(mode(file)).toBe(0o644);
  });

  it('fails with a non-zero status when the file cannot be written', () => {
    const home = newHome();
    mkdirSync(join(home, '.ssh', 'authorized_keys'), { recursive: true }); // a folder where the file goes
    const result = run(home, authorizedKeysCommand(line));
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('wirebench:added');
  });

  it('refuses something that is not a public key line', () => {
    expect(() => authorizedKeysCommand('ssh-ed25519 AAAA; rm -rf ~')).toThrow(
      expect.objectContaining({ code: 'ssh-key-invalid' }),
    );
  });
});
