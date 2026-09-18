/**
 * Parsing and display of keybinding strings such as `Mod+Shift+F`. Pure and DOM-free, so both the
 * renderer and Node scripts (the generated command reference in the docs site) render a shortcut
 * the same way.
 */

/** The three desktop platforms Wirebench ships on; drives modifier glyphs and key mapping. */
export type Platform = 'mac' | 'win' | 'linux';

/** A keybinding reduced to the four facts a `keydown` comparison needs. */
export interface Keybinding {
  /** The lower-cased `KeyboardEvent.key` value, e.g. `b`, `,`, `escape`. */
  readonly key: string;
  /** `Mod` — ⌘ on macOS, Ctrl elsewhere. */
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  space: ' ',
  enter: 'enter',
  escape: 'escape',
  tab: 'tab',
  backspace: 'backspace',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  arrowleft: 'arrowleft',
  arrowright: 'arrowright',
  arrowup: 'arrowup',
  arrowdown: 'arrowdown',
  pageup: 'pageup',
  pagedown: 'pagedown',
};

/**
 * Parses a binding string such as `Mod+Shift+F` into its {@link Keybinding} parts.
 * Modifiers may appear in any order; the last segment is the key.
 *
 * @throws Error `invalid-keybinding` when the string has no key segment.
 */
export function parseKeybinding(binding: string): Keybinding {
  const segments = binding
    .split('+')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  let mod = false;
  let shift = false;
  let alt = false;
  let key: string | undefined;

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'ctrl') {
      mod = true;
    } else if (lower === 'shift') {
      shift = true;
    } else if (lower === 'alt' || lower === 'option') {
      alt = true;
    } else {
      key = NAMED_KEYS[lower] ?? lower;
    }
  }

  if (key === undefined) {
    throw new Error(`invalid-keybinding: ${binding}`);
  }
  return { key, mod, shift, alt };
}

const MAC_KEY_GLYPHS: Readonly<Record<string, string>> = {
  enter: '⏎',
  escape: '⎋',
  tab: '⇥',
  backspace: '⌫',
  ' ': 'Space',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  pageup: '⇞',
  pagedown: '⇟',
  '\\': '\\',
};

const OTHER_KEY_NAMES: Readonly<Record<string, string>> = {
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  backspace: 'Backspace',
  ' ': 'Space',
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  '\\': '\\',
};

/** Renders a binding the way the host platform writes it: `⌘⇧F` on macOS, `Ctrl+Shift+F` elsewhere. */
export function formatKeybinding(binding: string | Keybinding, platform: Platform): string {
  const parsed = typeof binding === 'string' ? parseKeybinding(binding) : binding;
  const isMac = platform === 'mac';
  const table = isMac ? MAC_KEY_GLYPHS : OTHER_KEY_NAMES;
  const key = table[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  const parts: string[] = [];

  if (parsed.mod) {
    parts.push(isMac ? '⌘' : 'Ctrl');
  }
  if (parsed.shift) {
    parts.push(isMac ? '⇧' : 'Shift');
  }
  if (parsed.alt) {
    parts.push(isMac ? '⌥' : 'Alt');
  }
  parts.push(key);

  return isMac ? parts.join('') : parts.join('+');
}
