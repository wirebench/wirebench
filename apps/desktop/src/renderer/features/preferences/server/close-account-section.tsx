/**
 * Server › Close this account (hosted edition spec §22.11; settings split ruling 9): asked with the team's slug typed, held for 14 days while the team
 * keeps working, and cancelled until then. The deletion waits while the subscription is still active, so the page
 * says to cancel it with the payment provider first.
 */
import { useState } from 'react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { CardError, Chip, INPUT, ServerCard } from './server-card.js';
import { formatDate } from './billing-section.js';
import { serverLabel, useServerSettingsStore } from './server-settings-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The days from now until `deletingAt`, at least 0. */
export function daysUntil(deletingAt: string, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(deletingAt) - now) / DAY_MS));
}

/** The banner every Server page shows while a deletion is asked for (spec §22.11). */
export function DeletionBanner() {
  const deletingAt = useServerSettingsStore((s) => s.billing?.deletion?.deletingAt ?? null);
  if (deletingAt === null) return null;
  const days = daysUntil(deletingAt);
  return (
    <div
      role="status"
      data-testid="server-deletion-banner"
      className="mb-5 rounded-lg border border-status-danger/40 bg-status-danger/10 px-4 py-3 text-sm"
    >
      <p className="font-semibold text-status-danger">This account is being closed</p>
      <p className="mt-0.5 text-fg-muted">
        Everything in it is deleted on {formatDate(deletingAt)}, in {String(days)} {days === 1 ? 'day' : 'days'}. A
        server admin can cancel it until then, from Close this account.
      </p>
    </div>
  );
}

export function CloseAccountSection() {
  const url = useServerSettingsStore((s) => s.url) ?? '';
  const billing = useServerSettingsStore((s) => s.billing);
  const deletingAt = useServerSettingsStore((s) => s.billing?.deletion?.deletingAt ?? null);
  const busy = useServerSettingsStore((s) => s.busy.deletion === true);
  const error = useServerSettingsStore((s) => s.errors.deletion);
  const [typed, setTyped] = useState('');
  const [confirming, setConfirming] = useState(false);
  // The slug is the server's own (its billing answer), never guessed from the address: a custom domain says nothing
  // of it. Until it is known, nothing can be confirmed.
  const slug = billing?.slug;
  const name = serverLabel(url, billing);
  const confirmed = slug !== undefined && typed.trim() === slug;

  if (deletingAt !== null) {
    const days = daysUntil(deletingAt);
    return (
      <div data-testid="server-delete">
        <ServerCard
          title="Close this account"
          testId="server-delete-card"
          danger
          chip={<Chip tone="danger">{`In ${String(days)} ${days === 1 ? 'day' : 'days'}`}</Chip>}
          footer={
            <Button
              data-testid="server-delete-cancel"
              disabled={busy}
              onClick={() => void useServerSettingsStore.getState().cancelDeletion()}
            >
              Cancel the deletion
            </Button>
          }
        >
          <p data-testid="server-delete-pending" className="text-sm text-fg-muted">
            {name} is deleted on {formatDate(deletingAt)}. Until then it keeps working, and any server admin can cancel
            the deletion. It waits while the subscription is still active: cancel it in Paddle’s portal first.
          </p>
          <CardError error={error} testId="server-delete-error" />
        </ServerCard>
      </div>
    );
  }

  return (
    <div data-testid="server-delete">
      <ServerCard
        title="Close this account"
        testId="server-delete-card"
        danger
        footer={
          <Button
            variant="danger"
            data-testid="server-delete-request"
            disabled={busy || !confirmed}
            onClick={() => setConfirming(true)}
          >
            Delete in 14 days
          </Button>
        }
      >
        <p className="mb-4 text-sm text-fg-muted">
          Held for 14 days, then every workspace, row, file and secret of {name} is removed and the name is retired.
          Cancel the subscription in Paddle first: the deletion waits while it is active. Export first if you need the
          data.
        </p>
        <label className="flex items-center gap-2 text-sm text-fg-subtle">
          Type <code className="font-mono text-xs text-fg-default">{slug ?? '…'}</code> to confirm
          <input
            data-testid="server-delete-slug"
            disabled={slug === undefined}
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className={`${INPUT} max-w-56 font-mono text-xs`}
          />
        </label>
        <CardError error={error} testId="server-delete-error" />
      </ServerCard>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Close this account?"
        description={`Every server admin is mailed, and ${name} is deleted in 14 days unless someone cancels it.`}
        confirmLabel="Delete in 14 days"
        destructive
        confirmTestId="server-delete-confirm"
        onConfirm={() => {
          setConfirming(false);
          void useServerSettingsStore
            .getState()
            .requestDeletion(typed)
            .then((asked) => {
              if (asked) setTyped('');
            });
        }}
      />
    </div>
  );
}
