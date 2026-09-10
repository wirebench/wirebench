import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
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
    editorLineNumbers: true,
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

describe('environment commands', () => {
  beforeEach(() => {
    resetCommands();
    registerShellCommands(vi.fn());
    useUiStore.setState({ envSwitcherOpen: false });
  });

  afterEach(() => {
    useProjectStore.setState({ project: null, environments: [], activeEnvironmentId: undefined });
  });

  it('opens the switcher dropdown with no argument', async () => {
    useProjectStore.setState({ project: {} as never, environments: [], activeEnvironmentId: undefined });
    await runCommand('env.switch', context);
    expect(useUiStore.getState().envSwitcherOpen).toBe(true);
  });

  it('switches straight to a named environment when the palette passes one', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({
      project: {} as never,
      environments: [{ id: 'e1', name: 'uat', slug: 'uat', order: 0, endpoints: {}, properties: {} }],
      setActiveEnvironment,
    });
    await runCommand('env.switch', context, 'uat');
    expect(setActiveEnvironment).toHaveBeenCalledWith('e1');
    expect(useUiStore.getState().envSwitcherOpen).toBe(false);
  });

  it('cycles to the next environment, and is unavailable without any', async () => {
    const setActiveEnvironment = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ environments: [], activeEnvironmentId: undefined, setActiveEnvironment });
    expect(listCommands(context).some((command) => command.id === 'env.next')).toBe(false);

    useProjectStore.setState({
      environments: [{ id: 'e1', name: 'uat', slug: 'uat', order: 0, endpoints: {}, properties: {} }],
    });
    await runCommand('env.next', context);
    expect(setActiveEnvironment).toHaveBeenCalledWith('e1');
  });
});
