/**
 * A REST response's contract result in the renderer: the chip on the status line (and in History),
 * warning markers placed against the text the body view is actually showing, and a Problems row that
 * brings the body into view and reveals where its pointer points.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { RestResponsePane } from '../../src/renderer/features/rest-editor/response/response-pane.js';
import {
  contractChip,
  contractGroupId,
  recordContractProblems,
  useContractRevealStore,
} from '../../src/renderer/features/rest-editor/response/contract.js';
import { ProblemsView } from '../../src/renderer/features/problems/problems-view.js';
import { HistoryEntryView } from '../../src/renderer/features/history/history-entry-view.js';
import {
  CONTRACT_MARKER_OWNER,
  contractMarkerData,
  setMarkerApi,
  type MarkerApi,
} from '../../src/renderer/editor/markers.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useHistoryStore } from '../../src/renderer/state/history.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeRestExchange } from '../mocks/exchange-fixtures.js';
import { revealedRanges } from '../mocks/monaco-editor-react.js';
import type { HistoryEntryWire, RestContractResultWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));
vi.mock('../../src/renderer/features/request-editor/views/lazy-views.js', () => ({
  QueryView: () => <div />,
}));

const BODY = '{"id":1,"name":7}';

function result(overrides: Partial<RestContractResultWire> = {}): RestContractResultWire {
  return {
    status: 'violation',
    operation: { method: 'get', path: '/pet/{id}' },
    responseKey: '200',
    mediaType: 'application/json',
    problems: [{ path: '/name', keyword: 'type', message: 'must be string' }],
    notes: ['readOnly properties were not required'],
    ...overrides,
  };
}

function mount(contract: RestContractResultWire | undefined, text = BODY): void {
  render(
    <TooltipPrimitive.Provider>
      <RestResponsePane
        requestId="rest-1"
        state={{
          status: 'done',
          sendId: 'send-1',
          exchange: makeRestExchange({ text, ...(contract !== undefined ? { contract } : {}) }),
        }}
      />
    </TooltipPrimitive.Provider>,
  );
}

const setModelMarkers = vi.fn();

beforeEach(() => {
  installWirebenchApi();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
  useProblemsStore.setState({ items: [] });
  useContractRevealStore.setState({ pending: undefined });
  setModelMarkers.mockReset();
  setMarkerApi({ editor: { setModelMarkers } } as unknown as MarkerApi);
  revealedRanges.length = 0;
});

afterEach(() => {
  cleanup();
  setMarkerApi(undefined);
});

describe('the contract chip', () => {
  it.each([
    [result({ status: 'ok', problems: [] }), 'Contract ✓', 'success'],
    [result(), 'Contract: 1 problem', 'warning'],
    [
      result({ problems: [...Array<null>(3)].map(() => ({ path: '', keyword: 'type', message: 'x' })) }),
      'Contract: 3 problems',
      'warning',
    ],
    [result({ status: 'unmatched', problems: [] }), 'Unexpected status', 'warning'],
    [result({ status: 'no-schema', problems: [] }), 'No schema', 'muted'],
    [result({ status: 'not-checked', problems: [] }), 'Not checked', 'muted'],
    [result({ status: 'skipped', problems: [] }), 'Skipped', 'muted'],
  ])('reads %#: %s', (contract, label, tone) => {
    mount(contract);
    const chip = screen.getByTestId('rest-contract-chip');
    expect(chip.textContent).toBe(label);
    expect(chip.dataset.tone).toBe(tone);
    // Never colour alone: an icon travels with the words.
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('rest-response-status').textContent).toContain(label);
  });

  it('is not shown when there was no contract, nor when no result came back', () => {
    expect(contractChip(result({ status: 'no-contract' }))).toBeUndefined();
    mount(result({ status: 'no-contract', problems: [] }));
    expect(screen.queryByTestId('rest-contract-chip')).toBeNull();
    cleanup();
    mount(undefined);
    expect(screen.queryByTestId('rest-contract-chip')).toBeNull();
  });

  it('names the operation, response key and media type, and lists the notes, in its tooltip', () => {
    mount(result());
    expect(screen.getByTestId('rest-contract-chip').getAttribute('title')).toBe(
      'GET /pet/{id} → 200 (application/json)\nreadOnly properties were not required',
    );
  });
});

describe('contract markers', () => {
  it('locate a pointer in raw text and in pretty-printed text, and fall back to line 1', () => {
    const problems = [
      { path: '/name', keyword: 'type', message: 'must be string' },
      { path: '/missing/deep', keyword: 'required', message: 'gone' },
    ];
    const raw = contractMarkerData(problems, BODY);
    expect(raw[0]).toMatchObject({ severity: 4, startLineNumber: 1, source: 'openapi', code: 'type' });
    expect(raw[0]!.startColumn).toBe(BODY.indexOf('7') + 1);

    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    const shown = contractMarkerData(problems, pretty);
    expect(shown[0]).toMatchObject({ startLineNumber: 3, endLineNumber: 3 });
    expect(shown[1]).toMatchObject({ startLineNumber: 1, startColumn: 1, endLineNumber: 1 });
  });

  it('are set on the body editor against the pretty-printed text it shows', () => {
    mount(result());
    const call = setModelMarkers.mock.calls.at(-1)!;
    expect(call[1]).toBe(CONTRACT_MARKER_OWNER);
    // Pretty is on by default, so `"name": 7` sits on the third line, not the first.
    expect(call[2]).toEqual([expect.objectContaining({ startLineNumber: 3, message: 'must be string' })]);
  });

  it('are placed against the raw text when the body is too large to pretty-print', () => {
    usePreferencesStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES_WIRE,
        rest: { ...DEFAULT_PREFERENCES_WIRE.rest, prettyPrintMaxBytes: 4 },
      },
      loaded: true,
    });
    mount(result());
    // Raw is shown by default for a large body; the Pretty tab is disabled, so no editor exists yet.
    expect(screen.getByTestId('rest-response-view-raw').getAttribute('aria-selected')).toBe('true');
    expect(contractMarkerData(result().problems, BODY)[0]).toMatchObject({ startLineNumber: 1 });
  });

  it('are cleared when the result has no problems', () => {
    mount(result({ status: 'ok', problems: [] }));
    expect(setModelMarkers.mock.calls.at(-1)![2]).toEqual([]);
  });
});

describe('contract problems in the Problems view', () => {
  it('files one warning row per problem under the request group, replacing the last send', () => {
    recordContractProblems('rest-1', result());
    recordContractProblems('rest-1', result({ problems: [{ path: '/id', keyword: 'type', message: 'bad id' }] }));
    const items = useProblemsStore.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      groupId: contractGroupId('rest-1'),
      source: 'contract',
      severity: 'warning',
      direction: 'response',
      requestId: 'rest-1',
      problem: { source: 'openapi', location: '/id', message: 'bad id' },
    });
    recordContractProblems('rest-1', undefined);
    expect(useProblemsStore.getState().items).toHaveLength(0);
  });

  it('reveals the marker from a row: the body tab comes forward and the range is selected', () => {
    recordContractProblems('rest-1', result());
    mount(result());
    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    expect(screen.queryByTestId('rest-response-body')).toBeNull();

    render(<ProblemsView />);
    act(() => {
      fireEvent.click(screen.getByTestId('problem-row'));
    });

    expect(screen.getByTestId('rest-response-body')).toBeTruthy();
    expect(revealedRanges.at(-1)).toMatchObject({ startLineNumber: 3 });
    expect(useContractRevealStore.getState().pending).toBeUndefined();
  });

  it('switches the body back to Pretty when a reveal arrives on the Raw view', () => {
    mount(result());
    fireEvent.click(screen.getByTestId('rest-response-view-raw'));
    act(() => {
      useContractRevealStore.getState().request('rest-1', '/name');
    });
    expect(screen.getByTestId('rest-response-view-pretty').getAttribute('aria-selected')).toBe('true');
    expect(revealedRanges.at(-1)).toMatchObject({ startLineNumber: 3 });
  });
});

describe('the contract chip in History', () => {
  it('shows on a REST entry that carries a result', () => {
    const entry: HistoryEntryWire = {
      id: 'h-1',
      kind: 'rest',
      method: 'GET',
      at: '2026-09-22T10:00:00.000Z',
      projectId: 'p1',
      requestName: 'Pet',
      interfaceName: '',
      operationName: '',
      endpoint: 'https://api.test/pet/1',
      soapVersion: 'none',
      durationMs: 12,
      ok: true,
      status: 200,
      request: { envelopeXml: '', headers: [] },
      response: { envelopeXml: BODY, rawHeaders: [], status: 200, statusText: 'OK' },
      sizeBytes: 17,
      contract: result(),
    };
    useHistoryStore.setState({ entries: [entry], total: 1 });
    render(<HistoryEntryView historyId="h-1" />);
    expect(screen.getByTestId('rest-contract-chip').textContent).toBe('Contract: 1 problem');
  });
});
