import { describe, expect, it } from 'vitest';
import { buildMultipartRelated, parseMultipartRelated } from '../../../../src/soap/mime/multipart.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf-8');

const ROOT = { contentType: 'text/xml; charset=UTF-8', contentId: 'root@wirebench', bytes: utf8('<Envelope/>') };

describe('buildMultipartRelated', () => {
  it('writes CRLF-delimited parts with a computed Content-Type', () => {
    const built = buildMultipartRelated({
      root: ROOT,
      parts: [{ contentId: 'a@wirebench', contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
      boundary: 'BOUND',
    });

    expect(built.contentType).toBe('multipart/related; type="text/xml"; start="<root@wirebench>"; boundary="BOUND"');
    const body = text(built.body);
    expect(body.startsWith('--BOUND\r\n')).toBe(true);
    expect(body).toContain('Content-Type: text/xml; charset=UTF-8\r\n');
    expect(body).toContain('Content-ID: <root@wirebench>\r\n');
    expect(body).toContain('Content-ID: <a@wirebench>\r\n');
    expect(body.endsWith('--BOUND--\r\n')).toBe(true);
    expect(body).not.toContain('\n\n');
  });

  it('marks an MTOM package with an xop type and start-info', () => {
    const built = buildMultipartRelated({
      root: { ...ROOT, contentType: 'application/xop+xml; charset=UTF-8; type="text/xml"' },
      parts: [],
      boundary: 'B',
      mtom: true,
    });
    expect(built.contentType).toBe(
      'multipart/related; type="application/xop+xml"; start="<root@wirebench>"; boundary="B"; start-info="text/xml"',
    );
  });

  it('writes a Content-Disposition when a file or part name is known', () => {
    const built = buildMultipartRelated({
      root: ROOT,
      parts: [
        {
          contentId: 'a',
          contentType: 'application/octet-stream',
          bytes: utf8('x'),
          fileName: 'in voice.pdf',
          partName: 'file',
        },
      ],
      boundary: 'B',
    });
    expect(text(built.body)).toContain('Content-Disposition: attachment; name="file"; filename="in voice.pdf"\r\n');
  });

  it('picks a boundary that does not occur in any part', () => {
    const collide = utf8('\r\n--BOUND\r\nnot a real delimiter');
    const built = buildMultipartRelated({
      root: ROOT,
      parts: [{ contentId: 'a', contentType: 'application/octet-stream', bytes: collide }],
      boundary: 'BOUND',
    });
    expect(built.boundary).not.toBe('BOUND');
    const parsed = parseMultipartRelated(built.body, built.contentType);
    expect(parsed.problems).toEqual([]);
    expect(parsed.parts[0]?.bytes).toEqual(collide);
  });
});

describe('parseMultipartRelated round trip', () => {
  it('round-trips binary parts byte-identically, including CRLF and delimiter-like runs', () => {
    const binary = new Uint8Array(512);
    for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
    const tricky = utf8('line\r\n--nearly--\r\n');

    const built = buildMultipartRelated({
      root: ROOT,
      parts: [
        { contentId: 'bin@x', contentType: 'application/octet-stream', bytes: binary, transferEncoding: 'binary' },
        { contentId: 'txt@x', contentType: 'text/plain', bytes: tricky, transferEncoding: 'binary' },
      ],
    });

    const parsed = parseMultipartRelated(built.body, built.contentType);
    expect(parsed.problems).toEqual([]);
    expect(parsed.root.contentId).toBe('root@wirebench');
    expect(text(parsed.root.bytes)).toBe('<Envelope/>');
    expect(parsed.parts.map((p) => p.contentId)).toEqual(['bin@x', 'txt@x']);
    expect(parsed.parts[0]?.bytes).toEqual(binary);
    expect(parsed.parts[1]?.bytes).toEqual(tricky);
    expect(parsed.parts[0]?.contentType).toBe('application/octet-stream');
  });

  it('decodes base64 transfer encoding back to the original bytes', () => {
    const binary = new Uint8Array(300).fill(0xab);
    const built = buildMultipartRelated({
      root: ROOT,
      parts: [{ contentId: 'b64', contentType: 'image/png', bytes: binary, transferEncoding: 'base64' }],
      boundary: 'B',
    });
    expect(text(built.body)).toContain('Content-Transfer-Encoding: base64\r\n');
    const parsed = parseMultipartRelated(built.body, built.contentType);
    expect(parsed.parts[0]?.transferEncoding).toBe('base64');
    expect(parsed.parts[0]?.bytes).toEqual(binary);
    // The raw bytes stay as they were on the wire.
    expect(parsed.parts[0]?.raw).not.toEqual(binary);
  });
});

describe('parseMultipartRelated tolerance', () => {
  const lfOnly = [
    '--B',
    'Content-Type: text/xml',
    'Content-ID: <root>',
    '',
    '<Envelope/>',
    '--B',
    'content-type: text/plain',
    'CONTENT-ID: <a>',
    '',
    'hello',
    '--B--',
    '',
  ].join('\n');

  it('accepts LF-only bodies, unquoted boundaries and case-insensitive header names', () => {
    const parsed = parseMultipartRelated(utf8(lfOnly), 'multipart/related; boundary=B; start="<root>"');
    expect(parsed.problems).toEqual([]);
    expect(text(parsed.root.bytes)).toBe('<Envelope/>');
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0]?.contentId).toBe('a');
    expect(parsed.parts[0]?.contentType).toBe('text/plain');
    expect(text(parsed.parts[0]?.bytes ?? new Uint8Array())).toBe('hello');
    expect(parsed.parts[0]?.headers['content-id']).toBe('<a>');
  });

  it('treats the first part as the root when no start parameter is given', () => {
    const parsed = parseMultipartRelated(utf8(lfOnly), 'multipart/related; boundary=B');
    expect(text(parsed.root.bytes)).toBe('<Envelope/>');
    expect(parsed.parts).toHaveLength(1);
  });

  it('reports a start parameter that matches no part and falls back to the first', () => {
    const parsed = parseMultipartRelated(utf8(lfOnly), 'multipart/related; boundary=B; start="<nope>"');
    expect(parsed.problems).toContain('start-part-not-found');
    expect(text(parsed.root.bytes)).toBe('<Envelope/>');
  });

  it('recovers from a missing final boundary', () => {
    const truncated = lfOnly.replace('--B--\n', '');
    const parsed = parseMultipartRelated(utf8(truncated), 'multipart/related; boundary=B');
    expect(parsed.problems).toContain('missing-final-boundary');
    expect(text(parsed.parts[0]?.bytes ?? new Uint8Array())).toBe('hello');
  });

  it('unfolds continuation lines in headers', () => {
    const folded = ['--B', 'Content-Type: text/xml;', '\tcharset=UTF-8', '', '<x/>', '--B--', ''].join('\r\n');
    const parsed = parseMultipartRelated(utf8(folded), 'multipart/related; boundary="B"');
    expect(parsed.root.contentType).toBe('text/xml; charset=UTF-8');
  });

  it('reports a content type without a boundary and returns the whole body as the root', () => {
    const parsed = parseMultipartRelated(utf8('<Envelope/>'), 'multipart/related');
    expect(parsed.problems).toContain('missing-boundary');
    expect(text(parsed.root.bytes)).toBe('<Envelope/>');
    expect(parsed.parts).toEqual([]);
  });

  it('reports a body with no parts at all', () => {
    const parsed = parseMultipartRelated(utf8('nothing here'), 'multipart/related; boundary=B');
    expect(parsed.problems).toContain('no-parts');
  });

  it('skips a preamble and an epilogue', () => {
    const withPreamble = `This is a MIME message.\r\n${['--B', 'Content-Type: text/xml', '', '<x/>', '--B--', 'epilogue', ''].join('\r\n')}`;
    const parsed = parseMultipartRelated(utf8(withPreamble), 'multipart/related; boundary=B');
    expect(parsed.problems).toEqual([]);
    expect(text(parsed.root.bytes)).toBe('<x/>');
  });

  it('decodes quoted-printable parts', () => {
    const qp = ['--B', 'Content-Type: text/plain', '', 'a=3Db=\r\nc', '--B--', ''].join('\r\n');
    const parsed = parseMultipartRelated(utf8(qp), 'multipart/related; boundary=B');
    expect(text(parsed.root.bytes)).toBe('a=3Db=\r\nc');
    const qpEncoded = [
      '--B',
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'a=3Db=\r\nc',
      '--B--',
      '',
    ].join('\r\n');
    const decoded = parseMultipartRelated(utf8(qpEncoded), 'multipart/related; boundary=B');
    expect(text(decoded.root.bytes)).toBe('a=bc');
  });

  it('reads a file name out of Content-Disposition', () => {
    const withDisposition = [
      '--B',
      'Content-Type: text/xml',
      '',
      '<x/>',
      '--B',
      'Content-Type: application/pdf',
      'Content-ID: <f>',
      'Content-Disposition: attachment; name="file"; filename="invoice.pdf"',
      '',
      'PDF',
      '--B--',
      '',
    ].join('\r\n');
    const parsed = parseMultipartRelated(utf8(withDisposition), 'multipart/related; boundary=B');
    expect(parsed.parts[0]?.fileName).toBe('invoice.pdf');
    expect(parsed.parts[0]?.partName).toBe('file');
  });
  it('ignores a header line with no colon and boundary text that is not at a line start', () => {
    const body = [
      '--B',
      'Content-Type: text/xml',
      'this line is not a header',
      '',
      'prefix --B still inside the part',
      '--B  	',
      'Content-Type: text/plain',
      '',
      'second',
      '--B--',
      '',
    ].join('\r\n');
    const parsed = parseMultipartRelated(utf8(body), 'multipart/related; boundary=B');
    expect(parsed.problems).toEqual([]);
    expect(parsed.root.headers).toEqual({ 'content-type': 'text/xml' });
    expect(text(parsed.root.bytes)).toBe('prefix --B still inside the part');
    // Transport padding after the delimiter is skipped, so the second part still parses.
    expect(text(parsed.parts[0]?.bytes ?? new Uint8Array())).toBe('second');
  });
});
