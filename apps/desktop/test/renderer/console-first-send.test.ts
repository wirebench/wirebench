import { beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import {
  collapseConsoleInShortWindow,
  isFailedSend,
  subscribeConsoleToTrouble,
} from '../../src/renderer/state/console-first-send.js';
import { useProblemsStore, type Problem } from '../../src/renderer/state/problems.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { makeRestExchange } from '../mocks/wire-fixtures.js';

/** A REST send's log row that got `status` back. */
function answered(status: number): LogEntry {
  const exchange = makeRestExchange();
  return { kind: 'exchange', exchange: { ...exchange, http: { ...exchange.http, status } } } as unknown as LogEntry;
}
const ok = (): LogEntry => answered(200);
const notFound = (): LogEntry => answered(404);
const refused = (): LogEntry =>
  ({ kind: 'failure', failure: { code: 'connection-refused', message: 'Connection refused.' } }) as unknown as LogEntry;
const problem = (source: string): Problem =>
  ({ id: `p-${source}`, groupId: 'g', source, severity: 'error', message: 'Bad' }) as unknown as Problem;

describe('subscribeConsoleToTrouble (G07)', () => {
  beforeEach(() => {
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
    useExchangesStore.setState({ log: [] });
    useProblemsStore.setState({ items: [] });
  });

  it('names a refused send, a 4xx and a 5xx as failed, and a 200 as not', () => {
    expect(isFailedSend(refused())).toBe(true);
    expect(isFailedSend(notFound())).toBe(true);
    expect(isFailedSend(ok())).toBe(false);
  });

  it('leaves a fresh console collapsed on a send that worked', () => {
    const stop = subscribeConsoleToTrouble();
    useExchangesStore.setState({ log: [ok()] });
    stop();
    expect(useUiStore.getState().console.visible).toBe(false);
    expect(useUiStore.getState().console.openOnFirstSend).toBe(true);
  });

  it('opens a fresh console on the HTTP log for a failed send', () => {
    useUiStore.setState((state) => ({ console: { ...state.console, activeTab: 'problems' } }));
    const stop = subscribeConsoleToTrouble();
    useExchangesStore.setState({ log: [ok(), refused()] });
    stop();
    expect(useUiStore.getState().console.visible).toBe(true);
    expect(useUiStore.getState().console.activeTab).toBe('http-log');
  });

  it('opens a fresh console on Problems for a new problem, but not for a lint finding', () => {
    const stop = subscribeConsoleToTrouble();
    useProblemsStore.setState({ items: [problem('lint')] });
    expect(useUiStore.getState().console.visible).toBe(false);
    useProblemsStore.setState({ items: [problem('lint'), problem('validation')] });
    stop();
    expect(useUiStore.getState().console.visible).toBe(true);
    expect(useUiStore.getState().console.activeTab).toBe('problems');
  });

  it('leaves a console the user collapsed alone', () => {
    useUiStore.getState().expandConsole();
    useUiStore.getState().collapseConsole();
    const stop = subscribeConsoleToTrouble();
    useExchangesStore.setState({ log: [refused()] });
    stop();
    expect(useUiStore.getState().console.visible).toBe(false);
  });

  it('does nothing when the log is cleared', () => {
    useExchangesStore.setState({ log: [refused()] });
    const stop = subscribeConsoleToTrouble();
    useExchangesStore.setState({ log: [] });
    stop();
    expect(useUiStore.getState().console.visible).toBe(false);
  });

  it('keeps a fresh console collapsed when a failure lands in a short window (#636)', () => {
    let height = 700;
    const stop = subscribeConsoleToTrouble(() => height);
    useExchangesStore.setState({ log: [refused()] });
    expect(useUiStore.getState().console.visible).toBe(false);
    // The promise is kept: a later failure in a taller window opens it.
    height = 900;
    useExchangesStore.setState({ log: [refused(), refused()] });
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
