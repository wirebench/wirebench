import { describe, expect, it } from 'vitest';
import {
  comparableBodies,
  diffHeaders,
  requestBodyOf,
  responseBodyOf,
} from '../../src/renderer/features/console/log-compare.js';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import { b64, logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

describe('diffHeaders', () => {
  it('marks added, removed, changed and same, case-insensitively, sorted by name', () => {
    expect(
      diffHeaders({ Accept: '*/*', 'X-A': '1', 'x-gone': 'g' }, { accept: '*/*', 'X-A': '2', 'X-New': 'n' }),
    ).toEqual([
      { name: 'Accept', left: '*/*', right: '*/*', change: 'same' },
      { name: 'X-A', left: '1', right: '2', change: 'changed' },
      { name: 'x-gone', left: 'g', change: 'removed' },
      { name: 'X-New', right: 'n', change: 'added' },
    ]);
  });
});

describe('comparableBodies', () => {
  it('pretty-prints JSON when both sides parse', () => {
    expect(comparableBodies('{"a":1}', '{"a":2}')).toEqual({
      left: '{\n  "a": 1\n}',
      right: '{\n  "a": 2\n}',
      language: 'json',
    });
  });

  it('leaves text as is when only one side parses', () => {
    expect(comparableBodies('{"a":1}', 'oops')).toEqual({ left: '{"a":1}', right: 'oops', language: 'plaintext' });
  });

  it('recognises XML on both sides', () => {
    expect(comparableBodies('<a><b/></a>', '<a><c/></a>').language).toBe('xml');
  });
});

describe('bodies of a row', () => {
  it('takes the request body after the blank line and decodes the response body', () => {
    const e = makeRestExchange({ sendId: 'a' });
    const entry = logExchange({
      ...e,
      http: { ...e.http, rawRequestBase64: b64('POST / HTTP/1.1\r\nHost: x\r\n\r\n{"q":1}'), bodyBase64: b64('ok') },
    });
    expect(requestBodyOf(entry)).toBe('{"q":1}');
    expect(responseBodyOf(entry)).toBe('ok');
  });

  it('gives a failure no response body', () => {
    const entry: LogEntry = { kind: 'failure', failure: makeFailure() };
    expect(responseBodyOf(entry)).toBe('');
  });
});
