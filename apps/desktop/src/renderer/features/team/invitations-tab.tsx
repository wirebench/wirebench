import { Button } from '../../components/button.js';
import { useTeamStore } from '../../state/team.js';
import { ROLE_LABELS } from './roles.js';

/** The Invitations tab (team admins only): open invitations, each with Revoke. Their links are never shown again. */
export function InvitationsTab() {
  const invitations = useTeamStore((state) => state.invitations);
  const revokeInvitation = useTeamStore((state) => state.revokeInvitation);

  return (
    <div data-testid="invitations-tab">
      {invitations.length === 0 ? (
        <p className="text-sm text-fg-subtle">No open invitations.</p>
      ) : (
        <ul className="divide-y divide-hairline">
          {invitations.map((invitation) => (
            <li
              key={invitation.id}
              data-testid={`invitation-row-${invitation.id}`}
              className="flex items-center gap-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg-default">{invitation.email}</div>
                <div className="truncate text-xs text-fg-subtle">
                  {ROLE_LABELS[invitation.role]} · expires {new Date(invitation.expiresAt).toLocaleString()}
                </div>
              </div>
              <Button
                variant="ghost"
                data-testid={`invitation-revoke-${invitation.id}`}
                onClick={() => {
                  void revokeInvitation(invitation.id);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
