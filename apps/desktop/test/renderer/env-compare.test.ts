// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { summarise, toCompareColumns } from '../../src/renderer/features/multi-env/env-compare.js';
import type { EnvSendResult } from '../../src/shared/wire-types.js';
import { makeExchange, makeRestExchange } from '../mocks/wire-fixtures.js';

function rest(environmentId: string, text: string, status = 200): EnvSendResult {
  const exchange = makeRestExchange({ text });
  return {
    outcome: 'ok',
    environmentId,
    environmentName: environmentId.toUpperCase(),
    kind: 'rest',
    rest: { ...exchange, url: `https://${environmentId}.example/pets`, http: { ...exchange.http, status } },
  };
}

function soap(environmentId: string, envelopeXml: string, fault = false): EnvSendResult {
  const exchange = makeExchange({
    response: {
      envelopeXml,
      version: '1.1',
      isSoap: true,
      attachments: [],
      ...(fault ? { fault: { version: '1.1' as const, code: 'soap:Server', subcodes: [], reason: 'Boom' } } : {}),
    },
  });
  return { outcome: 'ok', environmentId, environmentName: environmentId, kind: 'soap', soap: exchange };
}

function failed(environmentId: string): EnvSendResult {
  return {
    outcome: 'error',
    environmentId,
    environmentName: environmentId,
    code: 'connection-refused',
    message: 'Connection refused.',
  };
}

describe('toCompareColumns', () => {
  it('gives one column per environment, in order, with its URL, status, time, size and body', () => {
    const columns = toCompareColumns([rest('dev', '{"a":1}'), failed('test'), soap('prod', '<a/>')]);

    expect(columns.map((column) => column.environmentId)).toEqual(['dev', 'test', 'prod']);
    expect(columns[0]).toMatchObject({
      environmentName: 'DEV',
      outcome: 'ok',
      url: 'https://dev.example/pets',
      status: 200,
      durationMs: 12,
      sizeBytes: 7,
      body: '{\n  "a": 1\n}',
      language: 'json',
      headers: { 'content-type': 'application/json' },
    });
    expect(columns[1]).toMatchObject({ outcome: 'error', error: 'Connection refused.' });
    expect(columns[2]).toMatchObject({ url: 'https://example.test/calc.asmx', fault: false, language: 'xml' });
  });
});

describe('summarise', () => {
  it('calls bodies differing only in JSON whitespace the same', () => {
    expect(summarise(rest('dev', '{"a":1,"b":[1,2]}'), rest('test', '{ "a": 1,\n "b": [ 1, 2 ] }'))).toBe('same');
  });

  it('calls bodies differing only in XML formatting the same', () => {
    expect(summarise(soap('dev', '<r><v>1</v></r>'), soap('test', '<r>\n  <v>1</v>\n</r>'))).toBe('same');
  });

  it('reports a body that differs', () => {
    expect(summarise(rest('dev', '{"a":1}'), rest('test', '{"a":2}'))).toBe('body-differs');
  });

  it('puts a status mismatch ahead of a body difference', () => {
    expect(summarise(rest('dev', '{"a":1}'), rest('test', '{"a":2}', 500))).toBe('status-differs');
    expect(summarise(soap('dev', '<r/>'), soap('test', '<r/>', true))).toBe('status-differs');
  });

  it('reports a failed side as failed', () => {
    expect(summarise(rest('dev', '{}'), failed('test'))).toBe('failed');
    expect(summarise(failed('dev'), rest('test', '{}'))).toBe('failed');
  });
});
