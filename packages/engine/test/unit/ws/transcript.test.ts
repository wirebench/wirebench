import { describe, expect, it } from 'vitest';
import type { WsFrame } from '../../../src/ws/model.js';
import { capFrames } from '../../../src/ws/transcript.js';

const text = (index: number, size = 10): WsFrame => ({
  index,
  direction: 'received',
  opcode: 'text',
  at: index,
  size,
  text: 'x'.repeat(size),
});
const closeRow = (index: number): WsFrame => ({
  index,
  direction: 'received',
  opcode: 'close',
  at: index,
  size: 0,
  close: { code: 1000, reason: '' },
});

describe('capFrames', () => {
  it('keeps a short session whole', () => {
    const frames = [text(0), text(1)];
    expect(capFrames(frames)).toEqual({ frames, truncated: false, omittedFrames: 0 });
  });
  it('keeps the first 400 and the last 100, and says how many went', () => {
    const result = capFrames(Array.from({ length: 1000 }, (_, i) => text(i)));
    expect(result.frames).toHaveLength(500);
    expect(result.frames[399]?.index).toBe(399);
    expect(result.frames[400]?.index).toBe(900);
    expect(result).toMatchObject({ truncated: true, omittedFrames: 500 });
  });
  it('keeps the close frame, which is among the last 100', () => {
    const result = capFrames([...Array.from({ length: 1000 }, (_, i) => text(i)), closeRow(1000)]);
    expect(result.frames.at(-1)?.opcode).toBe('close');
    expect(result.frames).toHaveLength(500);
  });
  it('past 1 MB a frame keeps its row and loses its payload', () => {
    const result = capFrames([text(0, 700_000), text(1, 700_000), text(2, 5)]);
    expect(result.frames[0]?.text).toHaveLength(700_000);
    expect(result.frames[1]).toMatchObject({ size: 700_000, payloadTruncated: true });
    expect(result.frames[1]?.text).toBeUndefined();
    expect(result.frames[2]?.text).toBe('xxxxx'); // a small one after it still fits
    expect(result.truncated).toBe(true);
  });
});

describe('capFrames and contract results', () => {
  it('keeps the status and message, drops the problems', () => {
    const frame: WsFrame = {
      ...text(0),
      contract: { status: 'violation', message: 'chat', problems: [{ path: '/a', keyword: 'type', message: 'x' }] },
    };
    expect(capFrames([frame]).frames[0]?.contract).toEqual({ status: 'violation', message: 'chat' });
    const big: WsFrame = { ...text(1, 2_000_000), contract: { status: 'ok', message: 'chat' } };
    const r = capFrames([big]);
    expect(r.frames[0]?.payloadTruncated).toBe(true);
    expect(r.frames[0]?.contract).toEqual({ status: 'ok', message: 'chat' });
  });
});
