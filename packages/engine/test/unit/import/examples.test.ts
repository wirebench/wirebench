import { describe, expect, it } from 'vitest';
import { maskRecordedResponse } from '../../../src/import/examples.js';
import { REDACTED_MARKER } from '../../../src/redact/index.js';

const XML_MARKER = '&lt;redacted&gt;';

describe('maskRecordedResponse', () => {
  it('drops the cookie headers and masks credential-looking ones', () => {
    const out = maskRecordedResponse(
      [
        { name: 'Set-Cookie', value: 'sid=1' },
        { name: 'X-Auth-Token', value: 't' },
        { name: 'Content-Type', value: 'text/plain' },
      ],
      undefined,
      undefined,
    );
    expect(out).toEqual({
      headers: [
        { name: 'X-Auth-Token', value: REDACTED_MARKER, enabled: true },
        { name: 'Content-Type', value: 'text/plain', enabled: true },
      ],
      masked: true,
    });
  });

  it('masks the values under credential keys of a JSON body', () => {
    const out = maskRecordedResponse([], '{"token":"abc","id":1}', 'application/json');
    expect(JSON.parse(out.body ?? '')).toEqual({ token: REDACTED_MARKER, id: 1 });
    expect(out.masked).toBe(true);
  });

  it('keeps a JSON body without credentials exactly as recorded', () => {
    const body = '{ "id": 1 }';
    expect(maskRecordedResponse([], body, 'application/json')).toEqual({ headers: [], body, masked: false });
  });

  it('masks credential elements and attributes of an XML body by its content type', () => {
    const out = maskRecordedResponse(
      [],
      '<r session="s1"><token>leak</token><id>1</id></r>',
      'application/soap+xml; charset=utf-8',
    );
    expect(out.body).toBe(`<r session="${XML_MARKER}"><token>${XML_MARKER}</token><id>1</id></r>`);
    expect(out.masked).toBe(true);
  });

  it('reads a body without a content type as XML when it opens with <', () => {
    const out = maskRecordedResponse([], '\n<r><secret>s</secret></r>', undefined);
    expect(out.body).toBe(`\n<r><secret>${XML_MARKER}</secret></r>`);
    expect(out.masked).toBe(true);
  });

  it('keeps an XML body whose credential values are references, or that has none', () => {
    for (const body of ['<r><token>${t}</token></r>', '<r><id>1</id></r>']) {
      expect(maskRecordedResponse([], body, 'text/xml')).toEqual({ headers: [], body, masked: false });
    }
  });
});
