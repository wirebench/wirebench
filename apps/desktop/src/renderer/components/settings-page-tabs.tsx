/**
 * A settings page split into tabs: the project page and every API page (REST, WebSocket, gRPC,
 * MCP). Each section of the page is one tab, so a long page reads one part at a time. The tab a
 * page was on is kept per page id, because the editor area mounts only the open editor and a
 * page would otherwise fall back to its first tab every time it is shown again.
 */
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { Tabs } from './tabs.js';

export interface SettingsPageTab<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Rendered after the label, e.g. the auth type or a row count. */
  readonly badge?: string;
  readonly content: ReactNode;
  /** The tab's body fills the page's height instead of scrolling, e.g. for a script editor. */
  readonly fill?: boolean;
}

interface SettingsPageTabStore {
  readonly selected: Readonly<Record<string, string>>;
  select: (pageId: string, tabId: string) => void;
}

export const useSettingsPageTabStore = create<SettingsPageTabStore>((set) => ({
  selected: {},
  select: (pageId, tabId) => {
    set((state) => ({ selected: { ...state.selected, [pageId]: tabId } }));
  },
}));

export interface SettingsPageTabsProps<T extends string> {
  /** Which page this is, e.g. the API's id; the selected tab is remembered under it. */
  readonly pageId: string;
  /** The tab list's accessible name. */
  readonly label: string;
  readonly tabs: readonly SettingsPageTab<T>[];
  /** Shown above the tab strip, e.g. the page's title and save state. */
  readonly header?: ReactNode;
}

export function SettingsPageTabs<T extends string>({ pageId, label, tabs, header }: SettingsPageTabsProps<T>) {
  const remembered = useSettingsPageTabStore((state) => state.selected[pageId]);
  const select = useSettingsPageTabStore((state) => state.select);
  // A remembered tab the page no longer has (a definition removed, say) falls back to the first.
  const current = tabs.find((tab) => tab.id === remembered) ?? tabs[0];
  if (current === undefined) {
    return null;
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="flex shrink-0 border-b border-hairline px-1">
        <Tabs
          label={label}
          items={tabs.map(({ id, label: tabLabel, badge }) =>
            badge === undefined ? { id, label: tabLabel } : { id, label: tabLabel, badge },
          )}
          active={current.id}
          onSelect={(id) => {
            select(pageId, id);
          }}
        />
      </div>
      <div
        role="tabpanel"
        aria-label={current.label}
        data-testid={`settings-page-panel-${current.id}`}
        className={current.fill === true ? 'flex min-h-0 flex-1 flex-col p-3' : 'min-h-0 flex-1 overflow-auto p-3'}
      >
        {current.content}
      </div>
    </div>
  );
}
