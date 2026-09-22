/**
 * The REST request editor.
 *
 * The cases that matter are the ones a user would notice going wrong: an edit is staged rather than
 * written (so the tab's dot means something and Escape-level mistakes cost nothing), the URL and the
 * Params tab never disagree about the query or the path placeholders, the send names only the request
 * and its draft, and a relative URL says where it is actually going.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { RestEditor, mergeQuery } from '../../src/renderer/features/rest-editor/rest-editor.js';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { restApiWire, restFolderWire, restRequestWire } from '../helpers/wire-defaults.js';
import { makeRestExchange } from '../mocks/exchange-fixtures.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const sendRest = vi.fn();
const preflightRest = vi.fn();
const cancel = vi.fn();

/** Mirrors one API with one folder and one request, and stubs the two channels the editor calls. */
function seed(request = restRequestWire({ url: '/pet/{petId}' })): void {
  useProjectStore.setState({
    apis: { 'api-1': restApiWire() },
    folders: { 'folder-1': restFolderWire() },
    restRequests: { [request.id]: request },
    rest: { p1: { apis: [restApiWire()], folders: [restFolderWire()], requests: [request] } },
    projects: {},
    projectOf: { 'api-1': 'p1', 'folder-1': 'p1', [request.id]: 'p1' },
  });
}

function mount(requestId = 'rest-1'): void {
  render(
    <TooltipPrimitive.Provider>
      <RestEditor requestId={requestId} />
    </TooltipPrimitive.Provider>,
  );
}

/** The patch the editor last staged for `requestId`. */
function staged(requestId = 'rest-1'): Record<string, unknown> | undefined {
  return useDraftsStore.getState().peekRestRequest(requestId);
}

describe('RestEditor', () => {
  beforeEach(() => {
    sendRest.mockReset().mockResolvedValue({ ok: false, error: { code: 'not-asserted', message: 'x' } });
    cancel.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
    preflightRest.mockReset().mockResolvedValue({
      ok: true,
      value: {
        endpoint: 'https://api.test/pet/1',
        endpointSource: 'interface-default',
        unresolved: [],
        auth: { type: 'none', source: 'none' },
        wsa: { enabled: false },
      },
    });
    installWirebenchApi({ request: { sendRest, preflightRest, cancel } });
    useDraftsStore.getState().reset();
    useEditorsStore.getState().reset();
    useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [] });
    seed();
  });

  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('shows the path, the method, the URL and the API base as a greyed prefix', () => {
    mount();

    expect(screen.getByTestId('rest-editor')).toBeTruthy();
    expect(screen.getByTestId('rest-breadcrumb').textContent).toContain('Petstore');
    expect(screen.getByTestId('rest-url-base').textContent).toBe('https://api.test');
    expect(screen.getByTestId<HTMLInputElement>('rest-url').value).toBe('/pet/{petId}');
    expect(screen.getByTestId<HTMLSelectElement>('rest-method').value).toBe('GET');
  });

  it('hides the base prefix for an absolute URL, which ignores it', () => {
    seed(restRequestWire({ url: 'https://elsewhere.test/pets' }));
    mount();

    expect(screen.queryByTestId('rest-url-base')).toBeNull();
  });

  it('highlights property references and path placeholders in the URL', () => {
    seed(restRequestWire({ url: '${#Env#base}/pet/{petId}?x=1' }));
    mount();

    const kinds = [...screen.getByTestId('rest-url-highlight').children].map((span) => span.getAttribute('data-kind'));
    expect(kinds).toEqual(['property', 'plain', 'param', 'plain']);
  });

  it('stages a method change rather than writing it', () => {
    mount();

    fireEvent.change(screen.getByTestId('rest-method'), { target: { value: 'POST' } });

    expect(staged()).toEqual({ method: 'POST' });
    expect(useProjectStore.getState().restRequests['rest-1']?.method).toBe('POST');
    expect(useDraftsStore.getState().isRestRequestDirty('rest-1')).toBe(true);
  });

  it('lets a custom method be typed, for a verb this build has never heard of', () => {
    mount();

    fireEvent.change(screen.getByTestId('rest-method'), { target: { value: '__custom__' } });
    fireEvent.change(screen.getByTestId('rest-method'), { target: { value: 'purge' } });

    expect(staged()).toEqual({ method: 'PURGE' });
  });

  it('keeps the path table in step with the URL as it is typed', () => {
    mount();

    fireEvent.change(screen.getByTestId('rest-url'), { target: { value: '/pet/{petId}/photo/{photoId}' } });

    expect(staged()?.['pathParams']).toEqual([
      { name: 'petId', value: '', enabled: true },
      { name: 'photoId', value: '', enabled: true },
    ]);
  });

  it('reads a query typed into the URL into the query table', () => {
    mount();

    fireEvent.change(screen.getByTestId('rest-url'), { target: { value: '/pet?status=sold&tag=a' } });

    expect(staged()?.['query']).toEqual([
      { name: 'status', value: 'sold', enabled: true },
      { name: 'tag', value: 'a', enabled: true },
    ]);
  });

  it('writes the query table back into the URL', () => {
    seed(restRequestWire({ url: '/pet', query: [{ name: 'status', value: 'sold', enabled: true }] }));
    mount();

    fireEvent.click(screen.getByRole('tab', { name: 'Params' }));
    const value = screen.getAllByTestId('rest-query-value')[0]!;
    fireEvent.change(value, { target: { value: 'pending' } });
    fireEvent.keyDown(value, { key: 'Enter' });

    expect(staged()?.['url']).toBe('/pet?status=pending');
    expect(staged()?.['query']).toEqual([{ name: 'status', value: 'pending', enabled: true }]);
  });

  it('keeps a switched-off query row out of the URL but in the table', () => {
    seed(restRequestWire({ url: '/pet?status=sold', query: [{ name: 'status', value: 'sold', enabled: true }] }));
    mount();

    fireEvent.click(screen.getByRole('tab', { name: 'Params' }));
    fireEvent.click(screen.getAllByTestId('rest-query-enabled')[0]!);

    expect(staged()?.['url']).toBe('/pet');
    expect(staged()?.['query']).toEqual([{ name: 'status', value: 'sold', enabled: false }]);
  });

  it('shows the computed content type on the Headers tab, and drops it once one is typed', () => {
    seed(restRequestWire({ body: { kind: 'raw', language: 'json', text: '{}' } }));
    mount();

    fireEvent.click(screen.getByRole('tab', { name: 'Headers' }));
    expect(screen.getByTestId('rest-header-computed-row').textContent).toContain('application/json');

    fireEvent.change(screen.getByTestId('rest-header-new-name'), { target: { value: 'Content-Type' } });
    expect(staged()?.['headers']).toEqual([{ name: 'Content-Type', value: '', enabled: true }]);
  });

  it('keeps each body kind draft while the switch moves between them', () => {
    seed(restRequestWire({ body: { kind: 'raw', language: 'json', text: '{"a":1}' } }));
    mount();

    fireEvent.click(screen.getByRole('tab', { name: 'Body' }));
    fireEvent.change(screen.getByTestId('rest-body-kind'), { target: { value: 'none' } });
    expect(staged()?.['body']).toEqual({ kind: 'none' });

    fireEvent.change(screen.getByTestId('rest-body-kind'), { target: { value: 'raw' } });
    // Back to the JSON that was there, not to an empty editor.
    expect(staged()?.['body']).toEqual({ kind: 'raw', language: 'json', text: '{"a":1}' });
  });

  it('names the level a request inherits its credentials from', () => {
    useProjectStore.setState({
      folders: { 'folder-1': restFolderWire({ auth: { type: 'bearer', tokenRef: 'sec' } }) },
      restRequests: { 'rest-1': restRequestWire({ folderId: 'folder-1' }) },
    });
    mount();

    fireEvent.click(screen.getByRole('tab', { name: 'Auth' }));
    expect(screen.getByTestId('rest-auth-source').textContent).toContain('Inherited from Pets');
  });

  it('says so when nothing above the request configures credentials', () => {
    mount();

    fireEvent.click(screen.getByRole('tab', { name: 'Auth' }));
    expect(screen.getByTestId('rest-auth-source').textContent).toContain('nothing above this request');
  });

  it('leaves an unset setting empty and shows what it would inherit', () => {
    mount();

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    const timeout = screen.getByTestId<HTMLInputElement>('rest-setting-timeout');
    expect(timeout.value).toBe('');
    expect(timeout.closest('div')?.parentElement?.textContent).toContain('Timeout');
  });

  it('sends the request id and its unsaved draft, never a resolved URL', async () => {
    mount();
    fireEvent.change(screen.getByTestId('rest-url'), { target: { value: '/pets' } });

    fireEvent.click(screen.getByTestId('rest-send'));

    await waitFor(() => {
      expect(sendRest).toHaveBeenCalled();
    });
    const payload = sendRest.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload['requestId']).toBe('rest-1');
    expect(typeof payload['sendId']).toBe('string');
    expect(payload['draft']).toMatchObject({ url: '/pets' });
    expect(Object.keys(payload)).toEqual(['sendId', 'requestId', 'draft']);
  });

  it('sends on Enter in the URL field, as a REST client does', async () => {
    mount();

    fireEvent.keyDown(screen.getByTestId('rest-url'), { key: 'Enter' });

    await waitFor(() => {
      expect(sendRest).toHaveBeenCalled();
    });
  });

  it('offers cancel while a send is in flight, and calls it with that send id', async () => {
    useExchangesStore.setState({ restByRequest: { 'rest-1': { status: 'sending', sendId: 's1' } } });
    mount();

    expect(screen.getByTestId('rest-send').textContent).toContain('Cancel');
    fireEvent.click(screen.getByTestId('rest-send'));

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith({ sendId: 's1' });
    });
  });

  it('shows Cancel, not Stop, while a plain send is in flight', () => {
    useExchangesStore.setState({ restByRequest: { 'rest-1': { status: 'sending', sendId: 's1' } } });
    mount();
    expect(screen.getByTestId('rest-send').textContent).toContain('Cancel');
    expect(screen.getByTestId('rest-send').textContent).not.toContain('Stop');
  });

  it('does not start a second send on Enter while one is in flight', () => {
    useExchangesStore.setState({ restByRequest: { 'rest-1': { status: 'sending', sendId: 's1' } } });
    mount();
    fireEvent.keyDown(screen.getByTestId('rest-url'), { key: 'Enter' });
    expect(sendRest).not.toHaveBeenCalled();
  });

  it('shows the status of a completed send', () => {
    useExchangesStore.setState({
      restByRequest: { 'rest-1': { status: 'done', sendId: 's1', exchange: makeRestExchange() } },
    });
    mount();

    expect(screen.getByTestId('rest-response-status').textContent).toContain('200');
  });

  it('says so, rather than throwing, for a request that no longer exists', () => {
    mount('gone');
    expect(screen.getByText('This request no longer exists.')).toBeTruthy();
  });
});

describe('RestEditor Mod+S in the body editor', () => {
  beforeEach(() => {
    installWirebenchApi();
    useDraftsStore.getState().reset();
    useEditorsStore.getState().reset();
  });

  afterEach(() => {
    cleanup();
  });

  it('is a manual save, so the project is reviewed for secrets first', () => {
    seed(restRequestWire({ body: { kind: 'raw', language: 'json', text: '{}' } }));
    const saveRestRequest = vi.fn().mockResolvedValue(undefined);
    useProjectStore.setState({ saveRestRequest });
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Body' }));

    fireEvent.keyDown(screen.getByLabelText('Request body'), { key: 's', ctrlKey: true });

    expect(saveRestRequest).toHaveBeenCalledWith('rest-1', { manual: true });
  });
});

describe('mergeQuery', () => {
  it('takes the enabled rows from the URL and keeps the switched-off ones', () => {
    expect(
      mergeQuery('/pet?status=sold', [
        { name: 'status', value: 'sold', enabled: true },
        { name: 'tag', value: 'a', enabled: false },
      ]),
    ).toEqual([
      { name: 'status', value: 'sold', enabled: true },
      { name: 'tag', value: 'a', enabled: false },
    ]);
  });

  it('keeps a repeated parameter, which a query string is allowed to carry', () => {
    expect(mergeQuery('/pet?tag=a&tag=b', [])).toEqual([
      { name: 'tag', value: 'a', enabled: true },
      { name: 'tag', value: 'b', enabled: true },
    ]);
  });
});
