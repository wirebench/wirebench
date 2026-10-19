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
import { TELNET_PORT, telnetTargetText } from './host-protocol.js';
import { inheritedSerial, SerialDeviceField, serialLabel, SerialLineSection, serialProblem } from './serial-section.js';
import { cleanProxy, proxyProblem, ProxySection } from './proxy-section.js';
import { OS_LABELS } from './os-icon.js';
import { HostAuthSection } from './host-auth-section.js';
import { cleanTerminal, HostTerminalSection, inheritedTerminal, terminalProblem } from './host-terminal-section.js';
import { SSH_DEFAULTS, SSH_OS_IDS } from '../../../shared/ssh-defaults.js';
import { COMMON_TERMINAL_TYPES, TERMINAL_CHARSETS, terminalTypeProblem } from '../../../shared/terminal-charsets.js';
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
  type HostsDialog,
} from './hosts-store.js';
import { INPUT_CLASS, InheritedField, InheritedSelect, InheritedSwitch, sourceText } from './inherited-field.js';
import { useRevealMissing } from './reveal-missing.js';
import {
  chainOf,
  dropEmpty,
  inheritedFrom,
  inheritedLogin,
  sshPreferenceDefaults,
  inheritedProtected,
  initialGroup,
  fieldGaps,
  missingFields,
  missingSummary,
  passwordSecretName,
  slug,
  withField,
  type FormField,
} from './host-form-model.js';
import { useSecretNames } from './secret-fields.js';
import { findIdentity, identitiesOf } from './identities.js';
import { storeSshSecret } from './secret-writes.js';

type Inheritable = 'user' | 'port' | 'jump' | 'keepAlive' | 'connectTimeout' | 'term' | 'charset';

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
  const { save, closeDialog, leaveForm, noteForm, selectHost, problems, resolved, groupFilter } = useHostsStore();
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
  // Duplicate starts a new host from a copy of another, which Save writes under a fresh id.
  const copy = dialog.mode === 'new-host' && dialog.copyOf !== undefined ? findHost(file, dialog.copyOf) : undefined;
  const start = existing ?? copy;
  const [name, setName] = useState(
    existing?.name ?? (copy === undefined ? undefined : `${copy.name} copy`) ?? prefill?.name ?? '',
  );
  const [address, setAddress] = useState(
    start !== undefined && 'address' in start ? start.address : (prefill?.address ?? ''),
  );
  const [tags, setTags] = useState((start?.tags ?? []).join(', '));
  // A one-off server signed in with the agent; its port is kept only when it is not the default.
  const [ssh, setSsh] = useState<SshSettingsWire>(
    start?.ssh ??
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
  const [protectedHere, setProtectedHere] = useState<boolean | undefined>(start?.protected);
  const [forwards, setForwards] = useState<ForwardEntryWire[]>(start?.forwards ?? []);
  const [env, setEnv] = useState<EnvVarWire[]>(start?.env ?? []);
  const [terminal, setTerminal] = useState<TerminalEntryWire>(start?.terminal ?? {});
  const terminalPrefs = usePreferencesStore((s) => s.preferences.terminal);
  const storedSshPrefs = usePreferencesStore((s) => s.preferences.ssh);
  const sshPrefs = useMemo(() => sshPreferenceDefaults(storedSshPrefs), [storedSshPrefs]);
  const [failed, setFailed] = useState(false);
  const [secretError, setSecretError] = useState<string | undefined>(undefined);
  const { names: secretNames } = useSecretNames();
  const localUser = useLocalUser();
  const missingId = useId();
  // Telnet (#425) needs no user or way in, signs in with a password only, and has no SSH-only settings. A
  // serial console (#426) has no network at all: no address, port, sign-in, jump or proxy.
  const protocol = ssh.protocol ?? inheritedProtocol(chain).value ?? 'ssh';
  const telnet = protocol === 'telnet';
  const serial = protocol === 'serial';
  const viaSsh = !telnet && !serial;
  // The device a serial host opens on this machine: read from main, written after a save (never to the file).
  const [device, setDevice] = useState('');
  const [savedDevice, setSavedDevice] = useState('');
  const [deviceError, setDeviceError] = useState<string | undefined>(undefined);
  const editId = dialog.mode === 'edit-host' ? dialog.id : undefined;
  useEffect(() => {
    if (editId === undefined) return;
    let live = true;
    Promise.resolve()
      .then(() => ipc().ssh.serialDevice({ hostId: editId }))
      .then((result) => {
        if (!live || !result.ok) return;
        setDevice(result.value.device ?? '');
        setSavedDevice(result.value.device ?? '');
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [editId]);
  const portInherited = inheritedFrom(chain, 'port');
  const inheritedPort =
    telnet && portInherited.from === 'default' ? { ...portInherited, value: TELNET_PORT } : portInherited;
  // The OS is kept per server on this machine, keyed like its trusted host key: address and port.
  const osKey = (): string => `${address.trim()}:${String(ssh.port ?? inheritedPort.value ?? SSH_DEFAULTS.port)}`;
  const [savedOsKey] = useState(osKey);
  const savedOs = useHostsStore((s) => s.osByHost[savedOsKey]);
  const [os, setOs] = useState<SshOsId | ''>(savedOs?.chosen ?? '');

  // A new host starts from what its group does not supply: this machine's login name, and a typed password.
  // Both follow the Group select until the field is touched.
  // A copy keeps the user and sign-in it was given.
  const [touched, setTouched] = useState<{ user?: true; auth?: true }>(() =>
    copy !== undefined
      ? { user: true, auth: true }
      : prefill === undefined
        ? {}
        : { ...(prefill.user === undefined ? {} : { user: true }), auth: true },
  );
  // What the groups and identities give this entry when it sets no user or auth of its own (#416).
  const loginUser = inheritedLogin(file.identities, chain, ssh.identity, 'user', sshPrefs);
  const loginAuth = inheritedLogin(file.identities, chain, ssh.identity, 'auth');
  const groupUser = loginUser.value;
  const groupHasAuth = loginAuth.value !== undefined;
  const fresh = dialog.mode === 'new-host';
  // A device's login is not this machine's: a new Telnet host or serial console starts with neither.
  // What the form held before the user changed anything: the defaults below fill it in as well, so they
  // alone never count as a change that leaving the form would drop.
  const [baseline, setBaseline] = useState<SshSettingsWire>(ssh);
  useEffect(() => {
    if (!fresh || touched.user === true) return;
    const user = groupUser === undefined && localUser !== '' && viaSsh ? localUser : undefined;
    setSsh((prev) => withField(prev, 'user', user));
    setBaseline((prev) => withField(prev, 'user', user));
  }, [fresh, touched.user, groupUser, localUser, viaSsh]);
  useEffect(() => {
    if (!fresh || touched.auth === true) return;
    const auth = groupHasAuth || !viaSsh ? undefined : { kind: 'password' as const, secret: '' };
    setSsh((prev) => withField(prev, 'auth', auth));
    setBaseline((prev) => withField(prev, 'auth', auth));
  }, [fresh, touched.auth, groupHasAuth, viaSsh]);

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
    ...[
      envProblem(env),
      terminalProblem(terminal),
      terminalTypeProblem(ssh.term),
      proxyProblem(ssh.proxy),
      moshProblem(ssh.mosh),
      serialProblem(ssh.serial),
    ].filter((p): p is string => p !== undefined),
  ];
  const saveCheck = {
    isHost,
    // A copy saves as its original was: it asks for no sign-in the original did without.
    needsLogin: fresh && viaSsh && copy === undefined,
    needsAddress: !serial,
    name,
    address,
    user: ssh.user,
    inheritedUser: groupUser,
    // A serial console signs in to nothing: a sign-in left from another protocol does not hold up Save.
    auth: serial ? undefined : ssh.auth,
    inheritedAuth: loginAuth.value,
    password: serial ? '' : password,
    passwordAsked: !telnet,
    sectionProblems,
  };
  const missing = missingFields(saveCheck);
  const valid = missing.length === 0;
  // A blank new form names no required field until Save or a required field left empty; a section's own
  // problem (a proxy without a host) shows at once, since only an edit can cause it (#594).
  const { revealed, reveal, onBlur } = useRevealMissing();
  const shown = revealed ? missing : sectionProblems;
  // Each empty required field says so under itself; the footer keeps one line (S59).
  const gaps = revealed ? fieldGaps(saveCheck) : [];
  const gapOf = (field: FormField): string | undefined => gaps.find((gap) => gap.field === field)?.message;
  const summary = missingSummary(gaps.length, sectionProblems);
  const gapLine = (field: FormField) => {
    const message = gapOf(field);
    return message === undefined ? null : (
      <span
        id={`${missingId}-${field}`}
        data-testid={`host-form-gap-${field}`}
        className="-mt-2 text-xs text-status-danger"
      >
        {message}
      </span>
    );
  };

  // Whether leaving now would drop something typed; the New host form also draws its draft card from this.
  const [startedAs] = useState(() =>
    JSON.stringify([name, address, tags, protectedHere, forwards, env, terminal, os, groupId]),
  );
  const dirty =
    JSON.stringify([name, address, tags, protectedHere, forwards, env, terminal, os, groupId]) !== startedAs ||
    JSON.stringify(ssh) !== JSON.stringify(baseline) ||
    password !== '' ||
    proxyPassword !== '' ||
    device.trim() !== savedDevice;
  const hostForm = dialog.mode === 'new-host' || dialog.mode === 'edit-host';
  const draftTarget = serial
    ? `Serial · ${serialLabel(ssh.serial ?? inheritedSerial(chain).value)}`
    : telnet
      ? telnetTargetText(address.trim(), ssh.user ?? loginUser.value, ssh.port ?? inheritedPort.value)
      : draftTargetText(address.trim(), ssh.user ?? loginUser.value, ssh.port ?? inheritedPort.value);
  const draftName = name.trim();
  // A form that goes (its tab left for another) has nothing left to drop.
  useEffect(
    () => () => {
      if (useHostsStore.getState().formDirty) useHostsStore.setState({ formDirty: false });
    },
    [],
  );
  useEffect(() => {
    if (!hostForm) return;
    noteForm(
      dirty,
      fresh
        ? {
            name: draftName,
            target: draftTarget,
            ...(telnet ? { plainText: true } : {}),
            ...(groupId === undefined ? {} : { groupId }),
          }
        : undefined,
    );
  }, [hostForm, fresh, dirty, draftName, draftTarget, telnet, groupId, noteForm]);
  // Cancel and Escape leave a form in the details panel the way putting the panel away does: asking first.
  const cancel = (): void => {
    if (embedded && hostForm) leaveForm();
    else closeDialog();
  };

  const submit = async (): Promise<void> => {
    // A copy keeps its original's id with `-copy` while it keeps the name it was given.
    const copyId = copy !== undefined && name.trim() === `${copy.name} copy` ? `${copy.id}-copy` : undefined;
    const id = existing?.id ?? freeId(file, copyId ?? slug(name));
    let clean = dropEmpty(ssh);
    // A typed password goes to this machine's secret store first; the file only ever gets its name.
    if (clean.auth?.kind === 'password' && password !== '') {
      // A copy's typed password is its own: writing it to the original's secret would change that host too.
      const copied = copy?.ssh.auth?.kind === 'password' && copy.ssh.auth.secret === clean.auth.secret;
      const secret =
        clean.auth.secret !== '' && !copied
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
    } else if (clean.auth?.kind === 'password' && clean.auth.secret === '' && !telnet) {
      // A password left empty is asked for when the host connects (S60): the file names the secret the
      // connection screen stores it under, and nothing is stored now.
      const secret = passwordSecretName(
        id,
        secretNames.map((n) => n.name),
      );
      clean = { ...clean, auth: { ...clean.auth, secret } };
    }
    const proxy = cleanProxy(clean.proxy);
    if (proxy !== undefined) clean = { ...clean, proxy };
    // The proxy's typed password, the same way: stored first, then only its name is written.
    if (proxy !== undefined && proxy !== false && proxyPassword !== '') {
      const copiedProxy =
        copy?.ssh.proxy !== undefined &&
        copy.ssh.proxy !== false &&
        copy.ssh.proxy.passwordSecret === proxy.passwordSecret;
      const secret =
        (copiedProxy ? undefined : proxy.passwordSecret) ??
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
    const typedDevice = device.trim();
    if (isHost && serial && typedDevice !== savedDevice) {
      const kept = await ipc().ssh.setSerialDevice({ hostId: id, device: typedDevice === '' ? null : typedDevice });
      if (!kept.ok) {
        setDeviceError(kept.error.message);
        return;
      }
      setSavedDevice(typedDevice);
      setDeviceError(undefined);
    }
    const chosen = os === '' ? null : os;
    const key = osKey();
    // A choice moves with the host when its address or port changes; Auto on a new host is nothing to store.
    if (isHost && !serial && (chosen !== (savedOs?.chosen ?? null) || (key !== savedOsKey && chosen !== null))) {
      await ipc().ssh.setHostOs({ host: key, os: chosen });
    }
    closeDialog();
    // The draft card becomes the saved host's, picked so its details show where the form was.
    if (fresh) selectHost(id);
  };

  const label = `${editing ? 'Edit' : 'New'} ${isHost ? 'host' : 'group'}`;
  const groups = flattenGroups(file);
  const protocolSection = (
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
  );
  const actions = (
    // In the panel, a footer bar under the scrolling fields, so a long form (Advanced open, a short window)
    // never scrolls Cancel and Save out of view (#689).
    <div
      className={
        embedded ? 'flex shrink-0 items-start gap-2 border-t border-hairline px-1 pt-2' : 'flex items-start gap-2'
      }
    >
      {summary === undefined ? (
        <span className="flex-1" />
      ) : (
        <p
          id={missingId}
          data-testid="host-form-missing"
          title={summary}
          className="min-w-0 flex-1 self-center truncate text-xs text-fg-subtle"
        >
          {summary}
        </p>
      )}
      <Button onClick={cancel}>Cancel</Button>
      <Button
        type="submit"
        variant="primary"
        disabled={shown.length > 0}
        aria-describedby={shown.length === 0 ? undefined : missingId}
      >
        Save
      </Button>
    </div>
  );
  return (
    // A container, so a narrow details panel stacks the paired fields rather than squeezing them. In the
    // panel the form fills its body and scrolls the fields itself, above the footer.
    <form
      className={embedded ? 'flex h-full min-h-0 flex-col' : '@container flex flex-col gap-3'}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !embedded || !hostForm || e.defaultPrevented) return;
        // The panel's own Escape would put it away as well: the form decides, asking first.
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
        else reveal();
      }}
    >
      <div
        data-testid={embedded ? 'host-form-fields' : undefined}
        className={
          embedded
            ? '@container flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto px-1 py-3 *:min-w-0'
            : 'contents'
        }
      >
        {embedded ? (
          // The panel's header already says New host or Edit host.
          <h2 className="sr-only">{label}</h2>
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
            aria-invalid={gapOf('name') === undefined ? undefined : 'true'}
            aria-describedby={gapOf('name') === undefined ? undefined : `${missingId}-name`}
            className={INPUT_CLASS}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        {gapLine('name')}
        {/* Protocol reshapes the rest of the form, so it comes before what it changes. */}
        {protocolSection}
        {isHost && !serial && (
          <label className={FIELD_CLASS}>
            <span className="text-fg-subtle">Address</span>
            <input
              aria-required="true"
              aria-invalid={gapOf('address') === undefined ? undefined : 'true'}
              aria-describedby={gapOf('address') === undefined ? undefined : `${missingId}-address`}
              className={INPUT_CLASS}
              value={address}
              placeholder="host.example.com or 10.0.0.5"
              onChange={(e) => {
                setAddress(e.target.value);
              }}
            />
          </label>
        )}
        {isHost && !serial && gapLine('address')}
        {!serial && (identities.length > 0 || ssh.identity !== undefined) && (
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
        {serial ? (
          <>
            {isHost && (
              <SerialDeviceField
                value={device}
                onChange={(next) => {
                  setDevice(next);
                  setDeviceError(undefined);
                }}
              />
            )}
            <SerialLineSection
              own={ssh.serial}
              inherited={inheritedSerial(chain)}
              onChange={(next) => {
                setSsh((prev) => withField(prev, 'serial', next));
              }}
            />
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 @min-[22rem]:grid-cols-[minmax(0,1fr)_9rem]">
              <InheritedField label="User" provenance={loginUser} override={ssh.user} onChange={set('user')} />
              <InheritedField
                label="Port"
                type="number"
                provenance={inheritedPort}
                override={ssh.port}
                onChange={set('port')}
              />
            </div>
            {gapLine('user')}
            <HostAuthSection
              value={ssh.auth}
              inherited={loginAuth}
              onChange={set('auth')}
              password={password}
              onPasswordChange={(typed) => {
                // A typed password is a choice: switching to Telnet afterwards keeps it.
                setTouched((prev) => ({ ...prev, auth: true }));
                setPassword(typed);
              }}
              passwordOnly={telnet}
              emptyAsked={!telnet}
            />
            {gapLine('auth')}
          </>
        )}
        {/* After the sign-in, so it does not split the address from the user (S47). */}
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
        {telnet && (
          <p className="text-xs text-fg-subtle">
            Wirebench types the user and password at the device's login and password prompts. Leave them empty to sign
            in yourself.
          </p>
        )}
        {deviceError !== undefined && (
          <p role="alert" className="text-sm text-status-danger">
            {`The device was not kept: ${deviceError}`}
          </p>
        )}
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
            {isHost && !serial && (
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
            {!serial && (
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
            )}
            {!serial && (
              <div className="grid grid-cols-1 gap-2 @min-[22rem]:grid-cols-2">
                {!telnet && (
                  <InheritedField
                    label="Keep-alive (s)"
                    type="number"
                    provenance={inheritedFrom(chain, 'keepAlive', sshPrefs)}
                    override={ssh.keepAlive}
                    onChange={set('keepAlive')}
                  />
                )}
                <InheritedField
                  label="Connect timeout (s)"
                  type="number"
                  provenance={inheritedFrom(chain, 'connectTimeout', sshPrefs)}
                  override={ssh.connectTimeout}
                  onChange={set('connectTimeout')}
                />
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 @min-[22rem]:grid-cols-2">
              {!serial && (
                <InheritedField
                  label="Terminal type"
                  provenance={inheritedFrom(chain, 'term', sshPrefs)}
                  override={ssh.term}
                  onChange={set('term')}
                  suggestions={COMMON_TERMINAL_TYPES}
                />
              )}
              <InheritedSelect
                label="Character set"
                provenance={inheritedFrom(chain, 'charset', sshPrefs)}
                override={ssh.charset}
                options={TERMINAL_CHARSETS}
                onChange={set('charset')}
              />
            </div>
            {!serial && (
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
            )}
            {viaSsh && (
              <AgentForwardingSection
                override={ssh.forwardAgent}
                inherited={inheritedForwardAgent(chain)}
                onChange={(next) => {
                  setSsh((prev) => withField(prev, 'forwardAgent', next));
                }}
              />
            )}
            {viaSsh && <EnvSection own={env} inherited={inheritedEnv(chain)} onChange={setEnv} />}
            <HostTerminalSection
              own={terminal}
              inherited={inheritedTerminal(chain, terminalPrefs)}
              onChange={setTerminal}
            />
            {viaSsh && <ForwardsSection own={forwards} inherited={inheritedForwards(chain)} onChange={setForwards} />}
          </div>
        </details>
        {failed && problems[0] !== undefined && (
          <p role="alert" className="text-sm text-status-danger">
            {problems[0].message}
          </p>
        )}
      </div>
      {actions}
    </form>
  );
}

/** Whether `dialog` is a group's form, the one the centred dialog holds. */
export function isGroupForm(
  dialog: HostsDialog,
): dialog is Extract<NonNullable<HostsDialog>, { mode: 'new-group' | 'edit-group' }> {
  return dialog?.mode === 'new-group' || dialog?.mode === 'edit-group';
}

/** `user@address:port` for the draft card, leaving out what is not known yet and the default port. */
function draftTargetText(address: string, user: string | undefined, port: number | undefined): string {
  return `${user === undefined || user === '' ? '' : `${user}@`}${address}${
    port === undefined || port === SSH_DEFAULTS.port ? '' : `:${String(port)}`
  }`;
}

/**
 * The group form. Each setting shows what it inherits and from which group; Override edits it here.
 * A host's form, new or edited, opens in the details panel (`host-details.tsx`) instead.
 */
export function HostDialog() {
  const dialog = useHostsStore((s) => s.dialog);
  const file = useHostsStore((s) => s.file);
  const closeDialog = useHostsStore((s) => s.closeDialog);
  return (
    <Dialog.Root
      open={isGroupForm(dialog)}
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
          {isGroupForm(dialog) && <HostForm key={JSON.stringify(dialog)} file={file} dialog={dialog} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
