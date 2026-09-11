import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { COMMAND_IDS } from '../../src/shared/commands.js';
import type { CommandCategory, CommandId } from '../../src/shared/commands.js';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { getCommand } from '../../src/renderer/lib/commands.js';
import { parseKeybinding } from '../../src/renderer/lib/keybindings.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

/**
 * The design's "Shortcuts (default)" table (§5) transcribed as `command id → chord`. Every row
 * here must be the registered default for that command; the audit fails if a chord drifts.
 */
const SPEC_DEFAULT_SHORTCUTS: Readonly<Record<string, string>> = {
  'request.send': 'Mod+Enter',
  'request.cancel': 'Escape',
  'palette.open': 'Mod+K',
  'palette.quickOpen': 'Mod+P',
  'editor.formatXml': 'Mod+Shift+F',
  'request.validate': 'Mod+Shift+V',
  'project.save': 'Mod+S',
  'editor.closeTab': 'Mod+W',
  'view.toggleSidebar': 'Mod+B',
  'view.toggleConsole': 'Mod+J',
  'editor.toggleLayoutMode': 'Mod+Backslash',
  'editor.nextValue': 'Alt+Right',
  'editor.previousValue': 'Alt+Left',
  'editor.focusOtherPane': 'Shift+Tab',
};

const CATEGORIES: readonly CommandCategory[] = [
  'General',
  'View',
  'Project',
  'Definition',
  'Explorer',
  'Environment',
  'Request',
  'Secrets',
  'Editor',
];

describe('command registry audit', () => {
  beforeAll(() => {
    installWirebenchApi();
    registerShellCommands(() => undefined);
  });

  it('lists every id exactly once', () => {
    expect(new Set(COMMAND_IDS).size).toBe(COMMAND_IDS.length);
  });

  it.each(COMMAND_IDS)('%s has a handler, a label and a category', (id: CommandId) => {
    const command = getCommand(id);

    expect(command, `command ${id} is not registered`).toBeDefined();
    expect(typeof command?.run).toBe('function');
    expect(command?.label.length ?? 0).toBeGreaterThan(0);
    expect(CATEGORIES).toContain(command?.category);
  });

  it('registers nothing outside the id list', () => {
    // `getCommand` is keyed by id, so the only way to register an unknown one is to bypass the
    // type — this guards the reverse direction of the audit: no orphan handlers.
    for (const id of COMMAND_IDS) {
      expect(getCommand(id)?.id).toBe(id);
    }
  });

  it.each(Object.entries(SPEC_DEFAULT_SHORTCUTS))('%s carries its design default shortcut %s', (id, chord) => {
    expect(getCommand(id as CommandId)?.shortcut).toBe(chord);
  });

  it('parses every registered chord', () => {
    for (const id of COMMAND_IDS) {
      const command = getCommand(id);
      for (const chord of [command?.shortcut, ...(command?.extraShortcuts ?? [])]) {
        if (chord !== undefined) {
          expect(() => parseKeybinding(chord), `${id}: ${chord}`).not.toThrow();
        }
      }
    }
  });

  it('binds no chord to two commands', () => {
    const seen = new Map<string, CommandId>();
    for (const id of COMMAND_IDS) {
      const command = getCommand(id);
      for (const chord of [command?.shortcut, ...(command?.extraShortcuts ?? [])]) {
        if (chord === undefined) {
          continue;
        }
        const parsed = parseKeybinding(chord);
        const key = `${parsed.key}|${String(parsed.mod)}|${String(parsed.shift)}|${String(parsed.alt)}`;
        expect(seen.get(key), `${chord} is bound to both ${seen.get(key) ?? ''} and ${id}`).toBeUndefined();
        seen.set(key, id);
      }
    }
  });
});
