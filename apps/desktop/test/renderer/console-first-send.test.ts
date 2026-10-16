import { beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import {
  collapseConsoleInShortWindow,
  subscribeConsoleToFirstSend,
} from '../../src/renderer/state/console-first-send.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

const entry = { kind: 'exchange' } as unknown as LogEntry;

describe('subscribeConsoleToFirstSend', () => {
  beforeEach(() => {
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
    useExchangesStore.setState({ log: [] });
  });

  it('opens a fresh console when the log gains its first row', () => {
    const stop = subscribeConsoleToFirstSend();
    useExchangesStore.setState({ log: [entry] });
    stop();
    expect(useUiStore.getState().console.visible).toBe(true);
  });

  it('leaves a console the user collapsed alone', () => {
    useUiStore.getState().expandConsole();
    useUiStore.getState().collapseConsole();
    const stop = subscribeConsoleToFirstSend();
    useExchangesStore.setState({ log: [entry] });
    stop();
    expect(useUiStore.getState().console.visible).toBe(false);
  });

  it('does nothing when the log is cleared', () => {
    useExchangesStore.setState({ log: [entry] });
    const stop = subscribeConsoleToFirstSend();
    useExchangesStore.setState({ log: [] });
    stop();
    expect(useUiStore.getState().console.visible).toBe(false);
  });

  it('keeps a fresh console collapsed when the first send lands in a short window (#636)', () => {
    let height = 700;
    const stop = subscribeConsoleToFirstSend(() => height);
    useExchangesStore.setState({ log: [entry] });
    expect(useUiStore.getState().console.visible).toBe(false);
    // The promise is kept: a later send in a taller window opens it.
    height = 900;
    useExchangesStore.setState({ log: [entry, entry] });
    stop();
    expect(useUiStore.getState().console.visible).toBe(true);
  });
});

describe('collapseConsoleInShortWindow (#636)', () => {
  beforeEach(() => {
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
  });

  function fakeWindow(innerHeight: number) {
    const target = new EventTarget() as EventTarget & { innerHeight: number };
    target.innerHeight = innerHeight;
    const resize = (height: number): void => {
      target.innerHeight = height;
      target.dispatchEvent(new Event('resize'));
    };
    return { target, resize };
  }

  it('collapses an open console as the window shrinks, and reopens it as it grows back', () => {
    const { target, resize } = fakeWindow(900);
    useUiStore.getState().expandConsole();
    const stop = collapseConsoleInShortWindow(target);

    resize(700);
    expect(useUiStore.getState().console.visible).toBe(false);
    resize(680);
    expect(useUiStore.getState().console.visible).toBe(false);
    resize(900);
    stop();
    expect(useUiStore.getState().console.visible).toBe(true);
  });

  it('leaves a console the user opened in the short window, and one they closed', () => {
    const { target, resize } = fakeWindow(900);
    useUiStore.getState().expandConsole();
    const stop = collapseConsoleInShortWindow(target);

    resize(700);
    useUiStore.getState().expandConsole();
    resize(690);
    expect(useUiStore.getState().console.visible).toBe(true);

    resize(900);
    useUiStore.getState().collapseConsole();
    resize(700);
    resize(900);
    stop();
    expect(useUiStore.getState().console.visible).toBe(false);
  });
});
