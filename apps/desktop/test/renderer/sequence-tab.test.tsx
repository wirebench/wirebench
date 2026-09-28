/**
 * The sequence tab: each step shows its request (or why it cannot run), each committed edit sends one
 * `update-sequence` with the steps replaced whole, and a run fills the panel step by step, showing a
 * secret transfer as secret and never as a value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { SequenceTab } from '../../src/renderer/features/sequence/sequence-tab.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { subscribeToSequenceProgress, useSequenceRunsStore } from '../../src/renderer/state/sequence-runs.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import {
  NO_REST,
  PROJECT_SETTINGS,
  restApiWire,
  restRequestWire,
  sequenceWire,
  wsApiWire,
  wsRequestWire,
} from '../helpers/wire-defaults.js';
import type {
  ProjectWire,
  SequenceRunResultWire,
  SequenceStepResultWire,
  SequenceStepWire,
  SequenceWire,
} from '../../src/shared/wire-types.js';

const updateSequence = vi.fn();

const LOGIN: SequenceStepWire = {
  id: 'step-login',
  requestId: 'rest-login',
  enabled: true,
  requestAssertions: true,
  transfers: [{ name: 'token', from: 'body', language: 'jsonpath', expression: '$.token', secret: true }],
  assertions: [],
};

const SEQUENCE: SequenceWire = sequenceWire({
  steps: [
    LOGIN,
    { id: 'step-ws', requestId: 'ws-1', enabled: true, requestAssertions: true, transfers: [], assertions: [] },
    { id: 'step-gone', requestId: 'gone', enabled: true, requestAssertions: true, transfers: [], assertions: [] },
  ],
});

function project(sequence: SequenceWire = SEQUENCE): ProjectWire {
  return {
    ...NO_REST,
    settings: PROJECT_SETTINGS,
    id: 'p1',
    name: 'Shop',
    dir: '/tmp/shop',
    dirty: false,
    interfaces: [],
    requests: [],
    properties: {},
    disabledProperties: [],
    environments: [],
    problems: [],
    keystores: [],
    wssOutgoing: [],
    wssIncoming: [],
    apis: [restApiWire({ id: 'api-1', name: 'Shop API' })],
    restRequests: [restRequestWire({ id: 'rest-login', name: 'Log in', method: 'POST' })],
    wsApis: [wsApiWire({ id: 'ws-api-1' })],
    wsRequests: [wsRequestWire({ id: 'ws-1', apiId: 'ws-api-1', name: 'Live feed' })],
    sequences: [sequence],
  };
}

const listeners = new Map<string, (payload: unknown) => void>();
let resolveRun: ((value: SequenceRunResultWire) => void) | undefined;
const run = vi.fn();

function mount(sequence: SequenceWire = SEQUENCE): void {
  useProjectStore.getState().applySnapshot('p1', project(sequence));
  useProjectStore.setState({ updateSequence });
  render(
    <TooltipPrimitive.Provider>
      <SequenceTab sequenceId={sequence.id} />
    </TooltipPrimitive.Provider>,
  );
}

beforeEach(() => {
  useProjectStore.getState().reset();
  useSequenceRunsStore.setState({ runs: {} });
  updateSequence.mockReset().mockResolvedValue(undefined);
  listeners.clear();
  run.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRun = (value) => resolve({ ok: true, value });
      }),
  );
  installWirebenchApi({
    sequence: { run, cancel: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }) },
    on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return vi.fn();
    }),
  });
});

afterEach(() => cleanup());

const lastPatch = (): { steps?: SequenceWire['steps']; name?: string } =>
  updateSequence.mock.calls.at(-1)?.[1] as { steps?: SequenceWire['steps']; name?: string };

describe('SequenceTab', () => {
  it('shows each step’s request, and why a step cannot run', () => {
    mount();
    const steps = screen.getAllByTestId('sequence-step');
    expect(steps).toHaveLength(3);
    expect(within(steps[0]!).getByText('Log in')).toBeTruthy();
    expect(within(steps[0]!).getByText('POST')).toBeTruthy();
    expect(within(steps[0]!).queryByTestId('sequence-step-problem')).toBeNull();
    expect(within(steps[1]!).getByTestId('sequence-step-problem').textContent).toBe(
      'A WebSocket request cannot be a step',
    );
    expect(within(steps[2]!).getByTestId('sequence-step-problem').textContent).toBe('Missing request');
  });

  it('sends the whole step list with a step disabled, removed or moved', () => {
    mount();
    fireEvent.click(screen.getAllByTestId('sequence-step-enabled')[0]!);
    expect(lastPatch().steps?.map((step) => step.enabled)).toEqual([false, true, true]);

    fireEvent.click(screen.getByRole('button', { name: 'Move step 1 down' }));
    expect(lastPatch().steps?.map((step) => step.id)).toEqual(['step-ws', 'step-login', 'step-gone']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove step 3' }));
    expect(lastPatch().steps?.map((step) => step.id)).toEqual(['step-login', 'step-ws']);
  });

  it('edits the selected step’s transfers and assertions', () => {
    mount();
    expect(screen.getAllByTestId('sequence-transfer-row')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('sequence-add-transfer'));
    expect(lastPatch().steps?.[0]?.transfers).toEqual([
      LOGIN.transfers[0],
      { name: 'value', from: 'body', language: 'jsonpath', expression: '$' },
    ]);

    fireEvent.click(screen.getByTestId('sequence-add-assertion'));
    expect(lastPatch().steps?.[0]?.assertions).toEqual([{ type: 'status', equals: 200 }]);
  });

  it('renames the sequence', () => {
    mount();
    const name = screen.getByTestId('sequence-name');
    fireEvent.change(name, { target: { value: 'Pay' } });
    fireEvent.blur(name);
    expect(updateSequence).toHaveBeenCalledWith('seq-1', { name: 'Pay' });
  });

  it('runs, fills the panel as steps report, and shows a secret transfer only as secret', async () => {
    const unsubscribe = subscribeToSequenceProgress();
    mount();
    fireEvent.click(screen.getByTestId('sequence-run'));
    expect(run).toHaveBeenCalledWith({ sequenceId: 'seq-1', runId: expect.any(String) as string });
    const { runId } = run.mock.calls[0]?.[0] as { runId: string };
    expect(screen.getByTestId('sequence-cancel')).toBeTruthy();

    const step: SequenceStepResultWire = {
      index: 0,
      stepId: 'step-login',
      requestId: 'rest-login',
      name: 'Log in',
      protocol: 'rest',
      outcome: 'passed',
      status: 200,
      durationMs: 12,
      origin: 'https://shop.test',
      assertions: [],
      transfers: [{ name: 'token', outcome: 'set', secret: true }],
    };
    act(() => listeners.get('sequence.progress')?.({ runId, sequenceId: 'seq-1', step }));
    expect(screen.getByTestId('sequence-run-status').textContent).toBe('Running… 1 of 3');
    expect(screen.getByTestId('sequence-run-transfer').textContent).toBe('→ token = (secret)');

    // An event for another run is not this one's.
    act(() =>
      listeners.get('sequence.progress')?.({ runId: 'other', sequenceId: 'seq-1', step: { ...step, index: 1 } }),
    );
    expect(screen.getAllByTestId('sequence-run-step')).toHaveLength(1);

    await act(async () => {
      resolveRun?.({ runId, sequenceId: 'seq-1', name: 'Checkout', startedAt: '', outcome: 'passed', steps: [step] });
      await Promise.resolve();
    });
    expect(screen.getByTestId('sequence-run-status').textContent).toBe('Run passed');
    expect(screen.getByTestId('sequence-run')).toBeTruthy();
    unsubscribe();
  });
});
