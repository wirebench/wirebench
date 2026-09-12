import { Code2 } from 'lucide-react';
import { shortcutFor } from '../lib/keybindings.js';
import type { Platform } from '../lib/platform.js';
import { IconButton } from '../components/icon-button.js';
import { useUiStore } from '../state/ui.js';

/**
 * The right rail: a fixed-width strip that replaces the old Details panel's permanent presence.
 * Its one icon today opens the Code slide-over; Task 9 adds this rail's own collapse affordance.
 */
export function RightRail({ platform }: { readonly platform: Platform }) {
  const open = useUiStore((state) => state.slideOver.open);
  const toggleCode = useUiStore((state) => state.toggleCode);

  return (
    <nav
      data-testid="right-rail"
      aria-label="Panels"
      className="flex w-right-rail shrink-0 flex-col items-center gap-1 border-l border-hairline bg-surface-sunken py-2"
    >
      <IconButton
        label="Code"
        shortcut={shortcutFor('view.toggleCode', platform)}
        active={open}
        data-testid="rail-code"
        aria-expanded={open}
        onClick={() => {
          toggleCode();
        }}
      >
        <Code2 size={17} aria-hidden="true" />
      </IconButton>
    </nav>
  );
}
