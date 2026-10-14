import { expect, it } from 'vitest';
import { guardPaste, hasControlCharacters, pastePreview } from '../../src/renderer/features/ssh/paste-guard.js';

it('asks for multi-line text only when the preference is on; one trailing newline is fine', () => {
  expect(guardPaste('ls\n', { confirmMultilinePaste: true })).toBe('send');
  expect(guardPaste('ls\r\n', { confirmMultilinePaste: true })).toBe('send');
  expect(guardPaste('ls', { confirmMultilinePaste: true })).toBe('send');
  expect(guardPaste('', { confirmMultilinePaste: true })).toBe('send');
  expect(guardPaste('ls\nrm -rf /tmp/x\n', { confirmMultilinePaste: true })).toBe('ask');
  expect(guardPaste('ls\n\n', { confirmMultilinePaste: true })).toBe('ask');
  expect(guardPaste('ls\nrm -rf /tmp/x\n', { confirmMultilinePaste: false })).toBe('send');
  expect(guardPaste('a\rb', { confirmMultilinePaste: true })).toBe('ask');
  expect(guardPaste('a\r\nb', { confirmMultilinePaste: true })).toBe('ask');
});

it('previews the first five lines and counts the rest', () => {
  expect(pastePreview('a\nb\nc\n')).toEqual({ lines: ['a', 'b', 'c'], remaining: 0 });
  expect(pastePreview('1\n2\n3\n4\n5')).toEqual({ lines: ['1', '2', '3', '4', '5'], remaining: 0 });
  expect(pastePreview('1\r\n2\r3\n4\n5\n6\n7\n8\n')).toEqual({ lines: ['1', '2', '3', '4', '5'], remaining: 3 });
});

it('a paste that reaches more than one pane always asks, the preference and one line notwithstanding', () => {
  expect(guardPaste('uptime', { confirmMultilinePaste: false }, 3)).toBe('ask');
  expect(guardPaste('uptime', { confirmMultilinePaste: true }, 1)).toBe('send');
});

it('text holding control characters always asks, whatever the preference; tab and line breaks are not counted', () => {
  const prefsOff = { confirmMultilinePaste: false };
  // An embedded bracketed-paste end on a single line.
  expect(guardPaste('echo hi\x1b[201~rm -rf ~', prefsOff)).toBe('ask');
  expect(guardPaste('\x1b[A', prefsOff)).toBe('ask');
  // C1: the one-byte CSI.
  expect(guardPaste('a\x9b201~b', prefsOff)).toBe('ask');
  expect(guardPaste('ctrl-c \x03', prefsOff)).toBe('ask');
  expect(guardPaste('del \x7f', prefsOff)).toBe('ask');
  expect(guardPaste('nul \x00', prefsOff)).toBe('ask');
  // Tabs and line breaks alone stay with the multi-line preference.
  expect(guardPaste('a\tb\n', prefsOff)).toBe('send');
  expect(guardPaste('a\tb\nc\r\nd', prefsOff)).toBe('send');
  expect(guardPaste('a\tb\nc', { confirmMultilinePaste: true })).toBe('ask');
  // Ordinary text past ASCII is not a control character.
  expect(guardPaste('café ü €', prefsOff)).toBe('send');
  expect(hasControlCharacters('café x')).toBe(false);
});

it('previews control characters escaped, line by line', () => {
  expect(pastePreview('a\x1b[201~b\nc\x07\td\x9b\n')).toEqual({
    lines: ['a\\x1b[201~b', 'c\\x07\td\\x9b'],
    remaining: 0,
  });
});
