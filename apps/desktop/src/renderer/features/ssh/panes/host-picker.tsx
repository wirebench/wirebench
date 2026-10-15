import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import type { ResolvedHostWire } from '../../../../shared/ssh-wire.js';
import { hostStatusOf, useHostsStore } from '../hosts-store.js';
import { sessionStatus } from '../session-status.js';

/** What cmdk filters a host row on; the id at the end keeps two hosts of the same name apart. */
function valueOf(host: ResolvedHostWire): string {
  return [host.name, host.address, ...host.path, ...host.tags, host.id].join(' ');
}

const GROUP_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-faint [&_[cmdk-group-heading]]:uppercase';

/** One host row: a status dot, the name, a warning when the host cannot sign in yet, and the address. */
function HostRow({ host, onPick }: { readonly host: ResolvedHostWire; readonly onPick: (hostId: string) => void }) {
  const status = sessionStatus(useHostsStore((s) => hostStatusOf(s.panes, host.id)));
  return (
    <Command.Item
      value={valueOf(host)}
      data-testid="ssh-pane-host"
      onSelect={() => {
        onPick(host.id);
      }}
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
    >
      <span
        role="img"
        aria-label={status.label}
        title={status.label}
        className={`size-2 shrink-0 rounded-full bg-current ${status.color}`}
      />
      <span className="min-w-0 flex-1 truncate">{host.name}</span>
      {host.incomplete !== undefined && (
        <span className="shrink-0 text-xs text-status-warning">needs {host.incomplete.field}</span>
      )}
      <span className="max-w-[45%] truncate text-xs text-fg-subtle">{host.address}</span>
    </Command.Item>
  );
}

/**
 * The host list a split's new pane connects to, as the palette's host picker draws it: the current pane's host
 * first, under Same host, then the others, each with its status. Enter picks the highlighted host (the same
 * one, to begin with); Escape (or a click outside) cancels the split.
 */
export function HostPicker({
  initialHostId,
  onPick,
  onCancel,
}: {
  readonly initialHostId: string;
  readonly onPick: (hostId: string) => void;
  readonly onCancel: () => void;
}) {
  const hosts = useHostsStore((s) => s.resolved);
  const same = hosts.find((h) => h.id === initialHostId);
  const others = hosts.filter((h) => h.id !== initialHostId);
  const [value, setValue] = useState(() => (same === undefined ? '' : valueOf(same)));
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[18%] left-1/2 w-[min(560px,90vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-hairline-strong bg-surface-overlay shadow-2xl"
        >
          <Dialog.Title className="sr-only">Pick a host for the new pane</Dialog.Title>
          <Command loop label="Hosts" value={value} onValueChange={setValue}>
            <Command.Input
              autoFocus
              data-testid="ssh-pane-host-input"
              placeholder="Pick a host for the new pane…"
              className="h-10 w-full border-b border-hairline bg-transparent px-3 text-md text-fg-default outline-none placeholder:text-fg-faint"
            />
            <Command.List className="max-h-[320px] overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-subtle">No matching host.</Command.Empty>
              {same !== undefined && (
                <Command.Group heading="Same host" className={GROUP_CLASS}>
                  <HostRow host={same} onPick={onPick} />
                </Command.Group>
              )}
              {others.length > 0 && (
                <Command.Group heading={same === undefined ? 'Hosts' : 'Other hosts'} className={GROUP_CLASS}>
                  {others.map((host) => (
                    <HostRow key={host.id} host={host} onPick={onPick} />
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
