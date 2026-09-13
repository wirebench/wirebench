/**
 * Body encoding. The golden bytes matter: a multipart body with the wrong line endings or a
 * boundary that appears inside a part is a request the far end rejects for reasons no one can see
 * from the UI. The other rules worth holding: `none` sends no bytes at all (not an empty buffer),
 * a file is only ever read through the injected resolver, and a disabled row or part is absent.
 */
import { describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '../../../src/errors.js';
import type { AttachmentSource } from '../../../src/project/model.js';
import { bodyLanguage, encodeFormFields, encodeRestBody, escapeForLanguage } from '../../../src/rest/body.js';
import { entry } from '../../../src/rest/model.js';

const BOUNDARY = '----WirebenchBoundaryFIXED';

/** A resolver that answers with the path or hash it was asked for, and counts its calls. */
function resolver(bytes = 'FILEBYTES') {
  return vi.fn((source: AttachmentSource) =>
    Promise.resolve(new TextEncoder().encode(source.kind === 'path' ? bytes : `cache:${source.sha256}`)),
  );
}

function text(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? '<none>' : Buffer.from(bytes).toString('utf8');
}

describe('encodeRestBody', () => {
  it('gives a none body no bytes and no content type', async () => {
    expect(await encodeRestBody({ kind: 'none' })).toEqual({});
  });

  it('encodes a raw body with the language default content type', async () => {
    const encoded = await encodeRestBody({ kind: 'raw', language: 'json', text: '{"a":1}' });
    expect(text(encoded.bytes)).toBe('{"a":1}');
    expect(encoded.contentType).toBe('application/json');
  });

  it('prefers the body own content type over the language default', async () => {
    const encoded = await encodeRestBody({
      kind: 'raw',
      language: 'json',
      contentType: 'application/merge-patch+json',
      text: '{}',
    });
    expect(encoded.contentType).toBe('application/merge-patch+json');
  });

  it('declares a non-UTF-8 charset and encodes the bytes in it', async () => {
    const encoded = await encodeRestBody({ kind: 'raw', language: 'text', text: 'café' }, { charset: 'ISO-8859-1' });
    expect(encoded.contentType).toBe('text/plain; charset=ISO-8859-1');
    expect([...(encoded.bytes ?? [])]).toEqual([0x63, 0x61, 0x66, 0xe9]);
  });

  it('does not add a charset for UTF-8, nor a second one when the type has it', async () => {
    expect((await encodeRestBody({ kind: 'raw', language: 'text', text: 'a' }, { charset: 'utf-8' })).contentType).toBe(
      'text/plain',
    );
    expect(
      (
        await encodeRestBody(
          { kind: 'raw', language: 'text', contentType: 'text/plain; charset=utf-16', text: 'a' },
          { charset: 'ISO-8859-1' },
        )
      ).contentType,
    ).toBe('text/plain; charset=utf-16');
  });

  it('encodes a form body, skipping a disabled field', async () => {
    const encoded = await encodeRestBody({
      kind: 'form',
      fields: [entry('name', 'a b'), entry('note', 'x&y=z'), entry('off', '1', { enabled: false })],
    });
    expect(text(encoded.bytes)).toBe('name=a+b&note=x%26y%3Dz');
    expect(encoded.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('builds a multipart body with CRLF, a terminator, and one part per enabled row', async () => {
    const resolveFile = resolver();
    const encoded = await encodeRestBody(
      {
        kind: 'multipart',
        parts: [
          { kind: 'text', name: 'caption', value: 'a dog', enabled: true },
          { kind: 'text', name: 'json', value: '{}', enabled: true, contentType: 'application/json' },
          {
            kind: 'file',
            name: 'file',
            source: { kind: 'path', path: '/tmp/dog.png' },
            enabled: true,
            contentType: 'image/png',
          },
          { kind: 'text', name: 'skipped', value: 'no', enabled: false },
        ],
      },
      { resolveFile, boundary: BOUNDARY },
    );

    expect(text(encoded.bytes)).toBe(
      [
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="caption"',
        '',
        'a dog',
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="json"',
        'Content-Type: application/json',
        '',
        '{}',
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="file"; filename="dog.png"',
        'Content-Type: image/png',
        '',
        'FILEBYTES',
        `--${BOUNDARY}--`,
        '',
      ].join('\r\n'),
    );
    expect(encoded.contentType).toBe(`multipart/form-data; boundary=${BOUNDARY}`);
    expect(resolveFile).toHaveBeenCalledTimes(1);
  });

  it('defaults a file part to octet-stream and its own cache name', async () => {
    const encoded = await encodeRestBody(
      {
        kind: 'multipart',
        parts: [{ kind: 'file', name: 'blob', source: { kind: 'cache', sha256: 'abc' }, enabled: true }],
      },
      { resolveFile: resolver(), boundary: BOUNDARY },
    );
    expect(text(encoded.bytes)).toContain('Content-Disposition: form-data; name="blob"; filename="blob"');
    expect(text(encoded.bytes)).toContain('Content-Type: application/octet-stream');
    expect(text(encoded.bytes)).toContain('cache:abc');
  });

  it('strips a quote or newline from a part name rather than breaking the header', async () => {
    const encoded = await encodeRestBody(
      {
        kind: 'multipart',
        parts: [{ kind: 'text', name: 'a"b\r\nContent-Type: evil', value: 'v', enabled: true }],
      },
      { boundary: BOUNDARY },
    );
    expect(text(encoded.bytes)).toContain('name="a_b__Content-Type: evil"');
    expect(
      text(encoded.bytes)
        .split('\r\n')
        .filter((line) => line.startsWith('Content-Type')),
    ).toEqual([]);
  });

  it('generates a random boundary when none is given', async () => {
    const first = await encodeRestBody({ kind: 'multipart', parts: [] });
    const second = await encodeRestBody({ kind: 'multipart', parts: [] });
    expect(first.contentType).not.toBe(second.contentType);
    expect(first.contentType).toMatch(/^multipart\/form-data; boundary=----WirebenchBoundary[0-9a-f]{32}$/);
  });

  it('reads a binary body through the resolver and keeps its declared type', async () => {
    const encoded = await encodeRestBody(
      { kind: 'binary', source: { kind: 'cache', sha256: 'deadbeef' }, contentType: 'application/pdf' },
      { resolveFile: resolver() },
    );
    expect(text(encoded.bytes)).toBe('cache:deadbeef');
    expect(encoded.contentType).toBe('application/pdf');
  });

  it.each([
    [
      'multipart',
      {
        kind: 'multipart' as const,
        parts: [{ kind: 'file' as const, name: 'f', source: { kind: 'path' as const, path: 'x' }, enabled: true }],
      },
    ],
    [
      'binary',
      { kind: 'binary' as const, source: { kind: 'path' as const, path: 'x' }, contentType: 'application/pdf' },
    ],
  ])('refuses a %s body with no resolver instead of sending nothing', async (_label, body) => {
    await expect(encodeRestBody(body)).rejects.toThrow(WirebenchError);
    await expect(encodeRestBody(body)).rejects.toMatchObject({ code: 'rest-file-unresolved' });
  });

  it('aborts between parts when the signal is already aborted', async () => {
    await expect(
      encodeRestBody(
        { kind: 'multipart', parts: [{ kind: 'text', name: 'a', value: 'b', enabled: true }] },
        { signal: AbortSignal.abort(), boundary: BOUNDARY },
      ),
    ).rejects.toThrow();
  });
});

describe('encodeFormFields', () => {
  it('uses + for a space and percent-encodes the rest', () => {
    expect(encodeFormFields([entry('a b', 'c d'), entry('e', 'f+g')])).toBe('a+b=c+d&e=f%2Bg');
  });
});

describe('escapeForLanguage', () => {
  it('escapes a JSON string body without adding quotes', () => {
    expect(escapeForLanguage('a"b\\c\nd', 'json')).toBe('a\\"b\\\\c\\nd');
  });

  it('escapes the five XML entities', () => {
    expect(escapeForLanguage(`<a href="x">&'`, 'xml')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
  });

  it('leaves plain text alone, because there is nothing to escape', () => {
    expect(escapeForLanguage('a<b&c', 'text')).toBe('a<b&c');
  });
});

describe('bodyLanguage', () => {
  it.each([
    [{ kind: 'raw' as const, language: 'xml' as const, text: '' }, 'xml'],
    [{ kind: 'form' as const, fields: [] }, 'form'],
    [{ kind: 'none' as const }, undefined],
  ])('is %s for the body kind', (body, expected) => {
    expect(bodyLanguage(body)).toBe(expected);
  });
});
