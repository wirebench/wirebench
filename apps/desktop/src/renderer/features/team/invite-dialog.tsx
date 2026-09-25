import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { useTeamStore } from '../../state/team.js';
import type { TeamRoleWire } from '../../../shared/wire-types.js';
import { INPUT_CLASS, ROLE_LABELS, SELECT_CLASS, TEAM_ROLES } from './roles.js';

export interface InviteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * *Invite…* (teams-access §3.5): an email and a team role. The returned link is shown here once, with
 * Copy, and the store drops it when the dialog closes; the server keeps only its hash.
 */
export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const invite = useTeamStore((state) => state.invite);
  const lastInvite = useTeamStore((state) => state.lastInvite);
  const clearLastInvite = useTeamStore((state) => state.clearLastInvite);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRoleWire>('member');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setEmail('');
      setRole('member');
      setBusy(false);
    } else {
      clearLastInvite();
    }
  }, [open, clearLastInvite]);

  const submit = async (): Promise<void> => {
    if (busy || email.trim().length === 0) return;
    setBusy(true);
    await invite(email.trim(), role);
    setBusy(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="invite-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Invite to the team</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            {lastInvite === undefined
              ? 'The invitation link is shown once. Send it to them yourself.'
              : `Send this link to ${lastInvite.email}. It is shown only now, and expires ${new Date(lastInvite.expiresAt).toLocaleString()}.`}
          </Dialog.Description>
          {lastInvite === undefined ? (
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <input
                data-testid="invite-email"
                aria-label="Email"
                placeholder="Email"
                autoFocus
                className={INPUT_CLASS}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
              />
              <select
                data-testid="invite-role"
                aria-label="Role"
                className={SELECT_CLASS}
                value={role}
                onChange={(event) => {
                  setRole(event.target.value as TeamRoleWire);
                }}
              >
                {TEAM_ROLES.map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABELS[option]}
                  </option>
                ))}
              </select>
              <div className="mt-2 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    onOpenChange(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" data-testid="invite-submit" disabled={busy}>
                  Create invitation
                </Button>
              </div>
            </form>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              <input
                data-testid="invite-link"
                aria-label="Invitation link"
                readOnly
                className={INPUT_CLASS}
                value={lastInvite.url}
              />
              <div className="flex justify-end gap-2">
                <Button
                  data-testid="invite-copy"
                  onClick={() => {
                    void navigator.clipboard.writeText(lastInvite.url).then(() => {
                      showToast('Invitation link copied');
                    });
                  }}
                >
                  Copy
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    onOpenChange(false);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
