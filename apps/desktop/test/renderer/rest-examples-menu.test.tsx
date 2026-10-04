/**
 * The Examples menu on the REST response pane (#64): a request's recorded responses, listed only
 * when it has some, each shown read-only through the same Body and Headers views as a live
 * response, under a banner that says it is not one, and deletable from there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { RestResponsePane } from '../../src/renderer/features/rest-editor/response/response-pane.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import type { RestExchangeState } from '../../src/renderer/state/exchanges.js';
import type { RestRequestWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restRequestWire } from '../helpers/wire-defaults.js';
import { makeRestExchange } from '../mocks/exchange-fixtures.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const mutate = vi.fn();

type Examples = NonNullable<RestRequestWire['examples']>;

const EXAMPLE: Examples[number] = {
  id: 'e1',
  name: '200 OK — recorded 2026-10-04',
  status: 200,
  statusText: 'OK',
  headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
  body: '{"id":1}',
  contentType: 'application/json',
};

/** Mirrors one REST request carrying `examples`, and mounts its response pane. */
function renderRestEditorWith({ examples }: { readonly examples?: Examples }, state?: RestExchangeState) {
  const request = restRequestWire(examples !== undefined ? { examples } : {});
  useProjectStore.setState({
    restRequests: { [request.id]: request },
    projectOf: { [request.id]: 'p1' },
  });
  const view = (next?: RestExchangeState) => (
    <TooltipPrimitive.Provider>
      <RestResponsePane requestId={request.id} state={next} />
    </TooltipPrimitive.Provider>
  );
  const result = render(view(state));
  return { rerender: (next?: RestExchangeState) => result.rerender(view(next)) };
}

/** The text the (stubbed) Monaco editor is showing. */
function editorText(): string {
  return screen.getByRole<HTMLTextAreaElement>('textbox').value;
}

beforeEach(() => {
  mutate.mockReset().mockResolvedValue({ ok: true, value: { project: null } });
  installWirebenchApi({ project: { mutate } });
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});

afterEach(() => {
  cleanup();
});

describe('the Examples menu', () => {
  it('lists examples and shows the chosen one read-only', async () => {
    renderRestEditorWith({
      examples: [
        {
          id: 'e1',
          name: '200 OK — recorded 2026-10-04',
          status: 200,
          statusText: 'OK',
          headers: [],
          body: '{"id":1}',
          contentType: 'application/json',
        },
      ],
    });
    fireEvent.click(screen.getByTestId('rest-examples-menu'));
    fireEvent.click(screen.getByTestId('rest-example-item-e1'));
    expect(await screen.findByTestId('rest-example-banner')).toBeTruthy();
    expect(editorText()).toContain('"id": 1');
  });

  it('is not there for a request without examples', () => {
    renderRestEditorWith({});
    expect(screen.queryByTestId('rest-examples-menu')).toBeNull();
  });

  it('reads the banner exactly, and shows the recorded headers', () => {
    renderRestEditorWith({ examples: [EXAMPLE] });
    fireEvent.click(screen.getByTestId('rest-examples-menu'));
    expect(screen.getByTestId('rest-example-item-e1').textContent).toContain('200 OK — recorded 2026-10-04');
    fireEvent.click(screen.getByTestId('rest-example-item-e1'));

    expect(screen.getByTestId('rest-example-banner').textContent).toBe('Example — recorded, not a live response');
    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }));
    expect(screen.getByTestId('rest-response-headers').textContent).toContain('application/json');
  });

  it('shows the example over a live response, and a new send puts the live one back', () => {
    const { rerender } = renderRestEditorWith(
      { examples: [EXAMPLE] },
      { status: 'done', sendId: 's1', exchange: makeRestExchange() },
    );
    fireEvent.click(screen.getByTestId('rest-examples-menu'));
    fireEvent.click(screen.getByTestId('rest-example-item-e1'));
    expect(screen.getByTestId('rest-example-banner')).toBeTruthy();

    rerender({ status: 'sending', sendId: 's2' });

    expect(screen.queryByTestId('rest-example-banner')).toBeNull();
    expect(screen.getByTestId('rest-response-status').textContent).toContain('Sending');
  });

  it('deletes the shown example through a project change', async () => {
    renderRestEditorWith({ examples: [EXAMPLE] });
    fireEvent.click(screen.getByTestId('rest-examples-menu'));
    fireEvent.click(screen.getByTestId('rest-example-item-e1'));
    fireEvent.click(screen.getByTestId('rest-example-delete'));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        projectId: 'p1',
        change: { kind: 'remove-rest-example', requestId: 'rest-1', exampleId: 'e1' },
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('rest-example-banner')).toBeNull();
    });
  });
});
