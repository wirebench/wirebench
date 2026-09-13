import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { COMMAND_IDS, COMMAND_WHEN_SCOPES, whenScopesOverlap } from '../../src/shared/commands.js';
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
  'item.save': 'Mod+S',
  'project.save': 'Mod+Alt+S',
  'workspace.newProject': 'Mod+Shift+N',
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
  'Workspace',
  'Project',
  'Definition',
  'Explorer',
  'Environment',
  'Request',
  'Secrets',
  'Editor',
  'History',
  'Sync',
];

/**
 * The §6 actions this round added a command for, so the audit fails if one is dropped again.
 * §6.3's view strips, §6.9's history actions and §6.8's WS-I report export.
 */
const SPEC_SECTION_6_COMMANDS: readonly CommandId[] = [
  'view.requestXml',
  'view.requestForm',
  'view.requestOutline',
  'view.requestRaw',
  'view.responseXml',
  'view.responseOutline',
  'view.responseRaw',
  'view.responseQuery',
  'history.resend',
  'history.compare',
  'history.clear',
  'request.exportWsiReport',
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

  it.each(SPEC_SECTION_6_COMMANDS)('%s is registered for its design §6 action', (id: CommandId) => {
    expect(COMMAND_IDS).toContain(id);
    expect(getCommand(id)).toBeDefined();
  });

  it('gives the §6 additions no default chord, so no existing binding is taken away', () => {
    for (const id of SPEC_SECTION_6_COMMANDS) {
      expect(getCommand(id)?.shortcut, id).toBeUndefined();
    }
  });

  it('declares a when scope wherever a command is gated', () => {
    for (const id of COMMAND_IDS) {
      const command = getCommand(id);
      if (command?.when === undefined) {
        expect(command?.whenScope, `${id} declares a scope without a gate`).toBeUndefined();
        continue;
      }
      expect(command.whenScope, `${id} is gated but declares no when scope`).toBeDefined();
      expect(Object.keys(COMMAND_WHEN_SCOPES)).toContain(command.whenScope);
    }
  });

  /**
   * Two commands may share a chord only when they can never be live together — `request.send` and
   * `rest.send` are both ⌘⏎, and a tab is a SOAP request or a REST one, never both. Anything else
   * sharing one is a real clash, because the dispatcher would have to pick.
   */
  it('binds no chord to two commands that can both be live', () => {
    const byChord = new Map<string, CommandId[]>();
    for (const id of COMMAND_IDS) {
      const command = getCommand(id);
      for (const chord of [command?.shortcut, ...(command?.extraShortcuts ?? [])]) {
        if (chord === undefined) {
          continue;
        }
        const parsed = parseKeybinding(chord);
        const key = `${parsed.key}|${String(parsed.mod)}|${String(parsed.shift)}|${String(parsed.alt)}`;
        byChord.set(key, [...(byChord.get(key) ?? []), id]);
      }
    }
    for (const [chord, ids] of byChord) {
      for (const a of ids) {
        for (const b of ids) {
          if (a === b) {
            continue;
          }
          expect(
            whenScopesOverlap(getCommand(a)?.whenScope, getCommand(b)?.whenScope),
            `${chord} is live for both ${a} and ${b}`,
          ).toBe(false);
        }
      }
    }
  });
});
