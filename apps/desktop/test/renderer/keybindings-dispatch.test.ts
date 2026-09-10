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

  it('does not ignore keys pressed outside editable fields', () => {
    const div = document.createElement('div');

    expect(shouldIgnoreEvent(eventOn(div, false), { key: 'b', mod: false, shift: false, alt: false })).toBe(false);
  });
});
