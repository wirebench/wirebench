// @vitest-environment node
/**
 * The main-side half of checking a REST response against its OpenAPI contract: which responses are
 * checked, what reaches the checker, how a broken cache degrades, and that the result survives the
 * wire and History.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import type { RestContractInput, RestContractResult, RestSendInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { buildRestHistoryEntry } from '../src/main/history-service.js';
import { restContractOf, type RestContractTarget } from '../src/main/rest-contract.js';
import { historyEntrySchema, restExchangeSummarySchema } from '../src/shared/wire-types.js';

const responses = {
  '200': { content: { 'application/json': { schema: { type: 'object', required: ['name'] } } } },
};
const target: RestContractTarget = { operation: { method: 'get', path: '/echo' }, responses };
const ok: RestContractResult = {
  status: 'ok',
  operation: { method: 'get', path: '/echo' },
  responseKey: '200',
  mediaType: 'application/json',
  problems: [],
  notes: [],
};

function response(overrides: Partial<Parameters<typeof restContractOf>[0]> = {}): Parameters<typeof restContractOf>[0] {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: '{}',
    language: 'json',
    streamed: false,
    ...overrides,
  };
}

describe('restContractOf', () => {
  it('passes only the selected operation and its responses to the checker', async () => {
    const check = vi.fn<(input: RestContractInput) => Promise<RestContractResult>>(() => Promise.resolve(ok));
    const result = await restContractOf(response(), Promise.resolve(target), check);
    expect(result).toEqual(ok);
    expect(check).toHaveBeenCalledWith({
      status: 200,
      contentType: 'application/json',
      bodyText: '{}',
      language: 'json',
      streamed: false,
      operation: target.operation,
      responses,
    });
  });

  it('finds the content type whatever its case', async () => {
    const check = vi.fn<(input: RestContractInput) => Promise<RestContractResult>>(() => Promise.resolve(ok));
    await restContractOf(
      response({ headers: { 'Content-Type': 'application/problem+json' } }),
      Promise.resolve(target),
      check,
    );
    expect(check.mock.calls[0]?.[0].contentType).toBe('application/problem+json');
  });

  it('checks nothing for a request whose API has no cached definition', async () => {
    const check = vi.fn();
    expect(await restContractOf(response(), undefined, check)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('checks neither a stream nor a body that is not JSON', async () => {
    const check = vi.fn();
    expect(await restContractOf(response({ streamed: true }), Promise.resolve(target), check)).toBeUndefined();
    expect(await restContractOf(response({ language: 'xml' }), Promise.resolve(target), check)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('is no-contract, without asking the checker, when no operation matched', async () => {
    const check = vi.fn();
    expect(await restContractOf(response(), Promise.resolve({}), check)).toEqual({
      status: 'no-contract',
      problems: [],
      notes: [],
    });
    expect(check).not.toHaveBeenCalled();
  });

  it('logs a failing cache read once and yields no-contract', async () => {
    const warn = vi.fn();
    const check = vi.fn();
    const result = await restContractOf(response(), Promise.reject(new Error('cache gone')), check, warn);
    expect(result).toEqual({ status: 'no-contract', problems: [], notes: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('cache gone');
    expect(check).not.toHaveBeenCalled();
  });
});

describe('restContractOf is bounded', () => {
  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

  it('a hung definition lookup gives not-checked within the deadline', async () => {
    const started = Date.now();
    const result = await restContractOf(response(), never<RestContractTarget>(), vi.fn(), undefined, {
      deadlineMs: 600,
    });
    expect(result).toEqual({ status: 'not-checked', problems: [], notes: ['the check took longer than 600 ms'] });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('a saturated checker gives not-checked within the deadline', async () => {
    const started = Date.now();
    const result = await restContractOf(
      response(),
      Promise.resolve(target),
      () => never<RestContractResult>(),
      undefined,
      {
        deadlineMs: 600,
      },
    );
    expect(result?.status).toBe('not-checked');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('a cancelled send stops waiting for the check at once', async () => {
    const controller = new AbortController();
    const pending = restContractOf(response(), Promise.resolve(target), () => never<RestContractResult>(), undefined, {
      deadlineMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 10);
    expect(await pending).toEqual({ status: 'not-checked', problems: [], notes: ['the send was cancelled'] });
  });
});

describe('the contract on the wire and in History', () => {
  let server: TestRestServer;
  beforeAll(async () => {
    server = await startTestRestServer();
  });
  afterAll(async () => {
    await server.close();
  });

  function input(): RestSendInput {
    return {
      baseUrl: server.url,
      request: { method: 'GET', url: '/echo', pathParams: [], query: [], headers: [], body: { kind: 'none' } },
      settings: { timeoutMs: 5_000, followRedirects: true },
    };
  }

  it('a send with a contract attaches the result, which survives the wire parse and the cached view', async () => {
    const engine = new EngineService();
    try {
      const summary = await engine.sendRestRequest(
        { sendId: 'c1', requestId: 'r1', input: input() },
        { contract: Promise.resolve(target) },
      );
      expect(summary.contract?.status).toBe('violation');
      expect(summary.contract?.problems[0]?.keyword).toBe('required');
      expect(restExchangeSummarySchema.parse(summary).contract).toEqual(summary.contract);
      expect(engine.exchanges.getRestView('c1', false)?.contract).toEqual(summary.contract);
    } finally {
      await engine.disposeRestContractChecker();
    }
  });

  it('a send with a hung definition lookup still returns within the deadline, not-checked', async () => {
    const engine = new EngineService();
    engine.restContractDeadlineMs = 600;
    const started = Date.now();
    const summary = await engine.sendRestRequest(
      { sendId: 'c4', requestId: 'r1', input: input() },
      { contract: new Promise<RestContractTarget>(() => undefined) },
    );
    expect(summary.contract?.status).toBe('not-checked');
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('a followed 302 is checked against the final 200 response', async () => {
    const engine = new EngineService();
    try {
      const summary = await engine.sendRestRequest(
        {
          sendId: 'c5',
          requestId: 'r1',
          input: { ...input(), request: { ...input().request, url: '/redirect/302?to=/echo' } },
        },
        { contract: Promise.resolve(target) },
      );
      expect(summary.http.status).toBe(200);
      expect(summary.contract?.responseKey).toBe('200');
    } finally {
      await engine.disposeRestContractChecker();
    }
  });

  it('a send without a contract carries no contract field', async () => {
    const engine = new EngineService();
    const summary = await engine.sendRestRequest({ sendId: 'c2', requestId: 'r1', input: input() });
    expect(summary).not.toHaveProperty('contract');
    await engine.disposeRestContractChecker();
  });

  it('History keeps the result under the caps and parses it back', async () => {
    const engine = new EngineService();
    const sent = await engine.sendRestRequest({ sendId: 'c3', requestId: 'r1', input: input() });
    const summary = {
      ...sent,
      contract: {
        status: 'violation' as const,
        problems: Array.from({ length: 80 }, (_, i) => ({ path: `/${String(i)}`, keyword: 'type', message: 'm' })),
        notes: [],
      },
    };
    const entry = buildRestHistoryEntry('p', {
      requestId: 'r',
      requestName: 'n',
      apiName: 'a',
      folderPath: '',
      method: 'GET',
      url: 'https://x.test/',
      requestHeaders: {},
      requestBody: '',
      exchange: summary,
      durationMs: 1,
    });
    expect(entry.contract?.problems).toHaveLength(50);
    const parsed = historyEntrySchema.parse(JSON.parse(JSON.stringify(entry)));
    expect(parsed.contract).toEqual(entry.contract);
  });
});
