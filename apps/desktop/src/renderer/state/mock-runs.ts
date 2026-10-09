/**
 * Running mocks as the explorer and the mock tab show them (#59): each mock's state, and the requests
 * it answered this session. Nothing here is persisted; every event arrived from main already masked.
 */
import { create } from 'zustand';
import { showToast } from '../components/toast.js';
import type { MockExchangeEventWire, MockStateEvent } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/** How many requests a mock's log keeps; older ones fall off the end. */
export const MOCK_LOG_LIMIT = 500;

interface MockRunsStore {
  /** Each mock's latest state, by mock id. Absent means stopped and never started this session. */
  readonly states: Readonly<Record<string, MockStateEvent>>;
  /** Each mock's requests, newest last. */
  readonly logs: Readonly<Record<string, readonly MockExchangeEventWire[]>>;
  /** A start or stop in flight, by mock id, so a button cannot be pressed twice. */
  readonly busy: Readonly<Record<string, boolean>>;
  readonly start: (mockId: string) => Promise<void>;
  readonly stop: (mockId: string) => Promise<void>;
  readonly reset: (mockId: string) => Promise<void>;
  readonly clearLog: (mockId: string) => void;
  readonly applyState: (event: MockStateEvent) => void;
  readonly applyExchange: (event: MockExchangeEventWire) => void;
}

function withBusy(busy: Readonly<Record<string, boolean>>, mockId: string, value: boolean): Record<string, boolean> {
  const next = { ...busy };
  if (value) next[mockId] = true;
  else delete next[mockId];
  return next;
}

export const useMockRunsStore = create<MockRunsStore>((set, get) => ({
  states: {},
  logs: {},
  busy: {},

  start: async (mockId) => {
    if (get().busy[mockId] === true) return;
    set((state) => ({ busy: withBusy(state.busy, mockId, true) }));
    const result = await ipc().mock.start({ mockId });
    set((state) => ({
      busy: withBusy(state.busy, mockId, false),
      ...(result.ok ? { states: { ...state.states, [mockId]: result.value } } : {}),
    }));
    if (!result.ok) {
      showToast(`The mock could not start: ${result.error.message}`);
    }
  },

  stop: async (mockId) => {
    if (get().busy[mockId] === true) return;
    set((state) => ({ busy: withBusy(state.busy, mockId, true) }));
    const result = await ipc().mock.stop({ mockId });
    set((state) => ({
      busy: withBusy(state.busy, mockId, false),
      states: { ...state.states, [mockId]: { mockId, running: false, warnings: [] } },
    }));
    if (!result.ok) {
      showToast(`The mock could not stop: ${result.error.message}`);
    }
  },

  reset: async (mockId) => {
    const result = await ipc().mock.reset({ mockId });
    if (!result.ok) {
      showToast(`The mock's state could not be reset: ${result.error.message}`);
    }
  },

  clearLog: (mockId) => {
    set((state) => ({ logs: { ...state.logs, [mockId]: [] } }));
  },

  applyState: (event) => {
    set((state) => ({ states: { ...state.states, [event.mockId]: event } }));
  },

  applyExchange: (event) => {
    set((state) => {
      const current = state.logs[event.mockId] ?? [];
      const kept = current.length >= MOCK_LOG_LIMIT ? current.slice(current.length - MOCK_LOG_LIMIT + 1) : current;
      return { logs: { ...state.logs, [event.mockId]: [...kept, event] } };
    });
  },
}));

/** Whether `mockId` is running now. */
export function isMockRunning(states: Readonly<Record<string, MockStateEvent>>, mockId: string): boolean {
  return states[mockId]?.running === true;
}

/** Subscribes the explorer and the mock tabs to `mock.state` and `mock.exchange`. Called once from the shell. */
export function subscribeToMocks(): () => void {
  const offState = window.wirebench.on('mock.state', ((payload: MockStateEvent) => {
    useMockRunsStore.getState().applyState(payload);
  }) as (payload: unknown) => void);
  const offExchange = window.wirebench.on('mock.exchange', ((payload: MockExchangeEventWire) => {
    useMockRunsStore.getState().applyExchange(payload);
  }) as (payload: unknown) => void);
  // A reloaded renderer learns which of its mocks are still running.
  void ipc()
    .mock.states({})
    .then((result) => {
      if (result.ok) {
        for (const state of result.value.states) useMockRunsStore.getState().applyState(state);
      }
    });
  return () => {
    offState();
    offExchange();
  };
}
