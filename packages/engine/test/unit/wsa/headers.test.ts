import { describe, expect, it } from 'vitest';
import { WsaError } from '../../../src/errors.js';
import { createEnvelope } from '../../../src/soap/envelope.js';
import { serializeXml } from '../../../src/xml/serialize.js';
import {
  anonymousAddress,
  applyWsaHeaders,
  buildWsaHeaders,
  defaultRelationshipType,
  effectiveAction,
  effectiveMessageId,
  effectiveTo,
  stripWsaHeaders,
  wsaNamespace,
} from '../../../src/wsa/headers.js';
import { DEFAULT_WSA_CONFIG, effectiveWsa, normalizeWsa } from '../../../src/wsa/model.js';
import type { WsaConfig } from '../../../src/wsa/model.js';

const CTX = {
  endpoint: 'http://example.invalid/soap',
  soapAction: 'urn:wb:wsa:Echo',
  defaultAction: 'urn:wb:wsa/WsaPortType/EchoRequest',
  uuid: () => '11111111-2222-3333-4444-555555555555',
  envelopeVersion: '1.1' as const,
};

function config(patch: Partial<WsaConfig> = {}): WsaConfig {
  return { ...DEFAULT_WSA_CONFIG, enabled: true, ...patch };
}

function render(built: readonly { toString(): string }[]): string {
  return built.map((element) => serializeXml(element as never)).join('\n');
}

const ENVELOPE = createEnvelope('1.1', { bodyXml: '<tem:Add xmlns:tem="urn:t"/>' });

describe('buildWsaHeaders', () => {
  it('produces the golden 2005/08 header block', () => {
    expect(render(buildWsaHeaders(config(), CTX))).toBe(
      [
        '<wsa:Action xmlns:wsa="http://www.w3.org/2005/08/addressing">urn:wb:wsa:Echo</wsa:Action>',
        '<wsa:To xmlns:wsa="http://www.w3.org/2005/08/addressing">http://example.invalid/soap</wsa:To>',
        '<wsa:MessageID xmlns:wsa="http://www.w3.org/2005/08/addressing">urn:uuid:11111111-2222-3333-4444-555555555555</wsa:MessageID>',
      ].join('\n'),
    );
  });

  it('produces the golden 2004/08 header block, with that version’s anonymous address', () => {
    const built = buildWsaHeaders(config({ version: '2004/08', replyTo: 'anonymous' }), CTX);
    const ns = 'http://schemas.xmlsoap.org/ws/2004/08/addressing';
    expect(render(built)).toBe(
      [
        `<wsa:Action xmlns:wsa="${ns}">urn:wb:wsa:Echo</wsa:Action>`,
        `<wsa:To xmlns:wsa="${ns}">http://example.invalid/soap</wsa:To>`,
        `<wsa:MessageID xmlns:wsa="${ns}">urn:uuid:11111111-2222-3333-4444-555555555555</wsa:MessageID>`,
        `<wsa:ReplyTo xmlns:wsa="${ns}"><wsa:Address>${anonymousAddress('2004/08')}</wsa:Address></wsa:ReplyTo>`,
      ].join('\n'),
    );
  });

  it('writes the anonymous 2005/08 address for ReplyTo/From/FaultTo', () => {
    const built = render(
      buildWsaHeaders(config({ replyTo: 'anonymous', from: 'anonymous', faultTo: 'urn:elsewhere' }), CTX),
    );
    expect(built).toContain(`<wsa:Address>${anonymousAddress('2005/08')}</wsa:Address>`);
    expect(built).toContain('<wsa:Address>urn:elsewhere</wsa:Address>');
    expect(built.match(/<wsa:Address>/g)).toHaveLength(3);
  });

  it('writes the SOAP 1.1 mustUnderstand literal on every header', () => {
    const built = render(buildWsaHeaders(config({ mustUnderstand: 'true' }), CTX));
    expect(built.match(/mustUnderstand="1"/g)).toHaveLength(3);
  });

  it('writes the SOAP 1.2 mustUnderstand literal on every header', () => {
    const built = render(buildWsaHeaders(config({ mustUnderstand: 'false' }), { ...CTX, envelopeVersion: '1.2' }));
    expect(built.match(/mustUnderstand="false"/g)).toHaveLength(3);
  });

  it('writes no mustUnderstand attribute by default', () => {
    expect(render(buildWsaHeaders(config(), CTX))).not.toContain('mustUnderstand');
  });

  it('defaults a RelatesTo RelationshipType per version', () => {
    expect(render(buildWsaHeaders(config({ relatesTo: 'urn:uuid:prior' }), CTX))).toContain(
      `RelationshipType="${defaultRelationshipType('2005/08')}"`,
    );
    expect(render(buildWsaHeaders(config({ version: '2004/08', relatesTo: 'urn:uuid:prior' }), CTX))).toContain(
      'RelationshipType="wsa:Reply"',
    );
    expect(
      render(buildWsaHeaders(config({ relatesTo: 'urn:uuid:prior', relationshipType: 'urn:custom' }), CTX)),
    ).toContain('RelationshipType="urn:custom"');
  });

  it('omits every optional header when the defaults are turned off', () => {
    const built = buildWsaHeaders(
      config({ addDefaultAction: false, addDefaultTo: false, generateMessageId: false }),
      CTX,
    );
    expect(built).toHaveLength(0);
  });
});

describe('effective values', () => {
  it('prefers an explicit action, then the SOAPAction, then the WSDL default', () => {
    expect(effectiveAction(config({ action: 'urn:explicit' }), CTX)).toBe('urn:explicit');
    expect(effectiveAction(config(), CTX)).toBe('urn:wb:wsa:Echo');
    expect(effectiveAction(config(), { ...CTX, soapAction: '' })).toBe(CTX.defaultAction);
    expect(effectiveAction(config(), { soapAction: '', defaultAction: '' })).toBeUndefined();
    expect(effectiveAction(config({ addDefaultAction: false }), CTX)).toBeUndefined();
  });

  it('prefers an explicit To, then the endpoint', () => {
    expect(effectiveTo(config({ to: 'urn:explicit' }), 'http://e')).toBe('urn:explicit');
    expect(effectiveTo(config(), 'http://e')).toBe('http://e');
    expect(effectiveTo(config(), '')).toBeUndefined();
    expect(effectiveTo(config({ addDefaultTo: false }), 'http://e')).toBeUndefined();
  });

  it('mints a fresh MessageID unless one is fixed', () => {
    let n = 0;
    const uuid = () => `uuid-${String((n += 1))}`;
    expect(effectiveMessageId(config(), uuid)).toBe('urn:uuid:uuid-1');
    expect(effectiveMessageId(config(), uuid)).toBe('urn:uuid:uuid-2');
    expect(effectiveMessageId(config({ messageId: 'auto' }), uuid)).toBe('urn:uuid:uuid-3');
    expect(effectiveMessageId(config({ messageId: 'urn:fixed' }), uuid)).toBe('urn:fixed');
    expect(effectiveMessageId(config({ generateMessageId: false }), uuid)).toBeUndefined();
  });

  it('mints a fresh MessageID even when generation is off, if the id is explicitly auto', () => {
    expect(effectiveMessageId(config({ generateMessageId: false, messageId: 'auto' }), () => 'x')).toBe('urn:uuid:x');
  });
});

describe('wsaNamespace', () => {
  it('maps each version to its namespace', () => {
    expect(wsaNamespace('2005/08')).toBe('http://www.w3.org/2005/08/addressing');
    expect(wsaNamespace('2004/08')).toBe('http://schemas.xmlsoap.org/ws/2004/08/addressing');
  });
});

describe('applyWsaHeaders', () => {
  it('inserts the block before every other header', () => {
    const envelope = createEnvelope('1.1', {
      headerXml: '<x:Trace xmlns:x="urn:x">1</x:Trace>',
      bodyXml: '<tem:Add xmlns:tem="urn:t"/>',
    });
    const applied = applyWsaHeaders(envelope, config(), CTX);
    expect(applied.indexOf('wsa:Action')).toBeLessThan(applied.indexOf('x:Trace'));
    expect(applied).toContain('<x:Trace xmlns:x="urn:x">1</x:Trace>');
  });

  it('creates a Header when the envelope has none', () => {
    const bare =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>';
    const applied = applyWsaHeaders(bare, config(), CTX);
    expect(applied).toContain('<soapenv:Header>');
    expect(applied.indexOf('soapenv:Header')).toBeLessThan(applied.indexOf('soapenv:Body'));
  });

  it('replaces headers already present, of either version', () => {
    const once = applyWsaHeaders(ENVELOPE, config(), CTX);
    const twice = applyWsaHeaders(once, config({ action: 'urn:second' }), CTX);
    expect(twice.match(/<wsa:Action/g)).toHaveLength(1);
    expect(twice).toContain('urn:second');
    const switched = applyWsaHeaders(twice, config({ version: '2004/08' }), CTX);
    expect(switched.match(/<wsa:Action/g)).toHaveLength(1);
    expect(switched).toContain('http://schemas.xmlsoap.org/ws/2004/08/addressing');
    expect(switched).not.toContain('http://www.w3.org/2005/08/addressing');
  });

  it('uses the envelope’s own SOAP version for mustUnderstand', () => {
    const soap12 = createEnvelope('1.2', { bodyXml: '<tem:Add xmlns:tem="urn:t"/>' });
    expect(applyWsaHeaders(soap12, config({ mustUnderstand: 'true' }), CTX)).toContain('mustUnderstand="true"');
  });

  it('rejects a document that is not a SOAP envelope', () => {
    expect(() => applyWsaHeaders('<root/>', config(), CTX)).toThrow(WsaError);
  });
});

describe('stripWsaHeaders', () => {
  it('removes every addressing header of either version', () => {
    const applied = applyWsaHeaders(ENVELOPE, config({ replyTo: 'anonymous' }), CTX);
    expect(stripWsaHeaders(applied)).not.toContain('wsa:');
  });

  it('leaves other headers alone', () => {
    const envelope = createEnvelope('1.1', {
      headerXml: '<x:Trace xmlns:x="urn:x">1</x:Trace>',
      bodyXml: '<tem:Add xmlns:tem="urn:t"/>',
    });
    expect(stripWsaHeaders(applyWsaHeaders(envelope, config(), CTX))).toContain('<x:Trace xmlns:x="urn:x">1</x:Trace>');
  });

  it('returns an envelope with nothing to strip byte for byte', () => {
    expect(stripWsaHeaders(ENVELOPE)).toBe(ENVELOPE);
    const bare =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>';
    expect(stripWsaHeaders(bare)).toBe(bare);
    expect(stripWsaHeaders('<root/>')).toBe('<root/>');
  });
});

describe('effectiveWsa', () => {
  it('fills the defaults in for an old two-field configuration', () => {
    expect(normalizeWsa({ enabled: true })).toEqual({ ...DEFAULT_WSA_CONFIG, enabled: true });
    expect(normalizeWsa(undefined)).toEqual(DEFAULT_WSA_CONFIG);
  });

  it('lets the request override the interface field by field', () => {
    const iface = { enabled: true, version: '2004/08' as const, action: 'urn:iface', to: 'urn:to' };
    expect(effectiveWsa(iface, { action: 'urn:request' })).toEqual({
      ...DEFAULT_WSA_CONFIG,
      enabled: true,
      version: '2004/08',
      action: 'urn:request',
      to: 'urn:to',
    });
  });

  it('inherits the interface wholesale when the request defines nothing', () => {
    const iface = { enabled: true, mustUnderstand: 'true' as const };
    expect(effectiveWsa(iface, undefined)).toEqual({ ...DEFAULT_WSA_CONFIG, enabled: true, mustUnderstand: 'true' });
    expect(effectiveWsa(undefined, undefined)).toEqual(DEFAULT_WSA_CONFIG);
  });
});
