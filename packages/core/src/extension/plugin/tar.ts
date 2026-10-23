/**
 * A strict reader for a plugin's `.tgz` (phase 7 spec §6). It knows regular files and directories
 * and nothing else: a symlink, a hard link, a device or a FIFO refuses the archive, as does an
 * absolute name, a name with `..`, more than {@link TAR_LIMITS}`.files` files or more than
 * `bytes` unpacked. It reads into memory; nothing is written.
 */
import { gunzipSync } from 'node:zlib';

export const TAR_LIMITS = { files: 16, bytes: 64 * 1024 * 1024 } as const;

const BLOCK = 512;

export class TarError extends Error {}

function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function octal(header: Buffer, offset: number, length: number): number {
  const text = field(header, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError('the archive has a malformed header');
  return Number.parseInt(text, 8);
}

/** `path=` from a pax extended header's records. */
function paxPath(body: Buffer): string | undefined {
  let at = 0;
  let path: string | undefined;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number.parseInt(body.subarray(at, space).toString('utf8'), 10);
    if (!Number.isFinite(length) || length <= 0) throw new TarError('the archive has a malformed pax header');
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq !== -1 && record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    at += length;
  }
  return path;
}

/** A name made safe, or a refusal: relative, `/`-separated, no `.` or `..` segment. */
function safeName(name: string): string {
  const trimmed = name.replace(/^\.\//, '').replace(/\/+$/, '');
  if (trimmed === '' || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed) || trimmed.includes('\\')) {
    throw new TarError(`the archive holds a name it may not: "${name}"`);
  }
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new TarError(`the archive holds a name it may not: "${name}"`);
    }
  }
  return trimmed;
}

/** The regular files in a gzipped tar, by name. @throws TarError */
export function readTgz(gzipped: Buffer): ReadonlyMap<string, Buffer> {
  let tar: Buffer;
  try {
    tar = gunzipSync(gzipped, { maxOutputLength: TAR_LIMITS.bytes });
  } catch (error) {
    throw new TarError(
      error instanceof RangeError ? 'the archive unpacks to more than 64 MiB' : 'the file is not a gzipped tar archive',
    );
  }
  const files = new Map<string, Buffer>();
  let at = 0;
  let longName: string | undefined;
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = tar.subarray(at + BLOCK, at + BLOCK + size);
    if (body.length !== size) throw new TarError('the archive is cut short');
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x' || type === 'L') {
      longName = type === 'x' ? paxPath(body) : body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'g') continue;
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix !== '' ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type === '5') {
      safeName(name);
      continue;
    }
    if (type !== '0' && type !== '\0') {
      throw new TarError(`the archive holds "${name}", which is not a regular file`);
    }
    const safe = safeName(name);
    if (files.has(safe)) throw new TarError(`the archive holds "${safe}" twice`);
    files.set(safe, Buffer.from(body));
    if (files.size > TAR_LIMITS.files)
      throw new TarError(`the archive holds more than ${String(TAR_LIMITS.files)} files`);
  }
  return files;
}
