import { describe, expect, it } from 'vitest';
import type { Attachment } from '../../../../src/project/model.js';
import { parseMultipartRelated } from '../../../../src/soap/mime/multipart.js';
import { expandMtomResponse, prepareMtomRequest, xopContentType } from '../../../../src/soap/mime/mtom.js';
import type { AttachmentResolver } from '../../../../src/soap/mime/types.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'A1',
    name: 'logo.png',
    contentType: 'image/png',
    size: PNG.length,
    type: 'XOP',
    contentId: 'A1@wirebench',
    cached: true,
    source: { kind: 'cache', sha256: 'deadbeef' },
    ...overrides,
  };
}

const resolver: AttachmentResolver = () => Promise.resolve(PNG);

const ENVELOPE = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <up:Upload xmlns:up="urn:up">
      <up:data>cid:A1@wirebench</up:data>
      <up:note>not cid:A1@wirebench really</up:note>
    </up:Upload>
  </soapenv:Body>
</soapenv:Envelope>`;

describe('prepareMtomRequest', () => {
  it('replaces an element whose text is exactly a cid reference with an xop:Include', async () => {
    const prepared = await prepareMtomRequest(ENVELOPE, [attachment()], { force: false, resolver });

    expect(prepared.used).toBe(true);
    expect(prepared.envelopeXml).toContain(
      '<up:data><xop:Include href="cid:A1@wirebench" xmlns:xop="http://www.w3.org/2004/08/xop/include"/></up:data>',
    );
    expect(prepared.envelopeXml).toContain('<up:note>not cid:A1@wirebench really</up:note>');
    expect(prepared.parts).toHaveLength(1);
    expect(prepared.parts[0]).toMatchObject({
      contentId: 'A1@wirebench',
      contentType: 'image/png',
      transferEncoding: 'binary',
      fileName: 'logo.png',
    });
    expect(prepared.parts[0]?.bytes).toEqual(PNG);
    expect(prepared.consumedIds).toEqual(['A1']);
  });

  it('matches an attachment by its id when the reference does not name a Content-ID', async () => {
    const envelope = '<Body><data>cid:A1</data></Body>';
    const prepared = await prepareMtomRequest(envelope, [attachment()], { force: false, resolver });
    expect(prepared.parts[0]?.contentId).toBe('A1@wirebench');
    expect(prepared.envelopeXml).toContain('href="cid:A1@wirebench"');
  });

  it('emits one part when two elements reference the same attachment', async () => {
    const envelope = '<Body><a>cid:A1@wirebench</a><b>cid:A1@wirebench</b></Body>';
    const prepared = await prepareMtomRequest(envelope, [attachment()], { force: false, resolver });
    expect(prepared.parts).toHaveLength(1);
    expect(prepared.envelopeXml.match(/xop:Include/g)).toHaveLength(2);
  });

  it('leaves a cid reference that matches no attachment untouched', async () => {
    const envelope = '<Body><a>cid:missing@x</a></Body>';
    const prepared = await prepareMtomRequest(envelope, [attachment()], { force: false, resolver });
    expect(prepared.used).toBe(false);
    expect(prepared.parts).toEqual([]);
    expect(prepared.envelopeXml).toBe(envelope);
  });

  it('packages as MTOM with no parts at all when forced', async () => {
    const prepared = await prepareMtomRequest('<Body/>', [], { force: true, resolver });
    expect(prepared.used).toBe(true);
    expect(prepared.parts).toEqual([]);
  });

  it('does nothing to an envelope it cannot scan', async () => {
    const prepared = await prepareMtomRequest('<a><b>cid:A1</a>', [attachment()], { force: false, resolver });
    expect(prepared.envelopeXml).toBe('<a><b>cid:A1</a>');
  });
});

describe('xopContentType', () => {
  it('wraps a SOAP 1.1 content type', () => {
    expect(xopContentType('text/xml;charset=UTF-8')).toBe('application/xop+xml;charset=UTF-8;type="text/xml"');
  });

  it('keeps the SOAP 1.2 action parameter after the type parameter', () => {
    expect(xopContentType('application/soap+xml;charset=UTF-8;action="urn:Add"')).toBe(
      'application/xop+xml;charset=UTF-8;type="application/soap+xml";action="urn:Add"',
    );
  });

  it('defaults the charset when the source type carries none', () => {
    expect(xopContentType('text/xml')).toBe('application/xop+xml;charset=UTF-8;type="text/xml"');
  });
});

describe('expandMtomResponse', () => {
  const body = [
    '--B',
    'Content-Type: application/xop+xml; charset=UTF-8; type="text/xml"',
    'Content-ID: <root>',
    '',
    '<Body><data><xop:Include href="cid:img" xmlns:xop="http://www.w3.org/2004/08/xop/include"/></data></Body>',
    '--B',
    'Content-Type: image/png',
    'Content-ID: <img>',
    'Content-Transfer-Encoding: binary',
    '',
    'PNGBYTES',
    '--B--',
    '',
  ].join('\r\n');
  const parsed = parseMultipartRelated(new TextEncoder().encode(body), 'multipart/related; boundary=B; start="<root>"');

  it('replaces xop:Include with the base64 of the referenced part when inlining', () => {
    const expanded = expandMtomResponse(parsed, { inline: true });
    const base64 = Buffer.from('PNGBYTES').toString('base64');
    expect(expanded.envelopeXml).toBe(`<Body><data>${base64}</data></Body>`);
    expect(expanded.inlinedContentIds).toEqual(['img']);
    expect(expanded.attachments).toHaveLength(1);
    expect(expanded.attachments[0]).toMatchObject({ contentId: 'img', contentType: 'image/png', size: 8 });
  });

  it('leaves the include in place when not inlining', () => {
    const expanded = expandMtomResponse(parsed, { inline: false });
    expect(expanded.envelopeXml).toContain('<xop:Include href="cid:img"');
    expect(expanded.inlinedContentIds).toEqual([]);
    expect(expanded.attachments).toHaveLength(1);
  });

  it('leaves an include whose part is missing alone', () => {
    const orphan = parseMultipartRelated(
      new TextEncoder().encode(
        [
          '--B',
          'Content-Type: application/xop+xml',
          '',
          '<a><xop:Include href="cid:gone" xmlns:xop="http://www.w3.org/2004/08/xop/include"/></a>',
          '--B--',
          '',
        ].join('\r\n'),
      ),
      'multipart/related; boundary=B',
    );
    const expanded = expandMtomResponse(orphan, { inline: true });
    expect(expanded.envelopeXml).toContain('xop:Include');
    expect(expanded.inlinedContentIds).toEqual([]);
  });

  it('uses the envelope text the caller decoded, when given one', () => {
    const expanded = expandMtomResponse(parsed, { inline: false, envelopeXml: '<already-decoded/>' });
    expect(expanded.envelopeXml).toBe('<already-decoded/>');
  });
});
