import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WirebenchError, WorkspaceError, nodeFs, writeFileAtomic } from '@wirebench/engine';
import {
  EMPTY_HOSTS_FILE,
  SshModelError,
  envSecretName,
  hostsFileVersion,
  isCharset,
  listResolvedHosts,
  parseHostsFile,
  secretNameOf,
  serializeHostsFile,
} from '@wirebench/ssh';
import type {
  Charset,
  ForwardEntry,
  ForwardGroupEntry,
  GroupEntry,
  HostEntry,
  HostsFile,
  IdentityEntry,
  ResolvedEnvVar,
  ResolvedHost,
  SshAuth,
  SshDefaults,
  SshProxy,
  SshSettings,
} from '@wirebench/ssh';
import type {
  EnvVarWire,
  ForwardEntryWire,
  ForwardGroupWire,
  GroupEntryWire,
  HostEntryWire,
  HostsFileWire,
  IdentityWire,
  ResolvedEnvVarWire,
  ResolvedHostWire,
  SshAuthWire,
  SshListHostsResponse,
  SshProblemWire,
  SshProxyWire,
  SshSettingsWire,
} from '../shared/ssh-wire.js';

export const HOSTS_FILE = 'hosts.yaml';

/**
 * Preferences → SSH as the resolver's last level (#571); an empty default user is none, and a character set
 * this version does not know (preferences written by a newer one) leaves the built-in UTF-8.
 */
export function sshDefaultsOf(ssh: {
  readonly user?: string | undefined;
  readonly keepAlive: number;
  readonly connectTimeout: number;
  readonly charset?: string | undefined;
  readonly term?: string | undefined;
}): SshDefaults {
  const user = ssh.user?.trim();
  return {
    ...(user === undefined || user === '' ? {} : { user }),
    keepAlive: ssh.keepAlive,
    connectTimeout: ssh.connectTimeout,
    ...(ssh.charset !== undefined && isCharset(ssh.charset) ? { charset: ssh.charset } : {}),
    ...(ssh.term === undefined || ssh.term === '' ? {} : { term: ssh.term }),
  };
}
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads and writes the workspace's `hosts.yaml`. The file holds `${secret:NAME}` tokens; everything that
 * leaves this class carries the secret NAME only. A file that does not parse is a problem on the answer,
 * not an exception, so the view can show it.
 */
export class HostsService {
  private cache: { dir: string; file: HostsFile; problems: SshProblemWire[] } | undefined;

  constructor(
    private readonly deps: {
      treeDir: () => string | undefined;
      onChanged?: () => void;
      /** Preferences → SSH, read on every resolve so a change applies at once; built-in values without it. */
      defaults?: () => SshDefaults;
    },
  ) {}

  /** The last level hosts resolve to (#571). */
  sshDefaults(): SshDefaults {
    return this.deps.defaults?.() ?? {};
  }

  /** Forget what was read; the next call reads the disk again (the workspace changed). */
  invalidate(): void {
    this.cache = undefined;
  }

  /** The last parsed model, if one has been read for the open workspace. */
  current(): HostsFile | undefined {
    return this.cache?.file;
  }

  async list(): Promise<SshListHostsResponse> {
    const { file, problems } = await this.load();
    try {
      return {
        file: fileToWire(file),
        resolved: listResolvedHosts(file, this.sshDefaults()).map(resolvedToWire),
        problems,
      };
    } catch (error) {
      throw asWirebenchError(error);
    }
  }

  /** @throws SshModelError when the file is invalid; WirebenchError `workspace-not-open` without a workspace. */
  async save(wire: HostsFileWire): Promise<SshListHostsResponse> {
    let model: HostsFile;
    try {
      model = fileFromWire(wire);
    } catch (error) {
      throw asWirebenchError(error);
    }
    return this.replace(model);
  }

  /** Writes a model file (an import's merge); validated exactly as {@link save}. */
  async replace(model: HostsFile): Promise<SshListHostsResponse> {
    const dir = this.requireDir();
    let file: HostsFile;
    try {
      file = parseHostsFile(serializeHostsFile(model)); // the round trip is the full validation
    } catch (error) {
      throw asWirebenchError(error);
    }
    await writeFileAtomic(nodeFs, join(dir, HOSTS_FILE), serializeHostsFile(file));
    this.cache = { dir, file, problems: [] };
    this.deps.onChanged?.();
    return this.list();
  }

  private requireDir(): string {
    const dir = this.deps.treeDir();
    if (!dir) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    return dir;
  }

  private async load(): Promise<{ dir: string; file: HostsFile; problems: SshProblemWire[] }> {
    const dir = this.requireDir();
    if (this.cache?.dir === dir) return this.cache;
    let text = '';
    try {
      text = await readFile(join(dir, HOSTS_FILE), 'utf8');
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno !== 'ENOENT') {
        // Raw, it would cross IPC as `internal-error`. `details.path` is a location inside the file, so not set.
        throw new WirebenchError('ssh-hosts-invalid', `${HOSTS_FILE} could not be read (${errno ?? 'unknown error'})`, {
          details: { file: HOSTS_FILE, ...(errno === undefined ? {} : { errno }) },
          cause: error,
        });
      }
    }
    let file = EMPTY_HOSTS_FILE;
    const problems: SshProblemWire[] = [];
    try {
      file = parseHostsFile(text);
    } catch (error) {
      if (!(error instanceof SshModelError)) throw error;
      const path = error.details['path'];
      problems.push({ code: error.code, message: error.message, ...(typeof path === 'string' ? { path } : {}) });
    }
    this.cache = { dir, file, problems };
    return this.cache;
  }
}

/**
 * One window's hosts file (multi-window: each window holds its own workspace, so each has its own cache).
 * `treeDir` is that window's workspace's tree root; its `workspace-not-found` means none is open.
 */
export function windowHosts(treeDir: () => string, onChanged: () => void, defaults?: () => SshDefaults): HostsService {
  return new HostsService({
    ...(defaults === undefined ? {} : { defaults }),
    treeDir: () => {
      try {
        return treeDir();
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === 'workspace-not-found') return undefined; // none open
        throw error;
      }
    },
    onChanged,
  });
}

function authToWire(auth: SshAuth | undefined): SshAuthWire | undefined {
  if (!auth) return undefined;
  if (auth.kind === 'agent') return { kind: 'agent' };
  if (auth.kind === 'password') return { kind: 'password', secret: secretNameOf(auth.password) };
  return {
    kind: 'key',
    secret: secretNameOf(auth.key),
    ...(auth.certificate ? { certificateSecret: secretNameOf(auth.certificate) } : {}),
    ...(auth.passphrase ? { passphraseSecret: secretNameOf(auth.passphrase) } : {}),
  };
}
/** `SshModelError` is not a `WirebenchError`; without this it would cross IPC as `internal-error`. */
export function asWirebenchError(error: unknown): unknown {
  return error instanceof SshModelError
    ? new WirebenchError(error.code, error.message, { details: error.details })
    : error;
}
function token(name: string): string {
  // The bad name is not echoed: a password typed into the name field would travel back in the message.
  if (!NAME.test(name)) {
    throw new SshModelError('ssh-literal-secret', 'a secret name must match [A-Za-z_][A-Za-z0-9_]*', {});
  }
  return `\${secret:${name}}`;
}
function authFromWire(auth: SshAuthWire | undefined): SshAuth | undefined {
  if (!auth) return undefined;
  if (auth.kind === 'agent') return { kind: 'agent' };
  if (auth.kind === 'password') return { kind: 'password', password: token(auth.secret) };
  return {
    kind: 'key',
    key: token(auth.secret),
    ...(auth.certificateSecret ? { certificate: token(auth.certificateSecret) } : {}),
    ...(auth.passphraseSecret ? { passphrase: token(auth.passphraseSecret) } : {}),
  };
}
function proxyToWire(proxy: SshProxy): SshProxyWire {
  const { password, ...rest } = proxy;
  return { ...rest, ...(password === undefined ? {} : { passwordSecret: secretNameOf(password) }) };
}
function proxyFromWire(proxy: SshProxyWire | false): SshProxy | false {
  if (proxy === false) return false;
  const { passwordSecret, ...rest } = proxy;
  return { ...rest, ...(passwordSecret === undefined ? {} : { password: token(passwordSecret) }) };
}
function settingsToWire({ auth, proxy, ...rest }: SshSettings): SshSettingsWire {
  const wire = authToWire(auth);
  return {
    ...rest,
    ...(wire ? { auth: wire } : {}),
    ...(proxy === undefined ? {} : { proxy: proxy === false ? false : proxyToWire(proxy) }),
  };
}
function settingsFromWire({ auth, proxy, charset, ...rest }: SshSettingsWire): SshSettings {
  const model = authFromWire(auth);
  return {
    ...rest,
    // Checked against the list when the file is parsed back before it is written.
    ...(charset === undefined ? {} : { charset: charset as Charset }),
    ...(model ? { auth: model } : {}),
    ...(proxy === undefined ? {} : { proxy: proxyFromWire(proxy) }),
  };
}
function forwardFromWire(f: ForwardEntryWire): ForwardEntry {
  if (!('type' in f)) return { id: f.id, enabled: false };
  return {
    id: f.id,
    type: f.type,
    port: f.port,
    ...(f.bind === undefined ? {} : { bind: f.bind }),
    ...(f.target === undefined ? {} : { target: f.target }),
    ...(f.autoStart === undefined ? {} : { autoStart: f.autoStart }),
    ...(f.enabled === undefined ? {} : { enabled: f.enabled }),
  };
}
/** A `${secret:NAME}` value crosses as its name; anything else as text. */
function envVarToWire(name: string, value: string): EnvVarWire {
  const secret = envSecretName(value);
  return secret === undefined ? { name, value } : { name, secret };
}
function envToWire(env: Readonly<Record<string, string>> | undefined): EnvVarWire[] | undefined {
  return env === undefined ? undefined : Object.entries(env).map(([name, value]) => envVarToWire(name, value));
}
const resolvedEnvToWire = ({ name, value, from }: ResolvedEnvVar): ResolvedEnvVarWire => ({
  ...envVarToWire(name, value),
  from,
});
/** Neither the name nor the text is echoed back: either may be a value typed into the wrong field. */
function envFromWire(env: readonly EnvVarWire[] | undefined): Record<string, string> | undefined {
  if (env === undefined || env.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const variable of env) {
    if (Object.hasOwn(out, variable.name)) {
      throw new SshModelError('ssh-hosts-invalid', 'an environment variable is listed twice', {});
    }
    if ('secret' in variable) out[variable.name] = token(variable.secret);
    else if (variable.value.includes('${secret:')) {
      throw new SshModelError(
        'ssh-hosts-invalid',
        'an environment variable holds ${secret:…} as text; choose Secret',
        {},
      );
    } else out[variable.name] = variable.value;
  }
  return out;
}
const hostToWire = (h: HostEntry): HostEntryWire => ({
  ...h,
  tags: [...h.tags],
  ssh: settingsToWire(h.ssh),
  env: envToWire(h.env),
});
const hostFromWire = (h: HostEntryWire): HostEntry => ({
  ...h,
  ssh: settingsFromWire(h.ssh),
  env: envFromWire(h.env),
  forwards: h.forwards?.map(forwardFromWire),
});
const groupToWire = (g: GroupEntry): GroupEntryWire => ({
  ...g,
  tags: [...g.tags],
  ssh: settingsToWire(g.ssh),
  env: envToWire(g.env),
  groups: g.groups.map(groupToWire),
  hosts: g.hosts.map(hostToWire),
});
const groupFromWire = (g: GroupEntryWire): GroupEntry => ({
  ...g,
  ssh: settingsFromWire(g.ssh),
  env: envFromWire(g.env),
  forwards: g.forwards?.map(forwardFromWire),
  groups: g.groups.map(groupFromWire),
  hosts: g.hosts.map(hostFromWire),
});
const identityToWire = ({ auth, ...rest }: IdentityEntry): IdentityWire => {
  const wire = authToWire(auth);
  return { ...rest, ...(wire ? { auth: wire } : {}) };
};
const identityFromWire = ({ auth, ...rest }: IdentityWire): IdentityEntry => {
  const model = authFromWire(auth);
  return { ...rest, ...(model ? { auth: model } : {}) };
};
const forwardGroupsToWire = (groups: readonly ForwardGroupEntry[]): ForwardGroupWire[] =>
  groups.map((g) => ({ id: g.id, name: g.name, rules: g.rules.map((m) => ({ host: m.host, rule: m.rule })) }));
const fileToWire = (f: HostsFile): HostsFileWire => ({
  version: f.version,
  ...(f.identities === undefined ? {} : { identities: f.identities.map(identityToWire) }),
  groups: f.groups.map(groupToWire),
  hosts: f.hosts.map(hostToWire),
  ...(f.forwardGroups === undefined ? {} : { forwardGroups: forwardGroupsToWire(f.forwardGroups) }),
});
const fileFromWire = (f: HostsFileWire): HostsFile => {
  const forwardGroups = f.forwardGroups === undefined || f.forwardGroups.length === 0 ? undefined : f.forwardGroups;
  return {
    version: hostsFileVersion({ forwardGroups }),
    ...(f.identities === undefined || f.identities.length === 0
      ? {}
      : { identities: f.identities.map(identityFromWire) }),
    groups: f.groups.map(groupFromWire),
    hosts: f.hosts.map(hostFromWire),
    ...(forwardGroups === undefined ? {} : { forwardGroups: forwardGroupsToWire(forwardGroups) }),
  };
};
const resolvedToWire = (h: ResolvedHost): ResolvedHostWire => ({
  ...h,
  tags: [...h.tags],
  path: [...h.path],
  ssh: {
    ...h.ssh,
    auth: { value: authToWire(h.ssh.auth.value), from: h.ssh.auth.from },
    proxy: { value: h.ssh.proxy.value && proxyToWire(h.ssh.proxy.value), from: h.ssh.proxy.from },
  },
  forwards: [...h.forwards],
  env: h.env.map(resolvedEnvToWire),
});
