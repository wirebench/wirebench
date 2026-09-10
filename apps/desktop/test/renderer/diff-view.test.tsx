import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DiffView } from '../../src/renderer/features/history/diff-view.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

describe('DiffView', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders both labels and passes pretty-printed originals to the diff editor', () => {
    render(
      <DiffView
        leftLabel="Send at 10:00:00"
        rightLabel="Send at 10:05:00"
        leftXml="<a><b>1</b></a>"
        rightXml="<a><b>2</b></a>"
      />,
    );

    expect(screen.getByText('Send at 10:00:00')).toBeDefined();
    expect(screen.getByText('Send at 10:05:00')).toBeDefined();

    const original = screen.getByLabelText<HTMLTextAreaElement>('Original');
    const modified = screen.getByLabelText<HTMLTextAreaElement>('Modified');
    // format-xml.ts re-indents, so a pretty-printed original spans more than one line.
    expect(original.value.split('\n').length).toBeGreaterThan(1);
    expect(original.value).toContain('<b>1</b>');
    expect(modified.value).toContain('<b>2</b>');
  });

  it('toggles side-by-side and ignore-whitespace checkboxes', () => {
    render(<DiffView leftLabel="A" rightLabel="B" leftXml="<a/>" rightXml="<b/>" />);

    const sideBySide = screen.getByLabelText<HTMLInputElement>('Side by side');
    const ignoreWs = screen.getByLabelText<HTMLInputElement>('Ignore whitespace');
    expect(sideBySide.checked).toBe(true);
    expect(ignoreWs.checked).toBe(true);
  });
});
