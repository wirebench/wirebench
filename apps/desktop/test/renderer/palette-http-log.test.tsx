import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommandPalette, rankGroups } from '../../src/renderer/shell/command-palette.js';
import { resetCommands } from '../../src/renderer/lib/commands.js';
import type { CommandContext } from '../../src/renderer/lib/commands.js';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { CommandCategory } from '@wirebench/wire/commands';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';

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

/**
 * "HTTP Log" + Enter used to run the command that reveals credentials in the log, with no question
 * asked. The log itself must be what that search lands on.
 */
describe('palette search for "HTTP Log"', () => {
  beforeEach(() => {
    resetCommands();
    installWirebenchApi();
    // Every command, registered the way the app does, so the order is the one Enter would run.
    registerShellCommands(() => undefined);
  });

  afterEach(() => {
    cleanup();
    resetCommands();
  });

  it('selects Show HTTP Log, ranked above Reveal Secrets in HTTP Log…', async () => {
    render(<CommandPalette open onOpenChange={() => undefined} context={context} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'HTTP Log' } });

    // The palette sorts after the query settles, so wait for the order rather than read it at once.
    await waitFor(() => {
      const labels = screen.getAllByRole('option').map((option) => option.textContent ?? '');
      const show = labels.findIndex((label) => label.includes('Show HTTP Log'));
      const reveal = labels.findIndex((label) => label.includes('Reveal Secrets in HTTP Log…'));
      expect(show).toBeGreaterThanOrEqual(0);
      expect(reveal).toBeGreaterThan(show);
      expect(screen.getByRole('option', { selected: true }).textContent).toContain('Show HTTP Log');
    });
  });
});

describe('rankGroups', () => {
  type Group = readonly [CommandCategory, readonly { readonly category: string; readonly label: string }[]];
  const groups: readonly Group[] = [
    ['Secrets', [{ category: 'Secrets', label: 'Reveal Secrets in HTTP Log…' }]],
    ['View', [{ category: 'View', label: 'Show HTTP Log' }]],
  ];

  it('puts the group holding the best match first', () => {
    expect(rankGroups(groups, 'HTTP Log').map(([category]) => category)).toEqual(['View', 'Secrets']);
  });

  it('keeps the given order with no search', () => {
    expect(rankGroups(groups, '  ')).toBe(groups);
  });
});
