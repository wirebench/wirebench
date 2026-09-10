// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { redactHeaders, redactRawHttp, redactXml } from '../src/main/redact.js';

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
