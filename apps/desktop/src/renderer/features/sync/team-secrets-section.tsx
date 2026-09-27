/**
 * The Sync panel's Team secrets section (team-secrets spec §4.2): turning on, who is waiting and who
 * is approved, the fingerprint an admin checks another way before approving, and the values to
 * rotate, ignored, or replaced here. Values never reach this component.
 */
import { useState } from 'react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { SettingsGroup } from '../../components/settings-grid.js';
import { rotateMessage, useTeamSecretsStore } from '../../state/team-secrets.js';
import type { TeamSecretsKeyWire, TeamSecretsUntrustedWire } from '../../../shared/wire-types.js';

const ME_WORDS = {
  unavailable: 'Not available on this machine',
  none: 'Not asked yet',
  pending: 'Waiting for an admin to approve this machine',
  approved: 'Approved',
  removed: 'Removed',
  declined: 'Request declined',
} as const;

/** Why an entry was ignored (team-secrets ruling): a rollback reads differently from an untrusted signer. */
function untrustedReason(entry: TeamSecretsUntrustedWire): string {
  return entry.reason === 'rolled-back'
    ? 'Rolled back: an older copy was put back'
    : 'Not trusted: signed by a key that is not approved';
}

export function TeamSecretsSection() {
  const status = useTeamSecretsStore((state) => state.status);
  const busy = useTeamSecretsStore((state) => state.busy);
  const run = useTeamSecretsStore((state) => state.run);
  const [removing, setRemoving] = useState<TeamSecretsKeyWire | undefined>(undefined);

  if (!status.on) {
    if (!status.canTurnOn && status.message === undefined) {
      return null;
    }
    return (
      <SettingsGroup
        title="Team secrets"
        hint="Share secret values with the people in this workspace, encrypted for each approved machine."
      >
        {status.message !== undefined && (
          <p role="status" data-testid="team-secrets-message" className="mb-2 text-sm text-fg-subtle">
            {status.message}
          </p>
        )}
        {status.canTurnOn && (
          <Button data-testid="team-secrets-turn-on" disabled={busy} onClick={() => void run('turnOn')}>
            Turn on team secrets
          </Button>
        )}
      </SettingsGroup>
    );
  }

  const signed = status.authority === 'signed';
  const admins = status.approved.filter((key) => key.admin);
  const former = new Set(status.formerMembers);

  return (
    <SettingsGroup title="Team secrets">
      <p role="status" data-testid="team-secrets-me" className="mb-2 text-sm text-fg-default">
        This machine: {ME_WORDS[status.me.state]}
        {status.me.fingerprint !== undefined && (
          <>
            {' · fingerprint '}
            <span className="font-mono">{status.me.fingerprint}</span>
          </>
        )}
      </p>
      {status.message !== undefined && (
        <p role="status" data-testid="team-secrets-message" className="mb-2 text-sm text-fg-subtle">
          {status.message}
        </p>
      )}
      {(status.me.state === 'removed' || status.me.state === 'declined') && (
        <Button data-testid="team-secrets-request-access" disabled={busy} onClick={() => void run('requestAccess')}>
          Ask for access again
        </Button>
      )}

      {status.canManage && signed && admins.length === 1 && admins[0]?.mine === true && (
        <p data-testid="team-secrets-single-admin" className="mb-2 text-sm text-status-warning">
          You are the only admin. Make someone else an admin too, so the team keeps access if this machine is lost.
        </p>
      )}

      {status.canManage && status.pending.length > 0 && (
        <>
          <p data-testid="team-secrets-fingerprint-note" className="mb-1 text-sm text-fg-subtle">
            Before approving, check the fingerprint with the person another way — a call or in person.
          </p>
          <ul className="mb-2 flex flex-col gap-1">
            {status.pending.map((key) => (
              <li
                key={key.keyId}
                data-testid="team-secrets-pending-row"
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span className="min-w-0 truncate" title={key.email}>
                  {key.name} · {key.machine} · <span className="font-mono">{key.fingerprint}</span>
                </span>
                <span className="flex gap-1">
                  <Button
                    data-testid="team-secrets-approve"
                    aria-label={`Approve ${key.name} (${key.machine})`}
                    disabled={busy}
                    onClick={() => void run('approve', key.keyId)}
                  >
                    Approve
                  </Button>
                  <Button
                    data-testid="team-secrets-decline"
                    aria-label={`Decline ${key.name} (${key.machine})`}
                    disabled={busy}
                    onClick={() => void run('decline', key.keyId)}
                  >
                    Decline
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      <ul className="mb-2 flex flex-col gap-1">
        {status.approved.map((key) => (
          <li
            key={key.keyId}
            data-testid="team-secrets-member-row"
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="min-w-0 truncate" title={key.email}>
              {key.name} · {key.machine}
              {key.admin && ' · admin'}
              {key.mine && ' · this machine'}
              {former.has(key.keyId) && ' · no longer in the workspace'}
            </span>
            {status.canManage && !key.mine && (
              <span className="flex gap-1">
                {signed && (
                  <Button
                    data-testid={key.admin ? 'team-secrets-revoke-admin' : 'team-secrets-grant-admin'}
                    aria-label={key.admin ? `Remove admin from ${key.name}` : `Make ${key.name} an admin`}
                    disabled={busy}
                    onClick={() => void run(key.admin ? 'revokeAdmin' : 'grantAdmin', key.keyId)}
                  >
                    {key.admin ? 'Remove admin' : 'Make admin'}
                  </Button>
                )}
                <Button
                  data-testid="team-secrets-remove"
                  aria-label={`Remove ${key.name} (${key.machine})`}
                  disabled={busy}
                  onClick={() => setRemoving(key)}
                >
                  Remove
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {status.rotate.length > 0 && (
        <ul className="mb-2 flex flex-col gap-1">
          {status.rotate.map((mark) => (
            <li key={mark.entryId} data-testid="team-secrets-rotate-row" className="text-sm text-status-warning">
              {rotateMessage(mark.label, mark.removedNames)}
            </li>
          ))}
        </ul>
      )}

      {status.untrusted.map((entry) => (
        <p key={entry.entryId} data-testid="team-secrets-untrusted-row" className="text-sm text-fg-subtle">
          {entry.label} — {untrustedReason(entry)}
        </p>
      ))}

      {status.replaced.map((notice) => (
        <div
          key={notice.entryId}
          data-testid="team-secrets-replaced-row"
          className="flex items-center justify-between gap-2 text-sm"
        >
          <span>
            Your change to {notice.label} was replaced by {notice.byName}'s newer value.
          </span>
          <span className="flex gap-1">
            <Button
              data-testid="team-secrets-restore"
              disabled={busy}
              onClick={() => void run('restoreMine', notice.entryId)}
            >
              Restore my value
            </Button>
            <Button
              data-testid="team-secrets-dismiss"
              disabled={busy}
              onClick={() => void run('dismissReplaced', notice.entryId)}
            >
              Keep theirs
            </Button>
          </span>
        </div>
      ))}

      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title={`Remove ${removing?.name ?? ''} from team secrets?`}
        description="Their machine stops receiving values. Values they could already read are marked Rotate: change them where they are issued."
        confirmLabel="Remove"
        destructive
        confirmTestId="team-secrets-remove-confirm"
        onConfirm={() => {
          const key = removing;
          setRemoving(undefined);
          if (key !== undefined) void run('remove', key.keyId);
        }}
      />
    </SettingsGroup>
  );
}
