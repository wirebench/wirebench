import { describe, expect, it } from 'vitest';
import { diffXml } from '../../../src/snapshot/xml-diff.js';

describe('diffXml', () => {
  it('ignores a different prefix bound to the same namespace', () => {
    const golden = '<a:root xmlns:a="urn:x"><a:child>1</a:child></a:root>';
    const actual = '<b:root xmlns:b="urn:x"><b:child>1</b:child></b:root>';
    expect(diffXml(golden, actual)).toEqual([]);
  });

  it('ignores attribute order, comments and whitespace', () => {
    const golden = '<root a="1" b="2"><!-- note -->\n  <child>x</child>\n</root>';
    const actual = '<root b="2" a="1"><child>\n  x\n</child></root>';
    expect(diffXml(golden, actual)).toEqual([]);
  });

  it('adds [n] to repeated siblings', () => {
    const golden = '<root><item>a</item><item>b</item></root>';
    const actual = '<root><item>a</item><item>c</item></root>';
    expect(diffXml(golden, actual)).toEqual([{ kind: 'changed', path: '/root/item[2]', expected: 'b', actual: 'c' }]);
  });

  it('does not shift siblings when an earlier one with a different name is inserted', () => {
    const golden = '<root><item>a</item><item>b</item></root>';
    const actual = '<root><extra>z</extra><item>a</item><item>b</item></root>';
    expect(diffXml(golden, actual)).toEqual([{ kind: 'added', path: '/root/extra', actual: '<extra>' }]);
  });

  it('reports a changed attribute value', () => {
    const golden = '<root id="1"/>';
    const actual = '<root id="2"/>';
    expect(diffXml(golden, actual)).toEqual([{ kind: 'changed', path: '/root/@id', expected: '1', actual: '2' }]);
  });

  it('treats the same local name in a different namespace as a change', () => {
    const golden = '<root xmlns:a="urn:a"><a:item>1</a:item></root>';
    const actual = '<root xmlns:b="urn:b"><b:item>1</b:item></root>';
    const changes = diffXml(golden, actual);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'removed', path: '/root/item' }),
        expect.objectContaining({ kind: 'added', path: '/root/item' }),
      ]),
    );
    expect(changes).toHaveLength(2);
  });

  it('trims each run of mixed content on its own', () => {
    const golden = '<root>Hello <b>big</b> world</root>';
    const actual = '<root>\n  Hello\n  <b>big</b>\n  world\n</root>';
    expect(diffXml(golden, actual)).toEqual([]);
  });

  it('still sees text move across a child element', () => {
    const golden = '<root>ab<b/>c</root>';
    const actual = '<root>a<b/>bc</root>';
    expect(diffXml(golden, actual)).toEqual([{ kind: 'changed', path: '/root', expected: 'ab c', actual: 'a bc' }]);
  });
});
