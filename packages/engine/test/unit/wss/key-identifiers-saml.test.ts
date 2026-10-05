import { describe, expect, it } from 'vitest';
import { samlTokenReference } from '../../../src/wss/key-identifiers.js';
import { NS } from '../../../src/xml/namespaces.js';
import { parseXml } from '../../../src/xml/parse.js';
import type { PlacedSamlToken } from '../../../src/wss/outgoing/saml.js';

const ATTACHED =
  `<wsse:SecurityTokenReference xmlns:wsse="${NS.WSSE}">` +
  `<wsse:KeyIdentifier ValueType="urn:v">_a1</wsse:KeyIdentifier></wsse:SecurityTokenReference>`;

function attached(xml: string): PlacedSamlToken {
  return { version: '2.0', attachedReferenceXml: xml };
}

function root(xml: string) {
  const element = parseXml(xml).documentElement;
  if (element === null) throw new Error('no root');
  return element;
}

describe('samlTokenReference with an id', () => {
  it('escapes the id in a KeyIdentifier reference', () => {
    const xml = samlTokenReference({ version: '2.0', assertionId: '_a1' }, { id: 'a"b<c' });
    expect(root(xml).getAttributeNS(NS.WSU, 'Id')).toBe('a"b<c');
  });

  it('gives an attached reference the id', () => {
    const xml = samlTokenReference(attached(ATTACHED), { id: 'STR-1' });
    const str = root(xml);
    expect(str.localName).toBe('SecurityTokenReference');
    expect(str.getAttributeNS(NS.WSU, 'Id')).toBe('STR-1');
  });

  it('escapes the id in an attached reference', () => {
    const xml = samlTokenReference(attached(ATTACHED), { id: 'a"b&c' });
    expect(root(xml).getAttributeNS(NS.WSU, 'Id')).toBe('a"b&c');
  });

  it('tolerates leading whitespace and comments before the attached reference', () => {
    const xml = samlTokenReference(attached(`\n  <!-- from the RSTR -->\n${ATTACHED}`), { id: 'STR-1' });
    expect(root(xml).getAttributeNS(NS.WSU, 'Id')).toBe('STR-1');
  });

  it('replaces an id the attached reference already carries, without a duplicate declaration', () => {
    const withId = ATTACHED.replace(
      '<wsse:SecurityTokenReference ',
      `<wsse:SecurityTokenReference xmlns:wsu="${NS.WSU}" wsu:Id="old" `,
    );
    const xml = samlTokenReference(attached(withId), { id: 'STR-1' });
    expect(root(xml).getAttributeNS(NS.WSU, 'Id')).toBe('STR-1');
    expect(xml.match(/xmlns:wsu=/g)).toHaveLength(1);
    expect(xml.match(/wsu:Id=/g)).toHaveLength(1);
  });

  it('keeps the attached reference verbatim without an id', () => {
    expect(samlTokenReference(attached(ATTACHED))).toBe(ATTACHED);
  });
});
