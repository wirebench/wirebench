/**
 * One plain sentence for a connect that failed (#528): what happened and what to do. Built from the
 * error's code and details only, never its message: a library's exception text is not for the screen.
 */
import type { ConnectPurpose } from './connect-progress.js';

/** A connect's refusal as the IPC result carries it. */
export interface ConnectError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

function text(details: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = details[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function list(details: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = details[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** `address:port` → its address and port (an IPv6 address keeps its colons). */
function split(host: string): { address: string; port: string | undefined } {
  const at = host.lastIndexOf(':');
  if (at <= 0) return { address: host, port: undefined };
  return { address: host.slice(0, at), port: host.slice(at + 1) };
}

/** A sign-in method in words: `the password`, `key id_ed25519`, `the agent's keys`. */
function methodWords(method: string, key: string | undefined): string {
  switch (method) {
    case 'password':
      return 'the password';
    case 'publickey':
    case 'key':
      return key === undefined ? 'the key' : `key ${key}`;
    case 'certificate':
      return key === undefined ? 'the certificate' : `the certificate for key ${key}`;
    case 'agent':
      return "the agent's keys";
    case 'keyboard-interactive':
      return 'keyboard-interactive sign-in';
    default:
      return method;
  }
}

/** "a", "a and b", "a, b and c". */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

/** Starts a sentence: "the server" and "the jump host …" take a capital; an address is left as it is. */
function capitalise(sentence: string): string {
  return sentence.startsWith('the ') ? `T${sentence.slice(1)}` : sentence;
}

function authSentence(details: Readonly<Record<string, unknown>>, who: string): string {
  const key = text(details, 'key');
  const user = text(details, 'user');
  const as = user === undefined ? '' : ` for ${user}`;
  if (details['unusableKey'] === true) {
    return `${key === undefined ? 'The private key' : `Key ${key}`} could not be used. Check its passphrase and that it is an OpenSSH or PEM private key.`;
  }
  const tried = list(details, 'tried');
  const allowed = list(details, 'allowed');
  const method = text(details, 'method');
  const asCertificate = (m: string): string => (method === 'certificate' && m === 'publickey' ? 'certificate' : m);
  const triedWords =
    tried.length > 0
      ? joinWords([...new Set(tried.map((m) => methodWords(asCertificate(m), key)))])
      : methodWords(method ?? 'password', key);
  const others = allowed.filter((m) => !tried.includes(m) && m !== 'none');
  if (allowed.length === 0) return `${capitalise(who)} refused ${triedWords}${as}. Check the host's sign-in settings.`;
  if (others.length === 0) {
    const fix = tried.includes('password') ? 'password' : 'key';
    return `${capitalise(who)} refused ${triedWords}${as} and allows no other method (${allowed.join(', ')}). Check the ${fix} in the host's settings.`;
  }
  return `${capitalise(who)} refused ${triedWords}${as}; it allows ${others.join(', ')}. Change the host's sign-in method.`;
}

function reachSentence(details: Readonly<Record<string, unknown>>, who: string, host: string): string {
  const { address, port } = split(host);
  switch (details['reason']) {
    case 'dns':
      return `The address ${address} could not be found. Check the host's address, your DNS or your VPN.`;
    case 'refused':
      return `${capitalise(who)} refused the connection${port === undefined ? '' : ` on port ${port}`}: no SSH server is listening there. Check the port and that the server is running.`;
    case 'timeout': {
      const seconds = typeof details['timeout'] === 'number' ? ` after ${String(details['timeout'])} s` : '';
      return `No answer from ${host}${seconds}. Check the address, your network or VPN, and any firewall in between.`;
    }
    case 'unreachable':
      return `There is no route to ${host}. Check your network or VPN.`;
    case 'reset':
      return `${capitalise(who)} closed the connection before signing in. The server may limit who can connect, or may not be an SSH server.`;
    case 'jump': {
      const via = text(details, 'via');
      return `The jump host${via === undefined ? '' : ` ${via}`} could not open a connection to ${host}. Check the target's address and port from the jump host.`;
    }
    default:
      if (details['phase'] === 'shell') return `Signed in, but ${who} would not open a shell.`;
      return `The connection to ${host} failed. The log below shows how far it got.`;
  }
}

/** The sentence the screen shows under the red step. */
export function connectFailureSentence(error: ConnectError, purpose: ConnectPurpose): string {
  const details = error.details ?? {};
  const host = text(details, 'host') ?? 'the host';
  const hop = details['hop'];
  const hops = details['hops'];
  const jump = typeof hop === 'number' && typeof hops === 'number' && hop < hops - 1;
  const who = jump ? `the jump host ${host}` : host === 'the host' ? 'the server' : host;
  switch (error.code) {
    case 'ssh-connect-failed':
      return reachSentence(details, who, host);
    case 'ssh-auth-failed':
      if (details['agent'] === 'missing') {
        return 'No SSH agent is running on this machine. Start one, or choose another sign-in method for the host.';
      }
      return authSentence(details, who);
    case 'ssh-host-key-new':
      return `You did not trust the key ${who} presented, so the connection stopped. Retry to check its fingerprint again.`;
    case 'ssh-host-key-changed':
      return `The key of ${who} changed since you last trusted it. The host may have been reinstalled, or something may be intercepting the connection: check with its owner before you trust the new key.`;
    case 'secret-missing': {
      const name = text(details, 'name');
      return `The secret ${name === undefined ? 'this host signs in with' : `"${name}"`} is not on this machine. Set it in the host's settings.`;
    }
    case 'ssh-host-incomplete':
      return 'This host is missing a setting it needs to connect (its user or sign-in method). Edit the host to fill it in.';
    case 'ssh-host-unknown':
      return 'This host is no longer in the hosts file.';
    case 'ssh-jump-unknown':
      return "This host's jump host is not in the hosts file any more. Edit the host to pick another.";
    case 'ssh-jump-cycle':
      return "This host's jump hosts lead back to themselves. Edit the chain so it ends.";
    case 'ssh-cert-expired':
      return 'The certificate for this host has expired, or is not valid yet. Renew it and connect again.';
    case 'ssh-cert-invalid':
      return 'The certificate for this host could not be read. Check that it is an OpenSSH user certificate.';
    case 'ssh-cert-mismatch':
      return "The certificate does not belong to this host's key. Pair it with the key it was issued for.";
    case 'sftp-unavailable':
      return `Signed in, but ${who} offers no SFTP. Enable the SFTP subsystem on the server to browse its files.`;
    case 'ssh-hosts-invalid':
      return 'The hosts file could not be read. Fix it, then connect again.';
    case 'workspace-not-open':
    case 'ssh-session-closed':
      return 'The connection stopped because the workspace closed or changed.';
    default:
      return purpose === 'files'
        ? 'The file browser could not connect. The log below shows how far it got.'
        : 'The connection could not be started. The log below shows how far it got.';
  }
}
