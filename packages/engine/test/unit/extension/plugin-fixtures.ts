/** Plugin folders and archives for the plugin tests: a manifest, a module, a hand-made `.tgz`. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const MAIN = `
export const importers = {
  acme: {
    detect(input) { return input.text.startsWith('ACME') ? 'definite' : null; },
    import(input) {
      return { apis: [{ name: 'Acme', items: [{ kind: 'request', name: 'Ping', method: 'GET', url: 'https://api.example.test/ping' }] }] };
    },
  },
};
export const reporters = { summary: { render(report) { return 'total ' + report.summary.total + '\\n'; } } };
`;

export function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'acme',
    name: 'Acme formats',
    version: '1.0.0',
    api: 1,
    main: 'main.js',
    contributes: {
      importers: [{ id: 'acme', title: 'Acme collection', extensions: ['.acme'] }],
      reporters: [{ id: 'summary', title: 'Acme summary', extension: '.txt' }],
    },
    ...overrides,
  };
}

export async function pluginFolder(
  dir: string,
  manifestValue: Record<string, unknown> = manifest(),
  main = MAIN,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'wirebench-plugin.json'), JSON.stringify(manifestValue));
  await writeFile(join(dir, 'main.js'), main);
  return dir;
}

export interface TarEntry {
  readonly name: string;
  readonly body?: string;
  /** `0` a file (default), `5` a folder, `2` a symlink, `1` a hard link. */
  readonly type?: string;
}

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(entry.name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.fill(0x20, 148, 156);
  block.write(entry.type ?? '0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** A gzipped tar of `entries`, in order. */
export function tgz(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '', 'utf8');
    parts.push(header(entry, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
