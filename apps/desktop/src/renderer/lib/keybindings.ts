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

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'capslock', 'dead']);

/** The chord-string spelling of a `KeyboardEvent.key`, inverting {@link NAMED_KEYS}. */
const CHORD_KEY_NAMES: Readonly<Record<string, string>> = {
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  ' ': 'Space',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
};

/**
 * The chord a keystroke stands for, in the registry's own notation — what the Shortcuts
 * editor's "record a chord" field writes.
 *
 * @returns `undefined` while only modifiers are held, since that is not a chord yet.
 */
export function chordFromEvent(event: KeyboardEvent, platform: Platform): string | undefined {
  const key = event.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) {
    return undefined;
  }
  const mod = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const parts: string[] = [];
  if (mod) {
    parts.push('Mod');
  }
  if (event.shiftKey) {
    parts.push('Shift');
  }
  if (event.altKey) {
    parts.push('Alt');
  }
  parts.push(CHORD_KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  return parts.join('+');
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
  // Monaco's edit host is a text field by construction, and it is treated as one here: a
  // user-recorded bare chord (`K`, `2`) must never eat a keystroke the user meant to type.
  // The handful of bindings the editor is *supposed* to answer to travel through
  // EDITOR_DISPATCH_ALLOWLIST instead, which is an id list rather than a target test.
  if (typeof target.closest === 'function' && target.closest('.monaco-editor') !== null) {
    return true;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  // `isContentEditable` is undefined for detached nodes in jsdom, so read the attribute too.
  return target.isContentEditable === true || target.getAttribute('contenteditable') === 'true';
}

/**
 * The only commands allowed to fire from inside a text field (Monaco included) on a chord that
 * carries no Mod. They are the editor's own navigation and the in-flight escape hatch: each is
 * useless anywhere else, and each is one the design's §5 table puts on a bare or Alt chord.
 * Everything else must carry Mod to reach past a focused field, so no rebind — however
 * careless — can swallow typed characters.
 */
const EDITOR_DISPATCH_ALLOWLIST: ReadonlySet<CommandId> = new Set<CommandId>([
  'request.cancel',
  'editor.focusOtherPane',
  'editor.nextValue',
  'editor.previousValue',
]);

/**
 * True when a keystroke inside a text field should be left to that field. Mod-based bindings
 * (⌘K, ⌘B…) still fire while typing — they are app-level and never produce characters — and so
 * do the four {@link EDITOR_DISPATCH_ALLOWLIST} commands. Anything else typed into a field
 * belongs to the field.
 *
 * @param id - The command the binding would run; omit to apply the Mod rule alone.
 */
export function shouldIgnoreEvent(event: KeyboardEvent, binding: Keybinding, id?: CommandId): boolean {
  if (binding.mod) {
    return false;
  }
  if (!isEditable(event.target)) {
    return false;
  }
  return id === undefined || !EDITOR_DISPATCH_ALLOWLIST.has(id);
}

/** Function keys are never characters, so they are safe to bind bare. */
const FUNCTION_KEY = /^f([1-9]|1[0-2])$/;

/**
 * Why `chord` may not be recorded as a shortcut, or `undefined` when it may.
 *
 * A chord with no Mod/Ctrl and no Alt is a character the user can type. Binding one would make
 * that character unusable wherever the command is live — worst of all in the XML editor, where
 * "k" would stop being a letter. The exceptions are the keystrokes that are never characters
 * anywhere: ⎋, F1–F12, and ⇧⇥ (the design's own request↔response focus chord).
 */
export function chordRecordingError(chord: string): string | undefined {
  let parsed: Keybinding;
  try {
    parsed = parseKeybinding(chord);
  } catch {
    return 'That key cannot be used as a shortcut.';
  }
  if (parsed.mod || parsed.alt) {
    return undefined;
  }
  if (parsed.key === 'escape' || FUNCTION_KEY.test(parsed.key) || (parsed.key === 'tab' && parsed.shift)) {
    return undefined;
  }
  return 'Add ⌘/Ctrl or Alt — a bare key would stop working as text in the editor.';
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
          if (!matchesEvent(binding, event, context.platform) || shouldIgnoreEvent(event, binding, definition.id)) {
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
