/**
 * Reopen Closed Tab (#912): the tabs a user closes go on a short per-window list, and the command brings
 * them back newest first, skipping any whose project item was deleted since.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { COMMAND_CATALOG } from '@wirebench/wire/command-catalog';
import type { ProjectWire } from '@wirebench/wire/wire-types';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { onePane } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import { getCommand, type CommandContext } from '../../src/renderer/lib/commands.js';
import { closeTabs, reopenClosedTab } from '../../src/renderer/shell/tab-close.js';
import { CLOSED_TABS_KEPT, useEditorsStore, type EditorTab } from '../../src/renderer/state/editors.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

function project(id: string): EditorTab {
  return { id: `project:${id}`, kind: 'project', title: id, projectId: id };
}

function history(id: string): EditorTab {
  return { id: `history:${id}`, kind: 'history', title: `Entry ${id}`, historyId: id };
}

const ids = (): string[] => useEditorsStore.getState().tabs.map((tab) => tab.id);

function withProjects(...names: string[]): void {
  useProjectStore.setState({
    projects: Object.fromEntries(names.map((name) => [name, { id: name, name } as unknown as ProjectWire])),
  });
}

beforeEach(() => {
  installWirebenchApi();
  useEditorsStore.getState().reset();
  withProjects('a', 'b', 'c');
});

describe('the closed-tab list', () => {
  it('keeps the tabs a user closes, each one of a batch, oldest first', async () => {
    for (const id of ['a', 'b', 'c']) useEditorsStore.getState().open(project(id));
    await closeTabs(['project:a', 'project:c']);
    expect(useEditorsStore.getState().closed.map((tab) => tab.id)).toEqual(['project:a', 'project:c']);
  });

  it('leaves out a plain close, such as a deleted request taking its tab', () => {
    useEditorsStore.getState().open(project('a'));
    useEditorsStore.getState().close('project:a');
    expect(useEditorsStore.getState().closed).toEqual([]);
  });

  it('never keeps a tab holding live sessions', async () => {
    useEditorsStore.getState().open({ id: 'ssh-terminal:t1', kind: 'ssh-terminal', title: 'box', panes: onePane('h') });
    await closeTabs(['ssh-terminal:t1']);
    expect(useEditorsStore.getState().closed).toEqual([]);
  });

  it(`keeps the last ${CLOSED_TABS_KEPT}`, async () => {
    const many = Array.from({ length: CLOSED_TABS_KEPT + 5 }, (_, index) => history(String(index)));
    for (const tab of many) useEditorsStore.getState().open(tab);
    await closeTabs(many.map((tab) => tab.id));
    const closed = useEditorsStore.getState().closed;
    expect(closed).toHaveLength(CLOSED_TABS_KEPT);
    expect(closed.at(-1)?.id).toBe(`history:${CLOSED_TABS_KEPT + 4}`);
    expect(closed[0]?.id).toBe('history:5');
  });

  it('is cleared with the workspace', async () => {
    useEditorsStore.getState().open(project('a'));
    await closeTabs(['project:a']);
    useEditorsStore.getState().reset();
    expect(useEditorsStore.getState().closed).toEqual([]);
  });
});

describe('reopenClosedTab', () => {
  it('brings the closed tabs back newest first, in front', async () => {
    for (const id of ['a', 'b', 'c']) useEditorsStore.getState().open(project(id));
    await closeTabs(['project:b', 'project:c']);
    expect(reopenClosedTab()).toBe(true);
    expect(ids()).toEqual(['project:a', 'project:c']);
    expect(useEditorsStore.getState().activeId).toBe('project:c');
    expect(reopenClosedTab()).toBe(true);
    expect(ids()).toEqual(['project:a', 'project:c', 'project:b']);
    expect(reopenClosedTab()).toBe(false);
  });

  it('brings back a History entry tab as it was', async () => {
    useEditorsStore.getState().open(history('h1'));
    await closeTabs(['history:h1']);
    reopenClosedTab();
    expect(useEditorsStore.getState().tabs).toEqual([history('h1')]);
  });

  it('skips a tab whose item was deleted and reopens the one before it', async () => {
    for (const id of ['a', 'b']) useEditorsStore.getState().open(project(id));
    await closeTabs(['project:a', 'project:b']);
    withProjects('a', 'c');
    expect(reopenClosedTab()).toBe(true);
    expect(ids()).toEqual(['project:a']);
    expect(useEditorsStore.getState().closed).toEqual([]);
  });

  it('skips a tab that is open again already', async () => {
    for (const id of ['a', 'b']) useEditorsStore.getState().open(project(id));
    await closeTabs(['project:a', 'project:b']);
    useEditorsStore.getState().open(project('b'));
    reopenClosedTab();
    expect(ids()).toEqual(['project:b', 'project:a']);
  });
});

describe('the Reopen Closed Tab command', () => {
  beforeEach(() => {
    registerShellCommands(() => undefined);
  });

  it('is an Editor command on Mod+Shift+T, and Alt+Shift+T in a browser tab', () => {
    expect(COMMAND_CATALOG['editor.reopenClosedTab']).toMatchObject({
      label: 'Reopen Closed Tab',
      category: 'Editor',
      shortcut: 'Mod+Shift+T',
      browserShortcut: 'Alt+Shift+T',
    });
  });

  it('runs only when there is a closed tab, and reopens it', async () => {
    const command = getCommand('editor.reopenClosedTab');
    // The gate reads the editors store, never the context.
    const context = {} as CommandContext;
    expect(command?.when?.(context)).toBe(false);
    useEditorsStore.getState().open(project('a'));
    await closeTabs(['project:a']);
    expect(command?.when?.(context)).toBe(true);
    await command?.run(context);
    expect(ids()).toEqual(['project:a']);
  });
});
