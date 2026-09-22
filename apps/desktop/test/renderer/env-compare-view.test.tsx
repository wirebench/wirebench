import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvCompareView } from '../../src/renderer/features/multi-env/env-compare-view.js';
import type { EnvSendResult } from '../../src/shared/wire-types.js';
import { makeRestExchange } from '../mocks/wire-fixtures.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

function rest(environmentId: string, text: string, status = 200, headers: Record<string, string> = {}): EnvSendResult {
  const exchange = makeRestExchange({ text });
  return {
    outcome: 'ok',
    environmentId,
    environmentName: environmentId.toUpperCase(),
    kind: 'rest',
    rest: {
      ...exchange,
      durationMs: 42,
      url: `https://${environmentId}.example/pets`,
      http: { ...exchange.http, status, headers },
    },
  };
}

const RESULTS: EnvSendResult[] = [
  rest('dev', '{"a":1}', 200, { 'X-Env': 'dev' }),
  rest('test', '{"a":2}', 200, { 'X-Env': 'test' }),
  rest('prod', '{"a":1}', 500),
  {
    outcome: 'error',
    environmentId: 'qa',
    environmentName: 'QA',
    code: 'connection-refused',
    message: 'Connection refused.',
  },
];

describe('EnvCompareView', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders one column per environment with status and time, and marks the baseline', () => {
    render(<EnvCompareView results={RESULTS} baselineId="dev" />);

    const columns = screen.getAllByTestId('env-compare-column');
    expect(columns).toHaveLength(4);
    expect(within(columns[0]!).getByTestId('env-compare-baseline')).toBeDefined();
    expect(within(columns[1]!).queryByTestId('env-compare-baseline')).toBeNull();
    expect(within(columns[0]!).getByTestId('env-compare-status').textContent).toContain('200');
    expect(within(columns[0]!).getByTestId('env-compare-status').textContent).toContain('42');
    expect(within(columns[0]!).getByText('https://dev.example/pets')).toBeDefined();
    expect(within(columns[3]!).getByText('Connection refused.')).toBeDefined();
  });

  it('summarises every other environment against the baseline', () => {
    render(<EnvCompareView results={RESULTS} baselineId="dev" />);
    const verdicts = screen.getAllByTestId('env-compare-verdict').map((row) => row.textContent);
    expect(verdicts).toEqual(['TEST: body differs', 'PROD: status differs', 'QA: failed']);
  });

  it('diffs the baseline with the chosen environment, bodies and headers', async () => {
    render(<EnvCompareView results={RESULTS} baselineId="dev" />);

    expect(screen.getByLabelText<HTMLTextAreaElement>('Original').value).toContain('"a": 1');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Modified').value).toContain('"a": 2');
    const headers = screen.getByRole('table', { name: 'Response headers' });
    expect(
      within(headers)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Header', 'DEV', 'TEST']);
    expect(within(headers).getByText('X-Env').closest('tr')?.getAttribute('data-change')).toBe('changed');

    await userEvent.selectOptions(screen.getByLabelText('Compare the baseline with'), 'prod');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Modified').value).toContain('"a": 1');
    expect(
      within(screen.getByRole('table', { name: 'Response headers' }))
        .getByText('X-Env')
        .closest('tr')
        ?.getAttribute('data-change'),
    ).toBe('removed');
  });
});
