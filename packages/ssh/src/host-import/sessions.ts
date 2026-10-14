import { SshModelError } from '../errors.js';
import { forwardEntrySchema, type ForwardEntry, type ForwardType } from '../forward-rules.js';
import type { HostsFile } from '../model.js';
import { listResolvedHosts, resolveSettings } from '../resolve.js';
import { walk } from '../tree.js';
import { displayPath, pathsFor } from '../openssh-config/load.js';
import {
  parseHop,
  slugId,
  unique,
  type PlannedAuth,
  type PlannedFolder,
  type PlannedHost,
  type PlannedSettings,
  type SshConfigImportPlan,
} from '../openssh-config/plan.js';

/** The session-list formats; each has a parser beside this file. */
export type SessionFormat = 'putty' | 'securecrt' | 'mobaxterm' | 'csv';

/** A port forward as a session file describes it, before it is given an id. */
export interface ImportedForward {
  readonly type: ForwardType;
  readonly port: number;
  readonly bind?: string;
  /** `host:port`; absent on a dynamic forward. */
  readonly target?: string;
}

/** One SSH session read from a file. Never carries a password. */
export interface ImportedSession {
  readonly name: string;
  /** 1-based, where the session starts; for the report. */
  readonly line: number;
  /** Folder names, outermost first; `[]` for none. */
  readonly folder: readonly string[];
  readonly address: string;
  readonly port?: number;
  readonly user?: string;
  /** The key file as written in the source. */
  readonly keyFile?: string;
  /** Another session's name or `folder/name`, or `[user@]host[:port]`. */
  readonly jump?: string;
  readonly tags?: readonly string[];
  readonly forwards?: readonly ImportedForward[];
}

/** What a parser read: the sessions, and what it left out. */
export interface SessionSource {
  readonly format: SessionFormat;
  readonly sessions: readonly ImportedSession[];
  /** Sessions or fields not carried across; never the value. */
  readonly skipped: readonly { line: number; keyword: string; why: string }[];
  readonly ignored: readonly { keyword: string; count: number }[];
  readonly notes: readonly string[];
  /** Sessions that held a saved password (left behind). */
  readonly passwords: number;
}

export interface SessionImportInput {
  readonly source: SessionSource;
  /** The file read, as shown to the user. */
  readonly file: string;
  readonly home: string;
  readonly existing: HostsFile;
  /** Secret names that already resolve in the workspace; a proposal never reuses one. */
  readonly existingSecretNames: readonly string[];
}

export const SESSION_GROUP_NAMES: Readonly<Record<SessionFormat, string>> = {
  putty: 'PuTTY',
  securecrt: 'SecureCRT',
  mobaxterm: 'MobaXterm',
  csv: 'CSV',
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * What importing a parsed session file into `existing` would do, in the shape the OpenSSH config import
 * plans, so both share the dialog and `applySshConfigImport`. Pure. Every host starts on the SSH agent.
 * @throws SshModelError `ssh-config-empty` when the file holds no SSH session.
 */
export function planSessionImport(input: SessionImportInput): SshConfigImportPlan {
  const { source, existing, home, file } = input;
  if (source.sessions.length === 0) {
    throw new SshModelError('ssh-config-empty', 'The file holds no SSH session to import');
  }
  const notes: string[] = [...source.notes];
  const note = (message: string): void => {
    if (!notes.includes(message)) notes.push(message);
  };
  const skipped = source.skipped.map((s) => ({ file, ...s }));
  const taken = new Set(walk(existing).map((i) => i.entry.id));
  const groupName = SESSION_GROUP_NAMES[source.format];
  const groupId = unique(slugId(groupName), taken, '-');

  // Folders, parents first, by path.
  const folders: PlannedFolder[] = [];
  const folderIds = new Map<string, string>();
  const folderOf = (path: readonly string[]): string | undefined => {
    let parent: string | undefined;
    for (let i = 0; i < path.length; i += 1) {
      const key = path.slice(0, i + 1).join('\u0000');
      let id = folderIds.get(key);
      if (id === undefined) {
        const name = path[i] as string;
        id = unique(slugId(name), taken, '-');
        folderIds.set(key, id);
        folders.push({
          id,
          name,
          ...(parent === undefined ? {} : { parent }),
          path: path.slice(0, i + 1).join(' / '),
        });
      }
      parent = id;
    }
    return parent;
  };

  // Key rows, one per distinct file.
  const paths = pathsFor(home);
  const secretsTaken = new Set(input.existingSecretNames);
  const keyRows = new Map<string, { ref: string; hosts: string[]; proposedSecret: string }>();
  const keyFor = (session: ImportedSession, owner: string): PlannedAuth | undefined => {
    const path = session.keyFile;
    if (path === undefined) return undefined;
    if (path.toLowerCase().endsWith('.ppk')) {
      note(
        `${session.name}: its key is a PuTTY .ppk file; convert it to OpenSSH format to store it. The host uses the SSH agent`,
      );
      return undefined;
    }
    if (!paths.isAbsolute(path)) {
      note(`${session.name}: its key file is not a path on this computer; the host uses the SSH agent`);
      return undefined;
    }
    let row = keyRows.get(path);
    if (!row) {
      const base = `ssh_key_${paths.basename(path).replace(/[^A-Za-z0-9_]/g, '_')}`;
      row = { ref: `k${String(keyRows.size + 1)}`, hosts: [], proposedSecret: unique(base, secretsTaken, '_') };
      keyRows.set(path, row);
    }
    if (!row.hosts.includes(owner)) row.hosts.push(owner);
    return { kind: 'key', ref: row.ref };
  };

  const forwardsOf = (session: ImportedSession): ForwardEntry[] | undefined => {
    const out: ForwardEntry[] = [];
    const ids = new Set<string>();
    for (const f of session.forwards ?? []) {
      const candidate = { id: unique(`${f.type}-${String(f.port)}`, new Set(ids), '-'), ...f };
      const parsed = forwardEntrySchema.safeParse(candidate);
      if (!parsed.success) {
        skipped.push({
          file,
          line: session.line,
          keyword: 'forward',
          why: `${session.name}: a ${f.type} forward on port ${String(f.port)} is not valid here`,
        });
        continue;
      }
      ids.add(candidate.id);
      out.push(parsed.data);
    }
    return out.length === 0 ? undefined : out;
  };

  const existingResolved = listResolvedHosts(existing);
  const duplicateOf = (address: string, port: number, user: string | undefined): string | undefined =>
    existingResolved.find(
      (h) =>
        h.address.toLowerCase() === address.toLowerCase() && h.ssh.port.value === port && h.ssh.user.value === user,
    )?.id;

  const hosts: Mutable<PlannedHost>[] = [];
  const agentHosts: string[] = [];
  for (const session of source.sessions) {
    const slug = slugId(session.name);
    const id = unique(slug, taken, '-');
    const ssh: Mutable<PlannedSettings> = {};
    if (session.port !== undefined && session.port !== 22) ssh.port = session.port;
    if (session.user !== undefined) ssh.user = session.user;
    const auth = keyFor(session, id);
    if (auth) ssh.auth = auth;
    else agentHosts.push(session.name);
    const dup = duplicateOf(session.address, session.port ?? 22, session.user);
    const folder = folderOf(session.folder);
    const forwards = forwardsOf(session);
    hosts.push({
      alias: session.name,
      id,
      ...(id === slug ? {} : { idChangedFrom: slug }),
      status: dup === undefined ? 'new' : 'duplicate',
      ...(dup === undefined ? {} : { duplicateOf: dup, reason: `already in hosts.yaml as ${dup}` }),
      address: session.address,
      ssh,
      ...(folder === undefined ? {} : { folder }),
      ...(session.tags === undefined || session.tags.length === 0 ? {} : { tags: [...session.tags] }),
      ...(forwards === undefined ? {} : { forwards }),
    });
  }

  // Jumps: another session by name or folder path (case-insensitive), else a host created for the hop.
  const byName = new Map<string, Mutable<PlannedHost>>();
  source.sessions.forEach((s, i) => {
    const host = hosts[i] as Mutable<PlannedHost>;
    for (const key of [[...s.folder, s.name].join('/'), s.name].map((k) => k.toLowerCase())) {
      if (!byName.has(key)) byName.set(key, host);
    }
  });
  const created = new Map<string, Mutable<PlannedHost>>();
  const hopId = (hop: string): string | undefined => {
    const known = byName.get(hop.toLowerCase());
    if (known) return known.status === 'duplicate' ? known.duplicateOf : known.id;
    const parsed = parseHop(hop);
    if (!parsed) return undefined;
    const at = source.sessions.findIndex(
      (s) =>
        s.address.toLowerCase() === parsed.host.toLowerCase() &&
        (s.port ?? 22) === (parsed.port ?? 22) &&
        (parsed.user === undefined || s.user === parsed.user),
    );
    const same = hosts[at];
    if (same) return same.status === 'duplicate' ? same.duplicateOf : same.id;
    const key = hop.toLowerCase();
    let host = created.get(key);
    if (!host) {
      const slug = slugId(parsed.host);
      const id = unique(slug, taken, '-');
      host = {
        alias: hop,
        id,
        ...(id === slug ? {} : { idChangedFrom: slug }),
        status: 'created-for-jump',
        address: parsed.host,
        ssh: {
          ...(parsed.user === undefined ? {} : { user: parsed.user }),
          ...(parsed.port === undefined ? {} : { port: parsed.port }),
        },
      };
      created.set(key, host);
    }
    return host.id;
  };
  source.sessions.forEach((s, i) => {
    if (s.jump === undefined) return;
    const host = hosts[i] as Mutable<PlannedHost>;
    const jump = hopId(s.jump);
    if (jump === undefined) note(`${s.name}: the jump host could not be mapped; imported without a jump`);
    else if (jump === host.id) note(`${s.name}: it names itself as its jump host; imported without a jump`);
    else host.ssh = { ...host.ssh, jump };
  });

  // A loop would fail the model's check on Import; drop the jump that closes it.
  const planned = new Map([...hosts, ...created.values()].map((h) => [h.id, h]));
  const jumpOf = (id: string): string | undefined => {
    const host = planned.get(id);
    if (host) return host.ssh.jump;
    try {
      return resolveSettings(existing, id).jump;
    } catch {
      return undefined;
    }
  };
  for (const host of hosts) {
    const seen = new Set([host.id]);
    for (let at = host.ssh.jump; at !== undefined; at = jumpOf(at)) {
      if (seen.has(at)) {
        const { jump, ...rest } = host.ssh;
        void jump;
        host.ssh = rest;
        note(`${host.alias}: its jump chain loops; imported without a jump`);
        break;
      }
      seen.add(at);
    }
  }
  for (const host of created.values()) note(`${host.id} (${host.alias}) was created for a jump`);

  if (agentHosts.length > 0) note(`Authenticate through the SSH agent (no key file): ${agentHosts.join(', ')}`);
  const n = source.passwords;
  note(
    n === 0
      ? 'Passwords are never imported'
      : `Saved passwords in ${String(n)} session${n === 1 ? '' : 's'} were not imported: passwords are never imported`,
  );

  return {
    group: { id: groupId, name: groupName, ssh: { auth: { kind: 'agent' } } },
    ...(folders.length === 0 ? {} : { folders }),
    hosts: [...hosts, ...created.values()],
    keys: [...keyRows].map(([path, row]) => ({
      ref: row.ref,
      path,
      display: displayPath(path, home),
      hosts: row.hosts,
      proposedSecret: row.proposedSecret,
    })),
    report: { problems: [], skipped, ignored: [...source.ignored], notes },
  };
}
