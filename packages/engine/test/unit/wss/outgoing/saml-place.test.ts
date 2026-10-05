import { describe, expect, it } from 'vitest';
import { applyOutgoingWss } from '../../../../src/wss/apply.js';
import { createWssContext } from '../../../../src/wss/model.js';
import type { WssOutgoingConfig } from '../../../../src/wss/model.js';

const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';
const ASSERTION =
  '<saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0"' +
  ' IssueInstant="2026-10-05T10:00:00Z"><saml2:Issuer>urn:test</saml2:Issuer></saml2:Assertion>';

function config(entries: WssOutgoingConfig['entries']): WssOutgoingConfig {
  return { id: 'w1', name: 'Federated', mustUnderstand: false, entries };
}

describe('placing a supplied SAML assertion', () => {
  it('appends it to wsse:Security in entry order, unchanged', async () => {
    const xml = await applyOutgoingWss(
      SOAP11,
      config([
        { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
        { kind: 'saml-token', source: 'xml', xml: ASSERTION, expandProperties: false },
      ]),
      createWssContext({ clock: () => new Date('2026-10-05T10:00:00Z'), uuid: () => 'u' }),
    );
    expect(xml.indexOf('wsu:Timestamp')).toBeLessThan(xml.indexOf('saml2:Assertion'));
    expect(xml).toContain('ID="_a1"');
    expect(xml).not.toMatch(/saml2:Assertion[^>]*wsu:Id/);
  });

  it('reads the file variant through ctx.projectFile', async () => {
    const xml = await applyOutgoingWss(
      SOAP11,
      config([{ kind: 'saml-token', source: 'xml', file: 'tokens/a.xml', expandProperties: false }]),
      createWssContext({ projectFile: (path) => Promise.resolve(path === 'tokens/a.xml' ? ASSERTION : '') }),
    );
    expect(xml).toContain('ID="_a1"');
  });

  it('refuses the file variant when the host lends no file reader', async () => {
    await expect(
      applyOutgoingWss(
        SOAP11,
        config([{ kind: 'saml-token', source: 'xml', file: 'tokens/a.xml', expandProperties: false }]),
        createWssContext(),
      ),
    ).rejects.toMatchObject({ code: 'saml-token-file-missing' });
  });

  it('expands ${…} only when the entry asks for it', async () => {
    const templated = ASSERTION.replace('urn:test', '${issuer}');
    const ctx = createWssContext({ expand: (text) => text.replace('${issuer}', 'urn:expanded') });
    const kept = await applyOutgoingWss(
      SOAP11,
      config([{ kind: 'saml-token', source: 'xml', xml: templated, expandProperties: false }]),
      ctx,
    );
    const expanded = await applyOutgoingWss(
      SOAP11,
      config([{ kind: 'saml-token', source: 'xml', xml: templated, expandProperties: true }]),
      ctx,
    );
    expect(kept).toContain('${issuer}');
    expect(expanded).toContain('urn:expanded');
  });

  it('refuses an issued-token entry with ws-trust-unavailable when no source is lent', async () => {
    await expect(
      applyOutgoingWss(
        SOAP11,
        config([
          {
            kind: 'issued-token',
            stsUrl: 'https://sts.test/trust',
            soapVersion: '1.2',
            trustVersion: '1.3',
            tokenType: '2.0',
            keyType: 'bearer',
            credential: { kind: 'username', username: 'alice' },
            requestedLifetimeSeconds: 0,
          },
        ]),
        createWssContext(),
      ),
    ).rejects.toMatchObject({ code: 'ws-trust-unavailable' });
  });
});
