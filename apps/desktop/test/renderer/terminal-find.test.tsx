import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findCountLabel,
  isFindChord,
  TerminalFindBar,
  type FindResults,
  type TerminalFinder,
} from '../../src/renderer/features/ssh/terminal-find.js';

const find = vi.fn<TerminalFinder['find']>();
const clear = vi.fn<TerminalFinder['clear']>();
const finder: TerminalFinder = { find, clear };
const onClose = vi.fn();

beforeEach(() => {
  find.mockReset().mockReturnValue(true);
  clear.mockReset();
  onClose.mockReset();
});

afterEach(() => {
  cleanup();
});

const NONE = { caseSensitive: false, wholeWord: false, regex: false };

/** The bar with its owner's open state, so Escape really hides it. */
function Harness({ results, initiallyOpen = true }: { results?: FindResults; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [focus, setFocus] = useState(0);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setFocus((n) => n + 1);
        }}
      >
        chord
      </button>
      <TerminalFindBar
        open={open}
        focusRequest={focus}
        finder={finder}
        results={results}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      />
    </>
  );
}

const input = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Find', hidden: true });
const bar = () => screen.getByTestId('terminal-find');
const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('isFindChord', () => {
  it('is ⌘F on a Mac and Ctrl+F elsewhere', () => {
    expect(isFindChord(key({ key: 'f', metaKey: true }), 'mac')).toBe(true);
    expect(isFindChord(key({ key: 'F', metaKey: true }), 'mac')).toBe(true);
    expect(isFindChord(key({ key: 'f', ctrlKey: true }), 'linux')).toBe(true);
    expect(isFindChord(key({ key: 'f', ctrlKey: true }), 'win')).toBe(true);
  });

  it("leaves a Mac's Ctrl+F (forward-char) and every other key to the shell", () => {
    expect(isFindChord(key({ key: 'f', ctrlKey: true }), 'mac')).toBe(false);
    expect(isFindChord(key({ key: 'f', metaKey: true }), 'linux')).toBe(false);
    expect(isFindChord(key({ key: 'f' }), 'mac')).toBe(false);
    expect(isFindChord(key({ key: 'f', metaKey: true, shiftKey: true }), 'mac')).toBe(false);
    expect(isFindChord(key({ key: 'f', ctrlKey: true, altKey: true }), 'linux')).toBe(false);
    expect(isFindChord(key({ key: 'g', ctrlKey: true }), 'linux')).toBe(false);
  });
});

describe('findCountLabel', () => {
  it('reads the addon results', () => {
    expect(findCountLabel('', false, { index: 0, count: 3 })).toBe('');
    expect(findCountLabel('x', false, undefined)).toBe('');
    expect(findCountLabel('x', false, { index: -1, count: 0 })).toBe('No results');
    expect(findCountLabel('x', false, { index: 2, count: 12 })).toBe('3 of 12');
    expect(findCountLabel('x', false, { index: -1, count: 4 })).toBe('4 found');
    expect(findCountLabel('x', false, { index: 0, count: 1000 })).toBe('1 of 1000+');
    expect(findCountLabel('(', true, { index: 0, count: 3 })).toBe('Invalid pattern');
  });
});

describe('the terminal find bar', () => {
  it('is hidden while closed and takes focus when opened', () => {
    render(<Harness initiallyOpen={false} />);
    expect(bar().hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'chord' }));
    expect(bar().hidden).toBe(false);
    expect(document.activeElement).toBe(input());
  });

  it('searches as you type, incrementally, and clears on an empty query', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'err' } });
    expect(find).toHaveBeenLastCalledWith('next', 'err', NONE, true);
    fireEvent.change(input(), { target: { value: '' } });
    expect(clear).toHaveBeenCalled();
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('Enter finds the next match, Shift+Enter the previous; the arrows do the same', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'err' } });
    find.mockClear();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(find).toHaveBeenLastCalledWith('next', 'err', NONE, false);
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(find).toHaveBeenLastCalledWith('previous', 'err', NONE, false);
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(find).toHaveBeenLastCalledWith('previous', 'err', NONE, false);
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(find).toHaveBeenLastCalledWith('next', 'err', NONE, false);
  });

  it('the toggles show their state and search again with it', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'err' } });
    const matchCase = screen.getByRole('button', { name: 'Match case' });
    expect(matchCase.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(matchCase);
    expect(matchCase.getAttribute('aria-pressed')).toBe('true');
    expect(find).toHaveBeenLastCalledWith('next', 'err', { ...NONE, caseSensitive: true }, true);
    fireEvent.click(screen.getByRole('button', { name: 'Match whole word' }));
    expect(find).toHaveBeenLastCalledWith('next', 'err', { ...NONE, caseSensitive: true, wholeWord: true }, true);
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    expect(find).toHaveBeenLastCalledWith('next', 'err', { caseSensitive: true, wholeWord: true, regex: true }, true);
  });

  it('shows the count, and says so when a regex does not compile', () => {
    const { rerender } = render(<Harness results={{ index: 1, count: 5 }} />);
    fireEvent.change(input(), { target: { value: 'err' } });
    expect(screen.getByTestId('terminal-find-count').textContent).toBe('2 of 5');
    rerender(<Harness results={{ index: -1, count: 0 }} />);
    expect(screen.getByTestId('terminal-find-count').textContent).toBe('No results');

    find.mockReturnValue(false);
    fireEvent.change(input(), { target: { value: '(' } });
    expect(screen.getByTestId('terminal-find-count').textContent).toBe('Invalid pattern');
    expect(input().getAttribute('aria-invalid')).toBe('true');
  });

  it('Escape closes the bar and clears the highlights, without reaching the window', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'err' } });
    clear.mockClear();
    fireEvent.keyDown(input(), { key: 'Escape' });
    window.removeEventListener('keydown', onWindowKey);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bar().hidden).toBe(true);
    expect(clear).toHaveBeenCalled();
    expect(onWindowKey).not.toHaveBeenCalled();
  });

  it('reopening searches the same query again', () => {
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'err' } });
    fireEvent.keyDown(input(), { key: 'Escape' });
    find.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'chord' }));
    expect(find).toHaveBeenCalledWith('next', 'err', NONE, true);
    expect(input().value).toBe('err');
  });

  it('the find chord inside the bar selects the query and goes no further', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    render(<Harness />);
    fireEvent.change(input(), { target: { value: 'err' } });
    input().setSelectionRange(3, 3);
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    input().dispatchEvent(event);
    window.removeEventListener('keydown', onWindowKey);
    expect(event.defaultPrevented).toBe(true);
    expect(onWindowKey).not.toHaveBeenCalled();
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(3);
  });
});
