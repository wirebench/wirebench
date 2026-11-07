/**
 * Team settings' team switcher (settings split spec §3.1): the team's initial in a square, its name and a chevron,
 * opening the caller's teams on this server; a server admin also gets *New team…*, which creates one and lands on
 * its People page.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import { Button } from '../../../components/button.js';
import { selectedTeam, useTeamStore } from '../../../state/team.js';
import { INPUT_CLASS } from '../roles.js';

/** A team's mark: its first letter, as the switcher and its list draw it. */
function Initial({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-accent-muted text-2xs font-semibold text-fg-default"
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-surface-hover';

export function TeamSwitcher({ onNewTeam }: { readonly onNewTeam: () => void }) {
  const teams = useTeamStore((s) => s.teams);
  const teamId = useTeamStore((s) => s.teamId);
  const serverAdmin = useTeamStore((s) => s.serverAdmin);
  const selectTeam = useTeamStore((s) => s.selectTeam);
  const team = useTeamStore(selectedTeam);
  const name = team?.name ?? 'No team';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="team-switcher"
          aria-label={`Team: ${name}`}
          className="flex w-full items-center gap-2 rounded-md border border-hairline bg-surface-raised px-2 py-1.5 text-left text-sm text-fg-default hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <Initial name={name} />
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-dropdown min-w-52 rounded-lg border border-hairline-strong bg-surface-overlay p-1 shadow-lg"
        >
          {teams.map((item) => (
            <DropdownMenu.Item
              key={item.id}
              data-testid={`team-switcher-${item.id}`}
              onSelect={() => {
                void selectTeam(item.id);
              }}
              className={ITEM_CLASS}
            >
              <Initial name={item.name} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.id === teamId && <Check size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />}
            </DropdownMenu.Item>
          ))}
          {teams.length === 0 && <p className="px-2.5 py-1.5 text-sm text-fg-subtle">No teams yet.</p>}
          {serverAdmin && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
              <DropdownMenu.Item data-testid="team-switcher-new" onSelect={onNewTeam} className={ITEM_CLASS}>
                <Plus size={14} aria-hidden="true" className="shrink-0" />
                New team…
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** *New team…*: a name, then the team is created and Team settings switches to it on People. */
export function NewTeamDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const createTeam = useTeamStore((s) => s.createTeam);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setBusy(false);
    }
  }, [open]);

  const submit = async (): Promise<void> => {
    if (busy || name.trim().length === 0) return;
    setBusy(true);
    const created = await createTeam(name.trim());
    setBusy(false);
    if (created) onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="team-new-dialog"
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 w-[24rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">New team</Dialog.Title>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <input
              data-testid="team-new-name"
              aria-label="Team name"
              placeholder="Team name"
              autoFocus
              className={INPUT_CLASS}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                data-testid="team-new-submit"
                disabled={busy || name.trim().length === 0}
              >
                Create
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
