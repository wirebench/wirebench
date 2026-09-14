/**
 * "Edit endpoints…": the interface's addressable endpoints, managed in one place — add, rename
 * or re-address, delete (with a confirmation, since requests may point at it), and choose the
 * one requests fall back to. Every change goes through a project mutation in main; nothing is
 * edited locally.
 */

import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, X } from 'lucide-react';
import { AuthFields, asSoapAuth, SOAP_AUTH_TYPES } from '../../components/auth-fields.js';
import { TRUST_INVALID_HINT, TrustInvalidBadge } from '../../components/trust-invalid-badge.js';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { useProjectStore } from '../../state/project.js';
import type { EndpointWire } from '../../../shared/wire-types.js';

export interface EndpointsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly interfaceId: string;
}

interface DraftEndpoint {
  readonly name: string;
  readonly url: string;
}

const EMPTY: DraftEndpoint = { name: '', url: '' };

function report(error: unknown, fallback: string): void {
  showToast(error instanceof Error ? error.message : fallback);
}

/** Lists and edits one interface's endpoints. */
export function EndpointsDialog({ open, onOpenChange, interfaceId }: EndpointsDialogProps) {
  const iface = useProjectStore((state) => state.interfaces[interfaceId]);
  const addEndpoint = useProjectStore((state) => state.addEndpoint);
  const updateEndpoint = useProjectStore((state) => state.updateEndpoint);
  const removeEndpoint = useProjectStore((state) => state.removeEndpoint);
  const setDefaultEndpoint = useProjectStore((state) => state.setDefaultEndpoint);
  const updateEndpointAuth = useProjectStore((state) => state.updateEndpointAuth);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<DraftEndpoint>(EMPTY);
  const [adding, setAdding] = useState<DraftEndpoint>(EMPTY);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined);

  const endpoints: readonly EndpointWire[] = iface?.endpoints ?? [];

  const startEditing = (endpoint: EndpointWire): void => {
    setEditingId(endpoint.id);
    setDraft({ name: endpoint.name, url: endpoint.url });
  };

  const commitEdit = (endpointId: string): void => {
    setEditingId(undefined);
    void updateEndpoint(interfaceId, endpointId, { name: draft.name.trim(), url: draft.url.trim() }).catch(
      (error: unknown) => report(error, 'Could not update the endpoint'),
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 flex max-h-[34rem] w-[40rem] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-md font-medium text-fg-default">
              Endpoints — {iface?.name ?? 'Interface'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="text-fg-subtle hover:text-fg-default">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <ul aria-label="Endpoints" className="mt-3 min-h-0 flex-1 overflow-auto">
            {endpoints.length === 0 && <li className="py-2 text-sm text-fg-subtle">No endpoints yet.</li>}
            {endpoints.map((endpoint) => (
              <li key={endpoint.id} className="flex flex-col gap-2 border-b border-hairline py-2">
                {editingId === endpoint.id ? (
                  <>
                    <div className="flex items-center gap-2">
                      <input
                        aria-label="Endpoint name"
                        value={draft.name}
                        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                        className="h-row w-40 rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default"
                      />
                      <input
                        aria-label="Endpoint URL"
                        value={draft.url}
                        onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                        className="h-row min-w-0 flex-1 rounded-md border border-hairline bg-surface-base px-2 font-mono text-sm text-fg-default"
                      />
                      <Button variant="primary" onClick={() => commitEdit(endpoint.id)}>
                        Save
                      </Button>
                    </div>
                    <label className="flex items-center gap-2">
                      <span className="w-28 shrink-0 text-xs text-fg-subtle">Auth mode</span>
                      <select
                        aria-label="Auth mode"
                        value={endpoint.authMode}
                        onChange={(event) => {
                          void updateEndpoint(interfaceId, endpoint.id, {
                            authMode: event.target.value as 'override' | 'complement',
                          }).catch((error: unknown) => report(error, 'Could not update the endpoint'));
                        }}
                        className="h-row w-full min-w-0 rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default"
                      >
                        <option value="override">Override</option>
                        <option value="complement">Complement</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2">
                      <span className="w-28 shrink-0 text-xs text-fg-subtle">Trust invalid</span>
                      <input
                        type="checkbox"
                        aria-label="Trust invalid certificates"
                        data-testid="endpoint-trust-invalid"
                        checked={endpoint.trustInvalid === true}
                        onChange={(event) => {
                          void updateEndpoint(interfaceId, endpoint.id, {
                            trustInvalid: event.target.checked,
                          }).catch((error: unknown) => report(error, 'Could not update the endpoint'));
                        }}
                      />
                      <span className="text-xs text-status-danger">{TRUST_INVALID_HINT}</span>
                    </label>
                    <AuthFields
                      types={SOAP_AUTH_TYPES}
                      scope="Endpoint"
                      auth={endpoint.auth}
                      onChange={(auth) => {
                        void updateEndpointAuth(interfaceId, endpoint.id, asSoapAuth(auth)).catch((error: unknown) =>
                          report(error, 'Could not update the endpoint credentials'),
                        );
                      }}
                    />
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="flex w-5 justify-center text-accent" aria-hidden="true">
                      {iface?.defaultEndpointId === endpoint.id ? <Check size={14} /> : null}
                    </span>
                    <span className="w-40 shrink-0 truncate text-sm text-fg-default">{endpoint.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-muted">{endpoint.url}</span>
                    {endpoint.trustInvalid === true && <TrustInvalidBadge />}
                    <Button
                      onClick={() => {
                        void setDefaultEndpoint(interfaceId, endpoint.id).catch((error: unknown) =>
                          report(error, 'Could not set the default endpoint'),
                        );
                      }}
                      disabled={iface?.defaultEndpointId === endpoint.id}
                    >
                      Set default
                    </Button>
                    <Button onClick={() => startEditing(endpoint)}>Edit</Button>
                    {confirmDeleteId === endpoint.id ? (
                      <Button
                        variant="primary"
                        aria-label={`Confirm delete ${endpoint.name}`}
                        onClick={() => {
                          setConfirmDeleteId(undefined);
                          void removeEndpoint(interfaceId, endpoint.id).catch((error: unknown) =>
                            report(error, 'Could not delete the endpoint'),
                          );
                        }}
                      >
                        Confirm
                      </Button>
                    ) : (
                      <Button onClick={() => setConfirmDeleteId(endpoint.id)}>Delete</Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-3 flex items-center gap-2">
            <input
              aria-label="New endpoint name"
              placeholder="Name"
              value={adding.name}
              onChange={(event) => setAdding({ ...adding, name: event.target.value })}
              className="h-row w-40 rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default"
            />
            <input
              aria-label="New endpoint URL"
              placeholder="https://host/path"
              value={adding.url}
              onChange={(event) => setAdding({ ...adding, url: event.target.value })}
              className="h-row min-w-0 flex-1 rounded-md border border-hairline bg-surface-base px-2 font-mono text-sm text-fg-default"
            />
            <Button
              variant="primary"
              disabled={adding.url.trim().length === 0}
              onClick={() => {
                const next = { name: adding.name.trim(), url: adding.url.trim() };
                setAdding(EMPTY);
                void addEndpoint(interfaceId, next.name.length > 0 ? next.name : next.url, next.url).catch(
                  (error: unknown) => report(error, 'Could not add the endpoint'),
                );
              }}
            >
              Add
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
