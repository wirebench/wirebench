import { describe, expect, it, vi } from 'vitest';
import { classifyParseEvent, getPosition, parseXml, parseXmlDetailed } from '../../../src/xml/parse.js';
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

  // Probed empirically against @xmldom/xmldom 0.9.12 (see task-2-report.md, "Fix round 1"):
  // an unquoted attribute value produces a `warning` onError call but xmldom still
  // recovers and yields a Document.
  it('does not throw for an unquoted attribute value, and surfaces it as a warning problem', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { document, problems } = parseXmlDetailed('<root attr=value/>', { location: 'unquoted.xml' });
      expect(document.documentElement?.tagName).toBe('root');
      expect(problems).toHaveLength(1);
      expect(problems[0]?.level).toBe('warning');
      expect(problems[0]?.location).toBe('unquoted.xml');
      expect(problems[0]?.message).toContain('quot');

      // parseXml (the thin wrapper) must also not throw and must not print anything.
      const doc = parseXml('<root attr=value/>');
      expect(doc.documentElement?.tagName).toBe('root');
      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  // Probed empirically: an undefined entity reference produces an `error` onError
  // call but xmldom still recovers and yields a Document.
  it('does not throw for an undefined entity reference, and surfaces it as an error problem', () => {
    const { document, problems } = parseXmlDetailed('<root>&undefinedEntity;</root>');
    expect(document.documentElement?.tagName).toBe('root');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.level).toBe('error');
    expect(problems[0]?.message).toContain('entity not found');
  });

  it('still throws xml-parse-error for a genuine fatalError (unclosed tag)', () => {
    expect(() => parseXmlDetailed('<root><unclosed></root>')).toThrow();
    try {
      parseXmlDetailed('<root><unclosed></root>');
      expect.unreachable();
    } catch (e) {
      expect(isWirebenchError(e)).toBe(true);
      if (isWirebenchError(e)) {
        expect(e.code).toBe('xml-parse-error');
      }
    }
  });
});

describe('classifyParseEvent', () => {
  it('classifies fatalError as fatal', () => {
    expect(classifyParseEvent('fatalError', 'boom')).toEqual({ fatal: true });
  });

  it('classifies warning as non-fatal warning', () => {
    expect(classifyParseEvent('warning', 'careful')).toEqual({ fatal: false, level: 'warning' });
  });

  it('classifies error as non-fatal error', () => {
    expect(classifyParseEvent('error', 'oops')).toEqual({ fatal: false, level: 'error' });
  });
});
