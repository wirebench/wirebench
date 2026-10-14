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
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useCaptureFocusStore } from '../../src/renderer/state/capture-focus.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import {
  mcpRequestWire,
  mcpServerWire,
  NO_REST,
  PROJECT_SETTINGS,
  restApiWire,
  restRequestWire,
  sequenceWire,
  wsApiWire,
  wsRequestWire,
} from '../helpers/wire-defaults.js';
import type { ProjectWire } from '../../src/shared/wire-types.js';
import type {
  CatchUrlWire,
  SequenceRunResultWire,
  SequenceStepResultWire,
  SequenceStepWire,
  SequenceWire,
} from '../../src/shared/wire-base.js';

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
    // A WebSocket session runs as a step, so it shows no problem.
    expect(within(steps[1]!).getByText('Live feed')).toBeTruthy();
    expect(within(steps[1]!).queryByTestId('sequence-step-problem')).toBeNull();
    expect(within(steps[2]!).getByTestId('sequence-step-problem').textContent).toBe('Missing request');
  });

  it('shows an MCP request as a step and offers one in Add step', () => {
    const withMcp = sequenceWire({
      steps: [
        { id: 'step-mcp', requestId: 'mcp-1', enabled: true, requestAssertions: true, transfers: [], assertions: [] },
      ],
    });
    useProjectStore.getState().applySnapshot('p1', {
      ...project(withMcp),
      mcpServers: [mcpServerWire({ name: 'Files' })],
      mcpRequests: [
        mcpRequestWire({
          name: 'Read a file',
          operation: { method: 'tools/call', tool: 'read_file', arguments: '{}' },
        }),
        mcpRequestWire({ id: 'mcp-2', name: 'List tools', operation: { method: 'tools/list' } }),
      ],
    });
    useProjectStore.setState({ updateSequence });
    render(
      <TooltipPrimitive.Provider>
        <SequenceTab sequenceId={withMcp.id} />
      </TooltipPrimitive.Provider>,
    );

    const [step] = screen.getAllByTestId('sequence-step');
    expect(within(step!).getByText('Read a file')).toBeTruthy();
    expect(within(step!).getByText('MCP')).toBeTruthy();
    expect(within(step!).queryByTestId('sequence-step-problem')).toBeNull();

    fireEvent.click(screen.getByTestId('sequence-add-step'));
    const items = screen.getAllByTestId('sequence-add-step-item');
    expect(items.map((item) => item.textContent)).toContain('MCPList toolsFiles/tools/list');
    fireEvent.click(items.find((item) => item.textContent?.includes('List tools'))!);
    expect(lastPatch().steps?.map((entry) => entry.requestId)).toEqual(['mcp-1', 'mcp-2']);
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

  it('adds a branch, turns it into a go-to, and drops go-tos to a step that is removed', () => {
    mount();
    fireEvent.click(screen.getByTestId('sequence-add-branch'));
    expect(lastPatch().steps?.[0]?.branches).toEqual([
      { when: { type: 'status', equals: 503 }, then: 'repeat', max: 5 },
    ]);

    // The store echoes each patch, as main would.
    const withRepeat = sequenceWire({
      steps: [{ ...LOGIN, branches: lastPatch().steps?.[0]?.branches ?? [] }, ...SEQUENCE.steps.slice(1)],
    });
    cleanup();
    mount(withRepeat);
    fireEvent.change(screen.getByTestId('sequence-branch-action'), { target: { value: 'goto' } });
    expect(lastPatch().steps?.[0]?.branches).toEqual([
      { when: { type: 'status', equals: 503 }, then: 'goto', step: 'step-ws', max: 5 },
    ]);

    const withGoto = sequenceWire({
      steps: [{ ...LOGIN, branches: lastPatch().steps?.[0]?.branches ?? [] }, ...SEQUENCE.steps.slice(1)],
    });
    cleanup();
    mount(withGoto);
    fireEvent.change(screen.getByTestId('sequence-branch-condition'), { target: { value: 'outcome' } });
    expect(lastPatch().steps?.[0]?.branches?.[0]?.when).toEqual({ type: 'outcome', equals: 'errored' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove step 2' }));
    expect(lastPatch().steps?.map((step) => [step.id, step.branches])).toEqual([
      ['step-login', undefined],
      ['step-gone', undefined],
    ]);
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

describe('a branching run in the run panel (#347)', () => {
  const base: SequenceStepResultWire = {
    index: 0,
    stepId: 'step-login',
    requestId: 'rest-login',
    name: 'Log in',
    protocol: 'rest',
    outcome: 'failed',
    status: 503,
    assertions: [],
    transfers: [],
  };
  const to = { index: 0, stepId: 'step-login', name: 'Log in' };

  it('shows every run of a step in order, the path each took, and which ones were retried', async () => {
    const unsubscribe = subscribeToSequenceProgress();
    mount();
    fireEvent.click(screen.getByTestId('sequence-run'));
    const { runId } = run.mock.calls[0]?.[0] as { runId: string };
    const first: SequenceStepResultWire = {
      ...base,
      retried: true,
      branch: { rule: 0, action: 'repeat', to, count: 1, max: 3 },
    };
    const second: SequenceStepResultWire = {
      ...base,
      outcome: 'passed',
      status: 200,
      attempt: 2,
      branch: { rule: 1, action: 'goto', to: { index: 2, stepId: 'step-gone', name: 'gone' }, count: 1, max: 1 },
    };
    const passed: SequenceStepResultWire = {
      ...base,
      index: 1,
      stepId: 'step-ws',
      requestId: 'ws-1',
      name: 'Live feed',
      outcome: 'skipped',
      skipped: 'branch',
    };
    for (const step of [first, second, passed]) {
      act(() => listeners.get('sequence.progress')?.({ runId, sequenceId: 'seq-1', step }));
    }
    const rows = screen.getAllByTestId('sequence-run-step');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.dataset['retried']).toBe('true');
    expect(within(rows[0]!).getByTestId('sequence-run-branch').textContent).toBe('→ repeat (1 of 3)');
    expect(within(rows[1]!).getByText('1. Log in (attempt 2)')).toBeTruthy();
    expect(within(rows[1]!).getByTestId('sequence-run-branch').textContent).toBe('→ 3. gone (1 of 1)');
    expect(rows[2]!.textContent).toContain('skipped (passed over by a branch)');
    // Two of the three steps have reported, whatever the number of runs.
    expect(screen.getByTestId('sequence-run-status').textContent).toBe('Running… 2 of 3');

    await act(async () => {
      resolveRun?.({
        runId,
        sequenceId: 'seq-1',
        name: 'Checkout',
        startedAt: '',
        outcome: 'passed',
        steps: [first, second, passed],
      });
      await Promise.resolve();
    });
    expect(screen.getAllByTestId('sequence-run-step')).toHaveLength(3);
    unsubscribe();
  });

  it('drops a progress event that arrives after the run has ended', () => {
    useSequenceRunsStore.setState({ runs: { 'seq-1': { runId: 'R', status: 'done', steps: [base] } } });
    useSequenceRunsStore.getState().applyProgress({ runId: 'R', sequenceId: 'seq-1', step: base });
    expect(useSequenceRunsStore.getState().runs['seq-1']!.steps).toHaveLength(1);
  });

  it('marks the earlier run of a step retried as soon as a later one reports', () => {
    useSequenceRunsStore.setState({ runs: { 'seq-1': { runId: 'R', status: 'running', steps: [] } } });
    const apply = useSequenceRunsStore.getState().applyProgress;
    apply({ runId: 'R', sequenceId: 'seq-1', step: base });
    apply({ runId: 'R', sequenceId: 'seq-1', step: { ...base, index: 1, stepId: 'step-ws' } });
    apply({ runId: 'R', sequenceId: 'seq-1', step: { ...base, attempt: 2 } });
    const steps = useSequenceRunsStore.getState().runs['seq-1']!.steps;
    expect(steps.map((step) => step.retried)).toEqual([true, undefined, undefined]);
  });
});

describe('callback assertions in the run panel (callback-assertion §5)', () => {
  const HOOK = '01K000000000000000000000H1';
  const CAPTURE = '01K00000000000000000000002';
  const CALLBACK_STEP: SequenceStepResultWire = {
    index: 0,
    stepId: 'step-login',
    requestId: 'rest-login',
    name: 'Log in',
    protocol: 'rest',
    outcome: 'passed',
    status: 200,
    durationMs: 12,
    origin: 'https://shop.test',
    assertions: [
      {
        type: 'callback',
        label: 'callback orders-hook',
        outcome: 'passed',
        message: `matched capture ${CAPTURE} after 2.0 s`,
        capture: { hookId: HOOK, captureId: CAPTURE },
      },
    ],
    transfers: [],
  };

  afterEach(() => {
    useWebhooksStore.setState({ hooks: [] });
    useCaptureFocusStore.setState({ focus: undefined });
    useEditorsStore.getState().reset();
  });

  it('says what a step waits for, then shows the passed callback with its message and a link', async () => {
    const unsubscribe = subscribeToSequenceProgress();
    mount();
    fireEvent.click(screen.getByTestId('sequence-run'));
    const runId = (run.mock.calls[0]![0] as { runId: string }).runId;

    act(() =>
      listeners.get('sequence.waiting')?.({
        runId,
        sequenceId: 'seq-1',
        index: 0,
        stepId: 'step-login',
        waiting: [{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 30_000 }],
      }),
    );
    // P7: the row names the catch URL, not the assertion's label.
    expect(screen.getByTestId('sequence-run-waiting').textContent).toBe('1. waiting for orders-hook… (up to 30 s)');

    act(() => listeners.get('sequence.progress')?.({ runId, sequenceId: 'seq-1', step: CALLBACK_STEP }));
    expect(screen.queryByTestId('sequence-run-waiting')).toBeNull();
    const assertion = screen.getByTestId('sequence-run-assertion');
    expect(assertion.dataset['type']).toBe('callback');
    expect(assertion.dataset['outcome']).toBe('passed');
    expect(assertion.textContent).toContain(`matched capture ${CAPTURE} after 2.0 s`);

    act(() => useWebhooksStore.setState({ hooks: [{ id: HOOK, name: 'orders-hook' } as CatchUrlWire] }));
    fireEvent.click(screen.getByTestId('sequence-run-capture-link'));
    expect(useCaptureFocusStore.getState().focus).toEqual({ hookId: HOOK, captureId: CAPTURE });
    expect(JSON.stringify(useEditorsStore.getState())).toContain(`catch-url:${HOOK}`);

    await act(async () => {
      resolveRun?.({
        runId,
        sequenceId: 'seq-1',
        name: 'Checkout',
        startedAt: '',
        outcome: 'passed',
        steps: [CALLBACK_STEP],
      });
      await Promise.resolve();
    });
    unsubscribe();
  });

  it('drops a waiting event for another run, and disables the link for a catch URL not in the workspace (P10)', async () => {
    const unsubscribe = subscribeToSequenceProgress();
    mount();
    fireEvent.click(screen.getByTestId('sequence-run'));
    const runId = (run.mock.calls[0]![0] as { runId: string }).runId;

    act(() =>
      listeners.get('sequence.waiting')?.({
        runId: 'other',
        sequenceId: 'seq-1',
        index: 0,
        stepId: 'step-login',
        waiting: [{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 30_000 }],
      }),
    );
    expect(screen.queryByTestId('sequence-run-waiting')).toBeNull();

    act(() => listeners.get('sequence.progress')?.({ runId, sequenceId: 'seq-1', step: CALLBACK_STEP }));
    // The catch URL is not in the open workspace: the link is disabled and says why; the id stays.
    const link = screen.getByTestId<HTMLButtonElement>('sequence-run-capture-link');
    expect(link.disabled).toBe(true);
    expect(link.title).toBe('This catch URL isn’t in the open workspace');
    expect(screen.getByTestId('sequence-run-assertion').textContent).toContain(CAPTURE);
    fireEvent.click(link);
    expect(useCaptureFocusStore.getState().focus).toBeUndefined();
    expect(JSON.stringify(useEditorsStore.getState())).not.toContain(`catch-url:${HOOK}`);

    // Once the workspace lists it, the link works.
    act(() => useWebhooksStore.setState({ hooks: [{ id: HOOK, name: 'orders-hook' } as CatchUrlWire] }));
    expect(link.disabled).toBe(false);
    expect(link.title).toBe('');

    await act(async () => {
      resolveRun?.({
        runId,
        sequenceId: 'seq-1',
        name: 'Checkout',
        startedAt: '',
        outcome: 'passed',
        steps: [CALLBACK_STEP],
      });
      await Promise.resolve();
    });
    unsubscribe();
  });
});
