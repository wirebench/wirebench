import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { LogCompare } from '../../src/renderer/features/console/log-compare-view.js';
import { b64, logExchange, makeRestExchange } from '../mocks/exchange-fixtures.js';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: (props: { original: string; modified: string; language: string }) => (
    <pre data-testid="diff" data-language={props.language}>{`${props.original}|${props.modified}`}</pre>
  ),
}));

const row = (id: string, status: number, body: string, headers: Record<string, string>) => {
  const e = makeRestExchange({ sendId: id });
  return logExchange({ ...e, http: { ...e.http, status, bodyBase64: b64(body), headers } });
};

describe('LogCompare', () => {
  afterEach(cleanup);

  it('summarises both rows, marks header changes and diffs pretty JSON bodies', () => {
    render(
      <LogCompare
        left={row('a', 200, '{"n":1}', { 'content-type': 'application/json', etag: '1' })}
        right={row('b', 404, '{"n":2}', { 'content-type': 'application/json', 'x-new': 'y' })}
      />,
    );
    const summaries = screen.getAllByTestId('log-compare-summary');
    expect(summaries[0]!.textContent).toContain('200');
    expect(summaries[1]!.textContent).toContain('404');
    const response = screen.getByRole('table', { name: 'Response headers' });
    expect(within(response).getByText('etag').closest('tr')!.dataset['change']).toBe('removed');
    expect(within(response).getByText('x-new').closest('tr')!.dataset['change']).toBe('added');
    const diffs = screen.getAllByTestId('diff');
    expect(diffs[1]!.dataset['language']).toBe('json');
    expect(diffs[1]!.textContent).toBe('{\n  "n": 1\n}|{\n  "n": 2\n}');
  });
});
