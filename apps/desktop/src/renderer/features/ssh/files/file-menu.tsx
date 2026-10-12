import * as ContextMenu from '@radix-ui/react-context-menu';
import type { ReactElement } from 'react';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';
const CONTENT_CLASS = 'z-50 min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';

export interface FileMenuActions {
  /** How many entries the menu acts on. */
  readonly count: number;
  /** One folder (or link to one) selected: Open lists it. Otherwise the item reads Edit, which waits for #444. */
  readonly folder: boolean;
  readonly open: () => void;
  readonly rename: () => void;
  readonly remove: () => void;
  readonly permissions: () => void;
  readonly newFolder: () => void;
  readonly copyPath: () => void;
  readonly refresh: () => void;
}

/** The pane's menu on right-click of `children`: what a selection allows, then what the folder allows. */
export function FileMenu({
  actions: a,
  children,
}: {
  readonly actions: FileMenuActions;
  readonly children: ReactElement;
}) {
  const one = a.count === 1;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={CONTENT_CLASS} data-testid="files-menu">
          <ContextMenu.Item className={ITEM_CLASS} disabled={!(one && a.folder)} onSelect={a.open}>
            {a.count > 0 && !a.folder ? 'Edit' : 'Open'}
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} disabled>
            Copy to other pane
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} disabled={!one} onSelect={a.rename}>
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} disabled={a.count === 0} onSelect={a.remove}>
            Delete…
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} disabled={!one} onSelect={a.permissions}>
            Permissions…
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-hairline" />
          <ContextMenu.Item className={ITEM_CLASS} onSelect={a.newFolder}>
            New folder
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={a.copyPath}>
            Copy path
          </ContextMenu.Item>
          <ContextMenu.Item className={ITEM_CLASS} onSelect={a.refresh}>
            Refresh
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
