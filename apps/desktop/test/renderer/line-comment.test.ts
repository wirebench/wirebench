import { describe, expect, it } from 'vitest';
import {
  toggleCommentInEditor,
  toggleLineComments,
  type CommentableEditor,
} from '../../src/renderer/editor/line-comment.js';

describe('toggleLineComments', () => {
  it('puts // at the indent of an indented line, not at column 1 (G15)', () => {
    expect(toggleLineComments(['  "a": 1,'])).toEqual(['  // "a": 1,']);
  });

  it('uncomments an indented line back to the original', () => {
    expect(toggleLineComments(['  // "a": 1,'])).toEqual(['  "a": 1,']);
  });

  it('uses the smallest indent of the non-blank lines and skips blank ones', () => {
    const lines = ['    "a": 1,', '', '  "b": 2'];
    const commented = toggleLineComments(lines);
    expect(commented).toEqual(['  //   "a": 1,', '', '  // "b": 2']);
    expect(toggleLineComments(commented)).toEqual(lines);
  });

  it('comments mixed lines when only some are comments, and reverses cleanly', () => {
    const lines = ['  // a', '  b'];
    const commented = toggleLineComments(lines);
    expect(commented).toEqual(['  // // a', '  // b']);
    expect(toggleLineComments(commented)).toEqual(lines);
  });

  it('uncomments lines of different indents each at their own indent', () => {
    expect(toggleLineComments(['// a', '  // b', '    //c'])).toEqual(['a', '  b', '    c']);
  });

  it('comments a whitespace-only selection', () => {
    expect(toggleLineComments(['  '])).toEqual(['  // ']);
  });
});

function fakeEditor(text: string, selection: { start: number; end: number; endColumn: number }) {
  const lines = text.split('\n');
  const edits: { range: unknown; text: string }[] = [];
  const editor: CommentableEditor = {
    getSelection: () => ({
      startLineNumber: selection.start,
      endLineNumber: selection.end,
      endColumn: selection.endColumn,
    }),
    getModel: () => ({
      getLineContent: (line) => lines[line - 1]!,
      getLineMaxColumn: (line) => lines[line - 1]!.length + 1,
      getEOL: () => '\n',
    }),
    executeEdits: (_source, list) => {
      edits.push(...list);
      return true;
    },
  };
  return { editor, edits };
}

describe('toggleCommentInEditor', () => {
  it('replaces the selected lines with the toggled text', () => {
    const { editor, edits } = fakeEditor('{\n  "a": 1,\n  "b": 2\n}', { start: 2, end: 3, endColumn: 5 });
    toggleCommentInEditor(editor);
    expect(edits).toEqual([
      {
        range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 9 },
        text: '  // "a": 1,\n  // "b": 2',
      },
    ]);
  });

  it('leaves out the last line when the selection ends at its column 1', () => {
    const { editor, edits } = fakeEditor('  a\n  b', { start: 1, end: 2, endColumn: 1 });
    toggleCommentInEditor(editor);
    expect(edits[0]?.text).toBe('  // a');
  });
});
