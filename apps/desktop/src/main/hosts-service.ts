import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WirebenchError, nodeFs, writeFileAtomic } from '@wirebench/engine';
import {
  EMPTY_HOSTS_FILE,
  SshModelError,
  listResolvedHosts,
  parseHostsFile,
  secretNameOf,
  serializeHostsFile,
} from '@wirebench/ssh';
import type { GroupEntry, HostEntry, HostsFile, ResolvedHost, SshAuth, SshSettings } from '@wirebench/ssh';
import type {
  GroupEntryWire,
  HostEntryWire,
  HostsFileWire,
  ResolvedHostWire,
  SshAuthWire,
  SshListHostsResponse,
  SshProblemWire,
  SshSettingsWire,
} from '../shared/ssh-wire.js';

export const HOSTS_FILE = 'hosts.yaml';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads and writes the workspace's `hosts.yaml`. The file holds `${secret:NAME}` tokens; everything that
 * leaves this class carries the secret NAME only. A file that does not parse is a problem on the answer,
 * not an exception, so the view can show it.
 */
export class HostsService {
  private cache: { dir: string; file: HostsFile; problems: SshProblemWire[] } | undefined;

  constructor(private readonly deps: { treeDir: () => string | undefined; onChanged?: () => void }) {}

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
      return { file: fileToWire(file), resolved: listResolvedHosts(file).map(resolvedToWire), problems };
    } catch (error) {
      throw asWirebenchError(error);
    }
  }

  /** @throws SshModelError when the file is invalid; WirebenchError `workspace-not-open` without a workspace. */
  async save(wire: HostsFileWire): Promise<SshListHostsResponse> {
    const dir = this.requireDir();
    let file: HostsFile;
    try {
      file = parseHostsFile(serializeHostsFile(fileFromWire(wire))); // the round trip is the full validation
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

function authToWire(auth: SshAuth | undefined): SshAuthWire | undefined {
  if (!auth) return undefined;
  if (auth.kind === 'agent') return { kind: 'agent' };
  if (auth.kind === 'password') return { kind: 'password', secret: secretNameOf(auth.password) };
  return {
    kind: 'key',
    secret: secretNameOf(auth.key),
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
    ...(auth.passphraseSecret ? { passphrase: token(auth.passphraseSecret) } : {}),
  };
}
function settingsToWire({ auth, ...rest }: SshSettings): SshSettingsWire {
  const wire = authToWire(auth);
  return { ...rest, ...(wire ? { auth: wire } : {}) };
}
function settingsFromWire({ auth, ...rest }: SshSettingsWire): SshSettings {
  const model = authFromWire(auth);
  return { ...rest, ...(model ? { auth: model } : {}) };
}
const hostToWire = (h: HostEntry): HostEntryWire => ({ ...h, tags: [...h.tags], ssh: settingsToWire(h.ssh) });
const hostFromWire = (h: HostEntryWire): HostEntry => ({ ...h, ssh: settingsFromWire(h.ssh) });
const groupToWire = (g: GroupEntry): GroupEntryWire => ({
  ...g,
  tags: [...g.tags],
  ssh: settingsToWire(g.ssh),
  groups: g.groups.map(groupToWire),
  hosts: g.hosts.map(hostToWire),
});
const groupFromWire = (g: GroupEntryWire): GroupEntry => ({
  ...g,
  ssh: settingsFromWire(g.ssh),
  groups: g.groups.map(groupFromWire),
  hosts: g.hosts.map(hostFromWire),
});
const fileToWire = (f: HostsFile): HostsFileWire => ({
  version: 1,
  groups: f.groups.map(groupToWire),
  hosts: f.hosts.map(hostToWire),
});
const fileFromWire = (f: HostsFileWire): HostsFile => ({
  version: 1,
  groups: f.groups.map(groupFromWire),
  hosts: f.hosts.map(hostFromWire),
});
const resolvedToWire = (h: ResolvedHost): ResolvedHostWire => ({
  ...h,
  tags: [...h.tags],
  path: [...h.path],
  ssh: { ...h.ssh, auth: { value: authToWire(h.ssh.auth.value), from: h.ssh.auth.from } },
});
