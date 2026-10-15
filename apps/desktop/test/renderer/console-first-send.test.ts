import { beforeEach, describe, expect, it } from 'vitest';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { subscribeConsoleToFirstSend } from '../../src/renderer/state/console-first-send.js';
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
});
