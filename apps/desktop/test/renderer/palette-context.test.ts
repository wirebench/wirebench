import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { explorerActions } from '../../src/renderer/features/explorer/explorer-actions.js';
import { registerRestCommands } from '../../src/renderer/kinds/rest/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { listPaletteCommands, resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import type { Selection } from '../../src/renderer/state/ui.js';
import { restApiWire, restFolderWire, restRequestWire } from '../helpers/wire-defaults.js';

function context(selection?: Selection): CommandContext {
  return {
    platform: 'mac',
    ui: {
      sidebar: DEFAULT_UI_STATE.sidebar,
      console: DEFAULT_UI_STATE.console,
      slideOver: DEFAULT_UI_STATE.slideOver,
      theme: DEFAULT_UI_STATE.theme,
      editorLineNumbers: DEFAULT_UI_STATE.editorLineNumbers,
      editorLayout: DEFAULT_UI_STATE.editorLayout,
    },
    selection,
  };
}

function row(id: string, ctx: CommandContext) {
  return listPaletteCommands(ctx).find((candidate) => candidate.command.id === id);
}

describe('palette context for REST commands', () => {
  beforeEach(() => {
    resetCommands();
    registerRestCommands();
    useProjectStore.setState({
      apis: { 'api-1': restApiWire() },
      folders: { 'folder-1': restFolderWire() },
      restRequests: { 'rest-1': restRequestWire({ folderId: 'folder-1' }) },
    });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });

  afterEach(() => {
    resetCommands();
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    vi.restoreAllMocks();
  });

  it('lists New Request disabled, with a reason, when nothing REST is selected or open', () => {
    const newRequest = row('rest.newRequest', context());

    expect(newRequest?.disabledReason).toBe('Select a REST API, or open one of its requests');
    expect(row('rest.send', context())?.disabledReason).toBe('Open a REST request first');
  });

  it('creates in the active REST tab’s API and folder when the explorer selection is elsewhere', async () => {
    const newRestRequest = vi.spyOn(explorerActions, 'newRestRequest').mockImplementation(() => undefined);
    useEditorsStore.setState({
      tabs: [{ id: 'rest:rest-1', kind: 'rest-request', title: 'Get pet', restRequestId: 'rest-1' }],
      activeId: 'rest:rest-1',
    });

    expect(row('rest.newRequest', context())?.disabledReason).toBeUndefined();
    expect(await runCommand('rest.newRequest', context())).toBe(true);
    expect(newRestRequest).toHaveBeenCalledWith('api-1', 'folder-1');
  });

  it('creates at the API root from an open API tab', async () => {
    const newFolder = vi.spyOn(explorerActions, 'newFolder').mockImplementation(() => undefined);
    useEditorsStore.setState({
      tabs: [{ id: 'api:api-1', kind: 'api', title: 'Petstore', apiId: 'api-1' }],
      activeId: 'api:api-1',
    });

    expect(await runCommand('rest.newFolder', context())).toBe(true);
    expect(newFolder).toHaveBeenCalledWith('api-1', undefined);
  });

  it('prefers a selection inside a REST API over the active tab', async () => {
    useProjectStore.setState({ apis: { 'api-1': restApiWire(), 'api-2': restApiWire({ id: 'api-2' }) } });
    const newRestRequest = vi.spyOn(explorerActions, 'newRestRequest').mockImplementation(() => undefined);
    useEditorsStore.setState({
      tabs: [{ id: 'rest:rest-1', kind: 'rest-request', title: 'Get pet', restRequestId: 'rest-1' }],
      activeId: 'rest:rest-1',
    });

    await runCommand('rest.newRequest', context({ kind: 'api', id: 'api:api-2', apiId: 'api-2' }));
    expect(newRestRequest).toHaveBeenCalledWith('api-2', undefined);
  });
});
