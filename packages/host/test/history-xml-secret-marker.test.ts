// @vitest-environment node
/**
 * A secret value main recorded, found inside an XML body, is masked with the escaped marker that
 * `redactor.redactXml` writes, so XML in History shows one marker and stays well formed; any other body keeps
 * the raw marker.
 */
import { describe, expect, it } from 'vitest';
import { buildRestHistoryEntry } from '../src/history-service.js';
import { Redactor } from '../src/host/redactor.js';

const redactor = new Redactor();

const SECRET = 'tok-s3cret-value';
redactor.recordSecretValue(SECRET);

function entryFor(contentType: string, body: string) {
  return buildRestHistoryEntry(redactor, 'p1', {
    requestId: 'r1',
    requestName: 'Send',
    apiName: 'Api',
    folderPath: '',
    method: 'POST',
    url: 'https://api.test/x',
    requestHeaders: { 'Content-Type': contentType },
    requestBody: body,
    durationMs: 1,
  });
}

describe('a recorded secret value in an XML body', () => {
  it('is written as the escaped marker in a REST History entry with an XML body', () => {
    const entry = entryFor('application/xml', `<Order><Note>${SECRET}</Note></Order>`);
    expect(entry.request.envelopeXml).toBe('<Order><Note>&lt;redacted&gt;</Note></Order>');
  });

  it('keeps the raw marker in a body that is not XML', () => {
    const entry = entryFor('application/json', `{"note":"${SECRET}"}`);
    expect(entry.request.envelopeXml).toBe('{"note":"<redacted>"}');
  });

  it('is escaped by redactor.redactXml too, beside a masked password', () => {
    expect(redactor.redactXml(`<a><Password>pw</Password><Note>${SECRET}</Note></a>`, { show: false })).toBe(
      '<a><Password>&lt;redacted&gt;</Password><Note>&lt;redacted&gt;</Note></a>',
    );
    expect(redactor.redactSecretValues(`x ${SECRET}`)).toBe('x <redacted>');
  });
});
