import type { Transform } from 'node:stream';
import {
  brotliDecompress,
  constants,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzip,
  inflate,
} from 'node:zlib';

/**
 * Decompresses `data` according to the response's `content-encoding` header
 * (`gzip`, `x-gzip`, `deflate`, or `br`). Returns `data` unchanged for any
 * other/absent encoding. Errors from a malformed compressed body propagate
 * to the caller.
 */
export async function decompressBody(data: Uint8Array, contentEncoding: string | undefined): Promise<Uint8Array> {
  const encoding = contentEncoding?.trim().toLowerCase();
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return new Uint8Array(
        await new Promise<Buffer>((resolve, reject) => gunzip(buf, (err, out) => (err ? reject(err) : resolve(out)))),
      );
    case 'deflate':
      return new Uint8Array(
        await new Promise<Buffer>((resolve, reject) => inflate(buf, (err, out) => (err ? reject(err) : resolve(out)))),
      );
    case 'br':
      return new Uint8Array(
        await new Promise<Buffer>((resolve, reject) =>
          brotliDecompress(buf, (err, out) => (err ? reject(err) : resolve(out))),
        ),
      );
    default:
      return data;
  }
}

/**
 * An incremental decoder for a streamed body with the given `content-encoding`, or `undefined` when
 * the encoding needs none. Sync-flushes, so each chunk's decoded bytes come out as soon as they can
 * rather than waiting for more input, and a stream cut short still yields what it decoded.
 */
export function createDecompressStream(contentEncoding: string | undefined): Transform | undefined {
  const zlibFlush = { flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH };
  switch (contentEncoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip(zlibFlush);
    case 'deflate':
      return createInflate(zlibFlush);
    case 'br':
      return createBrotliDecompress({
        flush: constants.BROTLI_OPERATION_FLUSH,
        finishFlush: constants.BROTLI_OPERATION_FLUSH,
      });
    default:
      return undefined;
  }
}
