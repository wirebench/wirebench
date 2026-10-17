import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A real OpenSSH server for the certificate tests (#421), run unprivileged on 127.0.0.1: it trusts the test
 * CA in `fixtures/certs` (`TrustedUserCAKeys`) and can only sign in the user running the tests. Certificates
 * for that user are made with `ssh-keygen -s` when asked, since a principal must name the login.
 */
export interface OpenSshServer {
  readonly port: number;
  readonly user: string;
  /** The server's host key fingerprint, as the trust prompt shows it. */
  readonly hostKeyFingerprint: string;
  /** A certificate for `fixtures/certs/<key>.pub`, made now, for `user` (or `principals`) within `validity`. */
  certify(key: string, options?: { principals?: string; validity?: string }): string;
  /** Lets `fixtures/certs/<key>.pub` in without a certificate too (`authorized_keys`). */
  authorize(key: string): void;
  /** Lets one `authorized_keys` line in (options first, as sshd reads them): a key made during the test. */
  authorizeLine(line: string): void;
  close(): Promise<void>;
}

const SSHD = ['/usr/sbin/sshd', '/usr/local/sbin/sshd', '/opt/homebrew/sbin/sshd'];
const FIXTURES = fileURLToPath(new URL('../fixtures/certs/', import.meta.url));

/** A committed test key or certificate from `fixtures/certs` (made with ssh-keygen, used nowhere else). */
export function certFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** The `sshd` binary, or undefined where OpenSSH's server (or `ssh-keygen`) is not installed. */
export function sshdPath(): string | undefined {
  if (process.platform === 'win32') return undefined;
  if (spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error) return undefined;
  return SSHD.find((candidate) => existsSync(candidate));
}

function keygen(args: string[]): void {
  const result = spawnSync('ssh-keygen', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ssh-keygen failed: ${result.stderr}`);
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Waits for sshd to say it is listening on `port`. A connect to the port is no proof: the port is free only
 * when `freePort` looks, and another test's server can bind it before sshd does, so sshd exits and the
 * connect reaches that stranger instead. Resolves false when sshd exits before it listens.
 */
function waitForListening(port: number, child: ChildProcess, log: () => string): Promise<boolean> {
  const line = `Server listening on 127.0.0.1 port ${String(port)}.`;
  return new Promise((resolve, reject) => {
    const done = (result: boolean | Error): void => {
      clearTimeout(timer);
      child.stderr?.off('data', check);
      child.off('exit', exited);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const check = (): void => {
      if (log().includes(line)) done(true);
    };
    const exited = (): void => done(false);
    const timer = setTimeout(() => done(new Error(`sshd did not listen: ${log()}`)), 10_000);
    child.stderr?.on('data', check);
    child.once('exit', exited);
    check();
  });
}

export async function startOpenSshServer(): Promise<OpenSshServer> {
  const sshd = sshdPath();
  if (sshd === undefined) throw new Error('no OpenSSH sshd is installed');
  const dir = mkdtempSync(join(tmpdir(), 'wb-sshd-'));
  const user = userInfo().username;
  keygen(['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'host_ed25519')]);
  // ssh-keygen refuses a CA key others can read; the committed copy's mode depends on the checkout.
  copyFileSync(join(FIXTURES, 'ca'), join(dir, 'ca'));
  spawnSync('chmod', ['600', join(dir, 'ca')]);
  writeFileSync(join(dir, 'authorized_keys'), '');
  const configFile = join(dir, 'sshd_config');
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    writeConfig(sshd, configFile, port, dir);
    let output = '';
    const child = spawn(sshd, ['-D', '-e', '-f', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (data: Buffer) => (output += data.toString('utf8')));
    child.stderr?.on('data', (data: Buffer) => (output += data.toString('utf8')));
    if (await waitForListening(port, child, () => output)) return serverOn(port, user, dir, child);
    // Lost the port to another listener between freePort and sshd's bind: take another one.
    if (attempt === 5) throw new Error(`sshd exited: ${output}`);
  }
}

function writeConfig(sshd: string, configFile: string, port: number, dir: string): void {
  const config = [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${join(dir, 'host_ed25519')}`,
    `PidFile ${join(dir, 'sshd.pid')}`,
    `TrustedUserCAKeys ${join(FIXTURES, 'ca.pub')}`,
    `AuthorizedKeysFile ${join(dir, 'authorized_keys')}`,
    'AuthenticationMethods publickey',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'StrictModes no',
    'LogLevel VERBOSE',
    // OpenSSH 9.8+ shuts out an address after failed sign-ins, which the refusal tests make on purpose.
    'PerSourcePenalties no',
    '',
  ];
  writeFileSync(configFile, config.join('\n'));
  // An older sshd does not know the option and would refuse the whole file.
  if (spawnSync(sshd, ['-t', '-f', configFile], { stdio: 'ignore' }).status !== 0) {
    writeFileSync(configFile, config.filter((line) => !line.startsWith('PerSourcePenalties')).join('\n'));
  }
}

function serverOn(port: number, user: string, dir: string, child: ChildProcess): OpenSshServer {
  let serial = 100;
  const hostBlob = Buffer.from(readFileSync(join(dir, 'host_ed25519.pub'), 'utf8').split(' ')[1] ?? '', 'base64');
  return {
    port,
    user,
    hostKeyFingerprint: `SHA256:${createHash('sha256').update(hostBlob).digest('base64').replace(/=+$/, '')}`,
    certify(key, options = {}) {
      copyFileSync(join(FIXTURES, `${key}.pub`), join(dir, `${key}.pub`));
      keygen([
        '-q',
        ...['-s', join(dir, 'ca'), '-I', `${key}-test`, '-n', options.principals ?? user],
        ...['-V', options.validity ?? '-5m:+1h', '-z', String(serial++), join(dir, `${key}.pub`)],
      ]);
      return readFileSync(join(dir, `${key}-cert.pub`), 'utf8');
    },
    authorize(key) {
      writeFileSync(join(dir, 'authorized_keys'), readFileSync(join(FIXTURES, `${key}.pub`), 'utf8'), { flag: 'a' });
    },
    authorizeLine(line) {
      writeFileSync(join(dir, 'authorized_keys'), `${line.trim()}\n`, { flag: 'a' });
    },
    async close() {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
