import { useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useProvisioningStore } from '../../state/provisioning.js';
import { INPUT_CLASS, SELECT_CLASS } from './roles.js';

const NOT_LINKED = '';

function CopyRow({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}) {
  return (
    <>
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <span data-testid={testId} className="truncate font-mono text-xs">
          {value}
        </span>
        <Button
          variant="ghost"
          data-testid={`${testId}-copy`}
          aria-label={`Copy ${label}`}
          onClick={() => void navigator.clipboard.writeText(value)}
        >
          Copy
        </Button>
      </dd>
    </>
  );
}

/**
 * The Provisioning tab (saml-scim spec §3.7), for server admins: the SCIM base URL and tokens, the SAML
 * details to give the identity provider, and the SCIM groups with a team picker each. Without the
 * Enterprise feature the server answers `licensing-feature-required` and only a note is shown.
 */
export function ProvisioningTab({
  url,
  teams,
}: {
  readonly url: string;
  readonly teams: readonly { readonly id: string; readonly name: string }[];
}) {
  const store = useProvisioningStore();
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<{ id: string; name: string } | undefined>(undefined);

  useEffect(() => {
    void useProvisioningStore.getState().load(url);
    return () => {
      useProvisioningStore.getState().reset();
    };
  }, [url]);

  if (store.errorCode === 'licensing-feature-required') {
    return (
      <div data-testid="provisioning-tab" className="flex flex-col gap-3 text-sm">
        <p data-testid="provisioning-gated" role="status">
          SAML sign-in and SCIM provisioning are Enterprise features. Install an Enterprise license to set them up.
        </p>
      </div>
    );
  }

  const create = async (): Promise<void> => {
    if (name.trim().length === 0) return;
    if (await store.createToken(url, name)) setName('');
  };

  return (
    <div data-testid="provisioning-tab" className="flex flex-col gap-5 text-sm">
      <div className="flex justify-end">
        <Button variant="ghost" data-testid="provisioning-refresh" onClick={() => void store.load(url)}>
          Refresh
        </Button>
      </div>
      {store.error !== undefined && (
        <p data-testid="provisioning-error" role="alert" className="text-xs text-status-danger">
          {store.error}
        </p>
      )}

      <section aria-labelledby="provisioning-scim" className="flex flex-col gap-2">
        <h3 id="provisioning-scim" className="font-medium text-fg-default">
          SCIM
        </h3>
        {store.info !== undefined && (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
            <CopyRow label="Base URL" value={store.info.scimBaseUrl} testId="provisioning-scim-url" />
          </dl>
        )}
        <table data-testid="provisioning-tokens" className="w-full text-left">
          <thead className="text-xs text-fg-subtle">
            <tr>
              <th className="font-normal">Name</th>
              <th className="font-normal">Created</th>
              <th className="font-normal">Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {store.tokens.map((token) => (
              <tr key={token.id} data-testid={`provisioning-token-${token.id}`}>
                <td>{token.name}</td>
                <td>{token.createdAt.slice(0, 10)}</td>
                <td>{token.lastUsedAt?.slice(0, 16).replace('T', ' ') ?? 'Never'}</td>
                <td className="text-right">
                  <Button
                    variant="ghost"
                    data-testid={`provisioning-revoke-${token.id}`}
                    disabled={store.busy}
                    onClick={() => {
                      setRevoking({ id: token.id, name: token.name });
                    }}
                  >
                    Revoke…
                  </Button>
                </td>
              </tr>
            ))}
            {store.loaded && store.tokens.length === 0 && (
              <tr>
                <td colSpan={4} className="text-fg-subtle">
                  No SCIM tokens yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {store.created !== undefined ? (
          <div data-testid="provisioning-created" className="flex flex-col gap-2 rounded border border-hairline p-2">
            <p>Give this token to the identity provider now. It is not shown again.</p>
            <div className="flex items-center gap-2">
              <input
                data-testid="provisioning-created-token"
                aria-label="New SCIM token"
                readOnly
                className={`${INPUT_CLASS} flex-1 font-mono text-xs`}
                value={store.created.token}
              />
              <Button
                data-testid="provisioning-created-copy"
                onClick={() => void navigator.clipboard.writeText(store.created?.token ?? '')}
              >
                Copy
              </Button>
              <Button variant="primary" data-testid="provisioning-created-done" onClick={store.dismissCreated}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <input
              data-testid="provisioning-token-name"
              aria-label="Token name"
              placeholder="Identity provider"
              maxLength={64}
              className={`${INPUT_CLASS} flex-1`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <Button
              type="submit"
              variant="primary"
              data-testid="provisioning-token-create"
              disabled={store.busy || name.trim().length === 0}
            >
              Create token
            </Button>
          </form>
        )}
      </section>

      <section aria-labelledby="provisioning-saml" className="flex flex-col gap-2">
        <h3 id="provisioning-saml" className="font-medium text-fg-default">
          SAML
        </h3>
        {store.info !== undefined && (
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
            <dt className="text-fg-subtle">Sign-in</dt>
            <dd data-testid="provisioning-saml-configured">
              {store.info.configured ? 'Configured' : 'Not configured on this server'}
            </dd>
            {store.info.idpEntityId !== undefined && (
              <>
                <dt className="text-fg-subtle">IdP entity ID</dt>
                <dd data-testid="provisioning-idp-entity-id" className="truncate font-mono text-xs">
                  {store.info.idpEntityId}
                </dd>
              </>
            )}
            <CopyRow label="ACS URL" value={store.info.acsUrl} testId="provisioning-acs-url" />
            <CopyRow label="Entity ID" value={store.info.entityId} testId="provisioning-entity-id" />
          </dl>
        )}
      </section>

      <section aria-labelledby="provisioning-groups" className="flex flex-col gap-2">
        <h3 id="provisioning-groups" className="font-medium text-fg-default">
          Groups
        </h3>
        <p className="text-xs text-fg-subtle">
          Members of a linked group join its team as members. SCIM removes only the people it added.
        </p>
        <ul data-testid="provisioning-groups-list" className="flex flex-col gap-1">
          {store.groups.map((group) => (
            <li key={group.id} data-testid={`provisioning-group-${group.id}`} className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <span className="flex-1 truncate">{group.displayName}</span>
                <span className="text-xs text-fg-subtle">
                  {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
                </span>
                <select
                  data-testid={`provisioning-group-team-${group.id}`}
                  aria-label={`Team for ${group.displayName}`}
                  className={SELECT_CLASS}
                  value={group.team?.id ?? NOT_LINKED}
                  onChange={(event) => {
                    const value = event.target.value;
                    void store.linkGroup(url, group.id, value === NOT_LINKED ? null : value);
                  }}
                >
                  <option value={NOT_LINKED}>Not linked</option>
                  {group.team !== null && !teams.some((team) => team.id === group.team?.id) && (
                    <option value={group.team.id}>{group.team.name}</option>
                  )}
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>
              {store.groupErrors[group.id] !== undefined && (
                <p
                  data-testid={`provisioning-group-error-${group.id}`}
                  role="alert"
                  className="text-xs text-status-danger"
                >
                  {store.groupErrors[group.id]}
                </p>
              )}
            </li>
          ))}
          {store.loaded && store.groups.length === 0 && (
            <li className="text-fg-subtle">The identity provider has not sent any groups yet.</li>
          )}
        </ul>
      </section>

      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        title={`Revoke ${revoking?.name ?? 'token'}?`}
        description="The identity provider can no longer provision with it. Users and groups it created stay."
        confirmLabel="Revoke token"
        destructive
        testId="provisioning-revoke-confirm"
        confirmTestId="provisioning-revoke-confirm-button"
        onConfirm={() => {
          if (revoking !== undefined) void store.revokeToken(url, revoking.id);
        }}
      />
    </div>
  );
}
