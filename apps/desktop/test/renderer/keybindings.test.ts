import { describe, expect, it, vi } from 'vitest';

// Registering the commands reaches the Monaco-backed editor commands, which jsdom cannot load.
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import {
  chordRecordingError,
  formatKeybinding,
  matchesEvent,
  parseKeybinding,
} from '../../src/renderer/lib/keybindings.js';
import { COMMAND_IDS, whenScopesOverlap } from '../../src/shared/commands.js';
import { getCommand } from '../../src/renderer/lib/commands.js';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';

describe('parseKeybinding', () => {
  it('parses a bare key', () => {
    expect(parseKeybinding('K')).toEqual({ key: 'k', mod: false, shift: false, alt: false });
  });

  it('parses Mod, Shift and Alt in any order', () => {
    expect(parseKeybinding('Mod+Shift+F')).toEqual({ key: 'f', mod: true, shift: true, alt: false });
    expect(parseKeybinding('Shift+Mod+Alt+B')).toEqual({ key: 'b', mod: true, shift: true, alt: true });
  });

  it('parses named keys', () => {
    expect(parseKeybinding('Mod+Comma')).toEqual({ key: ',', mod: true, shift: false, alt: false });
    expect(parseKeybinding('Escape')).toEqual({ key: 'escape', mod: false, shift: false, alt: false });
  });

  it('rejects an empty or modifier-only binding', () => {
    expect(() => parseKeybinding('Mod+')).toThrow(/invalid-keybinding/);
    expect(() => parseKeybinding('')).toThrow(/invalid-keybinding/);
  });
});

describe('formatKeybinding', () => {
  it('uses glyphs on mac', () => {
    expect(formatKeybinding('Mod+Shift+F', 'mac')).toBe('⌘⇧F');
    expect(formatKeybinding('Mod+Alt+B', 'mac')).toBe('⌘⌥B');
    expect(formatKeybinding('Mod+Comma', 'mac')).toBe('⌘,');
  });

  it('uses Ctrl and plus signs elsewhere', () => {
    expect(formatKeybinding('Mod+Shift+F', 'win')).toBe('Ctrl+Shift+F');
    expect(formatKeybinding('Mod+Alt+B', 'linux')).toBe('Ctrl+Alt+B');
    expect(formatKeybinding('Mod+Comma', 'win')).toBe('Ctrl+,');
  });
});

interface FakeEventInit {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
}

function fakeEvent(init: FakeEventInit): KeyboardEvent {
  return {
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  } as unknown as KeyboardEvent;
}

describe('matchesEvent', () => {
  it('maps Mod to Meta on mac and Ctrl elsewhere', () => {
    const binding = parseKeybinding('Mod+B');

    expect(matchesEvent(binding, fakeEvent({ key: 'b', metaKey: true }), 'mac')).toBe(true);
    expect(matchesEvent(binding, fakeEvent({ key: 'b', ctrlKey: true }), 'mac')).toBe(false);
    expect(matchesEvent(binding, fakeEvent({ key: 'b', ctrlKey: true }), 'win')).toBe(true);
    expect(matchesEvent(binding, fakeEvent({ key: 'b', metaKey: true }), 'win')).toBe(false);
  });

  it('requires shift and alt to match exactly', () => {
    const binding = parseKeybinding('Mod+Shift+E');

    expect(matchesEvent(binding, fakeEvent({ key: 'E', metaKey: true, shiftKey: true }), 'mac')).toBe(true);
    expect(matchesEvent(binding, fakeEvent({ key: 'e', metaKey: true }), 'mac')).toBe(false);
    expect(matchesEvent(binding, fakeEvent({ key: 'E', metaKey: true, shiftKey: true, altKey: true }), 'mac')).toBe(
      false,
    );
  });

  it('does not match a different key', () => {
    expect(matchesEvent(parseKeybinding('Mod+B'), fakeEvent({ key: 'j', metaKey: true }), 'mac')).toBe(false);
  });
});

describe('chordRecordingError', () => {
  it('refuses a bare character key, which would stop being typeable', () => {
    expect(chordRecordingError('K')).toContain('bare key');
    expect(chordRecordingError('2')).toContain('bare key');
    expect(chordRecordingError('Shift+K')).toContain('bare key');
  });

  it('accepts anything carrying Mod or Alt', () => {
    expect(chordRecordingError('Mod+K')).toBeUndefined();
    expect(chordRecordingError('Alt+Left')).toBeUndefined();
    expect(chordRecordingError('Mod+Shift+Enter')).toBeUndefined();
  });

  it('accepts the keystrokes that are never characters', () => {
    expect(chordRecordingError('Escape')).toBeUndefined();
    expect(chordRecordingError('F2')).toBeUndefined();
    expect(chordRecordingError('F12')).toBeUndefined();
    expect(chordRecordingError('Shift+Tab')).toBeUndefined();
  });

  it('refuses a bare Tab, which is focus navigation', () => {
    expect(chordRecordingError('Tab')).toContain('bare key');
  });

  it('refuses a chord that does not parse', () => {
    expect(chordRecordingError('Mod+')).toBeDefined();
  });
});

/**
 * `Mod+Shift+I` for _Import OpenAPI…_, the one shortcut this round adds. It is registered now so the
 * chord is reserved and the keymap editor lists it from the moment REST exists, even though the
 * import itself arrives later.
 */
describe('the REST shortcuts', () => {
  it('parses Mod+Shift+I the way the design writes it', () => {
    expect(parseKeybinding('Mod+Shift+I')).toEqual({ key: 'i', mod: true, shift: true, alt: false });
  });

  it('is the registered default for rest.importOpenApi, and for nothing else', () => {
    registerShellCommands(() => undefined);

    expect(getCommand('rest.importOpenApi')?.shortcut).toBe('Mod+Shift+I');
    const sharing = COMMAND_IDS.filter((id) => getCommand(id)?.shortcut === 'Mod+Shift+I');
    expect(sharing).toEqual(['rest.importOpenApi']);
  });

  it('gives rest.send the same chord as request.send, which it can never be live with', () => {
    registerShellCommands(() => undefined);

    expect(getCommand('rest.send')?.shortcut).toBe('Mod+Enter');
    expect(getCommand('request.send')?.shortcut).toBe('Mod+Enter');
    expect(whenScopesOverlap(getCommand('rest.send')?.whenScope, getCommand('request.send')?.whenScope)).toBe(false);
  });
});
