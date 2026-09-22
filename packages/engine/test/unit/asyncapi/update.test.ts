import { describe, expect, it } from 'vitest';
import { mapAsyncApi } from '../../../src/asyncapi/map.js';
import { parseAsyncApi } from '../../../src/asyncapi/parse.js';
import { applyAsyncApiUpdate, planAsyncApiUpdate } from '../../../src/asyncapi/update.js';
import { wsApiRequests, type WsApi, type WsRequestDef } from '../../../src/ws/model.js';
import { fileFetch } from '../../helpers/file-fetch.js';

const fixture = (name: string) => new URL(`../../fixtures/asyncapi/${name}`, import.meta.url);
const parse = (name: string) => parseAsyncApi({ kind: 'file', path: fixture(name).href }, { fetchDocument: fileFetch });
const seqIds = (prefix = 'id') => {
  let n = 0;
  return () => `${prefix}-${String((n += 1)).padStart(4, '0')}`;
};
const countRequests = (api: WsApi) => wsApiRequests(api).length;
const findByChannel = (api: WsApi, channel: string) => wsApiRequests(api).find((r) => r.contract?.channel === channel);

function editRequest(api: WsApi, channel: string, edit: (r: WsRequestDef) => WsRequestDef): WsApi {
  const fix = (r: WsRequestDef) => (r.contract?.channel === channel ? edit(r) : r);
  return {
    ...api,
    requests: api.requests.map(fix),
    folders: api.folders.map((f) => ({ ...f, requests: f.requests.map(fix) })),
  };
}
const withMessageEdited = (api: WsApi, message: string, content: string) =>
  editRequest(api, 'userChat', (r) => ({
    ...r,
    messages: r.messages.map((m) => (m.contract?.message === message ? { ...m, content } : m)),
  }));

const old = (await parse('chat-3.0.yaml')).document;
const next = (await parse('chat-3.0-next.yaml')).document;

describe('planAsyncApiUpdate', () => {
  it('reports per operation', () => {
    const plan = planAsyncApiUpdate(old, next);
    expect(plan.added.map((o) => o.key)).toEqual(['onTyping']);
    expect(plan.removed.map((o) => o.key)).toEqual(['onChat']);
    expect(plan.changed.map((c) => [c.op.key, c.reasons])).toEqual([['sendChat', ['payload']]]);
  });

  it('the same document plans nothing', () => {
    expect(planAsyncApiUpdate(old, old)).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('applyAsyncApiUpdate', () => {
  it('never deletes; orphans the gone channel; replaces only untouched samples', () => {
    const { api } = mapAsyncApi(old, { newId: seqIds() });
    const edited = withMessageEdited(api, 'sendChat', '{"type":"chat","text":"mine"}');
    const forward = applyAsyncApiUpdate(edited, old, next, { newId: seqIds('n') });
    expect(forward.requestsAdded).toHaveLength(1);
    expect(findByChannel(forward.api, 'typing')!.messages.map((m) => m.name)).toEqual(['typing']);
    const chat = findByChannel(forward.api, 'userChat')!;
    expect(chat.messages.map((m) => m.name)).toEqual(['sendChat', 'sendChat (updated)']);
    expect(chat.messages[0]!.content).toBe('{"type":"chat","text":"mine"}');
    expect(JSON.parse(chat.messages[1]!.content)).toEqual({ type: 'message', text: 'Hello', room: 'lobby' });

    const back = applyAsyncApiUpdate(forward.api, next, old, { newId: seqIds('b') });
    expect(countRequests(back.api)).toBeGreaterThanOrEqual(countRequests(forward.api));
    expect(back.requestsOrphaned).toHaveLength(1);
    expect(findByChannel(back.api, 'typing')!.orphaned).toBe(true);
  });

  it('an untouched sample is replaced in place', () => {
    const { api } = mapAsyncApi(old, { newId: seqIds() });
    const result = applyAsyncApiUpdate(api, old, next, { newId: seqIds('n') });
    const chat = findByChannel(result.api, 'userChat')!;
    expect(chat.messages.map((m) => m.name)).toEqual(['sendChat']);
    expect(chat.messages[0]!.contract!.generated).toBe(chat.messages[0]!.content);
    expect(JSON.parse(chat.messages[0]!.content)).toMatchObject({ room: 'lobby' });
    expect(result.messagesReplaced).toEqual([chat.messages[0]!.id]);
  });

  it('a user-edited URL is kept; an untouched one follows the contract', () => {
    const moved = {
      ...next,
      channels: next.channels.map((c) => (c.key === 'userChat' ? { ...c, address: '/rooms/{roomId}' } : c)),
    };
    const sendChat = planAsyncApiUpdate(old, moved).changed.find((c) => c.op.key === 'sendChat')!;
    expect(sendChat.reasons).toEqual(['address', 'payload']);
    const { api } = mapAsyncApi(old, { newId: seqIds() });
    const untouched = applyAsyncApiUpdate(api, old, moved, { newId: seqIds('n') });
    expect(findByChannel(untouched.api, 'userChat')!.url).toBe('/rooms/lobby');
    expect(untouched.requestsRewritten).toHaveLength(1);
    const edited = editRequest(api, 'userChat', (r) => ({ ...r, url: '/mine' }));
    const kept = applyAsyncApiUpdate(edited, old, moved, { newId: seqIds('n') });
    expect(findByChannel(kept.api, 'userChat')!.url).toBe('/mine');
    expect(kept.requestsRewritten).toHaveLength(0);
  });

  it('a channel that came back clears orphaned', () => {
    const { api } = mapAsyncApi(old, { newId: seqIds() });
    const forward = applyAsyncApiUpdate(api, old, next, { newId: seqIds('n') });
    const back = applyAsyncApiUpdate(forward.api, next, old, { newId: seqIds('b') });
    const again = applyAsyncApiUpdate(back.api, old, next, { newId: seqIds('c') });
    const typing = findByChannel(again.api, 'typing')!;
    expect(typing.orphaned).toBeUndefined();
    expect(again.requestsRestored).toEqual([typing.id]);
    expect(again.requestsAdded).toHaveLength(0);
    expect(countRequests(again.api)).toBe(countRequests(back.api));
  });
});
