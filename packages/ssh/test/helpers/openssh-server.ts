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

function waitForPort(port: number, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      if (child.exitCode !== null) return reject(new Error(`sshd exited: ${log()}`));
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`sshd did not listen: ${log()}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
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
  const port = await freePort();
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
  const configFile = join(dir, 'sshd_config');
  writeFileSync(configFile, config.join('\n'));
  // An older sshd does not know the option and would refuse the whole file.
  if (spawnSync(sshd, ['-t', '-f', configFile], { stdio: 'ignore' }).status !== 0) {
    writeFileSync(configFile, config.filter((line) => !line.startsWith('PerSourcePenalties')).join('\n'));
  }
  let output = '';
  const child = spawn(sshd, ['-D', '-e', '-f', join(dir, 'sshd_config')], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (data: Buffer) => (output += data.toString('utf8')));
  child.stderr?.on('data', (data: Buffer) => (output += data.toString('utf8')));
  await waitForPort(port, child, () => output);
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
