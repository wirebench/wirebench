import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

describe('DiffView over two REST sides', () => {
  afterEach(() => {
    cleanup();
  });

  const rest = {
    response: { left: '200 OK\n\n{}', right: '404 Not Found\n\n{}' },
    request: { left: 'GET https://api.test/a\n\n', right: 'GET https://api.test/b\n\n' },
  };

  it('opens on the Response tab and switches to the Request tab', () => {
    render(<DiffView leftLabel="A" rightLabel="B" leftXml="{}" rightXml="{}" rest={rest} />);

    const views = screen.getByRole('tablist', { name: 'Compare views' });
    expect(within(views).getByRole('tab', { name: 'Response' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Original').value).toBe('200 OK\n\n{}');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Modified').value).toBe('404 Not Found\n\n{}');

    fireEvent.click(within(views).getByRole('tab', { name: 'Request' }));

    expect(within(views).getByRole('tab', { name: 'Request' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Original').value).toBe('GET https://api.test/a\n\n');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Modified').value).toBe('GET https://api.test/b\n\n');
  });

  it('goes back to the Response tab when the tab is reused for another comparison', () => {
    const { rerender } = render(<DiffView leftLabel="A" rightLabel="B" leftXml="{}" rightXml="{}" rest={rest} />);
    fireEvent.click(
      within(screen.getByRole('tablist', { name: 'Compare views' })).getByRole('tab', { name: 'Request' }),
    );

    const next = {
      response: { left: '201 Created\n\n{}', right: '500 Server Error\n\n{}' },
      request: { left: 'POST https://api.test/c\n\n', right: 'POST https://api.test/d\n\n' },
    };
    rerender(<DiffView leftLabel="C" rightLabel="D" leftXml="{}" rightXml="{}" rest={next} />);

    const views = screen.getByRole('tablist', { name: 'Compare views' });
    expect(within(views).getByRole('tab', { name: 'Response' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Original').value).toBe('201 Created\n\n{}');
  });

  it('shows one body diff and no tabs when the sides are not both REST', () => {
    render(<DiffView leftLabel="A" rightLabel="B" leftXml="<a/>" rightXml="<b/>" />);
    expect(screen.queryByRole('tablist', { name: 'Compare views' })).toBeNull();
  });
});
