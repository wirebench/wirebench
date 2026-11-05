/**
 * Slice 7 Task 19 (hosted edition spec §22.9): the export's ustar writer and reader. A round trip keeps every name,
 * the long ones too (PAX), and every byte; the reader also takes a GNU long name; and it refuses what an import must
 * never unpack: an absolute name, a `..`, a link, a bad checksum, an archive cut short.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEntryName, readTar, readTarGz, writeTarGz } from '../../../src/control-plane/export/tar.js';

/** A raw ustar header, as another writer would make it, for the reader's refusals. */
function rawHeader(name: string, size: number, type: string, options: { readonly badSum?: boolean } = {}): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar  \0', 257, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${(sum + (options.badSum === true ? 1 : 0)).toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

const pad = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);
const end = Buffer.alloc(1024);

/** `buffer` in odd chunks, so the reader's buffering is exercised. */
function once(buffer: Buffer): AsyncIterable<Buffer> {
  const chunks: Buffer[] = [];
  for (let at = 0; at < buffer.length; at += 777) chunks.push(buffer.subarray(at, at + 777));
  return Readable.from(chunks) as AsyncIterable<Buffer>;
}

async function namesOf(buffer: Buffer): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of readTar(once(buffer))) names.push(entry.name);
  return names;
}

describe('the export tar (spec §22.9)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wbs-tar-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips buffers and files, long names included, byte for byte', async () => {
    const long = `repos/${'x'.repeat(140)}/${'é'.repeat(60)}.bundle`;
    const big = randomBytes(200_000);
    const file = join(dir, 'big.bin');
    await writeFile(file, big);
    const archive = join(dir, 'out.tar.gz');
    await writeTarGz(archive, [
      { name: 'manifest.json', data: Buffer.from('{"format":1}') },
      { name: 'tables/empty.ndjson', data: Buffer.alloc(0) },
      { name: long, path: file },
      { name: 'tables/exact.ndjson', data: Buffer.alloc(512, 1) },
    ]);
    const read: { name: string; data: Buffer }[] = [];
    for await (const entry of readTarGz(archive)) read.push({ name: entry.name, data: await entry.buffer() });
    expect(read.map((entry) => entry.name)).toEqual([
      'manifest.json',
      'tables/empty.ndjson',
      long,
      'tables/exact.ndjson',
    ]);
    expect(read[0]!.data.toString()).toBe('{"format":1}');
    expect(read[1]!.data.length).toBe(0);
    expect(read[2]!.data.equals(big)).toBe(true);
    expect(read[3]!.data.equals(Buffer.alloc(512, 1))).toBe(true);
  });

  it('skips a body the caller leaves unread', async () => {
    const archive = join(dir, 'out.tar.gz');
    await writeTarGz(archive, [
      { name: 'a', data: randomBytes(70_000) },
      { name: 'b', data: Buffer.from('second') },
    ]);
    const seen: string[] = [];
    for await (const entry of readTarGz(archive)) {
      if (entry.name === 'b') seen.push((await entry.buffer()).toString());
      else seen.push(entry.name);
    }
    expect(seen).toEqual(['a', 'second']);
  });

  it('reads a GNU long name and passes over directories', async () => {
    const long = `tables/${'y'.repeat(150)}.ndjson`;
    const nameBody = Buffer.from(`${long}\0`);
    const tar = Buffer.concat([
      rawHeader('tables/', 0, '5'),
      rawHeader('././@LongLink', nameBody.length, 'L'),
      nameBody,
      pad(nameBody.length),
      rawHeader(long.slice(0, 100), 3, '0'),
      Buffer.from('abc'),
      pad(3),
      end,
    ]);
    const entries: string[] = [];
    for await (const entry of readTar(once(tar))) entries.push(`${entry.name}=${(await entry.buffer()).toString()}`);
    expect(entries).toEqual([`${long}=abc`]);
  });

  it.each([
    ['an absolute name', rawHeader('/etc/passwd', 0, '0')],
    ['a parent segment', rawHeader('repos/../../escape', 0, '0')],
    ['a backslash', rawHeader('repos\\x', 0, '0')],
    ['a symbolic link', rawHeader('repos/link', 0, '2')],
    ['a hard link', rawHeader('repos/hard', 0, '1')],
    ['a device', rawHeader('repos/dev', 0, '3')],
    ['a bad checksum', rawHeader('manifest.json', 0, '0', { badSum: true })],
  ])('refuses %s', async (_what, block) => {
    await expect(namesOf(Buffer.concat([block, end]))).rejects.toMatchObject({ code: 'export-archive-invalid' });
  });

  it('refuses an archive that ends inside an entry', async () => {
    await expect(namesOf(Buffer.concat([rawHeader('a', 2000, '0'), Buffer.alloc(100)]))).rejects.toMatchObject({
      code: 'export-archive-invalid',
    });
  });

  it('refuses to write a name an import would refuse', async () => {
    await expect(writeTarGz(join(dir, 'x.tar.gz'), [{ name: '../x', data: Buffer.alloc(1) }])).rejects.toMatchObject({
      code: 'export-archive-invalid',
    });
    expect(() => checkEntryName('tables/./x')).toThrow();
    expect(checkEntryName('repos/01ARZ3NDEKTSV4RRFFQ69G5FAV.bundle')).toBe('repos/01ARZ3NDEKTSV4RRFFQ69G5FAV.bundle');
  });

  it('reads an archive gzipped by another writer', async () => {
    const archive = join(dir, 'other.tar.gz');
    await writeFile(archive, gzipSync(Buffer.concat([rawHeader('a.txt', 2, '0'), Buffer.from('hi'), pad(2), end])));
    const read: string[] = [];
    for await (const entry of readTarGz(archive)) read.push((await entry.buffer()).toString());
    expect(read).toEqual(['hi']);
  });
});
