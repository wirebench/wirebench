/**
 * A small ustar writer and reader over `node:zlib` (hosted edition spec §22.9): a tenant's export is one
 * `.tar.gz`, and no dependency is taken for it. Both sides stream: the writer takes each entry's bytes from a buffer
 * or a file and never holds a whole archive, and the reader hands out each entry's body as it reads it.
 *
 * - **Names** up to 100 bytes go in the header; a longer one is written as a PAX `path` record before it, and read
 *   back from a PAX record or a GNU long-name entry. A size past the header's 11 octal digits goes in a PAX `size`
 *   record the same way.
 * - **What the reader refuses** (`export-archive-invalid`): an absolute name, a `..` segment, a backslash or a NUL,
 *   a symbolic or hard link, a device or FIFO, a bad header checksum, and an archive that ends inside an entry. An
 *   import only ever reads regular files out of an archive, so nothing else is needed, and nothing it names can
 *   point outside the directory it is unpacked into.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { WirebenchError } from '@wirebench/engine';

const BLOCK = 512;
const NAME_BYTES = 100;
/** The largest size the header's 11 octal digits hold. */
const MAX_OCTAL_SIZE = 8 ** 11 - 1;
/** How much of an entry's body the reader hands out at a time. */
const CHUNK = 64 * 1024;
/** The most an extended header (a PAX record set or a long name) may hold. */
const MAX_EXTENDED = 1024 * 1024;

const invalid = (why: string): WirebenchError =>
  new WirebenchError('export-archive-invalid', `the export archive is not valid: ${why}`);

/** One entry to write: its bytes, or a file's, which must keep its size while it is read. */
export type TarSource =
  { readonly name: string; readonly data: Buffer } | { readonly name: string; readonly path: string };

/**
 * `name` as an archive may hold it: relative, `/`-separated, no `..` or empty segment, no backslash, no NUL.
 *
 * @throws WirebenchError `export-archive-invalid` otherwise
 */
export function checkEntryName(name: string): string {
  if (name.length === 0) throw invalid('an entry has no name');
  if (name.includes('\0')) throw invalid('an entry name holds a NUL');
  if (name.includes('\\')) throw invalid('an entry name holds a backslash');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw invalid('an entry name is absolute');
  const segments = name.replace(/\/+$/, '').split('/');
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) {
    throw invalid('an entry name leaves its directory or has an empty segment');
  }
  return name;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** One PAX record, `<len> <key>=<value>\n`, where `len` counts the whole record, its own digits included. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  let length = bodyBytes + 1;
  while (String(length).length + bodyBytes !== length) length = String(length).length + bodyBytes;
  return Buffer.from(`${String(length)}${body}`, 'utf8');
}

function header(name: string, size: number, type: string, mtime: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, NAME_BYTES, 'utf8');
  block.write(octal(0o644, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(mtime, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

const padding = (size: number): Buffer => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** The headers of one entry: a PAX header first when its name or size does not fit. */
function headersOf(name: string, size: number, mtime: number): Buffer[] {
  const records: Buffer[] = [];
  if (Buffer.byteLength(name, 'utf8') > NAME_BYTES) records.push(paxRecord('path', name));
  if (size > MAX_OCTAL_SIZE) records.push(paxRecord('size', String(size)));
  const out: Buffer[] = [];
  if (records.length > 0) {
    const pax = Buffer.concat(records);
    out.push(header('PaxHeader', pax.length, 'x', mtime), pax, padding(pax.length));
  }
  // The header's own name field: the start of the name, cut at a character, when the PAX record holds the whole.
  let short = name;
  while (Buffer.byteLength(short, 'utf8') > NAME_BYTES) short = short.slice(0, -1);
  out.push(header(short, size > MAX_OCTAL_SIZE ? 0 : size, '0', mtime));
  return out;
}

/** The archive's bytes, entry by entry, then the two zero blocks that end it. */
async function* tarBytes(
  sources: AsyncIterable<TarSource> | Iterable<TarSource>,
  mtime: number,
): AsyncGenerator<Buffer> {
  for await (const source of sources) {
    const name = checkEntryName(source.name);
    if ('data' in source) {
      yield* headersOf(name, source.data.length, mtime);
      yield source.data;
      yield padding(source.data.length);
      continue;
    }
    const size = (await stat(source.path)).size;
    yield* headersOf(name, size, mtime);
    let written = 0;
    for await (const chunk of createReadStream(source.path)) {
      const bytes = chunk as Buffer;
      written += bytes.length;
      if (written > size) throw invalid(`${name} grew while it was written`);
      yield bytes;
    }
    if (written !== size) throw invalid(`${name} shrank while it was written`);
    yield padding(size);
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Writes `sources`, in order, as a gzipped tar at `path`, which it creates (mode 0600) or truncates. */
export async function writeTarGz(
  path: string,
  sources: AsyncIterable<TarSource> | Iterable<TarSource>,
  options: { readonly mtime?: Date } = {},
): Promise<void> {
  const mtime = Math.floor((options.mtime ?? new Date()).getTime() / 1000);
  await pipeline(Readable.from(tarBytes(sources, mtime)), createGzip(), createWriteStream(path, { mode: 0o600 }));
}

/** One entry of an archive being read. Its body must be read, or left, before the next entry is asked for. */
export interface TarEntry {
  readonly name: string;
  readonly size: number;
  /** The body, in chunks; read at most once. */
  chunks(): AsyncGenerator<Buffer>;
  /** The whole body, for a small entry. */
  buffer(): Promise<Buffer>;
}

/** Exact reads over an async source of chunks. */
class Bytes {
  readonly #source: AsyncIterator<Buffer>;
  #held: Buffer = Buffer.alloc(0);
  #done = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.#source = source[Symbol.asyncIterator]();
  }

  /** Up to `n` bytes, fewer only at the end; an empty buffer once the source is spent. */
  async upTo(n: number): Promise<Buffer> {
    while (this.#held.length < n && !this.#done) {
      const next = await this.#source.next();
      if (next.done === true) this.#done = true;
      else this.#held = this.#held.length === 0 ? next.value : Buffer.concat([this.#held, next.value]);
    }
    const out = this.#held.subarray(0, n);
    this.#held = this.#held.subarray(out.length);
    return out;
  }

  /** Exactly `n` bytes. */
  async exactly(n: number): Promise<Buffer> {
    const out = await this.upTo(n);
    if (out.length !== n) throw invalid('it ends inside an entry');
    return out;
  }

  /** Reads and drops `n` bytes. */
  async skip(n: number): Promise<void> {
    for (let left = n; left > 0;) left -= (await this.exactly(Math.min(left, CHUNK))).length;
  }
}

function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function parseOctal(block: Buffer, offset: number, length: number): number {
  const text = field(block, offset, length).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw invalid('a header holds a number that is not octal');
  return Number.parseInt(text, 8);
}

function checksumValid(block: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
  return parseOctal(block, 148, 8) === sum;
}

function parsePax(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) throw invalid('a PAX record is malformed');
    const length = Number(body.subarray(at, space).toString('ascii'));
    if (!Number.isInteger(length) || length <= 0 || at + length > body.length) {
      throw invalid('a PAX record is malformed');
    }
    const record = body.subarray(space + 1, at + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals === -1) throw invalid('a PAX record is malformed');
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
}

/**
 * Every regular file of the tar read from `source`, in archive order. Directories are passed over; anything else
 * that is not a regular file is refused.
 *
 * @throws WirebenchError `export-archive-invalid`
 */
export async function* readTar(source: AsyncIterable<Buffer>): AsyncGenerator<TarEntry> {
  const bytes = new Bytes(source);
  let longName: string | undefined;
  let pax = new Map<string, string>();
  for (;;) {
    const block = await bytes.upTo(BLOCK);
    if (block.length === 0) return;
    if (block.length < BLOCK) throw invalid('it ends inside a header');
    if (block.every((byte) => byte === 0)) return;
    if (!checksumValid(block)) throw invalid('a header checksum does not match');
    const type = String.fromCharCode(block[156]!);
    const prefix = field(block, 345, 155);
    const headerName = prefix === '' ? field(block, 0, NAME_BYTES) : `${prefix}/${field(block, 0, NAME_BYTES)}`;
    const paxSize = pax.get('size');
    const size = paxSize !== undefined ? Number(paxSize) : parseOctal(block, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw invalid('an entry size is not valid');
    if (type === 'x' || type === 'g' || type === 'L') {
      if (size > MAX_EXTENDED) throw invalid('an extended header is too large');
      const body = await bytes.exactly(size);
      await bytes.skip(padding(size).length);
      if (type === 'x') pax = parsePax(body);
      else if (type === 'L') longName = field(body, 0, body.length);
      continue;
    }
    const name = checkEntryName(pax.get('path') ?? longName ?? headerName);
    pax = new Map();
    longName = undefined;
    if (type === '1' || type === '2') throw invalid(`${name} is a link`);
    if (type === '5') {
      await bytes.skip(size + padding(size).length);
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') throw invalid(`${name} is not a regular file`);
    let left = size;
    let started = false;
    const chunks = async function* (): AsyncGenerator<Buffer> {
      if (started) throw invalid(`${name} was read twice`);
      started = true;
      while (left > 0) {
        const read = await bytes.exactly(Math.min(left, CHUNK));
        left -= read.length;
        yield read;
      }
    };
    yield {
      name,
      size,
      chunks,
      buffer: async () => {
        const parts: Buffer[] = [];
        for await (const chunk of chunks()) parts.push(chunk);
        return Buffer.concat(parts);
      },
    };
    // Whatever the caller left of the body, then the padding.
    await bytes.skip(left);
    left = 0;
    await bytes.skip(padding(size).length);
  }
}

/** {@link readTar} over the gzipped file at `path`. */
export function readTarGz(path: string): AsyncGenerator<TarEntry> {
  return readTar(createReadStream(path).pipe(createGunzip()) as AsyncIterable<Buffer>);
}
