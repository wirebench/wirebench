/**
 * One plain sentence for a connect that failed (#528): what happened and what to do. Built from the
 * error's code and details only, never its message: a library's exception text is not for the screen.
 */
import type { SshAuthWire } from '../../../shared/ssh-wire.js';
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

/** The first hop's proxy failed (#417): reaching the proxy itself, or the tunnel it was asked for. */
function proxySentence(details: Readonly<Record<string, unknown>>, host: string): string {
  const where = text(details, 'proxy');
  const proxy = where === undefined ? 'the proxy' : `the proxy ${where}`;
  const words = text(details, 'proxyDetail');
  switch (details['proxyReason']) {
    case 'dns':
      return `${capitalise(proxy)} could not be found. Check the proxy's address in the host's settings, your DNS or your VPN.`;
    case 'refused':
      return words === undefined
        ? `${capitalise(proxy)} refused the connection: nothing listens on that port. Check the proxy's address and port.`
        : `${capitalise(proxy)} would not open a tunnel to ${host} (${words}). Check the host's address and port, and that the proxy allows it.`;
    case 'timeout': {
      const seconds = typeof details['timeout'] === 'number' ? ` after ${String(details['timeout'])} s` : '';
      return `No answer from ${proxy}${seconds}. Check its address, your network or VPN.`;
    }
    case 'unreachable':
      return `There is no route to ${proxy}. Check your network or VPN.`;
    case 'auth':
      return `${capitalise(proxy)} refused the sign-in${words === undefined ? '' : ` (${words})`}. Check the proxy user and password in the host's settings.`;
    case 'protocol':
      return `${capitalise(proxy)} did not answer as ${details['proxyType'] === 'http' ? 'an HTTP' : 'a SOCKS5'} proxy. Check the proxy's type and port.`;
    default:
      return `${capitalise(proxy)} closed the connection before the tunnel to ${host} opened. The log below shows how far it got.`;
  }
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
    case 'proxy':
      return proxySentence(details, host);
    default:
      if (details['phase'] === 'shell') return `Signed in, but ${who} would not open a shell.`;
      return `The connection to ${host} failed. The log below shows how far it got.`;
  }
}

function securityKeyPinSentence(details: Readonly<Record<string, unknown>>, purpose: ConnectPurpose): string {
  switch (details['reason']) {
    case 'wrong': {
      const retries = details['retries'];
      return typeof retries === 'number'
        ? `Wrong PIN for the security key: ${String(retries)} attempts left before it locks.`
        : 'Wrong PIN for the security key.';
    }
    case 'blocked':
      return 'The security key is locked after too many wrong PINs. Unplug it and plug it back in, or reset it with its maker’s tool.';
    case 'not-set':
      return 'This key asks for a PIN, but the security key has none set. Set one with its maker’s tool.';
    default:
      return purpose === 'files'
        ? 'The security key needs its PIN. Connect from a terminal tab, where you can type it.'
        : 'The security key needs its PIN to sign in.';
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
      if (details['field'] === 'user') return 'This host has no user to sign in as. Enter one to connect.';
      if (details['field'] === 'auth') {
        return 'This host has no sign-in method (password, key or agent). Edit the host to choose one.';
      }
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
    case 'ssh-sk-pin':
      return securityKeyPinSentence(details, purpose);
    case 'ssh-sk-not-touched':
      return 'The security key was not touched in time. Retry, and touch the key when it blinks.';
    case 'ssh-sk-no-device':
      return details['reason'] === 'several'
        ? 'Several security keys are plugged in. Leave only the one to use.'
        : 'The security key this host signs in with is not plugged in. Plug it in and retry.';
    case 'ssh-sk-unavailable':
      switch (details['cause']) {
        case 'windows':
          return 'Wirebench cannot reach security keys on Windows yet. Choose another sign-in method for this host.';
        case 'u2f':
          return 'This security key speaks only U2F. Signing in needs a FIDO2 key.';
        default:
          return 'Wirebench could not open the security key on this machine.';
      }
    case 'ssh-sk-failed':
      return 'The security key did not sign. Unplug it, plug it back in and retry.';
    case 'ssh-device-key-missing': {
      const madeOn = text(details, 'device');
      return `This host signs in with a device key made on ${madeOn === undefined || madeOn === '' ? 'another device' : madeOn}; it cannot sign in from here. Sign in from that device, or generate a key on this one and install it on the host.`;
    }
    case 'ssh-device-key-cancelled':
      return 'The prompt to use the device key was cancelled. Retry to confirm it.';
    case 'ssh-device-key-unavailable':
      return 'This host signs in with a device key, which only the Wirebench app on the device that made it can use.';
    case 'app-locked':
      return details['reason'] === 'cancelled'
        ? 'Wirebench is locked, and the prompt to unlock it was cancelled. Retry to unlock it and use SSH secrets.'
        : 'Wirebench is locked and could not ask to unlock it. Turn the app lock off in Settings → Secrets to connect.';
    case 'mosh-server-missing':
      return `Signed in, but ${text(details, 'server') ?? 'mosh-server'} was not found on ${who}. Install mosh on the server, or set its server command in the host's Advanced settings.`;
    case 'mosh-bootstrap-failed': {
      const said = text(details, 'serverSaid');
      if (details['timedOut'] === true) return `Signed in, but the mosh server on ${who} did not answer in time.`;
      return `Signed in, but the mosh server on ${who} did not start${said === undefined ? '.' : `: ${said}`}`;
    }
    case 'mosh-client-missing':
      return 'Mosh is not installed on this computer. Install mosh (it provides mosh-client), or switch the host to SSH in its Advanced settings.';
    case 'mosh-unreachable':
      return `Mosh connects to ${host} directly over UDP, and that address does not resolve on this computer. A host behind a jump host is often not reachable directly: switch it to SSH.`;
    case 'mosh-unavailable':
      return 'Mosh sessions are not available on this computer.';
    case 'telnet-off':
      return 'Telnet is switched off in this build of Wirebench. Connect to the device over SSH instead.';
    case 'ssh-jump-not-ssh':
      return `The jump host is ${details['protocol'] === 'serial' ? 'a serial console' : 'a Telnet host'}, and a jump host must be reached over SSH. Pick an SSH jump host in the host's Advanced settings.`;
    case 'ssh-protocol-unsupported':
      return `This is ${details['protocol'] === 'serial' ? 'a serial console' : 'a Telnet host'}: files, port forwarding and keys need SSH.`;
    case 'serial-off':
      return 'Serial consoles are switched off in this build of Wirebench.';
    case 'serial-unavailable':
      return 'Serial ports are not available on this computer.';
    case 'serial-device-unset':
      return 'Pick the serial port this console is plugged into on this computer.';
    case 'serial-device-missing':
      return `${text(details, 'device') ?? 'The serial port'} is not on this computer. Plug the adapter in, or pick another port.`;
    case 'serial-device-busy':
      return `${text(details, 'device') ?? 'The serial port'} is in use by another program. Close it there, then retry.`;
    case 'serial-permission':
      return `Wirebench may not open ${text(details, 'device') ?? 'the serial port'}. On Linux, add yourself to the dialout group (sudo usermod -aG dialout $USER), then sign out and in again.`;
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

/**
 * What stopped a connect, which decides what the screen offers (#532). `network`: the host could not be
 * reached, so trying again can work. `auth`: the server refused the sign-in, or its credential is unusable.
 * `settings`: the host's own settings stop it before anything goes on the network. `trust`: the host key
 * was not trusted.
 */
export type ConnectErrorKind = 'network' | 'auth' | 'settings' | 'trust' | 'other';

export function connectErrorKind(code: string): ConnectErrorKind {
  switch (code) {
    case 'ssh-connect-failed':
    case 'mosh-unreachable':
      return 'network';
    case 'ssh-auth-failed':
    case 'ssh-cert-expired':
    case 'ssh-cert-invalid':
    case 'ssh-cert-mismatch':
    case 'ssh-sk-pin':
      return 'auth';
    case 'ssh-host-incomplete':
    case 'secret-missing':
    case 'ssh-host-unknown':
    case 'ssh-jump-unknown':
    case 'ssh-jump-cycle':
    case 'ssh-hosts-invalid':
    case 'mosh-server-missing':
    case 'mosh-client-missing':
    case 'ssh-device-key-missing':
    case 'ssh-device-key-unavailable':
    case 'telnet-off':
    case 'ssh-jump-not-ssh':
    case 'ssh-protocol-unsupported':
    case 'serial-off':
    case 'serial-unavailable':
    case 'serial-device-unset':
    case 'serial-device-missing':
    case 'serial-permission':
      return 'settings';
    case 'ssh-host-key-new':
    case 'ssh-host-key-changed':
      return 'trust';
    default:
      return 'other';
  }
}

/** The target host's sign-in, as far as the screen's fixes need it. */
export interface SignIn {
  readonly hostId: string;
  readonly user: string | undefined;
  readonly auth: SshAuthWire | undefined;
}

/**
 * What the screen offers for a failed connect. `retryPrimary`: Retry is the main button, since trying again
 * can work. `ask`: a field on the screen fixes it there: the user to sign in as, or the password for `user`,
 * stored under the host's secret `secret`, the security key's PIN for the next connect, or a serial port.
 */
export type ConnectFix =
  | { readonly kind: ConnectErrorKind; readonly retryPrimary: boolean; readonly ask?: undefined }
  | { readonly kind: ConnectErrorKind; readonly retryPrimary: false; readonly ask: 'user' }
  | {
      readonly kind: ConnectErrorKind;
      readonly retryPrimary: false;
      readonly ask: 'password';
      readonly secret: string;
      readonly user: string | undefined;
    }
  /** The security key needs its PIN (#420); `wrong` after one it refused. */
  | { readonly kind: ConnectErrorKind; readonly retryPrimary: false; readonly ask: 'pin'; readonly wrong: boolean }
  /** A serial console (#426) has no device on this computer yet, or the one it had is gone: pick one. */
  | { readonly kind: ConnectErrorKind; readonly retryPrimary: false; readonly ask: 'device' };

/** Retry stays primary unless the same attempt would fail the same way: a refused sign-in or a setting. */
export function connectFix(error: ConnectError, target: SignIn | undefined): ConnectFix {
  const kind = connectErrorKind(error.code);
  const details = error.details ?? {};
  const retryPrimary = kind !== 'auth' && kind !== 'settings';
  const reason = details['reason'];
  if (error.code === 'ssh-sk-pin' && (reason === 'required' || reason === 'wrong')) {
    return { kind, retryPrimary: false, ask: 'pin', wrong: reason === 'wrong' };
  }
  if (error.code === 'serial-device-unset' || error.code === 'serial-device-missing') {
    return { kind, retryPrimary: false, ask: 'device' };
  }
  if (target === undefined || retryPrimary) return { kind, retryPrimary };
  const hostId = details['hostId'];
  if (
    error.code === 'ssh-host-incomplete' &&
    details['field'] === 'user' &&
    (hostId ?? target.hostId) === target.hostId
  ) {
    return { kind, retryPrimary: false, ask: 'user' };
  }
  const { auth } = target;
  const hop = details['hop'];
  const hops = details['hops'];
  const jump = typeof hop === 'number' && typeof hops === 'number' && hop < hops - 1;
  // Only the target's own password: a jump host's, a key or the agent is fixed in the host's settings.
  if (auth?.kind !== 'password' || auth.secret === '' || jump) return { kind, retryPrimary };
  const refused = error.code === 'ssh-auth-failed' && details['agent'] !== 'missing' && details['unusableKey'] !== true;
  const missing = error.code === 'secret-missing' && text(details, 'name') === auth.secret;
  if (!refused && !missing) return { kind, retryPrimary };
  return {
    kind,
    retryPrimary: false,
    ask: 'password',
    secret: auth.secret,
    user: text(details, 'user') ?? target.user,
  };
}
