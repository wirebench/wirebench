import { Moon, Search, Sun } from 'lucide-react';
import type { Platform } from '../lib/platform.js';
import { shortcutFor } from '../lib/keybindings.js';
import { IconButton } from '../components/icon-button.js';
import { useUiStore } from '../state/ui.js';
import { WorkspaceSwitcher } from '../features/workspace/switcher.js';

export interface TitleBarProps {
  readonly platform: Platform;
  /** The open workspace's name, or `null` when none is open (the picker is showing). */
  readonly workspaceName: string | null;
  /** True when the project has edits the autosave has not written out yet. */
  readonly dirty?: boolean;
  readonly onOpenPalette: () => void;
  readonly onToggleTheme: () => void;
}

/**
 * The custom title bar. On macOS the window is `hiddenInset`, so this strip both drags the
 * window and carries the traffic lights' inset — hence the leading spacer.
 */
export function TitleBar({ platform, workspaceName, dirty = false, onOpenPalette, onToggleTheme }: TitleBarProps) {
  const theme = useUiStore((state) => state.theme);
  const paletteShortcut = shortcutFor('palette.open', platform) ?? '';

  return (
    <header
      data-testid="title-bar"
      className="wb-drag flex h-title-bar shrink-0 items-center gap-3 border-b border-hairline bg-surface-sunken px-3"
    >
      {platform === 'mac' && <div className="w-[68px] shrink-0" aria-hidden="true" />}
      <span className="flex shrink-0 items-center gap-1 text-sm text-fg-muted">
        wirebench
        {workspaceName !== null && (
          <>
            <span className="text-fg-faint">·</span>
            {/* The name is the dropdown's trigger: with a workspace open, the way to another
                one is the name itself. With none open the picker is already that. */}
            <WorkspaceSwitcher />
          </>
        )}
        {dirty && (
          <span data-testid="title-bar-dirty" title="Unsaved changes" className="text-fg-muted">
            •
          </span>
        )}
      </span>

      <div className="flex flex-1 justify-center">
        <button
          type="button"
          onClick={onOpenPalette}
          className="wb-no-drag inline-flex h-row w-full max-w-md items-center gap-2 rounded-md border border-hairline bg-surface-raised px-2 text-sm text-fg-subtle transition-colors hover:border-hairline-strong hover:text-fg-muted"
        >
          <Search size={13} aria-hidden="true" />
          <span>Search or run a command</span>
          <span className="ml-auto font-mono text-xs text-fg-faint">{paletteShortcut}</span>
        </button>
      </div>

      <div className="wb-no-drag flex shrink-0 items-center">
        <IconButton
          label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          onClick={onToggleTheme}
        >
          {theme === 'light' ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
        </IconButton>
      </div>
    </header>
  );
}
