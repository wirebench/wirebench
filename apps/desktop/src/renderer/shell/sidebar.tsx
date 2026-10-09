import { PanelLeftClose } from 'lucide-react';
import { IconButton } from '../components/icon-button.js';
import { areaById } from '@shared/area-module.js';
import { RENDERER_AREAS } from '../areas/index.js';
import { useUiStore } from '../state/ui.js';

/** The sidebar panel: a section title plus the active view's content. */
export function Sidebar() {
  const view = useUiStore((state) => state.sidebar.view);
  const collapseSidebar = useUiStore((state) => state.collapseSidebar);
  const copy = areaById(view).copy;
  const View = RENDERER_AREAS[view].View;

  return (
    <aside
      data-testid="sidebar"
      aria-label={copy.title}
      className="flex h-full min-w-0 flex-col bg-surface-base text-fg-default"
    >
      {/* The chevron is a sibling of the heading, not a child of it: nested inside, its label
          became part of the heading's own accessible name ("Explorer Collapse Sidebar"). */}
      <div className="flex h-row shrink-0 items-center justify-between px-3">
        <h2 className="text-xs font-medium tracking-wider text-fg-subtle uppercase">{copy.title}</h2>
        <IconButton
          label="Collapse Sidebar"
          data-testid="sidebar-collapse"
          onClick={() => {
            collapseSidebar();
          }}
        >
          <PanelLeftClose size={14} aria-hidden="true" />
        </IconButton>
      </div>
      <View />
    </aside>
  );
}
