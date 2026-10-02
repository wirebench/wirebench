import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderConfigTable, splice, TARGETS } from './docs-server-config.ts';

describe('docs-server-config', () => {
  it('renders one row per variable with the required ones marked', () => {
    const table = renderConfigTable();
    expect(table).toContain('| `WIREBENCH_SERVER_DATABASE_URL` | yes | — |');
    expect(table).toContain('| `WIREBENCH_SERVER_PORT` | no | `8080` |');
  });
  it('replaces only what sits between the markers', () => {
    expect(splice('a\n<!-- config:start -->\nold\n<!-- config:end -->\nz', 'new')).toBe(
      'a\n<!-- config:start -->\nnew\n<!-- config:end -->\nz',
    );
    expect(() => splice('no markers', 'x')).toThrow();
  });
  it('splices between MDX comment markers in a .mdx page', () => {
    const markers = { start: '{/* config:start */}', end: '{/* config:end */}' };
    expect(splice('a\n{/* config:start */}\nold\n{/* config:end */}\nz', 'new', markers)).toBe(
      'a\n{/* config:start */}\nnew\n{/* config:end */}\nz',
    );
  });
  it('writes the table into the server README and the user guide page, both carrying the markers', async () => {
    expect(TARGETS.map((target) => target.path)).toEqual([
      'packages/server/README.md',
      'docs-site/src/content/docs/guides/wirebench-server.mdx',
    ]);
    for (const { path, markers } of TARGETS) {
      const text = await readFile(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf-8');
      expect(splice(text, renderConfigTable(), markers)).toBe(text);
    }
  });
});
