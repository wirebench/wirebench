import type { LucideIcon } from 'lucide-react';
import { FolderTree, Globe, History, Search, Settings, ShieldCheck } from 'lucide-react';
import type { CommandId } from '@shared/commands.js';
import type { Platform } from '../lib/platform.js';
import { shortcutFor } from '../lib/keybindings.js';
import { IconButton } from '../components/icon-button.js';
import type { SidebarView } from '../state/ui-state.js';
import { useUiStore } from '../state/ui.js';

interface ActivityItem {
  readonly view: SidebarView;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly command: CommandId;
  readonly testId?: string;
}

const ITEMS: readonly ActivityItem[] = [
  { view: 'explorer', label: 'Explorer', icon: FolderTree, command: 'view.showExplorer' },
  {
    view: 'environments',
    label: 'Environments',
    icon: Globe,
    command: 'view.showEnvironments',
    testId: 'activity-environments',
  },
  { view: 'search', label: 'Search', icon: Search, command: 'view.showSearch' },
  { view: 'history', label: 'History', icon: History, command: 'view.showHistory' },
  { view: 'wss', label: 'WS-Security', icon: ShieldCheck, command: 'view.showWss' },
  { view: 'settings', label: 'Settings', icon: Settings, command: 'view.showSettings' },
];

/** The left rail. Selecting the active view again collapses the sidebar. */
export function ActivityBar({ platform }: { readonly platform: Platform }) {
  const sidebar = useUiStore((state) => state.sidebar);
  const showSidebarView = useUiStore((state) => state.showSidebarView);

  return (
    <nav
      data-testid="activity-bar"
      aria-label="Views"
      className="flex w-activity-bar shrink-0 flex-col items-center gap-1 border-r border-hairline bg-surface-sunken py-2"
    >
      {ITEMS.map(({ view, label, icon: Icon, command, testId }) => (
        <IconButton
          key={view}
          label={label}
          shortcut={shortcutFor(command, platform)}
          active={sidebar.visible && sidebar.view === view}
          onClick={() => {
            showSidebarView(view);
          }}
          {...(testId === undefined ? {} : { 'data-testid': testId })}
        >
          <Icon size={17} aria-hidden="true" />
        </IconButton>
      ))}
    </nav>
  );
}
