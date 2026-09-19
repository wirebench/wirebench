import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { COMMAND_IDS } from '../../src/shared/commands.js';
import type { CommandId } from '../../src/shared/commands.js';
import { COMMAND_CATALOG } from '../../src/shared/command-catalog.js';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { getCommand } from '../../src/renderer/lib/commands.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

/**
 * Proves the split T3 introduced — static fields in {@link COMMAND_CATALOG}, `run`/`when`/
 * `whenScope` in the `register-*` modules — never drifts: every catalog entry ends up
 * registered exactly once, every registered command has a catalog entry, and the fields the
 * catalog owns match what actually got registered.
 */
describe('command catalog audit', () => {
  beforeAll(() => {
    installWirebenchApi();
    registerShellCommands(() => undefined);
  });

  it('has exactly one catalog entry per registered command id, and vice versa', () => {
    const catalogIds = Object.keys(COMMAND_CATALOG) as CommandId[];
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(new Set(catalogIds)).toEqual(new Set(COMMAND_IDS));

    for (const id of COMMAND_IDS) {
      expect(getCommand(id), `${id} is a catalog entry but never registered`).toBeDefined();
    }
  });

  it('catalog ids are a subset of COMMAND_IDS', () => {
    for (const id of Object.keys(COMMAND_CATALOG)) {
      expect(COMMAND_IDS as readonly string[], id).toContain(id);
    }
  });

  it.each(COMMAND_IDS)('%s registers with its catalog label, category and shortcuts', (id: CommandId) => {
    const command = getCommand(id);
    const entry = COMMAND_CATALOG[id];

    expect(command?.label).toBe(entry.label);
    expect(command?.category).toBe(entry.category);
    expect(command?.shortcut).toBe(entry.shortcut);
    expect(command?.extraShortcuts).toEqual(entry.extraShortcuts);
  });
});
