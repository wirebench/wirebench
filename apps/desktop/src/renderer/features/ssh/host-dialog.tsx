import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import type { GroupEntryWire, HostsFileWire, SshSettingsWire } from '../../../shared/ssh-wire.js';
import { HostAuthSection } from './host-auth-section.js';
import { SSH_DEFAULTS } from '../../../shared/ssh-defaults.js';
import { ancestorsOf, findGroup, findHost, freeId, upsertGroup, upsertHost, useHostsStore } from './hosts-store.js';
import { INPUT_CLASS, InheritedField, type Provenance } from './inherited-field.js';

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
}

function HostForm({ file, dialog }: FormProps) {
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
  const [failed, setFailed] = useState(false);

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
  const valid = name.trim() !== '' && (!isHost || address.trim() !== '') && authReady;

  const submit = async (): Promise<void> => {
    const id = existing?.id ?? freeId(file, slug(name));
    const clean = dropEmpty(ssh);
    const next = isHost
      ? upsertHost(file, { id, name: name.trim(), address: address.trim(), tags: tagList, ssh: clean }, parent)
      : upsertGroup(file, { id, name: name.trim(), tags: tagList, ssh: clean, groups: [], hosts: [] }, parent);
    if (await save(next)) closeDialog();
    else setFailed(true);
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
      <Dialog.Title className="text-md font-medium text-fg-default">{label}</Dialog.Title>
      <Dialog.Description className="sr-only">{`${label}: settings left on inherit come from the enclosing group.`}</Dialog.Description>
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

/** The host / group form. Each setting shows what it inherits and from which group; Override edits it here. */
export function HostDialog() {
  const dialog = useHostsStore((s) => s.dialog);
  const file = useHostsStore((s) => s.file);
  const closeDialog = useHostsStore((s) => s.closeDialog);
  return (
    <Dialog.Root
      open={dialog !== null}
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
          {dialog !== null && <HostForm key={JSON.stringify(dialog)} file={file} dialog={dialog} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
