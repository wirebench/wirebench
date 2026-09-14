import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { registerShellCommands } from '../../src/renderer/commands/register-shell-commands.js';
import { chordIdentity, keymapRows, resetValueFor } from '../../src/renderer/features/preferences/keymap.js';
import { chordFromEvent } from '../../src/renderer/lib/keybindings.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const rowFor = (rows: ReturnType<typeof keymapRows>, id: string) => rows.find((row) => row.id === id);

describe('chordIdentity', () => {
  it('ignores modifier order and key case', () => {
    expect(chordIdentity('Mod+Shift+F')).toBe(chordIdentity('Shift+Mod+f'));
  });

  it('separates chords that differ by a modifier', () => {
    expect(chordIdentity('Mod+S')).not.toBe(chordIdentity('Mod+Shift+S'));
  });
});

describe('chordFromEvent', () => {
  const event = (init: Partial<KeyboardEvent>): KeyboardEvent => init as KeyboardEvent;

  it('records the modifiers and the key', () => {
    expect(chordFromEvent(event({ key: 's', metaKey: true, shiftKey: true }), 'mac')).toBe('Mod+Shift+S');
  });

  it('uses Ctrl as Mod off macOS', () => {
    expect(chordFromEvent(event({ key: 'k', ctrlKey: true }), 'win')).toBe('Mod+K');
    expect(chordFromEvent(event({ key: 'k', metaKey: true }), 'win')).toBe('K');
  });

  it('spells the named keys the way the registry does', () => {
    expect(chordFromEvent(event({ key: 'Enter', metaKey: true }), 'mac')).toBe('Mod+Enter');
    expect(chordFromEvent(event({ key: 'ArrowLeft', altKey: true }), 'mac')).toBe('Alt+Left');
    expect(chordFromEvent(event({ key: '\\', metaKey: true }), 'mac')).toBe('Mod+Backslash');
  });

  it('is not a chord while only modifiers are held', () => {
    expect(chordFromEvent(event({ key: 'Shift', shiftKey: true }), 'mac')).toBeUndefined();
    expect(chordFromEvent(event({ key: 'Meta', metaKey: true }), 'mac')).toBeUndefined();
  });
});

describe('keymapRows', () => {
  beforeEach(() => {
    installWirebenchApi();
    registerShellCommands(() => undefined);
  });

  it('lists every command with its default binding', () => {
    const rows = keymapRows({});

    expect(rows.length).toBeGreaterThan(60);
    expect(rowFor(rows, 'request.send')).toMatchObject({
      defaultChord: 'Mod+Enter',
      chord: 'Mod+Enter',
      customized: false,
      conflictsWith: [],
    });
  });

  it('shows an override as the chord in force, and marks the row customized', () => {
    const row = rowFor(keymapRows({ 'request.send': 'Mod+Shift+Enter' }), 'request.send');

    expect(row).toMatchObject({ defaultChord: 'Mod+Enter', chord: 'Mod+Shift+Enter', customized: true });
  });

  it('treats an empty override as unbound', () => {
    expect(rowFor(keymapRows({ 'request.send': '' }), 'request.send')?.chord).toBeUndefined();
  });

  it('does not call an override that restates the default a customization', () => {
    expect(rowFor(keymapRows({ 'request.send': 'Mod+Enter' }), 'request.send')?.customized).toBe(false);
  });

  it('flags both sides of a conflict', () => {
    const rows = keymapRows({ 'request.validate': 'Mod+Enter' });

    expect(rowFor(rows, 'request.validate')?.conflictsWith).toEqual(['Send Request']);
    expect(rowFor(rows, 'request.send')?.conflictsWith).toEqual(['Validate Request']);
  });

  it('reports no conflicts for the shipped keymap', () => {
    expect(keymapRows({}).filter((row) => row.conflictsWith.length > 0)).toEqual([]);
  });

  it('names the winner and its condition in the conflict note', () => {
    const rows = keymapRows({ 'request.validate': 'Mod+Enter' });

    // Both are gated on `editor.request`, so they really do compete; the dispatcher walks
    // (category, label) order, where "Send Request" precedes "Validate Request".
    expect(rowFor(rows, 'request.validate')?.conflictNote).toBe(
      'Also bound to Send Request (Send Request wins while a request tab is active)',
    );
  });

  it('does not call a shared chord a conflict when the two can never both be live', () => {
    // `explorer.newRequest` needs an operation selected; `request.send` needs a request tab
    // active. Their `when` scopes do not overlap, so sharing ⌘⏎ is not a clash.
    const rows = keymapRows({ 'explorer.newRequest': 'Mod+Enter' });

    expect(rowFor(rows, 'explorer.newRequest')?.conflictsWith).toEqual([]);
    expect(rowFor(rows, 'request.send')?.conflictsWith).toEqual([]);
    expect(rowFor(rows, 'request.send')?.conflictNote).toBeUndefined();
  });

  it('treats an ungated command as overlapping everything', () => {
    const rows = keymapRows({ 'view.toggleSidebar': 'Mod+Enter' });

    // Both send commands carry ⌘⏎, and an ungated command overlaps either of them.
    expect(rowFor(rows, 'view.toggleSidebar')?.conflictsWith).toEqual(['Send Request', 'Send REST Request']);
    expect(rowFor(rows, 'request.send')?.conflictsWith).toEqual(['Toggle Sidebar']);
    expect(rowFor(rows, 'rest.send')?.conflictsWith).toEqual(['Toggle Sidebar']);
  });

  it('treats a narrower scope as overlapping the wider one it sits inside', () => {
    // `editor.closeTab` is gated on `editor`; `request.send` on `editor.request`, which is a
    // narrower condition inside it — whenever a request tab is active, a tab is open.
    const rows = keymapRows({ 'editor.closeTab': 'Mod+Enter' });

    expect(rowFor(rows, 'editor.closeTab')?.conflictsWith).toEqual(['Send Request', 'Send REST Request']);
  });

  it('ignores an unparseable override rather than throwing', () => {
    expect(() => keymapRows({ 'request.send': 'Mod+' })).not.toThrow();
  });
});

describe('resetValueFor', () => {
  beforeEach(() => {
    installWirebenchApi();
    registerShellCommands(() => undefined);
  });

  it('restates the shipped chord', () => {
    expect(resetValueFor(rowFor(keymapRows({ 'request.send': 'Mod+J' }), 'request.send')!)).toBe('Mod+Enter');
  });

  it('unbinds a command that ships without one', () => {
    expect(resetValueFor(rowFor(keymapRows({ 'app.checkForUpdates': 'Mod+Y' }), 'app.checkForUpdates')!)).toBe('');
  });
});
