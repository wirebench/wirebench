import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_ACTIONS } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';

const DIRS = ['../../integration/audit-log/', './'].map((dir) => fileURLToPath(new URL(dir, import.meta.url)));
const text = DIRS.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8')),
).join('\n');

describe('audit actions and their tests (audit-log spec §15)', () => {
  it('every action in AUDIT_ACTIONS is asserted by name in an audit test', () => {
    const untested = AUDIT_ACTIONS.filter((action) => !text.includes(`'${action}'`));
    expect(untested).toEqual([]);
  });
});
