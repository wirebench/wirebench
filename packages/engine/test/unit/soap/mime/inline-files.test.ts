import { describe, expect, it } from 'vitest';
import { inlineFiles } from '../../../../src/soap/mime/inline-files.js';

const CONTENT = new TextEncoder().encode('hello attachment');
const BASE64 = Buffer.from(CONTENT).toString('base64');

function resolverFor(known: Readonly<Record<string, Uint8Array>>): (path: string) => Promise<Uint8Array> {
  return (path) => {
    const bytes = known[path];
    return bytes === undefined ? Promise.reject(new Error(`ENOENT: ${path}`)) : Promise.resolve(bytes);
  };
}

describe('inlineFiles', () => {
  it('does nothing when the feature is off', async () => {
    const envelope = '<Body><data>file:/tmp/a.txt</data></Body>';
    const result = await inlineFiles(envelope, {
      enabled: false,
      resolveFile: resolverFor({ '/tmp/a.txt': CONTENT }),
    });
    expect(result.envelopeXml).toBe(envelope);
    expect(result.inlined).toBe(0);
    expect(result.problems).toEqual([]);
  });

  it('replaces an absolute file: reference with the file base64', async () => {
    const result = await inlineFiles('<Body><data>file:/tmp/a.txt</data></Body>', {
      enabled: true,
      resolveFile: resolverFor({ '/tmp/a.txt': CONTENT }),
    });
    expect(result.envelopeXml).toBe(`<Body><data>${BASE64}</data></Body>`);
    expect(result.inlined).toBe(1);
  });

  it('resolves a relative reference against the resource root', async () => {
    const result = await inlineFiles('<Body><data>file:docs/a.txt</data></Body>', {
      enabled: true,
      resourceRoot: '/projects/demo/res',
      resolveFile: resolverFor({ '/projects/demo/res/docs/a.txt': CONTENT }),
    });
    expect(result.envelopeXml).toContain(BASE64);
    expect(result.problems).toEqual([]);
  });

  it('falls back to the path as given when the resource root has no such file', async () => {
    const result = await inlineFiles('<Body><data>file:docs/a.txt</data></Body>', {
      enabled: true,
      resourceRoot: '/projects/demo/res',
      resolveFile: resolverFor({ 'docs/a.txt': CONTENT }),
    });
    expect(result.inlined).toBe(1);
  });

  it('accepts a file:// URL form', async () => {
    const result = await inlineFiles('<Body><data>file:///tmp/a.txt</data></Body>', {
      enabled: true,
      resolveFile: resolverFor({ '/tmp/a.txt': CONTENT }),
    });
    expect(result.inlined).toBe(1);
  });

  it('reports a missing file and leaves the reference in place', async () => {
    const envelope = '<Body><data>file:/tmp/gone.txt</data></Body>';
    const result = await inlineFiles(envelope, { enabled: true, resolveFile: resolverFor({}) });
    expect(result.envelopeXml).toBe(envelope);
    expect(result.inlined).toBe(0);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.code).toBe('inline-file-missing');
    expect(result.problems[0]?.path).toBe('/tmp/gone.txt');
    expect(result.problems[0]?.message).toContain('/tmp/gone.txt');
  });

  it('ignores text that merely mentions a file: reference', async () => {
    const envelope = '<Body><data>see file:/tmp/a.txt for details</data></Body>';
    const result = await inlineFiles(envelope, {
      enabled: true,
      resolveFile: resolverFor({ '/tmp/a.txt': CONTENT }),
    });
    expect(result.envelopeXml).toBe(envelope);
  });

  it('leaves an envelope it cannot scan alone', async () => {
    const envelope = '<Body><data>file:/tmp/a.txt</Body>';
    const result = await inlineFiles(envelope, {
      enabled: true,
      resolveFile: resolverFor({ '/tmp/a.txt': CONTENT }),
    });
    expect(result.envelopeXml).toBe(envelope);
    expect(result.inlined).toBe(0);
  });

  it('inlines a file: reference whose path contains a space', async () => {
    const result = await inlineFiles('<Body><data>file:My Documents/a.txt</data></Body>', {
      enabled: true,
      resolveFile: resolverFor({ 'My Documents/a.txt': CONTENT }),
    });
    expect(result.envelopeXml).toBe(`<Body><data>${BASE64}</data></Body>`);
    expect(result.inlined).toBe(1);
    expect(result.problems).toEqual([]);
  });

  it('inlines several references in one pass', async () => {
    const result = await inlineFiles('<Body><a>file:/tmp/a.txt</a><b>file:/tmp/b.txt</b></Body>', {
      enabled: true,
      resolveFile: resolverFor({ '/tmp/a.txt': CONTENT, '/tmp/b.txt': CONTENT }),
    });
    expect(result.inlined).toBe(2);
    expect(result.envelopeXml).toBe(`<Body><a>${BASE64}</a><b>${BASE64}</b></Body>`);
  });
});
