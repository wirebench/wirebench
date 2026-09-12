import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CommandPalette } from '../../src/renderer/shell/command-palette.js';
import { registerCommand, resetCommands } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';

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
});
