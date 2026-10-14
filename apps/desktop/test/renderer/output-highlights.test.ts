import type { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { attachOutputHighlights } from '../../src/renderer/features/ssh/output-highlights.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';

/** One cell of a fake buffer line: a character, and whether the remote program coloured it. */
interface FakeCell {
  readonly chars: string;
  readonly coloured: boolean;
}

/** `[text, coloured]` pieces into the cells of one row. */
function row(...pieces: [string, boolean][]): FakeCell[] {
  return pieces.flatMap(([text, coloured]) => [...text].map((chars) => ({ chars, coloured })));
}

/** Just enough of xterm for the highlights: a viewport of rows, markers and decorations, and its events. */
function fakeTerminal(rows: FakeCell[][], type: 'normal' | 'alternate' = 'normal') {
  const decorations: { x: number; width: number; foregroundColor: string; disposed: boolean }[] = [];
  const parsed: (() => void)[] = [];
  const term = {
    rows: rows.length,
    options: { theme: { red: '#ff0000', yellow: '#ffff00', blue: '#0000ff', cyan: '#00ffff' } },
    buffer: {
      active: {
        type,
        viewportY: 0,
        baseY: 0,
        cursorY: 0,
        getLine: (y: number) => {
          const cells = rows[y];
          if (cells === undefined) return undefined;
          return {
            length: cells.length,
            getCell: (x: number) => {
              const cell = cells[x];
              if (cell === undefined) return undefined;
              return {
                getChars: () => cell.chars,
                getWidth: () => 1,
                isFgDefault: () => !cell.coloured,
                isBgDefault: () => true,
                isInverse: () => 0,
              };
            },
          };
        },
      },
    },
    registerMarker: () => ({ dispose: () => undefined }),
    registerDecoration: (options: { x: number; width: number; foregroundColor: string }) => {
      const entry = { ...options, disposed: false };
      decorations.push(entry);
      return {
        onRender: () => ({ dispose: () => undefined }),
        dispose: () => {
          entry.disposed = true;
        },
      };
    },
    onWriteParsed: (listener: () => void) => {
      parsed.push(listener);
      return { dispose: () => undefined };
    },
    onScroll: () => ({ dispose: () => undefined }),
    onResize: () => ({ dispose: () => undefined }),
  };
  return {
    term: term as unknown as Terminal,
    live: () =>
      decorations.filter((d) => !d.disposed).map(({ x, width, foregroundColor }) => ({ x, width, foregroundColor })),
    write: () => {
      for (const listener of parsed) listener();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
});

afterEach(() => {
  vi.useRealTimers();
});

it('colours words and addresses in the default colours from the terminal palette', () => {
  const fake = fakeTerminal([row(['ERROR from 10.0.0.1', false]), row(['warning: info', false])]);
  attachOutputHighlights(fake.term);
  vi.advanceTimersToNextFrame();
  expect(fake.live()).toEqual([
    { x: 0, width: 5, foregroundColor: '#ff0000' },
    { x: 11, width: 8, foregroundColor: '#00ffff' },
    { x: 0, width: 7, foregroundColor: '#ffff00' },
    { x: 9, width: 4, foregroundColor: '#0000ff' },
  ]);
});

it('leaves text the remote program coloured alone', () => {
  const fake = fakeTerminal([row(['error', true], [' and ', false], ['fail', false])]);
  attachOutputHighlights(fake.term);
  vi.advanceTimersToNextFrame();
  expect(fake.live()).toEqual([{ x: 10, width: 4, foregroundColor: '#ff0000' }]);
});

it('leaves full-screen programs alone', () => {
  const fake = fakeTerminal([row(['error', false])], 'alternate');
  attachOutputHighlights(fake.term);
  vi.advanceTimersToNextFrame();
  expect(fake.live()).toEqual([]);
});

it('takes every highlight away when the preference goes off, and paints again once a frame after writes', () => {
  const fake = fakeTerminal([row(['error', false])]);
  const highlights = attachOutputHighlights(fake.term);
  vi.advanceTimersToNextFrame();
  expect(fake.live()).toHaveLength(1);

  fake.write();
  fake.write();
  vi.advanceTimersToNextFrame();
  expect(fake.live()).toHaveLength(1);

  usePreferencesStore.setState({
    preferences: {
      ...DEFAULT_PREFERENCES_WIRE,
      terminal: { ...DEFAULT_PREFERENCES_WIRE.terminal, highlightOutput: false },
    },
  });
  vi.advanceTimersToNextFrame();
  expect(fake.live()).toEqual([]);

  highlights.dispose();
});
