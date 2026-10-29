import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkBrowserBundle, forbiddenImports } from './check-browser-bundle.ts';

async function bundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dist-browser-'));
  await mkdir(join(dir, 'assets'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

describe('forbiddenImports', () => {
  it('finds electron and node: imports in every spelling, minified too', () => {
    expect(
      forbiddenImports(
        [
          'import{ipcRenderer as a}from"electron";',
          "const b = require('electron');",
          'import("node:fs");',
          "import 'node:path';",
          'export*from"electron/renderer";',
        ].join('\n'),
      ),
    ).toEqual(['electron', 'electron', 'node:fs', 'node:path', 'electron/renderer']);
  });

  it('leaves the word electron in text alone', () => {
    expect(forbiddenImports('const host="electron";typeof process?.versions?.electron=="string"')).toEqual([]);
  });
});

describe('checkBrowserBundle', () => {
  it('passes a page with hashed, browser-safe scripts', async () => {
    const dir = await bundle({
      'index.html': '<script type="module" src="/assets/index-AbCd1234.js"></script>',
      'assets/index-AbCd1234.js': 'const host="electron";',
      'assets/main-x_Y-9zQw.css': 'body{}',
    });
    expect(checkBrowserBundle(dir)).toEqual([]);
  });

  it('names an electron import, an unhashed asset and a missing page', async () => {
    const dir = await bundle({
      'index.html': '',
      'assets/index-AbCd1234.js': 'import{a}from"electron";',
      'assets/plain.js': '',
    });
    expect(checkBrowserBundle(dir)).toEqual([
      `${join('assets', 'index-AbCd1234.js')} imports electron, which a browser cannot load`,
      `${join('assets', 'plain.js')} has no content hash in its name`,
    ]);
    const empty = await mkdtemp(join(tmpdir(), 'dist-browser-'));
    expect(checkBrowserBundle(empty)).toEqual([`${join(empty, 'index.html')} is missing`]);
  });
});
