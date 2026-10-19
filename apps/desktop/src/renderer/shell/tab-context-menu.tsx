import type { ReactNode } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { revealNode } from '../features/explorer/explorer-api.js';
import { entityIdOf, TAB_KINDS } from '../kinds/index.js';
import { useEditorsStore, type EditorTab } from '../state/editors.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';
import { closeTabs, closeTabsIn, type CloseScope } from './tab-close.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-default data-[disabled]:text-fg-subtle data-[highlighted]:bg-accent-muted';

/** The Explorer row of the kinds whose tab contribution names none, since their tab never moves the tree. */
const TREE_PREFIX: Readonly<Partial<Record<EditorTab['kind'], string>>> = {
  project: 'proj:',
  sequence: 'sequence:',
  mock: 'mock:',
  'catch-url': 'catch-url:',
  schedule: 'schedule:',
};

/** The Explorer row `tab` is about, or `undefined` for a tab with none (a terminal, a diff, Cookies). */
export function treeNodeOfTab(tab: EditorTab): string | undefined {
  const contribution = TAB_KINDS[tab.kind];
  const id = contribution === undefined ? undefined : entityIdOf(tab, contribution);
  if (id === undefined) return undefined;
  const prefix = TREE_PREFIX[tab.kind];
  return contribution?.treeNode?.(id, useProjectStore.getState()) ?? (prefix === undefined ? undefined : prefix + id);
}

/** Brings the Explorer up on `tab`'s row: unfolded to, selected and focused, with the tab active. */
export function revealInExplorer(tab: EditorTab): void {
  const nodeId = treeNodeOfTab(tab);
  if (nodeId === undefined) return;
  useEditorsStore.getState().activate(tab.id);
  const ui = useUiStore.getState();
  // `showSidebarView` folds the sidebar away when it already shows the Explorer.
  if (!ui.sidebar.visible || ui.sidebar.view !== 'explorer') ui.showSidebarView('explorer');
  revealNode(nodeId, { focus: true });
}

export interface TabContextMenuProps {
  readonly tab: EditorTab;
  /** The tab's name as the strip shows it: what Copy name copies. */
  readonly label: string;
  /** Whether other tabs share the strip, and whether any sit to this one's right. */
  readonly hasOthers: boolean;
  readonly hasRight: boolean;
  readonly children: ReactNode;
}

/** The right-click menu of one editor tab (#679): the close actions, Reveal in Explorer and Copy name. */
export function TabContextMenu({ tab, label, hasOthers, hasRight, children }: TabContextMenuProps) {
  const close = (scope: CloseScope): void => {
    void (scope === 'this' ? closeTabs([tab.id]) : closeTabsIn(scope, tab.id));
  };
  const revealable = treeNodeOfTab(tab) !== undefined;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          data-testid="editor-tab-menu"
          className="z-dropdown min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
          // Portalled, yet React bubbles its clicks through the component tree to the tab, which would select it.
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <ContextMenu.Item
            data-testid="editor-tab-menu-close"
            className={ITEM_CLASS}
            onSelect={() => {
              close('this');
            }}
          >
            Close
          </ContextMenu.Item>
          <ContextMenu.Item
            data-testid="editor-tab-menu-close-others"
            className={ITEM_CLASS}
            disabled={!hasOthers}
            onSelect={() => {
              close('others');
            }}
          >
            Close others
          </ContextMenu.Item>
          <ContextMenu.Item
            data-testid="editor-tab-menu-close-right"
            className={ITEM_CLASS}
            disabled={!hasRight}
            onSelect={() => {
              close('right');
            }}
          >
            Close to the right
          </ContextMenu.Item>
          <ContextMenu.Item
            data-testid="editor-tab-menu-close-saved"
            className={ITEM_CLASS}
            onSelect={() => {
              close('saved');
            }}
          >
            Close saved
          </ContextMenu.Item>
          <ContextMenu.Item
            data-testid="editor-tab-menu-close-all"
            className={ITEM_CLASS}
            onSelect={() => {
              close('all');
            }}
          >
            Close all
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-hairline" />
          {revealable && (
            <ContextMenu.Item
              data-testid="editor-tab-menu-reveal"
              className={ITEM_CLASS}
              onSelect={() => {
                revealInExplorer(tab);
              }}
            >
              Reveal in Explorer
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            data-testid="editor-tab-menu-copy-name"
            className={ITEM_CLASS}
            onSelect={() => {
              void navigator.clipboard.writeText(label);
            }}
          >
            Copy name
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
