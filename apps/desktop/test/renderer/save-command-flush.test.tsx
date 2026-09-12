import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestEditor } from '../../src/renderer/features/request-editor/request-editor.js';
import { registerProjectCommands } from '../../src/renderer/commands/register-project-commands.js';
import { menuManifest } from '../../src/renderer/shell/app-menu.js';
import { resetCommands, runCommand } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { makeDraft, makeInterface } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { PROJECT_SETTINGS } from '../helpers/wire-defaults.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const context = { platform: 'mac', ui: () => DEFAULT_UI_STATE, selection: undefined } as unknown as CommandContext;

/** A project wire complete enough for the mirror to index it. */
function projectWire() {
  return {
    id: 'p1',
    name: 'P',
    dir: '/tmp/p',
    dirty: true,
    interfaces: [],
    requests: [],
    properties: {},
    disabledProperties: [],
    settings: PROJECT_SETTINGS,
    environments: [],
    keystores: [],
    wssOutgoing: [],
    wssIncoming: [],
    problems: [],
  };
}

/** The two IPC methods a save touches, stubbed together so their mock types stay inferred. */
function stubSaveIpc() {
  const mutate = vi.fn().mockResolvedValue({ ok: true, value: { project: projectWire() } });
  const save = vi.fn().mockResolvedValue({ ok: true, value: { saved: true, written: 1, removed: 0 } });
  installWirebenchApi({ project: { mutate, save } });
  return { mutate, save };
}

let mutate: ReturnType<typeof stubSaveIpc>['mutate'];
let save: ReturnType<typeof stubSaveIpc>['save'];

beforeEach(() => {
  resetCommands();
  ({ mutate, save } = stubSaveIpc());
  useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
  useDraftsStore.setState({ requests: {} });
  useProjectStore.setState({
    projects: { p1: projectWire() },
    requests: { 'req-1': makeDraft() },
    interfaces: { 'if-1': makeInterface() },
    order: [{ projectId: 'p1', interfaceIds: ['if-1'] }],
    projectOf: { 'if-1': 'p1', 'req-1': 'p1' },
  });
  useEditorsStore.setState({
    tabs: [{ id: 'request:req-1', kind: 'request', title: 'Request 1', requestId: 'req-1' }],
    activeId: 'request:req-1',
  });
  registerProjectCommands();
});

afterEach(() => {
  cleanup();
  resetCommands();
  vi.restoreAllMocks();
});

describe('item.save, invoked the way the application menu invokes it', () => {
  /**
   * On macOS the native menu owns ⌘S, so the accelerator fires File ▸ Save and the renderer's
   * keydown — and with it the pane's own Monaco binding, which flushes — never runs. Playwright
   * sends keys straight to the page, so no e2e can reach this path; the command has to be
   * invoked directly, exactly as `command.invoke` does.
   */
  it('writes what is on screen, not the last debounced envelope', async () => {
    render(<RequestEditor requestId="req-1" />);
    const editor = await screen.findByLabelText('Request envelope XML');

    // Typed and saved inside the 120 ms debounce, which is what pressing ⌘S after a burst of
    // typing looks like. Nothing has reached the drafts store yet.
    editor.focus();
    // `skipClick`: the resizable-panel group swallows the synthetic pointer sequence under
    // jsdom, the same reason the request-editor tests pass it.
    await userEvent.type(editor, '<!-- typed -->', { skipClick: true });
    expect(useDraftsStore.getState().isRequestDirty('req-1')).toBe(false);

    await runCommand('item.save', context);

    await waitFor(() => {
      expect(mutate).toHaveBeenCalled();
    });
    const change = mutate.mock.calls[0]?.[0] as {
      projectId: string;
      change: { kind: string; requestId: string; patch: { envelopeXml?: string } };
    };
    expect(change.projectId).toBe('p1');
    expect(change.change.kind).toBe('update-request');
    expect(change.change.requestId).toBe('req-1');
    expect(change.change.patch.envelopeXml).toContain('<!-- typed -->');
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
  });

  it('is a harmless no-op when the tab has nothing staged', async () => {
    render(<RequestEditor requestId="req-1" />);
    await screen.findByLabelText('Request envelope XML');

    await expect(runCommand('item.save', context)).resolves.toBe(true);

    expect(mutate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('leaves the tab clean afterwards, so the dot does not come back', async () => {
    render(<RequestEditor requestId="req-1" />);
    const editor = await screen.findByLabelText('Request envelope XML');
    editor.focus();
    await userEvent.type(editor, '<!-- edited -->', { skipClick: true });

    await runCommand('item.save', context);

    // The debounce would have re-staged the edit had the flush not consumed it first — that
    // reappearing dot is exactly what "Mod+S does not save" looked like.
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(useDraftsStore.getState().isRequestDirty('req-1')).toBe(false);
  });
});

describe('Save All', () => {
  it('commits every staged edit before writing, rather than saving a model that never saw them', async () => {
    render(<RequestEditor requestId="req-1" />);
    const editor = await screen.findByLabelText('Request envelope XML');
    editor.focus();
    await userEvent.type(editor, '<!-- all -->', { skipClick: true });

    await runCommand('project.save', context);

    // The write is of main's model, so an uncommitted draft would simply not be in the file —
    // "Save All" would report success and leave the edit behind, tab still marked.
    await waitFor(() => {
      expect(mutate).toHaveBeenCalled();
    });
    const committed = mutate.mock.calls[0]?.[0] as {
      projectId: string;
      change: { kind: string; requestId: string };
    };
    expect(committed.projectId).toBe('p1');
    expect(committed.change).toMatchObject({ kind: 'update-request', requestId: 'req-1' });
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
    expect(mutate.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]!);
    expect(useDraftsStore.getState().isRequestDirty('req-1')).toBe(false);
  });

  it("commits only the named project's drafts when the save is scoped to one", async () => {
    // The *command* always saves every open project — that is what "Save All" means. The store
    // underneath takes a project id, and that narrower path must not drag another project's
    // unsaved work to disk behind its back.
    useProjectStore.setState((state) => ({
      projects: { ...state.projects, p2: { ...projectWire(), id: 'p2' } },
      projectOf: { ...state.projectOf, 'req-other': 'p2' },
    }));
    useDraftsStore.getState().stageRequest('req-other', { envelopeXml: '<other/>' });
    useDraftsStore.getState().stageRequest('req-1', { envelopeXml: '<mine/>' });

    await useProjectStore.getState().save('p1');

    expect(useDraftsStore.getState().isRequestDirty('req-1')).toBe(false);
    expect(useDraftsStore.getState().isRequestDirty('req-other')).toBe(true);
  });
});

describe('the application menu route', () => {
  /**
   * The bug was not in the command's logic but in which entry point reached it. Main builds the
   * menu from this manifest, so an accelerator here is a native menu accelerator — and on macOS
   * that claims the keystroke before the page ever sees a keydown. Pinning it records that
   * `item.save` is reached this way, and that the pane's Monaco binding is therefore a second
   * route rather than the only one.
   */
  it('gives Save a native accelerator, which is why the command has to flush for itself', () => {
    const save = menuManifest().find((command) => command.id === 'item.save');

    expect(save).toMatchObject({ label: 'Save', accelerator: 'CmdOrCtrl+S' });
  });

  it('keeps Save All on a separate chord, so one keystroke cannot mean both', () => {
    const manifest = menuManifest();
    const saveAll = manifest.find((command) => command.id === 'project.save');

    expect(saveAll?.accelerator).toBe('CmdOrCtrl+Alt+S');
    // Two menu items sharing an accelerator would leave the OS to pick one, and which one it
    // picked would decide whether a staged edit was written.
    const accelerators = manifest.map((command) => command.accelerator).filter((a) => a !== undefined);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});
