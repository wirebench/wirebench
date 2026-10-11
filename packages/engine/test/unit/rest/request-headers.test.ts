/**
 * `restHeaderRows`: the one place a REST send's headers are merged, read by the send and by the
 * Headers tab's preview, so the two cannot disagree about what goes on the wire.
 */
import { describe, expect, it } from 'vitest';
import { entry } from '../../../src/rest/model.js';
import { headersOfRows, restHeaderRows } from '../../../src/rest/request-headers.js';

describe('restHeaderRows', () => {
  it('lists each generated header with its source, lowest layer first', () => {
    const rows = restHeaderRows({
      defaults: { 'User-Agent': 'wb/1', Accept: '*/*' },
      auth: { Authorization: 'Bearer t' },
      contentType: 'application/json',
      cookie: 'a=1',
      typed: [entry('X-Extra', '1')],
    });
    expect(rows.map((row) => [row.name, row.source, row.state])).toEqual([
      ['User-Agent', 'preference', 'sent'],
      ['Accept', 'preference', 'sent'],
      ['Authorization', 'auth', 'sent'],
      ['Content-Type', 'body', 'sent'],
      ['Cookie', 'cookie', 'sent'],
      ['X-Extra', 'typed', 'sent'],
    ]);
  });

  it('marks a generated header a typed one replaces as overridden, case-insensitively', () => {
    const rows = restHeaderRows({
      defaults: { Accept: '*/*' },
      auth: {},
      contentType: 'application/json',
      typed: [entry('accept', 'text/plain'), entry('content-type', 'text/xml')],
    });
    expect(rows.filter((row) => row.state === 'overridden').map((row) => row.name)).toEqual(['Accept', 'Content-Type']);
    expect(headersOfRows(rows)).toEqual({ accept: 'text/plain', 'content-type': 'text/xml' });
  });

  it('marks a lower generated layer a higher one replaces as overridden', () => {
    const rows = restHeaderRows({ defaults: { Accept: '*/*' }, auth: { Accept: 'key' }, typed: [] });
    expect(rows.map((row) => [row.source, row.state])).toEqual([
      ['preference', 'overridden'],
      ['auth', 'sent'],
    ]);
  });

  it('leaves out a generated header the request omits, and keeps a typed one of that name', () => {
    const rows = restHeaderRows({
      defaults: { 'User-Agent': 'wb/1', Accept: '*/*' },
      auth: { Authorization: 'Bearer t' },
      contentType: 'application/json',
      typed: [entry('Accept', 'text/plain')],
      omit: ['user-agent', 'AUTHORIZATION', 'Content-Type', 'Accept'],
    });
    expect(rows.map((row) => [row.name, row.state])).toEqual([
      ['User-Agent', 'omitted'],
      ['Accept', 'overridden'],
      ['Authorization', 'omitted'],
      ['Content-Type', 'omitted'],
      ['Accept', 'sent'],
    ]);
    expect(headersOfRows(rows)).toEqual({ Accept: 'text/plain' });
  });

  it('joins a repeated typed name and skips disabled or nameless rows', () => {
    const rows = restHeaderRows({
      defaults: {},
      auth: {},
      typed: [entry('X-Trace', 'on'), entry('X-Off', '1', { enabled: false }), entry('', 'x'), entry('x-trace', 'v')],
    });
    expect(headersOfRows(rows)).toEqual({ 'x-trace': 'on, v' });
  });
});
