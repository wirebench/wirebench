import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderWsiAssertionsMarkdown } from '../packages/engine/src/validate/wsi/docs.js';

const target = fileURLToPath(new URL('../docs/ws-i-assertions.md', import.meta.url));

describe('docs/ws-i-assertions.md', () => {
  it('is generated from the assertion registry', async () => {
    const committed = await readFile(target, 'utf-8');
    expect(committed).toBe(renderWsiAssertionsMarkdown());
  });
});
