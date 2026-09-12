/**
 * The Outgoing section of the WS-Security sidebar: the project's outgoing configurations, and
 * the editor for the selected one — its defaults, its actor/mustUnderstand, and its ordered
 * entry list.
 *
 * The renderer never holds a password. A username token's password goes into the secret store
 * through {@link SecretField}, and only the resulting `secretRef` is written to the
 * configuration; the value itself is resolved in main, at send time.
 */

import { useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/button.js';
import { IconButton } from '../../components/icon-button.js';
import { SecretField } from '../../components/secret-field.js';
import { useProjectStore, useTargetProjectId } from '../../state/project.js';
import {
  EncryptionFields,
  SignatureFields,
  TimestampFields,
  UsernameTokenFields,
  WSS_FIELD_CLASS,
} from './outgoing-entry-fields.js';
import type { WssEntryWire, WssOutgoingWire } from '../../../shared/wire-types.js';

/** The label each entry kind carries in the list and in the Add menu. */
const ENTRY_LABEL: Readonly<Record<WssEntryWire['kind'], string>> = {
  timestamp: 'Timestamp',
  'username-token': 'Username Token',
  signature: 'Signature',
  encryption: 'Encryption',
};

/** The parts a new signature covers: the SOAP 1.1 `Body` and the WS-Security `Timestamp`. */
const DEFAULT_SIGNATURE_PARTS = [
  { name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' },
  {
    name: 'Timestamp',
    namespace: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
    encode: 'Content',
  },
] as const;

/** The parts a new encryption entry covers: the SOAP 1.1 `Body`'s content. */
const DEFAULT_ENCRYPTION_PARTS = [
  { name: 'Body', namespace: 'http://schemas.xmlsoap.org/soap/envelope/', encode: 'Content' },
] as const;

/** The kinds the Add menu can create. */
type NewEntryKind = 'timestamp' | 'username-token' | 'signature' | 'encryption';

/** A fresh entry of the kind the user picked from the Add menu. */
function newEntry(kind: NewEntryKind): WssEntryWire {
  if (kind === 'timestamp') {
    return { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false };
  }
  if (kind === 'username-token') {
    return { kind: 'username-token', username: '', passwordType: 'digest', addNonce: true, addCreated: true };
  }
  if (kind === 'signature') {
    return {
      kind: 'signature',
      keystoreRef: '',
      keyIdentifierType: 'BinarySecurityToken',
      signatureAlgorithm: 'rsa-sha256',
      digestAlgorithm: 'sha256',
      canonicalization: 'exc-c14n',
      useSingleCertificate: true,
      parts: DEFAULT_SIGNATURE_PARTS.map((part) => ({ ...part })),
    };
  }
  return {
    kind: 'encryption',
    keystoreRef: '',
    keyIdentifierType: 'BinarySecurityToken',
    symmetricAlgorithm: 'aes256-gcm',
    keyTransportAlgorithm: 'rsa-oaep',
    embedKey: false,
    encryptSymmetricKey: true,
    parts: DEFAULT_ENCRYPTION_PARTS.map((part) => ({ ...part })),
  };
}

/** Moves the entry at `index` by `delta`, or returns the list unchanged at either end. */
function move(entries: readonly WssEntryWire[], index: number, delta: number): readonly WssEntryWire[] {
  const target = index + delta;
  if (target < 0 || target >= entries.length) {
    return entries;
  }
  const next = [...entries];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) {
    next.splice(target, 0, moved);
  }
  return next;
}

const FIELD = WSS_FIELD_CLASS;

interface EntryProps {
  readonly entry: WssEntryWire;
  readonly index: number;
  readonly count: number;
  readonly onChange: (entry: WssEntryWire) => void;
  readonly onMove: (delta: number) => void;
  readonly onRemove: () => void;
}

function EntryRow({ entry, index, count, onChange, onMove, onRemove }: EntryProps) {
  return (
    <li data-testid="wss-entry-row" className="rounded border border-hairline p-1">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-xs text-fg-default">{ENTRY_LABEL[entry.kind]}</span>
        <IconButton
          label={`Move ${ENTRY_LABEL[entry.kind]} up`}
          disabled={index === 0}
          onClick={() => {
            onMove(-1);
          }}
        >
          <ArrowUp size={12} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={`Move ${ENTRY_LABEL[entry.kind]} down`}
          disabled={index === count - 1}
          onClick={() => {
            onMove(1);
          }}
        >
          <ArrowDown size={12} aria-hidden="true" />
        </IconButton>
        <IconButton label={`Remove ${ENTRY_LABEL[entry.kind]}`} onClick={onRemove}>
          <Trash2 size={12} aria-hidden="true" />
        </IconButton>
      </div>

      {entry.kind === 'timestamp' && <TimestampFields entry={entry} onChange={onChange} />}

      {entry.kind === 'username-token' && <UsernameTokenFields entry={entry} onChange={onChange} />}

      {entry.kind === 'signature' && <SignatureFields entry={entry} onChange={onChange} />}

      {entry.kind === 'encryption' && <EncryptionFields entry={entry} onChange={onChange} />}
    </li>
  );
}

interface ConfigProps {
  readonly config: WssOutgoingWire;
  readonly onRemove: () => void;
}

function ConfigRow({ config, onRemove }: ConfigProps) {
  const [open, setOpen] = useState(false);
  const updateWssOutgoing = useProjectStore((state) => state.updateWssOutgoing);
  const keystores = useProjectStore((state) => state.keystores);
  const Chevron = open ? ChevronDown : ChevronRight;

  const patchEntries = (entries: readonly WssEntryWire[]): void => {
    void updateWssOutgoing(config.id, { entries: [...entries] });
  };

  return (
    <li data-testid="wss-outgoing-row" className="rounded px-1 py-0.5">
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
          <span className="min-w-0 truncate">{config.name}</span>
          <span className="shrink-0 text-xs text-fg-subtle">
            {config.entries.length === 1 ? '1 entry' : `${String(config.entries.length)} entries`}
          </span>
        </button>
        <IconButton label={`Remove ${config.name}`} onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
        </IconButton>
      </div>

      {open && (
        <div data-testid="wss-outgoing-editor" className="flex flex-col gap-1 px-5 pb-2">
          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <span className="w-24 shrink-0">Name</span>
            <input
              aria-label="Configuration name"
              className={FIELD}
              defaultValue={config.name}
              onBlur={(event) => {
                if (event.target.value.trim().length > 0 && event.target.value !== config.name) {
                  void updateWssOutgoing(config.id, { name: event.target.value });
                }
              }}
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <span className="w-24 shrink-0">Default alias</span>
            <select
              aria-label="Default alias"
              className={FIELD}
              value={config.defaultAlias ?? ''}
              onChange={(event) => {
                void updateWssOutgoing(config.id, {
                  defaultAlias: event.target.value === '' ? null : event.target.value,
                });
              }}
            >
              <option value="">—</option>
              {/* The alias list is the union of every keystore's *default* alias: reading the
                  aliases themselves means `keystores.inspect` per row, which Task 38 needs
                  anyway when signing gains a real per-entry keystore choice. */}
              {keystores
                .map((keystore) => keystore.defaultAlias)
                .filter((alias): alias is string => alias !== undefined)
                .map((alias) => (
                  <option key={alias} value={alias}>
                    {alias}
                  </option>
                ))}
              {config.defaultAlias !== undefined &&
                !keystores.some((keystore) => keystore.defaultAlias === config.defaultAlias) && (
                  <option value={config.defaultAlias}>{config.defaultAlias}</option>
                )}
            </select>
          </label>
          <div data-testid="wss-outgoing-password">
            <SecretField
              label="Default WS-Security password"
              value={config.defaultPasswordRef}
              onChange={(ref) => {
                void updateWssOutgoing(config.id, { defaultPasswordRef: ref ?? null });
              }}
            />
          </div>
          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <span className="w-24 shrink-0">Actor</span>
            <input
              aria-label="Actor"
              className={FIELD}
              defaultValue={config.actor ?? ''}
              onBlur={(event) => {
                if (event.target.value !== (config.actor ?? '')) {
                  void updateWssOutgoing(config.id, {
                    actor: event.target.value === '' ? null : event.target.value,
                  });
                }
              }}
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <input
              type="checkbox"
              aria-label="Must understand"
              checked={config.mustUnderstand}
              onChange={(event) => {
                void updateWssOutgoing(config.id, { mustUnderstand: event.target.checked });
              }}
            />
            Must understand
          </label>

          <div className="mt-1 flex items-center gap-1">
            <span className="min-w-0 flex-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">Entries</span>
            <select
              aria-label="Add entry"
              data-testid="wss-entry-add"
              className="rounded border border-hairline bg-surface-sunken px-1 py-0.5 text-xs text-fg-default"
              value=""
              onChange={(event) => {
                const kind = event.target.value;
                if (
                  kind === 'timestamp' ||
                  kind === 'username-token' ||
                  kind === 'signature' ||
                  kind === 'encryption'
                ) {
                  patchEntries([...config.entries, newEntry(kind)]);
                }
                event.target.value = '';
              }}
            >
              <option value="">Add entry…</option>
              <option value="timestamp">Timestamp</option>
              <option value="username-token">Username Token</option>
              <option value="signature">Signature</option>
              <option value="encryption">Encryption</option>
            </select>
          </div>

          <ul aria-label={`Entries of ${config.name}`} className="flex flex-col gap-1">
            {config.entries.length === 0 && <li className="text-xs text-fg-faint">No entries yet.</li>}
            {config.entries.map((entry, index) => (
              <EntryRow
                // Entries have no ids of their own; position is their identity, and the whole
                // list is replaced on every edit, so a positional key is exact here.
                key={`${entry.kind}-${String(index)}`}
                entry={entry}
                index={index}
                count={config.entries.length}
                onChange={(next) => {
                  patchEntries(config.entries.map((candidate, at) => (at === index ? next : candidate)));
                }}
                onMove={(delta) => {
                  patchEntries(move(config.entries, index, delta));
                }}
                onRemove={() => {
                  patchEntries(config.entries.filter((_candidate, at) => at !== index));
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** The Outgoing section body: one row per configuration, each expanding into its editor. */
export function OutgoingConfigEditor() {
  const configs = useProjectStore((state) => state.wssOutgoing);
  const projectId = useTargetProjectId();
  const addWssOutgoing = useProjectStore((state) => state.addWssOutgoing);
  const removeWssOutgoing = useProjectStore((state) => state.removeWssOutgoing);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);
  const pendingDelete = configs.find((candidate) => candidate.id === pendingDeleteId);

  return (
    <div data-testid="wss-outgoing-view" className="flex min-h-0 flex-col border-t border-hairline">
      <div className="flex h-8 items-center gap-1 pr-2 pl-2">
        <span className="min-w-0 flex-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">Outgoing</span>
        <IconButton
          label="Add outgoing WS-Security configuration"
          data-testid="wss-outgoing-add"
          disabled={projectId === undefined}
          onClick={() => {
            if (projectId !== undefined) {
              void addWssOutgoing(projectId);
            }
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <ul aria-label="Outgoing WS-Security configurations" className="flex flex-col gap-0.5 px-1 pb-2">
        {configs.length === 0 && (
          <li className="px-2 py-1 text-sm text-fg-subtle">
            {projectId === undefined ? 'Select a project to add one.' : 'No outgoing configurations yet.'}
          </li>
        )}
        {configs.map((config) => (
          <ConfigRow
            key={config.id}
            config={config}
            onRemove={() => {
              setPendingDeleteId(config.id);
            }}
          />
        ))}
      </ul>

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
            <AlertDialog.Title className="text-md font-medium text-fg-default">
              Remove WS-Security configuration?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
              {pendingDelete !== undefined
                ? `"${pendingDelete.name}" is removed from the project, and every request that selected it stops sending a security header.`
                : 'This cannot be undone.'}
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  variant="primary"
                  data-testid="wss-outgoing-remove-confirm"
                  onClick={() => {
                    if (pendingDeleteId !== undefined) {
                      void removeWssOutgoing(pendingDeleteId);
                    }
                    setPendingDeleteId(undefined);
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
