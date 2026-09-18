// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { redactStructuredBody, SECRET_BODY_KEYS } from '../src/main/redact.js';

describe('redactStructuredBody', () => {
  it('lists the spec keys', () => {
    expect(SECRET_BODY_KEYS).toEqual([
      'password',
      'passwd',
      'secret',
      'token',
      'access_token',
      'refresh_token',
      'id_token',
      'client_secret',
      'api_key',
      'apikey',
      'authorization',
    ]);
  });

  it('masks secret keys at any depth, case-insensitively, inside arrays too', () => {
    const body = JSON.stringify({
      user: 'ann',
      Password: 's3cr3t-placeholder',
      nested: { deeper: { ACCESS_TOKEN: 'plain-token', keep: 1 } },
      list: [{ client_secret: 'cs-placeholder' }, { name: 'x' }],
      token: { kind: 'object', value: 'plain-token' },
    });
    const out = redactStructuredBody(body, 'application/json; charset=utf-8');
    expect(out).not.toContain('s3cr3t-placeholder');
    expect(out).not.toContain('plain-token');
    expect(out).not.toContain('cs-placeholder');
    expect(JSON.parse(out)).toMatchObject({ user: 'ann', nested: { deeper: { keep: 1 } }, list: [{}, { name: 'x' }] });
    expect((JSON.parse(out) as { token: unknown }).token).toBe('<redacted>');
  });

  it('keeps the indentation style of the input', () => {
    const pretty = JSON.stringify({ password: 'p', a: 1 }, null, 2);
    expect(redactStructuredBody(pretty, 'application/vnd.api+json')).toBe(
      JSON.stringify({ password: '<redacted>', a: 1 }, null, 2),
    );
    expect(redactStructuredBody('{"password":"p"}', 'application/json')).toBe('{"password":"<redacted>"}');
  });

  it('masks form fields by key and keeps the others byte-for-byte', () => {
    expect(
      redactStructuredBody(
        'grant_type=password&username=ann&password=s3cr3t-placeholder&Client_Secret=cs',
        'application/x-www-form-urlencoded',
      ),
    ).toBe('grant_type=password&username=ann&password=%3Credacted%3E&Client_Secret=%3Credacted%3E');
  });

  it('leaves bad JSON, other content types and show:true alone', () => {
    expect(redactStructuredBody('{"password": ', 'application/json')).toBe('{"password": ');
    expect(redactStructuredBody('password=x', 'text/plain')).toBe('password=x');
    expect(redactStructuredBody('{"password":"p"}', 'application/json', { show: true })).toBe('{"password":"p"}');
  });

  it('is idempotent on already-masked text', () => {
    const once = redactStructuredBody('{"token":"t"}', 'application/json');
    expect(redactStructuredBody(once, 'application/json')).toBe(once);
  });
});
