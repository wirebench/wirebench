import { Settings } from 'lucide-react';
import { AREAS } from '@shared/area-module.js';
import type { Platform } from '../lib/platform.js';
import { shortcutFor } from '../lib/keybindings.js';
import { IconButton } from '../components/icon-button.js';
import { AREA_ICONS } from '../areas/index.js';
import { useUiStore } from '../state/ui.js';

/**
 * Focuses the sidebar view's current menu entry (its first, if none is current): where a rail item whose
 * view already shows sends the keyboard, for an area that reselects with `focus`.
 */
function focusSidebarMenu(): void {
  const sidebar = document.querySelector('[data-testid="sidebar"]');
  const target =
    sidebar?.querySelector<HTMLElement>('nav [aria-current="page"]') ??
    sidebar?.querySelector<HTMLElement>('nav button');
  target?.focus();
}

/**
 * The left rail. Selecting the active view again collapses the sidebar, unless its area reselects with
 * `focus` (the SSH menu): then the focus goes into the view's menu.
 *
 * Settings sits apart, at the foot of the rail: it opens a dialog rather than a sidebar view, so
 * grouping it with the views promised a panel that never came.
 */
export function ActivityBar({ platform }: { readonly platform: Platform }) {
  const sidebar = useUiStore((state) => state.sidebar);
  const showSidebarView = useUiStore((state) => state.showSidebarView);
  const enabledAreas = useUiStore((state) => state.enabledAreas);
  const openPreferences = useUiStore((state) => state.openPreferences);

  return (
    <nav
      data-testid="activity-bar"
      data-chrome=""
      aria-label="Views"
      className="flex w-activity-bar shrink-0 flex-col items-center gap-1 border-r border-hairline bg-surface-chrome py-2"
    >
      {AREAS.filter((area) => enabledAreas.includes(area.id)).map((area) => {
        const Icon = AREA_ICONS[area.rail.icon];
        const testId = 'testId' in area.rail ? area.rail.testId : undefined;
        return (
          <IconButton
            key={area.id}
            label={area.rail.label}
            shortcut={shortcutFor(area.rail.command, platform)}
            active={sidebar.visible && sidebar.view === area.id}
            onClick={() => {
              const shown = sidebar.visible && sidebar.view === area.id;
              if (shown && 'reselect' in area.rail && area.rail.reselect === 'focus') focusSidebarMenu();
              else showSidebarView(area.id);
            }}
            {...(testId === undefined ? {} : { 'data-testid': testId })}
          >
            <Icon size={17} aria-hidden="true" />
          </IconButton>
        );
      })}
      <div className="flex-1" aria-hidden="true" />
      <IconButton
        label="Settings"
        data-testid="activity-settings"
        shortcut={shortcutFor('preferences.open', platform)}
        onClick={() => {
          openPreferences();
        }}
      >
        <Settings size={17} aria-hidden="true" />
      </IconButton>
    </nav>
  );
}
