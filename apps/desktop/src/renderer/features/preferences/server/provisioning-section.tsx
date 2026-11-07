/**
 * Server › Provisioning (hosted edition spec §22.13; saml-scim spec §3.7): the SCIM base URL and its tokens. A new
 * token is shown once, with Copy; then only its name remains. The groups and their teams stay in *Manage team…*.
 */
import { useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { useProvisioningStore } from '../../../state/provisioning.js';
import { CardError, Chip, CopyValue, FieldGrid, FieldLabel, INPUT, MONO_INPUT, ServerCard } from './server-card.js';
import { useServerSettingsStore } from './server-settings-store.js';

const usedText = (iso: string | null): string =>
  iso === null ? 'never used' : `last used ${new Date(iso).toLocaleString()}`;

export function ProvisioningSection() {
  const url = useServerSettingsStore((s) => s.url) ?? '';
  const store = useProvisioningStore();
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<{ readonly id: string; readonly name: string } | undefined>(undefined);

  useEffect(() => {
    if (url !== '') void useProvisioningStore.getState().load(url);
    return () => {
      useProvisioningStore.getState().reset();
    };
  }, [url]);

  if (store.errorCode === 'licensing-feature-required') {
    return (
      <ServerCard title="SCIM" testId="server-scim" chip={<Chip>Enterprise</Chip>}>
        <p data-testid="server-scim-unlicensed" className="text-sm text-fg-subtle">
          Provisioning people and groups from an identity provider needs the Enterprise edition.
        </p>
      </ServerCard>
    );
  }

  const create = async (): Promise<void> => {
    if (name.trim() === '') return;
    if (await useProvisioningStore.getState().createToken(url, name)) setName('');
  };

  return (
    <div data-testid="server-provisioning">
      <ServerCard
        title="SCIM"
        testId="server-scim"
        chip={
          <Chip tone={store.tokens.length === 0 ? 'neutral' : 'ok'}>
            {store.tokens.length === 0 ? 'No tokens' : `${String(store.tokens.length)} active`}
          </Chip>
        }
      >
        <FieldGrid>
          <FieldLabel>Base URL</FieldLabel>
          <CopyValue testId="server-scim-base" value={store.info?.scimBaseUrl ?? `${url}/scim/v2`} />
        </FieldGrid>
        {store.created !== undefined && (
          <div
            data-testid="server-scim-created"
            className="mt-4 flex flex-col gap-2 rounded-md border border-hairline p-3"
          >
            <p className="text-sm text-fg-default">
              Copy the token for “{store.created.name}” now. It will not be shown again.
            </p>
            <div className="flex gap-2">
              <input
                data-testid="server-scim-token-value"
                aria-label="New SCIM token"
                readOnly
                value={store.created.token}
                onFocus={(event) => event.currentTarget.select()}
                className={MONO_INPUT}
              />
              <Button onClick={() => void navigator.clipboard.writeText(store.created?.token ?? '')}>Copy</Button>
              <Button data-testid="server-scim-created-done" onClick={store.dismissCreated}>
                Done
              </Button>
            </div>
          </div>
        )}
        <ul className="mt-4 divide-y divide-hairline">
          {store.tokens.map((token) => (
            <li key={token.id} data-testid="server-scim-token" className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-fg-default">{token.name}</p>
                <p className="text-xs text-fg-subtle">
                  created {new Date(token.createdAt).toLocaleDateString()} · {usedText(token.lastUsedAt)}
                </p>
              </div>
              <Button
                data-testid="server-scim-revoke"
                aria-label={`Revoke ${token.name}`}
                onClick={() => setRevoking({ id: token.id, name: token.name })}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            data-testid="server-scim-name"
            aria-label="Token name"
            maxLength={64}
            placeholder="Token name, e.g. identity-provider"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={INPUT}
          />
          <Button type="submit" data-testid="server-scim-create" disabled={store.busy || name.trim() === ''}>
            Create token
          </Button>
        </form>
        <CardError
          error={store.errorCode === 'licensing-feature-required' ? undefined : store.error}
          testId="server-scim-error"
        />
      </ServerCard>
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        title="Revoke SCIM token"
        description={`The identity provider using “${revoking?.name ?? ''}” stops provisioning at once.`}
        confirmLabel="Revoke"
        destructive
        confirmTestId="server-scim-revoke-confirm"
        onConfirm={() => {
          if (revoking !== undefined) void useProvisioningStore.getState().revokeToken(url, revoking.id);
          setRevoking(undefined);
        }}
      />
    </div>
  );
}
