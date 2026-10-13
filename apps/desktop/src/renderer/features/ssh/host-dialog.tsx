import { useState } from 'react';
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
import { OS_LABELS } from './os-icon.js';
import { HostAuthSection } from './host-auth-section.js';
import { cleanTerminal, HostTerminalSection, inheritedTerminal, terminalProblem } from './host-terminal-section.js';
import { SSH_DEFAULTS, SSH_OS_IDS } from '../../../shared/ssh-defaults.js';
import { ancestorsOf, findGroup, findHost, freeId, upsertGroup, upsertHost, useHostsStore } from './hosts-store.js';
import { INPUT_CLASS, InheritedField, InheritedSwitch, type Provenance } from './inherited-field.js';

type Inheritable = 'user' | 'port' | 'jump' | 'keepAlive' | 'connectTimeout';

/** Where `field` comes from for an entry inside `chain` (outermost group first): nearest group that sets it. */
function inheritedFrom<K extends keyof SshSettingsWire>(
  chain: readonly GroupEntryWire[],
  field: K,
): Provenance<NonNullable<SshSettingsWire[K]>> {
  for (const g of [...chain].reverse()) {
    const value = g.ssh[field];
    if (value !== undefined) return { value, from: { group: g.name } };
  }
  const fallback = (SSH_DEFAULTS as Record<string, number>)[field];
  return { value: fallback as NonNullable<SshSettingsWire[K]> | undefined, from: 'default' };
}

/** Whether the enclosing groups make an entry protected: the nearest group that says, else off by default. */
function inheritedProtected(chain: readonly GroupEntryWire[]): Provenance<boolean> {
  for (const g of [...chain].reverse()) {
    if (g.protected !== undefined) return { value: g.protected, from: { group: g.name } };
  }
  return { value: false, from: 'default' };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'host'
  );
}

/** An override left empty is not saved: it would be a literal empty string in the file. */
function dropEmpty(ssh: SshSettingsWire): SshSettingsWire {
  return Object.fromEntries(Object.entries(ssh).filter(([, v]) => v !== ''));
}

function withField(ssh: SshSettingsWire, key: keyof SshSettingsWire, value: unknown): SshSettingsWire {
  const { [key]: dropped, ...rest } = ssh;
  void dropped;
  return value === undefined ? rest : { ...rest, [key]: value };
}

interface FormProps {
  readonly file: HostsFileWire;
  readonly dialog: NonNullable<ReturnType<typeof useHostsStore.getState>['dialog']>;
  /** Drawn inside the details panel rather than the dialog: a plain heading, no dialog title. */
  readonly embedded?: boolean;
}

export function HostForm({ file, dialog, embedded = false }: FormProps) {
  const { save, closeDialog, problems, resolved } = useHostsStore();
  const isHost = dialog.mode === 'new-host' || dialog.mode === 'edit-host';
  const editing = dialog.mode === 'edit-host' || dialog.mode === 'edit-group';
  const existing =
    dialog.mode === 'edit-host'
      ? findHost(file, dialog.id)
      : dialog.mode === 'edit-group'
        ? findGroup(file, dialog.id)
        : undefined;
  const parent = dialog.mode === 'new-host' || dialog.mode === 'new-group' ? dialog.parent : undefined;
  const chain: GroupEntryWire[] =
    dialog.mode === 'edit-host'
      ? ancestorsOf(file, 'host', dialog.id)
      : dialog.mode === 'edit-group'
        ? ancestorsOf(file, 'group', dialog.id)
        : parent === undefined
          ? []
          : [
              ...ancestorsOf(file, 'group', parent),
              ...(findGroup(file, parent) ? [findGroup(file, parent) as GroupEntryWire] : []),
            ];

  const [name, setName] = useState(existing?.name ?? '');
  const [address, setAddress] = useState(existing !== undefined && 'address' in existing ? existing.address : '');
  const [tags, setTags] = useState((existing?.tags ?? []).join(', '));
  const [ssh, setSsh] = useState<SshSettingsWire>(existing?.ssh ?? {});
  const [protectedHere, setProtectedHere] = useState<boolean | undefined>(existing?.protected);
  const [forwards, setForwards] = useState<ForwardEntryWire[]>(existing?.forwards ?? []);
  const [env, setEnv] = useState<EnvVarWire[]>(existing?.env ?? []);
  const [terminal, setTerminal] = useState<TerminalEntryWire>(existing?.terminal ?? {});
  const terminalPrefs = usePreferencesStore((s) => s.preferences.terminal);
  const [failed, setFailed] = useState(false);
  // The OS is kept per server on this machine, keyed like its trusted host key: address and port.
  const osKey = (): string =>
    `${address.trim()}:${String(ssh.port ?? inheritedFrom(chain, 'port').value ?? SSH_DEFAULTS.port)}`;
  const [savedOsKey] = useState(osKey);
  const savedOs = useHostsStore((s) => s.osByHost[savedOsKey]);
  const [os, setOs] = useState<SshOsId | ''>(savedOs?.chosen ?? '');

  const set = (key: Inheritable | 'auth') => (value: unknown) => {
    setSsh((prev) => withField(prev, key, value));
  };
  const jumpInherited = inheritedFrom(chain, 'jump');
  const selfId = dialog.mode === 'edit-host' ? dialog.id : undefined;
  const jumpOptions = resolved.filter((h) => h.id !== selfId);
  const tagList = tags
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  const authReady = ssh.auth === undefined || ssh.auth.kind === 'agent' || ssh.auth.secret !== '';
  const forwardsReady = forwards.every((entry) => !('type' in entry) || forwardProblem(entry) === undefined);
  const envReady = envProblem(env) === undefined;
  const terminalReady = terminalProblem(terminal) === undefined;
  const valid =
    name.trim() !== '' && (!isHost || address.trim() !== '') && authReady && forwardsReady && envReady && terminalReady;

  const submit = async (): Promise<void> => {
    const id = existing?.id ?? freeId(file, slug(name));
    const clean = dropEmpty(ssh);
    const guard = protectedHere === undefined ? {} : { protected: protectedHere };
    // No rules left writes no `forwards` key.
    const ownForwards = forwards.length === 0 ? {} : { forwards };
    const ownEnv = env.length === 0 ? {} : { env };
    // A block where every field inherits writes no `terminal` key.
    const ownTerminal = Object.keys(cleanTerminal(terminal)).length === 0 ? {} : { terminal: cleanTerminal(terminal) };
    const next = isHost
      ? upsertHost(
          file,
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
          parent,
        )
      : upsertGroup(
          file,
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
          parent,
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
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
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
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-fg-subtle">Name</span>
        <input
          className={INPUT_CLASS}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </label>
      {isHost && (
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-fg-subtle">Address</span>
          <input
            className={INPUT_CLASS}
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
            }}
          />
        </label>
      )}
      {isHost && (
        <label className="flex flex-col gap-1 text-xs">
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
      <label className="flex flex-col gap-1 text-xs">
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
      <InheritedField
        label="User"
        provenance={inheritedFrom(chain, 'user')}
        override={ssh.user}
        onChange={set('user')}
      />
      <InheritedField
        label="Port"
        type="number"
        provenance={inheritedFrom(chain, 'port')}
        override={ssh.port}
        onChange={set('port')}
      />
      <div className="flex items-end gap-2">
        <label className="flex flex-1 flex-col gap-1 text-xs">
          <span className="text-fg-subtle">Jump host</span>
          <select
            aria-label="Jump host"
            className={INPUT_CLASS}
            value={ssh.jump ?? ''}
            onChange={(e) => {
              set('jump')(e.target.value === '' ? undefined : e.target.value);
            }}
          >
            <option value="">{`Inherit${jumpInherited.value === undefined ? ' (none)' : ''}`}</option>
            {jumpOptions.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        {ssh.jump === undefined && jumpInherited.value !== undefined && typeof jumpInherited.from === 'object' && (
          <span className="pb-1.5 text-xs text-fg-subtle">{`${jumpInherited.value} from ${jumpInherited.from.group}`}</span>
        )}
      </div>
      <InheritedField
        label="Keep-alive (s)"
        type="number"
        provenance={inheritedFrom(chain, 'keepAlive')}
        override={ssh.keepAlive}
        onChange={set('keepAlive')}
      />
      <InheritedField
        label="Connect timeout (s)"
        type="number"
        provenance={inheritedFrom(chain, 'connectTimeout')}
        override={ssh.connectTimeout}
        onChange={set('connectTimeout')}
      />
      <HostAuthSection value={ssh.auth} inherited={inheritedFrom(chain, 'auth')} onChange={set('auth')} />
      <EnvSection own={env} inherited={inheritedEnv(chain)} onChange={setEnv} />
      <HostTerminalSection own={terminal} inherited={inheritedTerminal(chain, terminalPrefs)} onChange={setTerminal} />
      <ForwardsSection own={forwards} inherited={inheritedForwards(chain)} onChange={setForwards} />
      {failed && problems[0] !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {problems[0].message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={closeDialog}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!valid}>
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
