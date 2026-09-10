import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

import {
  buildCompletionItems,
  computeFormatEdit,
  formatEditorInPlace,
  gotoLine,
  nextUnusedNsPrefix,
  prettyPrintXml,
} from '../../src/renderer/editor/xml-language.js';

describe('computeFormatEdit', () => {
  it('returns the reformatted text when it changes the document', () => {
    const edit = computeFormatEdit('<a><b>1</b></a>');
    expect(edit?.text).toBe('<a>\n   <b>1</b>\n</a>');
  });

  it('returns undefined when already formatted', () => {
    expect(computeFormatEdit('<a>\n   <b>1</b>\n</a>')).toBeUndefined();
  });

  it('returns undefined on unbalanced tags rather than a bogus edit', () => {
    expect(computeFormatEdit('<a><b></a>')).toBeUndefined();
  });
});

describe('prettyPrintXml', () => {
  it('always returns a string, unchanged on malformed input', () => {
    expect(prettyPrintXml('<a><b>1</b></a>')).toBe('<a>\n   <b>1</b>\n</a>');
    expect(prettyPrintXml('<a><b></a>')).toBe('<a><b></a>');
  });
});

describe('nextUnusedNsPrefix', () => {
  it('picks ns1 when nothing is bound', () => {
    expect(nextUnusedNsPrefix(new Set())).toBe('ns1');
  });

  it('skips already-bound nsN prefixes', () => {
    expect(nextUnusedNsPrefix(new Set(['ns1', 'ns2']))).toBe('ns3');
  });
});

describe('buildCompletionItems', () => {
  const doc = '<tem:Add xmlns:tem="http://tempuri.org/"><tem:intA>1</tem:intA></tem:Add>';
  const prefixes = { tem: 'http://tempuri.org/' };

  it('reuses the prefix already bound to the namespace in the document', () => {
    const items = buildCompletionItems([{ name: 'intB', namespaceUri: 'http://tempuri.org/' }], doc, prefixes);
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('tem:intB');
    expect(items[0]?.insertText).toBe('tem:intB>$0</tem:intB>');
    expect(items[0]?.rootEdit).toBeUndefined();
  });

  it('synthesises the next unused nsN prefix and a root xmlns edit for an unbound namespace', () => {
    const items = buildCompletionItems([{ name: 'Widget', namespaceUri: 'urn:other' }], doc, prefixes);
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe('ns1:Widget');
    expect(items[0]?.insertText).toBe('ns1:Widget>$0</ns1:Widget>');
    expect(items[0]?.rootEdit).toEqual({
      offset: '<tem:Add xmlns:tem="http://tempuri.org/"'.length,
      text: ' xmlns:ns1="urn:other"',
    });
  });

  it('reuses one synthesised prefix across multiple candidates sharing the same unbound namespace', () => {
    const items = buildCompletionItems(
      [
        { name: 'A', namespaceUri: 'urn:other' },
        { name: 'B', namespaceUri: 'urn:other' },
      ],
      doc,
      prefixes,
    );
    expect(items[0]?.label).toBe('ns1:A');
    expect(items[1]?.label).toBe('ns1:B');
    // Only the first candidate carries the root edit — applying it twice would duplicate the declaration.
    expect(items[0]?.rootEdit).toBeDefined();
    expect(items[1]?.rootEdit).toBeUndefined();
  });

  it('avoids an already-bound nsN when synthesising', () => {
    const withNs1Bound = { tem: 'http://tempuri.org/', ns1: 'urn:taken' };
    const items = buildCompletionItems([{ name: 'Widget', namespaceUri: 'urn:other' }], doc, withNs1Bound);
    expect(items[0]?.label).toBe('ns2:Widget');
  });

  it('carries documentation through when present', () => {
    const items = buildCompletionItems(
      [{ name: 'intB', namespaceUri: 'http://tempuri.org/', documentation: 'the second operand' }],
      doc,
      prefixes,
    );
    expect(items[0]?.documentation).toBe('the second operand');
  });
});

describe('formatEditorInPlace', () => {
  function fakeEditor(text: string) {
    let position = { lineNumber: 1, column: 1 };
    const model = {
      getValue: () => text,
      getFullModelRange: () => 'FULL_RANGE',
    };
    return {
      executeEdits: vi.fn(),
      getModel: () => model,
      getPosition: () => position,
      setPosition: vi.fn((p: typeof position) => {
        position = p;
      }),
    };
  }

  it('applies one executeEdits call with the reformatted text over the full range', () => {
    const editor = fakeEditor('<a><b>1</b></a>');
    formatEditorInPlace(editor as unknown as Parameters<typeof formatEditorInPlace>[0]);
    expect(editor.executeEdits).toHaveBeenCalledTimes(1);
    expect(editor.executeEdits).toHaveBeenCalledWith('editor.formatXml', [
      { range: 'FULL_RANGE', text: '<a>\n   <b>1</b>\n</a>' },
    ]);
    expect(editor.setPosition).toHaveBeenCalled();
  });

  it('does nothing when already formatted', () => {
    const editor = fakeEditor('<a>\n   <b>1</b>\n</a>');
    formatEditorInPlace(editor as unknown as Parameters<typeof formatEditorInPlace>[0]);
    expect(editor.executeEdits).not.toHaveBeenCalled();
  });
});

describe('gotoLine', () => {
  it('runs the editor.action.gotoLine action', () => {
    const run = vi.fn();
    const editor = { getAction: vi.fn(() => ({ run })) };
    gotoLine(editor as unknown as Parameters<typeof formatEditorInPlace>[0]);
    expect(editor.getAction).toHaveBeenCalledWith('editor.action.gotoLine');
    expect(run).toHaveBeenCalled();
  });

  it('does not throw when the action is unavailable', () => {
    const editor = { getAction: vi.fn(() => undefined) };
    expect(() => gotoLine(editor as unknown as Parameters<typeof formatEditorInPlace>[0])).not.toThrow();
  });
});
