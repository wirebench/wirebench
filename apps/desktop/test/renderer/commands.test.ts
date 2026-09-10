import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import {
  getCommand,
  listCommands,
  registerCommand,
  resetCommands,
  runCommand,
  unregisterCommand,
} from '../../src/renderer/lib/commands.js';

const context: CommandContext = {
  platform: 'mac',
  ui: {
    sidebar: { visible: true, view: 'explorer', size: 20 },
    console: { visible: true, activeTab: 'http-log', size: 25 },
    details: { visible: true, size: 20 },
    theme: 'dark',
  },
  selection: undefined,
};

describe('command registry', () => {
  beforeEach(() => {
    resetCommands();
  });

  it('registers a command and reads it back', () => {
    registerCommand({ id: 'palette.open', label: 'Open Command Palette', category: 'General', run: vi.fn() });

    expect(getCommand('palette.open')?.label).toBe('Open Command Palette');
  });

  it('throws on duplicate registration', () => {
    registerCommand({ id: 'palette.open', label: 'Open Command Palette', category: 'General', run: vi.fn() });

    expect(() => registerCommand({ id: 'palette.open', label: 'Again', category: 'General', run: vi.fn() })).toThrow(
      /duplicate-command/,
    );
  });

  it('unregisters a command', () => {
    registerCommand({ id: 'palette.open', label: 'Open Command Palette', category: 'General', run: vi.fn() });
    unregisterCommand('palette.open');

    expect(getCommand('palette.open')).toBeUndefined();
  });

  it('runs a registered command and reports success', async () => {
    const run = vi.fn();
    registerCommand({ id: 'palette.open', label: 'Open Command Palette', category: 'General', run });

    await expect(runCommand('palette.open', context)).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(context, undefined);
  });

  it('passes an optional arg through to the handler', async () => {
    const run = vi.fn();
    registerCommand({ id: 'palette.open', label: 'Open Command Palette', category: 'General', run });

    await expect(runCommand('palette.open', context, 'https://example.test/service.wsdl')).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(context, 'https://example.test/service.wsdl');
  });

  it('throws unknown-command for an unregistered id', async () => {
    await expect(runCommand('project.new', context)).rejects.toThrow(/unknown-command/);
  });

  it('returns false without running when `when` denies the command', async () => {
    const run = vi.fn();
    registerCommand({
      id: 'view.toggleConsole',
      label: 'Toggle Console',
      category: 'View',
      when: (ctx) => ctx.ui.theme === 'light',
      run,
    });

    await expect(runCommand('view.toggleConsole', context)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('lists only commands whose `when` passes, sorted by category then label', () => {
    registerCommand({ id: 'view.toggleConsole', label: 'Toggle Console', category: 'View', run: vi.fn() });
    registerCommand({ id: 'view.toggleDetails', label: 'Toggle Details', category: 'View', run: vi.fn() });
    registerCommand({ id: 'palette.open', label: 'Open Command Palette', category: 'General', run: vi.fn() });
    registerCommand({ id: 'project.new', label: 'New Project', category: 'Project', run: vi.fn(), when: () => false });

    expect(listCommands(context).map((command) => command.id)).toEqual([
      'palette.open',
      'view.toggleConsole',
      'view.toggleDetails',
    ]);
  });

  it('exposes only the declarative half of a command to listeners', () => {
    registerCommand({
      id: 'definition.import',
      label: 'Import WSDL…',
      category: 'Definition',
      shortcut: 'Mod+I',
      run: vi.fn(),
    });

    const [command] = listCommands(context);

    expect(command?.shortcut).toBe('Mod+I');
    expect(command && 'run' in command).toBe(false);
  });
});
