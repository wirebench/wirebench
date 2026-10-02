import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_LINKS, docsUrl } from '../src/docs-links.ts';

const docsRoot = fileURLToPath(new URL('../../docs-site/src/content/docs/', import.meta.url));

function pageExists(slug: string): boolean {
  if (slug === '') return existsSync(`${docsRoot}index.mdx`);
  return [`${slug}.md`, `${slug}.mdx`, `${slug}/index.md`, `${slug}/index.mdx`].some((file) =>
    existsSync(`${docsRoot}${file}`),
  );
}

describe('docs links', () => {
  it.each(Object.entries(DOCS_LINKS))('%s points at a real docs page', (_name, slug) => {
    expect(pageExists(slug)).toBe(true);
  });

  it('builds absolute paths under the Pages base', () => {
    expect(docsUrl('')).toBe('/wirebench/docs/');
    expect(docsUrl('guides/rest-client')).toBe('/wirebench/docs/guides/rest-client/');
  });
});
