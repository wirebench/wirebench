import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readTar, readTarGz } from './tar.ts';

const encoder = new TextEncoder();

/** A ustar header for one entry, checksummed the way every tar writer does it. */
function header(name: string, size: number, typeflag: string, prefix = ''): Uint8Array {
  const block = new Uint8Array(512);
  block.set(encoder.encode(name), 0);
  block.set(encoder.encode('0000644\0'), 100);
  block.set(encoder.encode(`${size.toString(8).padStart(11, '0')}\0`), 124);
  block.set(encoder.encode('00000000000\0'), 136);
  block.fill(0x20, 148, 156); // Checksum is computed with its own field read as spaces.
  block[156] = typeflag.charCodeAt(0);
  block.set(encoder.encode('ustar\0'), 257);
  block.set(encoder.encode('00'), 263);
  block.set(encoder.encode(prefix), 345);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.set(encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
  return block;
}

/** A whole archive from (name, text) pairs; a directory when text is `null`. */
function archive(entries: readonly [string, string | null, string?][]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, text, prefix] of entries) {
    if (text === null) {
      blocks.push(header(name, 0, '5', prefix));
      continue;
    }
    const bytes = encoder.encode(text);
    blocks.push(header(name, bytes.length, '0', prefix));
    const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    padded.set(bytes);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

describe('readTar', () => {
  it('returns every regular file with its exact bytes, in archive order', () => {
    const tar = archive([
      ['package/package.json', '{"name":"x"}'],
      ['package/3.0/json/petstore.json', '{"openapi":"3.0.0"}'],
    ]);

    const entries = readTar(tar);

    expect(entries.map((entry) => entry.name)).toEqual(['package/package.json', 'package/3.0/json/petstore.json']);
    expect(new TextDecoder().decode(entries[1]?.bytes)).toBe('{"openapi":"3.0.0"}');
  });

  it('walks past directories and stops at the end-of-archive marker', () => {
    const tar = archive([
      ['package/', null],
      ['package/a.txt', 'a'],
    ]);

    expect(readTar(tar).map((entry) => entry.name)).toEqual(['package/a.txt']);
  });

  it('joins the prefix field onto a long path', () => {
    const tar = archive([['file.json', '{}', 'package/deeply/nested']]);

    expect(readTar(tar)[0]?.name).toBe('package/deeply/nested/file.json');
  });

  it('reads a file that is not a whole number of blocks', () => {
    const text = 'x'.repeat(700);

    expect(new TextDecoder().decode(readTar(archive([['big.txt', text]]))[0]?.bytes)).toBe(text);
  });
});

describe('readTarGz', () => {
  it('inflates before reading', () => {
    const tar = archive([['package/a.txt', 'hello']]);

    const entries = readTarGz(new Uint8Array(gzipSync(tar)));

    expect(entries).toHaveLength(1);
    expect(new TextDecoder().decode(entries[0]?.bytes)).toBe('hello');
  });
});
