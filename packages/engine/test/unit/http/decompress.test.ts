import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decompressBody } from '../../../src/http/decompress.js';

describe('decompressBody', () => {
  const plaintext = new TextEncoder().encode('hello world');

  it('decompresses gzip', async () => {
    const out = await decompressBody(new Uint8Array(gzipSync(plaintext)), 'gzip');
    expect(Buffer.from(out).toString('utf-8')).toBe('hello world');
  });

  it('decompresses x-gzip', async () => {
    const out = await decompressBody(new Uint8Array(gzipSync(plaintext)), 'x-gzip');
    expect(Buffer.from(out).toString('utf-8')).toBe('hello world');
  });

  it('decompresses deflate', async () => {
    const out = await decompressBody(new Uint8Array(deflateSync(plaintext)), 'deflate');
    expect(Buffer.from(out).toString('utf-8')).toBe('hello world');
  });

  it('decompresses br', async () => {
    const out = await decompressBody(new Uint8Array(brotliCompressSync(plaintext)), 'br');
    expect(Buffer.from(out).toString('utf-8')).toBe('hello world');
  });

  it('returns the input unchanged for an unrecognized encoding', async () => {
    const out = await decompressBody(plaintext, 'identity');
    expect(out).toBe(plaintext);
  });

  it('returns the input unchanged when no encoding is given', async () => {
    const out = await decompressBody(plaintext, undefined);
    expect(out).toBe(plaintext);
  });
});
