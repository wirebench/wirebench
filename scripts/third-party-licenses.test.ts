import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderThirdPartyLicenses } from './third-party-licenses.js';

const target = fileURLToPath(new URL('../THIRD-PARTY-LICENSES.md', import.meta.url));

describe('THIRD-PARTY-LICENSES.md', () => {
  it('matches what the installed dependency tree actually contains', async () => {
    const committed = await readFile(target, 'utf-8');
    expect(committed).toBe(await renderThirdPartyLicenses());
  });

  it('attributes the packages a reader would look for first', async () => {
    const committed = await readFile(target, 'utf-8');
    for (const name of ['electron', 'monaco-editor', 'react', 'undici', 'xmllint-wasm']) {
      expect(committed).toContain(`| \`${name}\` |`);
    }
    // A package whose license could not be determined is an attribution gap, not a detail.
    expect(committed).not.toContain('| UNKNOWN |');
  });
});
