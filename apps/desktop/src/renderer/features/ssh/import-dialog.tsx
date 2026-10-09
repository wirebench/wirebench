import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { SSH_SECRET_NAME_PATTERN } from '../../../shared/ssh-defaults.js';
import type {
  SshImportPreview,
  SshKeyChoiceWire,
  SshPlannedHostWire,
  SshSecretNameWire,
} from '../../../shared/ssh-wire.js';
import { ipc } from '../../state/ipc-client.js';
import { useHostsStore } from './hosts-store.js';
import { INPUT_CLASS } from './inherited-field.js';

/** A key row's choice while the user edits it; `secret` is kept across kinds so switching back keeps the name. */
interface KeyDraft {
  readonly kind: SshKeyChoiceWire['kind'];
  readonly store: string;
  readonly existing: string;
}

type Step = { kind: 'choose'; message?: string } | { kind: 'busy' } | { kind: 'report'; preview: SshImportPreview };

/** Codes after which the preview no longer matches the disk: the dialog starts over. */
const START_OVER = new Set(['ssh-import-expired', 'ssh-import-stale']);

function keyError(draft: KeyDraft, names: readonly SshSecretNameWire[]): string | undefined {
  if (draft.kind === 'store') {
    if (!SSH_SECRET_NAME_PATTERN.test(draft.store)) return 'Use letters, digits and _ (not starting with a digit)';
    if (names.some((n) => n.name === draft.store)) return 'That secret exists: choose "Use an existing secret"';
  }
  if (draft.kind === 'existing' && draft.existing === '') return 'Choose a secret';
  return undefined;
}

function choiceOf(draft: KeyDraft): SshKeyChoiceWire {
  if (draft.kind === 'store') return { kind: 'store', secret: draft.store };
  if (draft.kind === 'existing') return { kind: 'existing', secret: draft.existing };
  return { kind: 'agent' };
}

/** The "Import from SSH config" dialog: pick the file, read the report, choose per key, import. */
export function ImportDialog() {
  const open = useHostsStore((s) => s.importOpen);
  const setImportOpen = useHostsStore((s) => s.setImportOpen);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setImportOpen(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="ssh-import-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[85vh] w-[46rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Import from SSH config</Dialog.Title>
          {open && <ImportBody />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ImportBody() {
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [names, setNames] = useState<readonly SshSecretNameWire[]>([]);

  useEffect(() => {
    void ipc()
      .ssh.secretNames(undefined)
      .then((result) => {
        if (result.ok) setNames(result.value.names);
      });
  }, []);

  const preview = async (source: 'user-config' | 'pick'): Promise<void> => {
    setStep({ kind: 'busy' });
    const result = await ipc().ssh.importPreview({ source });
    if (!result.ok) {
      setStep({ kind: 'choose', message: result.error.message });
      return;
    }
    if ('cancelled' in result.value) {
      setStep({ kind: 'choose' });
      return;
    }
    setStep({ kind: 'report', preview: result.value });
  };

  if (step.kind === 'report') {
    return (
      <Report
        preview={step.preview}
        names={names}
        onStartOver={(message) => {
          setStep({ kind: 'choose', message });
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3 text-sm text-fg-default">
      <Dialog.Description className="text-fg-subtle">
        Hosts from an OpenSSH client config are added to a new group in hosts.yaml. You see what will be imported before
        anything is written.
      </Dialog.Description>
      {step.kind === 'choose' && step.message !== undefined && (
        <p role="alert" className="rounded border border-status-danger px-2 py-1">
          {step.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={step.kind === 'busy'}
          onClick={() => {
            void preview('user-config');
          }}
        >
          Read ~/.ssh/config
        </Button>
        <Button
          disabled={step.kind === 'busy'}
          onClick={() => {
            void preview('pick');
          }}
        >
          Choose a file…
        </Button>
      </div>
    </div>
  );
}

function Report(props: {
  readonly preview: SshImportPreview;
  readonly names: readonly SshSecretNameWire[];
  readonly onStartOver: (message: string) => void;
}) {
  const { preview, names, onStartOver } = props;
  const setImportOpen = useHostsStore((s) => s.setImportOpen);
  const applyImported = useHostsStore((s) => s.applyImported);
  const [groupName, setGroupName] = useState(preview.group.name);
  const [anyway, setAnyway] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Readonly<Record<string, KeyDraft>>>(() =>
    Object.fromEntries(preview.keys.map((k) => [k.ref, { kind: 'agent', store: k.proposedSecret, existing: '' }])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const count = preview.hosts.filter(
    (h) => h.status === 'new' || h.status === 'created-for-jump' || (h.status === 'duplicate' && anyway.has(h.id)),
  ).length;
  const keyErrors = Object.fromEntries(preview.keys.map((k) => [k.ref, keyError(drafts[k.ref] as KeyDraft, names)]));
  const invalid = Object.values(keyErrors).some((e) => e !== undefined) || groupName.trim() === '';

  const authLabel = (host: SshPlannedHostWire): string => {
    const auth = host.ssh.auth ?? preview.group.ssh.auth;
    if (auth === undefined || auth.kind === 'agent') return 'SSH agent';
    const key = preview.keys.find((k) => k.ref === auth.ref);
    const draft = drafts[auth.ref];
    if (draft?.kind === 'store') return `key → ${draft.store}`;
    if (draft?.kind === 'existing') return `key → ${draft.existing || '?'}`;
    return `SSH agent (${key?.display ?? 'key'})`;
  };
  const statusLabel = (host: SshPlannedHostWire): string =>
    host.status === 'new'
      ? 'new'
      : host.status === 'created-for-jump'
        ? 'created for a jump'
        : (host.reason ?? host.status);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await ipc().ssh.importApply({
      previewId: preview.previewId,
      groupName: groupName.trim(),
      importDuplicates: [...anyway],
      keys: preview.keys.map((k) => ({ ref: k.ref, choice: choiceOf(drafts[k.ref] as KeyDraft) })),
    });
    setBusy(false);
    if (!result.ok) {
      if (START_OVER.has(result.error.code)) onStartOver(result.error.message);
      else setError(result.error.message);
      return;
    }
    applyImported(result.value);
    setImportOpen(false);
    const { stored } = result.value;
    showToast(
      `Imported ${String(count)} host${count === 1 ? '' : 's'} into ${groupName.trim()}` +
        (stored.length > 0 ? `; stored ${stored.join(', ')}` : ''),
    );
  };

  return (
    <div className="flex flex-col gap-3 text-sm text-fg-default">
      <Dialog.Description className="text-fg-subtle">{`From ${preview.source}`}</Dialog.Description>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-fg-subtle">Group name</span>
        <input
          aria-label="Group name"
          className={INPUT_CLASS}
          value={groupName}
          onChange={(e) => {
            setGroupName(e.target.value);
          }}
        />
      </label>

      <table aria-label="Hosts to import" className="w-full text-left text-xs">
        <thead className="text-fg-subtle">
          <tr>
            <th className="py-1">Host</th>
            <th>Id</th>
            <th>Address</th>
            <th>User</th>
            <th>Port</th>
            <th>Jump</th>
            <th>Authentication</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {preview.hosts.map((h) => (
            <tr key={h.id} className="border-t border-hairline">
              <td className="py-1">{h.alias}</td>
              <td className="font-mono">
                {h.id}
                {h.idChangedFrom !== undefined && <span className="ml-1 text-fg-subtle">(changed)</span>}
              </td>
              <td>{h.address}</td>
              <td>{h.ssh.user ?? preview.group.ssh.user ?? '—'}</td>
              <td>{String(h.ssh.port ?? preview.group.ssh.port ?? 22)}</td>
              <td>{h.ssh.jump ?? '—'}</td>
              <td>{h.status === 'skipped' ? '—' : authLabel(h)}</td>
              <td>
                {statusLabel(h)}
                {h.status === 'duplicate' && (
                  <label className="ml-2 inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      aria-label={`Import ${h.alias} anyway`}
                      checked={anyway.has(h.id)}
                      onChange={(e) => {
                        const next = new Set(anyway);
                        if (e.target.checked) next.add(h.id);
                        else next.delete(h.id);
                        setAnyway(next);
                      }}
                    />
                    Import anyway
                  </label>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {preview.keys.length > 0 && (
        <section aria-label="Keys" className="flex flex-col gap-2">
          <h3 className="text-xs font-medium">Keys</h3>
          <p className="text-xs text-fg-subtle">
            Wirebench reads a key file only if you choose to store it, and only when you click Import.
          </p>
          {preview.keys.map((key) => {
            const draft = drafts[key.ref] as KeyDraft;
            const update = (next: Partial<KeyDraft>): void => {
              setDrafts({ ...drafts, [key.ref]: { ...draft, ...next } });
            };
            const group = `key-${key.ref}`;
            return (
              <fieldset key={key.ref} className="flex flex-col gap-1 rounded border border-hairline p-2 text-xs">
                <legend className="px-1 font-mono">{key.display}</legend>
                <span className="text-fg-subtle">{`Used by ${key.hosts.join(', ')}`}</span>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={group}
                    checked={draft.kind === 'agent'}
                    onChange={() => {
                      update({ kind: 'agent' });
                    }}
                  />
                  Use the SSH agent
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={group}
                    checked={draft.kind === 'store'}
                    onChange={() => {
                      update({ kind: 'store' });
                    }}
                  />
                  Store as workspace secret
                  <input
                    aria-label={`Secret name for ${key.display}`}
                    className={`${INPUT_CLASS} w-56`}
                    value={draft.store}
                    disabled={draft.kind !== 'store'}
                    onChange={(e) => {
                      update({ store: e.target.value });
                    }}
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={group}
                    checked={draft.kind === 'existing'}
                    onChange={() => {
                      update({ kind: 'existing' });
                    }}
                  />
                  Use an existing secret
                  <select
                    aria-label={`Existing secret for ${key.display}`}
                    className={`${INPUT_CLASS} w-56`}
                    value={draft.existing}
                    disabled={draft.kind !== 'existing'}
                    onChange={(e) => {
                      update({ existing: e.target.value });
                    }}
                  >
                    <option value="">Choose a secret…</option>
                    {names.map((n) => (
                      <option key={n.name} value={n.name}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                </label>
                {keyErrors[key.ref] !== undefined && (
                  <span role="alert" className="text-status-danger">
                    {keyErrors[key.ref]}
                  </span>
                )}
              </fieldset>
            );
          })}
        </section>
      )}

      {(preview.report.skipped.length > 0 || preview.report.problems.length > 0) && (
        <section aria-label="Not imported" className="flex flex-col gap-1 text-xs">
          <h3 className="font-medium">Not imported</h3>
          <ul className="flex flex-col gap-0.5">
            {preview.report.problems.map((p, i) => (
              <li key={`p${String(i)}`}>
                <span className="font-mono">{p.line === undefined ? p.file : `${p.file}:${String(p.line)}`}</span>{' '}
                {p.why}
              </li>
            ))}
            {preview.report.skipped.map((s) => (
              <li key={`${s.file}:${String(s.line)}`}>
                <span className="font-mono">{`${s.file}:${String(s.line)}`}</span> <span>{s.keyword}</span> {s.why}
              </li>
            ))}
          </ul>
        </section>
      )}
      {preview.report.ignored.length > 0 && (
        <section aria-label="Options Wirebench does not use" className="flex flex-col gap-1 text-xs">
          <h3 className="font-medium">Options Wirebench does not use</h3>
          <p className="text-fg-subtle">
            {preview.report.ignored.map((i) => `${i.keyword} × ${String(i.count)}`).join(', ')}
          </p>
        </section>
      )}
      {preview.report.notes.length > 0 && (
        <section aria-label="Notes" className="flex flex-col gap-1 text-xs">
          <h3 className="font-medium">Notes</h3>
          <ul className="flex flex-col gap-0.5 text-fg-subtle">
            {preview.report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      {error !== undefined && (
        <p role="alert" className="rounded border border-status-danger px-2 py-1">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Dialog.Close asChild>
          <Button>Cancel</Button>
        </Dialog.Close>
        <Button
          variant="primary"
          disabled={busy || invalid || count === 0}
          onClick={() => {
            void submit();
          }}
        >
          {`Import ${String(count)} host${count === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  );
}
