/**
 * The menus of a host and of a group: on right-click of whatever shows them (a card, a section
 * heading), and for a host also behind its ⋯ button. Both kinds draw the same items. The actions
 * edit `hosts.yaml` through the hosts store and open a terminal through `connect.ts`; nothing here
 * knows how the host is drawn.
 */
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, MoreHorizontal } from 'lucide-react';
import type { ComponentType, CSSProperties, ReactElement, ReactNode } from 'react';
import type { GroupEntryWire, HostEntryWire } from '../../../shared/ssh-wire.js';
import { editHost, openInNewTab, openTerminalFor } from './connect.js';
import { takeSecondPress } from './double-press.js';
import { openFiles } from './files/open-files.js';
import { useHostDelete } from './host-delete-store.js';
import {
  ancestorsOf,
  findHost,
  flattenGroups,
  freeId,
  moveHost,
  removeGroup,
  upsertHost,
  useHostsStore,
} from './hosts-store.js';
import { groupLogged, useLogSwitchesStore } from './session-log-switches.js';
import { useKeyInstall } from './ssh-keys.js';
import { hasSshFeatures, useHostProtocol } from './host-protocol.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';
/** Delete: the same item, in the danger colour. */
const DANGER_ITEM_CLASS = ITEM_CLASS.replace('text-fg-default', 'text-status-danger');
const CONTENT_CLASS = 'z-dropdown min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';

/** The parts of a Radix menu the items are drawn with; the context menu and the dropdown both fit. */
interface MenuKit {
  readonly Item: ComponentType<{
    className?: string;
    style?: CSSProperties;
    disabled?: boolean;
    onSelect?: () => void;
    children?: ReactNode;
  }>;
  readonly Sub: ComponentType<{ children?: ReactNode }>;
  readonly SubTrigger: ComponentType<{ className?: string; children?: ReactNode }>;
  readonly SubContent: ComponentType<{ className?: string; children?: ReactNode }>;
  readonly Portal: ComponentType<{ children?: ReactNode }>;
  readonly Separator: ComponentType<{ className?: string }>;
  readonly CheckboxItem: ComponentType<{
    className?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    children?: ReactNode;
  }>;
  readonly ItemIndicator: ComponentType<{ className?: string; children?: ReactNode }>;
}
const CONTEXT_KIT: MenuKit = ContextMenu;
const DROPDOWN_KIT: MenuKit = DropdownMenu;

/** Connect, Open in new tab, Open files, Edit, Duplicate, Move to…, Copy address and Delete for `host`. */
function HostItems({ host, kit: M }: { readonly host: HostEntryWire; readonly kit: MenuKit }) {
  const { file, save } = useHostsStore();
  const parent = ancestorsOf(file, 'host', host.id).at(-1);
  const targets = flattenGroups(file).filter(({ group }) => group.id !== parent?.id);
  // Files and keys need an SSH connection to the host itself; a Telnet host has none (#425).
  const sshFeatures = hasSshFeatures(useHostProtocol(host.id));
  const duplicate = (): void => {
    const entry = findHost(file, host.id);
    if (entry === undefined) return;
    void save(
      upsertHost(file, { ...entry, id: freeId(file, `${entry.id}-copy`), name: `${entry.name} copy` }, parent?.id),
    );
  };
  return (
    <>
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          openTerminalFor(host.id);
        }}
      >
        Connect
      </M.Item>
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          openInNewTab(host.id);
        }}
      >
        Open in new tab
      </M.Item>
      {sshFeatures && (
        <M.Item
          className={ITEM_CLASS}
          onSelect={() => {
            openFiles(host.id);
          }}
        >
          Open files
        </M.Item>
      )}
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          editHost(host.id);
        }}
      >
        Edit…
      </M.Item>
      <M.Item className={ITEM_CLASS} onSelect={duplicate}>
        Duplicate
      </M.Item>
      <M.Sub>
        <M.SubTrigger className={ITEM_CLASS}>Move to…</M.SubTrigger>
        <M.Portal>
          <M.SubContent className={CONTENT_CLASS}>
            {parent !== undefined && (
              <M.Item
                className={ITEM_CLASS}
                onSelect={() => {
                  void save(moveHost(file, host.id, undefined));
                }}
              >
                (top level)
              </M.Item>
            )}
            {targets.map(({ group, depth }) => (
              <M.Item
                key={group.id}
                className={ITEM_CLASS}
                style={{ paddingLeft: `${String(depth * 12 + 8)}px` }}
                onSelect={() => {
                  void save(moveHost(file, host.id, group.id));
                }}
              >
                {group.name}
              </M.Item>
            ))}
          </M.SubContent>
        </M.Portal>
      </M.Sub>
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          void navigator.clipboard.writeText(host.address);
        }}
      >
        Copy address
      </M.Item>
      {sshFeatures && (
        <M.Item
          className={ITEM_CLASS}
          onSelect={() => {
            useKeyInstall.getState().open({ hostId: host.id });
          }}
        >
          Install public key…
        </M.Item>
      )}
      <M.Separator className="my-1 h-px bg-hairline" />
      <M.Item
        className={DANGER_ITEM_CLASS}
        onSelect={() => {
          // Asks first, naming the sessions that will close; the dialog outlives this menu.
          useHostDelete.getState().ask(host.id);
        }}
      >
        Delete…
      </M.Item>
    </>
  );
}

/** The host's items on right-click of `children`. */
export function HostMenu({ host, children }: { readonly host: HostEntryWire; readonly children: ReactElement }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={CONTENT_CLASS}>
          <HostItems host={host} kit={CONTEXT_KIT} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The host's items behind a ⋯ button, for whoever does not right-click. */
export function HostActionsButton({
  host,
  className = '',
}: {
  readonly host: HostEntryWire;
  readonly className?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        asChild
        // Opens on the pointer press, before the cards see a mouse press: a host card's double-click whose
        // second press lands here connects instead of opening this menu (#537).
        onPointerDown={(e) => {
          takeSecondPress(e);
        }}
      >
        <button
          type="button"
          aria-label={`More actions for ${host.name}`}
          // The card's own keys (Enter connects, arrows move) must not see the button's.
          onKeyDown={(e) => {
            e.stopPropagation();
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
          }}
          className={`inline-flex size-6 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none ${className}`}
        >
          <MoreHorizontal size={14} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={CONTENT_CLASS}>
          <HostItems host={host} kit={DROPDOWN_KIT} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Edit, New host here, New subgroup, Log sessions, Show only this group and Delete (only while empty) for
 * `group`.
 */
function GroupItems({ group, kit: M }: { readonly group: GroupEntryWire; readonly kit: MenuKit }) {
  const { file, save, openDialog, groupFilter, setGroupFilter } = useHostsStore();
  const switches = useLogSwitchesStore((s) => s.switches);
  const empty = group.groups.length === 0 && group.hosts.length === 0;
  const logged = groupLogged(file, switches, group.id);
  const only = groupFilter === group.id;
  return (
    <>
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          openDialog({ mode: 'edit-group', id: group.id });
        }}
      >
        Edit group…
      </M.Item>
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          openDialog({ mode: 'new-host', parent: group.id });
        }}
      >
        New host here…
      </M.Item>
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          openDialog({ mode: 'new-group', parent: group.id });
        }}
      >
        New subgroup…
      </M.Item>
      <M.CheckboxItem
        className={ITEM_CLASS}
        checked={logged}
        onCheckedChange={(checked) => {
          void useLogSwitchesStore.getState().set({ kind: 'group', id: group.id }, checked);
        }}
      >
        Log sessions
        <M.ItemIndicator className="ml-auto pl-3">
          <Check size={12} aria-hidden="true" />
        </M.ItemIndicator>
      </M.CheckboxItem>
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          setGroupFilter(only ? undefined : group.id);
        }}
      >
        {only ? 'Show all groups' : 'Show only this group'}
      </M.Item>
      <M.Separator className="my-1 h-px bg-hairline" />
      <M.Item
        className={ITEM_CLASS}
        disabled={!empty}
        onSelect={() => {
          void save(removeGroup(file, group.id));
        }}
      >
        Delete group
      </M.Item>
    </>
  );
}

const loadSwitches = (open: boolean): void => {
  if (open) void useLogSwitchesStore.getState().load();
};

/** The group's items on right-click of `children`. */
export function GroupMenu({ group, children }: { readonly group: GroupEntryWire; readonly children: ReactElement }) {
  return (
    <ContextMenu.Root onOpenChange={loadSwitches}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={CONTENT_CLASS}>
          <GroupItems group={group} kit={CONTEXT_KIT} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The group's items behind a ⋯ button on its heading, for whoever does not right-click. */
export function GroupActionsButton({
  group,
  className = '',
}: {
  readonly group: GroupEntryWire;
  readonly className?: string;
}) {
  return (
    <DropdownMenu.Root onOpenChange={loadSwitches}>
      <DropdownMenu.Trigger
        asChild
        // Opens on the pointer press, before the cards see a mouse press: a host card's double-click whose
        // second press lands here connects instead of opening this menu (#537).
        onPointerDown={(e) => {
          takeSecondPress(e);
        }}
      >
        <button
          type="button"
          aria-label={`More actions for ${group.name}`}
          className={`inline-flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none ${className}`}
        >
          <MoreHorizontal size={13} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={4} className={CONTENT_CLASS}>
          <GroupItems group={group} kit={DROPDOWN_KIT} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
