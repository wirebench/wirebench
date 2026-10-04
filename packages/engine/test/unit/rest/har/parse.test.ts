import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HarError } from '../../../../src/errors.js';
import { isHar, parseHarText } from '../../../../src/rest/har/parse.js';

const here = dirname(fileURLToPath(import.meta.url));

function readFixture(rel: string): string {
  return readFileSync(resolve(here, '../../../../../../fixtures', rel), 'utf8');
}

describe('parseHarText', () => {
  it('reads entries in file order with request, response and resource type', () => {
    const log = parseHarText(readFixture('har/crafted/session.har'));
    expect(log.version).toBe('1.2');
    expect(log.entries).toHaveLength(9);
    expect(log.skippedMalformed).toBe(0);
    expect(log.entries[6]?.resourceType).toBe('script');
    expect(log.entries[0]?.request.queryString).toEqual([{ name: 'limit', value: '10' }]);
    expect(log.entries[3]?.request.postData?.text).toBe('{"name":"Rex"}');
    expect(log.entries[8]?.response.content).toEqual({
      mimeType: 'text/plain',
      text: 'aGVsbG8=',
      encoding: 'base64',
    });
  });

  it('refuses JSON without log.entries', () => {
    expect(() => parseHarText('{"log":{}}')).toThrow(HarError);
    expect(() => parseHarText('{"log":{}}')).toThrow(expect.objectContaining({ code: 'har-not-har' }));
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseHarText('nope')).toThrow(expect.objectContaining({ code: 'har-malformed' }));
  });

  it('strips a byte order mark and fills in missing parts', () => {
    const text =
      '﻿{"log":{"version":"1.1","entries":[{"request":{"method":"GET","url":"http://a/"},"response":{"status":200}}]}}';
    const log = parseHarText(text);
    expect(log.entries[0]?.request.headers).toEqual([]);
    expect(log.entries[0]?.response.content).toEqual({ mimeType: '' });
  });

  it('drops an entry without a method or url and counts it', () => {
    const text =
      '{"log":{"version":"1.2","entries":[{"request":{"url":"http://a/"}},{"request":{"method":"GET"}},null]}}';
    const log = parseHarText(text);
    expect(log.entries).toHaveLength(0);
    expect(log.skippedMalformed).toBe(3);
  });
});

describe('isHar', () => {
  it('needs a log with a version and entries', () => {
    expect(isHar({ log: { version: '1.2', entries: [] } })).toBe(true);
    expect(isHar({ log: { entries: [] } })).toBe(false);
    expect(isHar({ log: { version: '1.2' } })).toBe(false);
    expect(isHar(null)).toBe(false);
  });
});
