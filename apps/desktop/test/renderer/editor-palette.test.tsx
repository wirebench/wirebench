/**
 * The editors wear the colour theme: both Monaco wrappers pick their registered theme from the
 * resolved mode and `ui.palette`, and re-theme when either changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { CodeEditor } from '../../src/renderer/editor/code-editor.js';
import { DiffXmlEditor } from '../../src/renderer/editor/diff-xml-editor.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

afterEach(() => {
  cleanup();
  act(() => {
    useUiStore.setState({ theme: 'dark' });
    useUiStore.getState().setPalette('default');
  });
});

describe('editor colour theme', () => {
  it("keeps Default's theme names with no colour theme chosen", () => {
    act(() => {
      useUiStore.setState({ theme: 'light' });
    });
    render(<CodeEditor value="" language="xml" ariaLabel="Body" />);
    expect(screen.getByLabelText('Body').dataset['theme']).toBe('wirebench-light');
  });

  it('the code editor follows the colour theme and the mode', () => {
    render(<CodeEditor value="" language="xml" ariaLabel="Body" />);
    act(() => {
      useUiStore.getState().setPalette('sandstone');
    });
    expect(screen.getByLabelText('Body').dataset['theme']).toBe('wirebench-sandstone-dark');
    act(() => {
      useUiStore.setState({ theme: 'light' });
    });
    expect(screen.getByLabelText('Body').dataset['theme']).toBe('wirebench-sandstone-light');
  });

  it('the diff editor follows the colour theme', () => {
    act(() => {
      useUiStore.getState().setPalette('rind');
    });
    render(<DiffXmlEditor original="<a/>" modified="<b/>" renderSideBySide ignoreTrimWhitespace={false} />);
    expect(screen.getByTestId('diff-editor').dataset['theme']).toBe('wirebench-rind-dark');
  });
});
