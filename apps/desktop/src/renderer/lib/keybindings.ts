import { useEffect } from 'react';
import type { CommandDefinition, CommandId } from '@shared/commands.js';
import type { Platform } from './platform.js';
import { getCommand, listCommands, runCommand } from './commands.js';
import type { CommandContext } from './commands.js';

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

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  enter: 'Return',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  ' ': 'Space',
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
};

/**
 * Renders a chord in Electron's accelerator notation (`CmdOrCtrl+Shift+F`) for the application
 * menu, or `undefined` when it must not become one.
 *
 * A chord with neither Mod nor Alt (⎋, ⇧Tab) is deliberately refused: as a menu accelerator it
 * would be captured globally and take Escape and Tab away from every dialog and form in the
 * app. Those commands still appear in the menu — without a key hint — and still work through
 * the window-level dispatcher, which can see what has focus.
 */
export function toAccelerator(binding: string): string | undefined {
  const parsed = parseKeybinding(binding);
  if (!parsed.mod && !parsed.alt) {
    return undefined;
  }
  const key = ACCELERATOR_KEYS[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  const parts: string[] = [];
  if (parsed.mod) {
    parts.push('CmdOrCtrl');
  }
  if (parsed.shift) {
    parts.push('Shift');
  }
  if (parsed.alt) {
    parts.push('Alt');
  }
  parts.push(key);
  return parts.join('+');
}

/** True when `event` is exactly this binding on `platform` (Mod = ⌘ on macOS, Ctrl elsewhere). */
export function matchesEvent(binding: Keybinding, event: KeyboardEvent, platform: Platform): boolean {
  const modPressed = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const otherModPressed = platform === 'mac' ? event.ctrlKey : event.metaKey;

  return (
    event.key.toLowerCase() === binding.key &&
    modPressed === binding.mod &&
    !otherModPressed &&
    event.shiftKey === binding.shift &&
    event.altKey === binding.alt
  );
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  // Monaco's edit host is a text field by construction, but the editor is where ⇧Tab, ⎋ and
  // ⌥←/→ are *meant* to work — and Monaco consumes every keystroke it has its own binding for
  // before this listener ever sees it, so nothing here can steal one from it.
  if (typeof target.closest === 'function' && target.closest('.monaco-editor') !== null) {
    return false;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  // `isContentEditable` is undefined for detached nodes in jsdom, so read the attribute too.
  return target.isContentEditable === true || target.getAttribute('contenteditable') === 'true';
}

/**
 * True when a keystroke inside a text field should be left to that field. Mod-based bindings
 * (⌘K, ⌘B…) still fire while typing — they are app-level and never produce characters.
 */
export function shouldIgnoreEvent(event: KeyboardEvent, binding: Keybinding): boolean {
  return !binding.mod && isEditable(event.target);
}

let overrides: Readonly<Record<string, string>> = {};

/**
 * Replaces the user's keybinding overrides — `preferences.shortcuts`, keyed by command id,
 * where an empty string means "unbound". Called by the preferences mirror on every document it
 * receives, so a rebind takes effect without a reload.
 */
export function setKeybindingOverrides(next: Readonly<Record<string, string>>): void {
  overrides = next;
}

/** The overrides currently in force. */
export function keybindingOverrides(): Readonly<Record<string, string>> {
  return overrides;
}

/**
 * The chord that actually runs `definition` right now: the user's override when they set one,
 * the registered default otherwise, and `undefined` when either says "unbound" (`''`).
 */
export function effectiveShortcut(definition: CommandDefinition<CommandContext>): string | undefined {
  const override = overrides[definition.id];
  if (override === undefined) {
    return definition.shortcut;
  }
  return override === '' ? undefined : override;
}

/** {@link effectiveShortcut} by command id, for callers holding only an id. */
export function effectiveShortcutFor(id: CommandId): string | undefined {
  const command = getCommand(id);
  return command === undefined ? undefined : effectiveShortcut(command);
}

/**
 * Every chord that runs `definition`: its effective default plus any fixed aliases. Chords that
 * do not parse are skipped rather than thrown on — a bad override in a hand-edited preferences
 * file must not take the whole keyboard down with it.
 */
function chordsFor(definition: CommandDefinition<CommandContext>): readonly string[] {
  const effective = effectiveShortcut(definition);
  return [...(effective === undefined ? [] : [effective]), ...(definition.extraShortcuts ?? [])].filter((chord) => {
    try {
      parseKeybinding(chord);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Installs the single window-level `keydown` listener that turns keystrokes into commands.
 * Bindings come from the registry, so registering a command is all it takes to gain a shortcut.
 */
export function useKeybindings(context: CommandContext): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      for (const definition of listCommands(context)) {
        for (const chord of chordsFor(definition)) {
          const binding = parseKeybinding(chord);
          if (!matchesEvent(binding, event, context.platform) || shouldIgnoreEvent(event, binding)) {
            continue;
          }
          event.preventDefault();
          void runCommand(definition.id, context);
          return;
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [context]);
}

/** The formatted effective shortcut for a command, or `undefined` when it has none. */
export function shortcutFor(id: CommandId, platform: Platform): string | undefined {
  const shortcut = effectiveShortcutFor(id);
  return shortcut === undefined ? undefined : formatKeybinding(shortcut, platform);
}
