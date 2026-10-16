import { useEffect, useId, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import type {
  EnvVarWire,
  ForwardEntryWire,
  GroupEntryWire,
  HostsFileWire,
  SshOsId,
  SshSettingsWire,
  TerminalEntryWire,
} from '../../../shared/ssh-wire.js';
import { ipc } from '../../state/ipc-client.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { forwardProblem } from './forwarding/forward-form.js';
import { ForwardsSection, inheritedForwards } from './forwarding/forwards-section.js';
import { EnvSection, envProblem, inheritedEnv } from './env-section.js';
import { AgentForwardingSection, inheritedForwardAgent } from './agent-forwarding.js';
import { inheritedMosh, inheritedProtocol, MoshSection, moshProblem } from './mosh-section.js';
import { cleanProxy, proxyProblem, ProxySection } from './proxy-section.js';
import { OS_LABELS } from './os-icon.js';
import { HostAuthSection } from './host-auth-section.js';
import { cleanTerminal, HostTerminalSection, inheritedTerminal, terminalProblem } from './host-terminal-section.js';
import { SSH_DEFAULTS, SSH_OS_IDS } from '../../../shared/ssh-defaults.js';
import {
  ancestorsOf,
  findGroup,
  findHost,
  flattenGroups,
  freeId,
  moveHost,
  upsertGroup,
  upsertHost,
  useHostsStore,
} from './hosts-store.js';
import { INPUT_CLASS, InheritedField, InheritedSwitch, sourceText } from './inherited-field.js';
import { useRevealMissing } from './reveal-missing.js';
import {
  chainOf,
  dropEmpty,
  inheritedFrom,
  inheritedLogin,
  sshPreferenceDefaults,
  inheritedProtected,
  initialGroup,
  missingFields,
  passwordSecretName,
  slug,
  withField,
} from './host-form-model.js';
import { useSecretNames } from './secret-fields.js';
import { findIdentity, identitiesOf } from './identities.js';
import { storeSshSecret } from './secret-writes.js';

type Inheritable = 'user' | 'port' | 'jump' | 'keepAlive' | 'connectTimeout';

interface FormProps {
  readonly file: HostsFileWire;
  readonly dialog: NonNullable<ReturnType<typeof useHostsStore.getState>['dialog']>;
  /** Drawn inside the details panel rather than the dialog: a plain heading, no dialog title. */
  readonly embedded?: boolean;
}

/** The login name on this machine, which a new host's User starts from; empty until main answers, or if it cannot. */
function useLocalUser(): string {
  const [name, setName] = useState('');
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => ipc().ssh.localUser(undefined))
      .then((result) => {
        if (live && result.ok) setName(result.value.name);
      })
      // Without it the field starts empty and Save says User is required.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return name;
}

const FIELD_CLASS = 'flex flex-col gap-1 text-xs';

export function HostForm({ file, dialog, embedded = false }: FormProps) {
  const { save, closeDialog, problems, resolved, groupFilter } = useHostsStore();
  const isHost = dialog.mode === 'new-host' || dialog.mode === 'edit-host';
  const editing = dialog.mode === 'edit-host' || dialog.mode === 'edit-group';
  const existing =
    dialog.mode === 'edit-host'
      ? findHost(file, dialog.id)
      : dialog.mode === 'edit-group'
        ? findGroup(file, dialog.id)
        : undefined;
  // The group a host sits in now; Save moves it when the Group select changes.
  const [currentGroup] = useState(() =>
    dialog.mode === 'edit-host' ? ancestorsOf(file, 'host', dialog.id).at(-1)?.id : undefined,
  );
  const [groupId, setGroupId] = useState(() =>
    dialog.mode === 'new-host' || dialog.mode === 'new-group'
      ? initialGroup(file, dialog.parent, groupFilter)
      : currentGroup,
  );
  const chain: GroupEntryWire[] =
    dialog.mode === 'edit-group' ? ancestorsOf(file, 'group', dialog.id) : chainOf(file, groupId);

  const prefill = dialog.mode === 'new-host' ? dialog.prefill : undefined;
  const [name, setName] = useState(existing?.name ?? prefill?.name ?? '');
  const [address, setAddress] = useState(
    existing !== undefined && 'address' in existing ? existing.address : (prefill?.address ?? ''),
  );
  const [tags, setTags] = useState((existing?.tags ?? []).join(', '));
  // A one-off server signed in with the agent; its port is kept only when it is not the default.
  const [ssh, setSsh] = useState<SshSettingsWire>(
    existing?.ssh ??
      (prefill === undefined
        ? {}
        : {
            ...(prefill.user === undefined ? {} : { user: prefill.user }),
            ...(prefill.port === SSH_DEFAULTS.port ? {} : { port: prefill.port }),
            auth: { kind: 'agent' },
          }),
  );
  const [password, setPassword] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [protectedHere, setProtectedHere] = useState<boolean | undefined>(existing?.protected);
  const [forwards, setForwards] = useState<ForwardEntryWire[]>(existing?.forwards ?? []);
  const [env, setEnv] = useState<EnvVarWire[]>(existing?.env ?? []);
  const [terminal, setTerminal] = useState<TerminalEntryWire>(existing?.terminal ?? {});
  const terminalPrefs = usePreferencesStore((s) => s.preferences.terminal);
  const storedSshPrefs = usePreferencesStore((s) => s.preferences.ssh);
  const sshPrefs = useMemo(() => sshPreferenceDefaults(storedSshPrefs), [storedSshPrefs]);
  const [failed, setFailed] = useState(false);
  const [secretError, setSecretError] = useState<string | undefined>(undefined);
  const { names: secretNames } = useSecretNames();
  const localUser = useLocalUser();
  const missingId = useId();
  // The OS is kept per server on this machine, keyed like its trusted host key: address and port.
  const osKey = (): string =>
    `${address.trim()}:${String(ssh.port ?? inheritedFrom(chain, 'port').value ?? SSH_DEFAULTS.port)}`;
  const [savedOsKey] = useState(osKey);
  const savedOs = useHostsStore((s) => s.osByHost[savedOsKey]);
  const [os, setOs] = useState<SshOsId | ''>(savedOs?.chosen ?? '');

  // A new host starts from what its group does not supply: this machine's login name, and a typed password.
  // Both follow the Group select until the field is touched.
  const [touched, setTouched] = useState<{ user?: true; auth?: true }>(() =>
    prefill === undefined ? {} : { ...(prefill.user === undefined ? {} : { user: true }), auth: true },
  );
  // What the groups and identities give this entry when it sets no user or auth of its own (#416).
  const loginUser = inheritedLogin(file.identities, chain, ssh.identity, 'user', sshPrefs);
  const loginAuth = inheritedLogin(file.identities, chain, ssh.identity, 'auth');
  const groupUser = loginUser.value;
  const groupHasAuth = loginAuth.value !== undefined;
  const fresh = dialog.mode === 'new-host';
  useEffect(() => {
    if (!fresh || touched.user === true) return;
    setSsh((prev) => withField(prev, 'user', groupUser === undefined && localUser !== '' ? localUser : undefined));
  }, [fresh, touched.user, groupUser, localUser]);
  useEffect(() => {
    if (!fresh || touched.auth === true) return;
    setSsh((prev) => withField(prev, 'auth', groupHasAuth ? undefined : { kind: 'password', secret: '' }));
  }, [fresh, touched.auth, groupHasAuth]);

  const set = (key: Inheritable | 'auth') => (value: unknown) => {
    if (key === 'user' || key === 'auth') setTouched((prev) => ({ ...prev, [key]: true }));
    setSsh((prev) => withField(prev, key, value));
  };
  const jumpInherited = inheritedFrom(chain, 'jump');
  const identities = identitiesOf(file);
  const identityInherited = inheritedFrom(chain, 'identity');
  const identityName = (id: string): string => findIdentity(file, id)?.name ?? id;
  // Picking an identity hands it the user and sign-in it holds; Override takes either back for this entry.
  const pickIdentity = (id: string | undefined): void => {
    const identity = id === undefined ? undefined : findIdentity(file, id);
    setSsh((prev) => {
      let next = withField(prev, 'identity', id);
      if (identity?.user !== undefined) next = withField(next, 'user', undefined);
      if (identity?.auth !== undefined) next = withField(next, 'auth', undefined);
      return next;
    });
    if (identity?.auth !== undefined) setPassword('');
  };
  const selfId = dialog.mode === 'edit-host' ? dialog.id : undefined;
  const jumpOptions = resolved.filter((h) => h.id !== selfId);
  const tagList = tags
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  const forwardsReady = forwards.every((entry) => !('type' in entry) || forwardProblem(entry) === undefined);
  const sectionProblems = [
    ...(forwardsReady ? [] : ['A forwarding rule is incomplete (Advanced)']),
    ...[envProblem(env), terminalProblem(terminal), proxyProblem(ssh.proxy), moshProblem(ssh.mosh)].filter(
      (p): p is string => p !== undefined,
    ),
  ];
  const missing = missingFields({
    isHost,
    needsLogin: fresh,
    name,
    address,
    user: ssh.user,
    inheritedUser: groupUser,
    auth: ssh.auth,
    inheritedAuth: loginAuth.value,
    password,
    sectionProblems,
  });
  const valid = missing.length === 0;
  // A blank new form names no required field until Save or a required field left empty; a section's own
  // problem (a proxy without a host) shows at once, since only an edit can cause it (#594).
  const { revealed, reveal, onBlur } = useRevealMissing();
  const shown = revealed ? missing : sectionProblems;

  const submit = async (): Promise<void> => {
    const id = existing?.id ?? freeId(file, slug(name));
    let clean = dropEmpty(ssh);
    // A typed password goes to this machine's secret store first; the file only ever gets its name.
    if (clean.auth?.kind === 'password' && password !== '') {
      const secret =
        clean.auth.secret !== ''
          ? clean.auth.secret
          : passwordSecretName(
              id,
              secretNames.map((n) => n.name),
            );
      const stored = await storeSshSecret({ name: secret, value: password });
      if (!stored.ok) {
        setSecretError(stored.error.message);
        return;
      }
      clean = { ...clean, auth: { ...clean.auth, secret } };
      // A save main refuses next keeps the stored name, so trying again does not store a second copy.
      setSsh(clean);
      setPassword('');
      setSecretError(undefined);
    }
    const proxy = cleanProxy(clean.proxy);
    if (proxy !== undefined) clean = { ...clean, proxy };
    // The proxy's typed password, the same way: stored first, then only its name is written.
    if (proxy !== undefined && proxy !== false && proxyPassword !== '') {
      const secret =
        proxy.passwordSecret ??
        passwordSecretName(
          id,
          secretNames.map((n) => n.name),
          'proxy_password',
        );
      const stored = await storeSshSecret({ name: secret, value: proxyPassword });
      if (!stored.ok) {
        setSecretError(stored.error.message);
        return;
      }
      clean = { ...clean, proxy: { ...proxy, passwordSecret: secret } };
      setSsh(clean);
      setProxyPassword('');
      setSecretError(undefined);
    }
    const guard = protectedHere === undefined ? {} : { protected: protectedHere };
    // No rules left writes no `forwards` key.
    const ownForwards = forwards.length === 0 ? {} : { forwards };
    const ownEnv = env.length === 0 ? {} : { env };
    // A block where every field inherits writes no `terminal` key.
    const ownTerminal = Object.keys(cleanTerminal(terminal)).length === 0 ? {} : { terminal: cleanTerminal(terminal) };
    const base = dialog.mode === 'edit-host' && groupId !== currentGroup ? moveHost(file, id, groupId) : file;
    const next = isHost
      ? upsertHost(
          base,
          {
            id,
            name: name.trim(),
            address: address.trim(),
            tags: tagList,
            ...guard,
            ssh: clean,
            ...ownEnv,
            ...ownTerminal,
            ...ownForwards,
          },
          groupId,
        )
      : upsertGroup(
          base,
          {
            id,
            name: name.trim(),
            tags: tagList,
            ...guard,
            ssh: clean,
            ...ownEnv,
            ...ownTerminal,
            ...ownForwards,
            groups: [],
            hosts: [],
          },
          groupId,
        );
    if (!(await save(next))) {
      setFailed(true);
      return;
    }
    const chosen = os === '' ? null : os;
    const key = osKey();
    // A choice moves with the host when its address or port changes; Auto on a new host is nothing to store.
    if (isHost && (chosen !== (savedOs?.chosen ?? null) || (key !== savedOsKey && chosen !== null))) {
      await ipc().ssh.setHostOs({ host: key, os: chosen });
    }
    closeDialog();
  };

  const label = `${editing ? 'Edit' : 'New'} ${isHost ? 'host' : 'group'}`;
  const groups = flattenGroups(file);
  return (
    <form
      className="flex flex-col gap-3"
      onBlur={onBlur}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
        else reveal();
      }}
    >
      {embedded ? (
        <h2 className="text-md font-medium text-fg-default">{label}</h2>
      ) : (
        <>
          <Dialog.Title className="text-md font-medium text-fg-default">{label}</Dialog.Title>
          <Dialog.Description className="sr-only">{`${label}: settings left on inherit come from the enclosing group.`}</Dialog.Description>
        </>
      )}
      <label className={FIELD_CLASS}>
        <span className="text-fg-subtle">Name</span>
        <input
          aria-required="true"
          className={INPUT_CLASS}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </label>
      {isHost && (
        <label className={FIELD_CLASS}>
          <span className="text-fg-subtle">Address</span>
          <input
            aria-required="true"
            className={INPUT_CLASS}
            value={address}
            placeholder="host.example.com or 10.0.0.5"
            onChange={(e) => {
              setAddress(e.target.value);
            }}
          />
        </label>
      )}
      {dialog.mode !== 'edit-group' && groups.length > 0 && (
        <label className={FIELD_CLASS}>
          <span className="text-fg-subtle">{isHost ? 'Group' : 'Inside group'}</span>
          <select
            aria-label={isHost ? 'Group' : 'Inside group'}
            className={INPUT_CLASS}
            value={groupId ?? ''}
            onChange={(e) => {
              setGroupId(e.target.value === '' ? undefined : e.target.value);
            }}
          >
            <option value="">No group</option>
            {groups.map(({ group, depth }) => (
              <option key={group.id} value={group.id}>
                {`${' '.repeat(depth)}${group.name}`}
              </option>
            ))}
          </select>
        </label>
      )}
      {(identities.length > 0 || ssh.identity !== undefined) && (
        <label className={FIELD_CLASS}>
          <span className="flex gap-2 text-fg-subtle">
            Identity
            {ssh.identity === undefined && identityInherited.value !== undefined && (
              <span className="text-fg-faint">{sourceText(identityInherited, identityName)}</span>
            )}
          </span>
          <select
            aria-label="Identity"
            className={INPUT_CLASS}
            value={ssh.identity ?? ''}
            onChange={(e) => {
              pickIdentity(e.target.value === '' ? undefined : e.target.value);
            }}
          >
            <option value="">{identityInherited.value === undefined ? 'None' : 'Inherit'}</option>
            {identities.map((identity) => (
              <option key={identity.id} value={identity.id}>
                {identity.user === undefined ? identity.name : `${identity.name} (${identity.user})`}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_9rem] gap-2">
        <InheritedField label="User" provenance={loginUser} override={ssh.user} onChange={set('user')} />
        <InheritedField
          label="Port"
          type="number"
          provenance={inheritedFrom(chain, 'port')}
          override={ssh.port}
          onChange={set('port')}
        />
      </div>
      <HostAuthSection
        value={ssh.auth}
        inherited={loginAuth}
        onChange={set('auth')}
        password={password}
        onPasswordChange={setPassword}
      />
      {secretError !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {`The password was not stored: ${secretError}`}
        </p>
      )}
      <details className="border-t border-hairline pt-2" data-testid="host-advanced">
        <summary className="cursor-pointer rounded text-xs font-medium text-fg-subtle select-none hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none">
          Advanced
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          {isHost && (
            <label className={FIELD_CLASS}>
              <span className="text-fg-subtle">OS</span>
              <select
                aria-label="OS"
                className={INPUT_CLASS}
                value={os}
                onChange={(e) => {
                  setOs(e.target.value as SshOsId | '');
                }}
              >
                <option value="">{`Auto${savedOs?.detected === undefined ? '' : ` (${savedOs.detected.name})`}`}</option>
                {SSH_OS_IDS.map((id) => (
                  <option key={id} value={id}>
                    {OS_LABELS[id]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={FIELD_CLASS}>
            <span className="text-fg-subtle">Tags (comma separated)</span>
            <input
              className={INPUT_CLASS}
              value={tags}
              onChange={(e) => {
                setTags(e.target.value);
              }}
            />
          </label>
          <InheritedSwitch
            label="Protected"
            provenance={inheritedProtected(chain)}
            override={protectedHere}
            onChange={setProtectedHere}
          />
          <label className={FIELD_CLASS}>
            <span className="flex gap-2 text-fg-subtle">
              Jump host
              {ssh.jump === undefined && jumpInherited.value !== undefined && (
                <span className="text-fg-faint">{sourceText(jumpInherited)}</span>
              )}
            </span>
            <select
              aria-label="Jump host"
              className={INPUT_CLASS}
              value={ssh.jump ?? ''}
              onChange={(e) => {
                set('jump')(e.target.value === '' ? undefined : e.target.value);
              }}
            >
              <option value="">{jumpInherited.value === undefined ? 'None' : 'Inherit'}</option>
              {jumpOptions.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <InheritedField
              label="Keep-alive (s)"
              type="number"
              provenance={inheritedFrom(chain, 'keepAlive', sshPrefs)}
              override={ssh.keepAlive}
              onChange={set('keepAlive')}
            />
            <InheritedField
              label="Connect timeout (s)"
              type="number"
              provenance={inheritedFrom(chain, 'connectTimeout', sshPrefs)}
              override={ssh.connectTimeout}
              onChange={set('connectTimeout')}
            />
          </div>
          <MoshSection
            protocol={ssh.protocol}
            mosh={ssh.mosh}
            inheritedProtocol={inheritedProtocol(chain)}
            inheritedMosh={inheritedMosh(chain)}
            onProtocol={(next) => {
              setSsh((prev) => withField(prev, 'protocol', next));
            }}
            onMosh={(next) => {
              setSsh((prev) => withField(prev, 'mosh', next));
            }}
          />
          <ProxySection
            own={ssh.proxy}
            inherited={inheritedFrom(chain, 'proxy')}
            onChange={(next) => {
              setSsh((prev) => withField(prev, 'proxy', next));
            }}
            names={secretNames}
            password={proxyPassword}
            onPasswordChange={setProxyPassword}
          />
          <AgentForwardingSection
            override={ssh.forwardAgent}
            inherited={inheritedForwardAgent(chain)}
            onChange={(next) => {
              setSsh((prev) => withField(prev, 'forwardAgent', next));
            }}
          />
          <EnvSection own={env} inherited={inheritedEnv(chain)} onChange={setEnv} />
          <HostTerminalSection
            own={terminal}
            inherited={inheritedTerminal(chain, terminalPrefs)}
            onChange={setTerminal}
          />
          <ForwardsSection own={forwards} inherited={inheritedForwards(chain)} onChange={setForwards} />
        </div>
      </details>
      {failed && problems[0] !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {problems[0].message}
        </p>
      )}
      <div className="flex items-start gap-2">
        {shown.length === 0 ? (
          <span className="flex-1" />
        ) : (
          <ul id={missingId} aria-label="Needed to save" className="flex-1 text-xs text-fg-subtle">
            {shown.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        <Button onClick={closeDialog}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={shown.length > 0}
          aria-describedby={shown.length === 0 ? undefined : missingId}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

/**
 * The host / group form. Each setting shows what it inherits and from which group; Override edits it here.
 * Editing a host is the exception: its form opens in the details panel (`host-details.tsx`) instead.
 */
export function HostDialog() {
  const dialog = useHostsStore((s) => s.dialog);
  const file = useHostsStore((s) => s.file);
  const closeDialog = useHostsStore((s) => s.closeDialog);
  return (
    <Dialog.Root
      open={dialog !== null && dialog.mode !== 'edit-host'}
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="host-dialog"
          className="fixed top-1/2 left-1/2 max-h-[85vh] w-[34rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          {dialog !== null && dialog.mode !== 'edit-host' && (
            <HostForm key={JSON.stringify(dialog)} file={file} dialog={dialog} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
