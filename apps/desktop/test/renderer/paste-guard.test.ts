import { expect, it } from 'vitest';
import { guardPaste, pastePreview } from '../../src/renderer/features/ssh/paste-guard.js';

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
