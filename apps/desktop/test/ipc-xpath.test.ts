// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerXpathChannels } from '../src/main/ipc/xpath.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">' +
  '<soapenv:Body><tem:AddResponse><tem:AddResult>3</tem:AddResult></tem:AddResponse></soapenv:Body>' +
  '</soapenv:Envelope>';

describe('xpath.* IPC', () => {
  beforeEach(() => {
    handlers.clear();
    registerXpathChannels();
  });

  it('xpath.evaluate resolves an XPath 3.1 expression against the given xml', async () => {
    const result = (await invoke('xpath.evaluate', {
      xml: ADD_RESPONSE,
      expression: '//tem:AddResult/text()',
      language: 'xpath',
      namespaces: { tem: 'http://tempuri.org/' },
    })) as { ok: true; value: { kind: string; items: { text: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('nodes');
    expect(result.value.items[0]?.text).toBe('3');
  });

  it('xpath.evaluate runs XQuery 3.1 expressions', async () => {
    const result = (await invoke('xpath.evaluate', {
      xml: ADD_RESPONSE,
      expression: 'count(//*)',
      language: 'xquery',
    })) as { ok: true; value: { kind: string; items: { text: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('values');
    expect(result.value.items[0]?.text).toBe('4');
  });

  it('xpath.evaluate reports a syntax error as a validated error result, not a rejection', async () => {
    const result = (await invoke('xpath.evaluate', {
      xml: ADD_RESPONSE,
      expression: '//[',
      language: 'xpath',
    })) as { ok: true; value: { kind: string; message?: string } };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('error');
    expect(result.value.message).toContain('XPST0003');
  });

  it('xpath.evaluate runs JSONPath against a JSON body, with the path on each match', async () => {
    const result = (await invoke('xpath.evaluate', {
      xml: '{"items":[{"id":1,"status":"open"},{"id":2,"status":"shut"}]}',
      expression: '$.items[?(@.status=="open")].id',
      language: 'jsonpath',
      kind: 'json',
    })) as { ok: true; value: { kind: string; items: { text: string; type: string; path?: string }[] } };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('values');
    // The optional `path` has to survive the response schema: it is what the Query view renders
    // above each JSONPath match, and a zod object drops a key it does not declare.
    expect(result.value.items).toEqual([{ text: '1', type: 'number', path: "$['items'][0]['id']" }]);
  });

  it('xpath.evaluate refuses JSONPath against an XML document instead of guessing', async () => {
    const result = (await invoke('xpath.evaluate', {
      xml: ADD_RESPONSE,
      expression: '$.a',
      language: 'jsonpath',
    })) as { ok: true; value: { kind: string; message?: string } };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe('error');
    expect(result.value.message).toContain('JSON response');
  });

  it('xpath.evaluate rejects a language the channel does not know', async () => {
    const result = (await invoke('xpath.evaluate', {
      xml: ADD_RESPONSE,
      expression: '//*',
      language: 'jmespath',
    })) as { ok: false; error: { code: string } };

    expect(result.ok).toBe(false);
  });

  it('xpath.namespaces reports the bound prefixes and suggestions for a document', async () => {
    const result = (await invoke('xpath.namespaces', { xml: ADD_RESPONSE })) as {
      ok: true;
      value: { namespaces: Record<string, string>; suggestions: Record<string, string> };
    };

    expect(result.ok).toBe(true);
    expect(result.value.namespaces).toEqual({
      soapenv: 'http://schemas.xmlsoap.org/soap/envelope/',
      tem: 'http://tempuri.org/',
    });
    expect(result.value.suggestions).toEqual({});
  });

  it('xpath.namespaces reports a validated error for malformed xml instead of rejecting', async () => {
    const result = (await invoke('xpath.namespaces', { xml: '<not-closed>' })) as {
      ok: false;
      error: { code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.code).toBeDefined();
  });
});

describe('xpath.evaluate wiring (mocked engine)', () => {
  it('calls the time-bounded evaluateWithTimeout, not the synchronous evaluate', async () => {
    vi.resetModules();
    const evaluateWithTimeout = vi.fn().mockResolvedValue({ kind: 'empty' });
    vi.doMock('@wirebench/engine', () => ({
      evaluateWithTimeout,
      collectNamespaces: vi.fn(),
      suggestPrefixes: vi.fn(),
    }));

    const localHandlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    vi.doMock('electron', () => ({
      ipcMain: {
        handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
          localHandlers.set(name, handler);
        },
      },
    }));

    const { registerXpathChannels: register } = await import('../src/main/ipc/xpath.js');
    register();
    const handler = localHandlers.get('xpath.evaluate');
    expect(handler).toBeDefined();
    await handler?.({ sender: {} }, { xml: ADD_RESPONSE, expression: '//*', language: 'xpath' });

    expect(evaluateWithTimeout).toHaveBeenCalledTimes(1);

    vi.doUnmock('@wirebench/engine');
    vi.doUnmock('electron');
    vi.resetModules();
  });
});
