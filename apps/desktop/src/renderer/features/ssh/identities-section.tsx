import { useState } from 'react';
import { Plus, UserRound } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import type { IdentityWire, SshAuthWire } from '../../../shared/ssh-wire.js';
import { HostAuthSection } from './host-auth-section.js';
import { passwordSecretName, slug } from './host-form-model.js';
import { useHostsStore } from './hosts-store.js';
import {
  authSummary,
  freeIdentityId,
  identitiesOf,
  identityHosts,
  identityReferences,
  removeIdentity,
  upsertIdentity,
} from './identities.js';
import { INPUT_CLASS } from './inherited-field.js';
import { useSecretNames } from './secret-fields.js';
import { useRevealMissing } from './reveal-missing.js';
import { storeSshSecret } from './secret-writes.js';

const NO_PROVENANCE = { value: undefined, from: 'default' } as const;

/** Why the identity form cannot be stored yet; undefined when it can. */
export function identityProblem(name: string, auth: SshAuthWire | undefined, password: string): string | undefined {
  if (name.trim() === '') return 'Name is required';
  if (auth?.kind === 'password' && auth.secret === '' && password === '') return 'Password is required';
  if (auth?.kind === 'key' && auth.secret === '') return 'Choose a private key';
  return undefined;
}

/**
 * Adds or edits one identity: a name, a user and a way to sign in. A typed password goes to this machine's
 * secret store first; the hosts file only ever gets its name, as for a host.
 */
function IdentityForm({ identity, onDone }: { readonly identity?: IdentityWire; readonly onDone: () => void }) {
  const [name, setName] = useState(identity?.name ?? '');
  const [user, setUser] = useState(identity?.user ?? '');
  const [auth, setAuth] = useState<SshAuthWire | undefined>(identity?.auth ?? { kind: 'password', secret: '' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const { names } = useSecretNames();
  const problem = identityProblem(name, auth, password);
  const { revealed, reveal, onBlur } = useRevealMissing();
  const shown = revealed ? problem : undefined;

  const submit = async (): Promise<void> => {
    const hosts = useHostsStore.getState();
    const id = identity?.id ?? freeIdentityId(hosts.file, slug(name));
    let clean = auth;
    if (clean?.kind === 'password' && password !== '') {
      const secret =
        clean.secret !== ''
          ? clean.secret
          : passwordSecretName(
              id,
              names.map((n) => n.name),
            );
      const stored = await storeSshSecret({ name: secret, value: password });
      if (!stored.ok) {
        setError(`The password was not stored: ${stored.error.message}`);
        return;
      }
      clean = { ...clean, secret };
      setAuth(clean);
      setPassword('');
    }
    const next = upsertIdentity(hosts.file, {
      id,
      name: name.trim(),
      ...(user.trim() === '' ? {} : { user: user.trim() }),
      ...(clean === undefined ? {} : { auth: clean }),
    });
    if (await hosts.save(next)) {
      onDone();
      return;
    }
    setError(useHostsStore.getState().problems[0]?.message ?? 'The identity could not be stored.');
  };

  return (
    <form
      aria-label={identity === undefined ? 'New identity' : `Edit identity ${identity.name}`}
      data-testid="identity-form"
      className="flex flex-col gap-3 rounded-md border border-hairline p-3"
      onBlur={onBlur}
      onSubmit={(e) => {
        e.preventDefault();
        if (problem === undefined) void submit();
        else reveal();
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-fg-subtle">Identity name</span>
          <input
            aria-required="true"
            className={INPUT_CLASS}
            value={name}
            autoFocus
            placeholder="Deploy user"
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-fg-subtle">User</span>
          <input
            className={INPUT_CLASS}
            value={user}
            spellCheck={false}
            onChange={(e) => {
              setUser(e.target.value);
            }}
          />
        </label>
      </div>
      <HostAuthSection
        value={auth}
        inherited={NO_PROVENANCE}
        noneLabel="None"
        onChange={setAuth}
        password={password}
        onPasswordChange={setPassword}
      />
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-fg-subtle">{shown}</span>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={shown !== undefined}>
          {identity === undefined ? 'Add identity' : 'Update identity'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The keychain's identities (#416): a user and a way to sign in, named once and used by hosts in any group.
 * Each row lists the hosts that sign in with it; editing it changes them all, and deleting one in use asks
 * first.
 */
export function IdentitiesSection({ filter }: { readonly filter: string }) {
  const file = useHostsStore((s) => s.file);
  const resolved = useHostsStore((s) => s.resolved);
  const [editing, setEditing] = useState<{ readonly id?: string }>();
  const [deleting, setDeleting] = useState<IdentityWire>();
  const [error, setError] = useState<string>();
  const identities = identitiesOf(file);
  const needle = filter.trim().toLowerCase();
  const shown = identities.filter(
    (identity) =>
      needle === '' ||
      [identity.name, identity.user ?? '', ...identityHosts(resolved, identity.id)].some((field) =>
        field.toLowerCase().includes(needle),
      ),
  );

  const remove = async (identity: IdentityWire): Promise<void> => {
    const hosts = useHostsStore.getState();
    const saved = await hosts.save(removeIdentity(hosts.file, identity.id));
    setError(saved ? undefined : (useHostsStore.getState().problems[0]?.message ?? 'The identity was not deleted.'));
  };
  const askRemove = (identity: IdentityWire): void => {
    if (identityReferences(file, identity.id).length === 0) void remove(identity);
    else setDeleting(identity);
  };
  const close = (): void => {
    setEditing(undefined);
  };

  return (
    <section aria-label="Identities" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium text-fg-default">Identities</h3>
        <Button
          onClick={() => {
            setEditing({});
          }}
        >
          <Plus size={13} aria-hidden /> New identity
        </Button>
      </div>
      <p className="text-xs text-fg-subtle">
        A user and a way to sign in that hosts in any group can use. Changing one changes every host that uses it.
      </p>
      {editing !== undefined && editing.id === undefined && <IdentityForm onDone={close} />}
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
      {shown.length > 0 && (
        <ul
          aria-label="Identities"
          className="flex flex-col divide-y divide-hairline rounded-md border border-hairline"
        >
          {shown.map((identity) => {
            if (editing?.id === identity.id) {
              return (
                <li key={identity.id} className="p-2">
                  <IdentityForm identity={identity} onDone={close} />
                </li>
              );
            }
            const users = identityHosts(resolved, identity.id);
            return (
              <li
                key={identity.id}
                data-testid={`identity-row-${identity.id}`}
                className="flex items-center gap-3 px-3 py-2"
              >
                <UserRound size={15} aria-hidden="true" className="shrink-0 text-fg-subtle" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-fg-default">{identity.name}</span>
                  <span className="truncate font-mono text-xs text-fg-subtle">
                    {`${identity.user ?? 'no user'} · ${authSummary(identity.auth)}`}
                  </span>
                  <span className="truncate text-xs text-fg-subtle">
                    {users.length === 0 ? 'Not used by any host' : `Used by ${users.join(', ')}`}
                  </span>
                </span>
                <Button
                  onClick={() => {
                    setEditing({ id: identity.id });
                  }}
                >
                  Edit
                </Button>
                <Button
                  onClick={() => {
                    askRemove(identity);
                  }}
                >
                  Delete
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={`Delete ${deleting?.name ?? 'identity'}?`}
        description={
          deleting === undefined
            ? ''
            : `${identityReferences(file, deleting.id).join(', ')} use it. They keep their own settings and lose the user and sign-in it gave them.`
        }
        confirmLabel="Delete identity"
        destructive
        testId="identity-delete-dialog"
        onConfirm={() => {
          if (deleting !== undefined) void remove(deleting);
          setDeleting(undefined);
        }}
      />
    </section>
  );
}
