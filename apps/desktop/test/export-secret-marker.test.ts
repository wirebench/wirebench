// @vitest-environment node
/**
 * HAR export and a cURL copy mask every body with both passes. A recorded secret value takes the
 * escaped marker only in an XML body, so XML stays well formed, and the raw one in any other.
 */
import { describe, expect, it } from 'vitest';
import { harOf } from '../src/main/har.js';
import { curlForLogEntry } from '../src/main/log-curl.js';
import { recordSecretValue } from '../src/main/redact.js';
import { b64, makeRestExchange } from './mocks/wire-fixtures.js';

const SECRET = 'tok-export-s3cret';
recordSecretValue(SECRET);

const CREATOR = { name: 'Wirebench', version: '0.0.0-test' } as const;

function entryWith(contentType: string, body: string) {
  const exchange = makeRestExchange({ text: body });
  return {
    kind: 'exchange' as const,
    exchange: {
      ...exchange,
      http: {
        ...exchange.http,
        headers: { 'content-type': contentType },
        rawHeaders: [['content-type', contentType]] as [string, string][],
        bodyBase64: b64(body),
        rawRequestBase64: b64(`POST /pet HTTP/1.1\r\nHost: api.test\r\nContent-Type: ${contentType}\r\n\r\n${body}`),
        request: { url: 'https://api.test/pet', method: 'POST', headers: { 'Content-Type': contentType } },
      },
    },
  };
}

describe('a recorded secret value in an exported body', () => {
  it('keeps the raw marker in a JSON body, in HAR and in cURL', () => {
    const entry = entryWith('application/json', `{"note":"${SECRET}"}`);
    const har = harOf([entry], CREATOR).log.entries[0]!;
    expect(har.request.postData?.text).toBe('{"note":"<redacted>"}');
    expect(har.response.content.text).toBe('{"note":"<redacted>"}');
    const { command } = curlForLogEntry(entry, { shell: 'posix', show: false });
    expect(command).toContain('{"note":"<redacted>"}');
    expect(command).not.toContain('&lt;redacted&gt;');
  });

  it('gets the escaped marker in an XML body, in HAR and in cURL', () => {
    const entry = entryWith('application/xml', `<pet><note>${SECRET}</note></pet>`);
    const har = harOf([entry], CREATOR).log.entries[0]!;
    expect(har.request.postData?.text).toBe('<pet><note>&lt;redacted&gt;</note></pet>');
    expect(har.response.content.text).toBe('<pet><note>&lt;redacted&gt;</note></pet>');
    const { command } = curlForLogEntry(entry, { shell: 'posix', show: false });
    expect(command).toContain('<pet><note>&lt;redacted&gt;</note></pet>');
  });
});
