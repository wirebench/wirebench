import { describe, expect, it, vi } from 'vitest';
import { getPosition, parseXml } from '../../../src/xml/parse.js';
import { isWirebenchError } from '../../../src/errors.js';

describe('parseXml', () => {
  it('parses well-formed XML into a Document', () => {
    const doc = parseXml('<root xmlns:a="urn:a"><a:child attr="1">text</a:child></root>');
    expect(doc.documentElement?.tagName).toBe('root');
  });

  it('returns getPosition for a nested element in a multi-line document', () => {
    const xml = ['<root>', '  <a>', '    <b>value</b>', '  </a>', '</root>'].join('\n');
    const doc = parseXml(xml);
    const root = doc.documentElement;
    const a = root?.firstChild?.nextSibling; // whitespace text node, then <a>
    // Find the <b> element by walking.
    const bElement = doc.getElementsByTagName('b')[0];
    expect(bElement).toBeDefined();
    const pos = bElement !== undefined ? getPosition(bElement) : undefined;
    // <b> starts on line 3, at column 5 (4 spaces then '<b>')
    expect(pos).toEqual({ line: 3, column: 5 });
    expect(a).toBeDefined();
  });

  it('returns undefined for a node created programmatically (no parse position)', () => {
    const doc = parseXml('<root/>');
    const created = doc.createElement('injected');
    expect(getPosition(created)).toBeUndefined();
  });

  it('throws a WirebenchError with code xml-parse-error on malformed XML, without console output', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      expect(() => parseXml('<root><unclosed></root>', { location: 'test.xml' })).toThrow();
      try {
        parseXml('<root><unclosed></root>', { location: 'test.xml' });
      } catch (e) {
        expect(isWirebenchError(e)).toBe(true);
        if (isWirebenchError(e)) {
          expect(e.code).toBe('xml-parse-error');
          expect(e.details?.['location']).toBe('test.xml');
        }
      }

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
