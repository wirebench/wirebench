// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { containsRedaction, redactHeaders, REDACTED_MARKER, redactRawHttp, redactXml } from '../src/main/redact.js';

describe('containsRedaction', () => {
  it('is true when the text contains the redaction marker', () => {
    expect(containsRedaction(`<Password>${REDACTED_MARKER}</Password>`)).toBe(true);
  });

  it('is false for text with no redaction marker', () => {
    expect(containsRedaction('<Password>hunter2</Password>')).toBe(false);
  });
});

describe('redactHeaders', () => {
  it('masks sensitive headers case-insensitively, leaving others alone', () => {
    const result = redactHeaders({
      Authorization: 'Basic YWxpY2U6czNjcmV0IQ==',
      'PROXY-AUTHORIZATION': 'Basic xyz',
      Cookie: 'a=b',
      'Set-Cookie': 'a=b; HttpOnly',
      'X-Api-Key': 'k123',
      'Content-Type': 'text/xml',
    });
    expect(result['Authorization']).toBe('<redacted>');
    expect(result['PROXY-AUTHORIZATION']).toBe('<redacted>');
    expect(result['Cookie']).toBe('<redacted>');
    expect(result['Set-Cookie']).toBe('<redacted>');
    expect(result['X-Api-Key']).toBe('<redacted>');
    expect(result['Content-Type']).toBe('text/xml');
  });

  it('bypasses redaction when show is true', () => {
    const result = redactHeaders({ Authorization: 'Basic xyz' }, { show: true });
    expect(result['Authorization']).toBe('Basic xyz');
  });
});

describe('redactXml', () => {
  it('masks wsse:Password text content regardless of namespace prefix', () => {
    const xml = '<wsse:Password Type="...PasswordText">s3cret!</wsse:Password>';
    expect(redactXml(xml)).toBe('<wsse:Password Type="...PasswordText"><redacted></wsse:Password>');
  });

  it('handles an unprefixed Password element', () => {
    expect(redactXml('<Password>hunter2</Password>')).toBe('<Password><redacted></Password>');
  });

  it('bypasses redaction when show is true', () => {
    const xml = '<wsse:Password>s3cret!</wsse:Password>';
    expect(redactXml(xml, { show: true })).toBe(xml);
  });

  it('does not mask a PasswordDigest — it is not a secret', () => {
    const xml =
      '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">abc123==</wsse:Password>';
    expect(redactXml(xml)).toBe(xml);
  });

  it('masks a PasswordText value', () => {
    const xml =
      '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">s3cret!</wsse:Password>';
    expect(redactXml(xml)).toBe(
      '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText"><redacted></wsse:Password>',
    );
  });
});

describe('redactRawHttp', () => {
  it('redacts the Authorization header line in a raw HTTP request', () => {
    const raw = 'POST /svc HTTP/1.1\r\nAuthorization: Basic YWxpY2U6czNjcmV0IQ==\r\nHost: x\r\n\r\n<a/>';
    const result = redactRawHttp(raw);
    expect(result).toContain('Authorization: <redacted>');
    expect(result).not.toContain('YWxpY2U6czNjcmV0IQ==');
    expect(result).toContain('Host: x');
  });

  it('redacts wsse:Password in a SOAP body', () => {
    const raw =
      'POST /svc HTTP/1.1\r\nHost: x\r\nContent-Type: text/xml; charset=utf-8\r\n\r\n<wsse:Password>s3cret!</wsse:Password>';
    const result = redactRawHttp(raw);
    expect(result).not.toContain('s3cret!');
    expect(result).toContain('<redacted>');
  });

  it('preserves CRLF line terminators exactly', () => {
    const raw = 'POST /svc HTTP/1.1\r\nAuthorization: Basic xyz\r\nHost: x\r\n\r\nbody';
    const result = redactRawHttp(raw);
    expect(result).toBe('POST /svc HTTP/1.1\r\nAuthorization: <redacted>\r\nHost: x\r\n\r\nbody');
  });

  it('passes a gzip-encoded body through byte-identically', () => {
    const body = gzipSync(Buffer.from('<wsse:Password>s3cret!</wsse:Password>', 'utf8'));
    const head = Buffer.from(
      'HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\nContent-Encoding: gzip\r\nSet-Cookie: sid=abc\r\n\r\n',
      'latin1',
    );
    const raw = Buffer.concat([head, body]);
    const out = Buffer.from(redactRawHttp(raw.toString('base64'), { encoding: 'base64' }), 'base64');
    const sep = out.indexOf('\r\n\r\n');
    expect(out.subarray(sep + 4).equals(body)).toBe(true);
    expect(out.subarray(0, sep).toString('latin1')).toContain('Set-Cookie: <redacted>');
  });

  it('leaves a binary body untouched when the content type is not textual', () => {
    const body = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
    const head = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n', 'latin1');
    const raw = Buffer.concat([head, body]);
    const out = Buffer.from(redactRawHttp(raw.toString('base64'), { encoding: 'base64' }), 'base64');
    expect(out.subarray(out.indexOf('\r\n\r\n') + 4).equals(body)).toBe(true);
  });

  it('round-trips base64-encoded raw HTTP', () => {
    const raw = 'POST /svc HTTP/1.1\r\nAuthorization: Basic xyz\r\nHost: x\r\n\r\nbody';
    const b64 = Buffer.from(raw, 'utf8').toString('base64');
    const redactedB64 = redactRawHttp(b64, { encoding: 'base64' });
    const decoded = Buffer.from(redactedB64, 'base64').toString('utf8');
    expect(decoded).toContain('Authorization: <redacted>');
    expect(decoded).not.toContain('xyz');
  });

  it('bypasses redaction entirely when show is true', () => {
    const raw = 'POST /svc HTTP/1.1\r\nAuthorization: Basic xyz\r\nHost: x\r\n\r\nbody';
    expect(redactRawHttp(raw, { show: true })).toBe(raw);
  });
});

describe('redactXml over hostile input', () => {
  it('is linear when a response is full of open tags that never close', () => {
    // The regex this replaced re-scanned to the end of the text for every unclosed <Password>,
    // and this text is a *response* — whatever the server chose to send.
    const time = (n: number): number => {
      const input = '<Password>'.repeat(n);
      const started = performance.now();
      expect(redactXml(input)).toBe(input);
      return performance.now() - started;
    };
    time(10_000);
    expect(time(100_000)).toBeLessThan(400);
  });

  it('pairs each open tag with the first close tag after it, as the lazy match did', () => {
    expect(redactXml('<a><Password>x</Password><wsse:Password>y</wsse:Password></a>')).toBe(
      '<a><Password><redacted></Password><wsse:Password><redacted></wsse:Password></a>',
    );
    // A nested opener is swallowed into the first element's content, exactly as before.
    expect(redactXml('<Password><Password>x</Password></Password>')).toBe('<Password><redacted></Password></Password>');
  });

  it('leaves an unterminated element alone, and matches case-insensitively', () => {
    expect(redactXml('<Password>never closed')).toBe('<Password>never closed');
    expect(redactXml('<PASSWORD>x</PASSWORD>')).toBe('<PASSWORD><redacted></PASSWORD>');
    expect(redactXml('<Passwords>x</Passwords>')).toBe('<Passwords>x</Passwords>');
  });
});
