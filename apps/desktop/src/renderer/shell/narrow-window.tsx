/**
 * Below {@link NARROW_WINDOW_PX} the workbench cannot lay out: its panes and the title bar want more room than a
 * phone gives, and the page would scroll sideways. A browser tab can be that narrow; the desktop window's minimum
 * (880 px) never is, so there this never shows.
 */
import { useSyncExternalStore } from 'react';
import { MonitorSmartphone } from 'lucide-react';

/** The narrowest window the workbench is shown in. */
export const NARROW_WINDOW_PX = 640;

const QUERY = `(max-width: ${String(NARROW_WINDOW_PX - 1)}px)`;

function query(): MediaQueryList | undefined {
  return typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(QUERY) : undefined;
}

function subscribe(listener: () => void): () => void {
  const list = query();
  list?.addEventListener('change', listener);
  return () => {
    list?.removeEventListener('change', listener);
  };
}

const isNarrow = (): boolean => query()?.matches === true;

/** Whether the window is too narrow for the workbench; follows resizes. False where there is no `matchMedia`. */
export function useNarrowWindow(): boolean {
  return useSyncExternalStore(subscribe, isNarrow, () => false);
}

/** What a too-narrow window shows over the workbench, which stays mounted underneath, hidden. */
export function NarrowWindowNote() {
  return (
    <div
      data-testid="narrow-window-note"
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3 bg-surface-base p-6 text-center text-fg-default"
    >
      <MonitorSmartphone size={28} aria-hidden="true" className="text-fg-muted" />
      <p className="text-md font-medium">Wirebench needs a wider window</p>
      <p className="max-w-xs text-sm text-fg-subtle">
        Make the window at least {String(NARROW_WINDOW_PX)} pixels wide, or open Wirebench on a larger screen.
      </p>
    </div>
  );
}
