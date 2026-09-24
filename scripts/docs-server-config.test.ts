import { describe, expect, it } from 'vitest';
import { renderConfigTable, splice } from './docs-server-config.ts';

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
});
