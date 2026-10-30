import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { availableFirst, CommandPalette } from '../../src/renderer/shell/command-palette.js';
import { registerCommand, resetCommands } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useProjectStore } from '../../src/renderer/state/project.js';

/**
 * Regression coverage for a bug Task 9 uncovered (not introduced — it was always there, just
 * masked by an unrelated library side effect that this task's refactor removed): the palette
 * memoized its filtered command list on `context`'s identity alone, and `when` predicates read
 * stores that are *not* part of `context` (e.g. whether a workspace is open). A command whose
 * `when` flips from false to true without `context` itself changing identity — a very real case,
 * not a contrived one — used to stay hidden until something unrelated happened to touch
 * `sidebar`/`console`/`slideOver`/`selection`. Reopening the palette must always see the truth.
 */
describe('CommandPalette', () => {
  beforeEach(() => {
    resetCommands();
  });

  afterEach(() => {
    cleanup();
    resetCommands();
  });

  const context: CommandContext = {
    platform: 'mac',
    ui: {
      sidebar: DEFAULT_UI_STATE.sidebar,
      console: DEFAULT_UI_STATE.console,
      slideOver: DEFAULT_UI_STATE.slideOver,
      theme: DEFAULT_UI_STATE.theme,
      palette: DEFAULT_UI_STATE.palette,
      editorLineNumbers: DEFAULT_UI_STATE.editorLineNumbers,
      editorLayout: DEFAULT_UI_STATE.editorLayout,
    },
    selection: undefined,
  };

  it('re-evaluates `when` guards on every reopen, even when `context` keeps the same identity', () => {
    let gateOpen = false;
    registerCommand({
      id: 'workspace.switch',
      label: 'Switch Workspace…',
      category: 'Workspace',
      when: () => gateOpen,
      run: () => undefined,
    });

    const { rerender } = render(<CommandPalette open={false} onOpenChange={() => undefined} context={context} />);

    // First open: the gate is still closed, so the command is absent — expected.
    rerender(<CommandPalette open onOpenChange={() => undefined} context={context} />);
    expect(screen.queryByText('Switch Workspace…')).toBeNull();

    // Close it, flip the gate — note `context` is the exact same object reference throughout,
    // which is the point: nothing about `context` changed, only what a `when` predicate reads.
    rerender(<CommandPalette open={false} onOpenChange={() => undefined} context={context} />);
    gateOpen = true;
    rerender(<CommandPalette open onOpenChange={() => undefined} context={context} />);

    expect(screen.getByText('Switch Workspace…')).toBeDefined();
  });

  it('lists a group’s disabled commands after its enabled ones, searched or not (#633)', async () => {
    // Labels that sort a disabled command first, as "REST: Lint Definition" sorts before "REST: New Request".
    registerCommand({
      id: 'rest.lintDefinition',
      label: 'REST: Lint Definition',
      category: 'Explorer',
      when: () => false,
      unavailable: () => 'No definition',
      run: () => undefined,
    });
    registerCommand({ id: 'rest.newRequest', label: 'REST: New Request', category: 'Explorer', run: () => undefined });
    registerCommand({
      id: 'rest.updateDefinition',
      label: 'REST: Update Definition…',
      category: 'Explorer',
      when: () => false,
      unavailable: () => 'No definition',
      run: () => undefined,
    });
    registerCommand({ id: 'rest.newFolder', label: 'REST: New Folder', category: 'Explorer', run: () => undefined });
    render(<CommandPalette open onOpenChange={() => undefined} context={context} />);

    const order = () =>
      screen.getAllByRole('option').map((option) => [option.textContent, option.getAttribute('aria-disabled')]);
    const expected = [
      [expect.stringContaining('New Folder'), 'false'],
      [expect.stringContaining('New Request'), 'false'],
      [expect.stringContaining('Lint Definition'), 'true'],
      [expect.stringContaining('Update Definition'), 'true'],
    ];
    expect(order()).toEqual(expected);

    // cmdk ranks only the items it can select; the disabled ones still come last.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'REST' } });
    await waitFor(() => expect(order()).toEqual(expected));
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('New Folder');
  });
});

describe('CommandPalette quick open (#683)', () => {
  const context: CommandContext = {
    platform: 'mac',
    ui: {
      sidebar: DEFAULT_UI_STATE.sidebar,
      console: DEFAULT_UI_STATE.console,
      slideOver: DEFAULT_UI_STATE.slideOver,
      theme: DEFAULT_UI_STATE.theme,
      palette: DEFAULT_UI_STATE.palette,
      editorLineNumbers: DEFAULT_UI_STATE.editorLineNumbers,
      editorLayout: DEFAULT_UI_STATE.editorLayout,
    },
    selection: undefined,
  };
  const saved = (id: string, name: string) =>
    ({ id, name, interfaceId: 'if-pet', bindingName: 'PetSoap', operationName: name }) as never;

  beforeEach(() => {
    useProjectStore.setState({
      interfaces: { 'if-pet': { id: 'if-pet', name: 'Swagger Petstore', operations: [] } as never },
      requests: { a: saved('a', 'Delete user'), b: saved('b', 'Find pets'), c: saved('c', 'Add owner') },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('lists a request matched by name above one matched only by its breadcrumb', async () => {
    render(<CommandPalette open onOpenChange={() => undefined} context={context} mode="quick-open" />);
    const labels = () => screen.getAllByTestId('quick-open-item').map((item) => item.firstChild?.textContent);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pet' } });
    await waitFor(() => expect(labels()[0]).toBe('Find pets'));
    expect([...labels()].sort()).toEqual(['Add owner', 'Delete user', 'Find pets']);

    // "user" is in Delete user's name, so the "pet" in its breadcrumb no longer lists it.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pet user' } });
    await waitFor(() => expect(screen.queryAllByTestId('quick-open-item')).toHaveLength(0));
  });
});

describe('availableFirst', () => {
  it('keeps each part in its order, the enabled rows first', () => {
    const rows = [{ id: 'a', disabledReason: 'x' }, { id: 'b' }, { id: 'c', disabledReason: 'y' }, { id: 'd' }];
    expect(availableFirst(rows).map((part) => part.map((row) => row.id))).toEqual([
      ['b', 'd'],
      ['a', 'c'],
    ]);
  });
});
