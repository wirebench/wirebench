import { describe, expect, it } from 'vitest';
import { renderDnRfc2253 } from '../../../../src/wss/keystore/certificate.js';
import type forge from 'node-forge';

/** A forge `CertificateField`-shaped attribute, built from just what `renderDnRfc2253` reads. */
function attr(shortName: string, value: string): forge.pki.CertificateField {
  return { shortName, value };
}

describe('renderDnRfc2253', () => {
  it('renders most-specific attribute first, comma-separated with no space', () => {
    const dn = renderDnRfc2253([attr('C', 'ZZ'), attr('O', 'Wirebench'), attr('CN', 'wirebench-signer')]);
    expect(dn).toBe('CN=wirebench-signer,O=Wirebench,C=ZZ');
  });

  it('escapes a comma inside an attribute value', () => {
    const dn = renderDnRfc2253([attr('O', 'Acme'), attr('CN', 'Doe, John')]);
    expect(dn).toBe('CN=Doe\\, John,O=Acme');
  });

  it('escapes a leading space in an attribute value', () => {
    const dn = renderDnRfc2253([attr('CN', ' Leading Space')]);
    expect(dn).toBe('CN=\\ Leading Space');
  });

  it('escapes a trailing space', () => {
    const dn = renderDnRfc2253([attr('CN', 'Trailing Space ')]);
    expect(dn).toBe('CN=Trailing Space\\ ');
  });

  it('escapes a leading #, plus, quote, backslash, angle brackets, semicolon and equals', () => {
    const dn = renderDnRfc2253([attr('CN', '#a+b"c\\d<e>f;g=h')]);
    expect(dn).toBe('CN=\\#a\\+b\\"c\\\\d\\<e\\>f\\;g\\=h');
  });
});
