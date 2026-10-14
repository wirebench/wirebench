import type { ImportedForward, ImportedSession, SessionSource } from './sessions.js';

const SESSIONS_KEY = '\\software\\simontatham\\putty\\sessions\\';
const DEFAULT_SESSION = 'Default Settings';
/** `ProxyMethod` 6 is a proxy reached over SSH: the one kind Wirebench has, a jump host. */
const PROXY_SSH = 6;
const PROXY_NONE = 0;

/** `%20` → a space: a session name as the registry key stores it, decoded. */
function unmunge(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i += 1) {
    const hex = name.slice(i + 1, i + 3);
    if (name[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
    } else out += name[i];
  }
  return out;
}

/** A `"name"=value` line: a string (with `\\` and `\"` escapes) or a `dword:` number; other types are left out. */
function readValue(line: string): { name: string; value: string | number } | undefined {
  const close = line.indexOf('"=', 1);
  if (!line.startsWith('"') || close === -1) return undefined;
  const name = line.slice(1, close);
  const raw = line.slice(close + 2);
  if (raw.startsWith('dword:')) {
    const hex = raw.slice(6).trim();
    return /^[0-9A-Fa-f]{1,8}$/.test(hex) ? { name, value: parseInt(hex, 16) } : undefined;
  }
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return undefined;
  let value = '';
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch === '\\' && i + 1 < body.length) {
      value += body[i + 1];
      i += 1;
    } else value += ch;
  }
  return { name, value };
}

/** `[bind:]port`, with a bracketed IPv6 bind allowed. */
function readSource(text: string): { bind?: string; port: number } | undefined {
  const colon = text.lastIndexOf(':');
  const portText = colon === -1 ? text : text.slice(colon + 1);
  if (!/^\d{1,5}$/.test(portText)) return undefined;
  const port = Number(portText);
  if (colon === -1) return { port };
  let bind = text.slice(0, colon);
  if (bind.startsWith('[') && bind.endsWith(']')) bind = bind.slice(1, -1);
  return bind === '' ? { port } : { bind, port };
}

/**
 * `L8080=localhost:80,4R9000=127.0.0.1:9000,D1080`: an optional address family (`4`, `6`), the type, the
 * listening `[bind:]port`, and for `L` and `R` the target. A part that does not read is counted.
 */
export function parsePuttyForwards(value: string): { forwards: ImportedForward[]; unread: number } {
  const forwards: ImportedForward[] = [];
  let unread = 0;
  for (const part of value.split(',')) {
    const item = part.trim();
    if (item === '') continue;
    const rest = item.startsWith('4') || item.startsWith('6') ? item.slice(1) : item;
    const letter = rest[0];
    const type = letter === 'L' ? 'local' : letter === 'R' ? 'remote' : letter === 'D' ? 'dynamic' : undefined;
    const eq = rest.indexOf('=');
    const from = readSource(eq === -1 ? rest.slice(1) : rest.slice(1, eq));
    const target = eq === -1 ? '' : rest.slice(eq + 1);
    if (type === undefined || from === undefined || (type !== 'dynamic' && target === '')) {
      unread += 1;
      continue;
    }
    forwards.push({ type, ...from, ...(type === 'dynamic' ? {} : { target }) });
  }
  return { forwards, unread };
}

interface RegSession {
  readonly name: string;
  readonly line: number;
  readonly values: Map<string, { value: string | number; line: number }>;
}

/**
 * The SSH sessions in a registry export of `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions`. Reads
 * only the text it is given; a password (PuTTY saves one only for a proxy) is counted, never kept.
 */
export function parsePuttyReg(text: string): SessionSource {
  const regSessions: RegSession[] = [];
  let current: RegSession | undefined;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      const key = line.slice(1, -1);
      const at = key.toLowerCase().indexOf(SESSIONS_KEY);
      const name = at === -1 ? '' : key.slice(at + SESSIONS_KEY.length);
      current =
        name === '' || name.includes('\\') ? undefined : { name: unmunge(name), line: index + 1, values: new Map() };
      if (current) regSessions.push(current);
      return;
    }
    const value = current === undefined ? undefined : readValue(line);
    if (value) current?.values.set(value.name, { value: value.value, line: index + 1 });
  });

  const sessions: ImportedSession[] = [];
  const skipped: { line: number; keyword: string; why: string }[] = [];
  let passwords = 0;
  for (const reg of regSessions) {
    if (reg.name === DEFAULT_SESSION) continue;
    const str = (name: string): string | undefined => {
      const v = reg.values.get(name)?.value;
      return typeof v === 'string' && v !== '' ? v : undefined;
    };
    const num = (name: string): number | undefined => {
      const v = reg.values.get(name)?.value;
      return typeof v === 'number' ? v : undefined;
    };
    if (str('ProxyPassword') !== undefined || str('Password') !== undefined) passwords += 1;
    const protocol = str('Protocol') ?? 'ssh';
    if (protocol !== 'ssh') {
      skipped.push({ line: reg.line, keyword: reg.name, why: `a ${protocol} session, not SSH` });
      continue;
    }
    const hostName = str('HostName');
    if (hostName === undefined) {
      skipped.push({ line: reg.line, keyword: reg.name, why: 'has no host name' });
      continue;
    }
    const at = hostName.lastIndexOf('@');
    const address = at === -1 ? hostName : hostName.slice(at + 1);
    const user = str('UserName') ?? (at === -1 ? undefined : hostName.slice(0, at));
    const port = num('PortNumber');
    const keyFile = str('PublicKeyFile');

    let jump: string | undefined;
    const method = num('ProxyMethod') ?? PROXY_NONE;
    const proxyHost = str('ProxyHost');
    if (method === PROXY_SSH && proxyHost !== undefined) {
      const proxyUser = str('ProxyUsername');
      const proxyPort = num('ProxyPort');
      // A bare name may be another saved session; the planner looks it up before reading it as a host.
      const userPart = proxyUser === undefined ? '' : `${proxyUser}@`;
      const portPart = proxyPort === undefined || proxyPort === 22 ? '' : `:${String(proxyPort)}`;
      jump = `${userPart}${proxyHost}${portPart}`;
    } else if (method !== PROXY_NONE) {
      skipped.push({
        line: reg.values.get('ProxyMethod')?.line ?? reg.line,
        keyword: 'ProxyMethod',
        why: `${reg.name}: only an SSH proxy becomes a jump host; imported without it`,
      });
    }

    const { forwards, unread } = parsePuttyForwards(str('PortForwardings') ?? '');
    if (unread > 0) {
      skipped.push({
        line: reg.values.get('PortForwardings')?.line ?? reg.line,
        keyword: 'PortForwardings',
        why: `${reg.name}: ${String(unread)} port forward${unread === 1 ? '' : 's'} could not be read`,
      });
    }
    sessions.push({
      name: reg.name,
      line: reg.line,
      folder: [],
      address,
      ...(port === undefined ? {} : { port }),
      ...(user === undefined ? {} : { user }),
      ...(keyFile === undefined ? {} : { keyFile }),
      ...(jump === undefined ? {} : { jump }),
      ...(forwards.length === 0 ? {} : { forwards }),
    });
  }
  return { format: 'putty', sessions, skipped, ignored: [], notes: [], passwords };
}
