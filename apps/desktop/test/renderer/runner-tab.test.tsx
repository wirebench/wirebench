/**
 * The Runner tab (#336): it shows the target's requests in run order with its data file's name and
 * columns, saves each change of order, exclusion and setting, fills its results request by request,
 * grouped by iteration, and reopens a past run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RunnerTab, resultMark, summaryText } from '../../src/renderer/features/runner/runner-tab.js';
import { dataColumnsFor, subscribeToRunnerProgress, useRunnerStore } from '../../src/renderer/state/runner.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { RunnerRequestResult, RunnerRunResult, RunnerSettings, RunnerState } from '@wirebench/wire/runner-wire';

const SETTINGS: RunnerSettings = { delayMs: 0, overrun: 'stop', bail: false, order: [], excluded: [] };

const STATE: RunnerState = {
  targetId: 'api-1',
  kind: 'api',
  name: 'Shop',
  settings: SETTINGS,
  requests: [
    { id: 'login', name: 'Log in', path: 'Shop/Log in', protocol: 'rest' },
    // Named as an import used to name a request with no summary: by its method and path.
    { id: 'me', name: 'GET /me', path: 'Shop/GET /me', protocol: 'rest', method: 'GET' },
  ],
  data: { name: 'users.csv', columns: ['user', 'password'], rows: 2 },
};

function result(name: string, index: number, outcome: RunnerRequestResult['outcome']): RunnerRequestResult {
  return {
    path: `Shop/${name}`,
    name,
    protocol: 'rest',
    outcome,
    status: outcome === 'passed' ? 200 : 500,
    assertions: [{ type: 'status', label: 'status is 200', outcome: outcome === 'passed' ? 'passed' : 'failed' }],
    iteration: { index, count: 2, row: index },
  };
}

const RUN: RunnerRunResult = {
  runId: 'r-old',
  targetId: 'api-1',
  name: 'Shop',
  startedAt: '2026-10-11T10:00:00.000Z',
  dataFile: 'users.csv',
  cancelled: false,
  summary: {
    total: 2,
    passed: 1,
    failed: 1,
    errored: 0,
    skipped: 0,
    durationMs: 12,
    iterations: { planned: 2, run: 2 },
  },
  requests: [result('Log in', 0, 'passed'), result('Log in', 1, 'failed')],
};

const listeners = new Map<string, (payload: unknown) => void>();
const setSettings = vi.fn();
const run = vi.fn();
const historyGet = vi.fn();
let resolveRun: ((value: RunnerRunResult) => void) | undefined;

beforeEach(() => {
  useRunnerStore.setState({ targets: {}, loadErrors: {}, runs: {}, history: {}, viewing: {} });
  listeners.clear();
  setSettings.mockReset().mockResolvedValue({ ok: true, value: { ok: true } });
  run.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRun = (value) => resolve({ ok: true, value });
      }),
  );
  historyGet.mockReset().mockResolvedValue({ ok: true, value: { run: RUN } });
  installWirebenchApi({
    runner: {
      state: vi.fn().mockResolvedValue({ ok: true, value: STATE }),
      settings: { set: setSettings },
      data: {
        choose: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }),
        clear: vi.fn().mockResolvedValue({ ok: true, value: { ok: true } }),
      },
      run,
      cancel: vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } }),
      history: {
        list: vi.fn().mockResolvedValue({
          ok: true,
          value: { runs: [{ runId: 'r-old', startedAt: RUN.startedAt, cancelled: false, summary: RUN.summary }] },
        }),
        get: historyGet,
      },
    },
    on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return vi.fn();
    }),
  });
});

afterEach(() => cleanup());

async function mount(): Promise<void> {
  render(<RunnerTab targetId="api-1" />);
  await screen.findByTestId('runner-tab');
}

describe('RunnerTab', () => {
  it('lists the requests in run order and names the data file, never its path', async () => {
    await mount();
    // The method shows once, in the badge, not again at the start of the name (#633).
    expect(screen.getAllByTestId('method-badge').map((badge) => badge.textContent)).toEqual(['GET']);
    expect(screen.getAllByTestId('runner-request').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Shop/Log in'),
      expect.stringContaining('Shop › /me'),
    ]);
    expect(screen.getByTestId('runner-data').textContent).toBe('users.csv — 2 rows: user, password');
    expect(screen.getByTestId('runner-iterations').getAttribute('placeholder')).toBe('One per row (2)');
  });

  it('saves a request left out, a request moved, and stop on first failure', async () => {
    await mount();
    fireEvent.click(screen.getAllByTestId('runner-request-include')[1]!);
    expect(setSettings).toHaveBeenLastCalledWith({ targetId: 'api-1', settings: { ...SETTINGS, excluded: ['me'] } });
    fireEvent.click(screen.getAllByTestId('runner-request-down')[0]!);
    expect(setSettings).toHaveBeenLastCalledWith({
      targetId: 'api-1',
      settings: expect.objectContaining({ order: ['me', 'login'] }) as RunnerSettings,
    });
    fireEvent.click(screen.getByTestId('runner-bail'));
    expect(setSettings).toHaveBeenLastCalledWith({
      targetId: 'api-1',
      settings: expect.objectContaining({ bail: true }) as RunnerSettings,
    });
  });

  it('fills the results request by request, grouped by iteration', async () => {
    const unsubscribe = subscribeToRunnerProgress();
    await mount();
    fireEvent.click(screen.getByTestId('runner-run'));
    expect(screen.getByTestId('runner-stop')).toBeTruthy();
    const runId = (run.mock.calls[0]![0] as { runId: string }).runId;

    act(() => {
      listeners.get('runner.progress')?.({ runId, targetId: 'api-1', request: result('Log in', 0, 'passed') });
      listeners.get('runner.progress')?.({ runId, targetId: 'api-1', request: result('Log in', 1, 'failed') });
    });
    const iterations = screen.getAllByTestId('runner-iteration');
    expect(iterations.map((section) => within(section).getByRole('heading').textContent)).toEqual([
      'Iteration 1/2 (row 1)',
      'Iteration 2/2 (row 2)',
    ]);
    expect(within(iterations[1]!).getByTestId('runner-result').getAttribute('data-outcome')).toBe('failed');

    await act(async () => {
      resolveRun?.({ ...RUN, runId });
      await Promise.resolve();
    });
    expect(screen.getByTestId('runner-status').textContent).toBe('1 passed, 1 failed, 0 errored, 2 iterations, 12 ms');
    unsubscribe();
  });

  it('opens a past run, and goes back to the latest', async () => {
    await mount();
    fireEvent.click(await screen.findByTestId('runner-history-entry'));
    expect(historyGet).toHaveBeenCalledWith({ targetId: 'api-1', runId: 'r-old' });
    expect((await screen.findAllByTestId('runner-result')).length).toBe(2);
    fireEvent.click(screen.getByTestId('runner-view-close'));
    expect(screen.getByTestId('runner-empty')).toBeTruthy();
  });

  it('lists and reports an MCP server’s requests: no status, the MCP result check shown', async () => {
    installWirebenchApi({
      runner: {
        state: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            ...STATE,
            data: undefined,
            requests: [{ id: 'mcp-1', name: 'Read a file', path: 'Files/Read a file', protocol: 'mcp' }],
          },
        }),
        run,
        history: { list: vi.fn().mockResolvedValue({ ok: true, value: { runs: [] } }), get: historyGet },
      },
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
    });
    const unsubscribe = subscribeToRunnerProgress();
    await mount();
    expect(screen.getByTestId('runner-request').textContent).toContain('mcp');
    fireEvent.click(screen.getByTestId('runner-run'));
    const runId = (run.mock.calls[0]![0] as { runId: string }).runId;

    act(() => {
      listeners.get('runner.progress')?.({
        runId,
        targetId: 'api-1',
        request: {
          requestId: 'mcp-1',
          path: 'Files/Read a file',
          name: 'Read a file',
          protocol: 'mcp',
          outcome: 'failed',
          durationMs: 8,
          assertions: [
            { type: 'mcp', label: 'MCP result', outcome: 'failed', expected: 'no error', actual: 'No such file' },
          ],
        } satisfies RunnerRequestResult,
      });
    });
    const row = screen.getByTestId('runner-result');
    expect(row.getAttribute('data-outcome')).toBe('failed');
    expect(row.querySelector('summary')?.textContent).toBe('✗Files/Read a file8 ms');
    expect(within(row).getByTestId('runner-result-assertion').textContent).toContain('MCP result');
    unsubscribe();
  });
});

describe('summaryText (#637)', () => {
  const base = { total: 12, passed: 12, failed: 0, errored: 0, skipped: 0, durationMs: 40 };

  it('counts passes without checks apart from checked ones', () => {
    expect(summaryText({ ...base, unchecked: 9 }, false)).toBe(
      '3 passed, 0 failed, 0 errored, 9 without checks, 40 ms',
    );
  });

  it('reads a run saved before the count as every pass checked', () => {
    expect(summaryText(base, false)).toBe('12 passed, 0 failed, 0 errored, 40 ms');
  });
});

describe('the row error (#637)', () => {
  it('reads as the send error panel does: title and message, the code small', async () => {
    const errored: RunnerRequestResult = {
      path: 'Shop/Delete pet',
      name: 'Delete pet',
      protocol: 'rest',
      outcome: 'errored',
      assertions: [],
      error: { code: 'rest-url-incomplete', message: 'The URL still needs a value for {id}' },
    };
    historyGet.mockResolvedValue({ ok: true, value: { run: { ...RUN, requests: [errored] } } });
    await mount();
    fireEvent.click(await screen.findByTestId('runner-history-entry'));
    const error = await screen.findByTestId('runner-result-error');
    expect(error.textContent).toBe('Incomplete URL: The URL still needs a value for {id} rest-url-incomplete');
    expect(within(error).getByTestId('runner-result-error-code').textContent).toBe('rest-url-incomplete');
  });
});

describe('resultMark (#560)', () => {
  const checked = [{ type: 'status', label: 'status is 200', outcome: 'passed' as const }];

  it('gives the green tick only to a request whose checks passed', () => {
    expect(resultMark({ outcome: 'passed', status: 200, assertions: checked })).toMatchObject({
      mark: '✓',
      tone: 'text-status-success',
    });
  });

  it('marks a request with no checks neutral, not passed', () => {
    expect(resultMark({ outcome: 'passed', status: 200, assertions: [] })).toMatchObject({
      mark: '○',
      tone: 'text-fg-subtle',
    });
    expect(resultMark({ outcome: 'passed', assertions: [] }).tone).toBe('text-fg-subtle');
  });

  it('marks a 4xx or 5xx with no checks amber', () => {
    for (const status of [404, 500]) {
      const mark = resultMark({ outcome: 'passed', status, assertions: [] });
      expect(mark).toMatchObject({ mark: '!', tone: 'text-status-warning' });
      expect(mark.label).toContain(String(status));
    }
  });

  it('keeps the failed, errored and skipped marks', () => {
    expect(resultMark({ outcome: 'failed', status: 500, assertions: checked }).mark).toBe('✗');
    expect(resultMark({ outcome: 'errored', assertions: [] })).toMatchObject({
      mark: '!',
      tone: 'text-status-danger',
    });
    expect(resultMark({ outcome: 'skipped', assertions: [] }).mark).toBe('–');
  });

  it('gives a request the columns of every open target that runs it with a readable data file', () => {
    const other: RunnerState = {
      ...STATE,
      targetId: 'folder-1',
      requests: [{ id: 'me', name: 'Me', path: 'Shop/Me', protocol: 'rest' }],
      data: { name: 'more.csv', columns: ['password', 'otp'], rows: 1 },
    };
    const broken: RunnerState = {
      ...STATE,
      targetId: 'folder-2',
      data: { name: 'gone.csv', columns: ['x'], rows: 0, error: { code: 'data-file-unreadable', message: 'gone' } },
    };
    const targets = { [STATE.targetId]: STATE, [other.targetId]: other, [broken.targetId]: broken };
    expect(dataColumnsFor(targets, 'me')).toEqual(['user', 'password', 'otp']);
    expect(dataColumnsFor(targets, 'login')).toEqual(['user', 'password']);
    expect(dataColumnsFor(targets, 'elsewhere')).toEqual([]);
    expect(dataColumnsFor(targets, undefined)).toEqual([]);
  });

  it('teaches the ${#Data#column} form in the hint (D1, #569)', async () => {
    await mount();
    expect(screen.getByTestId('runner-tab').textContent).toContain('${#Data#column}');
    expect(screen.getByTestId('runner-tab').textContent).not.toContain('${column}');
  });
});
