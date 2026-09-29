/**
 * Preferences → Devices & tokens (callback-assertion §5): the open server workspace's CI tokens —
 * read-only, workspace-scoped credentials for `wirebench run` in a pipeline. Editors and admins
 * create and revoke them; a new token is shown once, with Copy, and then only its name remains.
 */
import { useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { SettingsGroup } from '../../../components/settings-grid.js';
import { showToast } from '../../../components/toast.js';
import { CI_TOKEN_NAME_MAX, useCiTokensStore } from '../../../state/ci-tokens.js';
import { useSyncStore } from '../../../state/sync.js';
import { useWebhooksStore } from '../../../state/webhooks.js';

/** The look of `settings-grid`'s text controls. */
const INPUT =
  'h-row min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

function usedText(iso: string | null): string {
  return iso === null ? 'never used' : `last used ${new Date(iso).toLocaleString()}`;
}

export function TokensSection() {
  const server = useWebhooksStore((state) => state.server);
  const role = useSyncStore((state) => state.status.role);
  const tokens = useCiTokensStore((state) => state.tokens);
  const loaded = useCiTokensStore((state) => state.loaded);
  const error = useCiTokensStore((state) => state.error);
  const created = useCiTokensStore((state) => state.created);
  const load = useCiTokensStore((state) => state.load);
  const create = useCiTokensStore((state) => state.create);
  const revoke = useCiTokensStore((state) => state.revoke);
  const dismissCreated = useCiTokensStore((state) => state.dismissCreated);
  const reset = useCiTokensStore((state) => state.reset);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<{ readonly id: string; readonly name: string } | undefined>(undefined);
  const canManage = role === 'editor' || role === 'admin';
  const url = server?.url;
  const workspaceId = server?.workspaceId;

  useEffect(() => {
    if (url !== undefined && workspaceId !== undefined && canManage) void load({ url, workspaceId });
    // Leaving the section, or the workspace, drops the list and any new token's value with it.
    return () => reset();
  }, [url, workspaceId, canManage, load, reset]);

  if (server === undefined) {
    return (
      <p data-testid="tokens-unlinked" className="text-sm text-fg-subtle">
        CI tokens belong to a workspace on a Wirebench Server. Open a server workspace to manage them.
      </p>
    );
  }
  if (!canManage) {
    return (
      <p data-testid="tokens-read-only" className="text-sm text-fg-subtle">
        Only editors and admins of this workspace can see and create CI tokens.
      </p>
    );
  }

  const submit = async (): Promise<void> => {
    if (name.trim() === '') return;
    if (await create(server, name)) {
      setNaming(false);
      setName('');
    }
  };

  return (
    <div data-testid="tokens-section">
      <SettingsGroup
        title="CI tokens"
        hint="Read-only tokens for checking callbacks from a pipeline. They read this workspace's catch URLs and nothing else."
      >
        {error !== undefined && (
          <p role="alert" className="mb-2 text-sm text-status-danger">
            {error}
          </p>
        )}
        {created !== undefined && (
          <div
            data-testid="ci-token-created"
            className="mb-2 flex flex-col gap-1 rounded-md border border-hairline p-2"
          >
            <p className="text-sm text-fg-default">
              Copy the token for “{created.name}” now. It will not be shown again.
            </p>
            <div className="flex gap-2">
              <input
                data-testid="ci-token-value"
                aria-label="New CI token"
                readOnly
                value={created.token}
                className={`${INPUT} flex-1 font-mono text-xs`}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                data-testid="ci-token-copy"
                onClick={() => {
                  void navigator.clipboard.writeText(created.token).then(
                    () => showToast('Token copied.'),
                    () => showToast('Could not copy the token. Select it and copy it by hand.'),
                  );
                }}
              >
                Copy
              </Button>
              <Button data-testid="ci-token-done" onClick={dismissCreated}>
                Done
              </Button>
            </div>
          </div>
        )}
        {loaded && tokens.length === 0 ? (
          <p className="mb-2 text-sm text-fg-subtle">No CI tokens yet.</p>
        ) : (
          <ul className="mb-2 divide-y divide-hairline">
            {tokens.map((token) => (
              <li key={token.id} data-testid="ci-token-row" className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg-default">{token.name}</p>
                  <p className="text-xs text-fg-subtle">
                    {token.createdBy ?? 'a former member'} · {usedText(token.lastUsedAt)}
                  </p>
                </div>
                <Button
                  data-testid="ci-token-revoke"
                  aria-label={`Revoke ${token.name}`}
                  onClick={() => setRevoking({ id: token.id, name: token.name })}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {naming ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <input
              data-testid="ci-token-name"
              aria-label="Token name"
              autoFocus
              maxLength={CI_TOKEN_NAME_MAX}
              placeholder="pipeline-main"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={`${INPUT} flex-1`}
            />
            <Button data-testid="ci-token-create-submit" type="submit" disabled={name.trim() === ''}>
              Create
            </Button>
          </form>
        ) : (
          <Button data-testid="ci-token-create" onClick={() => setNaming(true)}>
            Create CI token…
          </Button>
        )}
      </SettingsGroup>
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        title="Revoke CI token"
        description={`Pipelines using “${revoking?.name ?? ''}” stop checking callbacks at once. This cannot be undone.`}
        confirmLabel="Revoke"
        destructive
        confirmTestId="ci-token-revoke-confirm"
        onConfirm={() => {
          if (revoking !== undefined) void revoke(server, revoking.id);
          setRevoking(undefined);
        }}
      />
    </div>
  );
}
