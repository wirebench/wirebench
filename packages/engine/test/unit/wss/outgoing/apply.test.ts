import { describe, expect, it } from 'vitest';
import { WssError } from '../../../../src/errors.js';
import { createWssContext } from '../../../../src/wss/model.js';
import { applyOutgoingWss, removeOutgoingWss } from '../../../../src/wss/apply.js';
import type { WssEntry, WssOutgoingConfig } from '../../../../src/wss/model.js';

const ctx = createWssContext({
  clock: () => new Date('2026-09-09T12:00:00Z'),
  nonce: () => new Uint8Array(Buffer.from('WScqanjCEAC4mQoBE07sAQ==', 'base64')),
  uuid: () => 'fixed',
  secrets: (ref) => Promise.resolve(ref === 'secret:pw' ? 'hunter2' : undefined),
});

const SOAP11 =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';
const SOAP12 =
  '<soapenv:Envelope xmlns:soapenv="http://www.w3.org/2003/05/soap-envelope">' +
  '<soapenv:Header/><soapenv:Body><Ping/></soapenv:Body></soapenv:Envelope>';

function config(overrides?: Partial<WssOutgoingConfig>): WssOutgoingConfig {
  return {
    id: 'w1',
    name: 'Outgoing',
    mustUnderstand: false,
    entries: [
      { kind: 'timestamp', timeToLiveSeconds: 300, millisecondPrecision: false },
      {
        kind: 'username-token',
        username: 'bob',
        passwordRef: 'secret:pw',
        passwordType: 'text',
        addNonce: false,
        addCreated: false,
      },
    ],
    ...overrides,
  };
}

describe('applyOutgoingWss', () => {
  it('creates the Header and the Security block for SOAP 1.1, in entry order', async () => {
    const xml = await applyOutgoingWss(SOAP11, config(), ctx);
    expect(xml).toContain('<soapenv:Header>');
    expect(xml).toContain(
      '<wsse:Security xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"' +
        ' xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">',
    );
    expect(xml.indexOf('wsu:Timestamp')).toBeLessThan(xml.indexOf('wsse:UsernameToken'));
    expect(xml).toContain(
      '<wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">hunter2</wsse:Password>',
    );
    // the Header is created before the Body
    expect(xml.indexOf('<soapenv:Header>')).toBeLessThan(xml.indexOf('<soapenv:Body>'));
    expect(xml).toContain('<Ping/>');
  });

  it('honours the configured entry order', async () => {
    const reversed = config({ entries: [config().entries[1]!, config().entries[0]!] });
    const xml = await applyOutgoingWss(SOAP11, reversed, ctx);
    expect(xml.indexOf('wsse:UsernameToken')).toBeLessThan(xml.indexOf('wsu:Timestamp'));
  });

  it('writes mustUnderstand and actor per SOAP version', async () => {
    const soap11 = await applyOutgoingWss(SOAP11, config({ mustUnderstand: true, actor: 'gw' }), ctx);
    expect(soap11).toContain('soapenv:mustUnderstand="1"');
    expect(soap11).toContain('soapenv:actor="gw"');

    const soap12 = await applyOutgoingWss(SOAP12, config({ mustUnderstand: true, actor: 'gw' }), ctx);
    expect(soap12).toContain('soapenv:mustUnderstand="true"');
    expect(soap12).toContain('soapenv:role="gw"');
  });

  it('reuses an existing Security header with the same actor', async () => {
    const once = await applyOutgoingWss(SOAP12, config(), ctx);
    const twice = await applyOutgoingWss(once, config(), ctx);
    expect(twice.match(/<wsse:Security/g)).toHaveLength(1);
    expect(twice.match(/wsu:Timestamp/g)).toHaveLength(4);
  });

  it('removes mustUnderstand when reusing a Security header and the config now says false', async () => {
    const once = await applyOutgoingWss(SOAP12, config({ mustUnderstand: true }), ctx);
    expect(once).toContain('soapenv:mustUnderstand="true"');
    const twice = await applyOutgoingWss(once, config({ mustUnderstand: false }), ctx);
    expect(twice).not.toContain('mustUnderstand');
  });

  it('removes a stray role attribute on a reused Security header when the config names no actor', async () => {
    // A Security block hand-authored (or written by another tool) with an empty `role` — which
    // `securityActor` treats as "no actor", so the no-actor config below reuses this block —
    // but the attribute itself is still present and must be cleaned up, not left behind.
    const withStrayRole = SOAP12.replace(
      '<soapenv:Header/>',
      '<soapenv:Header><wsse:Security ' +
        'xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" ' +
        'soapenv:role=""/></soapenv:Header>',
    );
    const applied = await applyOutgoingWss(withStrayRole, config(), ctx);
    expect(applied).not.toContain('soapenv:role');
  });

  it('adds a second Security header for a different actor', async () => {
    const once = await applyOutgoingWss(SOAP12, config({ actor: 'a' }), ctx);
    const twice = await applyOutgoingWss(once, config({ actor: 'b' }), ctx);
    expect(twice.match(/<wsse:Security/g)).toHaveLength(2);
  });

  it('applies request-level password type and time-to-live overrides', async () => {
    const xml = await applyOutgoingWss(SOAP11, config(), ctx, {
      requestProperties: { wssPasswordType: 'digest', wssTimeToLive: 60 },
    });
    expect(xml).toContain('#PasswordDigest');
    expect(xml).toContain('<wsu:Expires>2026-09-09T12:01:00Z</wsu:Expires>');
  });

  it('falls back to the config default password ref', async () => {
    const xml = await applyOutgoingWss(
      SOAP11,
      config({
        defaultPasswordRef: 'secret:pw',
        entries: [
          {
            kind: 'username-token',
            username: 'bob',
            passwordType: 'text',
            addNonce: false,
            addCreated: false,
          },
        ],
      }),
      ctx,
    );
    expect(xml).toContain('>hunter2</wsse:Password>');
  });

  it('rejects an entry kind this build does not know', async () => {
    // A document written by a later build: every kind this one understands is dispatched above,
    // so anything else must fail loudly rather than be silently dropped from the header.
    const future = [{ kind: 'saml-token' } as unknown as WssEntry];
    await expect(applyOutgoingWss(SOAP11, config({ entries: future }), ctx)).rejects.toMatchObject({
      code: 'wss-entry-unsupported',
    });
    await expect(applyOutgoingWss(SOAP11, config({ entries: future }), ctx)).rejects.toBeInstanceOf(WssError);
  });

  it('rejects a document that is not a SOAP envelope', async () => {
    await expect(applyOutgoingWss('<nope/>', config(), ctx)).rejects.toMatchObject({ code: 'wss-not-an-envelope' });
  });
});

describe('removeOutgoingWss', () => {
  it('removes the Security header and an emptied Header element', async () => {
    const xml = await applyOutgoingWss(SOAP11, config(), ctx);
    const cleaned = removeOutgoingWss(xml);
    expect(cleaned).not.toContain('wsse:Security');
    expect(cleaned).not.toContain('soapenv:Header');
    expect(cleaned).toContain('<Ping/>');
  });

  it('only removes the Security header of the given actor', async () => {
    const both = await applyOutgoingWss(await applyOutgoingWss(SOAP12, config({ actor: 'a' }), ctx), config(), ctx);
    const cleaned = removeOutgoingWss(both, 'a');
    expect(cleaned.match(/<wsse:Security/g)).toHaveLength(1);
    expect(cleaned).toContain('soapenv:Header');
  });

  it('leaves a document without a Security header alone', () => {
    expect(removeOutgoingWss(SOAP11)).toContain('<Ping/>');
    expect(removeOutgoingWss('<nope/>')).toBe('<nope/>');
  });

  it('drops a Header left holding only whitespace after the Security block is removed', async () => {
    const pretty =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">\n' +
      '  <soapenv:Header>\n    PLACEHOLDER\n  </soapenv:Header>\n' +
      '  <soapenv:Body><Ping/></soapenv:Body>\n</soapenv:Envelope>';
    const xml = await applyOutgoingWss(SOAP11, config(), ctx);
    const security = /<wsse:Security[\s\S]*<\/wsse:Security>/.exec(xml)?.[0];
    const withWhitespace = pretty.replace('PLACEHOLDER', `${security}\n  `);
    const cleaned = removeOutgoingWss(withWhitespace);
    expect(cleaned).not.toContain('wsse:Security');
    expect(cleaned).not.toContain('soapenv:Header');
    expect(cleaned).toContain('<Ping/>');
  });
});
