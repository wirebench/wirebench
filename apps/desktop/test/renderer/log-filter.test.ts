import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER } from '../../src/renderer/state/exchanges.js';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import {
  matchesFilter,
  methodOf,
  methodsIn,
  protocolOf,
  stageOf,
  statusClassOf,
  statusLabelOf,
  urlOf,
} from '../../src/renderer/features/console/log-filter.js';
import { logExchange, makeExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

function withStatus(status: number): LogEntry {
  const base = makeRestExchange();
  return logExchange(makeRestExchange({ http: { ...base.http, status } }));
}

const soap = logExchange(makeExchange());
const rest = logExchange(makeRestExchange());
const failed: LogEntry = { kind: 'failure', failure: makeFailure() };

describe('entry accessors', () => {
  it('reads protocol, method and URL from either kind', () => {
    expect(protocolOf(soap)).toBe('soap');
    expect(protocolOf(rest)).toBe('rest');
    expect(protocolOf(failed)).toBe('rest');
    expect(methodOf(soap)).toBe('POST');
    expect(methodOf(failed)).toBe('GET');
    expect(urlOf(rest)).toBe('https://api.test/pet/1');
    expect(urlOf(failed)).toBe('http://127.0.0.1:1/nope');
  });

  it('classes a status by its hundreds; a failure is failed; a SOAP fault with a 200 is still 2xx', () => {
    expect(statusClassOf(withStatus(204))).toBe('2xx');
    expect(statusClassOf(withStatus(302))).toBe('3xx');
    expect(statusClassOf(withStatus(404))).toBe('4xx');
    expect(statusClassOf(withStatus(503))).toBe('5xx');
    expect(statusClassOf(failed)).toBe('failed');
    const faulted = logExchange(
      makeExchange({
        response: {
          envelopeXml: '<f/>',
          version: '1.1',
          isSoap: true,
          attachments: [],
          fault: { version: '1.1', code: 'Server', subcodes: [], reason: 'boom' },
        },
      }),
    );
    expect(statusClassOf(faulted)).toBe('2xx');
  });

  it('lists the methods present, unique, upper-case and sorted', () => {
    const base = makeRestExchange();
    const lower = logExchange(
      makeRestExchange({ http: { ...base.http, request: { ...base.http.request, method: 'delete' } } }),
    );
    expect(methodsIn([soap, rest, failed, lower, rest])).toEqual(['DELETE', 'GET', 'POST']);
  });
});

describe('matchesFilter', () => {
  it('matches everything with the empty filter', () => {
    expect([soap, rest, failed].every((entry) => matchesFilter(entry, EMPTY_FILTER))).toBe(true);
  });

  it('narrows by URL text, case-insensitively', () => {
    expect(matchesFilter(rest, { ...EMPTY_FILTER, text: 'PET/1' })).toBe(true);
    expect(matchesFilter(soap, { ...EMPTY_FILTER, text: 'pet/1' })).toBe(false);
  });

  it('narrows by method, status class and protocol', () => {
    expect(matchesFilter(soap, { ...EMPTY_FILTER, methods: ['POST'] })).toBe(true);
    expect(matchesFilter(rest, { ...EMPTY_FILTER, methods: ['POST'] })).toBe(false);
    expect(matchesFilter(withStatus(404), { ...EMPTY_FILTER, statuses: ['4xx'] })).toBe(true);
    expect(matchesFilter(failed, { ...EMPTY_FILTER, statuses: ['4xx'] })).toBe(false);
    expect(matchesFilter(failed, { ...EMPTY_FILTER, statuses: ['failed'] })).toBe(true);
    expect(matchesFilter(rest, { ...EMPTY_FILTER, protocols: ['soap'] })).toBe(false);
    expect(matchesFilter(soap, { ...EMPTY_FILTER, protocols: ['soap'] })).toBe(true);
  });

  it('combines the groups with AND and the values within a group with OR', () => {
    const filter = {
      text: 'api.test',
      regex: false,
      matchCase: false,
      methods: ['GET', 'POST'],
      statuses: ['2xx', 'failed'] as const,
      protocols: ['rest' as const],
    };
    expect(matchesFilter(rest, filter)).toBe(true);
    expect(matchesFilter(soap, filter)).toBe(false); // wrong URL, wrong protocol
    expect(matchesFilter(failed, filter)).toBe(false); // wrong URL
    expect(matchesFilter(withStatus(500), { ...filter, text: '' })).toBe(false); // 5xx not in statuses
  });
});

describe('statusLabelOf / stageOf', () => {
  it('labels a prepare failure "Failed · before send" and a send failure by its code', () => {
    expect(statusLabelOf({ kind: 'failure', failure: makeFailure({ stage: 'prepare' }) })).toBe('Failed · before send');
    expect(statusLabelOf({ kind: 'failure', failure: makeFailure() })).toBe('connection-refused');
    expect(statusLabelOf(logExchange(makeExchange()))).toBe('200');
    expect(stageOf({ kind: 'failure', failure: makeFailure() })).toBe('send');
    expect(stageOf(logExchange(makeExchange()))).toBeUndefined();
  });
});
