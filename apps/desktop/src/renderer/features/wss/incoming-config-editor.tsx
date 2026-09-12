/**
 * The Incoming section of the WS-Security sidebar: the project's incoming configurations, and
 * the editor for the selected one — which keystore opens an encrypted response, which
 * truststore its signatures are judged against, and how strict to be about them.
 *
 * As everywhere in this view, the renderer holds no key material: a private key's passphrase
 * goes into the secret store through {@link SecretField} and only its `secretRef` is written to
 * the configuration, and the alias list comes from `keystores.inspect`, which answers with
 * names and certificate metadata alone.
 */

import { useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { Button } from '../../components/button.js';
import { IconButton } from '../../components/icon-button.js';
import { SecretField } from '../../components/secret-field.js';
import { useProjectStore, useTargetProjectId } from '../../state/project.js';
import { useKeystoreAliases, WSS_FIELD_CLASS } from './outgoing-entry-fields.js';
import type { WssIncomingPatchWire, WssIncomingWire } from '../../../shared/wire-types.js';

const FIELD = WSS_FIELD_CLASS;

interface ConfigProps {
  readonly config: WssIncomingWire;
  readonly onRemove: () => void;
}

function ConfigRow({ config, onRemove }: ConfigProps) {
  const [open, setOpen] = useState(false);
  const updateWssIncoming = useProjectStore((state) => state.updateWssIncoming);
  const keystores = useProjectStore((state) => state.keystores);
  const aliases = useKeystoreAliases(config.decryptKeystoreRef ?? '');
  const Chevron = open ? ChevronDown : ChevronRight;

  const patch = (next: WssIncomingPatchWire): void => {
    void updateWssIncoming(config.id, next);
  };

  return (
    <li data-testid="wss-incoming-row" className="rounded px-1 py-0.5">
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
        </button>
        <IconButton label={`Remove ${config.name}`} onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
        </IconButton>
      </div>

      {open && (
        <div data-testid="wss-incoming-editor" className="flex flex-col gap-1 px-5 pb-2">
          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <span className="w-28 shrink-0">Name</span>
            <input
              aria-label="Incoming configuration name"
              className={FIELD}
              defaultValue={config.name}
              onBlur={(event) => {
                if (event.target.value.trim().length > 0 && event.target.value !== config.name) {
                  patch({ name: event.target.value });
                }
              }}
            />
          </label>

          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <span className="w-28 shrink-0">Decrypt keystore</span>
            <select
              aria-label="Decryption keystore"
              className={FIELD}
              value={config.decryptKeystoreRef ?? ''}
              onChange={(event) => {
                // Changing the keystore invalidates the alias chosen inside the old one.
                patch({
                  decryptKeystoreRef: event.target.value === '' ? null : event.target.value,
                  decryptAlias: null,
                });
              }}
            >
              <option value="">—</option>
              {keystores.map((keystore) => (
                <option key={keystore.id} value={keystore.id}>
                  {keystore.name}
                </option>
              ))}
            </select>
          </label>

          {config.decryptKeystoreRef !== undefined && (
            <label className="flex items-center gap-1 text-xs text-fg-subtle">
              <span className="w-28 shrink-0">Decrypt alias</span>
              <select
                aria-label="Decryption alias"
                className={FIELD}
                value={config.decryptAlias ?? ''}
                onChange={(event) => {
                  patch({ decryptAlias: event.target.value === '' ? null : event.target.value });
                }}
              >
                <option value="">Default</option>
                {aliases.map((alias) => (
                  <option key={alias.alias} value={alias.alias}>
                    {alias.alias}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div data-testid="wss-incoming-key-password">
            <SecretField
              label="Decryption key password"
              value={config.decryptKeyPasswordRef}
              onChange={(ref) => {
                patch({ decryptKeyPasswordRef: ref ?? null });
              }}
            />
          </div>

          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <span className="w-28 shrink-0">Truststore</span>
            <select
              aria-label="Signature truststore"
              className={FIELD}
              value={config.signatureKeystoreRef ?? ''}
              onChange={(event) => {
                patch({ signatureKeystoreRef: event.target.value === '' ? null : event.target.value });
              }}
            >
              <option value="">—</option>
              {keystores.map((keystore) => (
                <option key={keystore.id} value={keystore.id}>
                  {keystore.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <input
              type="checkbox"
              aria-label="Require signature"
              checked={config.requireSignature}
              onChange={(event) => {
                patch({ requireSignature: event.target.checked });
              }}
            />
            Require signature
          </label>
          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <input
              type="checkbox"
              aria-label="Require timestamp"
              checked={config.requireTimestamp}
              onChange={(event) => {
                patch({ requireTimestamp: event.target.checked });
              }}
            />
            Require timestamp
          </label>
          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <span className="w-28 shrink-0">Skew (s)</span>
            <input
              type="number"
              min={0}
              aria-label="Timestamp skew (seconds)"
              className={FIELD}
              value={config.timestampSkewSeconds}
              onChange={(event) => {
                patch({ timestampSkewSeconds: Math.max(0, Number(event.target.value) || 0) });
              }}
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-fg-subtle">
            <input
              type="checkbox"
              aria-label="Verify certificate chain"
              checked={config.verifyChain}
              onChange={(event) => {
                patch({ verifyChain: event.target.checked });
              }}
            />
            Verify certificate chain
          </label>
        </div>
      )}
    </li>
  );
}

/** The Incoming section body: one row per configuration, each expanding into its editor. */
export function IncomingConfigEditor() {
  const configs = useProjectStore((state) => state.wssIncoming);
  const projectId = useTargetProjectId();
  const addWssIncoming = useProjectStore((state) => state.addWssIncoming);
  const removeWssIncoming = useProjectStore((state) => state.removeWssIncoming);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);
  const pendingDelete = configs.find((candidate) => candidate.id === pendingDeleteId);

  return (
    <div data-testid="wss-incoming-view" className="flex min-h-0 flex-col border-t border-hairline">
      <div className="flex h-8 items-center gap-1 pr-2 pl-2">
        <span className="min-w-0 flex-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">Incoming</span>
        <IconButton
          label="Add incoming WS-Security configuration"
          data-testid="wss-incoming-add"
          disabled={projectId === undefined}
          onClick={() => {
            if (projectId !== undefined) {
              void addWssIncoming(projectId);
            }
          }}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <ul aria-label="Incoming WS-Security configurations" className="flex flex-col gap-0.5 px-1 pb-2">
        {configs.length === 0 && (
          <li className="px-2 py-1 text-sm text-fg-subtle">
            {projectId === undefined ? 'Select a project to add one.' : 'No incoming configurations yet.'}
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
              Remove incoming configuration?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
              {pendingDelete !== undefined
                ? `"${pendingDelete.name}" is removed from the project, and every request that selected it stops verifying its responses.`
                : 'This cannot be undone.'}
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button>Cancel</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  variant="primary"
                  data-testid="wss-incoming-remove-confirm"
                  onClick={() => {
                    if (pendingDeleteId !== undefined) {
                      void removeWssIncoming(pendingDeleteId);
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
