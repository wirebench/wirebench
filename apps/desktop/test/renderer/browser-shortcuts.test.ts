/**
 * Browser-reserved keys (#896): a browser tab never sees ⌘W or ⌘⇧N, so the commands bound to them get
 * a browser default that works, Keyboard shortcuts marks a user binding the browser keeps, and the tab
 * asks before it unloads over unsaved edits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { COMMAND_CATALOG } from '@wirebench/wire/command-catalog';
import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { keymapRows } from '../../src/renderer/features/preferences/keymap.js';
import { effectiveShortcutFor, isBrowserReservedChord } from '../../src/renderer/lib/keybindings.js';
import { hasUnsavedEdits, onBeforeUnload } from '../../src/renderer/lib/unload-guard.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

function install(host: 'browser' | 'desktop'): void {
  const api = installWirebenchApi();
  if (host === 'browser') {
    Object.defineProperty(api, 'env', {
      configurable: true,
      value: { e2e: false, osTheme: 'dark', host: 'browser', capabilities: ['send:public'] },
    });
  }
  registerShellCommands(() => undefined);
}

const row = (overrides: Readonly<Record<string, string>>, id: string) =>
  keymapRows(overrides).find((candidate) => candidate.id === id);

describe('browser defaults for reserved keys', () => {
  it('gives Close Tab and New Project a key the browser passes on', () => {
    install('browser');
    expect(effectiveShortcutFor('editor.closeTab')).toBe('Alt+W');
    expect(effectiveShortcutFor('workspace.newProject')).toBe('Alt+Shift+N');
    expect(row({}, 'editor.closeTab')).toMatchObject({ defaultChord: 'Alt+W', chord: 'Alt+W', browserReserved: false });
  });

  it('keeps the desktop keys on the desktop', () => {
    install('desktop');
    expect(effectiveShortcutFor('editor.closeTab')).toBe('Mod+W');
    expect(effectiveShortcutFor('workspace.newProject')).toBe('Mod+Shift+N');
    expect(row({ 'editor.closeTab': 'Mod+T' }, 'editor.closeTab')?.browserReserved).toBe(false);
  });

  it('marks a binding the browser keeps in Keyboard shortcuts', () => {
    install('browser');
    expect(row({ 'editor.closeTab': 'Mod+W' }, 'editor.closeTab')).toMatchObject({
      chord: 'Mod+W',
      customized: true,
      browserReserved: true,
    });
  });

  it('leaves no command on a reserved key in a browser tab by default', () => {
    install('browser');
    const reserved = keymapRows({}).filter((candidate) => candidate.browserReserved);
    expect(reserved.map((candidate) => candidate.id)).toEqual([]);
  });

  it('never gives a browser default the browser keeps', () => {
    for (const entry of Object.values(COMMAND_CATALOG)) {
      if (entry.browserShortcut !== undefined)
        expect(isBrowserReservedChord(entry.browserShortcut), entry.id).toBe(false);
    }
  });
});

describe('the unload guard', () => {
  beforeEach(() => {
    useDraftsStore.getState().reset();
    useProjectStore.setState({ projects: {} });
  });

  afterEach(() => {
    useDraftsStore.getState().reset();
    useProjectStore.setState({ projects: {} });
  });

  function unload(): Event {
    const event = new Event('beforeunload', { cancelable: true });
    onBeforeUnload(event);
    return event;
  }

  it('lets a tab with nothing unsaved go', () => {
    expect(hasUnsavedEdits()).toBe(false);
    expect(unload().defaultPrevented).toBe(false);
  });

  it('asks while a request edit is staged', () => {
    useDraftsStore.getState().stageRestRequest('r1', { url: 'https://example.test' });
    expect(unload().defaultPrevented).toBe(true);
  });

  it('asks while a project is dirty', () => {
    useProjectStore.setState({
      projects: { p1: { dirty: true } as never },
    });
    expect(unload().defaultPrevented).toBe(true);
  });
});
