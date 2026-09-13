/**
 * A minimal reader for the gzipped ustar archives the npm registry serves, used by
 * `scripts/fixtures-refresh.ts` to lift example documents out of a published package without
 * adding the package (or a tar library) as a dependency.
 *
 * It reads exactly what a registry tarball needs: regular-file entries, the `prefix` field for
 * long paths, and the standard 512-byte blocking. PAX extended headers and directories are walked
 * past, not interpreted, which is enough because npm's own packer keeps every file under the short
 * `package/` prefix.
 */

import { gunzipSync } from 'node:zlib';

/** One regular file from an archive. */
export interface TarEntry {
  /** The full path inside the archive, e.g. `package/3.0/json/petstore.json`. */
  readonly name: string;
  readonly bytes: Uint8Array;
}

const BLOCK = 512;
const REGULAR_FILE = 0x30; // '0'
const REGULAR_FILE_OLD = 0; // '\0', pre-POSIX archives
const latin1 = new TextDecoder('latin1');

/** A NUL-terminated header field as text. */
function field(header: Uint8Array, start: number, length: number): string {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return latin1.decode(end === -1 ? slice : slice.subarray(0, end));
}

/** Every regular file in a plain (uncompressed) tar stream, in archive order. */
export function readTar(tar: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      break; // The end-of-archive marker: two zero blocks, of which one is enough to stop on.
    }
    if (((header[124] ?? 0) & 0x80) !== 0) {
      throw new Error('tar: base-256 sizes are not supported');
    }
    const sizeText = field(header, 124, 12).trim();
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8);
    if (Number.isNaN(size)) {
      throw new Error(`tar: malformed size field at offset ${String(offset)}`);
    }
    const typeflag = header[156] ?? REGULAR_FILE_OLD;
    const prefix = field(header, 345, 155);
    const name = prefix === '' ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`;
    const dataStart = offset + BLOCK;
    if (typeflag === REGULAR_FILE || typeflag === REGULAR_FILE_OLD) {
      entries.push({ name, bytes: tar.slice(dataStart, dataStart + size) });
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/** Every regular file in a gzipped tar (`.tgz`), in archive order. */
export function readTarGz(gzipped: Uint8Array): TarEntry[] {
  return readTar(new Uint8Array(gunzipSync(gzipped)));
}
