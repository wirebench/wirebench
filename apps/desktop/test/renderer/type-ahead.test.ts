import { expect, it } from 'vitest';
import { TYPE_AHEAD_LIMIT, TypeAhead } from '../../src/renderer/features/ssh/type-ahead.js';
import { typedAheadText } from '../../src/renderer/features/ssh/connect-screen.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined): string | undefined =>
  data === undefined ? undefined : new TextDecoder().decode(data);

it('keeps what is typed, in order, and hands it over once', () => {
  const buffer = new TypeAhead();
  expect(buffer.push(bytes('echo '))).toBe(true);
  expect(buffer.push(bytes('hi\r'))).toBe(true);
  expect(buffer.state).toEqual({ bytes: 8, full: false });
  expect(text(buffer.take())).toBe('echo hi\r');
  expect(buffer.state).toEqual({ bytes: 0, full: false });
  expect(buffer.take()).toBeUndefined();
});

it('nothing typed gives nothing to send', () => {
  const buffer = new TypeAhead();
  expect(buffer.push(new Uint8Array())).toBe(true);
  expect(buffer.take()).toBeUndefined();
});

it('is bounded: input past the limit is not kept, nor anything after it, so the shell gets no holes', () => {
  const buffer = new TypeAhead(6);
  expect(buffer.push(bytes('abcd'))).toBe(true);
  expect(buffer.push(bytes('efg'))).toBe(false);
  // It would fit, but it came after input that was not kept.
  expect(buffer.push(bytes('h'))).toBe(false);
  expect(buffer.state).toEqual({ bytes: 4, full: true });
  expect(text(buffer.take())).toBe('abcd');
  // Handed over: it takes input again.
  expect(buffer.push(bytes('xyz'))).toBe(true);
  expect(text(buffer.take())).toBe('xyz');
});

it('fills to exactly the limit', () => {
  const buffer = new TypeAhead();
  expect(buffer.push(new Uint8Array(TYPE_AHEAD_LIMIT))).toBe(true);
  expect(buffer.push(bytes('x'))).toBe(false);
  expect(buffer.take()?.length).toBe(TYPE_AHEAD_LIMIT);
});

it('clear forgets what was typed and that it was full', () => {
  const buffer = new TypeAhead(2);
  buffer.push(bytes('ab'));
  buffer.push(bytes('c'));
  buffer.clear();
  expect(buffer.state).toEqual({ bytes: 0, full: false });
  expect(buffer.take()).toBeUndefined();
});

it('the connection screen says when typing past the limit was not kept', () => {
  expect(typedAheadText({ bytes: 3, full: false })).toBe('What you typed is sent when the shell opens.');
  expect(typedAheadText({ bytes: TYPE_AHEAD_LIMIT, full: true })).toBe(
    'What you typed is sent when the shell opens, up to 4 KB; typing after that is not kept.',
  );
});
