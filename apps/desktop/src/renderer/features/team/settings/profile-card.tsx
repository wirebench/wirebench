/**
 * A team mate's profile card (user profile spec §4, plan ruling 9), opened from a People row: the cover band, the
 * photo, name, `@username`, the about text, the email and their role in this team. The profile comes from
 * `account.person` each time the card opens; a person who no longer shares a team answers 404, said in words.
 * Every field is React text — the about text keeps its line breaks and is never read as HTML or Markdown (spec §9).
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { AccountPersonWire, TeamMemberWire } from '@shared/wire-base.js';
import type { IpcError } from '@shared/ipc.js';
import { Button } from '../../../components/button.js';
import { PersonAvatar, usePersonImage } from '../../../components/person-avatar.js';
import { ipc } from '../../../state/ipc-client.js';
import { ROLE_LABELS } from '../roles.js';

export const PERSON_GONE = 'This person is no longer on your teams.';

type CardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly person: AccountPersonWire }
  | { readonly kind: 'failed'; readonly message: string };

/** The server's 404 for someone who shares no team with the caller, whatever its problem code. */
function isGone(error: IpcError): boolean {
  return error.details?.['status'] === 404 || error.code === 'identity-not-found';
}

export interface ProfileCardProps {
  readonly url: string | undefined;
  /** The row the card was opened from; `undefined` closes it. */
  readonly member: TeamMemberWire | undefined;
  readonly onClose: () => void;
}

export function ProfileCard({ url, member, onClose }: ProfileCardProps) {
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const userId = member?.userId;

  useEffect(() => {
    setState({ kind: 'loading' });
    if (url === undefined || userId === undefined) return;
    let live = true;
    void ipc()
      .account.person({ url, userId })
      .then((result) => {
        if (!live) return;
        if (result.ok) setState({ kind: 'ready', person: result.value });
        else setState({ kind: 'failed', message: isGone(result.error) ? PERSON_GONE : result.error.message });
      });
    return () => {
      live = false;
    };
  }, [url, userId]);

  const person = state.kind === 'ready' ? state.person : undefined;
  const cover = usePersonImage(url, person?.id, 'cover', person?.cover?.version);
  const name = person?.displayName ?? member?.displayName ?? '';

  return (
    <Dialog.Root
      open={member !== undefined}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="profile-card"
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 w-[420px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md bg-surface-raised shadow-lg"
        >
          <div data-testid="profile-card-cover" className="aspect-[3/1] w-full bg-accent-surface">
            {cover !== undefined && (
              <img
                src={cover}
                alt=""
                data-testid="profile-card-cover-image"
                draggable={false}
                className="h-full w-full object-cover"
              />
            )}
          </div>
          <div className="px-4 pb-4">
            <div className="relative -mt-12 flex">
              <PersonAvatar
                url={url}
                userId={userId}
                name={name}
                photo={person?.photo ?? member?.photo ?? null}
                size="lg"
                className="ring-4 ring-surface-raised"
                testId="profile-card-photo"
              />
            </div>
            <Dialog.Title data-testid="profile-card-name" className="mt-2 text-lg font-semibold text-fg-default">
              {name}
            </Dialog.Title>
            {state.kind === 'loading' && <p className="mt-1 text-sm text-fg-subtle">Loading…</p>}
            {state.kind === 'failed' && (
              <p role="alert" data-testid="profile-card-error" className="mt-1 text-sm text-status-danger">
                {state.message}
              </p>
            )}
            {person !== undefined && (
              <>
                {person.username !== null && (
                  <p data-testid="profile-card-username" className="text-sm text-fg-subtle">
                    @{person.username}
                  </p>
                )}
                {person.about.length > 0 && (
                  <p
                    data-testid="profile-card-about"
                    className="mt-3 text-sm break-words whitespace-pre-line text-fg-default"
                  >
                    {person.about}
                  </p>
                )}
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-fg-subtle">Email</dt>
                  <dd data-testid="profile-card-email" className="truncate text-fg-default">
                    {person.email}
                  </dd>
                  {member !== undefined && (
                    <>
                      <dt className="text-fg-subtle">Role</dt>
                      <dd data-testid="profile-card-role" className="text-fg-default">
                        {ROLE_LABELS[member.role]}
                      </dd>
                    </>
                  )}
                </dl>
              </>
            )}
            <div className="mt-4 flex justify-end">
              <Dialog.Close asChild>
                <Button data-testid="profile-card-close">Close</Button>
              </Dialog.Close>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
