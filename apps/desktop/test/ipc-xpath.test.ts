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
