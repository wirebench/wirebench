/**
 * The Keystores list of the WS-Security sidebar: the project's client keystore registry, each
 * row's load status, and its aliases.
 *
 * The renderer holds *no* key material and no password. A row's status and its aliases come
 * from `keystores.inspect`, which main answers with metadata only; a password typed into the
 * add dialog goes straight into the secret store through {@link SecretField}, so only a
 * `secretRef` ever reaches the project file.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, ChevronRight, KeyRound, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/button.js';
import { IconButton } from '../../components/icon-button.js';
import { SecretField } from '../../components/secret-field.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { KeystoreAliasWire, KeystoresInspectResponse, KeystoreWire } from '../../../shared/wire-types.js';

/** The status chip's copy and tone, keyed by what `keystores.inspect` reported. */
const STATUS: Readonly<Record<KeystoresInspectResponse['status'], { label: string; tone: string }>> = {
  ok: { label: 'Loaded', tone: 'text-status-success' },
  'bad-password': { label: 'Wrong password', tone: 'text-status-danger' },
  invalid: { label: 'Unreadable', tone: 'text-status-danger' },
  'not-found': { label: 'File missing', tone: 'text-status-warning' },
  'outside-project': { label: 'Outside project', tone: 'text-status-warning' },
};

/** The trailing part of a path, so a long absolute path still identifies the file at a glance. */
function shortPath(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.length <= 2 ? path : `…/${segments.slice(-2).join('/')}`;
}

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 10);
}

interface RowProps {
  readonly keystore: KeystoreWire;
  readonly status: KeystoresInspectResponse | undefined;
  readonly onRemove: () => void;
  readonly onSetDefaultAlias: (alias: string) => void;
}

function KeystoreRow({ keystore, status, onRemove, onSetDefaultAlias }: RowProps) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const chip = status === undefined ? { label: 'Checking…', tone: 'text-fg-subtle' } : STATUS[status.status];

  return (
    <li data-testid="keystore-row" className="rounded px-1 py-0.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-sm text-fg-default hover:bg-surface-raised"
        >
          <Chevron size={12} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">{keystore.name}</span>
          <span className="shrink-0 rounded bg-surface-raised px-1 text-xs text-fg-subtle uppercase">
            {keystore.type === 'pkcs12' ? 'p12' : 'pem'}
          </span>
          <span data-testid="keystore-status" className={`shrink-0 text-xs ${chip.tone}`} title={status?.message}>
            {chip.label}
          </span>
        </button>
        <IconButton label={`Remove ${keystore.name}`} onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
        </IconButton>
      </div>

      {open && (
        <div className="px-5 pb-2 text-xs text-fg-subtle">
          <p className="truncate" title={keystore.path}>
            {shortPath(keystore.path)}
          </p>
          {keystore.defaultAlias !== undefined && <p>Default alias: {keystore.defaultAlias}</p>}
          <ul aria-label={`Aliases of ${keystore.name}`} className="mt-1 flex flex-col gap-1">
            {(status?.aliases ?? []).map((alias: KeystoreAliasWire) => (
              <li
                key={alias.fingerprintSha256 + alias.alias}
                data-testid="keystore-alias-row"
                className="rounded border border-hairline p-1"
              >
                <div className="flex items-center gap-1">
                  {alias.hasPrivateKey && (
                    <KeyRound size={11} aria-label="Has a private key" className="shrink-0 text-fg-muted" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-fg-default">{alias.alias}</span>
                  {keystore.defaultAlias === alias.alias ? (
                    <span className="shrink-0 text-fg-faint">default</span>
                  ) : (
                    <button
                      type="button"
                      className="shrink-0 rounded px-1 text-accent hover:bg-surface-raised"
                      onClick={() => {
                        onSetDefaultAlias(alias.alias);
                      }}
                    >
                      Set as default
                    </button>
                  )}
                </div>
                <p className="truncate" title={alias.subject}>
                  {alias.subject}
                </p>
                <p>Expires {formatExpiry(alias.notAfter)}</p>
                <p className="font-mono break-all">{alias.fingerprintSha256}</p>
              </li>
            ))}
            {status !== undefined && status.aliases.length === 0 && (
              <li className="text-fg-faint">{status.message ?? 'No aliases.'}</li>
            )}
          </ul>
        </div>
      )}
    </li>
  );
}

/** The "Add keystore" dialog: pick a file, name it, and optionally store its password. */
function AddKeystoreDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (o: boolean) => void;
}) {
  const addKeystore = useProjectStore((state) => state.addKeystore);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [passwordRef, setPasswordRef] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const flushRef = useRef<(() => Promise<string | undefined>) | undefined>(undefined);
  const registerFlush = useCallback((flush: (() => Promise<string | undefined>) | undefined) => {
    flushRef.current = flush;
  }, []);

  function reset(): void {
    setPath('');
    setName('');
    setPasswordRef(undefined);
    setBusy(false);
  }

  async function pick(): Promise<void> {
    const result = await ipc().keystores.pickFile({});
    if (!result.ok || result.value.path === undefined) {
      return;
    }
    setPath(result.value.path);
    if (name.trim().length === 0) {
      const file = result.value.path.split(/[\\/]/).pop() ?? '';
      const dot = file.lastIndexOf('.');
      setName(dot > 0 ? file.slice(0, dot) : file);
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      // A password typed but never explicitly saved must not be dropped on the floor, so the
      // SecretField is flushed first and its fresh ref used (see `auth-inspector.tsx`).
      const ref = (await flushRef.current?.()) ?? passwordRef;
      await addKeystore({
        path,
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
        ...(ref !== undefined ? { passwordSecretRef: ref } : {}),
      });
      reset();
      onOpenChange(false);
    } catch (error) {
      setBusy(false);
      showToast(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="keystore-add-dialog"
          className="fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Add keystore</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            A PKCS#12 (.p12/.pfx) or PEM bundle. The password is stored in the OS keychain, never in the project.
          </Dialog.Description>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="keystore-path">
            File
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="keystore-path"
              data-testid="keystore-path"
              readOnly
              value={path}
              placeholder="Choose a keystore file"
              className="min-w-0 flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none"
            />
            <Button data-testid="keystore-browse" onClick={() => void pick()}>
              Browse…
            </Button>
          </div>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="keystore-name">
            Name
          </label>
          <input
            id="keystore-name"
            data-testid="keystore-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none"
          />

          <p className="mt-3 text-sm text-fg-subtle">Password</p>
          <div className="mt-1">
            <SecretField
              label="Keystore password"
              value={passwordRef}
              onChange={setPasswordRef}
              registerFlush={registerFlush}
            />
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              data-testid="keystore-add-submit"
              disabled={path.length === 0 || busy}
              onClick={() => void submit()}
            >
              Add
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The Keystores section body: one row per registry entry, re-inspected whenever the registry
 * changes (an add, a removal, or a password the user replaced).
 */
export function KeystoresView() {
  const keystores = useProjectStore((state) => state.keystores);
  const hasProject = useProjectStore((state) => state.project !== null);
  const removeKeystore = useProjectStore((state) => state.removeKeystore);
  const updateKeystore = useProjectStore((state) => state.updateKeystore);
  const [adding, setAdding] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);
  const [statuses, setStatuses] = useState<Readonly<Record<string, KeystoresInspectResponse>>>({});

  // Keyed on the registry's identity *and* its password refs: replacing a password must
  // re-inspect, and nothing else should.
  const signature = keystores.map((k) => `${k.id}:${k.passwordSecretRef ?? ''}:${k.defaultAlias ?? ''}`).join('|');

  useEffect(() => {
    let cancelled = false;
    async function inspectAll(): Promise<void> {
      const entries = await Promise.all(
        keystores.map(async (keystore) => {
          const result = await ipc().keystores.inspect({ keystoreId: keystore.id });
          const value: KeystoresInspectResponse = result.ok
            ? result.value
            : { status: 'invalid', aliases: [], message: result.error.message };
          return [keystore.id, value] as const;
        }),
      );
      if (!cancelled) {
        setStatuses(Object.fromEntries(entries));
      }
    }
    void inspectAll();
    return () => {
      cancelled = true;
    };
    // `signature` (not the array identity) is the dependency: it changes exactly when a row, a
    // password ref or a default alias does, which is when a re-inspection is warranted.
  }, [signature, keystores]);

  const pendingDelete = keystores.find((candidate) => candidate.id === pendingDeleteId);

  return (
    <div data-testid="keystores-view" className="flex min-h-0 flex-col">
      <div className="flex h-8 items-center gap-1 pr-2 pl-2">
        <span className="min-w-0 flex-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">Keystores</span>
        <IconButton
          label="Add keystore"
          data-testid="keystore-add"
          disabled={!hasProject}
          onClick={() => {
            setAdding(true);
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <ul aria-label="Keystores" className="flex flex-col gap-0.5 px-1 pb-2">
        {keystores.length === 0 && (
          <li className="px-2 py-1 text-sm text-fg-subtle">
            {hasProject ? 'No keystores yet.' : 'Open a project to add keystores.'}
          </li>
        )}
        {keystores.map((keystore) => (
          <KeystoreRow
            key={keystore.id}
            keystore={keystore}
            status={statuses[keystore.id]}
            onRemove={() => {
              setPendingDeleteId(keystore.id);
            }}
            onSetDefaultAlias={(alias) => {
              void updateKeystore(keystore.id, { defaultAlias: alias });
            }}
          />
        ))}
      </ul>

      <AddKeystoreDialog open={adding} onOpenChange={setAdding} />

      <AlertDialog.Root
        open={pendingDeleteId !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setPendingDeleteId(undefined);
          }
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg">
            <AlertDialog.Title className="text-md font-medium text-fg-default">Remove keystore?</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
              {pendingDelete !== undefined
                ? `"${pendingDelete.name}" is removed from the project. The file itself is left alone, and every request that selected it stops presenting a client certificate.`
                : 'This cannot be undone.'}
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  variant="primary"
                  data-testid="keystore-remove-confirm"
                  onClick={() => {
                    if (pendingDeleteId !== undefined) {
                      void removeKeystore(pendingDeleteId);
                    }
                  }}
                >
                  Remove
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
