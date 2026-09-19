import { describe, expect, it } from 'vitest';
import type { CommandCatalogEntry } from '../apps/desktop/src/shared/command-catalog.ts';
import { renderCommandReference } from './docs-commands.ts';

const entries: readonly CommandCatalogEntry[] = [
  {
    id: 'palette.open',
    label: 'Show All Commands',
    category: 'General',
    shortcut: 'Mod+K',
    extraShortcuts: ['Mod+Shift+P'],
  },
  { id: 'view.toggleSidebar', label: 'Toggle Sidebar', category: 'View', shortcut: 'Mod+B' },
  { id: 'app.checkForUpdates', label: 'Check for Updates…', category: 'General' },
];

describe('renderCommandReference', () => {
  const page = renderCommandReference(entries);

  it('groups commands by category in first-appearance order', () => {
    expect(page.indexOf('## General')).toBeLessThan(page.indexOf('## View'));
    expect(page.match(/^## /gm)).toHaveLength(2);
    expect(page.indexOf('Check for Updates')).toBeLessThan(page.indexOf('## View'));
  });

  it('spells each shortcut for macOS and for Windows and Linux, rebindable one first', () => {
    expect(page).toContain(
      '| Show All Commands | <kbd>⌘K</kbd> or <kbd>⌘⇧P</kbd> | <kbd>Ctrl+K</kbd> or <kbd>Ctrl+Shift+P</kbd> |',
    );
  });

  it('lists commands without a shortcut with a dash', () => {
    expect(page).toContain('| Check for Updates… | — | — |');
  });

  it('escapes pipes in labels', () => {
    const piped = renderCommandReference([{ ...entries[2]!, label: 'A | B' }]);
    expect(piped).toContain('| A \\| B |');
  });
});
