import { describe, expect, it } from 'vitest';
import { WsError } from '../../../src/errors.js';
import { resolveWsUrl } from '../../../src/ws/url.js';

const row = (name: string, value: string, enabled = true) => ({ name, value, enabled });

describe('resolveWsUrl', () => {
  it('joins a path to the server URL', () => {
    expect(resolveWsUrl('wss://api.example.test/v1', '/feed', [])).toBe('wss://api.example.test/v1/feed');
    expect(resolveWsUrl('wss://api.example.test/v1/', 'feed', [])).toBe('wss://api.example.test/v1/feed');
  });
  it('lets an absolute request URL win', () => {
    expect(resolveWsUrl('wss://a.test', 'ws://b.test/x', [])).toBe('ws://b.test/x');
  });
  it('maps http(s) to ws(s)', () => {
    expect(resolveWsUrl('https://a.test', '/x', [])).toBe('wss://a.test/x');
    expect(resolveWsUrl('http://a.test', '', [])).toBe('ws://a.test/');
  });
  it('appends enabled query rows to any query already in the URL', () => {
    expect(resolveWsUrl('ws://a.test', '/x?a=1', [row('b', 'two words'), row('c', '3', false)])).toBe(
      'ws://a.test/x?a=1&b=two+words',
    );
  });
  it('refuses another scheme, and an empty URL, by name', () => {
    expect(() => resolveWsUrl('ftp://a.test', '/x', [])).toThrowError(WsError);
    expect(() => resolveWsUrl('', '', [])).toThrowError(expect.objectContaining({ code: 'ws-bad-url' }));
  });
});
