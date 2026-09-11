import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { useRequestDialogsStore } from '../../src/renderer/features/request-editor/request-dialogs.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
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
    details: { visible: true, size: 20, tab: 'selection', codeShell: 'posix' },
    theme: 'dark',
    editorLineNumbers: true,
    editorLayout: { orientation: 'side-by-side', mode: 'split' },
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

describe('editor layout commands', () => {
  beforeEach(() => {
    // Layout toggles persist the new default through `preferences.update`.
    installWirebenchApi();
    resetCommands();
    registerShellCommands(vi.fn());
    useEditorsStore.setState({
      tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
      activeId: 'request:req-1',
      editorLayouts: {},
    });
    useUiStore.getState().setEditorLayout({ orientation: 'side-by-side', mode: 'split' });
  });

  afterEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined, editorLayouts: {} });
  });

  it('registers both layout toggles, gated on an active request editor', () => {
    const ids = listCommands(context).map((command) => command.id);
    expect(ids).toContain('editor.toggleLayoutOrientation');
    expect(ids).toContain('editor.toggleLayoutMode');

    useEditorsStore.setState({ tabs: [], activeId: undefined });
    const withoutRequest = listCommands(context).map((command) => command.id);
    expect(withoutRequest).not.toContain('editor.toggleLayoutOrientation');
    expect(withoutRequest).not.toContain('editor.toggleLayoutMode');
  });

  it('toggles orientation and mode for the active request', async () => {
    await runCommand('editor.toggleLayoutOrientation', context);
    expect(useEditorsStore.getState().editorLayouts['req-1']?.orientation).toBe('stacked');
    expect(useUiStore.getState().editorLayout.orientation).toBe('stacked');

    await runCommand('editor.toggleLayoutMode', context);
    expect(useEditorsStore.getState().editorLayouts['req-1']?.mode).toBe('tabs');
    expect(useUiStore.getState().editorLayout.mode).toBe('tabs');
  });
});

describe('pane view commands', () => {
  beforeEach(() => {
    installWirebenchApi();
    resetCommands();
    registerShellCommands(vi.fn());
    useEditorsStore.setState({
      tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
      activeId: 'request:req-1',
      requestViewTypes: {},
      responseViewTypes: {},
      responseViewPinned: {},
    });
  });

  afterEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined, requestViewTypes: {}, responseViewTypes: {} });
  });

  it('switches the request pane view', async () => {
    await runCommand('view.requestForm', context);
    expect(useEditorsStore.getState().requestViewFor('req-1')).toBe('form');

    await runCommand('view.requestOutline', context);
    expect(useEditorsStore.getState().requestViewFor('req-1')).toBe('outline');

    await runCommand('view.requestRaw', context);
    expect(useEditorsStore.getState().requestViewFor('req-1')).toBe('raw');

    await runCommand('view.requestXml', context);
    expect(useEditorsStore.getState().requestViewFor('req-1')).toBe('xml');
  });

  it('switches the response pane view', async () => {
    await runCommand('view.responseQuery', context);
    expect(useEditorsStore.getState().responseViewFor('req-1')).toBe('query');

    await runCommand('view.responseRaw', context);
    expect(useEditorsStore.getState().responseViewFor('req-1')).toBe('raw');

    await runCommand('view.responseOutline', context);
    expect(useEditorsStore.getState().responseViewFor('req-1')).toBe('outline');
  });

  it('offers none of them without a request tab', () => {
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    const ids = listCommands(context).map((command) => command.id);

    expect(ids).not.toContain('view.requestForm');
    expect(ids).not.toContain('view.responseQuery');
  });
});

describe('request action commands', () => {
  beforeEach(() => {
    installWirebenchApi();
    resetCommands();
    registerShellCommands(vi.fn());
    useEditorsStore.setState({
      tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
      activeId: 'request:req-1',
    });
  });

  afterEach(() => {
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    useRequestDialogsStore.getState().close();
  });

  it('offers every request action, only while a request tab is active', () => {
    // `request.removeAttachment` also needs a selected attachment (covered on its own above),
    // so it is selected here purely to bring it into this list's "with a request" half.
    useEditorsStore.getState().setSelectedAttachment('req-1', 'att-9');
    const ids = [
      'request.recreateKeepValues',
      'request.recreateDiscardValues',
      'request.createEmpty',
      'request.clone',
      'request.copyCurl',
      'request.copyCurlPowerShell',
      'request.importCurl',
      'request.showCode',
      'request.addAttachment',
      'request.removeAttachment',
    ];
    const listed = listCommands(context).map((command) => command.id);
    for (const id of ids) {
      expect(listed).toContain(id);
    }

    useEditorsStore.setState({ tabs: [], activeId: undefined });
    const withoutRequest = listCommands(context).map((command) => command.id);
    for (const id of ids) {
      expect(withoutRequest).not.toContain(id);
    }
  });

  it('recreates the active request, discarding its values', async () => {
    const recreate = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { envelopeXml: '<fresh/>', kept: 0, added: 1, removed: 0 } });
    installWirebenchApi({ request: { recreate } });

    await runCommand('request.recreateDiscardValues', context);

    expect(recreate).toHaveBeenCalledWith({
      requestId: 'req-1',
      keepValues: false,
      keepHeaders: true,
      empty: false,
    });
  });

  it('opens the clone dialog for the active request', async () => {
    await runCommand('request.clone', context);

    expect(useRequestDialogsStore.getState()).toMatchObject({ kind: 'clone', requestId: 'req-1' });
  });

  it('adds attachments through the picker', async () => {
    const pickFiles = vi.fn().mockResolvedValue({ ok: true, value: { paths: ['/tmp/a.png'] } });
    const addAttachment = vi.fn().mockResolvedValue('att-1');
    installWirebenchApi({ attachments: { pickFiles } });
    useProjectStore.setState({ addAttachment } as never);

    await runCommand('request.addAttachment', context);

    expect(addAttachment).toHaveBeenCalledWith('req-1', '/tmp/a.png', { copyToCache: true });
  });

  it('offers Remove Attachment only while a row is selected, and removes that row', async () => {
    const removeAttachment = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ removeAttachment } as never);
    useEditorsStore.getState().setSelectedAttachment('req-1', undefined);
    expect(listCommands(context).map((command) => command.id)).not.toContain('request.removeAttachment');

    useEditorsStore.getState().setSelectedAttachment('req-1', 'att-9');
    expect(listCommands(context).map((command) => command.id)).toContain('request.removeAttachment');

    await runCommand('request.removeAttachment', context);
    expect(removeAttachment).toHaveBeenCalledWith('req-1', 'att-9');
  });

  it('reveals the Details panel on the Code tab', async () => {
    useUiStore.setState({ details: { ...useUiStore.getState().details, visible: false, tab: 'selection' } });

    await runCommand('request.showCode', context);

    expect(useUiStore.getState().details).toMatchObject({ visible: true, tab: 'code' });
  });
});
