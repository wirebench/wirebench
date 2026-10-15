import { useEffect, useState } from 'react';
import { matchesEvent, parseKeybinding } from './keybindings.js';
import type { Platform } from './platform.js';

/**
 * The palette's chord a focused terminal leaves to the app. Off a Mac the palette's own Ctrl+K is the shell's
 * (it deletes to the end of the line), so inside a terminal the palette answers to this alias only; the title
 * bar shows it while a terminal has the focus.
 */
export const TERMINAL_PALETTE_CHORD = 'Mod+Shift+P';

/** Whether a keystroke in a terminal is the palette's: the terminal must not send it to the shell. */
export function isPaletteChord(event: KeyboardEvent, platform: Platform): boolean {
  return matchesEvent(parseKeybinding(TERMINAL_PALETTE_CHORD), event, platform);
}

function terminalHasFocus(): boolean {
  const element = document.activeElement;
  return element !== null && element.closest('.xterm') !== null;
}

/** Whether the focus is in a terminal (an SSH or a local one), kept current as it moves. */
export function useTerminalFocused(): boolean {
  const [focused, setFocused] = useState(terminalHasFocus);
  useEffect(() => {
    const update = (): void => {
      setFocused(terminalHasFocus());
    };
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);
  return focused;
}
