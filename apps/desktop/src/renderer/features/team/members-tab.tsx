import { useState } from 'react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useAccountStore } from '../../state/account.js';
import { selectedTeam, useTeamStore } from '../../state/team.js';
import type { TeamMemberWire, TeamRoleWire } from '../../../shared/wire-types.js';
import { InviteDialog } from './invite-dialog.js';
import { INPUT_CLASS, ROLE_LABELS, SELECT_CLASS, TEAM_ROLES } from './roles.js';

/** The Members tab: everyone on the team with their team role, and for admins the controls to change that. */
export function MembersTab() {
  const store = useTeamStore();
  const team = selectedTeam(store);
  const myId = useAccountStore((state) => state.servers.find((server) => server.url === store.url)?.userId);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRoleWire>('member');
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<TeamMemberWire | undefined>(undefined);
  const isAdmin = team?.myRole === 'admin';
  const leaving = removing !== undefined && removing.userId === myId;

  const submitAdd = async (): Promise<void> => {
    if (email.trim().length === 0) return;
    if (await store.addMember(email.trim(), role)) {
      setAdding(false);
      setEmail('');
      setRole('member');
    }
  };

  const roleOptions = TEAM_ROLES.map((option) => (
    <option key={option} value={option}>
      {ROLE_LABELS[option]}
    </option>
  ));

  return (
    <div data-testid="members-tab" className="flex flex-col gap-3">
      <ul className="divide-y divide-hairline">
        {store.members.map((member) => {
          const self = member.userId === myId;
          return (
            <li
              key={member.userId}
              data-testid={`member-row-${member.userId}`}
              className="flex items-center gap-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-fg-default">
                  {member.displayName}
                  {member.disabled && <span className="ml-2 text-xs text-fg-faint">disabled</span>}
                </div>
                <div className="truncate text-xs text-fg-subtle">{member.email}</div>
              </div>
              {isAdmin ? (
                <select
                  data-testid={`member-role-${member.userId}`}
                  aria-label={`Role of ${member.email}`}
                  className={SELECT_CLASS}
                  value={member.role}
                  onChange={(event) => {
                    void store.setMemberRole(member.userId, event.target.value as TeamRoleWire);
                  }}
                >
                  {roleOptions}
                </select>
              ) : (
                <span className="text-sm text-fg-muted">{ROLE_LABELS[member.role]}</span>
              )}
              {(isAdmin || self) && (
                <Button
                  variant="ghost"
                  data-testid={`member-remove-${member.userId}`}
                  onClick={() => {
                    setRemoving(member);
                  }}
                >
                  {self ? 'Leave' : 'Remove'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {isAdmin &&
        (adding ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAdd();
            }}
          >
            <input
              data-testid="member-add-email"
              aria-label="Email of an existing user"
              placeholder="Email of an existing user"
              autoFocus
              className={`${INPUT_CLASS} flex-1`}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
            <select
              data-testid="member-add-role"
              aria-label="Role"
              className={SELECT_CLASS}
              value={role}
              onChange={(event) => {
                setRole(event.target.value as TeamRoleWire);
              }}
            >
              {roleOptions}
            </select>
            <Button type="submit" variant="primary" data-testid="member-add-submit">
              Add
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex gap-2">
            <Button
              data-testid="member-add"
              onClick={() => {
                setAdding(true);
              }}
            >
              Add member…
            </Button>
            <Button
              data-testid="member-invite"
              onClick={() => {
                setInviting(true);
              }}
            >
              Invite…
            </Button>
          </div>
        ))}

      <InviteDialog open={inviting} onOpenChange={setInviting} />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(next) => {
          if (!next) setRemoving(undefined);
        }}
        title={leaving ? `Leave ${team?.name ?? 'the team'}?` : `Remove ${removing?.email ?? ''}?`}
        description="Access to the team's workspaces goes too. A team always keeps at least one admin."
        confirmLabel={leaving ? 'Leave' : 'Remove'}
        destructive
        testId="member-remove-confirm"
        confirmTestId="member-remove-confirm-ok"
        onConfirm={() => {
          if (removing !== undefined) void store.removeMember(removing.userId);
        }}
      />
    </div>
  );
}
