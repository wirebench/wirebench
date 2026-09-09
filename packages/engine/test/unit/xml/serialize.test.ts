import { describe, expect, it } from 'vitest';
import { parseXml } from '../../../src/xml/parse.js';
import { serializeXml } from '../../../src/xml/serialize.js';

describe('serializeXml', () => {
  it('round-trips parse -> serialize preserving namespaces, attributes, and text', () => {
    const xml = '<root xmlns="urn:default" xmlns:a="urn:a"><a:child id="1" a:extra="v">hello world</a:child></root>';
    const doc = parseXml(xml);
    const out = serializeXml(doc);

    const reparsed = parseXml(out);
    expect(reparsed.documentElement?.namespaceURI).toBe('urn:default');
    const child = reparsed.getElementsByTagNameNS('urn:a', 'child')[0];
    expect(child).toBeDefined();
    expect(child?.getAttribute('id')).toBe('1');
    expect(child?.getAttributeNS('urn:a', 'extra')).toBe('v');
    expect(child?.textContent).toBe('hello world');
  });
});
