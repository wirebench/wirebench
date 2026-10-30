import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { COMMAND_CATALOG } from '@wirebench/wire/command-catalog';
import { CommandPalette, quietGroupsLast } from '../../src/renderer/shell/command-palette.js';
import { paletteFilter, paletteKeywords } from '../../src/renderer/shell/palette-filter.js';
import { pushRecent, recentCommandIds, recordRecentCommand } from '../../src/renderer/shell/recent-commands.js';
import { registerCommand, resetCommands } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';

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

/** The group headings in the order the palette shows them. */
function headings(): string[] {
  return Array.from(document.querySelectorAll('[cmdk-group-heading]')).map((heading) => heading.textContent ?? '');
}

describe('The empty palette (G05)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetCommands();
    registerCommand({
      id: 'account.signIn',
      label: 'Account: Sign in to a server…',
      category: 'Account',
      run: () => {},
    });
    registerCommand({ id: 'project.save', label: 'Save All', category: 'Project', run: () => {} });
    registerCommand({ id: 'view.showSettings', label: 'Show Settings', category: 'View', run: () => {} });
  });

  afterEach(() => {
    cleanup();
    resetCommands();
    window.localStorage.clear();
  });

  it('keeps the newest run first, without duplicates, up to five', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['f', 'a', 'b', 'c', 'd']);
    recordRecentCommand('project.save');
    recordRecentCommand('view.showSettings');
    expect(recentCommandIds()).toEqual(['view.showSettings', 'project.save']);
  });

  it('reads an unreadable store as no recent commands', () => {
    window.localStorage.setItem('wirebench.palette.recentCommands', '{not json');
    expect(recentCommandIds()).toEqual([]);
  });

  it('does not lead with Account when nothing was run yet', () => {
    render(<CommandPalette open onOpenChange={() => undefined} context={context} />);
    expect(headings()).toEqual(['Project', 'View', 'Account']);
    expect(screen.queryByTestId('palette-recent-group')).toBeNull();
  });

  it('leads with the commands run lately, and remembers a command run from it', () => {
    recordRecentCommand('view.showSettings');
    const { rerender } = render(<CommandPalette open onOpenChange={() => undefined} context={context} />);

    expect(headings()[0]).toBe('Recently used');
    expect(screen.getAllByTestId('palette-recent-command').map((row) => row.textContent)).toEqual(['Show Settings']);

    fireEvent.click(screen.getByText('Save All'));
    rerender(<CommandPalette open={false} onOpenChange={() => undefined} context={context} />);
    rerender(<CommandPalette open onOpenChange={() => undefined} context={context} />);
    expect(screen.getAllByTestId('palette-recent-command').map((row) => row.textContent)).toEqual([
      'Save All',
      'Show Settings',
    ]);
  });

  it('hides the recent group once something is typed', () => {
    recordRecentCommand('view.showSettings');
    render(<CommandPalette open onOpenChange={() => undefined} context={context} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'save' } });
    expect(screen.queryByTestId('palette-recent-group')).toBeNull();
  });

  it('moves only the quiet categories to the end', () => {
    const groups = [
      ['Account', []],
      ['General', []],
      ['View', []],
    ] as const;
    expect(quietGroupsLast(groups).map(([category]) => category)).toEqual(['General', 'View', 'Account']);
  });
});

describe('Preferences: Keyboard Shortcuts (G05)', () => {
  const command = COMMAND_CATALOG['preferences.keyboardShortcuts'];
  const score = (search: string): number =>
    paletteFilter(`${command.category} ${command.label}`, search, paletteKeywords(command));

  it('is a palette command found by its name and by "keys" and "bindings"', () => {
    expect(command.label).toBe('Preferences: Keyboard Shortcuts');
    expect(score('shortcuts')).toBeGreaterThan(0);
    expect(score('keys')).toBeGreaterThan(0);
    expect(score('bindings')).toBeGreaterThan(0);
  });
});
