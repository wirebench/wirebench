/**
 * *Add people* (settings split spec §3.3): one email and a role. The person is added when they have an account;
 * otherwise this becomes an invitation, and its link is shown here once with Copy (the server keeps only its hash).
 * *New link* reuses the link view for a renewed invitation.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { TeamRoleWire } from '@shared/wire-base.js';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';
import { selectedTeam, useTeamStore, type AddPersonResult } from '../../../state/team.js';
import { INPUT_CLASS, ROLE_LABELS, SELECT_CLASS, TEAM_ROLES } from '../roles.js';

export interface AddPeopleDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** `renewed`: show the store's `lastInvite`, the link *New link* just made. */
  readonly view: 'add' | 'renewed';
}

function LinkView({ url, onDone }: { readonly url: string; readonly onDone: () => void }) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      <input data-testid="add-people-link" aria-label="Invitation link" readOnly className={INPUT_CLASS} value={url} />
      <div className="flex justify-end gap-2">
        <Button
          data-testid="add-people-copy"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => {
              showToast('Invitation link copied');
            });
          }}
        >
          Copy
        </Button>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function AddPeopleDialog({ open, onOpenChange, view }: AddPeopleDialogProps) {
  const addPerson = useTeamStore((s) => s.addPerson);
  const lastInvite = useTeamStore((s) => s.lastInvite);
  const clearLastInvite = useTeamStore((s) => s.clearLastInvite);
  const teamName = useTeamStore((s) => selectedTeam(s)?.name ?? 'the team');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRoleWire>('member');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(AddPersonResult & { readonly email: string }) | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setEmail('');
      setRole('member');
      setBusy(false);
      setResult(undefined);
    } else {
      // A link is shown once: closing drops it.
      clearLastInvite();
    }
  }, [open, clearLastInvite]);

  const submit = async (): Promise<void> => {
    const wanted = email.trim();
    if (busy || wanted.length === 0) return;
    setBusy(true);
    const answer = await addPerson(wanted, role);
    setBusy(false);
    setResult({ ...answer, email: wanted });
  };

  const done = (): void => {
    onOpenChange(false);
  };

  let body;
  if (view === 'renewed') {
    body =
      lastInvite === undefined ? (
        <p className="mt-3 text-sm text-fg-subtle">Making a new link…</p>
      ) : (
        <>
          <p data-testid="add-people-result" className="mt-2 text-sm text-fg-muted">
            A new link for {lastInvite.email}; the old one no longer works. Send them this link; it is shown only now.
          </p>
          <LinkView url={lastInvite.url} onDone={done} />
        </>
      );
  } else if (result?.kind === 'member') {
    body = (
      <>
        <p data-testid="add-people-result" className="mt-2 text-sm text-fg-muted">
          Added {result.email} to {teamName}.
        </p>
        <div className="mt-3 flex justify-end">
          <Button variant="primary" onClick={done}>
            Done
          </Button>
        </div>
      </>
    );
  } else if (result?.kind === 'invited') {
    body = (
      <>
        <p data-testid="add-people-result" className="mt-2 text-sm text-fg-muted">
          No account has that email yet, so this is an invitation. Send them this link; it is shown only now.
        </p>
        <LinkView url={result.invitation.url} onDone={done} />
      </>
    );
  } else {
    body = (
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          data-testid="add-people-email"
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
          data-testid="add-people-role"
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
        {result?.kind === 'failed' && (
          <p role="alert" className="text-sm text-status-danger">
            {result.message}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={done}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" data-testid="add-people-submit" disabled={busy}>
            Add
          </Button>
        </div>
      </form>
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="add-people-dialog"
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 w-[28rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">
            {view === 'renewed' ? 'New invitation link' : `Add people to ${teamName}`}
          </Dialog.Title>
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
