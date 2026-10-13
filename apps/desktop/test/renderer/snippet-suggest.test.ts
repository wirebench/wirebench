import { describe, expect, it } from 'vitest';
import { createLineTracker, matchSnippet } from '../../src/renderer/features/ssh/snippets/suggest.js';
import type { SnippetListItemWire } from '../../src/shared/snippets-wire.js';

const typed = (...chunks: string[]): string | undefined => {
  const tracker = createLineTracker();
  for (const chunk of chunks) tracker.input(chunk);
  return tracker.line;
};

describe('createLineTracker', () => {
  it('starts empty and accumulates printable input', () => {
    expect(typed()).toBe('');
    expect(typed('j', 'o', 'u')).toBe('jou');
    expect(typed('journal', 'ctl -u')).toBe('journalctl -u');
    expect(typed('pä', 'ß')).toBe('päß');
  });

  it.each([
    ['Enter', '\r'],
    ['Ctrl-C', '\x03'],
    ['Ctrl-U', '\x15'],
    ['Escape', '\x1b'],
  ])('%s resets the line to empty', (_name, key) => {
    expect(typed('abc', key)).toBe('');
    expect(typed('abc', key, 'de')).toBe('de');
  });

  it.each([
    ['Up', '\x1b[A'],
    ['Down', '\x1b[B'],
    ['Left', '\x1b[D'],
    ['Right', '\x1b[C'],
    ['Home', '\x1b[H'],
    ['End', '\x1b[F'],
    ['Home (application mode)', '\x1bOH'],
    ['Delete', '\x1b[3~'],
    ['Alt-b', '\x1bb'],
    ['Ctrl-A', '\x01'],
    ['Ctrl-E', '\x05'],
    ['Ctrl-W', '\x17'],
    ['Ctrl-R', '\x12'],
    ['Tab', '\t'],
  ])('%s makes the line unknown until the next Enter', (_name, key) => {
    expect(typed('abc', key)).toBeUndefined();
    expect(typed('abc', key, 'more')).toBeUndefined();
    expect(typed('abc', key, 'more', '\r')).toBe('');
    expect(typed('abc', key, '\r', 'ls')).toBe('ls');
  });

  it('Backspace inside the tracked text removes one code point', () => {
    expect(typed('abc', '\x7f')).toBe('ab');
    expect(typed('a😀', '\x7f')).toBe('a');
    expect(typed('ab', '\x7f', '\x7f')).toBe('');
  });

  it('Backspace with nothing tracked makes the line unknown', () => {
    expect(typed('\x7f')).toBeUndefined();
    expect(typed('a', '\x7f', '\x7f')).toBeUndefined();
    expect(typed('a', '\x7f', '\x7f', 'b')).toBeUndefined();
  });

  it('a paste makes the line unknown', () => {
    const tracker = createLineTracker();
    tracker.input('ab');
    tracker.input('cd', { paste: true });
    expect(tracker.line).toBeUndefined();
    tracker.input('\r');
    expect(tracker.line).toBe('');
  });

  it('reads every key of a chunk in order', () => {
    expect(typed('ls\rjou')).toBe('jou');
    expect(typed('ab\x1b[Dc')).toBeUndefined();
    expect(typed('ab\x1b[D\rcd')).toBe('cd');
  });
});

const item = (id: string, literalStart: string, over: Partial<SnippetListItemWire> = {}): SnippetListItemWire => ({
  id,
  name: id,
  tags: [],
  firstLine: literalStart,
  literalStart,
  variables: [],
  secrets: [],
  enter: true,
  confirm: false,
  lineCount: 1,
  revision: `rev-${id}`,
  ...over,
});

describe('matchSnippet', () => {
  const tail = item('tail', 'journalctl -u ', { name: 'Tail a service' });
  const disk = item('disk', 'df -h');

  it('needs three characters', () => {
    expect(matchSnippet('jo', [tail], [])).toBeUndefined();
    expect(matchSnippet('jou', [tail], [])).toBe(tail);
  });

  it('needs a strict prefix of the literal start, case exact', () => {
    expect(matchSnippet('journalctl -u ', [tail], [])).toBeUndefined();
    expect(matchSnippet('Jou', [tail], [])).toBeUndefined();
    expect(matchSnippet('jox', [tail], [])).toBeUndefined();
    expect(matchSnippet('df ', [disk], [])).toBe(disk);
  });

  it('never matches an unknown line', () => {
    expect(matchSnippet(undefined, [tail], ['tail'])).toBeUndefined();
  });

  it('ties go to the earliest in recent, then by name', () => {
    const a = item('a', 'docker ps', { name: 'Beta' });
    const b = item('b', 'docker logs', { name: 'Alpha' });
    const c = item('c', 'docker images', { name: 'Gamma' });
    expect(matchSnippet('doc', [a, b, c], [])).toBe(b);
    expect(matchSnippet('doc', [a, b, c], ['c', 'a'])).toBe(c);
    expect(matchSnippet('doc', [a, b, c], ['x', 'a'])).toBe(a);
  });
});
