import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useState } from 'react';
import { ChevronDown, Laptop, Server } from 'lucide-react';
import type { HostsFileWire } from '../../../../shared/ssh-wire.js';
import { useHostsStore } from '../hosts-store.js';
import type { PanePlace, PlaceChoice } from './files-store.js';
import { hostName } from './open-files.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/** One entry of the picker: this machine, or a host with the path of groups it sits in. */
export interface PlaceOption {
  readonly place: PlaceChoice;
  readonly label: string;
  /** The enclosing groups' names, outermost first, joined by ` / `; `''` at the root and for this machine. */
  readonly path: string;
}

const THIS_MACHINE = 'This machine';

type Group = HostsFileWire['groups'][number];

/**
 * This machine, then every host of the hosts file sorted by group path and name (hosts at the root first),
 * keeping those whose name or group path contains `filter`, ignoring case.
 */
export function placeOptions(file: HostsFileWire, filter: string): PlaceOption[] {
  const hosts: PlaceOption[] = file.hosts.map((host) => ({
    place: { kind: 'remote', hostId: host.id },
    label: host.name,
    path: '',
  }));
  const walk = (groups: readonly Group[], trail: readonly string[]) => {
    for (const group of groups) {
      const path = [...trail, group.name];
      for (const host of group.hosts) {
        hosts.push({ place: { kind: 'remote', hostId: host.id }, label: host.name, path: path.join(' / ') });
      }
      walk(group.groups, path);
    }
  };
  walk(file.groups, []);
  hosts.sort((a, b) => a.path.localeCompare(b.path) || a.label.localeCompare(b.label));
  const all: PlaceOption[] = [{ place: { kind: 'local' }, label: THIS_MACHINE, path: '' }, ...hosts];
  const needle = filter.trim().toLowerCase();
  if (needle === '') return all;
  return all.filter((o) => o.label.toLowerCase().includes(needle) || o.path.toLowerCase().includes(needle));
}

/**
 * A pane's place, as a menu: this machine or any host, filterable by typing. Choosing one moves the pane
 * there (spec R1), so one tab can show two hosts and copy between them.
 */
export function PlacePicker({
  place,
  onPick,
}: {
  readonly place: PanePlace;
  readonly onPick: (place: PlaceChoice) => void;
}) {
  const file = useHostsStore((s) => s.file);
  const [filter, setFilter] = useState('');
  const options = placeOptions(file, filter);
  const local = place.kind === 'local';

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) setFilter('');
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="files-place"
          aria-label={`Place: ${local ? THIS_MACHINE : hostName(place.hostId)}`}
          className="flex min-w-0 items-center gap-1.5 rounded px-1 text-xs text-fg-subtle outline-none hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent"
        >
          {local ? <Laptop size={12} aria-hidden="true" /> : <Server size={12} aria-hidden="true" />}
          <span className="truncate">{local ? THIS_MACHINE : hostName(place.hostId)}</span>
          <ChevronDown size={11} aria-hidden="true" className="shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 max-h-80 min-w-56 overflow-y-auto rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          <input
            type="text"
            aria-label="Filter places"
            placeholder="Filter places"
            value={filter}
            // The menu's own type-ahead would take the keys; only the arrows, Tab and Escape go on to it.
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Escape', 'Tab'].includes(event.key)) event.stopPropagation();
            }}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
            className="mb-1 w-full rounded border border-hairline bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:border-accent"
          />
          {options.length === 0 && <p className="px-2 py-1.5 text-sm text-fg-subtle">No matching place</p>}
          {options.map((option) => (
            <DropdownMenu.Item
              key={option.place.kind === 'local' ? 'local' : option.place.hostId}
              className={ITEM_CLASS}
              onSelect={() => {
                onPick(option.place);
              }}
            >
              {option.place.kind === 'local' ? (
                <Laptop size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
              ) : (
                <Server size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
              )}
              <span className="truncate">{option.label}</span>
              {option.path !== '' && (
                <span className="ml-auto truncate pl-3 text-xs text-fg-subtle">{option.path}</span>
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
