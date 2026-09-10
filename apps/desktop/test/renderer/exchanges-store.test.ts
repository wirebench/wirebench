import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeSummary } from '../../src/shared/wire-types.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const draft: RequestDraft = {
  id: 'r1',
  interfaceId: 'iface-1',
  bindingName: '{tns}B',
  operationName: 'Add',
  name: 'Request 1',
  envelopeXml: '<Envelope/>',
  soapVersion: '1.1',
  endpointUrl: 'http://example.test/soap',
  headers: [{ name: 'SOAPAction', value: '"Add"' }],
  order: 0,
};

function exchangeSummary(sendId: string): ExchangeSummary {
  return {
    sendId,
    durationMs: 10,
    http: {
      status: 200,
      statusText: 'OK',
      headers: {},
      rawHeaders: [],
      bodyBase64: '',
      rawBodyBase64: '',
      rawRequestBase64: '',
      rawResponseBase64: '',
      truncated: false,
      timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 10 },
      redirects: [],
      request: { url: draft.endpointUrl ?? '', method: 'POST', headers: {} },
    },
    problems: [],
  };
}

function stubIpc(overrides: Parameters<typeof installWirebenchApi>[0] = {}): void {
  installWirebenchApi(overrides);
}

describe('useExchangesStore', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, log: [] });
    useProjectStore.setState({
      interfaces: {},
      requests: { r1: draft },
      order: [],
      environments: [],
      activeEnvironmentId: undefined,
    });
    useProblemsStore.setState({ items: [] });
  });

  it('send() transitions idle -> sending -> done and appends to the log', async () => {
    const sendFn = vi.fn().mockResolvedValue({ ok: true, value: exchangeSummary('send-1') });
    stubIpc({ request: { generate: vi.fn(), send: sendFn, cancel: vi.fn() } });

    const promise = useExchangesStore.getState().send('r1');
    expect(useExchangesStore.getState().byRequest['r1']?.status).toBe('sending');
    await promise;

    const state = useExchangesStore.getState();
    expect(state.byRequest['r1']?.status).toBe('done');
    expect(state.byRequest['r1']?.exchange?.sendId).toBe('send-1');
    expect(state.log).toHaveLength(1);
    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ endpoint: draft.endpointUrl }) as unknown }),
    );
  });

  it('send() records an error status when the IPC call fails', async () => {
    stubIpc({
      request: {
        generate: vi.fn(),
        send: vi.fn().mockResolvedValue({ ok: false, error: { code: 'boom', message: 'send failed' } }),
        cancel: vi.fn(),
      },
    });

    await useExchangesStore.getState().send('r1');

    const entry = useExchangesStore.getState().byRequest['r1'];
    expect(entry?.status).toBe('error');
    expect(entry?.error?.code).toBe('boom');
  });

  it('send() reports missing-endpoint without calling the IPC layer', async () => {
    const draftWithoutEndpoint: RequestDraft = {
      id: draft.id,
      interfaceId: draft.interfaceId,
      bindingName: draft.bindingName,
      operationName: draft.operationName,
      name: draft.name,
      envelopeXml: draft.envelopeXml,
      soapVersion: draft.soapVersion,
      headers: draft.headers,
      order: draft.order,
    };
    useProjectStore.setState({
      interfaces: {},
      requests: { r1: draftWithoutEndpoint },
      order: [],
      environments: [],
      activeEnvironmentId: undefined,
    });
    const sendFn = vi.fn();
    stubIpc({ request: { generate: vi.fn(), send: sendFn, cancel: vi.fn() } });

    await useExchangesStore.getState().send('r1');

    expect(sendFn).not.toHaveBeenCalled();
    expect(useExchangesStore.getState().byRequest['r1']?.error?.code).toBe('missing-endpoint');
  });

  it('cancel() calls request.cancel with the in-flight sendId', async () => {
    const cancelFn = vi.fn().mockResolvedValue({ ok: true, value: { cancelled: true } });
    let resolveSend: (value: { ok: true; value: ExchangeSummary }) => void = () => undefined;
    const sendFn = vi.fn().mockReturnValue(new Promise((resolve) => (resolveSend = resolve)));
    stubIpc({ request: { generate: vi.fn(), send: sendFn, cancel: cancelFn } });

    const sendPromise = useExchangesStore.getState().send('r1');
    const sendId = useExchangesStore.getState().byRequest['r1']?.sendId;
    expect(sendId).toBeDefined();

    await useExchangesStore.getState().cancel('r1');
    expect(cancelFn).toHaveBeenCalledWith({ sendId });

    resolveSend({ ok: true, value: exchangeSummary(sendId ?? '') });
    await sendPromise;
  });

  it('caps the log at 500 entries', async () => {
    useExchangesStore.setState({
      byRequest: {},
      log: Array.from({ length: 500 }, (_, i) => exchangeSummary(`old-${String(i)}`)),
    });
    stubIpc({
      request: {
        generate: vi.fn(),
        send: vi.fn().mockResolvedValue({ ok: true, value: exchangeSummary('new-1') }),
        cancel: vi.fn(),
      },
    });

    await useExchangesStore.getState().send('r1');

    const { log } = useExchangesStore.getState();
    expect(log).toHaveLength(500);
    expect(log.at(-1)?.sendId).toBe('new-1');
    expect(log[0]?.sendId).toBe('old-1');
  });

  it('clearRequest deletes the exchange entry but keeps the log', () => {
    const summary = exchangeSummary('send-1');
    useExchangesStore.setState({
      byRequest: { r1: { status: 'done', sendId: 'send-1', exchange: summary } },
      log: [summary],
    });

    useExchangesStore.getState().clearRequest('r1');

    const state = useExchangesStore.getState();
    expect(state.byRequest['r1']).toBeUndefined();
    expect(state.log).toHaveLength(1);
    expect(state.log[0]?.sendId).toBe('send-1');
  });

  it('send() preflights first, sends the endpoint it returns, and lists unresolved refs', async () => {
    const preflight = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        endpoint: 'http://dev.test/soap',
        endpointSource: 'environment',
        unresolved: [
          { expr: '${#Env#missing}', code: 'missing', start: 0, end: 15, field: 'envelopeXml' },
          { expr: '${who}', code: 'missing', start: 0, end: 6, field: 'header', headerName: 'X-User' },
        ],
      },
    });
    const sendFn = vi.fn().mockResolvedValue({ ok: true, value: exchangeSummary('send-1') });
    stubIpc({ request: { generate: vi.fn(), send: sendFn, cancel: vi.fn(), preflight } });

    await useExchangesStore.getState().send('r1');

    expect(preflight).toHaveBeenCalledWith({ requestId: 'r1' });
    // The environment override from main wins over the mirror's own `endpointUrl`.
    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ endpoint: 'http://dev.test/soap' }) as unknown }),
    );
    expect(useProblemsStore.getState().items.map((item) => item.problem.message)).toEqual([
      'Unresolved property ${#Env#missing} in envelopeXml',
      'Unresolved property ${who} in header "X-User"',
    ]);
    expect(useProblemsStore.getState().items[0]).toMatchObject({
      source: 'expansion',
      severity: 'warning',
      requestId: 'r1',
    });
  });

  it("send() clears the previous send's expansion problems for that request only", async () => {
    useProblemsStore.setState({
      items: [
        {
          groupId: 'expansion:r1',
          source: 'expansion',
          severity: 'warning',
          requestId: 'r1',
          problem: { code: 'expansion-missing', message: 'stale' },
        },
        {
          groupId: 'expansion:r2',
          source: 'expansion',
          severity: 'warning',
          requestId: 'r2',
          problem: { code: 'expansion-missing', message: 'someone else' },
        },
      ],
    });
    stubIpc({
      request: {
        generate: vi.fn(),
        send: vi.fn().mockResolvedValue({ ok: true, value: exchangeSummary('send-1') }),
        cancel: vi.fn(),
        preflight: vi.fn().mockResolvedValue({ ok: true, value: { endpointSource: 'request-custom', unresolved: [] } }),
      },
    });

    await useExchangesStore.getState().send('r1');

    expect(useProblemsStore.getState().items.map((item) => item.problem.message)).toEqual(['someone else']);
  });

  it('send() merges unresolved refs the exchange reports and skips duplicates', async () => {
    const ref = { expr: '${#Env#missing}', code: 'missing', start: 0, end: 15, field: 'envelopeXml' as const };
    stubIpc({
      request: {
        generate: vi.fn(),
        send: vi.fn().mockResolvedValue({
          ok: true,
          value: { ...exchangeSummary('send-1'), unresolved: [ref, { ...ref, expr: '${#Global#other}' }] },
        }),
        cancel: vi.fn(),
        preflight: vi.fn().mockResolvedValue({
          ok: true,
          value: { endpoint: draft.endpointUrl, endpointSource: 'request-custom', unresolved: [ref] },
        }),
      },
    });

    await useExchangesStore.getState().send('r1');

    expect(useProblemsStore.getState().items.map((item) => item.problem.message)).toEqual([
      'Unresolved property ${#Env#missing} in envelopeXml',
      'Unresolved property ${#Global#other} in envelopeXml',
    ]);
  });

  it("falls back to the mirror's endpoint when preflight fails (an unsaved request)", async () => {
    const sendFn = vi.fn().mockResolvedValue({ ok: true, value: exchangeSummary('send-1') });
    stubIpc({
      request: {
        generate: vi.fn(),
        send: sendFn,
        cancel: vi.fn(),
        preflight: vi.fn().mockResolvedValue({ ok: false, error: { code: 'not-found', message: 'gone' } }),
      },
    });

    await useExchangesStore.getState().send('r1');

    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ endpoint: draft.endpointUrl }) as unknown }),
    );
    expect(useProblemsStore.getState().items).toEqual([]);
  });
});
