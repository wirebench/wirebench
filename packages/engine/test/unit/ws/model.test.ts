import { describe, expect, it } from 'vitest';
import {
  createWsApi,
  createWsRequest,
  createWsSavedMessage,
  wsApiRequests,
  wsMessageFileName,
} from '../../../src/ws/model.js';

describe('ws model', () => {
  it('creates a request with inherited auth and nothing saved', () => {
    expect(createWsRequest('Feed', { id: 'r1' })).toMatchObject({
      kind: 'websocket',
      slug: 'Feed',
      url: '',
      auth: { type: 'inherit' },
      messages: [],
      subprotocols: [],
    });
  });
  it('walks folders depth-first', () => {
    const inner = createWsRequest('Inner', { id: 'r2' });
    const api = createWsApi('Live', {
      id: 'a1',
      folders: [{ id: 'f1', name: 'F', slug: 'f', order: 0, folders: [], requests: [inner] }],
    });
    expect(wsApiRequests(api).map((r) => r.id)).toEqual(['r2']);
  });
  it('names a message file by what it holds', () => {
    const name = (n: string, input: Parameters<typeof createWsSavedMessage>[1]) =>
      wsMessageFileName('Feed', createWsSavedMessage(n, input));
    expect(name('Subscribe', { content: '{"op":"sub"}' })).toBe('Feed.msg-Subscribe.json');
    expect(name('Hello', { content: '<hi/>' })).toBe('Feed.msg-Hello.xml');
    expect(name('Plain', { content: 'hi' })).toBe('Feed.msg-Plain.txt');
    expect(name('Blob', { format: 'binary', content: 'AAEC' })).toBe('Feed.msg-Blob.b64');
  });
});
