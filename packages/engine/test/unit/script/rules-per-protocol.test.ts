// packages/engine/test/unit/script/rules-per-protocol.test.ts
/**
 * The rules a pre-request script's changes are held to (ADR-0016), one test per rule and protocol.
 *
 * Every call goes through `apply` below, so the tests read the same whether the rules branch on the
 * protocol or ask the protocol's module what its snapshot holds. A module that describes its
 * snapshot wrongly — a header list left out, a target that is not the destination — fails one of
 * these.
 */
import { describe, expect, it } from 'vitest';
import type { GrpcRequestSnapshot } from '../../../src/grpc/scripting.js';
import { defaultRegistry } from '../../../src/protocols.js';
import type { RequestSnapshot } from '../../../src/protocols.js';
import type { RestRequestSnapshot } from '../../../src/rest/scripting.js';
import { applyRequestChanges } from '../../../src/script/apply.js';
import type { ScriptFailure } from '../../../src/script/model.js';
import type { SoapRequestSnapshot } from '../../../src/soap/scripting.js';

type Snapshot = RequestSnapshot;

/** The one place this file calls the rules: with the facet the registry holds for the protocol. */
const apply = (before: Snapshot, returned: unknown) => {
  const scripting = defaultRegistry().find(before.protocol)?.scripting;
  if (scripting === undefined) throw new Error(`The registry has no scripting facet for "${before.protocol}"`);
  return applyRequestChanges(scripting, before, returned);
};

const REST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'POST',
  url: 'https://api.test:8443/carts?page=1',
  headers: [['Authorization', 'Bearer ${secret:token}']],
  body: { kind: 'text', text: '{"items":[]}', language: 'json' },
};
const REST_FORM: RestRequestSnapshot = { ...REST, body: { kind: 'other', description: 'a multipart body' } };
const SOAP: SoapRequestSnapshot = {
  protocol: 'soap',
  endpoint: 'https://soap.test/stock',
  soapAction: 'urn:GetQuote',
  headers: [['X-Trace', '1']],
  envelope: '<e>${secret:token}</e>',
};
const GRPC: GrpcRequestSnapshot = {
  protocol: 'grpc',
  target: 'grpc.test:443',
  method: 'shop.Carts/Get',
  metadata: [['x-trace', '1']],
  message: { id: '${secret:token}' },
};

/** What `returned` is refused with, or undefined when it is accepted. */
const refusal = (before: Snapshot, returned: unknown): ScriptFailure | undefined => {
  const result = apply(before, returned);
  return result.ok ? undefined : result.error;
};
const code = (before: Snapshot, returned: unknown): string | undefined => refusal(before, returned)?.code;

const UNREADABLE = 'The script handed back a request the engine cannot read';

describe('REST', () => {
  it('accepts what a script may change: the path, the query, a header, a text body, the method', () => {
    const changed = {
      ...REST,
      method: 'PUT',
      url: 'https://api.test:8443/orders?page=2#top',
      headers: [...REST.headers, ['X-Signed', 'yes']],
      body: { kind: 'text', text: '{"items":["a"]}', language: 'json' },
    };
    expect(apply(REST, changed)).toEqual({ ok: true, request: changed });
    expect(apply(REST_FORM, { ...REST_FORM, headers: [] })).toMatchObject({ ok: true });
  });

  it('rule 1: refuses a shape it cannot read, and another protocol', () => {
    const unreadable = [
      undefined,
      null,
      'rest',
      { protocol: 'rest' },
      { ...REST, headers: [['only-a-name']] },
      SOAP,
      GRPC,
    ];
    for (const returned of unreadable) {
      expect(refusal(REST, returned)).toEqual({ code: 'script-error', message: UNREADABLE });
    }
  });

  it('rule 2: refuses another scheme, host or port', () => {
    for (const url of ['http://api.test:8443/carts', 'https://evil.test:8443/carts', 'https://api.test/carts']) {
      expect(code(REST, { ...REST, url })).toBe('script-origin-change');
    }
  });

  it('rule 2: a destination that is not a URL stays exactly as it was', () => {
    const relative = { ...REST, url: '/carts' };
    expect(code(relative, { ...relative, url: '/orders' })).toBe('script-origin-change');
    expect(apply(relative, relative)).toMatchObject({ ok: true });
  });

  it('rule 3: refuses any change to a body a script cannot edit', () => {
    for (const body of [
      { kind: 'none' },
      { kind: 'text', text: 'x', language: 'text' },
      { kind: 'other', description: 'a binary body' },
    ]) {
      expect(code(REST_FORM, { ...REST_FORM, body })).toBe('script-error');
    }
  });

  it('rule 4: refuses CR, LF or NUL in a header name or value', () => {
    for (const header of [
      ['X-A\r', 'v'],
      ['X-A', 'v\nInjected: 1'],
      ['X-A', 'v\0'],
    ]) {
      expect(code(REST, { ...REST, headers: [...REST.headers, header] })).toBe('script-value-invalid');
    }
  });

  it('rule 4: refuses CR, LF or NUL in the URL', () => {
    for (const url of ['https://api.test:8443/carts\r\nHost: evil.test', 'https://api.test:8443/carts\0']) {
      expect(code(REST, { ...REST, url })).toBe('script-value-invalid');
    }
  });

  it('rule 5: refuses a secret reference the request did not hold, wherever it is put', () => {
    for (const changed of [
      { ...REST, url: 'https://api.test:8443/carts?key=${secret:other}' },
      { ...REST, headers: [...REST.headers, ['X-Key', '${secret:other}']] },
      { ...REST, headers: [...REST.headers, ['${secret:other}', 'v']] },
      { ...REST, body: { kind: 'text', text: '${secret:other}', language: 'text' } },
    ]) {
      expect(refusal(REST, changed)).toMatchObject({
        code: 'script-secret-denied',
        message: expect.stringContaining('other') as unknown,
      });
    }
  });

  it('rule 5: lets a script move a reference the request already held', () => {
    const moved = {
      ...REST,
      headers: [['X-Token', '${secret:token}']],
      body: { kind: 'text', text: '${secret:token}', language: 'text' },
    };
    expect(apply(REST, moved)).toMatchObject({ ok: true });
  });

  it('its own rule: refuses a method that is not an HTTP token', () => {
    for (const method of ['GET /x HTTP/1.1', 'get', '', 'A'.repeat(33)]) {
      expect(refusal(REST, { ...REST, method })).toEqual({
        code: 'script-value-invalid',
        message: `"${method}" is not an HTTP method`,
      });
    }
  });
});

describe('SOAP', () => {
  it('accepts what a script may change: the path, the SOAPAction, a header, the envelope', () => {
    const changed = {
      ...SOAP,
      endpoint: 'https://soap.test/stock/v2',
      soapAction: 'urn:GetQuotes',
      headers: [['X-Trace', '2']],
      envelope: '<e><q>${secret:token}</q></e>',
    };
    expect(apply(SOAP, changed)).toEqual({ ok: true, request: changed });
  });

  it('rule 1: refuses a shape it cannot read, and another protocol', () => {
    for (const returned of [undefined, { protocol: 'soap' }, { ...SOAP, envelope: 7 }, REST, GRPC]) {
      expect(refusal(SOAP, returned)).toEqual({ code: 'script-error', message: UNREADABLE });
    }
  });

  it('rule 2: refuses another scheme, host or port', () => {
    for (const endpoint of ['http://soap.test/stock', 'https://evil.test/stock', 'https://soap.test:8443/stock']) {
      expect(code(SOAP, { ...SOAP, endpoint })).toBe('script-origin-change');
    }
  });

  it('rule 3: has nothing to hold for SOAP, every part is one a script may change, the typed body view included', () => {
    const changed = {
      ...SOAP,
      soapAction: '',
      headers: [],
      envelope: '',
      body: { anything: 'the envelope is what is sent' },
    };
    expect(apply(SOAP, changed)).toEqual({ ok: true, request: changed });
  });

  it('rule 4: refuses CR, LF or NUL in a header name or value', () => {
    for (const header of [
      ['X-A\n', 'v'],
      ['X-A', 'v\r\nInjected: 1'],
      ['X-A', 'v\0'],
    ]) {
      expect(code(SOAP, { ...SOAP, headers: [header] })).toBe('script-value-invalid');
    }
  });

  it('rule 4: refuses CR, LF or NUL in the endpoint and in the SOAPAction', () => {
    expect(code(SOAP, { ...SOAP, endpoint: 'https://soap.test/stock\r\nHost: evil.test' })).toBe(
      'script-value-invalid',
    );
    for (const soapAction of ['urn:a\rb', 'urn:a\nb', 'urn:a\0b']) {
      expect(code(SOAP, { ...SOAP, soapAction })).toBe('script-value-invalid');
    }
  });

  it('rule 5: refuses a secret reference the request did not hold, wherever it is put', () => {
    for (const changed of [
      { ...SOAP, endpoint: 'https://soap.test/${secret:other}' },
      { ...SOAP, soapAction: '${secret:other}' },
      { ...SOAP, headers: [['X-Key', '${secret:other}']] },
      { ...SOAP, envelope: '<e>${secret:token}${secret:other}</e>' },
    ]) {
      expect(refusal(SOAP, changed)).toMatchObject({
        code: 'script-secret-denied',
        message: expect.stringContaining('other') as unknown,
      });
    }
  });

  it('rule 5: lets a script move a reference the request already held', () => {
    expect(apply(SOAP, { ...SOAP, headers: [['X-Token', '${secret:token}']] })).toMatchObject({ ok: true });
  });
});

describe('gRPC', () => {
  it('accepts what a script may change: the metadata and the message', () => {
    const changed = { ...GRPC, metadata: [['x-trace', '2']], message: { id: '${secret:token}', page: 2 } };
    expect(apply(GRPC, changed)).toEqual({ ok: true, request: changed });
  });

  it('rule 1: refuses a shape it cannot read, and another protocol', () => {
    for (const returned of [undefined, { protocol: 'grpc' }, { ...GRPC, metadata: 'x-trace: 1' }, REST, SOAP]) {
      expect(refusal(GRPC, returned)).toEqual({ code: 'script-error', message: UNREADABLE });
    }
  });

  it('rule 2: refuses any other target, a port or a path included', () => {
    for (const target of ['evil.test:443', 'grpc.test:8443', 'grpc.test', 'grpc.test:443/x', 'grpcs://grpc.test:443']) {
      expect(code(GRPC, { ...GRPC, target })).toBe('script-origin-change');
    }
    const url = { ...GRPC, target: 'grpcs://grpc.test:443' };
    for (const target of ['grpcs://grpc.test:8443', 'grpc://grpc.test:443', 'grpcs://grpc.test:443/x']) {
      expect(code(url, { ...url, target })).toBe('script-origin-change');
    }
  });

  it('rule 3: refuses another method', () => {
    expect(code(GRPC, { ...GRPC, method: 'shop.Carts/Delete' })).toBe('script-error');
  });

  it('rule 4: refuses CR, LF or NUL in a metadata name or value', () => {
    for (const entry of [
      ['x-a\r', 'v'],
      ['x-a', 'v\n'],
      ['x-a', 'v\0'],
    ]) {
      expect(code(GRPC, { ...GRPC, metadata: [entry] })).toBe('script-value-invalid');
    }
  });

  it('rule 5: refuses a secret reference the request did not hold, wherever it is put', () => {
    for (const changed of [
      { ...GRPC, metadata: [['x-key', '${secret:other}']] },
      { ...GRPC, message: { id: '${secret:token}', key: '${secret:other}' } },
    ]) {
      expect(refusal(GRPC, changed)).toMatchObject({
        code: 'script-secret-denied',
        message: expect.stringContaining('other') as unknown,
      });
    }
  });

  it('rule 5: lets a script move a reference the request already held', () => {
    expect(apply(GRPC, { ...GRPC, metadata: [['x-token', '${secret:token}']] })).toMatchObject({ ok: true });
  });
});

describe('which refusal is reported when two rules are broken at once', () => {
  it('REST: a line break in the URL before the origin, the origin before a header, a header before a secret', () => {
    expect(code(REST, { ...REST, url: 'https://evil.test/carts\r\n' })).toBe('script-value-invalid');
    expect(code(REST, { ...REST, url: 'https://evil.test/carts', headers: [['X-A', 'v\n']] })).toBe(
      'script-origin-change',
    );
    expect(code(REST, { ...REST, headers: [['X-A\n', '${secret:other}']] })).toBe('script-value-invalid');
  });

  it('SOAP: a line break in the endpoint before the origin, the origin before a header, a header before a secret', () => {
    expect(code(SOAP, { ...SOAP, endpoint: 'https://evil.test/stock\n' })).toBe('script-value-invalid');
    expect(code(SOAP, { ...SOAP, endpoint: 'https://evil.test/stock', headers: [['X-A', 'v\n']] })).toBe(
      'script-origin-change',
    );
    expect(code(SOAP, { ...SOAP, headers: [['X-A\n', '${secret:other}']] })).toBe('script-value-invalid');
  });

  it('gRPC: the target before the method, the method before the metadata, the metadata before a secret', () => {
    expect(code(GRPC, { ...GRPC, target: 'evil.test:443', method: 'shop.Carts/Delete' })).toBe('script-origin-change');
    expect(code(GRPC, { ...GRPC, method: 'shop.Carts/Delete', metadata: [['x-a', 'v\0']] })).toBe('script-error');
    expect(code(GRPC, { ...GRPC, metadata: [['x-a\n', '${secret:other}']] })).toBe('script-value-invalid');
  });
});
