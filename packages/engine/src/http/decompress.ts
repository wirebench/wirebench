import { brotliDecompress, gunzip, inflate } from 'node:zlib';

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
