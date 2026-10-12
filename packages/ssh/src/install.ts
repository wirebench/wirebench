import type { ClientChannel } from 'ssh2';
import { SshConnectError, dialChain, hostOf } from './dial.js';
import type { DialOptions, DialledChain } from './dial.js';
import { SshModelError } from './errors.js';
import { describePublicKey } from './keygen.js';

/** POSIX single quotes: everything literal, a `'` closed, escaped and reopened. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * The script the remote runs (as `sh -c script wirebench KEY`): makes `~/.ssh` (700) and `authorized_keys`
 * (600) when missing, takes group and other write off both (sshd's StrictModes refuses them), and appends
 * the key unless a line already holds the same type and blob (whatever its options or comment; a commented
 * out line does not count). It prints `wirebench:present` or `wirebench:added`; any failure exits non-zero.
 */
const SCRIPT = [
  'set -e',
  'umask 077',
  'k=$1',
  't=${k%% *}',
  'r=${k#* }',
  'b=${r%% *}',
  'd="$HOME/.ssh"',
  'f="$d/authorized_keys"',
  '[ -d "$d" ] || mkdir -m 700 "$d"',
  '[ -e "$f" ] || : > "$f"',
  'chmod go-w "$d" "$f"',
  `if awk -v t="$t" -v b="$b" 'substr($1,1,1)!="#"{for(i=1;i<NF;i++)if($i==t&&$(i+1)==b)f=1}END{exit !f}' "$f"; then`,
  '  echo wirebench:present',
  '  exit 0',
  'fi',
  // A file whose last line has no newline would otherwise join the new key onto it.
  'if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then echo >> "$f"; fi',
  'printf \'%s\\n\' "$k" >> "$f"',
  'echo wirebench:added',
].join('\n');

/**
 * The command that installs `publicKey` in the remote user's `~/.ssh/authorized_keys`, idempotently. It runs
 * under `sh` whatever the login shell is, and the key travels as an argument, never inside the script.
 *
 * @throws SshModelError `ssh-key-invalid` when `publicKey` is not one OpenSSH public key line
 */
export function authorizedKeysCommand(publicKey: string): string {
  const key = describePublicKey(publicKey).publicKey;
  return `sh -c ${shellQuote(SCRIPT)} wirebench ${shellQuote(key)}`;
}

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one command on an open chain's last hop. */
function execOn(chain: DialledChain, host: string, command: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let code: number | null = null;
    let channel: ClientChannel | undefined;
    const timer = setTimeout(() => {
      channel?.close();
      reject(new SshConnectError('ssh-connect-failed', `${host}: the command did not finish in time`, { host }));
    }, timeoutMs);
    chain.client.exec(command, (error, ch) => {
      if (error) {
        clearTimeout(timer);
        reject(new SshConnectError('ssh-connect-failed', `${host}: ${error.message}`, { host }));
        return;
      }
      channel = ch;
      ch.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
      });
      ch.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });
      ch.on('exit', (exitCode: number | null) => {
        code = exitCode;
      });
      ch.on('close', () => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  });
}

export interface InstallKeyOptions extends DialOptions {
  /** One OpenSSH public key line. */
  readonly publicKey: string;
  /** Default 30 s. */
  readonly timeoutMs?: number;
}

/**
 * Signs in over `hops` (the host's current sign-in), appends `publicKey` to the target user's
 * `~/.ssh/authorized_keys` and disconnects. `present` when the key was already there.
 *
 * @throws SshConnectError the dial refusals (host key, auth, connect) | SshModelError `ssh-key-invalid` |
 *   `ssh-install-failed` when the remote command failed (its first error line is in the message)
 */
export async function installPublicKey(options: InstallKeyOptions): Promise<'added' | 'present'> {
  const command = authorizedKeysCommand(options.publicKey);
  const target = options.hops[options.hops.length - 1];
  const host = target ? hostOf(target) : '';
  const chain = await dialChain(options);
  try {
    const result = await execOn(chain, host, command, options.timeoutMs ?? 30_000);
    const marker = /wirebench:(added|present)/.exec(result.stdout)?.[1];
    if (result.code === 0 && (marker === 'added' || marker === 'present')) return marker;
    const reason = result.stderr
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim()
      .slice(0, 300);
    throw new SshModelError(
      'ssh-install-failed',
      `${host}: the key could not be added to ~/.ssh/authorized_keys${reason ? ` (${reason})` : ''}`,
      { host, ...(result.code === null ? {} : { exitCode: result.code }) },
    );
  } finally {
    chain.endAll();
  }
}
