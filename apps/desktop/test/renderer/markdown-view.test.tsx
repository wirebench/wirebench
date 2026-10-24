import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MarkdownView, safeHref } from '../../src/renderer/components/markdown-view.js';

afterEach(() => {
  cleanup();
});

function view(source: string): HTMLElement {
  render(<MarkdownView source={source} />);
  return screen.getByTestId('markdown-view');
}

describe('MarkdownView', () => {
  it('renders headings, lists, code and tables', () => {
    const root = view(
      ['# Title', '', '1. one', '2. two', '', '- a', '', '`inline`', '', '| A | B |', '| - | - |', '| 1 | 2 |'].join(
        '\n',
      ),
    );
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelectorAll('ol li')).toHaveLength(2);
    expect(root.querySelectorAll('ul li')).toHaveLength(1);
    expect(root.querySelector('code')?.textContent).toBe('inline');
    expect(root.querySelectorAll('td')).toHaveLength(2);
  });

  it('renders no raw HTML from the text', () => {
    const root = view('Hello <script>alert(1)</script> <b>bold</b> <img src="https://evil.test/x.png">');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.innerHTML).not.toContain('evil.test');
  });

  it('never loads an image, and shows its alt text instead', () => {
    const root = view('![the diagram](https://evil.test/track.png)');
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('the diagram');
    expect(root.innerHTML).not.toContain('evil.test');
  });

  it('drops a javascript: link but keeps its text', () => {
    const root = view('[click](javascript:alert(1))');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('click');
  });

  it('opens a web link outside the app', () => {
    const root = view('[docs](https://example.test/docs)');
    const link = root.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.test/docs');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noreferrer');
  });
});

describe('safeHref', () => {
  it('keeps http and https only', () => {
    expect(safeHref('https://a.test')).toBe('https://a.test');
    expect(safeHref('HTTP://a.test')).toBe('HTTP://a.test');
    expect(safeHref('mailto:x@a.test')).toBe('');
    expect(safeHref('file:///etc/passwd')).toBe('');
    expect(safeHref('data:text/html,x')).toBe('');
    expect(safeHref('/relative')).toBe('');
  });
});
