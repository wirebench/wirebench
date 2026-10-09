/**
 * The mock tab (#59): each committed edit is one mock change, Start and Stop go through `mock.*`, the
 * running URL shows, a request the mock answered appears in the log with its problems, and the stubs the
 * contract does not allow are listed (#325).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { MockTab } from '../../src/renderer/features/mock/mock-tab.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useMockRunsStore } from '../../src/renderer/state/mock-runs.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { NO_REST, PROJECT_SETTINGS } from '../helpers/wire-defaults.js';
import type { MockCheckResponse, MockExchangeEventWire, MockWire, ProjectWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const MOCK: MockWire = {
  id: 'm1',
  name: 'Orders mock',
  slug: 'Orders mock',
  order: 0,
  source: { containerId: 'api-1' },
  port: 8089,
  path: '/orders',
  validation: 'reject',
  operations: [
    {
      id: 'o1',
      name: 'createOrder',
      slug: 'createOrder',
      order: 0,
      operation: 'post /orders',
      dispatch: 'sequence',
      defaultResponseId: 'r1',
      responses: [
        {
          id: 'r1',
          name: 'Created',
          slug: 'Created',
          order: 0,
          status: 201,
          headers: [],
          delayMs: 0,
          body: 'json',
          bodyText: '{"id":1}',
          match: [],
        },
        {
          id: 'r2',
          name: 'Full',
          slug: 'Full',
          order: 1,
          status: 503,
          headers: [{ name: 'Retry-After', value: '5' }],
          delayMs: 0,
          body: 'none',
          bodyText: '',
          match: [],
        },
      ],
    },
  ],
};

function project(): ProjectWire {
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
    mocks: [MOCK],
  };
}

const updateMock = vi.fn();
const updateMockOperation = vi.fn();
const updateMockResponse = vi.fn();
const start = vi.fn();
const stop = vi.fn();
const check = vi.fn();

function mount(): void {
  useProjectStore.getState().applySnapshot('p1', project());
  useProjectStore.setState({ updateMock, updateMockOperation, updateMockResponse });
  render(
    <TooltipPrimitive.Provider>
      <MockTab mockId="m1" />
    </TooltipPrimitive.Provider>,
  );
}

beforeEach(() => {
  useProjectStore.getState().reset();
  useMockRunsStore.setState({ states: {}, logs: {}, busy: {} });
  for (const fn of [updateMock, updateMockOperation, updateMockResponse]) fn.mockReset().mockResolvedValue(undefined);
  start.mockReset().mockResolvedValue({
    ok: true,
    value: { mockId: 'm1', running: true, url: 'http://127.0.0.1:8089/orders', exposed: false, warnings: [] },
  });
  stop.mockReset().mockResolvedValue({ ok: true, value: { stopped: true } });
  check.mockReset().mockResolvedValue({ ok: true, value: { checked: 2, findings: [] } });
  useProblemsStore.setState({ items: [] });
  installWirebenchApi({
    mock: {
      start,
      stop,
      check,
      reset: vi.fn(),
      states: vi.fn().mockResolvedValue({ ok: true, value: { states: [] } }),
    },
  });
});

afterEach(() => cleanup());

function commit(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe('MockTab', () => {
  it('commits a settings edit as one update-mock', () => {
    mount();
    commit(screen.getByTestId('mock-path'), '/v2');
    expect(updateMock).toHaveBeenLastCalledWith('m1', { path: '/v2' });
    fireEvent.change(screen.getByTestId('mock-validation'), { target: { value: 'report' } });
    expect(updateMock).toHaveBeenLastCalledWith('m1', { validation: 'report' });
  });

  it('edits the operation and the selected response', () => {
    mount();
    fireEvent.change(screen.getByTestId('mock-dispatch'), { target: { value: 'random' } });
    expect(updateMockOperation).toHaveBeenLastCalledWith('m1', 'o1', { dispatch: 'random' });

    fireEvent.click(screen.getAllByTestId('mock-response-select')[1]!);
    commit(screen.getByTestId('mock-response-status'), '500');
    expect(updateMockResponse).toHaveBeenLastCalledWith('m1', 'o1', 'r2', { status: 500 });
    expect(screen.getByText('This response sends no body.')).toBeTruthy();

    commit(screen.getByTestId('mock-scenario-name'), 'stock');
    expect(updateMockResponse).toHaveBeenLastCalledWith('m1', 'o1', 'r2', { scenario: { name: 'stock' } });
  });

  it('starts and stops through mock.*, showing where it listens', async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-start'));
      await Promise.resolve();
    });
    expect(start).toHaveBeenCalledWith({ mockId: 'm1' });
    expect(screen.getByTestId('mock-url').textContent).toBe('http://127.0.0.1:8089/orders');
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-stop'));
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalledWith({ mockId: 'm1' });
    expect(screen.queryByTestId('mock-url')).toBeNull();
  });

  it('lists a request it answered, with its problems, and clears the log', () => {
    mount();
    const event: MockExchangeEventWire = {
      mockId: 'm1',
      seq: 1,
      at: '2026-10-08T10:00:00.000Z',
      method: 'POST',
      url: '/orders',
      operation: 'post /orders',
      status: 400,
      durationMs: 3,
      problems: [{ code: 'mock-request-invalid', message: 'is below the minimum 1', in: 'body', path: '/qty' }],
      request: { headers: [['authorization', '•••']], body: '{"qty":0}', truncated: false },
      response: { headers: [], body: '{}', truncated: false },
    };
    act(() => {
      useMockRunsStore.getState().applyExchange(event);
    });
    const row = screen.getByTestId('mock-log-row');
    expect(within(row).getByTestId('mock-log-status').textContent).toBe('400');
    expect(within(row).getByTestId('mock-log-problems').textContent).toContain('1 problem');
    fireEvent.click(row);
    expect(screen.getByTestId('mock-log-detail').textContent).toContain('is below the minimum 1');
    fireEvent.click(screen.getByTestId('mock-log-clear'));
    expect(screen.queryByTestId('mock-log-row')).toBeNull();
  });

  it('checks the stubs against the contract and lists the ones that do not conform', async () => {
    const broken: MockCheckResponse = {
      checked: 2,
      findings: [
        {
          operationId: 'o1',
          operationName: 'createOrder',
          operation: 'post /orders',
          responseId: 'r2',
          responseName: 'Full',
          status: 503,
          problems: [{ code: 'mock-stub-invalid', message: 'The contract declares no 503 response', in: 'status' }],
        },
      ],
    };
    mount();
    expect(await screen.findByText('All 2 stubs conform to the contract.')).toBeTruthy();
    expect(check).toHaveBeenCalledWith({ mockId: 'm1' });

    check.mockResolvedValue({ ok: true, value: broken });
    fireEvent.click(screen.getByTestId('mock-stub-check-run'));
    expect(await screen.findByText('1 of 2 stubs do not conform to the contract.')).toBeTruthy();
    const finding = screen.getByTestId('mock-stub-finding');
    expect(finding.textContent).toContain('createOrder › Full');
    expect(finding.textContent).toContain('The contract declares no 503 response');
    expect(useProblemsStore.getState().items).toEqual([
      {
        groupId: 'mock-stubs:m1',
        source: 'mock',
        severity: 'error',
        problem: {
          code: 'mock-stub-invalid',
          message: 'Orders mock › createOrder › Full: The contract declares no 503 response',
          location: 'status',
        },
      },
    ]);

    check.mockResolvedValue({ ok: false, error: { code: 'mock-definition-missing', message: 'Not cached' } });
    fireEvent.click(screen.getByTestId('mock-stub-check-run'));
    expect(await screen.findByText('Not cached')).toBeTruthy();
    expect(useProblemsStore.getState().items).toEqual([]);
  });

  it('says so when the mock is gone', () => {
    useProjectStore.getState().reset();
    render(<MockTab mockId="missing" />);
    expect(screen.getByText('This mock is no longer in the project.')).toBeTruthy();
  });
});
