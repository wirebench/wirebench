import { describe, expect, it } from 'vitest';
import { effectiveAuth } from '../../../src/project/endpoints.js';
import type { EndpointAuth } from '../../../src/project/model.js';

const NONE: EndpointAuth = { type: 'none' };
const REQUEST: EndpointAuth = { type: 'basic', username: 'req', passwordRef: 'ref-req', preemptive: true };
const ENDPOINT: EndpointAuth = { type: 'basic', username: 'end', passwordRef: 'ref-end', preemptive: false };
const INTERFACE: EndpointAuth = { type: 'basic', username: 'iface', passwordRef: 'ref-iface' };

describe('effectiveAuth', () => {
  const table: {
    readonly mode: 'override' | 'complement';
    readonly request: EndpointAuth | undefined;
    readonly endpoint: EndpointAuth | undefined;
    readonly expected: EndpointAuth | undefined;
  }[] = [
    // override: a defined endpoint auth replaces the request's, including an explicit "none".
    { mode: 'override', request: REQUEST, endpoint: ENDPOINT, expected: ENDPOINT },
    { mode: 'override', request: REQUEST, endpoint: NONE, expected: NONE },
    { mode: 'override', request: REQUEST, endpoint: undefined, expected: REQUEST },
    { mode: 'override', request: NONE, endpoint: ENDPOINT, expected: ENDPOINT },
    { mode: 'override', request: NONE, endpoint: undefined, expected: NONE },
    { mode: 'override', request: undefined, endpoint: ENDPOINT, expected: ENDPOINT },
    { mode: 'override', request: undefined, endpoint: NONE, expected: NONE },
    { mode: 'override', request: undefined, endpoint: undefined, expected: undefined },
    // complement: the endpoint only fills in what the request left blank.
    { mode: 'complement', request: REQUEST, endpoint: ENDPOINT, expected: REQUEST },
    { mode: 'complement', request: REQUEST, endpoint: NONE, expected: REQUEST },
    { mode: 'complement', request: REQUEST, endpoint: undefined, expected: REQUEST },
    { mode: 'complement', request: NONE, endpoint: ENDPOINT, expected: ENDPOINT },
    { mode: 'complement', request: NONE, endpoint: undefined, expected: NONE },
    { mode: 'complement', request: undefined, endpoint: ENDPOINT, expected: ENDPOINT },
    { mode: 'complement', request: undefined, endpoint: NONE, expected: NONE },
    { mode: 'complement', request: undefined, endpoint: undefined, expected: undefined },
  ];

  for (const row of table) {
    it(`${row.mode}: request ${describeAuth(row.request)} + endpoint ${describeAuth(row.endpoint)}`, () => {
      expect(effectiveAuth(row.request, row.endpoint, row.mode)).toEqual(row.expected);
    });
  }

  it('complement fills each blank field individually', () => {
    expect(
      effectiveAuth(
        { type: 'basic', username: 'req' },
        { type: 'ntlm', passwordRef: 'p', domain: 'CORP', preemptive: true },
        'complement',
      ),
    ).toEqual({ type: 'basic', username: 'req', passwordRef: 'p', domain: 'CORP', preemptive: true });
  });

  it('complement takes the endpoint type when the request asks for none', () => {
    expect(effectiveAuth({ type: 'none', username: 'req' }, { type: 'basic', passwordRef: 'p' }, 'complement')).toEqual(
      {
        type: 'basic',
        username: 'req',
        passwordRef: 'p',
      },
    );
  });

  it('complement keeps an explicit preemptive false over the endpoint true', () => {
    expect(
      effectiveAuth({ type: 'basic', preemptive: false }, { type: 'basic', preemptive: true }, 'complement'),
    ).toEqual({ type: 'basic', preemptive: false });
  });

  it('falls back to the interface only when neither request nor endpoint configured auth', () => {
    expect(effectiveAuth(undefined, undefined, 'override', INTERFACE)).toEqual(INTERFACE);
    expect(effectiveAuth(undefined, undefined, 'complement', INTERFACE)).toEqual(INTERFACE);
    expect(effectiveAuth(undefined, NONE, 'override', INTERFACE)).toEqual(NONE);
    expect(effectiveAuth(REQUEST, undefined, 'complement', INTERFACE)).toEqual(REQUEST);
  });
});

function describeAuth(auth: EndpointAuth | undefined): string {
  return auth === undefined ? 'undefined' : auth.type === 'none' ? 'none' : `basic(${auth.username ?? ''})`;
}
