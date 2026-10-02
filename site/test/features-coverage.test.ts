import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_LINKS } from '../src/docs-links.ts';

/**
 * Keeps the features page in step with the user guide: every guide page must be linked from a
 * features section, so a feature that ships with a guide cannot be missing from the site. The
 * guides in EXEMPT describe the app's frame rather than a feature, and have no section of their own.
 */
const EXEMPT = new Set(['guides/workspaces', 'guides/preferences']);

const guidesDir = fileURLToPath(new URL('../../docs-site/src/content/docs/guides/', import.meta.url));
const featuresPage = readFileSync(new URL('../src/pages/features.astro', import.meta.url), 'utf-8');

function linkedSlugs(page: string): Set<string> {
  const keys = [...page.matchAll(/DOCS_LINKS\.(\w+)/g)].map((match) => match[1]!);
  return new Set(keys.map((key) => DOCS_LINKS[key as keyof typeof DOCS_LINKS]));
}

describe('features page coverage', () => {
  const linked = linkedSlugs(featuresPage);
  const guides = readdirSync(guidesDir)
    .filter((file) => /\.mdx?$/.test(file))
    .map((file) => `guides/${file.replace(/\.mdx?$/, '')}`);

  it.each(guides.filter((slug) => !EXEMPT.has(slug)))('links %s from a features section', (slug) => {
    expect(linked.has(slug)).toBe(true);
  });

  it('exempts only guides that exist', () => {
    for (const slug of EXEMPT) {
      expect(guides).toContain(slug);
    }
  });
});
