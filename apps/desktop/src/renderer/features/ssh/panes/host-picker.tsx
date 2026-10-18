import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command, defaultFilter } from 'cmdk';
import type { ResolvedHostWire } from '../../../../shared/ssh-wire.js';
import { hostStatusOf, useHostsStore } from '../hosts-store.js';
import { serialTargetText } from '../serial-section.js';
import { sessionStatus } from '../session-status.js';

/**
 * What a host row matches a search on: its name, address, group path and tags. These are the row's cmdk
 * keywords; its value is the host id, which keeps two hosts of the same name apart and takes no part in the
 * match (the digits of an id once kept the current host matching "box-2", and selected).
 */
function keywordsOf(host: ResolvedHostWire): string[] {
  return [host.name, host.address, ...host.path, ...host.tags];
}

/** The picker's cmdk filter: cmdk's own score over the keywords alone, never the id in the value. */
function hostFilter(_value: string, search: string, keywords?: string[]): number {
  return defaultFilter((keywords ?? []).join(' '), search);
}

/**
 * The two groups with the best match first, for a non-empty search: cmdk ranks the rows inside a group but
 * never reorders the groups, so Same host stayed on top (and selected) whatever was typed. Ties keep order.
 */
export function rankHostGroups<G extends readonly [string, readonly ResolvedHostWire[]]>(
  groups: readonly G[],
  search: string,
): readonly G[] {
  if (search.trim() === '') return groups;
  const best = (hosts: G[1]): number =>
    Math.max(0, ...hosts.map((host) => hostFilter(host.id, search, keywordsOf(host))));
  return groups
    .map((group, index) => ({ group, index, score: best(group[1]) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ group }) => group);
}

const GROUP_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-faint [&_[cmdk-group-heading]]:uppercase';

/** One host row: a status dot, the name, a warning when the host cannot sign in yet, and the address. */
function HostRow({ host, onPick }: { readonly host: ResolvedHostWire; readonly onPick: (hostId: string) => void }) {
  const status = sessionStatus(useHostsStore((s) => hostStatusOf(s.panes, host.id)));
  return (
    <Command.Item
      value={host.id}
      keywords={keywordsOf(host)}
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
      <span className="max-w-[45%] truncate text-xs text-fg-subtle">
        {host.ssh.protocol?.value === 'serial' ? serialTargetText(host) : host.address}
      </span>
    </Command.Item>
  );
}

/**
 * The host list a split's new pane connects to, as the palette's host picker draws it: the current pane's host
 * first, under Same host, then the others, each with its status. Enter picks the highlighted host: the same
 * one to begin with, then the best match for what is typed, from either group. Escape (or a click outside)
 * cancels the split.
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
  const [value, setValue] = useState(initialHostId);
  const [search, setSearch] = useState('');
  const listed: (readonly [string, readonly ResolvedHostWire[]])[] = [];
  if (same !== undefined) listed.push(['Same host', [same]]);
  if (others.length > 0) listed.push([same === undefined ? 'Hosts' : 'Other hosts', others]);
  const groups = rankHostGroups(listed, search);
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
          <Command loop label="Hosts" value={value} onValueChange={setValue} filter={hostFilter}>
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              data-testid="ssh-pane-host-input"
              placeholder="Pick a host for the new pane…"
              className="h-10 w-full border-b border-hairline bg-transparent px-3 text-md text-fg-default outline-none placeholder:text-fg-faint"
            />
            <Command.List className="max-h-[320px] overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-subtle">No matching host.</Command.Empty>
              {groups.map(([heading, rows]) => (
                <Command.Group key={heading} heading={heading} className={GROUP_CLASS}>
                  {rows.map((host) => (
                    <HostRow key={host.id} host={host} onPick={onPick} />
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
