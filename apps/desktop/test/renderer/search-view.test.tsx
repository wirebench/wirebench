import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SearchView } from '../../src/renderer/features/search/search-view.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useInterfaceEditorStore } from '../../src/renderer/features/interface-editor/interface-editor-state.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { ProjectWire, SearchMatchWire } from '../../src/shared/wire-types.js';

const BODY_MATCH: SearchMatchWire = {
  kind: 'request-body',
  requestId: 'req-1',
  requestName: 'Request 1',
  interfaceId: 'if-1',
  interfaceName: 'Calculator',
  line: 2,
  column: 4,
  start: 12,
  end: 15,
  snippet: '<Add>',
};

const DOC_MATCH: SearchMatchWire = {
  kind: 'document',
  interfaceId: 'if-1',
  interfaceName: 'Calculator',
  location: 'calc.wsdl',
  line: 9,
  column: 1,
  start: 40,
  end: 43,
  snippet: '<wsdl:operation name="Add"/>',
};

const HEADER_MATCH: SearchMatchWire = { ...BODY_MATCH, kind: 'request-header', line: 1, start: 9, end: 16 };

function stubQuery(matches: readonly SearchMatchWire[], truncated = false) {
  return vi.fn().mockResolvedValue({ ok: true, value: { matches, truncated } });
}

const openProject = (): void => {
  useProjectStore.setState({ project: { id: 'p1', name: 'Demo' } as ProjectWire });
};

describe('SearchView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installWirebenchApi();
    openProject();
    useEditorsStore.setState({ tabs: [], activeId: undefined });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  async function type(value: string): Promise<void> {
    fireEvent.change(screen.getByTestId('search-input'), { target: { value } });
    await settle();
  }

  /** Fires the debounce timer and lets the resolved IPC promise repaint. */
  async function settle(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  }

  it('asks main for matches, debounced, with the toggles and scopes', async () => {
    const query = stubQuery([]);
    installWirebenchApi({ search: { query } });
    render(<SearchView />);

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'Ad' } });
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'Add' } });
    await settle();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith({
      query: 'Add',
      regex: false,
      caseSensitive: false,
      scopes: { requestBodies: true, headers: true, definitions: true },
    });
  });

  it('never searches for an empty query', async () => {
    const query = stubQuery([]);
    installWirebenchApi({ search: { query } });
    render(<SearchView />);

    await type('   ');

    expect(query).not.toHaveBeenCalled();
  });

  it('re-runs the search when a toggle or scope changes', async () => {
    const query = stubQuery([]);
    installWirebenchApi({ search: { query } });
    render(<SearchView />);
    await type('Add');

    fireEvent.click(screen.getByTestId('search-regex'));
    await settle();
    fireEvent.click(screen.getByTestId('search-scope-definitions'));
    await settle();

    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenLastCalledWith(
      expect.objectContaining({ regex: true, scopes: { requestBodies: true, headers: true, definitions: false } }),
    );
  });

  it('groups results by request and document, showing the line and its snippet', async () => {
    installWirebenchApi({ search: { query: stubQuery([BODY_MATCH, DOC_MATCH]) } });
    render(<SearchView />);
    await type('Add');

    expect(screen.getAllByTestId('search-group')).toHaveLength(2);
    expect(screen.getByText('Calculator › Request 1')).toBeTruthy();
    expect(screen.getByText('Calculator › calc.wsdl')).toBeTruthy();
    expect(screen.getAllByTestId('search-result')).toHaveLength(2);
    expect(screen.getByText('<Add>')).toBeTruthy();
  });

  it('says when nothing matched', async () => {
    installWirebenchApi({ search: { query: stubQuery([]) } });
    render(<SearchView />);
    await type('Nope');

    expect(screen.getByTestId('search-empty')).toBeTruthy();
  });

  it('shows the error from an invalid regex instead of dropping it', async () => {
    installWirebenchApi({
      search: { query: vi.fn().mockResolvedValue({ ok: false, error: { code: 'invalid-regex', message: 'bad (' } }) },
    });
    render(<SearchView />);
    await type('(');

    expect(screen.getByTestId('search-error').textContent).toBe('bad (');
  });

  it('says when the results were capped', async () => {
    installWirebenchApi({ search: { query: stubQuery([BODY_MATCH], true) } });
    render(<SearchView />);
    await type('Add');

    expect(screen.getByText(/More results were found/)).toBeTruthy();
  });

  it('opens the request tab for a body match', async () => {
    installWirebenchApi({ search: { query: stubQuery([BODY_MATCH]) } });
    render(<SearchView />);
    await type('Add');

    fireEvent.click(screen.getByTestId('search-result'));

    expect(useEditorsStore.getState().tabs.map((tab) => tab.requestId)).toEqual(['req-1']);
  });

  it('opens the request tab on its Headers inspector for a header match', async () => {
    installWirebenchApi({ search: { query: stubQuery([HEADER_MATCH]) } });
    render(<SearchView />);
    await type('Trace');

    fireEvent.click(screen.getByTestId('search-result'));

    expect(useEditorsStore.getState().inspectorCollapsedFor('req-1', 'request')).toBe(false);
    expect(useEditorsStore.getState().inspectorFor('req-1', 'request')).toBe('headers');
  });

  it('reveals a definition document at its line', async () => {
    installWirebenchApi({ search: { query: stubQuery([DOC_MATCH]) } });
    render(<SearchView />);
    await type('Add');

    fireEvent.click(screen.getByTestId('search-result'));

    expect(useInterfaceEditorStore.getState().sourceTargetFor('if-1')).toEqual({ location: 'calc.wsdl', line: 9 });
  });

  it('invites the user to open a project when none is', () => {
    useProjectStore.setState({ project: null });
    installWirebenchApi({ search: { query: stubQuery([]) } });
    render(<SearchView />);

    expect(screen.getByText('No project open')).toBeTruthy();
  });
});
