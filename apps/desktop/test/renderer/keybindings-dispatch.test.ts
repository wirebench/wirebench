import { describe, expect, it } from 'vitest';
import { shouldIgnoreEvent } from '../../src/renderer/lib/keybindings.js';

function eventOn(element: Element, mod: boolean): KeyboardEvent {
  return { target: element, metaKey: mod, ctrlKey: false } as unknown as KeyboardEvent;
}

describe('shouldIgnoreEvent', () => {
  it('ignores unmodified keys typed inside editable fields', () => {
    const input = document.createElement('input');

    expect(shouldIgnoreEvent(eventOn(input, false), { key: 'b', mod: false, shift: false, alt: false })).toBe(true);
  });

  it('lets Mod-based bindings through editable fields', () => {
    const input = document.createElement('input');

    expect(shouldIgnoreEvent(eventOn(input, true), { key: 'b', mod: true, shift: false, alt: false })).toBe(false);
  });

  it('treats textareas, selects and contenteditable hosts as editable', () => {
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const binding = { key: 'b', mod: false, shift: false, alt: false } as const;

    expect(shouldIgnoreEvent(eventOn(textarea, false), binding)).toBe(true);
    expect(shouldIgnoreEvent(eventOn(select, false), binding)).toBe(true);
    expect(shouldIgnoreEvent(eventOn(editable, false), binding)).toBe(true);
  });

  it('ignores a bare chord typed inside Monaco', () => {
    // A user-recorded bare "k" must stay a letter in the XML editor, not run a command.
    const host = document.createElement('div');
    host.className = 'monaco-editor';
    const textarea = document.createElement('textarea');
    host.append(textarea);

    expect(shouldIgnoreEvent(eventOn(textarea, false), { key: 'k', mod: false, shift: false, alt: false })).toBe(true);
  });

  it('lets the four editor commands through Monaco on a bare chord', () => {
    const host = document.createElement('div');
    host.className = 'monaco-editor';
    const textarea = document.createElement('textarea');
    host.append(textarea);
    const escape = { key: 'escape', mod: false, shift: false, alt: false } as const;
    const altRight = { key: 'arrowright', mod: false, shift: false, alt: true } as const;
    const shiftTab = { key: 'tab', mod: false, shift: true, alt: false } as const;

    expect(shouldIgnoreEvent(eventOn(textarea, false), escape, 'request.cancel')).toBe(false);
    expect(shouldIgnoreEvent(eventOn(textarea, false), altRight, 'editor.nextValue')).toBe(false);
    expect(shouldIgnoreEvent(eventOn(textarea, false), altRight, 'editor.previousValue')).toBe(false);
    expect(shouldIgnoreEvent(eventOn(textarea, false), shiftTab, 'editor.focusOtherPane')).toBe(false);
  });

  it('lets a Mod chord through Monaco whatever the command', () => {
    const host = document.createElement('div');
    host.className = 'monaco-editor';
    const textarea = document.createElement('textarea');
    host.append(textarea);

    expect(
      shouldIgnoreEvent(eventOn(textarea, true), { key: 'enter', mod: true, shift: false, alt: false }, 'request.send'),
    ).toBe(false);
  });

  it('does not ignore keys pressed outside editable fields', () => {
    const div = document.createElement('div');

    expect(shouldIgnoreEvent(eventOn(div, false), { key: 'b', mod: false, shift: false, alt: false })).toBe(false);
  });
});
