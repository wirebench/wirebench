import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Attachment } from '../../src/project/model.js';
import { DEFAULT_REQUEST_PROPERTIES } from '../../src/project/model.js';
import { mergePreferences } from '../../src/project/preferences.js';
import { parseMultipartRelated } from '../../src/soap/mime/multipart.js';
import type { AttachmentResolver } from '../../src/soap/mime/types.js';
import { toSendInput } from '../../src/send-options.js';
import { sendSoapRequest } from '../../src/send.js';
import {
  MIME_FIXTURE_CID,
  MIME_FIXTURE_PNG,
  startTestSoapServer,
  type TestSoapServer,
} from '../helpers/test-soap-server.js';

const PNG = new Uint8Array(64);
for (let i = 0; i < PNG.length; i++) PNG[i] = (i * 7) % 256;
// A payload that contains a CRLF delimiter-looking run, so the round trip proves framing.
const TRICKY = new TextEncoder().encode('first\r\n--boundary-ish--\r\nlast');

const PLAIN_ENVELOPE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ping/></soapenv:Body></soapenv:Envelope>';

const ENVELOPE = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <up:Upload xmlns:up="urn:up"><up:file>cid:A1@wirebench</up:file></up:Upload>
  </soapenv:Body>
</soapenv:Envelope>`;

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'A1',
    name: 'pixel.png',
    contentType: 'image/png',
    size: PNG.length,
    part: 'file',
    type: 'XOP',
    contentId: 'A1@wirebench',
    cached: true,
    source: { kind: 'cache', sha256: 'a'.repeat(64) },
    ...overrides,
  };
}

/** An anonymous attachment: no WSDL part, so it goes out as a plain extra MIME part. */
const ANONYMOUS: Attachment = {
  id: 'A2',
  name: 'tricky.bin',
  contentType: 'application/octet-stream',
  size: TRICKY.length,
  type: 'CONTENT',
  contentId: 'A2@wirebench',
  cached: false,
  source: { kind: 'path', path: 'tricky.bin' },
};

const bytesFor: Readonly<Record<string, Uint8Array>> = { A1: PNG, A2: TRICKY };
const resolver: AttachmentResolver = (a) => Promise.resolve(bytesFor[a.id] ?? new Uint8Array());

function send(
  server: TestSoapServer,
  properties: Partial<typeof DEFAULT_REQUEST_PROPERTIES>,
  attachments: readonly Attachment[],
  extra: { readonly envelopeXml?: string; readonly gzip?: boolean; readonly resourceRoot?: string } = {},
) {
  const input = toSendInput({
    request: {
      properties: { ...DEFAULT_REQUEST_PROPERTIES, ...properties },
      soapVersion: '1.1',
      soapAction: 'urn:Upload',
      headers: [],
      envelopeXml: extra.envelopeXml ?? ENVELOPE,
    },
    endpoint: `${server.url}/mime`,
    attachments,
    attachmentResolvers: {
      resolver,
      resolveFile: (path) => readFile(path).then((buffer) => new Uint8Array(buffer)),
      ...(extra.resourceRoot !== undefined ? { resourceRoot: extra.resourceRoot } : {}),
    },
    ...(extra.gzip === true ? { preferences: mergePreferences({ http: { requestCompression: 'gzip' } }) } : {}),
  });
  return sendSoapRequest(input);
}

describe('MTOM over the wire', () => {
  let server: TestSoapServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('sends an XOP package and gets every part back byte-identically', async () => {
    server = await startTestSoapServer();
    const exchange = await send(server, { enableMtom: true }, [attachment()]);

    const recorded = server.requests.at(-1);
    const requestContentType = String(recorded?.headers['content-type']);
    expect(requestContentType).toContain('multipart/related');
    expect(requestContentType).toContain('type="application/xop+xml"');
    expect(requestContentType).toContain('start-info="text/xml"');
    // SOAP 1.1 still names the operation in its own header.
    expect(recorded?.headers['soapaction']).toBe('"urn:Upload"');

    const sent = parseMultipartRelated(new Uint8Array(recorded?.body ?? Buffer.alloc(0)), requestContentType);
    expect(sent.root.contentType).toContain('application/xop+xml');
    expect(Buffer.from(sent.root.bytes).toString('utf-8')).toContain(
      '<xop:Include href="cid:A1@wirebench" xmlns:xop="http://www.w3.org/2004/08/xop/include"/>',
    );
    expect(sent.parts[0]?.bytes).toEqual(PNG);
    expect(sent.parts[0]?.headers['content-transfer-encoding']).toBe('binary');

    // The echo route sends the same parts back; the send path lists them as attachments.
    expect(exchange.response?.isSoap).toBe(true);
    expect(exchange.response?.envelopeXml).toContain('<part cid="A1@wirebench" size="64"/>');
    expect(exchange.response?.attachments).toHaveLength(1);
    expect(exchange.response?.attachments?.[0]?.bytes).toEqual(PNG);
    expect(exchange.problems).toEqual([]);

    // The Raw views must show the multipart as it travelled, both ways.
    const rawRequest = Buffer.from(exchange.http.rawRequest).toString('latin1');
    expect(rawRequest).toContain('Content-ID: <rootpart@wirebench>');
    expect(rawRequest).toContain('Content-ID: <A1@wirebench>');
    expect(Buffer.from(exchange.http.rawResponse).toString('latin1')).toContain('Content-ID: <A1@wirebench>');
  });

  it('forces an MTOM package even with nothing to optimise', async () => {
    server = await startTestSoapServer();
    await send(server, { forceMtom: true }, [], { envelopeXml: PLAIN_ENVELOPE });

    const recorded = server.requests.at(-1);
    expect(String(recorded?.headers['content-type'])).toContain('type="application/xop+xml"');
    const sent = parseMultipartRelated(
      new Uint8Array(recorded?.body ?? Buffer.alloc(0)),
      String(recorded?.headers['content-type']),
    );
    expect(sent.parts).toEqual([]);
  });

  it('names the SOAP 1.2 action on the root part instead of the multipart type', async () => {
    server = await startTestSoapServer();
    const input = toSendInput({
      request: {
        properties: { ...DEFAULT_REQUEST_PROPERTIES, enableMtom: true },
        soapVersion: '1.2',
        soapAction: 'urn:Upload',
        headers: [],
        envelopeXml: ENVELOPE,
      },
      endpoint: `${server.url}/mime`,
      attachments: [attachment()],
      attachmentResolvers: { resolver },
    });
    await sendSoapRequest(input);

    const recorded = server.requests.at(-1);
    const contentType = String(recorded?.headers['content-type']);
    expect(contentType).toContain('start-info="application/soap+xml"');
    const sent = parseMultipartRelated(new Uint8Array(recorded?.body ?? Buffer.alloc(0)), contentType);
    expect(sent.root.contentType).toBe(
      'application/xop+xml;charset=UTF-8;type="application/soap+xml";action="urn:Upload"',
    );
  });
});

describe('SOAP with Attachments over the wire', () => {
  let server: TestSoapServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('sends plain SwA parts and leaves the envelope untouched', async () => {
    server = await startTestSoapServer();
    const exchange = await send(server, {}, [attachment({ type: 'MIME' }), ANONYMOUS]);

    const recorded = server.requests.at(-1);
    const contentType = String(recorded?.headers['content-type']);
    expect(contentType).toContain('type="text/xml"');
    expect(contentType).not.toContain('start-info');

    const sent = parseMultipartRelated(new Uint8Array(recorded?.body ?? Buffer.alloc(0)), contentType);
    // The swaRef-style reference stays exactly as authored.
    expect(Buffer.from(sent.root.bytes).toString('utf-8')).toContain('<up:file>cid:A1@wirebench</up:file>');
    expect(sent.parts.map((part) => part.contentId)).toEqual(['A1@wirebench', 'A2@wirebench']);
    expect(sent.parts[0]?.headers['content-disposition']).toBe('attachment; name="file"; filename="pixel.png"');
    expect(sent.parts[1]?.headers['content-disposition']).toBe('attachment; filename="tricky.bin"');
    expect(sent.parts[1]?.bytes).toEqual(TRICKY);

    expect(exchange.response?.attachments?.map((a) => a.contentId)).toEqual(['A1@wirebench', 'A2@wirebench']);
    expect(exchange.response?.attachments?.[1]?.bytes).toEqual(TRICKY);
  });

  it('base64-encodes the parts when the request asks it to', async () => {
    server = await startTestSoapServer();
    const exchange = await send(server, { encodeAttachments: true }, [attachment({ type: 'MIME' })]);

    const recorded = server.requests.at(-1);
    const contentType = String(recorded?.headers['content-type']);
    const sent = parseMultipartRelated(new Uint8Array(recorded?.body ?? Buffer.alloc(0)), contentType);
    expect(sent.parts[0]?.transferEncoding).toBe('base64');
    // Decoding the transfer encoding gives the original bytes back, and so does the echo.
    expect(sent.parts[0]?.bytes).toEqual(PNG);
    expect(exchange.response?.attachments?.[0]?.bytes).toEqual(PNG);
  });

  it('sends a plain envelope when multiparts are disabled', async () => {
    server = await startTestSoapServer();
    const exchange = await send(server, { enableMtom: true, disableMultiparts: true }, [attachment()]);

    const recorded = server.requests.at(-1);
    expect(String(recorded?.headers['content-type'])).toBe('text/xml;charset=UTF-8');
    expect(recorded?.body.toString('utf-8')).toBe(ENVELOPE);
    expect(exchange.response?.attachments).toBeUndefined();
  });

  it('compresses the whole multipart body when gzip is enabled', async () => {
    server = await startTestSoapServer();
    await send(server, { enableMtom: true }, [attachment()], { gzip: true });

    const recorded = server.requests.at(-1);
    expect(recorded?.headers['content-encoding']).toBe('gzip');
    // The helper gunzips before recording, so this is the multipart body itself.
    const sent = parseMultipartRelated(
      new Uint8Array(recorded?.body ?? Buffer.alloc(0)),
      String(recorded?.headers['content-type']),
    );
    expect(sent.parts[0]?.bytes).toEqual(PNG);
  });
});

describe('response attachment handling', () => {
  let server: TestSoapServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function fixtureSend(properties: Partial<typeof DEFAULT_REQUEST_PROPERTIES>) {
    const input = toSendInput({
      request: {
        properties: { ...DEFAULT_REQUEST_PROPERTIES, ...properties },
        soapVersion: '1.1',
        headers: [],
        envelopeXml: PLAIN_ENVELOPE,
      },
      endpoint: `${server?.url ?? ''}/mime-fixture`,
      attachmentResolvers: { resolver },
    });
    return sendSoapRequest(input);
  }

  it('lists the XOP part without touching the envelope by default', async () => {
    server = await startTestSoapServer();
    const exchange = await fixtureSend({});

    expect(exchange.response?.envelopeXml).toContain(`<xop:Include href="cid:${MIME_FIXTURE_CID}"`);
    expect(exchange.response?.attachments).toHaveLength(1);
    expect(exchange.response?.attachments?.[0]).toMatchObject({
      contentId: MIME_FIXTURE_CID,
      contentType: 'image/png',
      name: 'pixel.png',
      size: MIME_FIXTURE_PNG.length,
    });
    expect(exchange.response?.attachments?.[0]?.bytes).toEqual(MIME_FIXTURE_PNG);
  });

  it('expands the include into base64 and drops the part from the list', async () => {
    server = await startTestSoapServer();
    const exchange = await fixtureSend({ expandMtomAttachments: true });

    expect(exchange.response?.envelopeXml).not.toContain('xop:Include');
    expect(exchange.response?.envelopeXml).toContain(Buffer.from(MIME_FIXTURE_PNG).toString('base64'));
    expect(exchange.response?.attachments).toEqual([]);
  });

  it('keeps expanded parts listed when inline response attachments is on', async () => {
    server = await startTestSoapServer();
    const exchange = await fixtureSend({ expandMtomAttachments: true, inlineResponseAttachments: true });

    expect(exchange.response?.envelopeXml).not.toContain('xop:Include');
    expect(exchange.response?.attachments).toHaveLength(1);
  });
});

describe('inline files', () => {
  let server: TestSoapServer | undefined;
  let dir: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('substitutes a file: reference resolved against the resource root', async () => {
    server = await startTestSoapServer();
    dir = await mkdtemp(join(tmpdir(), 'wirebench-inline-'));
    await writeFile(join(dir, 'note.txt'), 'inline me');

    const exchange = await send(server, { enableInlineFiles: true }, [], {
      envelopeXml: PLAIN_ENVELOPE.replace('<ping/>', '<doc>file:note.txt</doc>'),
      resourceRoot: dir,
    });

    const recorded = server.requests.at(-1);
    expect(recorded?.body.toString('utf-8')).toBe(
      PLAIN_ENVELOPE.replace('<ping/>', `<doc>${Buffer.from('inline me').toString('base64')}</doc>`),
    );
    expect(exchange.problems).toEqual([]);
  });

  it('reports a missing inline file and sends the reference verbatim', async () => {
    server = await startTestSoapServer();
    const envelope = PLAIN_ENVELOPE.replace('<ping/>', '<doc>file:/nowhere/none.txt</doc>');
    const exchange = await send(server, { enableInlineFiles: true }, [], { envelopeXml: envelope });

    expect(server.requests.at(-1)?.body.toString('utf-8')).toBe(envelope);
    expect(exchange.problems).toHaveLength(1);
    expect(exchange.problems[0]?.code).toBe('inline-file-missing');
    expect(exchange.problems[0]?.message).toContain('/nowhere/none.txt');
  });
});
