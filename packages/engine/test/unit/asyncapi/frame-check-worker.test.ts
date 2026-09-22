import { describe, expect, it } from 'vitest';
import { channelMessages } from '../../../src/asyncapi/frame-check.js';
import { createWorkerFrameChecker } from '../../../src/asyncapi/frame-check-worker-host.js';
import { parseAsyncApi } from '../../../src/asyncapi/parse.js';
import type { WsFrame } from '../../../src/ws/model.js';
import { fileFetch } from '../../helpers/file-fetch.js';

const fixture = (name: string) => new URL(`../../fixtures/asyncapi/${name}`, import.meta.url);
const doc = (await parseAsyncApi({ kind: 'file', path: fixture('chat-2.6.yaml').href }, { fetchDocument: fileFetch }))
  .document;
const messages = channelMessages(doc, '/chat/{roomId}');
const hanging = fixture('hanging-frame-worker.mjs');

const frame = (direction: 'sent' | 'received', text: string, index = 0): WsFrame => ({
  index,
  direction,
  opcode: 'text',
  at: 0,
  size: text.length,
  text,
});

describe('createWorkerFrameChecker', () => {
  it('checks a frame off the main thread against its direction’s messages', async () => {
    const checker = createWorkerFrameChecker(messages);
    try {
      expect(await checker.check(frame('sent', JSON.stringify({ type: 'message', text: 'hi' })))).toEqual({
        status: 'ok',
        message: 'sendMessage',
      });
      expect((await checker.check(frame('sent', '{"type":1}')))?.status).toBe('violation');
      expect(checker.spawned).toBe(1);
    } finally {
      await checker.dispose();
    }
  });

  it('answers a frame no contract speaks to without starting a worker', async () => {
    const checker = createWorkerFrameChecker(messages);
    const binary: WsFrame = { index: 0, direction: 'received', opcode: 'binary', at: 0, size: 1, base64: 'AA==' };
    expect(await checker.check(binary)).toBeUndefined();
    expect(checker.spawned).toBe(0);
    await checker.dispose();
  });

  it('marks a check that outruns the deadline not-checked, and a fresh worker takes the next frame', async () => {
    const checker = createWorkerFrameChecker(messages, { workerUrl: hanging, deadlineMs: 150 });
    try {
      const started = Date.now();
      const stuck = await checker.check(frame('received', 'hang', 0));
      expect(stuck).toMatchObject({ status: 'not-checked' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await checker.check(frame('received', '{}', 1))).toEqual({ status: 'ok', message: 'stub' });
      expect(checker.spawned).toBe(2);
    } finally {
      await checker.dispose();
    }
  });

  it('frames queued behind a stuck one are still checked, each against its own deadline', async () => {
    const checker = createWorkerFrameChecker(messages, { workerUrl: hanging, deadlineMs: 150 });
    try {
      const results = await Promise.all([
        checker.check(frame('received', 'hang', 0)),
        checker.check(frame('received', '{}', 1)),
        checker.check(frame('received', '{}', 2)),
      ]);
      expect(results.map((r) => r?.status)).toEqual(['not-checked', 'ok', 'ok']);
    } finally {
      await checker.dispose();
    }
  });

  it('dispose stops the worker, answers what was still waiting, and refuses later frames', async () => {
    const checker = createWorkerFrameChecker(messages, { workerUrl: hanging, deadlineMs: 10_000 });
    const pending = checker.check(frame('received', 'hang', 0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(checker.running).toBe(true);
    await checker.dispose();
    expect(checker.running).toBe(false);
    expect(await pending).toMatchObject({ status: 'not-checked' });
    expect(await checker.check(frame('received', '{}', 1))).toBeUndefined();
  });

  it('a full queue answers not-checked instead of growing without bound', async () => {
    const checker = createWorkerFrameChecker(messages, { workerUrl: hanging, deadlineMs: 10_000, maxQueued: 1 });
    const first = checker.check(frame('received', 'hang', 0));
    const second = checker.check(frame('received', '{}', 1));
    expect(await checker.check(frame('received', '{}', 2))).toMatchObject({ status: 'not-checked' });
    await checker.dispose();
    await Promise.all([first, second]);
  });
});
