import { describe, expect, it } from 'vitest';
import type { Attachment } from '../../../../src/project/model.js';
import { parseMultipartRelated } from '../../../../src/soap/mime/multipart.js';
import { collectResponseAttachments, prepareSwaRequest } from '../../../../src/soap/mime/swa.js';
import type { AttachmentResolver } from '../../../../src/soap/mime/types.js';

const BYTES = new Uint8Array([1, 2, 3, 4]);
const resolver: AttachmentResolver = () => Promise.resolve(BYTES);

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'A1',
    name: 'invoice.pdf',
    contentType: 'application/pdf',
    size: BYTES.length,
    type: 'MIME',
    contentId: 'A1@wirebench',
    cached: false,
    source: { kind: 'path', path: '/tmp/invoice.pdf' },
    ...overrides,
  };
}

/** A swaRef-typed element per WS-I Attachments Profile 1.0: its text is the cid reference. */
const SWAREF_ENVELOPE = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <s:SendRef xmlns:s="urn:s"><s:doc>cid:A1@wirebench</s:doc></s:SendRef>
  </soapenv:Body>
</soapenv:Envelope>`;

describe('prepareSwaRequest', () => {
  it('turns each attachment into a binary part and leaves the envelope alone', async () => {
    const prepared = await prepareSwaRequest(SWAREF_ENVELOPE, [attachment({ type: 'SWAREF', part: 'doc' })], {
      resolver,
      encodeAttachments: false,
    });

    expect(prepared.used).toBe(true);
    expect(prepared.parts).toHaveLength(1);
    expect(prepared.parts[0]).toMatchObject({
      contentId: 'A1@wirebench',
      contentType: 'application/pdf',
      transferEncoding: 'binary',
      fileName: 'invoice.pdf',
      partName: 'doc',
    });
    expect(prepared.parts[0]?.bytes).toEqual(BYTES);
    expect(prepared.referencedContentIds).toEqual(['A1@wirebench']);
  });

  it('uses base64 transfer encoding when the request asks attachments to be encoded', async () => {
    const prepared = await prepareSwaRequest(SWAREF_ENVELOPE, [attachment()], {
      resolver,
      encodeAttachments: true,
    });
    expect(prepared.parts[0]?.transferEncoding).toBe('base64');
  });

  it('accepts anonymous attachments that fill no WSDL part and are referenced by nothing', async () => {
    const prepared = await prepareSwaRequest('<Body/>', [attachment({ type: 'CONTENT' })], {
      resolver,
      encodeAttachments: false,
    });
    expect(prepared.used).toBe(true);
    expect(prepared.parts[0]?.partName).toBeUndefined();
    expect(prepared.referencedContentIds).toEqual([]);
  });

  it('sends nothing when multiparts are disabled', async () => {
    const prepared = await prepareSwaRequest(SWAREF_ENVELOPE, [attachment()], {
      resolver,
      encodeAttachments: false,
      disableMultiparts: true,
    });
    expect(prepared.used).toBe(false);
    expect(prepared.parts).toEqual([]);
  });

  it('is a no-op without attachments', async () => {
    const prepared = await prepareSwaRequest('<Body/>', [], { resolver, encodeAttachments: false });
    expect(prepared.used).toBe(false);
    expect(prepared.parts).toEqual([]);
  });

  it('falls back to the attachment name for the Content-ID when it has none', async () => {
    const prepared = await prepareSwaRequest('<Body/>', [attachment({ contentId: '' })], {
      resolver,
      encodeAttachments: false,
    });
    expect(prepared.parts[0]?.contentId).toBe('A1@wirebench');
  });
});

describe('collectResponseAttachments', () => {
  it('describes every non-root part', () => {
    const body = [
      '--B',
      'Content-Type: text/xml',
      'Content-ID: <root>',
      '',
      '<Envelope/>',
      '--B',
      'Content-Type: application/pdf',
      'Content-ID: <doc@x>',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="invoice.pdf"',
      '',
      Buffer.from(BYTES).toString('base64'),
      '--B',
      'Content-Type: text/plain',
      '',
      'anonymous',
      '--B--',
      '',
    ].join('\r\n');
    const parsed = parseMultipartRelated(
      new TextEncoder().encode(body),
      'multipart/related; boundary=B; start="<root>"',
    );

    const attachments = collectResponseAttachments(parsed);
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      contentId: 'doc@x',
      contentType: 'application/pdf',
      size: 4,
      name: 'invoice.pdf',
      transferEncoding: 'base64',
    });
    expect(attachments[0]?.bytes).toEqual(BYTES);
    expect(attachments[1]).toMatchObject({ contentId: '', contentType: 'text/plain', size: 9 });
  });
});
