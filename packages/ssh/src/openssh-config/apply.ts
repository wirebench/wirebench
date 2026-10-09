import { SshModelError } from '../errors.js';
import {
  parseHostsFile,
  serializeHostsFile,
  type GroupEntry,
  type HostEntry,
  type HostsFile,
  type SshAuth,
} from '../model.js';
import { walk } from '../tree.js';
import type { PlannedAuth, PlannedSettings, SshConfigImportPlan } from './plan.js';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What the user picked for one key row. */
export type SshKeyChoice =
  | { readonly kind: 'agent' }
  | { readonly kind: 'existing'; readonly secret: string }
  | { readonly kind: 'store'; readonly secret: string };

export interface SshConfigImportChoices {
  readonly groupName: string;
  /** Ids of duplicates to import anyway. */
  readonly importDuplicates: readonly string[];
  /** By key `ref`; a row with no choice uses the SSH agent. */
  readonly keys: Readonly<Record<string, SshKeyChoice>>;
  /** Refs of stored keys found to be encrypted: their hosts get a `<secret>_passphrase` reference. */
  readonly encrypted?: readonly string[];
}

function token(name: string): string {
  // The bad name is not echoed: a key or password typed into the name field would travel back in the message.
  if (!NAME.test(name))
    throw new SshModelError('ssh-literal-secret', 'a secret name must match [A-Za-z_][A-Za-z0-9_]*');
  return `\${secret:${name}}`;
}

/**
 * `existing` with one new group holding the plan's hosts as the user chose. Existing entries are untouched.
 * The result has passed the model's full validation.
 * @throws SshModelError `ssh-import-stale` when an id the plan uses now exists in `existing`.
 */
export function applySshConfigImport(
  plan: SshConfigImportPlan,
  choices: SshConfigImportChoices,
  existing: HostsFile,
): HostsFile {
  const name = choices.groupName.trim();
  if (name === '') throw new SshModelError('ssh-hosts-invalid', 'The group needs a name');
  const refs = new Set(plan.keys.map((k) => k.ref));
  for (const ref of Object.keys(choices.keys)) {
    if (!refs.has(ref)) throw new SshModelError('ssh-hosts-invalid', `No key row "${ref}" in this import`);
  }
  const encrypted = new Set(choices.encrypted ?? []);

  const authOf = (auth: PlannedAuth | undefined): SshAuth | undefined => {
    if (auth === undefined) return undefined;
    if (auth.kind === 'agent') return { kind: 'agent' };
    const choice = choices.keys[auth.ref] ?? { kind: 'agent' };
    if (choice.kind === 'agent') return { kind: 'agent' };
    const key = token(choice.secret);
    return choice.kind === 'store' && encrypted.has(auth.ref)
      ? { kind: 'key', key, passphrase: token(`${choice.secret}_passphrase`) }
      : { kind: 'key', key };
  };
  const groupAuth = authOf(plan.group.ssh.auth);
  const settings = (ssh: PlannedSettings, isGroup: boolean): HostEntry['ssh'] => {
    const auth = authOf(ssh.auth);
    const sameAsGroup = !isGroup && JSON.stringify(auth) === JSON.stringify(groupAuth);
    return {
      ...(ssh.user === undefined ? {} : { user: ssh.user }),
      ...(ssh.port === undefined ? {} : { port: ssh.port }),
      ...(ssh.jump === undefined ? {} : { jump: ssh.jump }),
      ...(auth === undefined || sameAsGroup ? {} : { auth }),
      ...(ssh.keepAlive === undefined ? {} : { keepAlive: ssh.keepAlive }),
      ...(ssh.connectTimeout === undefined ? {} : { connectTimeout: ssh.connectTimeout }),
    };
  };

  const wanted = new Set(choices.importDuplicates);
  const hosts: HostEntry[] = plan.hosts
    .filter(
      (h) => h.status === 'new' || h.status === 'created-for-jump' || (h.status === 'duplicate' && wanted.has(h.id)),
    )
    .map((h) => ({ id: h.id, name: h.alias, address: h.address, tags: [], ssh: settings(h.ssh, false) }));

  const taken = new Set(walk(existing).map((i) => i.entry.id));
  const clash = [plan.group.id, ...hosts.map((h) => h.id)].find((id) => taken.has(id));
  if (clash !== undefined) {
    throw new SshModelError(
      'ssh-import-stale',
      `hosts.yaml changed since the preview ("${clash}" now exists); preview again`,
      {
        id: clash,
      },
    );
  }
  const group: GroupEntry = {
    id: plan.group.id,
    name,
    tags: [],
    ssh: settings(plan.group.ssh, true),
    groups: [],
    hosts,
  };
  // The round trip is the model's full validation: ids, jumps, cycles, secret tokens.
  return parseHostsFile(serializeHostsFile({ ...existing, groups: [...existing.groups, group] }));
}
