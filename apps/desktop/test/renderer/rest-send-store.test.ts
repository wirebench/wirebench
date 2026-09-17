/**
 * The REST half of the exchanges store, and the save path behind the tab's unsaved dot.
 *
 * The send is where the protocol's one security-relevant promise lives: the renderer names the
 * request and hands over its draft, and nothing else — no resolved URL, no base URL, no credential —
 * because main owns the environment, the model and the keychain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeRestExchange } from '../mocks/exchange-fixtures.js';
import { restApiWire, restRequestWire } from '../helpers/wire-defaults.js';

const sendRest = vi.fn();
const cancel = vi.fn();

beforeEach(() => {
  sendRest.mockReset().mockResolvedValue({ ok: true, value: makeRestExchange() });
  cancel.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
  installWirebenchApi({ request: { sendRest, cancel } });
  useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [] });
  useDraftsStore.getState().reset();
  useProblemsStore.setState({ items: [] });
  useProjectStore.setState({
    apis: { 'api-1': restApiWire() },
    restRequests: { 'rest-1': restRequestWire() },
    projectOf: { 'api-1': 'p1', 'rest-1': 'p1' },
  });
});

describe('sendRest', () => {
  it('names the request only, and keeps the reply under that request', async () => {
    await useExchangesStore.getState().sendRest('rest-1');

    expect(sendRest).toHaveBeenCalledTimes(1);
    const payload = sendRest.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['requestId', 'sendId']);
    expect(useExchangesStore.getState().restByRequest['rest-1']).toMatchObject({ status: 'done' });
    expect(useExchangesStore.getState().restByRequest['rest-1']?.exchange?.http.status).toBe(200);
  });

  it('hands over the unsaved draft, so the send is what the editor is showing', async () => {
    useDraftsStore.getState().stageRestRequest('rest-1', { url: '/pets', method: 'POST' });

    await useExchangesStore.getState().sendRest('rest-1');

    expect(sendRest.mock.calls[0]?.[0]).toMatchObject({ draft: { url: '/pets', method: 'POST' } });
  });

  it('leaves the SOAP side untouched', async () => {
    await useExchangesStore.getState().sendRest('rest-1');
    expect(useExchangesStore.getState().byRequest).toEqual({});
  });

  it('puts the send in the HTTP Log, which is one list across both protocols', async () => {
    await useExchangesStore.getState().sendRest('rest-1');

    const { log } = useExchangesStore.getState();
    expect(log).toHaveLength(1);
    const lastEntry = log.at(-1);
    expect(lastEntry?.kind === 'exchange' ? lastEntry.exchange : undefined).toBe(
      useExchangesStore.getState().restByRequest['rest-1']?.exchange,
    );
    // `log.at(-1)` is also what the status bar's "last:" indicator reads, so a REST send that
    // never reached the log left it saying "no requests sent" beside a 200.
  });

  it('leaves the log alone when the send failed, the same as the SOAP path', async () => {
    sendRest.mockResolvedValue({ ok: false, error: { code: 'dns', message: 'not found' } });
    await useExchangesStore.getState().sendRest('rest-1');

    expect(useExchangesStore.getState().log).toEqual([]);
  });

  it('records a failure as an error state and a Problems entry', async () => {
    sendRest.mockResolvedValue({ ok: false, error: { code: 'dns', message: 'not found' } });

    await useExchangesStore.getState().sendRest('rest-1');

    expect(useExchangesStore.getState().restByRequest['rest-1']).toMatchObject({
      status: 'error',
      error: { code: 'dns' },
    });
    expect(useProblemsStore.getState().items.map((item) => item.problem.code)).toContain('dns');
  });

  it('reports the property references main could not resolve', async () => {
    sendRest.mockResolvedValue({
      ok: true,
      value: makeRestExchange({
        unresolved: [{ expr: '${#Env#missing}', code: 'missing', start: 0, end: 0, scope: 'env', name: 'missing' }],
      }),
    });

    await useExchangesStore.getState().sendRest('rest-1');

    expect(useProblemsStore.getState().items.some((item) => item.problem.message.includes('${#Env#missing}'))).toBe(
      true,
    );
  });

  it('clears the last send problems before the next one', async () => {
    sendRest.mockResolvedValueOnce({ ok: false, error: { code: 'dns', message: 'not found' } });
    await useExchangesStore.getState().sendRest('rest-1');
    expect(useProblemsStore.getState().items).toHaveLength(1);

    await useExchangesStore.getState().sendRest('rest-1');
    expect(useProblemsStore.getState().items).toHaveLength(0);
  });

  it('fails loudly for a request the mirror does not hold', async () => {
    await useExchangesStore.getState().sendRest('gone');

    expect(useExchangesStore.getState().restByRequest['gone']).toMatchObject({
      status: 'error',
      error: { code: 'unknown-request' },
    });
    expect(sendRest).not.toHaveBeenCalled();
  });

  it('ignores a reply whose send was already superseded', async () => {
    let settle: ((value: unknown) => void) | undefined;
    sendRest.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const pending = useExchangesStore.getState().sendRest('rest-1');
    // A second send takes over the slot, exactly as pressing Send twice would.
    useExchangesStore.setState({ restByRequest: { 'rest-1': { status: 'sending', sendId: 'other' } } });
    settle?.({ ok: true, value: makeRestExchange() });
    await pending;

    expect(useExchangesStore.getState().restByRequest['rest-1']).toMatchObject({ sendId: 'other', status: 'sending' });
  });

  it('cancels by the send id it is holding, and does nothing without one', async () => {
    useExchangesStore.setState({ restByRequest: { 'rest-1': { status: 'sending', sendId: 's9' } } });
    await useExchangesStore.getState().cancelRest('rest-1');
    expect(cancel).toHaveBeenCalledWith({ sendId: 's9' });

    cancel.mockClear();
    await useExchangesStore.getState().cancelRest('never-sent');
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('the REST save path', () => {
  it('stages an edit into the mirror and the drafts store, writing nothing', () => {
    const mutate = vi.fn();
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().editRestRequest('rest-1', { url: '/pets' });

    expect(useProjectStore.getState().restRequests['rest-1']?.url).toBe('/pets');
    expect(useDraftsStore.getState().peekRestRequest('rest-1')).toEqual({ url: '/pets' });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('commits the staged patch as one mutation and clears the draft', async () => {
    const mutate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        project: {
          id: 'p1',
          name: 'Demo',
          dir: '/tmp/p',
          dirty: true,
          interfaces: [],
          requests: [],
          apis: [restApiWire()],
          folders: [],
          restRequests: [restRequestWire({ url: '/pets' })],
          grpcApis: [],
          grpcRequests: [],
          properties: {},
          disabledProperties: [],
          environments: [],
          problems: [],
          settings: { cacheDefinitions: true, defaultTimeoutMs: 1000, prettyPrintResponses: true },
          keystores: [],
          wssOutgoing: [],
          wssIncoming: [],
        },
      },
    });
    installWirebenchApi({ project: { mutate } });

    useProjectStore.getState().editRestRequest('rest-1', { url: '/pets' });
    await expect(useProjectStore.getState().commitRestRequest('rest-1')).resolves.toBe(true);

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      change: { kind: 'update-rest-request', requestId: 'rest-1', patch: { url: '/pets' } },
    });
    expect(useDraftsStore.getState().isRestRequestDirty('rest-1')).toBe(false);
  });

  it('keeps the draft when the commit fails, so the tab still says unsaved', async () => {
    installWirebenchApi({
      project: { mutate: vi.fn().mockResolvedValue({ ok: false, error: { code: 'read-only', message: 'no' } }) },
    });

    useProjectStore.getState().editRestRequest('rest-1', { url: '/pets' });
    await expect(useProjectStore.getState().commitRestRequest('rest-1')).resolves.toBe(false);

    expect(useDraftsStore.getState().isRestRequestDirty('rest-1')).toBe(true);
  });

  it('commits nothing for a clean request, and writes the project only when it is dirty', async () => {
    const mutate = vi.fn();
    const save = vi.fn().mockResolvedValue({ ok: true, value: { saved: true, written: 1, removed: 0 } });
    installWirebenchApi({ project: { mutate, save } });
    // A clean request in a clean project: nothing to do at all.
    useProjectStore.setState({ projects: { p1: { id: 'p1', dirty: false } as never } });

    await expect(useProjectStore.getState().commitRestRequest('rest-1')).resolves.toBe(true);
    await useProjectStore.getState().saveRestRequest('rest-1');

    expect(mutate).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();

    // A rename reaches main unstaged, so a clean request can still sit in a dirty project.
    useProjectStore.setState({ projects: { p1: { id: 'p1', dirty: true } as never } });
    await useProjectStore.getState().saveRestRequest('rest-1');
    expect(save).toHaveBeenCalledWith({ projectId: 'p1' });
  });
});
