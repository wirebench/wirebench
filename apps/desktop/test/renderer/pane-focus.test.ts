import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { setActiveRequestEditor } from '../../src/renderer/editor/active-request-editor.js';
import { setActiveResponseEditor } from '../../src/renderer/editor/active-response-editor.js';
import { focusOtherPane } from '../../src/renderer/features/request-editor/pane-focus.js';

interface FakeEditor {
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  readonly focus: ReturnType<typeof vi.fn>;
}

function fakeEditor(focused: boolean): FakeEditor {
  const focus = vi.fn();
  return {
    editor: { hasTextFocus: () => focused, focus } as unknown as Monaco.editor.IStandaloneCodeEditor,
    focus,
  };
}

afterEach(() => {
  setActiveRequestEditor(undefined);
  setActiveResponseEditor(undefined);
});

describe('focusOtherPane', () => {
  it('moves focus from the request editor to the response editor', () => {
    const request = fakeEditor(true);
    const response = fakeEditor(false);
    setActiveRequestEditor(request.editor);
    setActiveResponseEditor(response.editor);

    expect(focusOtherPane()).toBe(true);
    expect(response.focus).toHaveBeenCalled();
    expect(request.focus).not.toHaveBeenCalled();
  });

  it('moves focus from the response editor back to the request editor', () => {
    const request = fakeEditor(false);
    const response = fakeEditor(true);
    setActiveRequestEditor(request.editor);
    setActiveResponseEditor(response.editor);

    expect(focusOtherPane()).toBe(true);
    expect(request.focus).toHaveBeenCalled();
  });

  it('focuses the request editor when neither pane holds focus', () => {
    const request = fakeEditor(false);
    const response = fakeEditor(false);
    setActiveRequestEditor(request.editor);
    setActiveResponseEditor(response.editor);

    expect(focusOtherPane()).toBe(true);
    expect(request.focus).toHaveBeenCalled();
  });

  it('stays in the request editor when no response is mounted', () => {
    const request = fakeEditor(true);
    setActiveRequestEditor(request.editor);

    expect(focusOtherPane()).toBe(true);
    expect(request.focus).toHaveBeenCalled();
  });

  it('reports false when no editor is mounted at all', () => {
    expect(focusOtherPane()).toBe(false);
  });
});
