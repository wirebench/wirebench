/**
 * The menus of a host and of a group: on right-click of whatever shows them (a card, a section
 * heading), and for a host also behind its ⋯ button. Both kinds draw the same items. The actions
 * edit `hosts.yaml` through the hosts store and open a terminal through `connect.ts`; nothing here
 * knows how the host is drawn.
 */
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import type { ComponentType, CSSProperties, ReactElement, ReactNode } from 'react';
import type { GroupEntryWire, HostEntryWire } from '../../../shared/ssh-wire.js';
import { editHost, openTerminalFor } from './connect.js';
import { openFiles } from './files/open-files.js';
import {
  ancestorsOf,
  findHost,
  flattenGroups,
  freeId,
  moveHost,
  removeGroup,
  removeHost,
  upsertHost,
  useHostsStore,
} from './hosts-store.js';
import { useKeyInstall } from './ssh-keys.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';
const CONTENT_CLASS = 'z-50 min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';

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
}
const CONTEXT_KIT: MenuKit = ContextMenu;
const DROPDOWN_KIT: MenuKit = DropdownMenu;

/** Connect, Open files, Edit, Duplicate, Move to…, Copy address and Delete for `host`. */
function HostItems({ host, kit: M }: { readonly host: HostEntryWire; readonly kit: MenuKit }) {
  const { file, save } = useHostsStore();
  const parent = ancestorsOf(file, 'host', host.id).at(-1);
  const targets = flattenGroups(file).filter(({ group }) => group.id !== parent?.id);
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
          openFiles(host.id);
        }}
      >
        Open files
      </M.Item>
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
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          useKeyInstall.getState().open({ hostId: host.id });
        }}
      >
        Install public key…
      </M.Item>
      <M.Separator className="my-1 h-px bg-hairline" />
      <M.Item
        className={ITEM_CLASS}
        onSelect={() => {
          void save(removeHost(file, host.id));
        }}
      >
        Delete
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
      <DropdownMenu.Trigger asChild>
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

/** Edit, New host here, New subgroup and Delete (only while empty) for `group`, on right-click of `children`. */
export function GroupMenu({ group, children }: { readonly group: GroupEntryWire; readonly children: ReactElement }) {
  const { file, save, openDialog } = useHostsStore();
  const empty = group.groups.length === 0 && group.hosts.length === 0;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={CONTENT_CLASS}>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              openDialog({ mode: 'edit-group', id: group.id });
            }}
          >
            Edit group…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              openDialog({ mode: 'new-host', parent: group.id });
            }}
          >
            New host here…
          </ContextMenu.Item>
          <ContextMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              openDialog({ mode: 'new-group', parent: group.id });
            }}
          >
            New subgroup…
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-hairline" />
          <ContextMenu.Item
            className={ITEM_CLASS}
            disabled={!empty}
            onSelect={() => {
              void save(removeGroup(file, group.id));
            }}
          >
            Delete group
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
