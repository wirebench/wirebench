import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExchangeSummary } from '../../src/shared/wire-types.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import {
  EMPTY_FILTER,
  lastExchangeOf,
  sendIdOf,
  subscribeToExchangeFailures,
  subscribeToExchangeLogged,
} from '../../src/renderer/state/exchanges.js';
import type { RequestDraft } from '../../src/renderer/state/project.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';
import { REQUEST_PROPERTIES } from '../helpers/wire-defaults.js';

const draft: RequestDraft = {
  properties: REQUEST_PROPERTIES,
  attachments: [],
  id: 'r1',
  interfaceId: 'iface-1',
  bindingName: '{tns}B',
  operationName: 'Add',
  name: 'Request 1',
  slug: 'Request 1',
  operationSlug: 'Add',
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
      httpVersion: '1.1',
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
    });
    useProblemsStore.setState({ items: [] });
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE });
  });

  /** Turns `editor.autoValidateOnSend` on for one test. */
  function autoValidateOn(): void {
    usePreferencesStore.setState({
      preferences: {
        ...DEFAULT_PREFERENCES_WIRE,
        editor: { ...DEFAULT_PREFERENCES_WIRE.editor, autoValidateOnSend: true },
      },
    });
  }

  it('send() blocks on validation errors when auto-validate is on', async () => {
    autoValidateOn();
    const sendFn = vi.fn();
    const message = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        problems: [{ severity: 'error', code: 'schema-invalid', message: 'bad', source: 'schema', line: 3 }],
        durationMs: 1,
      },
    });
    stubIpc({ request: { generate: vi.fn(), send: sendFn, cancel: vi.fn() }, validate: { message } });

    await useExchangesStore.getState().send('r1');

    expect(sendFn).not.toHaveBeenCalled();
    expect(useProblemsStore.getState().items.map((item) => item.source)).toEqual(['validation']);
  });

  it('send(requestId, true) sends anyway, skipping the validation gate', async () => {
    autoValidateOn();
    const sendFn = vi.fn().mockResolvedValue({ ok: true, value: exchangeSummary('send-1') });
    const message = vi.fn();
    stubIpc({
      request: { generate: vi.fn(), send: sendFn, cancel: vi.fn() },
      validate: { message },
    });

    await useExchangesStore.getState().send('r1', true);

    expect(message).not.toHaveBeenCalled();
    expect(useExchangesStore.getState().byRequest['r1']?.status).toBe('done');
  });

  it('send() proceeds when auto-validate finds only warnings', async () => {
    autoValidateOn();
    const sendFn = vi.fn().mockResolvedValue({ ok: true, value: exchangeSummary('send-1') });
    const message = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        problems: [{ severity: 'warning', code: 'content-type-mismatch', message: 'meh', source: 'structure' }],
        durationMs: 1,
      },
    });
    stubIpc({ request: { generate: vi.fn(), send: sendFn, cancel: vi.fn() }, validate: { message } });

    await useExchangesStore.getState().send('r1');
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('send() proceeds when validation itself is unavailable (an infra failure is a warning, not a gate)', async () => {
    autoValidateOn();
    const sendFn = vi.fn().mockResolvedValue({ ok: true, value: exchangeSummary('send-1') });
    const message = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'unknown-interface', message: 'not loaded' } });
    stubIpc({ request: { generate: vi.fn(), send: sendFn, cancel: vi.fn() }, validate: { message } });

    await useExchangesStore.getState().send('r1');

    expect(sendFn).toHaveBeenCalledTimes(1);
    expect(useProblemsStore.getState().items).toMatchObject([
      { severity: 'warning', problem: { code: 'validation-unavailable' } },
    ]);
  });

  it('send() does not validate at all when the preference is off', async () => {
    const sendFn = vi.fn().mockResolvedValue({ ok: true, value: exchangeSummary('send-1') });
    const message = vi.fn();
    stubIpc({ request: { generate: vi.fn(), send: sendFn, cancel: vi.fn() }, validate: { message } });

    await useExchangesStore.getState().send('r1');
    expect(message).not.toHaveBeenCalled();
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
      properties: REQUEST_PROPERTIES,
      attachments: [],
      id: draft.id,
      interfaceId: draft.interfaceId,
      bindingName: draft.bindingName,
      operationName: draft.operationName,
      name: draft.name,
      slug: draft.slug,
      operationSlug: draft.operationSlug,
      envelopeXml: draft.envelopeXml,
      soapVersion: draft.soapVersion,
      headers: draft.headers,
      order: draft.order,
    };
    useProjectStore.setState({
      interfaces: {},
      requests: { r1: draftWithoutEndpoint },
      order: [],
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
      log: Array.from({ length: 500 }, (_, i) => logExchange(exchangeSummary(`old-${String(i)}`))),
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
    expect(sendIdOf(log.at(-1)!)).toBe('new-1');
    expect(sendIdOf(log[0]!)).toBe('old-1');
  });

  it('clearRequest deletes the exchange entry but keeps the log', () => {
    const summary = exchangeSummary('send-1');
    useExchangesStore.setState({
      byRequest: { r1: { status: 'done', sendId: 'send-1', exchange: summary } },
      log: [logExchange(summary)],
    });

    useExchangesStore.getState().clearRequest('r1');

    const state = useExchangesStore.getState();
    expect(state.byRequest['r1']).toBeUndefined();
    expect(state.log).toHaveLength(1);
    expect(sendIdOf(state.log[0]!)).toBe('send-1');
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

describe('useExchangesStore: failures and the filter', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [], filter: EMPTY_FILTER });
    stubIpc();
  });

  it('appendFailure appends a failure entry, newest last', () => {
    useExchangesStore.setState({ log: [logExchange(exchangeSummary('send-1'))] });

    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'send-2' }));

    const { log } = useExchangesStore.getState();
    expect(log.map(sendIdOf)).toEqual(['send-1', 'send-2']);
    expect(log[1]?.kind).toBe('failure');
  });

  it('appendFailure ignores a sendId already in the log, whichever kind holds it', () => {
    useExchangesStore.setState({ log: [logExchange(exchangeSummary('send-1'))] });

    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'send-1' }));
    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'send-2' }));
    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'send-2' }));

    expect(useExchangesStore.getState().log.map(sendIdOf)).toEqual(['send-1', 'send-2']);
  });

  it('appendFailure keeps the 500 cap, dropping the oldest', () => {
    useExchangesStore.setState({
      log: Array.from({ length: 500 }, (_, i) => logExchange(exchangeSummary(`old-${String(i)}`))),
    });

    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'new-1' }));

    const { log } = useExchangesStore.getState();
    expect(log).toHaveLength(500);
    expect(sendIdOf(log[0]!)).toBe('old-1');
    expect(sendIdOf(log.at(-1)!)).toBe('new-1');
  });

  it('setFilter merges a patch and resetFilter restores the empty filter', () => {
    useExchangesStore.getState().setFilter({ text: 'pet' });
    useExchangesStore.getState().setFilter({ statuses: ['4xx', 'failed'] });

    expect(useExchangesStore.getState().filter).toEqual({
      text: 'pet',
      regex: false,
      matchCase: false,
      methods: [],
      statuses: ['4xx', 'failed'],
      protocols: [],
    });

    useExchangesStore.getState().resetFilter();
    expect(useExchangesStore.getState().filter).toEqual(EMPTY_FILTER);
  });

  it('reset drops the filter with the log', () => {
    useExchangesStore.getState().setFilter({ text: 'pet' });
    useExchangesStore.getState().appendFailure(makeFailure());

    useExchangesStore.getState().reset();

    expect(useExchangesStore.getState().log).toEqual([]);
    expect(useExchangesStore.getState().filter).toEqual(EMPTY_FILTER);
  });

  it('lastExchangeOf skips failures', () => {
    const summary = exchangeSummary('send-1');
    expect(lastExchangeOf([logExchange(summary), { kind: 'failure', failure: makeFailure() }])).toBe(summary);
    expect(lastExchangeOf([{ kind: 'failure', failure: makeFailure() }])).toBeUndefined();
  });

  it('subscribeToExchangeFailures appends what exchange.failed carries and unsubscribes', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const off = vi.fn();
    installWirebenchApi({
      on: vi.fn((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return off;
      }) as never,
    });

    const unsubscribe = subscribeToExchangeFailures();
    listeners.get('exchange.failed')?.({ failure: makeFailure({ sendId: 'evt-1' }) });

    expect(useExchangesStore.getState().log.map(sendIdOf)).toEqual(['evt-1']);
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('subscribeToExchangeLogged appends what exchange.logged carries, once, and unsubscribes', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const off = vi.fn();
    installWirebenchApi({
      on: vi.fn((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return off;
      }) as never,
    });

    const unsubscribe = subscribeToExchangeLogged();
    listeners.get('exchange.logged')?.({ entry: logExchange(exchangeSummary('evt-1')) });

    expect(useExchangesStore.getState().log.map(sendIdOf)).toEqual(['evt-1']);
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('appendLoggedEntry ignores a sendId already in the log, like its siblings', () => {
    useExchangesStore.setState({ log: [logExchange(exchangeSummary('send-1'))] });

    useExchangesStore.getState().appendLoggedEntry(logExchange(exchangeSummary('send-1')));
    useExchangesStore.getState().appendLoggedEntry(logExchange(exchangeSummary('send-2')));
    useExchangesStore.getState().appendLoggedEntry(logExchange(exchangeSummary('send-2')));

    expect(useExchangesStore.getState().log.map(sendIdOf)).toEqual(['send-1', 'send-2']);
  });

  it('a replayed exchange.logged event appears in the log once', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    installWirebenchApi({
      on: vi.fn((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return vi.fn();
      }) as never,
    });

    subscribeToExchangeLogged();
    const payload = { entry: logExchange(exchangeSummary('evt-1')) };
    listeners.get('exchange.logged')?.(payload);
    listeners.get('exchange.logged')?.(payload);

    expect(useExchangesStore.getState().log.map(sendIdOf)).toEqual(['evt-1']);
  });

  it('cycleSort goes asc → desc → off; another column restarts at asc; resetFilter clears it', () => {
    useExchangesStore.setState({ sort: undefined });
    const { cycleSort } = useExchangesStore.getState();
    cycleSort('duration');
    expect(useExchangesStore.getState().sort).toEqual({ column: 'duration', direction: 'asc' });
    cycleSort('duration');
    expect(useExchangesStore.getState().sort).toEqual({ column: 'duration', direction: 'desc' });
    cycleSort('duration');
    expect(useExchangesStore.getState().sort).toBeUndefined();
    cycleSort('status');
    cycleSort('name');
    expect(useExchangesStore.getState().sort).toEqual({ column: 'name', direction: 'asc' });
    useExchangesStore.getState().resetFilter();
    expect(useExchangesStore.getState().sort).toBeUndefined();
  });
});

describe('the HTTP Log row limit', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [], filter: EMPTY_FILTER, logCap: 500 });
  });

  it('setLogCap trims the oldest rows at once and caps later appends', () => {
    useExchangesStore.setState({
      log: Array.from({ length: 150 }, (_, i) => ({
        kind: 'failure' as const,
        failure: makeFailure({ sendId: `f${String(i)}` }),
      })),
    });
    useExchangesStore.getState().setLogCap(100);
    expect(useExchangesStore.getState().log).toHaveLength(100);
    expect(sendIdOf(useExchangesStore.getState().log[0]!)).toBe('f50');
    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'new' }));
    expect(useExchangesStore.getState().log).toHaveLength(100);
    expect(sendIdOf(useExchangesStore.getState().log.at(-1)!)).toBe('new');
    useExchangesStore.getState().setLogCap(200);
    expect(useExchangesStore.getState().log).toHaveLength(100);
  });

  it('applying preferences sets the cap from ui.logSize', () => {
    usePreferencesStore.getState().applyPreferences({
      ...DEFAULT_PREFERENCES_WIRE,
      ui: { ...DEFAULT_PREFERENCES_WIRE.ui, logSize: 250 },
    });
    expect(useExchangesStore.getState().logCap).toBe(250);
    usePreferencesStore.getState().applyPreferences(DEFAULT_PREFERENCES_WIRE);
  });
});

describe('Preserve log', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [], filter: EMPTY_FILTER, preserveLog: false });
  });

  it('reset keeps the log, filter and sort when preserveLog is on, and clears them when off', () => {
    useExchangesStore.setState({
      log: [{ kind: 'failure', failure: makeFailure() }],
      filter: { ...EMPTY_FILTER, text: 'pets' },
      sort: { column: 'name', direction: 'asc' },
    });
    useExchangesStore.getState().setPreserveLog(true);
    useExchangesStore.getState().reset();
    expect(useExchangesStore.getState().log).toHaveLength(1);
    expect(useExchangesStore.getState().filter.text).toBe('pets');
    expect(useExchangesStore.getState().sort).toEqual({ column: 'name', direction: 'asc' });
    expect(useExchangesStore.getState().preserveLog).toBe(true);
    useExchangesStore.getState().setPreserveLog(false);
    useExchangesStore.getState().reset();
    expect(useExchangesStore.getState().log).toHaveLength(0);
    expect(useExchangesStore.getState().filter).toEqual(EMPTY_FILTER);
    expect(useExchangesStore.getState().sort).toBeUndefined();
  });

  it('clearLog empties the log even when preserved', () => {
    useExchangesStore.setState({ log: [{ kind: 'failure', failure: makeFailure() }], preserveLog: true });
    useExchangesStore.getState().clearLog();
    expect(useExchangesStore.getState().log).toHaveLength(0);
  });

  it('refreshExchange swaps a REST row and its request state for the re-redacted copy', async () => {
    const hidden = makeRestExchange({ sendId: 'rest-1', url: 'https://api.test/pet?api_key=<redacted>' });
    const shown = makeRestExchange({ sendId: 'rest-1', url: 'https://api.test/pet?api_key=k3y' });
    installWirebenchApi({ exchanges: { get: vi.fn().mockResolvedValue({ ok: true, value: shown }) } });
    useExchangesStore.setState({
      log: [logExchange(hidden, 'rq-1')],
      restByRequest: { 'rq-1': { status: 'done', sendId: 'rest-1', exchange: hidden } },
    });

    await useExchangesStore.getState().refreshExchange('rest-1');

    const state = useExchangesStore.getState();
    expect(state.log[0]).toEqual(logExchange(shown, 'rq-1'));
    expect(state.restByRequest['rq-1']?.exchange?.url).toBe('https://api.test/pet?api_key=k3y');
    expect(state.byRequest['rq-1']).toBeUndefined();
  });
});
