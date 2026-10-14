import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import type { ResolvedHostWire } from '../../../../shared/ssh-wire.js';
import { useHostsStore } from '../hosts-store.js';

/** What cmdk filters a host row on; the id at the end keeps two hosts of the same name apart. */
function valueOf(host: ResolvedHostWire): string {
  return [host.name, host.address, ...host.path, ...host.tags, host.id].join(' ');
}

/**
 * The host list a split's new pane connects to, as the palette's host picker draws it, starting on
 * `initialHostId`. Enter picks the highlighted host; Escape (or a click outside) cancels the split.
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
  const [value, setValue] = useState(() => {
    const initial = hosts.find((h) => h.id === initialHostId);
    return initial === undefined ? '' : valueOf(initial);
  });
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
          <Dialog.Title className="sr-only">Connect the new pane to</Dialog.Title>
          <Command loop label="Hosts" value={value} onValueChange={setValue}>
            <Command.Input
              autoFocus
              data-testid="ssh-pane-host-input"
              placeholder="Connect the new pane to"
              className="h-10 w-full border-b border-hairline bg-transparent px-3 text-md text-fg-default outline-none placeholder:text-fg-faint"
            />
            <Command.List className="max-h-[320px] overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-subtle">No matching host.</Command.Empty>
              {hosts.map((host) => (
                <Command.Item
                  key={host.id}
                  value={valueOf(host)}
                  data-testid="ssh-pane-host"
                  onSelect={() => {
                    onPick(host.id);
                  }}
                  className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                >
                  <span className="truncate">{host.name}</span>
                  <span className="truncate text-xs text-fg-subtle">{host.address}</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
