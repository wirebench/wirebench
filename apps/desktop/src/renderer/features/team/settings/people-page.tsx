/**
 * People (settings split spec §3.3): every member, then every open invitation, in one list with All / Joined /
 * Waiting filters and a search. A team admin changes roles, removes people, adds people and renews or revokes
 * invitations; anyone can leave. The server checks each change again, and a refusal shows on its row.
 */
import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Ellipsis, Mail, Search, UserPlus } from 'lucide-react';
import type { TeamMemberWire, TeamRoleWire } from '@shared/wire-base.js';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { PersonAvatar } from '../../../components/person-avatar.js';
import { accountOnServer, useAccountStore } from '../../../state/account.js';
import { useLicenseStore } from '../../../state/license.js';
import { selectedTeam, useTeamStore } from '../../../state/team.js';
import { INPUT_CLASS, ROLE_LABELS, SELECT_CLASS, TEAM_ROLES } from '../roles.js';
import { AddPeopleDialog } from './add-people-dialog.js';
import { filterPeople, peopleCounts, peopleRows, type PeopleFilter } from './people.js';
import { useServerPeople } from './two-factor-people.js';
import { ipc } from '../../../state/ipc-client.js';
import { showToast } from '../../../components/toast.js';
import { ProfileCard } from './profile-card.js';

const FILTER_LABELS: Readonly<Record<PeopleFilter, string>> = { all: 'All', joined: 'Joined', waiting: 'Waiting' };

function days(count: number): string {
  return count === 1 ? '1 day' : `${String(count)} days`;
}

function SeatLine({ url }: { readonly url: string }) {
  const seats = useLicenseStore((s) => s.state?.seats);
  useEffect(() => {
    void useLicenseStore.getState().load(url);
  }, [url]);
  if (seats === undefined) return null;
  return (
    <p data-testid="people-seats" className="mt-4 text-xs text-fg-subtle">
      {seats.limit === null
        ? `${String(seats.used)} seats in use on this server`
        : `${String(seats.used)} of ${String(seats.limit)} seats in use on this server`}
    </p>
  );
}

export function PeoplePage() {
  const store = useTeamStore();
  const team = selectedTeam(store);
  const youId = useAccountStore((s) => accountOnServer(s.servers, s.active, store.url)?.userId);
  const isAdmin = team?.myRole === 'admin';
  const [filter, setFilter] = useState<PeopleFilter>('all');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<'add' | 'renewed' | undefined>(undefined);
  const [removing, setRemoving] = useState<TeamMemberWire | undefined>(undefined);
  const [card, setCard] = useState<TeamMemberWire | undefined>(undefined);
  const leaving = removing !== undefined && removing.userId === youId;
  // Two-step sign-in (spec §6, §7): a server admin sees who has it, and can reset it for someone who lost theirs.
  const twoFactor = useServerPeople(store.url, store.serverAdmin);
  const [resetting, setResetting] = useState<TeamMemberWire | undefined>(undefined);
  const reset = async (member: TeamMemberWire): Promise<void> => {
    if (store.url === undefined) return;
    const result = await ipc().account.resetTwoFactor({ url: store.url, userId: member.userId });
    if (!result.ok) {
      showToast(result.error.message);
      return;
    }
    showToast(`Two-step sign-in reset for ${member.email}. They were signed out everywhere.`);
    await twoFactor.reload();
  };

  const rows = useMemo(
    () => peopleRows(store.members, store.invitations, youId, new Date()),
    [store.members, store.invitations, youId],
  );
  const counts = peopleCounts(rows);
  // The server lists invitations to team admins only, so a member has nothing waiting to filter (ruling 10).
  const filters: readonly PeopleFilter[] = isAdmin ? ['all', 'joined', 'waiting'] : ['all', 'joined'];
  const shown = filterPeople(rows, isAdmin ? filter : filter === 'waiting' ? 'all' : filter, query);

  const renew = async (invitationId: string): Promise<void> => {
    setDialog('renewed');
    if (!(await store.renewInvitation(invitationId))) setDialog(undefined);
  };

  return (
    <div data-testid="people-page" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show" className="flex gap-1">
          {filters.map((id) => (
            <button
              key={id}
              type="button"
              data-testid={`people-filter-${id}`}
              aria-pressed={filter === id}
              onClick={() => {
                setFilter(id);
              }}
              className={`rounded-md px-2.5 py-1 text-sm focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none ${
                filter === id ? 'bg-surface-active text-fg-default' : 'text-fg-muted hover:bg-surface-hover'
              }`}
            >
              {FILTER_LABELS[id]} <span className="text-fg-subtle">{counts[id]}</span>
            </button>
          ))}
        </div>
        <div className="relative min-w-40 flex-1">
          <Search
            size={12}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle"
          />
          <input
            data-testid="people-search"
            aria-label="Find a person"
            placeholder="Find a person"
            className={`${INPUT_CLASS} w-full pl-7`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>
        {isAdmin && (
          <Button
            variant="primary"
            data-testid="people-add"
            onClick={() => {
              setDialog('add');
            }}
          >
            <UserPlus size={14} aria-hidden="true" />
            Add people
          </Button>
        )}
      </div>

      <ul className="divide-y divide-hairline">
        {shown.map((row) => {
          if (row.kind === 'invitation') {
            const invitation = row.invitation;
            return (
              <li
                key={`i:${invitation.id}`}
                data-testid={`invitation-row-${invitation.id}`}
                className="flex items-center gap-3 py-2"
              >
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-hairline-strong text-fg-subtle"
                >
                  <Mail size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-fg-default">{invitation.email}</div>
                  <div className="truncate text-xs text-fg-subtle">
                    Invited as {ROLE_LABELS[invitation.role]} · link expires in {days(row.expiresInDays)}
                  </div>
                </div>
                {isAdmin && (
                  <>
                    <Button
                      variant="ghost"
                      data-testid={`invitation-renew-${invitation.id}`}
                      onClick={() => {
                        void renew(invitation.id);
                      }}
                    >
                      New link
                    </Button>
                    <Button
                      variant="ghost"
                      data-testid={`invitation-revoke-${invitation.id}`}
                      onClick={() => {
                        void store.revokeInvitation(invitation.id);
                      }}
                    >
                      Revoke
                    </Button>
                  </>
                )}
              </li>
            );
          }
          const member = row.member;
          const error = store.rowErrors[member.userId];
          return (
            <li key={`m:${member.userId}`} data-testid={`member-row-${member.userId}`} className="py-2">
              <div className="flex items-center gap-3">
                {/* The avatar and the name open the profile card (user profile ruling 9). */}
                <button
                  type="button"
                  data-testid={`member-avatar-${member.userId}`}
                  aria-label={`Profile of ${member.displayName}`}
                  className="shrink-0 rounded-full focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                  onClick={() => {
                    setCard(member);
                  }}
                >
                  <PersonAvatar url={store.url} userId={member.userId} name={member.displayName} photo={member.photo} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-fg-default">
                    <button
                      type="button"
                      data-testid={`member-name-${member.userId}`}
                      className="rounded-sm text-left hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                      onClick={() => {
                        setCard(member);
                      }}
                    >
                      {member.displayName}
                    </button>
                    {row.you && <span className="text-fg-subtle"> · you</span>}
                    {member.disabled && <span className="ml-2 text-xs text-fg-faint">disabled</span>}
                    {twoFactor.people?.get(member.userId)?.twoFactor === true && (
                      <span
                        data-testid={`member-two-factor-${member.userId}`}
                        title="Two-step sign-in is on"
                        className="ml-2 rounded-full bg-surface-active px-1.5 py-0.5 text-2xs text-fg-muted"
                      >
                        2-step
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-fg-subtle">
                    {member.email}
                    {member.username ? (
                      <span data-testid={`member-username-${member.userId}`}> · @{member.username}</span>
                    ) : null}{' '}
                    · joined {new Date(member.addedAt).toLocaleDateString()}
                  </div>
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
                    {TEAM_ROLES.map((option) => (
                      <option key={option} value={option}>
                        {ROLE_LABELS[option]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm text-fg-muted">{ROLE_LABELS[member.role]}</span>
                )}
                {row.you ? (
                  <Button
                    variant="ghost"
                    data-testid="member-leave"
                    onClick={() => {
                      setRemoving(member);
                    }}
                  >
                    Leave team
                  </Button>
                ) : (
                  (isAdmin || twoFactor.people?.get(member.userId)?.twoFactor === true) && (
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          data-testid={`member-menu-${member.userId}`}
                          aria-label={`More actions for ${member.email}`}
                          className="flex h-7 items-center rounded-md px-2 text-fg-muted hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                        >
                          <Ellipsis size={14} aria-hidden="true" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="end"
                          sideOffset={4}
                          className="z-dropdown min-w-40 rounded-lg border border-hairline-strong bg-surface-overlay p-1 shadow-lg"
                        >
                          {twoFactor.people?.get(member.userId)?.twoFactor === true && (
                            <DropdownMenu.Item
                              data-testid={`member-reset-two-factor-${member.userId}`}
                              onSelect={() => {
                                setResetting(member);
                              }}
                              className="cursor-pointer rounded-md px-2.5 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-surface-hover"
                            >
                              Reset two-step sign-in
                            </DropdownMenu.Item>
                          )}
                          {isAdmin && (
                            <DropdownMenu.Item
                              data-testid={`member-remove-${member.userId}`}
                              onSelect={() => {
                                setRemoving(member);
                              }}
                              className="cursor-pointer rounded-md px-2.5 py-1.5 text-sm text-status-danger outline-none data-[highlighted]:bg-surface-hover"
                            >
                              Remove
                            </DropdownMenu.Item>
                          )}
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  )
                )}
              </div>
              {error !== undefined && (
                <p
                  role="alert"
                  data-testid={`member-row-error-${member.userId}`}
                  className="mt-1 pl-11 text-xs text-status-danger"
                >
                  {error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && <p className="py-6 text-center text-sm text-fg-subtle">No one matches.</p>}

      {store.serverAdmin && store.url !== undefined && <SeatLine url={store.url} />}

      <ProfileCard
        url={store.url}
        member={card}
        onClose={() => {
          setCard(undefined);
        }}
      />
      <AddPeopleDialog
        open={dialog !== undefined}
        view={dialog ?? 'add'}
        onOpenChange={(next) => {
          if (!next) setDialog(undefined);
        }}
      />
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
      <ConfirmDialog
        open={resetting !== undefined}
        onOpenChange={(next) => {
          if (!next) setResetting(undefined);
        }}
        title={`Reset two-step sign-in for ${resetting?.email ?? ''}?`}
        description="Their authenticator, passkeys and recovery codes are removed, and they are signed out on every device. They sign in with their password alone, or set two-step sign-in up again if this server requires it."
        confirmLabel="Reset"
        destructive
        testId="member-reset-two-factor-confirm"
        confirmTestId="member-reset-two-factor-confirm-ok"
        onConfirm={() => {
          if (resetting !== undefined) void reset(resetting);
        }}
      />
    </div>
  );
}
