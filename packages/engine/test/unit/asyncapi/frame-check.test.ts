import { describe, expect, it } from 'vitest';
import { createFrameChecker, checkFrame, MAX_CHECKED_FRAME_BYTES } from '../../../src/asyncapi/frame-check.js';
import { parseAsyncApi } from '../../../src/asyncapi/parse.js';
import type { WsFrame } from '../../../src/ws/model.js';
import { fileFetch } from '../../helpers/file-fetch.js';

const fixture = (name: string) => new URL(`../../fixtures/asyncapi/${name}`, import.meta.url);
const parse = (name: string) => parseAsyncApi({ kind: 'file', path: fixture(name).href }, { fetchDocument: fileFetch });
const doc = (await parse('chat-2.6.yaml')).document;
const check = createFrameChecker(doc, '/chat/{roomId}');
const text = (direction: 'sent' | 'received', value: unknown): WsFrame => ({
  index: 0,
  direction,
  opcode: 'text',
  at: 0,
  size: 10,
  text: JSON.stringify(value),
});

describe('createFrameChecker', () => {
  it('matches the first clean message of several', () => {
    expect(check(text('received', { type: 'presence', user: 'a', online: true }))).toEqual({
      status: 'ok',
      message: 'presence',
    });
  });
  it('reports the closest message when none is clean', () => {
    const r = check(text('received', { type: 'message', from: 'a', text: 5 }))!;
    expect(r.status).toBe('violation');
    expect(r.message).toBe('chatMessage');
    expect(r.problems?.[0]).toMatchObject({ path: '/text', keyword: 'type' });
  });
  it('sent frames are checked against outgoing messages only', () => {
    expect(check(text('sent', { type: 'message', text: 'hi' }))?.status).toBe('ok');
    // A chatMessage shape is incoming only: sent, it is judged against sendMessage alone.
    expect(check(text('sent', { type: 'presence', user: 'a', online: true }))).toMatchObject({
      status: 'violation',
      message: 'sendMessage',
    });
  });
  it('non-JSON text against a JSON message is a violation', () => {
    expect(check({ ...text('sent', 0), text: 'not json' })).toMatchObject({ status: 'violation', reason: 'not JSON' });
  });
  it('skips binary, control and oversized frames', () => {
    expect(
      check({ index: 0, direction: 'received', opcode: 'binary', at: 0, size: 3, base64: 'AAAA' }),
    ).toBeUndefined();
    expect(check({ index: 0, direction: 'received', opcode: 'ping', at: 0, size: 0 })).toBeUndefined();
    expect(check({ ...text('received', {}), size: MAX_CHECKED_FRAME_BYTES + 1 })).toMatchObject({ status: 'skipped' });
    expect(check({ ...text('received', {}), size: 300_000 })).toMatchObject({ status: 'skipped' });
  });
  it('a direction with no messages is unmatched', () => {
    expect(createFrameChecker(doc, 'audit')(text('sent', {}))).toMatchObject({ status: 'unmatched' });
    expect(createFrameChecker(doc, 'no-such-channel')(text('sent', {}))).toMatchObject({ status: 'unmatched' });
  });
  it('a non-JSON message is not asserted', () => {
    expect(createFrameChecker(doc, 'audit')(text('received', {}))).toMatchObject({ status: 'skipped' });
  });
  it('a check past its time budget is "not checked", never a pass or a failure', () => {
    let t = 0;
    const now = () => (t += 10); // every clock read costs 10 ms
    const r = createFrameChecker(doc, '/chat/{roomId}', { budgetMs: 5, now })(
      text('received', { type: 'presence', user: 'a', online: true }),
    );
    expect(r).toMatchObject({ status: 'not-checked', reason: 'time budget exceeded' });
    expect(r?.problems).toBeUndefined();
  });
  it('checkFrame takes plain data in and gives plain data out (worker-ready)', () => {
    const messages = doc.operations
      .filter((o) => o.channel === '/chat/{roomId}' && o.direction === 'received')
      .flatMap((o) => o.messages);
    const r = checkFrame(
      structuredClone(text('received', { type: 'presence', user: 'a', online: true })),
      structuredClone(messages),
    );
    expect(structuredClone(r)).toEqual({ status: 'ok', message: 'presence' });
  });
  it('a message whose check only hit the node cap is not the closest violation: not-checked', () => {
    const many = Array.from({ length: 12_000 }, () => 1);
    const frame: WsFrame = { ...text('received', many), size: JSON.stringify(many).length };
    const capped = {
      key: 'ints',
      name: 'ints',
      contentType: 'application/json',
      payload: { type: 'array', items: { type: 'integer' } },
    };
    const wrong = { key: 'obj', name: 'obj', contentType: 'application/json', payload: { type: 'object' } };
    expect(checkFrame(frame, [capped, wrong], { budgetMs: 60_000 })).toEqual({
      status: 'not-checked',
      reason: 'validation stopped after 10000 nodes',
    });
    expect(checkFrame(frame, [wrong], { budgetMs: 60_000 })).toMatchObject({ status: 'violation', message: 'obj' });
  });
});
