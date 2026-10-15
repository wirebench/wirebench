import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import type { SshKnownHostsImportPreview } from '../../../shared/ssh-wire.js';
import { ipc } from '../../state/ipc-client.js';
import { useHostsStore } from './hosts-store.js';

type Step =
  { kind: 'choose'; message?: string } | { kind: 'busy' } | { kind: 'report'; preview: SshKnownHostsImportPreview };
type Conflict = SshKnownHostsImportPreview['conflicts'][number];
type SkipReason = SshKnownHostsImportPreview['skipped'][number]['reason'];

/** Codes after which the preview no longer matches the disk: the dialog starts over. */
const START_OVER = new Set(['ssh-import-expired']);

const SKIP_LABELS: Record<SkipReason, string> = {
  'cert-authority': '@cert-authority: trusts a signing key, not a host key',
  revoked: '@revoked: a key to refuse, which Wirebench does not keep',
  'no-host': 'Names no host in hosts.yaml',
  duplicate: 'An earlier line already gives that host a key of this type',
  unreadable: 'Not a key line Wirebench can read',
};
const SKIP_ORDER: readonly SkipReason[] = ['cert-authority', 'revoked', 'no-host', 'duplicate', 'unreadable'];

const slot = (row: { host: string; keyType: string }): string => `${row.host} ${row.keyType}`;
const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** "Import known hosts": pick the file, review which hosts gain a key and which conflict, then trust. */
export function KnownHostsImportDialog() {
  const open = useHostsStore((s) => s.knownHostsImportOpen);
  const setOpen = useHostsStore((s) => s.setKnownHostsImportOpen);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="known-hosts-import-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[85vh] w-[46rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Import known hosts</Dialog.Title>
          {open && <ImportBody />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ImportBody() {
  const [step, setStep] = useState<Step>({ kind: 'choose' });

  const preview = async (source: 'user-known-hosts' | 'pick'): Promise<void> => {
    setStep({ kind: 'busy' });
    const result = await ipc().ssh.knownHostsImportPreview({ source });
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
        onStartOver={(message) => {
          setStep({ kind: 'choose', message });
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3 text-sm text-fg-default">
      <Dialog.Description className="text-fg-subtle">
        Host keys from an OpenSSH known_hosts file are trusted for the hosts in hosts.yaml they name, hashed names
        included. You see what will be trusted before anything is written.
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
            void preview('user-known-hosts');
          }}
        >
          Read ~/.ssh/known_hosts
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
  readonly preview: SshKnownHostsImportPreview;
  readonly onStartOver: (message: string) => void;
}) {
  const { preview, onStartOver } = props;
  const setOpen = useHostsStore((s) => s.setKnownHostsImportOpen);
  const knownHostsChanged = useHostsStore((s) => s.knownHostsChanged);
  const [replace, setReplace] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const chosen = preview.conflicts.filter((c) => replace.has(slot(c)));
  const count = preview.add.length + chosen.length;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const result = await ipc().ssh.knownHostsImportApply({
      previewId: preview.previewId,
      replace: chosen.map(({ host, keyType }) => ({ host, keyType })),
    });
    setBusy(false);
    if (!result.ok) {
      if (START_OVER.has(result.error.code)) onStartOver(result.error.message);
      else setError(result.error.message);
      return;
    }
    const { added, replaced, kept } = result.value;
    setOpen(false);
    knownHostsChanged();
    showToast(
      `Trusted ${plural(added, 'host key')}` +
        (replaced > 0 ? `; replaced ${String(replaced)}` : '') +
        (kept > 0 ? `; kept ${plural(kept, 'stored key')}` : ''),
    );
  };

  if (confirming) {
    return (
      <ConfirmReplace
        conflicts={chosen}
        understood={understood}
        busy={busy}
        error={error}
        onUnderstood={setUnderstood}
        onBack={() => {
          setConfirming(false);
          setUnderstood(false);
        }}
        onConfirm={() => {
          void submit();
        }}
      />
    );
  }

  const skipped = SKIP_ORDER.map((reason) => ({
    reason,
    lines: preview.skipped.filter((s) => s.reason === reason).map((s) => s.line),
  })).filter((group) => group.lines.length > 0);

  return (
    <div className="flex flex-col gap-3 text-sm text-fg-default">
      <Dialog.Description className="text-fg-subtle">{`From ${preview.source}`}</Dialog.Description>

      {preview.add.length === 0 ? (
        <p className="text-xs text-fg-subtle">No new host keys for the hosts in hosts.yaml.</p>
      ) : (
        <table aria-label="Keys to trust" className="w-full text-left text-xs">
          <thead className="text-fg-subtle">
            <tr>
              <th className="py-1">Host</th>
              <th>Address</th>
              <th>Key</th>
              <th>Line</th>
            </tr>
          </thead>
          <tbody>
            {preview.add.map((row) => (
              <tr key={slot(row)} className="border-t border-hairline">
                <td className="py-1">{row.names.join(', ')}</td>
                <td className="font-mono">{row.host}</td>
                <td>
                  <div>{row.keyType}</div>
                  <code className="font-mono break-all text-fg-subtle">{row.fingerprint}</code>
                </td>
                <td>{String(row.line)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {preview.conflicts.length > 0 && (
        <section aria-label="Conflicts" className="flex flex-col gap-1 text-xs">
          <h3 className="font-medium">Different from a trusted key</h3>
          <p className="text-fg-subtle">
            The stored key stays unless you choose to replace it; replacing asks you to confirm.
          </p>
          <table className="w-full text-left">
            <thead className="text-fg-subtle">
              <tr>
                <th className="py-1">Host</th>
                <th>Key</th>
                <th>Replace</th>
              </tr>
            </thead>
            <tbody>
              {preview.conflicts.map((row) => (
                <tr key={slot(row)} className="border-t border-hairline">
                  <td className="py-1">
                    <div>{row.names.join(', ')}</div>
                    <div className="font-mono text-fg-subtle">{row.host}</div>
                  </td>
                  <td>
                    <div>{row.keyType}</div>
                    <div className="text-fg-subtle">Trusted now</div>
                    <code className="font-mono break-all">{row.previous}</code>
                    <div className="text-fg-subtle">{`In the file (line ${String(row.line)})`}</div>
                    <code className="font-mono break-all">{row.fingerprint}</code>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Replace the ${row.keyType} key of ${row.host}`}
                      checked={replace.has(slot(row))}
                      onChange={(e) => {
                        const next = new Set(replace);
                        if (e.target.checked) next.add(slot(row));
                        else next.delete(slot(row));
                        setReplace(next);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {preview.trusted.length > 0 && (
        <p className="text-xs text-fg-subtle">{`${plural(preview.trusted.length, 'key')} already trusted.`}</p>
      )}

      {skipped.length > 0 && (
        <section aria-label="Not imported" className="flex flex-col gap-1 text-xs">
          <h3 className="font-medium">Not imported</h3>
          <ul className="flex flex-col gap-0.5">
            {skipped.map((group) => (
              <li key={group.reason}>
                {SKIP_LABELS[group.reason]}
                <span className="text-fg-subtle">
                  {` (${group.lines.length === 1 ? 'line' : 'lines'} ${group.lines.join(', ')})`}
                </span>
              </li>
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
        {/* Nothing to add and no conflict to replace: there is nothing to trust, only the report to close. */}
        {preview.add.length === 0 && preview.conflicts.length === 0 ? (
          <Dialog.Close asChild>
            <Button variant="primary">Close</Button>
          </Dialog.Close>
        ) : (
          <>
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              disabled={busy || count === 0}
              onClick={() => {
                if (chosen.length > 0) setConfirming(true);
                else void submit();
              }}
            >
              {`Trust ${plural(count, 'key')}`}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** The changed-key confirmation, as the trust prompt asks it: both fingerprints and an explicit tick. */
function ConfirmReplace(props: {
  readonly conflicts: readonly Conflict[];
  readonly understood: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onUnderstood: (understood: boolean) => void;
  readonly onBack: () => void;
  readonly onConfirm: () => void;
}) {
  const { conflicts } = props;
  return (
    <div className="flex flex-col gap-3 text-sm text-fg-default">
      <Dialog.Description className="text-fg-subtle">
        {`Replacing ${plural(conflicts.length, 'trusted key')}. A key that differs from the one you trusted can mean the host was reinstalled, or that something is intercepting the connection.`}
      </Dialog.Description>
      <ul aria-label="Keys to replace" className="flex flex-col gap-2 text-xs">
        {conflicts.map((row) => (
          <li key={slot(row)} className="flex flex-col gap-0.5 rounded border border-hairline p-2">
            <span>{`${row.names.join(', ')} (${row.host}), ${row.keyType}`}</span>
            <span className="text-fg-subtle">Previously trusted</span>
            <code className="font-mono break-all">{row.previous}</code>
            <span className="text-fg-subtle">New</span>
            <code className="font-mono break-all">{row.fingerprint}</code>
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={props.understood}
          onChange={(e) => {
            props.onUnderstood(e.target.checked);
          }}
        />
        I understand these keys changed
      </label>
      {props.error !== undefined && (
        <p role="alert" className="rounded border border-status-danger px-2 py-1">
          {props.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={props.onBack}>Back</Button>
        <Button variant="primary" disabled={props.busy || !props.understood} onClick={props.onConfirm}>
          Replace and trust
        </Button>
      </div>
    </div>
  );
}
